import { spawn } from 'child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import iconv from 'iconv-lite';
import {
  containWindowsEffectProcess,
  emitKodaXDiagnostic,
  isCurrentProcessWindowsJobContained,
  killChildProcessTree,
  killChildProcessTreeSync,
  prepareJavaScriptChildLaunch,
  registerManagedChildProcess,
  type WindowsEffectJob,
} from '@kodax-ai/agent';
import { KODAX_DEFAULT_TIMEOUT, KODAX_HARD_TIMEOUT } from '../constants.js';
import type { KodaXToolExecutionContext } from '../types.js';
import { resolveExecutionCwd } from '../runtime-paths.js';
import {
  BASH_CAPTURE_COMPLETE_MARKER,
  BASH_CAPTURE_INCOMPLETE_MARKER,
  appendBashOutputChunk,
  createBashOutputCollector,
  disposeBashOutputCollector,
  finishBashOutputCollector,
  finishBashOutputRecovery,
  startBashOutputRecovery,
  type BashOutputCollector,
} from './bash-output-collector.js';
import { filterBashOutputBodies } from './output-filters/registry.js';
import { shellMemoryMutationDenial } from './memory-mutation-guard.js';
import {
  getToolResultPolicy,
  TOOL_RESULT_INCOMPLETE_MARKER,
} from './tool-result-policy.js';
import { persistToolOutput } from './truncate.js';
import {
  createShellCommandInvocation,
  resolveShellExecution,
} from '../shell-execution/resolver.js';
import {
  hardenShellCommandEnvironment,
  normalizeSandboxEnvironmentPass,
  parseSandboxEnvironmentPass,
} from '../shell-execution/environment.js';
import {
  acquireFileSystemMutationLease,
  type FileSystemMutationLeaseRelease,
} from './_internal/file-mutation-queue.js';

const BACKGROUND_ABORT_KILL_MS = process.platform === 'win32' ? 5_000 : 2_000;
const FOREGROUND_CLOSE_DRAIN_MS = process.platform === 'win32' ? 2_000 : 1_000;
const POSIX_EFFECT_GATE = 'IFS= read -r gate && [ "$gate" = go ] && exec "$@"';
const WINDOWS_EFFECT_GATE = [
  "const readline=require('node:readline')",
  "const {spawn}=require('node:child_process')",
  "const input=readline.createInterface({input:process.stdin,terminal:false})",
  "input.once('line',(gate)=>{",
  "input.close()",
  "if(gate!=='go'){process.exit(125);return}",
  "const payload=JSON.parse(process.env.KODAX_EFFECT_COMMAND_JSON||'{}')",
  "delete process.env.KODAX_EFFECT_COMMAND_JSON",
  "if(payload.electronRunAsNode===true)process.env.ELECTRON_RUN_AS_NODE='1'",
  "const child=spawn(payload.executable,payload.args,{stdio:'inherit',shell:false,windowsHide:true,windowsVerbatimArguments:payload.windowsVerbatimArguments===true})",
  "child.once('error',(error)=>{process.stderr.write(String(error&&error.message||error));process.exitCode=1})",
  "child.once('close',(code)=>setTimeout(()=>process.exit(Number.isInteger(code)?code:1),150))",
  "})",
].join(';');

type ManagedChildProcess = Parameters<typeof killChildProcessTree>[0];
type KillChildProcessTreeOptions = NonNullable<Parameters<typeof killChildProcessTree>[1]>;

interface StreamRecovery {
  readonly path?: string;
  readonly error?: string;
}

interface ForegroundOutputRecovery {
  readonly stdout: StreamRecovery;
  readonly stderr: StreamRecovery;
}

function sandboxLifecycleErrorDetail(error: unknown): string {
  if (error instanceof AggregateError) {
    const details = error.errors.map(sandboxLifecycleErrorDetail).filter(Boolean);
    return [error.message, ...details].join(': ');
  }
  if (error instanceof Error) {
    const cause = error.cause === undefined ? '' : `: ${sandboxLifecycleErrorDetail(error.cause)}`;
    return `${error.message}${cause}`;
  }
  return String(error);
}

function gatedShellInvocation(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  windowsVerbatimArguments?: boolean,
): {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly windowsVerbatimArguments?: boolean;
} {
  if (process.platform !== 'win32') {
    return {
      executable: '/bin/sh',
      args: ['-c', POSIX_EFFECT_GATE, 'kodax-shell-effect', executable, ...args],
      env,
    };
  }
  const launch = prepareJavaScriptChildLaunch({
    args: ['-e', WINDOWS_EFFECT_GATE],
    env: {
      ...env,
      KODAX_EFFECT_COMMAND_JSON: JSON.stringify({
        executable,
        args,
        windowsVerbatimArguments: windowsVerbatimArguments === true,
        electronRunAsNode:
          process.versions.electron !== undefined
          && env.ELECTRON_RUN_AS_NODE === '1'
          && executable.toLowerCase() === process.execPath.toLowerCase(),
      }),
    },
    isElectron: process.versions.electron !== undefined,
  });
  return {
    executable: launch.command,
    args: launch.args,
    env: launch.env,
  };
}

function cancelledCommandResult(command: string): string {
  return `Command: ${command}\n[Cancelled] Operation cancelled by user`;
}

function commandPreparationTimeoutResult(command: string, timeout: number): string {
  return `Command: ${command}\n[Timeout] Command was not started because preparation exceeded ${timeout}s`;
}

function startStreamRecovery(collector: BashOutputCollector): StreamRecovery {
  try {
    return { path: startBashOutputRecovery(collector) };
  } catch (error) {
    return {
      path: collector.spoolPath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function startForegroundOutputRecovery(
  stdout: BashOutputCollector,
  stderr: BashOutputCollector,
): ForegroundOutputRecovery {
  return {
    stdout: startStreamRecovery(stdout),
    stderr: startStreamRecovery(stderr),
  };
}

function finishForegroundOutputRecovery(
  recovery: ForegroundOutputRecovery,
  stdout: BashOutputCollector,
  stderr: BashOutputCollector,
): void {
  if (recovery.stdout.path) finishBashOutputRecovery(stdout);
  else disposeBashOutputCollector(stdout);
  if (recovery.stderr.path) finishBashOutputRecovery(stderr);
  else disposeBashOutputCollector(stderr);
}

async function buildGuaranteedOversizeResult(
  command: string,
  exitCode: number | null,
  stdout: BashOutputCollector,
  stderr: BashOutputCollector,
  ctx: KodaXToolExecutionContext,
): Promise<string | undefined> {
  const policy = getToolResultPolicy('bash');
  const totalBytes = stdout.totalBytes + stderr.totalBytes;
  const totalLines = stdout.totalLines + stderr.totalLines;
  const capacityTokens = ctx.toolResultCapacityTokens ?? ctx.maximumInputTokens;
  const exceedsCapacity = capacityTokens !== undefined
    && totalBytes > Math.max(0, Math.floor(capacityTokens)) * 4;
  const exceedsPolicy = totalBytes > policy.maxBytes || totalLines > policy.maxLines;
  if (!exceedsPolicy && !exceedsCapacity) return undefined;

  const recovery = startForegroundOutputRecovery(stdout, stderr);
  if (!recovery.stdout.path || !recovery.stderr.path) return undefined;
  const stdoutComplete = finishBashOutputRecovery(stdout);
  const stderrComplete = finishBashOutputRecovery(stderr);
  const completion = stdoutComplete && stderrComplete
    ? 'Both artifacts are sealed with KODAX_CAPTURE_COMPLETE.'
    : 'At least one artifact could not be sealed; inspect its tail before relying on completeness.';
  let recoveryPath = recovery.stdout.path;
  try {
    recoveryPath = await persistToolOutput('bash-recovery-manifest', [
      `Command: ${command}`,
      `Exit: ${exitCode}`,
      `stdout recovery: ${recovery.stdout.path}`,
      `stderr recovery: ${recovery.stderr.path}`,
      completion,
    ].join('\n'), ctx);
  } catch {
    // The sealed stream artifacts remain recoverable and are still surfaced.
  }
  if (ctx.toolCallId) ctx.recordToolResultArtifact?.(ctx.toolCallId, recoveryPath);
  return [
    `Command: ${command}`,
    `Exit: ${exitCode}`,
    `stdout recovery: ${recovery.stdout.path}`,
    `stderr recovery: ${recovery.stderr.path}`,
    completion,
    `[${TOOL_RESULT_INCOMPLETE_MARKER}. Raw Bash output exceeded `
      + `${exceedsPolicy ? `the ${policy.maxBytes}-byte/${policy.maxLines}-line policy` : 'the active request capacity'} `
      + `and was not materialized inline. Full output saved to: ${recoveryPath}.]`,
  ].join('\n');
}

function openBackgroundLog(outputFile: string): Promise<WriteStream> {
  return new Promise<WriteStream>((resolve, reject) => {
    const stream = createWriteStream(outputFile, { flags: 'wx', mode: 0o600 });
    const onOpen = (): void => {
      stream.off('error', onError);
      resolve(stream);
    };
    const onError = (error: Error): void => {
      stream.off('open', onOpen);
      reject(error);
    };
    stream.once('open', onOpen);
    stream.once('error', onError);
  });
}

function killChildProcessTreeBestEffort(
  proc: ManagedChildProcess,
  options?: KillChildProcessTreeOptions,
  onSettled?: () => void,
): void {
  void killChildProcessTree(proc, options)
    .catch(() => undefined)
    .then(() => {
      if (!onSettled) return;
      try {
        onSettled();
      } catch {
        // Kill cleanup is an observer path; it must never promote a cancelled
        // shell command into a process-level unhandled rejection.
      }
    })
    .catch(() => {});
}

type DecodeResult = {
  text: string;
  /** True when Windows UTF-8 decode produced replacement chars and GBK fallback was used. */
  encodingFallback: boolean;
};

function decodeCollector(collector: BashOutputCollector): DecodeResult {
  const buffer = finishBashOutputCollector(collector);
  try {
    if (buffer.length === 0) {
      return { text: '', encodingFallback: false };
    }

    if (process.platform === 'win32') {
      try {
        const text = buffer.toString('utf-8');
        if (!/[\uFFFD]/.test(text)) {
          return { text, encodingFallback: false };
        }
      } catch {
        // Fall through to GBK decoding on Windows.
      }
      return { text: iconv.decode(buffer, 'gbk'), encodingFallback: true };
    }

    return { text: buffer.toString('utf-8'), encodingFallback: false };
  } finally {
    // The decoded string is the canonical in-memory representation from here;
    // retaining the raw Buffer would double steady-state memory for large output.
    collector.finalBuffer = undefined;
  }
}

/**
 * Y-1/Y-2: Pre-flight detection of Windows cmd gotchas that commonly cause silent
 * failures (exit 0 + no output) because cmd's argument parsing mangles the command
 * before the real interpreter sees it. These hints are appended to tool output so
 * the LLM can recognize the pattern instead of retrying the same broken approach.
 */
function detectWindowsCmdGotchas(
  command: string,
  usesWindowsCmd: boolean,
): string[] {
  if (!usesWindowsCmd) return [];
  const hints: string[] = [];

  // Y-1: python/node/ruby/perl -c/-e with an embedded newline in the quoted string.
  // Windows cmd splits arguments on newlines before the interpreter runs, so
  // multi-line inline scripts fail silently (script body is lost or truncated).
  // Allow other flags between the interpreter and -c/-e (e.g. `python -u -c`,
  // `python -OO -c`) — the user's exact failure used `python -u -c`.
  if (/\b(python3?|node|ruby|perl)\s+(?:-\w+\s+)*-[ce]\s+"[^"]*\n/.test(command)) {
    hints.push(
      '[hint] Windows cmd mangles multi-line inline scripts passed via -c/-e; the script body may not reach the interpreter. Write a .py/.js/.rb/.pl file and run it instead.',
    );
  }

  // Y-2: POSIX heredoc (<<EOF, <<-EOF, <<'EOF') is not supported by cmd.
  // cmd reads <<EOF as redirection-with-no-source and the "heredoc body" becomes
  // separate commands that silently fail. Require end-of-line after the delimiter
  // to avoid false positives on non-heredoc uses like `echo <<word>>` where the
  // `<<word>` appears mid-line without heredoc semantics.
  if (/<<-?\s*(['"])?[A-Za-z_][A-Za-z0-9_]*\1?[ \t]*(?:\r?\n|$)/.test(command)) {
    hints.push(
      '[hint] Windows cmd does not support heredoc (<<EOF). Write a script file or use PowerShell with a here-string.',
    );
  }

  return hints;
}

interface ToolBashInternalOptions {
  readonly bypassEffectContainment?: boolean;
}

export function toolBash(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  return executeToolBash(input, ctx, {});
}

async function executeToolBash(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
  internal: ToolBashInternalOptions,
): Promise<string> {
  const command = input.command as string;
  const memoryDenial = shellMemoryMutationDenial(command);
  if (memoryDenial !== undefined) return memoryDenial;
  const userTimeout = input.timeout as number | undefined;
  const timeout = userTimeout ? Math.min(KODAX_HARD_TIMEOUT, userTimeout) : KODAX_DEFAULT_TIMEOUT;
  const deadlineAt = Date.now() + timeout * 1000;
  const capped = userTimeout && userTimeout > KODAX_HARD_TIMEOUT;
  const runInBackground = (input.run_in_background as boolean) ?? false;
  const cwd = resolveExecutionCwd(ctx);
  const usesWindowsCmd =
    process.platform === 'win32'
    && (ctx.shellExecution === undefined || ctx.shellExecution.shell.kind === 'cmd');
  const legacyEnvSource = ctx.sessionScratchDir
    ? {
      ...process.env,
      KODAX_SESSION_TMP: ctx.sessionScratchDir,
    }
    : process.env;
  const environmentPass = ctx.sandbox === undefined
    ? parseSandboxEnvironmentPass(process.env.KODAX_SANDBOX_ENV_PASS)
    : normalizeSandboxEnvironmentPass(ctx.sandbox.envPass);
  const legacyEnv = hardenShellCommandEnvironment(
    legacyEnvSource,
    usesWindowsCmd ? 'cmd' : 'bash',
    process.platform,
    ctx.providerCredentialEnvironmentNames,
    cwd,
    environmentPass,
  );
  const legacyCommandInvocation = usesWindowsCmd
    ? {
      executable: legacyEnv.ComSpec ?? legacyEnv.COMSPEC ?? 'cmd.exe',
      args: [
        '/d',
        '/v:off',
        '/s',
        '/c',
        command.trimStart().startsWith('"') ? `"${command.trimStart()}"` : command,
      ],
      env: legacyEnv,
      windowsVerbatimArguments: true as const,
    }
    : undefined;
  let commandInvocation:
    | ReturnType<typeof createShellCommandInvocation>
    | undefined;
  if (ctx.shellExecution !== undefined) {
    if (ctx.abortSignal?.aborted) return cancelledCommandResult(command);
    try {
      const resolved = await resolveShellExecution(
        ctx.shellExecution,
        cwd,
        ctx.sessionScratchDir,
        ctx.providerCredentialEnvironmentNames,
        ctx.abortSignal,
      );
      commandInvocation = createShellCommandInvocation(resolved, command, environmentPass);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return cancelledCommandResult(command);
      }
      const message = error instanceof Error ? error.message : String(error);
      return `[Error] Command was not started because the configured shell environment could not be resolved: ${message}`;
    }
  }
  let sandboxInvocation:
    | Awaited<ReturnType<NonNullable<typeof ctx.shellSandbox>['prepare']>>
    | undefined;
  if (ctx.shellSandbox) {
    try {
      sandboxInvocation = await ctx.shellSandbox.prepare({
        toolCallId: ctx.toolCallId,
        toolInput: input,
        command,
        executable: commandInvocation?.executable ?? legacyCommandInvocation?.executable,
        args: commandInvocation?.args ?? legacyCommandInvocation?.args,
        cwd,
        env: commandInvocation?.env ?? legacyEnv,
        windowsVerbatimArguments: commandInvocation?.windowsVerbatimArguments
          ?? legacyCommandInvocation?.windowsVerbatimArguments,
        signal: ctx.abortSignal,
        deadlineAt,
        reportObservation: ctx.reportToolSandboxObservation,
      });
    } catch (error: unknown) {
      if (ctx.abortSignal?.aborted) return cancelledCommandResult(command);
      if (Date.now() >= deadlineAt) {
        return commandPreparationTimeoutResult(command, timeout);
      }
      ctx.reportToolSandboxObservation?.({
        version: 1,
        state: 'fallback',
        reason: 'prepare_failed',
        execution: 'normal_permission_policy',
      });
    }
  }
  let sandboxCleanup:
    | Promise<Awaited<ReturnType<NonNullable<typeof sandboxInvocation>['cleanup']>>>
    | undefined;
  let sandboxCleanupError: unknown;
  let sandboxRetirement: Promise<void> | undefined;
  const retireFailedSandbox = async (): Promise<void> => {
    if (!sandboxInvocation?.retire) return;
    sandboxRetirement ??= sandboxInvocation.retire();
    try {
      await sandboxRetirement;
    } catch (error: unknown) {
      sandboxCleanupError = new AggregateError(
        [sandboxCleanupError, error],
        'Sandbox cleanup and workspace-session retirement both failed.',
      );
      emitKodaXDiagnostic({
        source: 'coding:bash-sandbox',
        level: 'warn',
        message: 'Workspace sandbox session retirement failed.',
        detail: error,
      });
    }
  };
  const cleanupSandbox = async (
    execution: 'not_started' | 'started_or_unknown' = 'not_started',
  ): Promise<void> => {
    if (!sandboxInvocation) return;
    sandboxCleanup ??= sandboxInvocation.cleanup({ execution }).then((observation) => {
      if (observation) ctx.reportToolSandboxObservation?.(observation);
      return observation;
    });
    try {
      await sandboxCleanup;
    } catch (error: unknown) {
      sandboxCleanupError = sandboxCleanupError === undefined
        ? error
        : new AggregateError(
            [sandboxCleanupError, error],
            'Multiple required OS sandbox cleanup operations failed.',
          );
      emitKodaXDiagnostic({
        source: 'coding:bash-sandbox',
        level: 'warn',
        message: 'Workspace sandbox diagnostics cleanup failed.',
        detail: error,
      });
      await retireFailedSandbox();
    }
  };
  const withSandboxCleanupFailure = (result: string): string => {
    if (sandboxCleanupError === undefined) return result;
    const detail = sandboxLifecycleErrorDetail(sandboxCleanupError);
    return `${result}\n[Error] Required OS sandbox cleanup failed: ${detail}`;
  };
  if (ctx.abortSignal?.aborted) {
    await cleanupSandbox();
    return withSandboxCleanupFailure(cancelledCommandResult(command));
  }
  if (Date.now() >= deadlineAt) {
    await cleanupSandbox();
    return withSandboxCleanupFailure(commandPreparationTimeoutResult(command, timeout));
  }
  const ordinaryInvocation: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly env: NodeJS.ProcessEnv;
    readonly windowsVerbatimArguments?: boolean;
  } = commandInvocation
    ?? legacyCommandInvocation
    ?? (process.platform === 'win32'
      ? {
          executable: process.env.COMSPEC ?? pathJoin(
            process.env.SystemRoot ?? 'C:\\Windows',
            'System32',
            'cmd.exe',
          ),
          args: ['/d', '/s', '/c', command],
          env: legacyEnv,
        }
      : { executable: '/bin/sh', args: ['-c', command], env: legacyEnv });
  const resolvedInvocation = sandboxInvocation ?? ordinaryInvocation;
  const gatedInvocation = internal.bypassEffectContainment
    ? resolvedInvocation
    : gatedShellInvocation(
        resolvedInvocation.executable,
        resolvedInvocation.args,
        resolvedInvocation.env,
        resolvedInvocation.windowsVerbatimArguments,
      );
  const spawnCommand = () => spawn(
    gatedInvocation.executable,
    [...gatedInvocation.args],
    {
      shell: false,
      windowsHide: true,
      cwd,
      env: gatedInvocation.env,
      detached: process.platform !== 'win32',
      windowsVerbatimArguments: gatedInvocation.windowsVerbatimArguments,
    },
  );

  const preparedEffectLease = sandboxInvocation?.fileSystemEffectLease;
  let releaseMutationLease: FileSystemMutationLeaseRelease;
  try {
    releaseMutationLease = preparedEffectLease === undefined
      ? await acquireFileSystemMutationLease(sandboxInvocation?.fileSystemEffectPolicyKey)
      : Object.assign(
          () => preparedEffectLease.release(),
          {
            bindEffectProcess: (
              pid: number,
              windowsJobContained: boolean,
            ) => preparedEffectLease.bindEffectProcess(pid, windowsJobContained),
            finishEffectProcess: () => preparedEffectLease.finishEffectProcess(),
          },
        );
  } catch (error) {
    await cleanupSandbox();
    const message = error instanceof Error ? error.message : String(error);
    return withSandboxCleanupFailure(
      `[Error] Command was not started because another filesystem effect is active: ${message}`,
    );
  }
  let mutationLeaseReleased = false;
  let mutationLeaseRelease: Promise<void> | undefined;
  let mutationProcessBinding: Promise<void> = Promise.resolve();
  let mutationProcessBindingSettled = true;
  let mutationProcessBindingFailed = false;
  let mutationProcessBindingError: unknown;
  let mutationStartCommitted = false;
  let mutationStartBlockedReason: 'cancelled' | 'timeout' | undefined;
  let windowsEffectJob: WindowsEffectJob | undefined;
  const recordEffectLifecycleFailure = (error: unknown): void => {
    sandboxCleanupError = sandboxCleanupError === undefined
      ? error
      : new AggregateError(
          [sandboxCleanupError, error],
          'Multiple required OS sandbox lifecycle operations failed.',
        );
  };
  const releaseMutation = (): Promise<void> => {
    if (mutationLeaseReleased) return Promise.resolve();
    mutationLeaseRelease ??= mutationProcessBinding
      .then(() => undefined, () => undefined)
      .then(() => releaseMutationLease())
      .then(() => {
        mutationLeaseReleased = true;
      })
      .catch((error: unknown) => {
        recordEffectLifecycleFailure(error);
        emitKodaXDiagnostic({
          source: 'coding:bash-filesystem-effect',
          level: 'warn',
          message: 'Filesystem effect lock cleanup failed; a later lifecycle event may retry it.',
          detail: error,
        });
      })
      .finally(() => {
        mutationLeaseRelease = undefined;
      });
    return mutationLeaseRelease;
  };
  const bindMutationProcess = async (proc: ManagedChildProcess): Promise<void> => {
    if (proc.pid === undefined || (!internal.bypassEffectContainment && proc.stdin === null)) {
      throw new Error('Shell effect gate did not expose a managed process and stdin.');
    }
    if (internal.bypassEffectContainment) {
      mutationStartCommitted = true;
      return;
    }
    mutationProcessBindingSettled = false;
    mutationProcessBinding = (async () => {
      if (process.platform === 'win32') {
        windowsEffectJob = await containWindowsEffectProcess(proc.pid!);
      }
      await releaseMutationLease.bindEffectProcess(
        windowsEffectJob?.supervisorPid ?? proc.pid!,
        windowsEffectJob !== undefined || isCurrentProcessWindowsJobContained(),
      );
      if (mutationStartBlockedReason === 'cancelled' || ctx.abortSignal?.aborted) {
        mutationStartBlockedReason = 'cancelled';
        throw new DOMException('Operation aborted', 'AbortError');
      }
      if (mutationStartBlockedReason === 'timeout' || Date.now() >= deadlineAt) {
        mutationStartBlockedReason = 'timeout';
        throw new Error('Command deadline expired before the effect gate was authorized.');
      }
      sandboxInvocation?.authorizeStart?.();
      mutationStartCommitted = true;
      proc.stdin!.end('go\n');
    })().catch(async (error: unknown) => {
      mutationProcessBindingFailed = true;
      mutationProcessBindingError = error;
      await killChildProcessTree(proc);
      await windowsEffectJob?.drained.catch(() => undefined);
      emitKodaXDiagnostic({
        source: 'coding:bash-filesystem-effect',
        level: 'warn',
        message: 'Filesystem effect process identity could not be persisted; crash recovery stays fail-closed.',
        detail: error,
      });
      throw error;
    }).finally(() => {
      mutationProcessBindingSettled = true;
    });
    let stopWait: ((reason: 'cancelled' | 'timeout') => void) | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const stopped = new Promise<void>((_resolve, reject) => {
      let stoppedOnce = false;
      stopWait = (reason) => {
        if (stoppedOnce) return;
        stoppedOnce = true;
        mutationStartBlockedReason = reason;
        killChildProcessTreeBestEffort(proc, { forceMs: 500, taskkillMs: 500 });
        reject(reason === 'cancelled'
          ? new DOMException('Operation aborted', 'AbortError')
          : new Error('Command deadline expired while effect binding was pending.'));
      };
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) stopWait('timeout');
      else {
        deadlineTimer = setTimeout(() => stopWait?.('timeout'), remaining);
        deadlineTimer.unref();
      }
    });
    const onAbort = (): void => stopWait?.('cancelled');
    ctx.abortSignal?.addEventListener('abort', onAbort, { once: true });
    if (ctx.abortSignal?.aborted) onAbort();
    try {
      await Promise.race([mutationProcessBinding, stopped]);
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      ctx.abortSignal?.removeEventListener('abort', onAbort);
    }
  };
  const spawnWithMutationLease = () => {
    try {
      return spawnCommand();
    } catch (error) {
      void cleanupSandbox().then(() => releaseMutation());
      throw error;
    }
  };
  const registerMutationProcess = (
    proc: ManagedChildProcess,
    kind: 'bash' | 'bash-background',
  ): (() => void) => {
    try {
      return registerManagedChildProcess(proc, { kind, command, cwd }, {
        manualUnregister: true,
        requireDurableRecord: true,
      });
    } catch (error) {
      killChildProcessTreeSync(proc);
      void cleanupSandbox().then(() => releaseMutation());
      throw error;
    }
  };
  const finishBoundMutationProcess = async (proc: ManagedChildProcess): Promise<boolean> => {
    let drained = false;
    try {
      await mutationProcessBinding;
    } catch (error: unknown) {
      mutationProcessBindingFailed = true;
      mutationProcessBindingError ??= error;
    }
    if (internal.bypassEffectContainment) {
      // The root process has emitted close. This narrow path is selected only
      // after the normal Windows Job primitive failed before the sandbox target
      // started, so it must not re-enter that same unavailable containment.
      drained = true;
    } else if (windowsEffectJob !== undefined) {
      try {
        await windowsEffectJob.drained;
        drained = true;
      } catch (error: unknown) {
        emitKodaXDiagnostic({
          source: 'coding:bash-filesystem-effect',
          level: 'warn',
          message: 'Windows effect Job did not prove an empty process tree.',
          detail: error,
        });
      }
    } else {
      try {
        drained = (await killChildProcessTree(proc, {
          forceMs: 500,
          taskkillMs: 500,
        })).status !== 'unknown';
      } catch (error: unknown) {
        emitKodaXDiagnostic({
          source: 'coding:bash-filesystem-effect',
          level: 'warn',
          message: 'Shell effect tree cleanup attempt failed.',
          detail: error,
        });
      }
    }
    if (!drained) {
      recordEffectLifecycleFailure(new Error(
        'Shell effect process tree termination was not confirmed; '
        + 'later filesystem effects remain fenced.',
      ));
      await cleanupSandbox(
        mutationProcessBindingFailed ? 'not_started' : 'started_or_unknown',
      );
      emitKodaXDiagnostic({
        source: 'coding:bash-filesystem-effect',
        level: 'warn',
        message: 'Shell effect tree could not be proven drained; the filesystem fence remains closed.',
      });
      return false;
    }
    if (!internal.bypassEffectContainment) {
      try {
        await releaseMutationLease.finishEffectProcess();
      } catch (error: unknown) {
        recordEffectLifecycleFailure(error);
        emitKodaXDiagnostic({
          source: 'coding:bash-filesystem-effect',
          level: 'warn',
          message: 'Filesystem effect completion could not be persisted.',
          detail: error,
        });
      }
    }
    await cleanupSandbox(
      mutationProcessBindingFailed ? 'not_started' : 'started_or_unknown',
    );
    await releaseMutation();
    return true;
  };
  const executeNormalPermissionFallback = async (): Promise<string | undefined> => {
    if (
      sandboxInvocation === undefined
      || mutationStartCommitted
      || !mutationLeaseReleased
    ) return undefined;
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) return commandPreparationTimeoutResult(command, timeout);
    ctx.reportToolSandboxObservation?.({
      version: 1,
      state: 'fallback',
      reason: 'backend_failed',
      execution: 'normal_permission_policy',
    });
    return withSandboxCleanupFailure(await executeToolBash(
      { ...input, timeout: remainingMs / 1_000 },
      { ...ctx, shellSandbox: undefined },
      { bypassEffectContainment: true },
    ));
  };
  if (ctx.abortSignal?.aborted) {
    await cleanupSandbox();
    await releaseMutation();
    return withSandboxCleanupFailure(cancelledCommandResult(command));
  }
  if (Date.now() >= deadlineAt) {
    await cleanupSandbox();
    await releaseMutation();
    return withSandboxCleanupFailure(commandPreparationTimeoutResult(command, timeout));
  }

  if (runInBackground) {
    const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const outputFile = pathJoin(tmpdir(), `kodax-bg-${jobId}.log`);
    let logStream: WriteStream;
    try {
      logStream = await openBackgroundLog(outputFile);
    } catch (error) {
      await cleanupSandbox();
      await releaseMutation();
      const message = error instanceof Error ? error.message : String(error);
      return withSandboxCleanupFailure(
        `[Error] Background command was not started because its output file could not be created: ${message}`,
      );
    }

    // POSIX background jobs get a process group so cleanup can signal -pid and
    // reap shell descendants.
    const proc = spawnWithMutationLease();
    const unregisterManagedChild = registerMutationProcess(proc, 'bash-background');
    const cleanupOnProcessExit = (): void => {
      killChildProcessTreeSync(proc);
    };
    if (!isCurrentProcessWindowsJobContained()) process.once('exit', cleanupOnProcessExit);
    const abortSignal = ctx.abortSignal;
    let cleaned = false;
    let managedChildUnregistered = false;
    let onAbort: (() => void) | undefined;
    const clearProcessHooks = (): void => {
      if (cleaned) return;
      cleaned = true;
      process.off('exit', cleanupOnProcessExit);
      if (onAbort) {
        abortSignal?.removeEventListener('abort', onAbort);
      }
    };
    const cleanupProcessHooks = (): void => {
      clearProcessHooks();
      if (managedChildUnregistered) return;
      managedChildUnregistered = true;
      unregisterManagedChild();
    };
    const stopBackgroundProcess = (): void => {
      killChildProcessTreeBestEffort(proc, {
        forceMs: BACKGROUND_ABORT_KILL_MS,
        taskkillMs: BACKGROUND_ABORT_KILL_MS,
      });
    };
    let finishBackgroundEffect: Promise<boolean> | undefined;
    const finishBackground = (): Promise<boolean> => {
      finishBackgroundEffect ??= proc.pid === undefined
        ? cleanupSandbox().then(async () => {
            await releaseMutation();
            return true;
          })
        : finishBoundMutationProcess(proc);
      return finishBackgroundEffect;
    };
    logStream.on('error', (error) => {
      try {
        ctx.reportToolProgress?.(`[Background capture failed; stopping command] ${error.message}`);
      } catch {
        // The process stop below is authoritative; progress rendering is optional.
      }
      stopBackgroundProcess();
    });

    proc.stdout?.pipe(logStream, { end: false });
    proc.stderr?.pipe(logStream, { end: false });
    const reportBackgroundCleanupFailure = (error: unknown): void => {
      emitKodaXDiagnostic({
        source: 'coding:bash-filesystem-effect',
        level: 'warn',
        message: 'Background shell effect cleanup remains fenced after its process settled.',
        detail: error,
      });
      clearProcessHooks();
      if (!logStream.destroyed) logStream.end();
    };
    const backgroundSandboxFailure = (): string | undefined => {
      if (sandboxCleanupError === undefined) return undefined;
      const detail = sandboxLifecycleErrorDetail(sandboxCleanupError);
      return `\n[Error] Required OS sandbox execution could not be verified: ${detail}\n`
        + '[Safety] The command was not retried because it may have started.\n';
    };
    proc.on('close', (code) => {
      void (async () => {
        if (await finishBackground()) cleanupProcessHooks();
        else clearProcessHooks();
        if (!logStream.destroyed) {
          logStream.write(backgroundSandboxFailure() ?? `\n[Exit: ${code}]\n`);
          logStream.end();
        }
      })().catch(reportBackgroundCleanupFailure);
    });
    proc.on('error', (err) => {
      void (async () => {
        if (await finishBackground()) cleanupProcessHooks();
        else clearProcessHooks();
        if (!logStream.destroyed) {
          logStream.write(
            backgroundSandboxFailure() ?? `\n[Error: ${err.message}]\n`,
          );
          logStream.end();
        }
      })().catch(reportBackgroundCleanupFailure);
    });
    try {
      await bindMutationProcess(proc);
    } catch (error: unknown) {
      if (mutationStartBlockedReason !== undefined && !mutationProcessBindingSettled) {
        void finishBackground().then(
          (drained) => drained ? cleanupProcessHooks() : clearProcessHooks(),
          reportBackgroundCleanupFailure,
        );
        const pending = mutationStartBlockedReason === 'cancelled'
          ? cancelledCommandResult(command)
          : commandPreparationTimeoutResult(command, timeout);
        return `${pending}\n[Safety] Filesystem-effect binding is still pending; later effects remain fenced.`;
      }
      let drained = false;
      try {
        drained = await finishBackground();
        if (drained) cleanupProcessHooks();
      } catch (cleanupError: unknown) {
        emitKodaXDiagnostic({
          source: 'coding:bash-filesystem-effect',
          level: 'warn',
          message: 'Failed background binding cleanup remains fenced.',
          detail: cleanupError,
        });
      }
      if (mutationStartBlockedReason === 'cancelled') {
        return withSandboxCleanupFailure(cancelledCommandResult(command));
      }
      if (mutationStartBlockedReason === 'timeout') {
        return withSandboxCleanupFailure(commandPreparationTimeoutResult(command, timeout));
      }
      if (drained) {
        const fallback = await executeNormalPermissionFallback();
        if (fallback !== undefined) return fallback;
      }
      const detail = error instanceof Error ? error.message : String(error);
      return `Command: ${command}\n[Error] Command was not started because filesystem-effect binding failed: ${detail}`;
    }
    if (abortSignal?.aborted) {
      stopBackgroundProcess();
    } else if (abortSignal) {
      onAbort = stopBackgroundProcess;
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    return `Command started in background.\nPID: ${proc.pid}\nOutput: ${outputFile}\n\nUse the read tool to check output when done. A final [Exit: ...] footer confirms capture completed; if it is absent, the command is still running or capture failed.`;
  }

  return new Promise(resolve => {
    const proc = spawnWithMutationLease();
    const unregisterManagedChild = registerMutationProcess(proc, 'bash');
    void bindMutationProcess(proc).catch((error: unknown) => {
      mutationProcessBindingFailed = true;
      mutationProcessBindingError ??= error;
    });
    const cleanupOnProcessExit = (): void => {
      killChildProcessTreeSync(proc);
    };
    if (!isCurrentProcessWindowsJobContained()) process.once('exit', cleanupOnProcessExit);
    let foregroundCommandRegistered = true;
    const unregisterForegroundCommand = (): void => {
      if (!foregroundCommandRegistered) return;
      foregroundCommandRegistered = false;
      process.off('exit', cleanupOnProcessExit);
      unregisterManagedChild();
    };
    let finishForegroundEffect: Promise<boolean> | undefined;
    const finishForeground = (): Promise<boolean> => {
      finishForegroundEffect ??= proc.pid === undefined
        ? cleanupSandbox().then(async () => {
            await releaseMutation();
            return true;
          })
        : finishBoundMutationProcess(proc);
      return finishForegroundEffect.then((drained) => {
        process.off('exit', cleanupOnProcessExit);
        if (drained) unregisterForegroundCommand();
        return drained;
      });
    };
    const bashOutputPolicy = getToolResultPolicy('bash');
    const collectorOptions = {
      spoolThresholdBytes: bashOutputPolicy.maxBytes,
      spoolThresholdLines: bashOutputPolicy.maxLines,
    };
    const stdout = createBashOutputCollector(collectorOptions);
    const stderr = createBashOutputCollector(collectorOptions);
    const disposeCollectors = (): void => {
      disposeBashOutputCollector(stdout);
      disposeBashOutputCollector(stderr);
    };
    let settled = false;
    let stopReason: 'cancelled' | 'timeout' | undefined;
    let stoppedOutputRecovery: ForegroundOutputRecovery | undefined;
    let closeObserved = false;
    let resolveProcessClosed: (() => void) | undefined;
    const processClosed = new Promise<void>((resolveClosed) => {
      resolveProcessClosed = resolveClosed;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;

    const settle = (result: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    const markProcessClosed = (): void => {
      if (closeObserved) return;
      closeObserved = true;
      resolveProcessClosed?.();
    };

    const waitForProcessClose = (): Promise<boolean> => {
      if (closeObserved) return Promise.resolve(true);
      return new Promise<boolean>((resolveClosed) => {
        let completed = false;
        const finish = (closed: boolean): void => {
          if (completed) return;
          completed = true;
          clearTimeout(drainTimer);
          resolveClosed(closed);
        };
        const drainTimer = setTimeout(
          () => finish(false),
          FOREGROUND_CLOSE_DRAIN_MS,
        );
        void processClosed.then(() => finish(true));
      });
    };

    const decodePartialOutput = (): string => {
      const partialStdout = decodeCollector(stdout).text;
      const partialStderr = decodeCollector(stderr).text;
      let partial = partialStdout;
      if (partialStderr) {
        partial += `${partial ? '\n' : ''}[stderr]\n${partialStderr}`;
      }
      return partial;
    };

    const buildStoppedResult = (
      reason: 'cancelled' | 'timeout',
      partial: string,
      lifecycleWarnings: readonly string[],
    ): string => {
      const warningNote = lifecycleWarnings.length > 0
        ? `\n${lifecycleWarnings.join('\n')}`
        : '';
      if (reason === 'timeout') {
        const gotchaHints = detectWindowsCmdGotchas(command, usesWindowsCmd);
        const gotchaNote = gotchaHints.length > 0 ? `\n${gotchaHints.join('\n')}` : '';
        return `Command: ${command}\n[Timeout] Command interrupted after ${timeout}s\n\nPartial output:\n${partial}${gotchaNote}${warningNote}\n\n[Suggestion] The command took too long. Consider:\n- Is this a watch/dev server? Run in a separate terminal.\n- Can the task be broken into smaller steps?\n- Is there an error causing it to hang?`;
      }

      let result = `Command: ${command}\n[Cancelled] Operation cancelled by user`;
      if (partial) result += `\n\nPartial output:\n${partial}`;
      return `${result}${warningNote}`;
    };

    const buildRecoveryResult = (
      reason: 'cancelled' | 'timeout',
      recovery: ForegroundOutputRecovery,
      lifecycleWarnings: readonly string[],
    ): string => {
      const status = reason === 'timeout'
        ? `[Timeout] Command interrupted after ${timeout}s`
        : '[Cancelled] Operation cancelled by user';
      const streamLine = (name: 'stdout' | 'stderr', value: StreamRecovery): string => {
        if (value.path) {
          const warning = value.error ? ` (promotion warning: ${value.error})` : '';
          return `${name} recovery: ${value.path}${warning}`;
        }
        return `${name} recovery unavailable: ${value.error ?? 'artifact creation failed'}`;
      };
      return [
        `Command: ${command}`,
        status,
        `[${BASH_CAPTURE_INCOMPLETE_MARKER}] Process streams did not close within ${FOREGROUND_CLOSE_DRAIN_MS}ms; capture has not been finalized.`,
        streamLine('stdout', recovery.stdout),
        streamLine('stderr', recovery.stderr),
        `Drain continues after this result. An artifact is complete only after [${BASH_CAPTURE_COMPLETE_MARKER}] appears at its end.`,
        ...lifecycleWarnings,
      ].join('\n');
    };

    const settleStoppedCommand = async (reason: 'cancelled' | 'timeout'): Promise<void> => {
      let killWarning: string | undefined;
      try {
        await killChildProcessTree(proc, { forceMs: 500, taskkillMs: 500 });
      } catch (error) {
        killWarning = error instanceof Error ? error.message : String(error);
      }
      const streamsClosed = await waitForProcessClose();

      const lifecycleWarnings: string[] = [];
      if (killWarning) {
        lifecycleWarnings.push(`[warn] Process-tree termination reported an error: ${killWarning}`);
      }
      if (!streamsClosed && !closeObserved) {
        const recovery = startForegroundOutputRecovery(stdout, stderr);
        stoppedOutputRecovery = recovery;
        settle(buildRecoveryResult(reason, recovery, lifecycleWarnings));
        return;
      }

      if (!mutationProcessBindingSettled) {
        lifecycleWarnings.push(
          '[Safety] Filesystem-effect binding is still pending; later effects remain fenced.',
        );
      } else if (!await finishForeground()) {
        lifecycleWarnings.push('[warn] Process tree was not proven drained; later filesystem effects remain fenced.');
      }
      if (sandboxCleanupError !== undefined) {
        const detail = sandboxLifecycleErrorDetail(sandboxCleanupError);
        lifecycleWarnings.push(`[warn] Required OS sandbox cleanup failed: ${detail}`);
      }

      let partial: string;
      try {
        partial = decodePartialOutput();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        disposeCollectors();
        settle(
          `Command: ${command}\n[${reason === 'timeout' ? 'Timeout' : 'Cancelled'}] ` +
          `Command stopped, but captured output could not be decoded: ${message}`,
        );
        return;
      }

      disposeCollectors();
      settle(buildStoppedResult(reason, partial, lifecycleWarnings));
    };

    const requestStop = (reason: 'cancelled' | 'timeout'): void => {
      if (settled || stopReason) return;
      stopReason = reason;
      if (!mutationProcessBindingSettled) mutationStartBlockedReason ??= reason;
      if (timer) clearTimeout(timer);
      void settleStoppedCommand(reason).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (!closeObserved) {
          const recovery = startForegroundOutputRecovery(stdout, stderr);
          stoppedOutputRecovery = recovery;
          settle(buildRecoveryResult(reason, recovery, [
            `[warn] Failed to settle stopped command: ${message}`,
          ]));
          return;
        }
        disposeCollectors();
        settle(
          `Command: ${command}\n[warn] Failed to settle stopped command: ${message}\n`
          + '[warn] Later filesystem effects remain fenced until process-tree cleanup succeeds.',
        );
      });
    };

    timer = setTimeout(
      () => requestStop('timeout'),
      Math.max(0, deadlineAt - Date.now()),
    );

    // Issue 113: Kill child process when abort signal fires (Ctrl+C).
    const abortSignal = ctx.abortSignal;
    if (abortSignal) {
      if (abortSignal.aborted) {
        requestStop('cancelled');
      } else {
        const onAbort = () => {
          requestStop('cancelled');
        };
        abortSignal.addEventListener('abort', onAbort, { once: true });
        // Clean up listener when process exits naturally to avoid leak.
        const cleanupAbortListener = () => abortSignal.removeEventListener('abort', onAbort);
        proc.once('close', cleanupAbortListener);
        proc.once('error', cleanupAbortListener);
      }
    }

    // FEATURE_149 (v0.7.38) — live progress for long-running bash. Mirrors
    // Claude Code's `BashTool.renderToolUseProgressMessage` (the user sees
    // command output scrolling live in the transcript instead of a 30s
    // silent wait). Strategy: maintain a small UTF-8 string tail
    // (`liveTail`) separate from the complete capture collectors; on each
    // chunk, append + cap, then call `ctx.reportToolProgress` with the
    // last 3 complete lines, throttled to ~10 fps so we don't flood the
    // Ink renderer. Final output (post-`close`) still flows through the
    // existing decodeCollector path — this is purely an additive UI hint.
    let liveTail = '';
    const LIVE_TAIL_MAX_CHARS = 1024; // ~3-5 lines worth of stdout context
    const LIVE_PROGRESS_THROTTLE_MS = 100;
    let lastProgressAt = 0;
    const reportLiveProgress = (force: boolean): void => {
      if (!ctx.reportToolProgress) return;
      const now = Date.now();
      if (!force && now - lastProgressAt < LIVE_PROGRESS_THROTTLE_MS) return;
      lastProgressAt = now;
      // Pick the last few non-empty lines for a compact "tail" display.
      const lines = liveTail.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
      if (lines.length === 0) return;
      const tail = lines.slice(-3).join(' | ');
      // Cap the displayed tail so the spinner line stays readable.
      const display = tail.length > 120 ? '…' + tail.slice(-119) : tail;
      try {
        ctx.reportToolProgress(display);
      } catch {
        // Progress hints are best-effort UI sugar; a renderer failure must not
        // turn a completed shell command into a process-level crash.
      }
    };

    proc.stdout?.on('data', (chunk: Buffer) => {
      appendBashOutputChunk(stdout, chunk);
      // Best-effort UTF-8 decode for the live tail. Multi-byte chars
      // straddling a chunk boundary may render imperfectly for one frame
      // — acceptable for a transient progress hint (the captured output
      // is still decoded correctly via decodeCollector at end-of-stream).
      liveTail = (liveTail + chunk.toString('utf-8')).slice(-LIVE_TAIL_MAX_CHARS);
      reportLiveProgress(false);
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      appendBashOutputChunk(stderr, chunk);
      // stderr also feeds the live tail — many CLIs (npm / cargo / pytest)
      // emit progress to stderr.
      liveTail = (liveTail + chunk.toString('utf-8')).slice(-LIVE_TAIL_MAX_CHARS);
      reportLiveProgress(false);
    });
    proc.on('close', code => {
      markProcessClosed();
      void (async () => {
        let stdoutDecoded: DecodeResult | undefined;
        let stderrDecoded: DecodeResult | undefined;
        try {
          if (timer) clearTimeout(timer);
          if (mutationStartBlockedReason !== undefined && !mutationProcessBindingSettled) {
            void finishForeground().catch((error: unknown) => {
              emitKodaXDiagnostic({
                source: 'coding:bash-filesystem-effect',
                level: 'warn',
                message: 'Deferred foreground binding cleanup remains fenced.',
                detail: error,
              });
            });
            disposeCollectors();
            const pending = mutationStartBlockedReason === 'cancelled'
              ? cancelledCommandResult(command)
              : commandPreparationTimeoutResult(command, timeout);
            settle(
              `${withSandboxCleanupFailure(pending)}\n` +
              '[Safety] Filesystem-effect binding is still pending; later effects remain fenced.',
            );
            return;
          }
          await finishForeground();
          if (stopReason) {
            if (stoppedOutputRecovery) {
              finishForegroundOutputRecovery(stoppedOutputRecovery, stdout, stderr);
            }
            return;
          }
          if (mutationStartBlockedReason !== undefined) {
            disposeCollectors();
            settle(withSandboxCleanupFailure(
              mutationStartBlockedReason === 'cancelled'
                ? cancelledCommandResult(command)
                : commandPreparationTimeoutResult(command, timeout),
            ));
            return;
          }
          if (mutationProcessBindingFailed) {
            const fallback = await executeNormalPermissionFallback();
            if (fallback !== undefined) {
              disposeCollectors();
              settle(fallback);
              return;
            }
            const detail = mutationProcessBindingError instanceof Error
              ? mutationProcessBindingError.message
              : String(mutationProcessBindingError);
            disposeCollectors();
            settle(
              `Command: ${command}\n[Error] Command was not started because filesystem-effect binding failed: ${detail}`,
            );
            return;
          }
          if (sandboxCleanupError !== undefined) {
            const detail = sandboxLifecycleErrorDetail(sandboxCleanupError);
            let capturedProcessOutput = '';
            try {
              capturedProcessOutput = decodePartialOutput();
            } catch (error: unknown) {
              const captureDetail = error instanceof Error ? error.message : String(error);
              capturedProcessOutput = `[warn] Captured sandbox process output could not be decoded: ${captureDetail}`;
            }
            disposeCollectors();
            settle(
              `Command: ${command}\n[Error] Required OS sandbox execution could not be verified: ${detail}\n`
              + '[Safety] The command was not retried because it may have started.\n'
              + `[Sandbox process exit: ${code}]`
              + (capturedProcessOutput ? `\n${capturedProcessOutput}` : ''),
            );
            return;
          }
          // Spawn-error paths may already be settled before `close` arrives.
          if (settled) {
            disposeCollectors();
            return;
          }
          // Trailing flush of live progress so the final tail (often the most
          // informative — exit notice, "X tests passed", final commit hash)
          // always lands before the tool result. Without this, fast commands
          // (< throttle window) emit zero progress events, and on heavy load
          // only the first throttled fire wins so the tail (e.g. last
          // "epsilon"-style line) is silently dropped.
          reportLiveProgress(true);
          const oversizedResult = await buildGuaranteedOversizeResult(
            command,
            code,
            stdout,
            stderr,
            ctx,
          );
          if (oversizedResult) {
            settle(oversizedResult);
            return;
          }
          stdoutDecoded = decodeCollector(stdout);
          stderrDecoded = decodeCollector(stderr);
          const filteredBody = await filterBashOutputBodies({
            command,
            stdout: stdoutDecoded.text,
            stderr: stderrDecoded.text,
            ctx,
          });
          const stdoutText = filteredBody.stdout;
          const stderrText = filteredBody.stderr;

          let out = `Command: ${command}\nExit: ${code}\n${stdoutText}`;
          if (stderrText) {
            out += `\n[stderr]\n${stderrText}`;
          }
          if (filteredBody.note) {
            out += `\n${filteredBody.note}`;
          }
          if (capped) {
            out += `\n[Note] Timeout capped at ${KODAX_HARD_TIMEOUT}s`;
          }

          // Y-3: Surface the existing UTF-8 → GBK fallback so the LLM knows output
          // may have been reinterpreted. This doesn't mean the text is garbled —
          // GBK decode is usually correct for Chinese Windows — but mixed encodings
          // (e.g. a Python script that prints UTF-8 while the shell is GBK) can
          // produce confusing results that the LLM should double-check.
          if (stdoutDecoded.encodingFallback || stderrDecoded.encodingFallback) {
            out += `\n[warn] Output encoding fallback fired (UTF-8 → GBK). If text looks garbled, the command may mix encodings; re-run with an explicit encoding (e.g. PYTHONIOENCODING=utf-8).`;
          }

          // Y-1/Y-2: Append Windows cmd gotcha hints if the command pattern suggests
          // the shell may have silently mangled it. Added last so they're preserved
          // even if the output is truncated (truncateTail keeps the tail).
          const gotchaHints = detectWindowsCmdGotchas(command, usesWindowsCmd);
          if (gotchaHints.length > 0) {
            out += `\n${gotchaHints.join('\n')}`;
          }

          disposeCollectors();
          settle(out);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const stdoutText = stdoutDecoded?.text ?? decodeCollector(stdout).text;
          const stderrText = stderrDecoded?.text ?? decodeCollector(stderr).text;
          let out = `Command: ${command}\nExit: ${code}\n${stdoutText}`;
          if (stderrText) {
            out += `\n[stderr]\n${stderrText}`;
          }
          out += `\n[warn] Bash output post-processing failed; returned raw captured output instead: ${message}`;
          disposeCollectors();
          settle(out);
        }
      })().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        disposeCollectors();
        settle(
          `Command: ${command}\nExit: ${code}\n` +
            `[warn] Bash output post-processing failed before raw fallback could render: ${message}`,
        );
      });
    });
    proc.on('error', error => {
      void (async () => {
        if (stopReason) return;
        if (timer) clearTimeout(timer);
        if (proc.pid === undefined) {
          unregisterForegroundCommand();
          await cleanupSandbox();
          await releaseMutation();
        } else {
          await finishForeground();
        }
        disposeCollectors();
        // Y-1/Y-2: Same hints on spawn-level errors — a malformed command
        // string (newlines in `-c`, heredoc not understood by cmd) can surface
        // as a spawn error on some platforms.
        const gotchaHints = detectWindowsCmdGotchas(command, usesWindowsCmd);
        const gotchaNote = gotchaHints.length > 0 ? `\n${gotchaHints.join('\n')}` : '';
        settle(withSandboxCleanupFailure(
          `Command: ${command}\n[Error] ${error.message}${gotchaNote}`,
        ));
      })().catch((cleanupError: unknown) => {
        const message = cleanupError instanceof Error
          ? cleanupError.message
          : String(cleanupError);
        disposeCollectors();
        settle(`Command: ${command}\n[Error] ${error.message}\n[warn] Sandbox diagnostics cleanup failed: ${message}`);
      });
    });
  });
}
