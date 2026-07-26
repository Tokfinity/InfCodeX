import { ChildProcess, spawnSync } from 'node:child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { cleanupRegisteredManagedChildren, setAgentConfigHome } from '@kodax-ai/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toolBash } from './bash.js';

const WINDOWS_PROCESS_TREE_EXIT_WAIT_MS = process.platform === 'win32' ? 30_000 : 15_000;
const WINDOWS_PROCESS_TREE_TEST_TIMEOUT_MS = process.platform === 'win32' ? 60_000 : 30_000;
const BACKGROUND_CHILD_MARKER = 'child-pid:';

function nodeOutputCommand(stdout: string, commandMarker = ''): string {
  const encoded = Buffer.from(stdout, 'utf-8').toString('base64');
  return `node -e "const marker='${commandMarker}'; void marker; process.stdout.write(Buffer.from('${encoded}','base64'))"`;
}

function completedCommandBody(result: string): string {
  return result.split(/\nExit: -?\d+\n/, 2)[1] ?? result;
}

function parentWatchedBackgroundCommand(): string {
  return 'node -e "const parent=process.ppid; console.log(\'child-pid:\' + process.pid); setInterval(() => { try { process.kill(parent, 0); } catch { process.exit(0); } }, 1000)"';
}

function parseBackgroundPid(result: string): number {
  const match = /PID:\s*(\d+)/.exec(result);
  if (!match?.[1]) {
    throw new Error(`background PID missing from result: ${result}`);
  }
  return Number(match[1]);
}

function parseBackgroundOutputPath(result: string): string {
  const match = /Output:\s*(.+)/.exec(result);
  if (!match?.[1]) {
    throw new Error(`background output path missing from result: ${result}`);
  }
  return match[1].trim();
}

function parseRecoveryOutputPath(result: string, stream: 'stdout' | 'stderr'): string {
  const match = new RegExp(`${stream} recovery: (.+)`).exec(result);
  if (!match?.[1]) {
    throw new Error(`${stream} recovery path missing from result: ${result}`);
  }
  return match[1].trim();
}

async function waitForOutputMatch(
  filePath: string,
  pattern: RegExp,
  timeoutMs = 5_000,
): Promise<RegExpExecArray> {
  const deadline = Date.now() + timeoutMs;
  let content = '';
  while (Date.now() < deadline) {
    try {
      content = await fs.readFile(filePath, 'utf-8');
      const match = pattern.exec(content);
      if (match) {
        return match;
      }
    } catch {
      // File may not exist yet on the first poll iteration.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`pattern ${pattern} not found in background output: ${content}`);
}

function getWindowsCommandLine(pid: number): string | undefined {
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue).CommandLine`,
  ], {
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
  });
  const commandLine = typeof result.stdout === 'string'
    ? result.stdout.trim()
    : undefined;
  return commandLine ? commandLine : undefined;
}

function isPidAlive(pid: number, commandMarker?: string): boolean {
  if (process.platform === 'win32' && commandMarker !== undefined) {
    const commandLine = getWindowsCommandLine(pid);
    return commandLine?.includes(commandMarker) ?? false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(
  pid: number,
  timeoutMs = 5_000,
  commandMarker?: string,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid, commandMarker)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isPidAlive(pid, commandMarker);
}

describe('toolBash', () => {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-bash-'));
    setAgentConfigHome(path.join(tempDir, 'agent-home'));
  });

  afterEach(async () => {
    await cleanupRegisteredManagedChildren({ includeCurrentOwner: true });
    setAgentConfigHome(undefined);
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('returns complete large command output without an inner line or byte preview', async () => {
    // NOTE: keep this shell-portable — backticks / ${...} inside the double-
    // quoted -e script get interpreted by POSIX `sh` (command substitution +
    // parameter expansion) before node sees them, which on Linux CI produced
    // blank lines instead of "line-N". Use single-quoted string concatenation.
    const command = 'node -e "for (let i = 1; i <= 3000; i++) console.log(\'line-\' + i)"';
    const result = await toolBash({ command }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    expect(result).toContain('line-1\n');
    expect(result).toContain('line-3000');
    expect(result).not.toContain('Bash output truncated to the tail');
  });

  it('captures stdout and stderr from the first byte after the in-memory threshold is crossed', async () => {
    const command = 'node -e "process.stdout.write(\'stdout-first-byte\\n\'+\'x\'.repeat(600*1024)+\'\\nstdout-last-byte\'); process.stderr.write(\'stderr-first-byte\\n\'+\'y\'.repeat(600*1024)+\'\\nstderr-last-byte\')"';
    const result = await toolBash({ command }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    const body = completedCommandBody(result);
    expect(body).toContain('stdout-first-byte');
    expect(body).toContain('stdout-last-byte');
    expect(body).toContain('[stderr]\nstderr-first-byte');
    expect(body).toContain('stderr-last-byte');
    expect(body).not.toContain('capture capped');
  });

  it('keeps a canonical artifact when raw bytes prove the output cannot fit any request', async () => {
    const command = nodeOutputCommand(`BEGIN_SENTINEL${'x'.repeat(1024)}END_SENTINEL`);
    const recordToolResultArtifact = vi.fn();
    const result = await toolBash({ command }, {
      backups: new Map(),
      executionCwd: tempDir,
      maximumInputTokens: 1,
      toolCallId: 'bash-oversize',
      recordToolResultArtifact,
    });

    expect(result).toContain('KODAX_RESULT_INCOMPLETE');
    expect(result).toContain('Full output saved to:');
    expect(result).not.toContain('END_SENTINEL');
    const outputPath = parseRecoveryOutputPath(result, 'stdout');
    const artifact = await fs.readFile(outputPath, 'utf-8');
    expect(artifact).toContain('BEGIN_SENTINEL');
    expect(artifact).toContain('END_SENTINEL');
    expect(artifact).toContain('KODAX_CAPTURE_COMPLETE');
    const manifestPath = /Full output saved to: (.+?)\.\]/.exec(result)?.[1];
    expect(manifestPath).toBeDefined();
    await expect(fs.readFile(manifestPath!, 'utf-8')).resolves.toContain('stderr recovery:');
    expect(recordToolResultArtifact).toHaveBeenCalledWith('bash-oversize', manifestPath);
  });

  it('strips ANSI escape codes from completed command output while preserving the bash header', async () => {
    const command = 'node -e "const e=String.fromCharCode(27); process.stdout.write(e+\'[31mred\'+e+\'[0m\\n\'); process.stderr.write(e+\'[33mwarn\'+e+\'[0m\\n\')"';
    const result = await toolBash({ command }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    expect(result).toContain(`Command: ${command}`);
    expect(result).toContain('Exit: 0');
    expect(result).toContain('red');
    expect(result).toContain('[stderr]\nwarn');
    expect(result).not.toContain('\u001B[');
  });

  it('preserves the target URL when normalizing an OSC8 hyperlink', async () => {
    const url = 'https://example.test/critical-target?item=42';
    const command = 'node -e "const e=String.fromCharCode(27),b=String.fromCharCode(7); process.stdout.write(e+\']8;;https://example.test/critical-target?item=42\'+b+\'open result\'+e+\']8;;\'+b+\'\\n\')"';
    const result = await toolBash({ command }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    const body = completedCommandBody(result);
    expect(body).toContain('open result');
    expect(body).toContain(url);
    expect(body).not.toContain('\u001B]8;');
  });

  it.each([
    {
      id: 'git log',
      marker: 'git log --oneline --stat',
      critical: 'critical-late-commit',
      output: [
        ...Array.from({ length: 45 }, (_, index) => `${index.toString(16).padStart(7, 'a')} commit-${index}`),
        'fffffff critical-late-commit',
      ].join('\n'),
    },
    {
      id: 'git diff',
      marker: 'git diff',
      critical: '+const criticalDiffValue = 42;',
      output: Array.from({ length: 30 }, (_, index) => [
        `diff --git a/src/value-${index}.ts b/src/value-${index}.ts`,
        'index 1111111..2222222 100644',
        `--- a/src/value-${index}.ts`,
        `+++ b/src/value-${index}.ts`,
        '@@ -1,2 +1,2 @@',
        `-const oldValue${index} = ${index};`,
        index === 29 ? '+const criticalDiffValue = 42;' : `+const newValue${index} = ${index + 1};`,
      ].join('\n')).join('\n'),
    },
    {
      id: 'git status',
      marker: 'git status',
      critical: 'critical-status-path.ts',
      output: [
        'On branch main',
        'Changes not staged for commit:',
        ...Array.from({ length: 100 }, (_, index) => `\tmodified:   src/file-${index}.ts`),
        '\tmodified:   src/critical-status-path.ts',
      ].join('\n'),
    },
    {
      id: 'test runner',
      marker: 'npm test',
      critical: 'critical-root-cause-after-context-window',
      output: [
        'FAIL src/example.test.ts',
        ...Array.from({ length: 12 }, (_, index) => `failure-context-${index}`),
        'critical-root-cause-after-context-window',
        ...Array.from({ length: 80 }, (_, index) => `progress-${index}`),
        'Tests 1 failed | 99 passed',
      ].join('\n'),
    },
    {
      id: 'JSON',
      marker: 'curl https://example.test/data',
      critical: 'critical-json-value',
      output: JSON.stringify({
        critical: 'critical-json-value',
        padding: 'x'.repeat(2200),
      }),
    },
    {
      id: 'compound command',
      marker: 'git diff && npm test',
      critical: 'critical-compound-test-failure',
      output: [
        'diff --git a/src/value.ts b/src/value.ts',
        '--- a/src/value.ts',
        '+++ b/src/value.ts',
        '@@ -1,100 +1,100 @@',
        ...Array.from({ length: 100 }, (_, index) => `-old-${index}`),
        ...Array.from({ length: 100 }, (_, index) => `+new-${index}`),
        'FAIL src/compound.test.ts',
        'critical-compound-test-failure',
      ].join('\n'),
    },
  ])('does not apply a lossy $id semantic filter by default', async ({ marker, output, critical }) => {
    const command = nodeOutputCommand(output, marker);
    const result = await toolBash({ command }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    const body = completedCommandBody(result);
    expect(body).toContain(critical);
    expect(body).not.toContain('[Bash output compressed');
  });

  it('does not fail a completed command when live progress rendering throws', async () => {
    const command = 'node -e "console.log(\'progress-output\')"';
    const result = await toolBash({ command }, {
      backups: new Map(),
      executionCwd: tempDir,
      reportToolProgress: () => {
        throw new Error('renderer unavailable');
      },
    });

    expect(result).toContain(`Command: ${command}`);
    expect(result).toContain('Exit: 0');
    expect(result).toContain('progress-output');
  });

  it('includes stderr in timeout previews', async () => {
    const command = 'node -e "process.stderr.write(\'timeout-error\\n\'); setTimeout(() => {}, 5000)"';
    const result = await toolBash({ command, timeout: 1 }, {
      backups: new Map(),
      executionCwd: process.cwd(),
    });

    expect(result).toContain('[Timeout]');
    expect(result).toContain('timeout-error');
  });

  it('returns an explicit command-scoped cancellation for an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const command = 'node -e "console.log(\'should-not-complete\')"';

    const result = await toolBash({ command }, {
      backups: new Map(),
      executionCwd: tempDir,
      abortSignal: controller.signal,
    });

    expect(result).toContain(`Command: ${command}`);
    expect(result).toContain('[Cancelled] Operation cancelled by user');
  });

  it('preserves captured stdout and stderr when a running command is aborted', async () => {
    const controller = new AbortController();
    const command = 'node -e "process.stdout.write(\'partial-stdout\\n\'); process.stderr.write(\'partial-stderr\\n\'); setTimeout(() => console.log(\'ready-to-abort\'), 150); setInterval(() => {}, 1000)"';
    let aborted = false;

    const result = await toolBash({ command, timeout: 10 }, {
      backups: new Map(),
      executionCwd: tempDir,
      abortSignal: controller.signal,
      reportToolProgress: (progress) => {
        if (!aborted && progress.includes('ready-to-abort')) {
          aborted = true;
          controller.abort();
        }
      },
    });

    expect(aborted).toBe(true);
    expect(result).toContain('[Cancelled] Operation cancelled by user');
    expect(result).toContain('Partial output:');
    expect(result).toContain('partial-stdout');
    expect(result).toContain('[stderr]');
    expect(result).toContain('partial-stderr');
  });

  it('waits for a cancelled command to release its execution cwd before returning', async () => {
    const controller = new AbortController();
    const commandCwd = path.join(tempDir, 'cancelled-command-cwd');
    await fs.mkdir(commandCwd);
    const command = process.platform === 'win32'
      ? 'echo ready-to-abort & set /p KODAX_WAIT='
      : 'printf "ready-to-abort\\n"; read KODAX_WAIT';
    let aborted = false;

    const result = await toolBash({ command, timeout: 10 }, {
      backups: new Map(),
      executionCwd: commandCwd,
      abortSignal: controller.signal,
      reportToolProgress: (progress) => {
        if (!aborted && progress.includes('ready-to-abort')) {
          aborted = true;
          controller.abort();
        }
      },
    });

    expect(aborted).toBe(true);
    expect(result).toContain('[Cancelled] Operation cancelled by user');
    await expect(fs.rm(commandCwd, { recursive: true, force: true })).resolves.toBeUndefined();
  });

  it('hands delayed stream drain to recoverable artifacts without dropping late chunks', async () => {
    const marker = `delayed-close-${Date.now()}`;
    const command = `node -e "console.log('${marker}'); setInterval(() => {}, 1000)"`;
    const controller = new AbortController();
    const delayedCloseMs = process.platform === 'win32' ? 2_800 : 1_800;
    const lateChunkMs = process.platform === 'win32' ? 2_200 : 1_200;
    const abortWatchdog = setTimeout(() => controller.abort(), 1_000);
    const originalEmit = ChildProcess.prototype.emit;
    const delayedPids = new Set<number>();
    const recoveryPaths: string[] = [];
    const emitSpy = vi.spyOn(ChildProcess.prototype, 'emit').mockImplementation(function (
      this: ChildProcess,
      event: string | symbol,
      ...args: unknown[]
    ): boolean {
      const shouldDelay = event === 'close'
        && this.spawnargs.some((arg) => arg.includes(marker))
        && this.pid !== undefined
        && !delayedPids.has(this.pid);
      if (!shouldDelay) {
        return Reflect.apply(originalEmit, this, [event, ...args]) as boolean;
      }

      delayedPids.add(this.pid as number);
      setTimeout(() => {
        this.stdout?.emit('data', Buffer.from('late-after-deadline\n'));
      }, lateChunkMs);
      setTimeout(() => {
        Reflect.apply(originalEmit, this, [event, ...args]);
      }, delayedCloseMs);
      return true;
    });

    try {
      const result = await toolBash({ command, timeout: 10 }, {
        backups: new Map(),
        executionCwd: tempDir,
        abortSignal: controller.signal,
        reportToolProgress: (progress) => {
          if (progress.includes(marker)) controller.abort();
        },
      });

      expect(result).toContain('KODAX_CAPTURE_INCOMPLETE');
      const stdoutPath = parseRecoveryOutputPath(result, 'stdout');
      const stderrPath = parseRecoveryOutputPath(result, 'stderr');
      recoveryPaths.push(stdoutPath, stderrPath);
      await waitForOutputMatch(stdoutPath, /KODAX_CAPTURE_COMPLETE/, delayedCloseMs + 5_000);
      const recovered = await fs.readFile(stdoutPath, 'utf-8');
      expect(recovered).toContain(marker);
      expect(recovered).toContain('late-after-deadline');
    } finally {
      clearTimeout(abortWatchdog);
      controller.abort();
      emitSpy.mockRestore();
      await Promise.all(recoveryPaths.map((filePath) => fs.rm(filePath, { force: true })));
    }
  }, 15_000);

  it('passes sessionScratchDir to commands as KODAX_SESSION_TMP', async () => {
    const scratchDir = path.join(tempDir, '.agent', 'tmp', 'sessions', 'session-1');
    const command = 'node -e "console.log(process.env.KODAX_SESSION_TMP || \'missing\')"';

    const result = await toolBash({ command }, {
      backups: new Map(),
      executionCwd: tempDir,
      sessionScratchDir: scratchDir,
    });

    expect(result).toContain(scratchDir);
  });

  it('runs command in background and returns output file path', async () => {
    const command = 'node -e "console.log(\'bg-output\')"';
    const result = await toolBash({ command, run_in_background: true }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    expect(result).toContain('Command started in background');
    expect(result).toContain('PID:');
    expect(result).toContain('Output:');
    expect(result).toContain('kodax-bg-');

    const outputMatch = result.match(/Output:\s*(.+)/);
    expect(outputMatch).toBeTruthy();
    const outputPath = outputMatch![1]!.trim();

    const deadline = Date.now() + 5_000;
    let content = '';
    while (Date.now() < deadline) {
      try {
        content = await fs.readFile(outputPath, 'utf-8');
        if (content.includes('[Exit:')) break;
      } catch {
        // File may not exist yet on the first poll iteration.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(content).toContain('bg-output');
    expect(content).toContain('[Exit:');
  });

  it('registers background commands for managed cleanup', async () => {
    const command = parentWatchedBackgroundCommand();
    const result = await toolBash({ command, run_in_background: true }, {
      backups: new Map(),
      executionCwd: process.cwd(),
    });
    const pid = parseBackgroundPid(result);
    const outputPath = parseBackgroundOutputPath(result);
    const childPid = Number((await waitForOutputMatch(outputPath, /child-pid:(\d+)/))[1]);
    expect(isPidAlive(pid)).toBe(true);
    expect(isPidAlive(childPid)).toBe(true);

    const summary = await cleanupRegisteredManagedChildren({ includeCurrentOwner: true });

    expect(summary.killed).toBe(1);
    await Promise.all([
      expect(
        waitForPidExit(pid, WINDOWS_PROCESS_TREE_EXIT_WAIT_MS),
      ).resolves.toBe(true),
      expect(
        waitForPidExit(childPid, WINDOWS_PROCESS_TREE_EXIT_WAIT_MS, BACKGROUND_CHILD_MARKER),
      ).resolves.toBe(true),
    ]);
  }, WINDOWS_PROCESS_TREE_TEST_TIMEOUT_MS);

  it('stops background commands when the caller aborts', async () => {
    const controller = new AbortController();
    const command = parentWatchedBackgroundCommand();
    const result = await toolBash({ command, run_in_background: true }, {
      backups: new Map(),
      executionCwd: process.cwd(),
      abortSignal: controller.signal,
    });
    const pid = parseBackgroundPid(result);
    const outputPath = parseBackgroundOutputPath(result);
    const childPid = Number((await waitForOutputMatch(outputPath, /child-pid:(\d+)/))[1]);
    expect(isPidAlive(pid)).toBe(true);
    expect(isPidAlive(childPid)).toBe(true);

    controller.abort();

    await Promise.all([
      expect(
        waitForPidExit(pid, WINDOWS_PROCESS_TREE_EXIT_WAIT_MS),
      ).resolves.toBe(true),
      expect(
        waitForPidExit(childPid, WINDOWS_PROCESS_TREE_EXIT_WAIT_MS, BACKGROUND_CHILD_MARKER),
      ).resolves.toBe(true),
    ]);
  }, WINDOWS_PROCESS_TREE_TEST_TIMEOUT_MS);

  describe('live progress reporting (FEATURE_149)', () => {
    it('calls reportToolProgress with stdout tail during execution', async () => {
      const progressEvents: string[] = [];
      const command = `node -e "const lines=['alpha','beta','gamma','delta','epsilon']; (async()=>{ for(const l of lines){ console.log(l); await new Promise(r=>setTimeout(r,30)); }})()"`;
      const result = await toolBash({ command }, {
        backups: new Map(),
        executionCwd: tempDir,
        reportToolProgress: (msg) => {
          progressEvents.push(msg);
        },
      });

      expect(result).toContain('alpha');
      expect(result).toContain('epsilon');
      expect(progressEvents.length).toBeGreaterThan(0);
      const allEvents = progressEvents.join('\n');
      expect(allEvents).toContain('epsilon');
    });

    it('does not throw when reportToolProgress is undefined (back-compat)', async () => {
      const command = `node -e "console.log('quiet')"`;
      const result = await toolBash({ command }, {
        backups: new Map(),
        executionCwd: tempDir,
      });

      expect(result).toContain('quiet');
    });

    it('includes stderr in live progress', async () => {
      const progressEvents: string[] = [];
      const command = `node -e "process.stderr.write('warn-msg\\n'); console.log('done')"`;
      const result = await toolBash({ command }, {
        backups: new Map(),
        executionCwd: tempDir,
        reportToolProgress: (msg) => {
          progressEvents.push(msg);
        },
      });

      expect(result).toContain('done');
      const allEvents = progressEvents.join('\n');
      expect(allEvents).toMatch(/warn-msg|done/);
    });
  });
});
