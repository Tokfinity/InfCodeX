/**
 * Deterministic per-step evaluator — FEATURE_114 v0.7.36.
 *
 * When a `todo_update` transitions an item from `in_progress` →
 * `completed` and the item carries an `evaluator` hint
 * (`'build' | 'test' | 'lint'`), the runner runs the corresponding
 * deterministic check inside the workspace and threads stderr / exit
 * code into the next tool result. The Worker reads that result on its
 * next turn and self-corrects.
 *
 * Why deterministic only (no LLM-as-judge): Phase 0.7 industry survey
 * showed 4/4 codebases reject per-step LLM verification. The cost
 * (every step doubles the LLM call count) does not justify the
 * marginal precision improvement. KodaX's structural Evaluator
 * (Worker emit_handoff → Evaluator) is the LLM-judge gate; per-step
 * checks are ground-truth probes.
 *
 * Shell timeout / quoting / Windows-vs-POSIX dispatch is delegated to
 * the existing `runShellCommand` substrate so this helper stays a
 * thin policy layer (which command for which hint, plus
 * cwd/timeout/output capture).
 */

import { spawn } from 'child_process';

export type DeterministicEvaluatorHint = 'build' | 'test' | 'lint';

export interface DeterministicEvaluatorResult {
  readonly hint: DeterministicEvaluatorHint;
  readonly command: string;
  readonly status: 'pass' | 'fail' | 'skipped' | 'error';
  /** Process exit code; `undefined` when the process did not run. */
  readonly exitCode: number | undefined;
  /** Stderr captured from the child process, truncated to 4 KiB. */
  readonly stderrTail: string;
  /** Stdout tail captured for context, truncated to 2 KiB. */
  readonly stdoutTail: string;
  /** Wall-clock duration in milliseconds. */
  readonly durationMs: number;
}

export interface RunDeterministicEvaluatorInput {
  readonly hint: DeterministicEvaluatorHint;
  readonly cwd: string;
  /** Timeout in milliseconds. Default 90 000 (90s). */
  readonly timeoutMs?: number;
  /**
   * Override for the project-level command. Useful for tests that
   * don't have an `npm run build` script or want a custom one-liner
   * — production runs use the default mapping.
   */
  readonly commandOverride?: string;
  /**
   * Optional path scope for `test`. When set, the test command becomes
   * `npx vitest run <scopePath>` instead of the project-level
   * `npm run test`. Used when a todo item targets a specific module.
   */
  readonly testScopePath?: string;
}

const DEFAULT_TIMEOUT_MS = 90_000;
const STDERR_CAP = 4096;
const STDOUT_CAP = 2048;

function defaultCommandFor(input: RunDeterministicEvaluatorInput): string {
  if (input.commandOverride && input.commandOverride.trim().length > 0) {
    return input.commandOverride;
  }
  switch (input.hint) {
    case 'build':
      return 'npm run build';
    case 'test':
      return input.testScopePath
        ? `npx vitest run ${input.testScopePath}`
        : 'npm run test --';
    case 'lint':
      return 'npm run lint';
  }
}

function tail(value: string, max: number): string {
  if (value.length <= max) return value;
  return `…${value.slice(-max)}`;
}

/**
 * Run a deterministic check for the given hint. Captures stderr +
 * stdout tail + exit code. The `status` summarizes the outcome:
 *
 *  - `'pass'`   — exit code 0
 *  - `'fail'`   — exit code !== 0
 *  - `'skipped'`— command not available (npm script missing); the
 *                 caller treats this as a soft signal — Worker is not
 *                 blamed for a missing build script
 *  - `'error'`  — process failed to spawn or hit the timeout
 */
export async function runDeterministicEvaluator(
  input: RunDeterministicEvaluatorInput,
): Promise<DeterministicEvaluatorResult> {
  const command = defaultCommandFor(input);
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();

  return new Promise<DeterministicEvaluatorResult>((resolve) => {
    const proc = spawn(command, {
      cwd: input.cwd,
      shell: true,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let resolved = false;

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill('SIGTERM');
      } catch {
        // best-effort
      }
    }, timeoutMs);

    proc.stdout?.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      stdout += text;
      if (stdout.length > STDOUT_CAP * 4) {
        stdout = stdout.slice(-STDOUT_CAP * 2);
      }
    });
    proc.stderr?.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      stderr += text;
      if (stderr.length > STDERR_CAP * 4) {
        stderr = stderr.slice(-STDERR_CAP * 2);
      }
    });

    proc.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutHandle);
      resolve({
        hint: input.hint,
        command,
        status: 'error',
        exitCode: undefined,
        stderrTail: tail(stderr || (err instanceof Error ? err.message : String(err)), STDERR_CAP),
        stdoutTail: tail(stdout, STDOUT_CAP),
        durationMs: Date.now() - startedAt,
      });
    });

    proc.on('close', (code, signal) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutHandle);
      if (timedOut) {
        resolve({
          hint: input.hint,
          command,
          status: 'error',
          exitCode: code ?? undefined,
          stderrTail: tail(
            `${stderr}\n[deterministic-evaluator] TIMEOUT after ${timeoutMs}ms (signal=${signal ?? 'SIGTERM'})`,
            STDERR_CAP,
          ),
          stdoutTail: tail(stdout, STDOUT_CAP),
          durationMs: Date.now() - startedAt,
        });
        return;
      }
      // Heuristic: `npm run <missing-script>` exits with a non-zero
      // code AND emits "Missing script" or "command not found" — treat
      // as `'skipped'` so the Worker isn't blamed for a missing build
      // step. Conservative match — only when stderr clearly says the
      // script is missing.
      if (
        code !== 0
        && (
          stderr.toLowerCase().includes('missing script')
          || stderr.toLowerCase().includes('command not found')
          || stderr.toLowerCase().includes('not recognized as an internal')
        )
      ) {
        resolve({
          hint: input.hint,
          command,
          status: 'skipped',
          exitCode: code ?? undefined,
          stderrTail: tail(stderr, STDERR_CAP),
          stdoutTail: tail(stdout, STDOUT_CAP),
          durationMs: Date.now() - startedAt,
        });
        return;
      }
      resolve({
        hint: input.hint,
        command,
        status: code === 0 ? 'pass' : 'fail',
        exitCode: code ?? undefined,
        stderrTail: tail(stderr, STDERR_CAP),
        stdoutTail: tail(stdout, STDOUT_CAP),
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

/**
 * Format a result for inclusion in a tool-result tail. Used by the
 * Runner when threading evaluator output back into the Worker's
 * transcript.
 */
export function formatDeterministicEvaluatorResult(
  result: DeterministicEvaluatorResult,
): string {
  const header = `[deterministic-evaluator:${result.hint}] ${result.status} (exit=${
    result.exitCode ?? 'n/a'
  }, ${result.durationMs}ms) — \`${result.command}\``;
  if (result.status === 'pass' || result.status === 'skipped') {
    return result.status === 'skipped'
      ? `${header}\n  Skipped: command not available; not blocking the run.`
      : header;
  }
  const tailParts = [header];
  if (result.stderrTail) {
    tailParts.push('--- stderr tail ---');
    tailParts.push(result.stderrTail);
  } else if (result.stdoutTail) {
    tailParts.push('--- stdout tail (no stderr) ---');
    tailParts.push(result.stdoutTail);
  }
  return tailParts.join('\n');
}
