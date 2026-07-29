import { spawn } from 'child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import iconv from 'iconv-lite';
import {
  emitKodaXDiagnostic,
  killChildProcessTree,
  killChildProcessTreeSync,
  registerManagedChildProcess,
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
import { TOOL_RESULT_INCOMPLETE_MARKER } from './tool-result-policy.js';
import { persistToolOutput } from './truncate.js';
import {
  createShellCommandInvocation,
  resolveShellExecution,
} from '../shell-execution/resolver.js';

const BACKGROUND_ABORT_KILL_MS = process.platform === 'win32' ? 5_000 : 2_000;
const FOREGROUND_CLOSE_DRAIN_MS = process.platform === 'win32' ? 2_000 : 1_000;
// cl100k_base's longest vocabulary token is 128 bytes. Therefore raw output
// above capacity * 128 cannot fit even in the most compressible tokenization.
const MAX_TOKEN_BYTES = 128;

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
  const capacityTokens = ctx.toolResultCapacityTokens ?? ctx.maximumInputTokens;
  if (capacityTokens === undefined) return undefined;
  const capacityBytesUpperBound = Math.max(0, Math.floor(capacityTokens)) * MAX_TOKEN_BYTES;
  if (stdout.totalBytes + stderr.totalBytes <= capacityBytesUpperBound) return undefined;

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
    `[${TOOL_RESULT_INCOMPLETE_MARKER}. Raw Bash output is provably larger than the active request capacity and was not materialized inline. Full output saved to: ${recoveryPath}.]`,
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

export async function toolBash(input: Record<string, unknown>, ctx: KodaXToolExecutionContext): Promise<string> {
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
  const legacyEnv = ctx.sessionScratchDir
    ? {
      ...process.env,
      KODAX_SESSION_TMP: ctx.sessionScratchDir,
    }
    : process.env;
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
      commandInvocation = createShellCommandInvocation(resolved, command);
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
        executable: commandInvocation?.executable,
        args: commandInvocation?.args,
        cwd,
        env: commandInvocation?.env ?? legacyEnv,
        windowsVerbatimArguments: commandInvocation?.windowsVerbatimArguments,
        signal: ctx.abortSignal,
        deadlineAt,
        reportObservation: ctx.reportToolSandboxObservation,
      });
    } catch {
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
  const cleanupSandbox = async (): Promise<void> => {
    if (!sandboxInvocation) return;
    sandboxCleanup ??= sandboxInvocation.cleanup().then((observation) => {
      if (observation) ctx.reportToolSandboxObservation?.(observation);
      return observation;
    });
    try {
      await sandboxCleanup;
    } catch (error: unknown) {
      emitKodaXDiagnostic({
        source: 'coding:bash-sandbox',
        level: 'warn',
        message: 'Workspace sandbox diagnostics cleanup failed.',
        detail: error,
      });
    }
  };
  if (ctx.abortSignal?.aborted) {
    await cleanupSandbox();
    return cancelledCommandResult(command);
  }
  if (Date.now() >= deadlineAt) {
    await cleanupSandbox();
    return commandPreparationTimeoutResult(command, timeout);
  }
  const spawnCommand = () => sandboxInvocation !== undefined
    ? spawn(sandboxInvocation.executable, [...sandboxInvocation.args], {
        shell: false,
        windowsHide: true,
        cwd,
        env: sandboxInvocation.env,
        detached: process.platform !== 'win32',
        ...(sandboxInvocation.windowsVerbatimArguments === true
          ? { windowsVerbatimArguments: true }
          : {}),
      })
    : commandInvocation === undefined
    ? spawn(command, [], {
        shell: true,
        windowsHide: true,
        cwd,
        env: legacyEnv,
        detached: process.platform !== 'win32',
      })
    : spawn(commandInvocation.executable, [...commandInvocation.args], {
        shell: false,
        windowsHide: true,
        cwd,
        env: commandInvocation.env,
        detached: process.platform !== 'win32',
        ...(commandInvocation.windowsVerbatimArguments === true
          ? { windowsVerbatimArguments: true }
          : {}),
      });

  if (runInBackground) {
    const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const outputFile = pathJoin(tmpdir(), `kodax-bg-${jobId}.log`);
    let logStream: WriteStream;
    try {
      logStream = await openBackgroundLog(outputFile);
    } catch (error) {
      void cleanupSandbox();
      const message = error instanceof Error ? error.message : String(error);
      return `[Error] Background command was not started because its output file could not be created: ${message}`;
    }

    // POSIX background jobs get a process group so cleanup can signal -pid and
    // reap shell descendants.
    const proc = spawnCommand();
    proc.once('close', () => { void cleanupSandbox(); });
    proc.once('error', () => { void cleanupSandbox(); });
    const unregisterManagedChild = registerManagedChildProcess(proc, {
      kind: 'bash-background',
      command,
      cwd,
    });
    const cleanupOnProcessExit = (): void => killChildProcessTreeSync(proc);
    process.once('exit', cleanupOnProcessExit);
    const abortSignal = ctx.abortSignal;
    let cleaned = false;
    let onAbort: (() => void) | undefined;
    const cleanupProcessHooks = (): void => {
      if (cleaned) return;
      cleaned = true;
      process.off('exit', cleanupOnProcessExit);
      if (onAbort) {
        abortSignal?.removeEventListener('abort', onAbort);
      }
      unregisterManagedChild();
    };
    const stopBackgroundProcess = (): void => {
      killChildProcessTreeBestEffort(proc, {
        forceMs: BACKGROUND_ABORT_KILL_MS,
        taskkillMs: BACKGROUND_ABORT_KILL_MS,
      }, cleanupProcessHooks);
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
    proc.on('close', (code) => {
      cleanupProcessHooks();
      if (!logStream.destroyed) {
        logStream.write(`\n[Exit: ${code}]\n`);
        logStream.end();
      }
    });
    proc.on('error', (err) => {
      cleanupProcessHooks();
      if (!logStream.destroyed) {
        logStream.write(`\n[Error: ${err.message}]\n`);
        logStream.end();
      }
    });
    if (abortSignal?.aborted) {
      stopBackgroundProcess();
    } else if (abortSignal) {
      onAbort = stopBackgroundProcess;
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    return `Command started in background.\nPID: ${proc.pid}\nOutput: ${outputFile}\n\nUse the read tool to check output when done. A final [Exit: ...] footer confirms capture completed; if it is absent, the command is still running or capture failed.`;
  }

  return new Promise(resolve => {
    const proc = spawnCommand();
    proc.once('close', () => { void cleanupSandbox(); });
    proc.once('error', () => { void cleanupSandbox(); });
    const unregisterManagedChild = registerManagedChildProcess(proc, {
      kind: 'bash',
      command,
      cwd,
    });
    const cleanupOnProcessExit = (): void => killChildProcessTreeSync(proc);
    process.once('exit', cleanupOnProcessExit);
    let foregroundCommandRegistered = true;
    const unregisterForegroundCommand = (): void => {
      if (!foregroundCommandRegistered) return;
      foregroundCommandRegistered = false;
      process.off('exit', cleanupOnProcessExit);
      unregisterManagedChild();
    };
    const stdout = createBashOutputCollector();
    const stderr = createBashOutputCollector();
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
        await killChildProcessTree(proc);
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

      unregisterForegroundCommand();

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
        unregisterForegroundCommand();
        disposeCollectors();
        settle(`Command: ${command}\n[warn] Failed to settle stopped command: ${message}`);
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
          unregisterForegroundCommand();
          await cleanupSandbox();
          if (stopReason) {
            if (stoppedOutputRecovery) {
              finishForegroundOutputRecovery(stoppedOutputRecovery, stdout, stderr);
            }
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
        unregisterForegroundCommand();
        await cleanupSandbox();
        disposeCollectors();
        // Y-1/Y-2: Same hints on spawn-level errors — a malformed command
        // string (newlines in `-c`, heredoc not understood by cmd) can surface
        // as a spawn error on some platforms.
        const gotchaHints = detectWindowsCmdGotchas(command, usesWindowsCmd);
        const gotchaNote = gotchaHints.length > 0 ? `\n${gotchaHints.join('\n')}` : '';
        settle(`Command: ${command}\n[Error] ${error.message}${gotchaNote}`);
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
