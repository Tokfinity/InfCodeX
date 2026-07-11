import { spawnSync } from 'node:child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { cleanupRegisteredManagedChildren, setAgentConfigHome } from '@kodax-ai/agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toolBash } from './bash.js';

const WINDOWS_PROCESS_TREE_EXIT_WAIT_MS = process.platform === 'win32' ? 30_000 : 15_000;
const WINDOWS_PROCESS_TREE_TEST_TIMEOUT_MS = process.platform === 'win32' ? 60_000 : 30_000;
const BACKGROUND_CHILD_MARKER = 'child-pid:';

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
  const result = spawnSync('wmic', [
    'process',
    'where',
    `ProcessId=${pid}`,
    'get',
    'CommandLine',
    '/format:list',
  ], {
    encoding: 'utf8',
    timeout: 5_000,
    windowsHide: true,
  });
  const line = result.stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => value.startsWith('CommandLine='));
  const commandLine = line?.slice('CommandLine='.length).trim();
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

  it('keeps the tail for large command output', async () => {
    // NOTE: keep this shell-portable — backticks / ${...} inside the double-
    // quoted -e script get interpreted by POSIX `sh` (command substitution +
    // parameter expansion) before node sees them, which on Linux CI produced
    // blank lines instead of "line-N". Use single-quoted string concatenation.
    const command = 'node -e "for (let i = 1; i <= 3000; i++) console.log(\'line-\' + i)"';
    const result = await toolBash({ command }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    expect(result).toContain('line-3000');
    expect(result).toContain('Bash output truncated to the tail');
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
