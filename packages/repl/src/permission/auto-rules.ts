import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAgentConfigHome, isPathInsideDirectory } from '@kodax-ai/agent';
import type {
  AutoModePermissionOperation,
  AutoModePermissionReview,
  AutoModePermissionTarget,
  AutoModeRulesContext,
  AutoModeRulesDecision,
  AutoModeRulesEvaluator,
} from '@kodax-ai/coding';
import {
  collectDeterministicBashWriteTargets,
  extractPathsFromCommand,
  isBashReadCommand,
  isBashWriteCommand,
} from './permission.js';
import { parseBashCommand } from './bash-ast.js';
import type { BashCommandTree, BashPipelineStage } from './bash-ast.js';
import { analyzePowerShellMutation, isPowerShellMutationCommand } from './powershell-mutation.js';

const FILE_TOOLS = new Set(['write', 'edit', 'multi_edit', 'insert_after_anchor']);
const READ_FILE_TOOLS = new Set(['read', 'grep', 'glob']);
const SENSITIVE_PATH_PARTS = new Set([
  '.ssh', '.aws', '.azure', '.gnupg', '.kube', '.docker', '.kodax', '.agents',
]);
const SENSITIVE_FILES = new Set([
  '.env', '.npmrc', '.pypirc', '.netrc', '.git-credentials', 'credentials',
  'credentials.json', 'application_default_credentials.json', 'id_rsa', 'id_ed25519',
]);
const ENV_TEMPLATE_FILES = new Set(['.env.example', '.env.sample', '.env.template']);
const SENSITIVE_ENV_NAME = /(?:^|_)(?:api_?key|access_?key|secret|token|password|passwd|credential|private_?key|auth|cookie)(?:_|$)/i;
const POSITIONAL_READ_COMMANDS = new Set([
  'cat', 'type', 'get-content', 'head', 'tail', 'less', 'more', 'wc', 'fc',
]);
const REGEX_READ_COMMANDS = new Set([
  'rg', 'ripgrep', 'grep', 'egrep', 'fgrep', 'findstr', 'select-string', 'sed', 'awk',
]);
const GET_CONTENT_NON_PATH_VALUE_OPTIONS = new Set([
  '-delimiter', '-encoding', '-readcount', '-totalcount', '-tail',
]);
const GET_CONTENT_PATH_OPTIONS = new Set(['-path', '-literalpath', '-filter', '-include', '-exclude']);
const GIT_NON_PATH_VALUE_OPTIONS = new Set([
  '-g', '-s', '--format', '--pretty', '--date', '--encoding', '--diff-algorithm',
  '--word-diff-regex', '--diff-filter', '--find-object', '--line-prefix',
]);
const TARGETED_WRITE_COMMANDS = new Set([
  'rm', 'rmdir', 'mkdir', 'touch', 'mv', 'move', 'ren', 'del', 'erase', 'rd',
  'cp', 'copy', 'chmod', 'chown', 'dd', 'tee',
  'remove-item', 'set-content', 'add-content', 'out-file', 'new-item',
  'copy-item', 'move-item', 'rename-item', 'ni',
]);
const GIT_REMOTE_WRITE_ACTIONS = new Set([
  'add', 'remove', 'rm', 'rename', 'set-head', 'set-branches',
  'set-url', 'prune', 'update',
]);
const GIT_BRANCH_WRITE_FLAGS = new Set([
  '-d', '-m', '-c', '-f', '--force', '--delete', '--move', '--copy',
  '--edit-description', '--set-upstream-to', '--unset-upstream', '--create-reflog',
  '--track', '--no-track', '--recurse-submodules',
]);
const GIT_TAG_WRITE_FLAGS = new Set([
  '-a', '--annotate', '-s', '--sign', '-u', '--local-user', '-d', '--delete',
  '-f', '--force', '-m', '--message', '-F', '--file', '--create-reflog',
].map((token) => token.toLowerCase()));

function expandPermissionPath(targetPath: string): string {
  const tempDir = os.tmpdir();
  const aliases: ReadonlyArray<readonly [RegExp, string]> = [
    [/^%temp%/i, tempDir], [/^%tmp%/i, tempDir],
    [/^\$env:temp\b/i, tempDir], [/^\$env:tmp\b/i, tempDir],
    [/^\$tmpdir\b/i, tempDir], [/^\$temp\b/i, tempDir], [/^\$tmp\b/i, tempDir],
  ];
  let expanded = targetPath === '~'
    ? os.homedir()
    : /^~[\\/]/.test(targetPath)
      ? path.join(os.homedir(), targetPath.slice(2))
      : targetPath;
  const homePrefix = /^(?:\$\{HOME\}|\$HOME|\$env:(?:home|userprofile)|%userprofile%)(?=$|[\\/])/i;
  expanded = expanded.replace(homePrefix, os.homedir());
  for (const [pattern, replacement] of aliases) {
    if (pattern.test(expanded)) expanded = expanded.replace(pattern, replacement);
  }
  return expanded;
}

function normalizeShellTarget(targetPath: string): string | undefined {
  const expanded = expandPermissionPath(targetPath);
  if (/[$%*?`]/.test(expanded) || /^~/.test(expanded)) return undefined;
  return expanded;
}

/** Resolve symlinks/junctions through the deepest existing path prefix. */
function canonicalizePath(targetPath: string, baseDir?: string): string | undefined {
  if (!targetPath.trim() || targetPath.includes('\0')) return undefined;
  const expanded = expandPermissionPath(targetPath);
  if (process.platform === 'win32' && /^[a-z]:[^\\/]/i.test(expanded)) return undefined;
  const resolved = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(baseDir ?? process.cwd(), expanded);
  const suffix: string[] = [];
  let current = resolved;

  for (;;) {
    try {
      fs.lstatSync(current);
    } catch (error) {
      const code = error instanceof Error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
      if (code !== 'ENOENT') return undefined;
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      suffix.unshift(path.basename(current));
      current = parent;
      continue;
    }
    try {
      return path.join(fs.realpathSync.native(current), ...suffix);
    } catch {
      // A broken link or inaccessible existing prefix must never be treated
      // as a lexical in-workspace path.
      return undefined;
    }
  }
}

function canonicalizeExistingDirectory(targetPath: string): string | undefined {
  try {
    const resolved = path.resolve(expandPermissionPath(targetPath));
    if (!fs.statSync(resolved).isDirectory()) return undefined;
    return fs.realpathSync.native(resolved);
  } catch {
    return undefined;
  }
}

function canonicalTempDirectories(): string[] {
  const candidates = [os.tmpdir(), process.env.TEMP, process.env.TMP, process.env.TMPDIR];
  const result = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate?.trim()) continue;
    const canonical = canonicalizeExistingDirectory(candidate);
    if (canonical) result.add(canonical);
  }
  return [...result];
}

function isSensitivePath(targetPath: string): boolean {
  const parts = targetPath.split(/[\\/]+/).map((part) => part.toLowerCase());
  const basename = parts.at(-1) ?? '';
  const sensitiveEnvironmentFile = !ENV_TEMPLATE_FILES.has(basename)
    && (basename === '.env' || basename.startsWith('.env.'));
  const processEnvironmentFile = parts[1] === 'proc'
    && (parts[0] === '' || /^[a-z]:$/i.test(parts[0] ?? ''))
    && /^(?:self|\d+)$/.test(parts[2] ?? '')
    && parts[3] === 'environ';
  return processEnvironmentFile
    || parts.some((part) => SENSITIVE_PATH_PARTS.has(part))
    || parts.some((part) => SENSITIVE_FILES.has(part))
    || sensitiveEnvironmentFile
    || parts.some((part) => /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/.test(part))
    || parts.some((part, index) => (
      part === '.config'
      && (parts[index + 1] === 'gcloud'
        || parts[index + 1] === 'gh')
    ));
}

function isProtectedAgentHome(targetPath: string): boolean {
  try {
    const agentHome = canonicalizePath(getAgentConfigHome());
    return agentHome !== undefined && isPathInsideDirectory(targetPath, agentHome);
  } catch {
    return true;
  }
}

function classifyTarget(
  targetPath: string,
  context: AutoModeRulesContext,
): AutoModePermissionTarget {
  if (isSensitivePath(targetPath)) return { path: targetPath, boundary: 'protected' };
  const normalized = normalizeShellTarget(targetPath);
  if (!normalized) return { path: targetPath, boundary: 'unresolved' };
  if (isSensitivePath(normalized)) return { path: targetPath, boundary: 'protected' };
  const executionCwd = canonicalizeExistingDirectory(context.executionCwd);
  const projectRoot = canonicalizeExistingDirectory(context.projectRoot);
  const target = executionCwd ? canonicalizePath(normalized, executionCwd) : undefined;
  if (!target || !projectRoot) return { path: targetPath, boundary: 'unresolved' };
  if (isSensitivePath(target) || isProtectedAgentHome(target)) {
    return { path: targetPath, boundary: 'protected' };
  }
  if (isPathInsideDirectory(target, projectRoot)) {
    return { path: targetPath, boundary: 'workspace' };
  }
  if (canonicalTempDirectories().some((tempDir) => isPathInsideDirectory(target, tempDir))) {
    return { path: targetPath, boundary: 'system-temp' };
  }
  return { path: targetPath, boundary: 'outside-workspace' };
}

function isAllowedMutationTarget(target: AutoModePermissionTarget): boolean {
  return target.boundary === 'workspace' || target.boundary === 'system-temp';
}

function escalate(reason: string): AutoModeRulesDecision {
  return { action: 'escalate', reason };
}

function shellExecutable(stage: BashPipelineStage): string {
  return (stage.argv[0] ?? '').replace(/\\/g, '/').split('/').at(-1)?.toLowerCase() ?? '';
}

function hasOnlyModeledShellStages(tree: BashCommandTree): boolean {
  if (tree.unparseable || tree.statements.length === 0) return false;
  return tree.statements.every((statement) => (
    statement.stages.length > 0
    && statement.stages.every((stage) => (
      TARGETED_WRITE_COMMANDS.has(shellExecutable(stage))
      || isBashReadCommand(stage.argv.join(' '))
    ))
  ));
}

function hasWriteCapableReadSyntax(tree: BashCommandTree): boolean {
  for (const statement of tree.statements) {
    for (const stage of statement.stages) {
      const argv = stage.argv.map((token) => token.toLowerCase());
      const executable = shellExecutable(stage);
      if (executable === 'find' && argv.some((token) => (
        token === '-delete' || token === '-exec' || token === '-execdir'
        || token === '-ok' || token === '-okdir'
      ))) {
        return true;
      }
      if (executable !== 'git') continue;

      const subcommand = argv[1];
      const args = argv.slice(2);
      if (subcommand === 'remote') {
        const action = args.find((token) => !token.startsWith('-'));
        if (action && GIT_REMOTE_WRITE_ACTIONS.has(action)) return true;
      }
      if (subcommand === 'branch') {
        if (args.some((token) => GIT_BRANCH_WRITE_FLAGS.has(token))) return true;
        if (args[0] && !args[0].startsWith('-')) return true;
      }
      if (subcommand === 'tag') {
        if (args.some((token) => GIT_TAG_WRITE_FLAGS.has(token)
          || token.startsWith('--message=') || token.startsWith('--file='))) return true;
        const listsTags = args.some((token) => token === '-l' || token === '--list');
        if (!listsTags && args[0] && !args[0].startsWith('-')) return true;
      }
    }
  }
  return false;
}

export interface AutoModeCallAssessment {
  readonly decision: AutoModeRulesDecision;
  readonly review: AutoModePermissionReview;
}

function assessFileCall(
  input: Readonly<Record<string, unknown>>,
  context: AutoModeRulesContext,
): AutoModeCallAssessment {
  const targetPath = typeof input.path === 'string' ? input.path : '';
  if (!targetPath) {
    return assessment(
      escalate('auto-mode rules could not resolve the file target'),
      review('incomplete', 'tool', [], ['target_unresolved'], 'file target is missing'),
    );
  }
  const operation: AutoModePermissionOperation = {
    kind: 'write', target: classifyTarget(targetPath, context),
  };
  const complete = operation.target.boundary !== 'unresolved';
  const decision = isOperationAllowed(operation)
    ? { action: 'allow' as const }
    : escalate('auto-mode rules require confirmation for a protected or out-of-boundary file target');
  return assessment(decision, review(
    complete ? 'complete' : 'incomplete',
    'tool',
    [operation],
    collectRisks([operation]),
    complete ? undefined : 'file target could not be resolved safely',
  ));
}

function readToolTarget(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  context: AutoModeRulesContext,
): string {
  const searchFilter = toolName === 'glob' ? input.pattern : input.glob;
  if (typeof searchFilter === 'string' && isSensitivePath(searchFilter)) {
    return searchFilter;
  }
  if (typeof input.path === 'string' && input.path.trim()) return input.path;
  return toolName === 'read' ? '' : context.executionCwd;
}

function assessReadFileCall(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  context: AutoModeRulesContext,
): AutoModeCallAssessment {
  const targetPath = readToolTarget(toolName, input, context);
  if (!targetPath) {
    return assessment(
      escalate('auto-mode could not resolve the read target'),
      review('incomplete', 'tool', [], ['target_unresolved'], 'read target is missing'),
    );
  }
  const operation: AutoModePermissionOperation = {
    kind: 'read', target: classifyTarget(targetPath, context),
  };
  const complete = operation.target.boundary !== 'unresolved';
  const allowed = complete && operation.target.boundary !== 'protected';
  return assessment(
    allowed
      ? { action: 'allow' }
      : escalate('auto-mode requires confirmation before reading a sensitive or unresolved target'),
    review(
      complete ? 'complete' : 'incomplete',
      'tool',
      [operation],
      collectRisks([operation]),
      complete ? undefined : 'read target could not be resolved safely',
    ),
  );
}

function sensitiveEnvironmentRead(command: string, tree: BashCommandTree): boolean {
  const references = [
    ...command.matchAll(/\$(?:env:)?\{?([a-z_][a-z0-9_]*)\}?/gi),
    ...command.matchAll(/%([a-z_][a-z0-9_]*)%/gi),
    ...command.matchAll(/\benv:([a-z_][a-z0-9_]*)/gi),
  ];
  if (references.some((match) => SENSITIVE_ENV_NAME.test(match[1] ?? ''))) return true;
  if (/\b(?:get-childitem|gci|dir)\b[^\r\n|;&]*\benv:\s*(?:$|[|;&])/i.test(command)) {
    return true;
  }
  if (/\bgit\s+config\s+--get\s+\S*(?:credential|token|password|secret|extraheader|oauth)\S*/i.test(command)) {
    return true;
  }
  return tree.statements.some((statement) => statement.stages.some((stage) => {
    const executable = shellExecutable(stage);
    if (executable !== 'env' && executable !== 'printenv') return false;
    const names = stage.argv.slice(1).filter((token) => !token.startsWith('-'));
    return names.length === 0 || names.some((name) => SENSITIVE_ENV_NAME.test(name));
  }));
}

function sensitivePathCandidate(value: string): string | undefined {
  if (isSensitivePath(value)) return value;
  const gitMagic = value.match(/^:\([^)]*\)(.+)$/)?.[1];
  if (gitMagic && isSensitivePath(gitMagic)) return gitMagic;
  for (let index = value.indexOf(':'); index >= 0; index = value.indexOf(':', index + 1)) {
    const suffix = value.slice(index + 1);
    if (suffix && isSensitivePath(suffix)) return suffix;
  }
  return undefined;
}

function collectSensitiveReadTargets(tree: BashCommandTree): string[] {
  const targets = new Set<string>();
  const addCandidate = (value: string | undefined): void => {
    if (!value) return;
    const candidate = sensitivePathCandidate(value);
    if (candidate) targets.add(candidate);
  };

  for (const statement of tree.statements) {
    for (const stage of statement.stages) {
      const executable = shellExecutable(stage);
      if (executable === 'git') {
        const subcommand = stage.argv[1]?.toLowerCase();
        let pathsOnly = false;
        for (let index = 2; index < stage.argv.length; index += 1) {
          const token = stage.argv[index] ?? '';
          if (token === '--') {
            pathsOnly = true;
            continue;
          }
          if (!pathsOnly && GIT_NON_PATH_VALUE_OPTIONS.has(token.toLowerCase())) {
            index += 1;
            continue;
          }
          if (!pathsOnly && token.startsWith('-')) continue;
          if (pathsOnly || subcommand === 'diff' || token.includes(':')) {
            addCandidate(token);
          }
        }
        continue;
      }
      if (REGEX_READ_COMMANDS.has(executable)) {
        const stageCommand = stage.argv.map((token) => JSON.stringify(token)).join(' ');
        for (const target of extractPathsFromCommand(stageCommand)) addCandidate(target);
        continue;
      }
      if (!POSITIONAL_READ_COMMANDS.has(executable)) continue;

      for (let index = 1; index < stage.argv.length; index += 1) {
        const token = stage.argv[index] ?? '';
        const lower = token.toLowerCase();
        if (executable === 'get-content') {
          if (GET_CONTENT_NON_PATH_VALUE_OPTIONS.has(lower)) {
            index += 1;
            continue;
          }
          if (GET_CONTENT_PATH_OPTIONS.has(lower)) {
            addCandidate(stage.argv[index + 1]);
            index += 1;
            continue;
          }
        }
        if (token.startsWith('-')) continue;
        addCandidate(token);
      }
    }
  }
  return [...targets];
}

function assessBashCall(
  input: Readonly<Record<string, unknown>>,
  context: AutoModeRulesContext,
): AutoModeCallAssessment {
  const command = typeof input.command === 'string' ? input.command : '';
  if (!command.trim()) {
    return assessment(
      escalate('auto-mode rules could not resolve the shell command'),
      review('incomplete', 'shell', [], ['command_unresolved'], 'shell command is missing'),
    );
  }

  const tree = parseBashCommand(command);
  const shell = hasPowerShellMutationStage(tree) ? 'powershell' : 'shell';
  const operationResult = collectShellOperations(command, tree, context);
  const highRisk = context.signals.some((signal) => (
    signal.kind === 'dangerous_pattern' && signal.severity === 'high'
  ));
  const modeled = !tree.unparseable
    && !hasWriteCapableReadSyntax(tree)
    && hasOnlyModeledShellStages(tree);
  const hasKnownWrite = isBashWriteCommand(command)
    || operationResult.operations.some((operation) => operation.kind !== 'execute');
  const complete = operationResult.complete && modeled
    && (isBashReadCommand(command) || hasKnownWrite)
    && operationResult.operations.length > 0
    && operationResult.operations.every((operation) => (
      operationPaths(operation).every((target) => target.boundary !== 'unresolved')
    ));
  const risks = collectRisks(operationResult.operations);
  if (highRisk) risks.push('high_risk_pattern');
  if (sensitiveEnvironmentRead(command, tree)) risks.push('sensitive_environment_read');
  const permissionReview = review(
    complete ? 'complete' : 'incomplete',
    shell,
    operationResult.operations,
    risks,
    complete ? undefined : operationResult.reason ?? 'shell effects are not fully modeled',
  );

  if (!complete) {
    return assessment(
      escalate('auto-mode rules require confirmation for an unmodelled shell command'),
      permissionReview,
    );
  }
  if (highRisk) {
    return assessment(
      escalate('auto-mode rules require confirmation for a high-risk shell command'),
      permissionReview,
    );
  }
  if (risks.includes('sensitive_environment_read')) {
    return assessment(
      escalate('auto-mode requires confirmation before reading sensitive environment data'),
      permissionReview,
    );
  }
  const decision = operationResult.operations.every(isOperationAllowed)
    ? { action: 'allow' as const }
    : escalate('auto-mode rules require confirmation for a protected or out-of-boundary shell target');
  return assessment(decision, permissionReview);
}

function collectShellOperations(
  command: string,
  tree: BashCommandTree,
  context: AutoModeRulesContext,
): { readonly complete: boolean; readonly operations: AutoModePermissionOperation[]; readonly reason?: string } {
  if (tree.unparseable) {
    return {
      complete: false,
      operations: [{ kind: 'unknown', summary: `opaque shell payload (${Buffer.byteLength(command, 'utf8')} bytes)` }],
      reason: 'shell syntax could not be parsed',
    };
  }

  const operations: AutoModePermissionOperation[] = [];
  const modeledTargets = new Set<string>();
  let complete = true;
  let reason: string | undefined;
  for (const statement of tree.statements) {
    for (const stage of statement.stages) {
      if (!isPowerShellMutationCommand(shellExecutable(stage))) continue;
      const analysis = analyzePowerShellMutation(stage.argv);
      if (analysis.status === 'incomplete') {
        complete = false;
        reason ??= analysis.reason;
      }
      for (const operation of analysis.operations) {
        const mapped = mapPowerShellOperation(operation, context);
        operations.push(mapped);
        for (const target of operationPaths(mapped)) modeledTargets.add(target.path);
      }
    }
  }

  for (const statement of tree.statements) {
    for (const stage of statement.stages) {
      for (const operation of collectDirectShellOperations(stage, context)) {
        operations.push(operation);
        for (const target of operationPaths(operation)) modeledTargets.add(target.path);
      }
    }
  }

  for (const target of collectDeterministicBashWriteTargets(command)) {
    if (modeledTargets.has(target)) continue;
    operations.push({ kind: 'write', target: classifyTarget(target, context) });
  }
  const sensitiveReadTargets = collectSensitiveReadTargets(tree);
  if (isBashReadCommand(command) || sensitiveReadTargets.length > 0) {
    const readTargets = new Set(sensitiveReadTargets);
    if (isBashReadCommand(command)) {
      for (const target of extractPathsFromCommand(command)) readTargets.add(target);
    }
    for (const target of readTargets) {
      if (modeledTargets.has(target)) continue;
      operations.push({ kind: 'read', target: classifyTarget(target, context) });
      modeledTargets.add(target);
    }
  }
  if (operations.length === 0 && isBashReadCommand(command)) {
    operations.push({
      kind: 'execute', summary: 'read-only shell command', options: { readOnly: true },
    });
  }
  return reason === undefined ? { complete, operations } : { complete, operations, reason };
}

function collectDirectShellOperations(
  stage: BashPipelineStage,
  context: AutoModeRulesContext,
): AutoModePermissionOperation[] {
  const command = shellExecutable(stage);
  const args = directPositionals(command, stage.argv.slice(1));
  if (['rm', 'rmdir', 'del', 'erase', 'rd'].includes(command)) {
    return args.map((target) => ({
      kind: 'delete', target: classifyTarget(target, context),
      options: {
        recursive: stage.argv.some((token) => (
          token === '--recursive' || /^-[^-]*[rR]/.test(token)
        )),
      },
    }));
  }
  if (command === 'mkdir' || command === 'touch') {
    return args.map((target) => ({
      kind: 'create', target: classifyTarget(target, context),
    }));
  }
  if (command === 'mv' || command === 'move' || command === 'cp' || command === 'copy') {
    const targetDirectory = directTargetDirectory(stage.argv);
    const sources = targetDirectory ? args : args.slice(0, -1);
    const destination = targetDirectory ?? args.at(-1);
    if (!destination || sources.length === 0) return [];
    return sources.map((source) => ({
      kind: command === 'cp' || command === 'copy' ? 'copy' : 'move',
      source: classifyTarget(source, context),
      destination: classifyTarget(destination, context),
      options: {
        force: stage.argv.some((token) => /^(?:-f|--force|\/y)$/i.test(token)),
        recursive: (command === 'cp' || command === 'copy')
          && stage.argv.some((token) => token === '--recursive' || /^-[^-]*[rRa]/.test(token)),
        destinationIsDirectory: targetDirectory !== undefined || sources.length > 1,
        overwritePossible: true,
      },
    }));
  }
  if (command === 'ren' && args.length === 2) {
    const source = args[0]!;
    return [{
      kind: 'rename',
      source: classifyTarget(source, context),
      destination: classifyTarget(joinSourceParent(source, args[1]!), context),
    }];
  }
  return [];
}

function directPositionals(command: string, argv: readonly string[]): string[] {
  const result: string[] = [];
  let skipNext = false;
  for (const token of argv) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (directOptionTakesValue(command, token)) {
      skipNext = true;
      continue;
    }
    if (token === '--') continue;
    if (token.startsWith('-') || isDirectWindowsSwitch(command, token)) continue;
    result.push(token);
  }
  return result;
}

const DIRECT_WINDOWS_SWITCHES: Readonly<Record<string, ReadonlySet<string>>> = {
  copy: new Set(['/a', '/b', '/d', '/j', '/l', '/n', '/v', '/y', '/-y', '/z']),
  del: new Set(['/p', '/f', '/s', '/q', '/a']),
  erase: new Set(['/p', '/f', '/s', '/q', '/a']),
  move: new Set(['/y', '/-y']),
  rd: new Set(['/s', '/q']),
};

function isDirectWindowsSwitch(command: string, token: string): boolean {
  return DIRECT_WINDOWS_SWITCHES[command]?.has(token.toLowerCase()) === true;
}

function directOptionTakesValue(command: string, token: string): boolean {
  if ((command === 'cp' || command === 'copy' || command === 'mv' || command === 'move')
    && ['-t', '--target-directory', '-S', '--suffix'].includes(token)) return true;
  if (command === 'mkdir' && ['-m', '--mode'].includes(token)) return true;
  return command === 'touch'
    && ['-d', '--date', '-r', '--reference', '-t', '--time'].includes(token);
}

function directTargetDirectory(argv: readonly string[]): string | undefined {
  const index = argv.findIndex((token) => token === '-t' || token === '--target-directory');
  if (index >= 0) return argv[index + 1];
  const attached = argv.find((token) => token.startsWith('--target-directory='));
  return attached?.slice('--target-directory='.length);
}

function joinSourceParent(source: string, newName: string): string {
  const flavor = /^[a-z]:|\\/i.test(source) ? path.win32 : path.posix;
  return flavor.join(flavor.dirname(source), newName);
}

function mapPowerShellOperation(
  operation: ReturnType<typeof analyzePowerShellMutation>['operations'][number],
  context: AutoModeRulesContext,
): AutoModePermissionOperation {
  if ('target' in operation) {
    return {
      kind: operation.kind,
      target: classifyTarget(operation.target, context),
      options: operation.options,
    };
  }
  return {
    kind: operation.kind,
    source: classifyTarget(operation.source, context),
    destination: classifyTarget(operation.destination, context),
    options: operation.options,
  };
}

function hasPowerShellMutationStage(tree: BashCommandTree): boolean {
  return tree.statements.some((statement) => statement.stages.some((stage) => (
    isPowerShellMutationCommand(shellExecutable(stage))
  )));
}

function operationPaths(operation: AutoModePermissionOperation): readonly AutoModePermissionTarget[] {
  if ('target' in operation) return [operation.target];
  if ('source' in operation) return [operation.source, operation.destination];
  return [];
}

function isOperationAllowed(operation: AutoModePermissionOperation): boolean {
  if (operation.options?.whatIf === true) return true;
  if (operation.kind === 'execute') return operation.options?.readOnly === true;
  if (operation.kind === 'unknown') return false;
  if (operation.kind === 'read') {
    return operation.target.boundary !== 'protected'
      && operation.target.boundary !== 'unresolved';
  }
  if ('target' in operation) return isAllowedMutationTarget(operation.target);
  if (!('source' in operation)) return false;
  if (operation.kind === 'copy') {
    return isAllowedMutationTarget(operation.destination)
      && operation.source.boundary !== 'protected'
      && operation.source.boundary !== 'unresolved';
  }
  return isAllowedMutationTarget(operation.source)
    && isAllowedMutationTarget(operation.destination);
}

function collectRisks(operations: readonly AutoModePermissionOperation[]): string[] {
  const risks = new Set<string>();
  for (const operation of operations) {
    if (operation.options?.whatIf === true) continue;
    const targets = operationPaths(operation);
    if (mutationTargets(operation).some((target) => target.boundary === 'outside-workspace')) {
      risks.add('outside_workspace_mutation');
    }
    if (operation.kind === 'read'
      && targets.some((target) => target.boundary === 'protected')) risks.add('sensitive_read');
    if (targets.some((target) => target.boundary === 'protected')) risks.add('protected_path');
    if (targets.some((target) => target.boundary === 'unresolved')) risks.add('target_unresolved');
    if (operation.kind === 'move' || operation.kind === 'rename') {
      risks.add('source_removed');
      if (operation.source.boundary !== operation.destination.boundary) {
        risks.add('cross_boundary_mutation');
      }
    }
    if (operation.kind === 'copy' && operation.source.boundary !== operation.destination.boundary) {
      risks.add('cross_boundary_copy');
      if (operation.destination.boundary === 'outside-workspace') risks.add('data_export_possible');
    }
    if (operation.kind === 'delete') risks.add('source_removed');
    if ((operation.kind === 'move' || operation.kind === 'copy')
      && operation.options?.overwritePossible) risks.add('destination_overwrite_possible');
  }
  return [...risks];
}

function mutationTargets(
  operation: AutoModePermissionOperation,
): readonly AutoModePermissionTarget[] {
  if ('target' in operation) return operation.kind === 'read' ? [] : [operation.target];
  if (!('source' in operation)) return [];
  return operation.kind === 'copy'
    ? [operation.destination]
    : [operation.source, operation.destination];
}

function review(
  status: 'complete' | 'incomplete',
  shell: AutoModePermissionReview['analysis']['shell'],
  operations: readonly AutoModePermissionOperation[],
  risks: readonly string[],
  reason?: string,
): AutoModePermissionReview {
  return {
    schemaVersion: 1,
    analysis: {
      status,
      shell,
      binding: status === 'complete' ? 'exact' : 'partial',
      ...(reason ? { reason } : {}),
    },
    operations,
    risks,
  };
}

function assessment(
  decision: AutoModeRulesDecision,
  permissionReview: AutoModePermissionReview,
): AutoModeCallAssessment {
  return { decision, review: permissionReview };
}

export function assessAutoModeCall(
  call: Parameters<AutoModeRulesEvaluator>[0],
  context: AutoModeRulesContext,
): AutoModeCallAssessment {
  if (FILE_TOOLS.has(call.name)) return assessFileCall(call.input, context);
  if (READ_FILE_TOOLS.has(call.name)) return assessReadFileCall(call.name, call.input, context);
  if (call.name === 'bash') return assessBashCall(call.input, context);
  return assessment(
    escalate(`auto-mode rules require confirmation for tool "${call.name}"`),
    review(
      'incomplete',
      'tool',
      [{ kind: 'unknown', summary: `tool ${call.name}` }],
      ['tool_effects_unresolved'],
      'tool has no deterministic effect analyzer',
    ),
  );
}

export const analyzeAutoModeCall = (
  call: Parameters<AutoModeRulesEvaluator>[0],
  context: AutoModeRulesContext,
): AutoModePermissionReview => assessAutoModeCall(call, context).review;

export const evaluateAutoRulesCall: AutoModeRulesEvaluator = (call, context) => (
  assessAutoModeCall(call, context).decision
);
