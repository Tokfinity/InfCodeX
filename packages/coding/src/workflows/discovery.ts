/**
 * FEATURE_217 (v0.7.49) Phase E — Saved workflow discovery + loading.
 *
 * Discovers user-authored workflows from `.kodax/workflows/` (project)
 * and `~/.kodax/workflows/` (personal), project winning on name
 * conflict. Loading reuses the proven Self-Construction pattern
 * (`await import(pathToFileURL(...))`, FEATURE_088 load-handler) — no
 * transpiler dependency: `.ts` resolves under a tsx runtime (dev), `.js`
 * / `.mjs` resolve in compiled binaries.
 *
 * SECURITY: loading a saved workflow EXECUTES local code. The REPL gates
 * the first run of any discovered file behind a trusted-local
 * confirmation (Phase D.2 command) — discovery itself only reads paths.
 */

import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  createWorkflowCapsule,
  createWorkflowModuleFromCapsule,
  validateRestrictedWorkflowSource,
  validateWorkflowCapsule,
  validateWorkflowScriptManifest,
  type WorkflowCapsule,
  type WorkflowCapsuleIntent,
  type WorkflowCapsuleInputs,
  type WorkflowCapsuleProvenance,
  type WorkflowCapsuleRequirements,
  type WorkflowModule,
  type WorkflowScriptManifest,
} from '@kodax-ai/agent';

/** Extensions recognised as workflow modules, in resolution priority. */
const WORKFLOW_SUFFIXES: readonly string[] = ['.workflow.json', '.ts', '.mjs', '.js'];

export type SavedWorkflowSource = 'project' | 'personal';
export type SavedWorkflowExecution = 'trusted-local' | 'capability-generated';

export interface SavedWorkflowRef {
  /** Workflow name = filename without extension. */
  readonly name: string;
  readonly path: string;
  readonly source: SavedWorkflowSource;
  readonly execution: SavedWorkflowExecution;
}

export interface SavedWorkflowDirs {
  /** `.kodax/workflows` relative to the project root. */
  readonly project?: string;
  /** `~/.kodax/workflows`. */
  readonly personal?: string;
}

export interface SavedGeneratedWorkflowFile {
  readonly manifest: WorkflowScriptManifest;
  readonly source: string;
  readonly capsule?: WorkflowCapsule;
  readonly legacy?: boolean;
}

export interface SaveGeneratedWorkflowInput {
  readonly dir: string;
  readonly name: string;
  readonly manifest: WorkflowScriptManifest;
  readonly source: string;
  readonly intent?: WorkflowCapsuleIntent;
  readonly inputs?: WorkflowCapsuleInputs;
  readonly requires?: WorkflowCapsuleRequirements;
  readonly provenance?: WorkflowCapsuleProvenance;
  readonly minKodaxVersion?: string;
}

export interface SaveGeneratedWorkflowFromRunInput {
  readonly runDir: string;
  readonly targetDir: string;
  readonly name: string;
}

export interface RenameSavedWorkflowInput {
  readonly dirs: SavedWorkflowDirs;
  readonly name: string;
  readonly newName: string;
  readonly source?: SavedWorkflowSource;
}

export interface DeleteSavedWorkflowInput {
  readonly dirs: SavedWorkflowDirs;
  readonly name: string;
  readonly source?: SavedWorkflowSource;
}

export interface ReplaceSavedWorkflowInput extends Omit<SaveGeneratedWorkflowInput, 'dir'> {
  readonly dirs: SavedWorkflowDirs;
  readonly savedSource?: SavedWorkflowSource;
}

export interface ReplaceSavedWorkflowResult extends SavedWorkflowRef {
  readonly previousPath: string;
}

export interface LoadGeneratedWorkflowFromRunInput {
  readonly runDir: string;
}

export interface LoadedGeneratedWorkflowFromRun {
  readonly capsule: WorkflowCapsule;
  readonly module: WorkflowModule;
}

export interface WorkflowCapsulePreflightIssue {
  readonly severity: 'error' | 'warning';
  readonly requirement: string;
  readonly message: string;
}

export interface WorkflowCapsulePreflightResult {
  readonly ok: boolean;
  readonly issues: readonly WorkflowCapsulePreflightIssue[];
}

export interface WorkflowCapsulePreflightEnvironment {
  readonly kodaxVersion?: string;
  readonly isGitRepo?: boolean;
  readonly worktreeCapable?: boolean;
  readonly availableTools?: readonly string[];
  readonly availableMcp?: readonly string[];
  readonly availableSkills?: readonly string[];
}

const KODAX_WORKFLOW_CAPSULE_MIN_VERSION = '0.7.49';

function currentKodaxWorkflowVersion(): string {
  return (
    process.env.KODAX_VERSION ??
    process.env.npm_package_version ??
    KODAX_WORKFLOW_CAPSULE_MIN_VERSION
  );
}

function executionForPath(path: string): SavedWorkflowExecution {
  return path.endsWith('.workflow.json') ? 'capability-generated' : 'trusted-local';
}

function stripWorkflowSuffix(entry: string): string | undefined {
  const suffix = WORKFLOW_SUFFIXES.find((candidate) => entry.endsWith(candidate));
  return suffix ? entry.slice(0, -suffix.length) : undefined;
}

function safeWorkflowName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 80);
  if (!cleaned || cleaned === '.' || cleaned === '..') {
    throw new Error('workflow name must contain at least one safe filename character');
  }
  return cleaned;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`workflow run.json missing ${key}`);
  }
  return value;
}

async function scanDir(
  dir: string | undefined,
  source: SavedWorkflowSource,
): Promise<SavedWorkflowRef[]> {
  if (!dir) return [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return []; // missing dir → no saved workflows
  }
  const byName = new Map<string, SavedWorkflowRef>();
  for (const suffix of WORKFLOW_SUFFIXES) {
    for (const entry of entries) {
      if (!entry.endsWith(suffix)) continue;
      const name = stripWorkflowSuffix(entry);
      if (!name) continue;
      if (name.length === 0 || byName.has(name)) continue; // higher-priority ext wins
      const path = join(dir, entry);
      byName.set(name, { name, path, source, execution: executionForPath(path) });
    }
  }
  return [...byName.values()];
}

/**
 * Discover saved workflows across the project + personal dirs. On a name
 * conflict the project copy wins. Result is sorted by name.
 */
export async function discoverSavedWorkflows(
  dirs: SavedWorkflowDirs,
): Promise<SavedWorkflowRef[]> {
  const personal = await scanDir(dirs.personal, 'personal');
  const project = await scanDir(dirs.project, 'project');
  const byName = new Map<string, SavedWorkflowRef>();
  for (const ref of personal) byName.set(ref.name, ref);
  for (const ref of project) byName.set(ref.name, ref); // project overrides personal
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function isWorkflowModule(value: unknown): value is WorkflowModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'meta' in value &&
    'run' in value &&
    typeof (value as { run: unknown }).run === 'function'
  );
}

/**
 * Normalize a loaded module into a `WorkflowModule`. Accepts:
 *   - `export default { meta, run }`
 *   - `export const workflow = {...}` (meta) + `export default <run fn>`
 *   - `export const meta` + `export const run`
 */
export function normalizeWorkflowModule(mod: Record<string, unknown>): WorkflowModule {
  const def = mod.default;
  if (isWorkflowModule(def)) return def;

  const run = typeof def === 'function' ? def : mod.run;
  const meta = mod.workflow ?? mod.meta;
  if (
    typeof run === 'function' &&
    typeof meta === 'object' &&
    meta !== null &&
    'name' in meta
  ) {
    return { meta: meta as WorkflowModule['meta'], run: run as WorkflowModule['run'] };
  }
  throw new Error(
    'invalid workflow module: expected a `{ meta, run }` default export, ' +
      'or `export const workflow = {...}` + a default run function',
  );
}

function parseGeneratedWorkflowFile(raw: string): SavedGeneratedWorkflowFile {
  const data = JSON.parse(raw) as unknown;
  if (!isRecord(data)) {
    throw new Error('generated workflow file must be an object');
  }
  if (data.format !== undefined && data.format !== 'kodax.workflow') {
    throw new Error(`unsupported workflow capsule format: ${String(data.format)}`);
  }
  if (data.format === 'kodax.workflow') {
    const capsule = validateWorkflowCapsule(data);
    return {
      manifest: capsule.manifest,
      source: capsule.source,
      capsule,
      legacy: false,
    };
  }
  const source = data.source;
  if (typeof source !== 'string' || source.trim().length === 0) {
    throw new Error('generated workflow file source must be a non-empty string');
  }
  const manifest = validateWorkflowScriptManifest(data.manifest);
  return {
    manifest,
    source,
    capsule: createWorkflowCapsule({
      minKodaxVersion: KODAX_WORKFLOW_CAPSULE_MIN_VERSION,
      manifest,
      source,
    }),
    legacy: true,
  };
}

export async function loadSavedWorkflowCapsule(filePath: string): Promise<WorkflowCapsule> {
  const generated = parseGeneratedWorkflowFile(await readFile(filePath, 'utf8'));
  return generated.capsule ?? createWorkflowCapsule({
    minKodaxVersion: KODAX_WORKFLOW_CAPSULE_MIN_VERSION,
    manifest: generated.manifest,
    source: generated.source,
  });
}

/** Dynamically import + normalize a saved workflow file. Executes local code. */
export async function loadSavedWorkflow(filePath: string): Promise<WorkflowModule> {
  if (filePath.endsWith('.workflow.json')) {
    return createWorkflowModuleFromCapsule(await loadSavedWorkflowCapsule(filePath));
  }
  const mod = (await import(pathToFileURL(filePath).href)) as Record<string, unknown>;
  return normalizeWorkflowModule(mod);
}

function deriveRequirements(manifest: WorkflowScriptManifest): WorkflowCapsuleRequirements | undefined {
  if (manifest.mayUseWorktree !== true) return undefined;
  return { environment: ['git-repo', 'worktree-capable'] };
}

function assertGeneratedCapsuleSource(manifest: WorkflowScriptManifest, source: string): void {
  validateRestrictedWorkflowSource(source, {
    filename: `${manifest.name}.workflow.js`,
    requireAsyncRun: true,
  });
}

export async function saveGeneratedWorkflow(
  input: SaveGeneratedWorkflowInput,
): Promise<SavedWorkflowRef> {
  const safeName = safeWorkflowName(input.name);
  const manifest = validateWorkflowScriptManifest(input.manifest);
  assertGeneratedCapsuleSource(manifest, input.source);
  const requirements = input.requires ?? deriveRequirements(manifest);
  const capsule = createWorkflowCapsule({
    minKodaxVersion: input.minKodaxVersion ?? KODAX_WORKFLOW_CAPSULE_MIN_VERSION,
    manifest,
    source: input.source,
    ...(input.intent !== undefined ? { intent: input.intent } : {}),
    ...(input.inputs !== undefined ? { inputs: input.inputs } : {}),
    ...(requirements !== undefined ? { requires: requirements } : {}),
    ...(input.provenance !== undefined ? { provenance: input.provenance } : {}),
  });
  await mkdir(input.dir, { recursive: true });
  const path = join(input.dir, `${safeName}.workflow.json`);
  await writeFile(path, `${JSON.stringify(capsule, null, 2)}\n`, 'utf8');
  return {
    name: safeName,
    path,
    source: 'project',
    execution: 'capability-generated',
  };
}

async function writeCapsuleFile(path: string, capsule: WorkflowCapsule): Promise<void> {
  await writeFile(path, `${JSON.stringify(capsule, null, 2)}\n`, 'utf8');
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, 'utf8');
    return true;
  } catch {
    return false;
  }
}

export async function renameSavedWorkflow(
  input: RenameSavedWorkflowInput,
): Promise<SavedWorkflowRef> {
  const refs = (await discoverSavedWorkflows(input.dirs))
    .filter((ref) => ref.name === input.name)
    .filter((ref) => input.source === undefined || ref.source === input.source);
  if (refs.length === 0) {
    throw new Error(`saved workflow not found: ${input.name}`);
  }
  if (refs.length > 1) {
    throw new Error(`ambiguous saved workflow name: ${input.name}`);
  }
  const ref = refs[0]!;
  if (!ref.path.endsWith('.workflow.json')) {
    throw new Error('only generated workflow capsules can be renamed');
  }
  const safeName = safeWorkflowName(input.newName);
  const targetPath = join(dirname(ref.path), `${safeName}.workflow.json`);
  if (targetPath !== ref.path && await fileExists(targetPath)) {
    throw new Error(`saved workflow already exists: ${safeName}`);
  }
  const capsule = await loadSavedWorkflowCapsule(ref.path);
  assertGeneratedCapsuleSource(capsule.manifest, capsule.source);
  const renamed = createWorkflowCapsule({
    minKodaxVersion: capsule.minKodaxVersion,
    manifest: {
      ...capsule.manifest,
      name: safeName,
    },
    source: capsule.source,
    ...(capsule.intent !== undefined ? { intent: capsule.intent } : {}),
    ...(capsule.inputs !== undefined ? { inputs: capsule.inputs } : {}),
    ...(capsule.requires !== undefined ? { requires: capsule.requires } : {}),
    ...(capsule.provenance !== undefined ? { provenance: capsule.provenance } : {}),
  });
  await writeFile(targetPath, `${JSON.stringify(renamed, null, 2)}\n`, 'utf8');
  if (targetPath !== ref.path) await unlink(ref.path);
  return {
    name: safeName,
    path: targetPath,
    source: ref.source,
    execution: 'capability-generated',
  };
}

export async function deleteSavedWorkflow(
  input: DeleteSavedWorkflowInput,
): Promise<SavedWorkflowRef> {
  const refs = (await discoverSavedWorkflows(input.dirs))
    .filter((ref) => ref.name === input.name)
    .filter((ref) => input.source === undefined || ref.source === input.source);
  if (refs.length === 0) {
    throw new Error(`saved workflow not found: ${input.name}`);
  }
  if (refs.length > 1) {
    throw new Error(`ambiguous saved workflow name: ${input.name}`);
  }
  const ref = refs[0]!;
  if (!ref.path.endsWith('.workflow.json')) {
    throw new Error('only generated workflow capsules can be deleted');
  }
  await unlink(ref.path);
  return ref;
}

export async function replaceSavedWorkflow(
  input: ReplaceSavedWorkflowInput,
): Promise<ReplaceSavedWorkflowResult> {
  const safeName = safeWorkflowName(input.name);
  const refs = (await discoverSavedWorkflows(input.dirs))
    .filter((ref) => ref.name === safeName)
    .filter((ref) => input.savedSource === undefined || ref.source === input.savedSource);
  if (refs.length === 0) {
    throw new Error(`saved workflow not found: ${safeName}`);
  }
  if (refs.length > 1) {
    throw new Error(`ambiguous saved workflow name: ${safeName}`);
  }
  const ref = refs[0]!;
  if (!ref.path.endsWith('.workflow.json')) {
    throw new Error('only generated workflow capsules can be replaced');
  }

  const manifest = validateWorkflowScriptManifest({
    ...input.manifest,
    name: safeName,
  });
  assertGeneratedCapsuleSource(manifest, input.source);
  const requirements = input.requires ?? deriveRequirements(manifest);
  const capsule = createWorkflowCapsule({
    minKodaxVersion: input.minKodaxVersion ?? KODAX_WORKFLOW_CAPSULE_MIN_VERSION,
    manifest,
    source: input.source,
    ...(input.intent !== undefined ? { intent: input.intent } : {}),
    ...(input.inputs !== undefined ? { inputs: input.inputs } : {}),
    ...(requirements !== undefined ? { requires: requirements } : {}),
    ...(input.provenance !== undefined ? { provenance: input.provenance } : {}),
  });
  const previousCapsule = await loadSavedWorkflowCapsule(ref.path);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archiveDir = join(dirname(ref.path), '.revisions', safeName);
  const archiveSuffix = `${timestamp}-${process.hrtime.bigint().toString(36)}`;
  const previousPath = join(archiveDir, `${safeName}-${archiveSuffix}.workflow.json`);
  const tempPath = join(dirname(ref.path), `.${safeName}.${process.pid}.${Date.now().toString(36)}.tmp`);

  await mkdir(archiveDir, { recursive: true });
  await writeCapsuleFile(previousPath, previousCapsule);
  try {
    await writeCapsuleFile(tempPath, capsule);
    await rename(tempPath, ref.path);
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch {
      // Best-effort cleanup; rethrow the original replace failure.
    }
    throw error;
  }

  return {
    name: safeName,
    path: ref.path,
    source: ref.source,
    execution: 'capability-generated',
    previousPath,
  };
}

function readOptionalOriginalRequest(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined;
  const request = args.request;
  if (typeof request === 'string' && request.trim().length > 0) return request;
  const question = args.question;
  if (typeof question === 'string' && question.trim().length > 0) return question;
  return undefined;
}

function buildCapsuleFromRun(input: LoadGeneratedWorkflowFromRunInput): Promise<WorkflowCapsule> {
  return readCapsuleFromRun(input);
}

async function readCapsuleFromRun(input: LoadGeneratedWorkflowFromRunInput): Promise<WorkflowCapsule> {
  const runRaw = JSON.parse(await readFile(join(input.runDir, 'run.json'), 'utf8')) as unknown;
  if (!isRecord(runRaw)) {
    throw new Error('workflow run.json must be an object');
  }
  const scriptPath = readRequiredString(runRaw, 'scriptSnapshotPath');
  const manifestPath = readRequiredString(runRaw, 'manifestSnapshotPath');
  const source = await readFile(scriptPath, 'utf8');
  const manifest = validateWorkflowScriptManifest(
    JSON.parse(await readFile(manifestPath, 'utf8')) as unknown,
  );
  assertGeneratedCapsuleSource(manifest, source);
  const runId = typeof runRaw.runId === 'string' && runRaw.runId.length > 0
    ? runRaw.runId
    : basename(input.runDir);
  const originalRequest = readOptionalOriginalRequest(runRaw.args);
  const requirements = deriveRequirements(manifest);
  const intent: WorkflowCapsuleIntent = {
    taskClass: manifest.patterns[0] ?? manifest.name,
    ...(manifest.patterns.length > 0 ? { patterns: manifest.patterns } : {}),
    ...(originalRequest !== undefined ? { originalRequest } : {}),
    reusableFor: [manifest.description],
  };
  const inputs: WorkflowCapsuleInputs = {
    description: 'Provide new workflow args matching the generated request shape.',
    ...('args' in runRaw ? { examples: [runRaw.args] } : {}),
  };
  return createWorkflowCapsule({
    minKodaxVersion: KODAX_WORKFLOW_CAPSULE_MIN_VERSION,
    manifest,
    source,
    intent,
    inputs,
    ...(requirements !== undefined ? { requires: requirements } : {}),
    provenance: {
      fromRunId: runId,
      createdAt: new Date().toISOString(),
      kodaxVersion: currentKodaxWorkflowVersion(),
    },
  });
}

export async function loadGeneratedWorkflowFromRun(
  input: LoadGeneratedWorkflowFromRunInput,
): Promise<LoadedGeneratedWorkflowFromRun> {
  const capsule = await buildCapsuleFromRun(input);
  return {
    capsule,
    module: createWorkflowModuleFromCapsule(capsule),
  };
}

export async function saveGeneratedWorkflowFromRun(
  input: SaveGeneratedWorkflowFromRunInput,
): Promise<SavedWorkflowRef> {
  const capsule = await buildCapsuleFromRun(input);
  return saveGeneratedWorkflow({
    dir: input.targetDir,
    name: input.name,
    manifest: capsule.manifest,
    source: capsule.source,
    ...(capsule.intent !== undefined ? { intent: capsule.intent } : {}),
    ...(capsule.inputs !== undefined ? { inputs: capsule.inputs } : {}),
    ...(capsule.requires !== undefined ? { requires: capsule.requires } : {}),
    ...(capsule.provenance !== undefined ? { provenance: capsule.provenance } : {}),
    minKodaxVersion: capsule.minKodaxVersion,
  });
}

function addRequirementIssue(
  issues: WorkflowCapsulePreflightIssue[],
  severity: WorkflowCapsulePreflightIssue['severity'],
  requirement: string,
  message: string,
): void {
  issues.push({ severity, requirement, message });
}

function parseSemver(version: string): readonly [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  for (let i = 0; i < 3; i += 1) {
    const diff = a[i]! - b[i]!;
    if (diff !== 0) return diff;
  }
  return 0;
}

function addMinVersionIssue(
  issues: WorkflowCapsulePreflightIssue[],
  minKodaxVersion: string,
  currentVersion: string,
): void {
  const min = parseSemver(minKodaxVersion);
  const current = parseSemver(currentVersion);
  if (!min) {
    addRequirementIssue(
      issues,
      'error',
      'kodax:min-version',
      `workflow minKodaxVersion is not valid semver: ${minKodaxVersion}`,
    );
    return;
  }
  if (!current) {
    addRequirementIssue(
      issues,
      'warning',
      'kodax:min-version',
      `cannot verify workflow minKodaxVersion ${minKodaxVersion}; current version is unknown`,
    );
    return;
  }
  if (compareSemver(current, min) < 0) {
    addRequirementIssue(
      issues,
      'error',
      'kodax:min-version',
      `workflow requires KodaX >= ${minKodaxVersion}, current version is ${currentVersion}`,
    );
  }
}

function addMissingItems(
  issues: WorkflowCapsulePreflightIssue[],
  kind: 'tools' | 'mcp' | 'skills',
  required: readonly string[] | undefined,
  available: readonly string[] | undefined,
): void {
  if (!required) return;
  if (!available) {
    for (const item of required) {
      addRequirementIssue(
        issues,
        'warning',
        `${kind}:${item}`,
        `workflow requires ${kind}:${item}, but no ${kind} inventory was provided`,
      );
    }
    return;
  }
  const set = new Set(available);
  for (const item of required) {
    if (!set.has(item)) {
      addRequirementIssue(
        issues,
        'error',
        `${kind}:${item}`,
        `missing required workflow ${kind}: ${item}`,
      );
    }
  }
}

export function preflightWorkflowCapsule(
  capsule: WorkflowCapsule,
  env: WorkflowCapsulePreflightEnvironment = {},
): WorkflowCapsulePreflightResult {
  const validated = validateWorkflowCapsule(capsule);
  const issues: WorkflowCapsulePreflightIssue[] = [];
  const requirements = validated.requires;
  addMinVersionIssue(
    issues,
    validated.minKodaxVersion,
    env.kodaxVersion ?? currentKodaxWorkflowVersion(),
  );
  if (requirements?.environment?.includes('git-repo') && env.isGitRepo === false) {
    addRequirementIssue(
      issues,
      'error',
      'environment:git-repo',
      'workflow requires a git repository',
    );
  }
  if (
    requirements?.environment?.includes('worktree-capable') &&
    env.worktreeCapable === false
  ) {
    addRequirementIssue(
      issues,
      'error',
      'environment:worktree-capable',
      'workflow may request git worktree isolation',
    );
  }
  try {
    validateRestrictedWorkflowSource(validated.source, {
      filename: `${validated.manifest.name}.workflow.js`,
      requireAsyncRun: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    addRequirementIssue(
      issues,
      'error',
      'workflow:source',
      message,
    );
  }
  addMissingItems(issues, 'tools', requirements?.tools, env.availableTools);
  addMissingItems(issues, 'mcp', requirements?.mcp, env.availableMcp);
  addMissingItems(issues, 'skills', requirements?.skills, env.availableSkills);
  return {
    ok: !issues.some((issue) => issue.severity === 'error'),
    issues,
  };
}
