import { ChildProcess, spawnSync } from 'node:child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { cleanupRegisteredManagedChildren, setAgentConfigHome } from '@kodax-ai/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KodaXShellSandbox } from '../types.js';
import { toolBash } from './bash.js';
import { withFileMutation } from './_internal/file-mutation-queue.js';

const WINDOWS_PROCESS_TREE_EXIT_WAIT_MS = process.platform === 'win32' ? 30_000 : 15_000;
const WINDOWS_PROCESS_TREE_TEST_TIMEOUT_MS = process.platform === 'win32' ? 60_000 : 30_000;
const BACKGROUND_CHILD_MARKER = 'child-pid:';

function nodeOutputCommand(stdout: string, commandMarker = ''): string {
  const encoded = Buffer.from(stdout, 'utf-8').toString('base64');
  return `node -e "const marker='${commandMarker}'; void marker; process.stdout.write(Buffer.from('${encoded}','base64'))"`;
}

function passthroughShellSandbox(): KodaXShellSandbox {
  return {
    failClosed: true,
    prepare: async (input) => input.executable === undefined
      ? undefined
      : {
          executable: input.executable,
          args: input.args ?? [],
          env: input.env,
          ...(input.windowsVerbatimArguments === undefined
            ? {}
            : { windowsVerbatimArguments: input.windowsVerbatimArguments }),
          cleanup: async () => undefined,
        },
  };
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
  it('executes an admitted command through the runtime-owned shell sandbox', async () => {
    const cleanup = vi.fn(async () => ({
      version: 1 as const,
      state: 'applied' as const,
      backend: 'windows-restricted-user' as const,
      policyId: 'kodax-workspace-shell-v1' as const,
    }));
    const reportToolSandboxObservation = vi.fn();
    const prepare = vi.fn(async () => ({
      executable: process.execPath,
      args: ['-e', 'process.stdout.write("sandboxed")'],
      env: process.env,
      cleanup,
    }));

    const result = await toolBash({ command: 'echo unsandboxed' }, {
      backups: new Map(),
      toolCallId: 'bash-sandbox-1',
      shellSandbox: { prepare },
      reportToolSandboxObservation,
    });

    expect(completedCommandBody(result)).toContain('sandboxed');
    expect(completedCommandBody(result)).not.toContain('unsandboxed');
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({
      toolCallId: 'bash-sandbox-1',
      command: 'echo unsandboxed',
    }));
    if (process.platform === 'win32') {
      expect(prepare).toHaveBeenCalledWith(expect.objectContaining({
        env: expect.objectContaining({ NoDefaultCurrentDirectoryInExePath: '1' }),
      }));
    }
    expect(cleanup).toHaveBeenCalledOnce();
    expect(reportToolSandboxObservation).toHaveBeenCalledWith({
      version: 1,
      state: 'applied',
      backend: 'windows-restricted-user',
      policyId: 'kodax-workspace-shell-v1',
    });
  });

  it('falls back to ordinary execution when sandbox preparation unexpectedly fails', async () => {
    const reportToolSandboxObservation = vi.fn();
    const prepare = vi.fn(async () => {
      throw new Error('sandbox preparation failed');
    });
    const command = nodeOutputCommand('ordinary execution completed');

    const result = await toolBash({ command }, {
      backups: new Map(),
      toolCallId: 'bash-sandbox-fallback',
      shellSandbox: { prepare },
      reportToolSandboxObservation,
    });

    expect(completedCommandBody(result)).toContain('ordinary execution completed');
    expect(reportToolSandboxObservation).toHaveBeenCalledWith({
      version: 1,
      state: 'fallback',
      reason: 'prepare_failed',
      execution: 'normal_permission_policy',
    });
  });

  it('does not execute when a required sandbox cannot be prepared', async () => {
    const prepare = vi.fn(async () => {
      throw new Error('sandbox unavailable');
    });
    const command = nodeOutputCommand('must not execute');

    const result = await toolBash({ command }, {
      backups: new Map(),
      toolCallId: 'bash-sandbox-required',
      shellSandbox: { failClosed: true, prepare },
    });

    expect(result).toContain('[Error] Command was not started');
    expect(result).toContain('sandbox unavailable');
    expect(result).not.toContain('must not execute');
  });

  it('does not execute when a required sandbox declines the selected call', async () => {
    const command = nodeOutputCommand('must not execute');
    const result = await toolBash({ command }, {
      backups: new Map(),
      toolCallId: 'bash-sandbox-required-missing',
      shellSandbox: { failClosed: true, prepare: async () => undefined },
    });

    expect(result).toContain('[Error] Command was not started');
    expect(result).not.toContain('must not execute');
  });

  it('keeps Provider credentials out of legacy sandbox input and fallback execution', async () => {
    const originalOpenAI = process.env.OPENAI_API_KEY;
    const originalCustom = process.env.KODAX_TEST_CUSTOM_PROVIDER_AUTH;
    const originalSafe = process.env.KODAX_TEST_SAFE_VALUE;
    process.env.OPENAI_API_KEY = 'built-in-secret';
    process.env.KODAX_TEST_CUSTOM_PROVIDER_AUTH = 'custom-secret';
    process.env.KODAX_TEST_SAFE_VALUE = 'safe';
    let preparedEnvironment: NodeJS.ProcessEnv | undefined;
    const prepare = vi.fn(async (input: Parameters<KodaXShellSandbox['prepare']>[0]) => {
      preparedEnvironment = input.env;
      throw new Error('exercise normal-permission fallback');
    });
    const script = [
      'process.env.OPENAI_API_KEY',
      'process.env.KODAX_TEST_CUSTOM_PROVIDER_AUTH',
      'process.env.KODAX_TEST_SAFE_VALUE',
    ].join(" ?? 'missing',") + " ?? 'missing'";
    const encoded = Buffer.from(`process.stdout.write([${script}].join('|'))`, 'utf8')
      .toString('base64');
    try {
      const result = await toolBash({
        command: `node -e "eval(Buffer.from('${encoded}','base64').toString())"`,
      }, {
        backups: new Map(),
        toolCallId: 'bash-filter-provider-credentials',
        shellSandbox: { prepare },
        providerCredentialEnvironmentNames: ['KODAX_TEST_CUSTOM_PROVIDER_AUTH'],
      });

      expect(preparedEnvironment).not.toHaveProperty('OPENAI_API_KEY');
      expect(preparedEnvironment).not.toHaveProperty('KODAX_TEST_CUSTOM_PROVIDER_AUTH');
      expect(preparedEnvironment).toHaveProperty('KODAX_TEST_SAFE_VALUE', 'safe');
      expect(completedCommandBody(result)).toContain('missing|missing|safe');
    } finally {
      if (originalOpenAI === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalOpenAI;
      if (originalCustom === undefined) delete process.env.KODAX_TEST_CUSTOM_PROVIDER_AUTH;
      else process.env.KODAX_TEST_CUSTOM_PROVIDER_AUTH = originalCustom;
      if (originalSafe === undefined) delete process.env.KODAX_TEST_SAFE_VALUE;
      else process.env.KODAX_TEST_SAFE_VALUE = originalSafe;
    }
  });

  it('passes explicitly allowed credentials to sandbox input and fallback execution', async () => {
    const originalPass = process.env.KODAX_SANDBOX_ENV_PASS;
    const originalGitHub = process.env.GITHUB_TOKEN;
    const originalOpenAI = process.env.OPENAI_API_KEY;
    process.env.KODAX_SANDBOX_ENV_PASS = 'OPENAI_API_KEY';
    process.env.GITHUB_TOKEN = 'allowed-secret';
    process.env.OPENAI_API_KEY = 'filtered-secret';
    let preparedEnvironment: NodeJS.ProcessEnv | undefined;
    const prepare = vi.fn(async (input: Parameters<KodaXShellSandbox['prepare']>[0]) => {
      preparedEnvironment = input.env;
      throw new Error('exercise normal-permission fallback');
    });
    const encoded = Buffer.from(
      "process.stdout.write([process.env.GITHUB_TOKEN, process.env.OPENAI_API_KEY ?? 'missing'].join('|'))",
      'utf8',
    ).toString('base64');
    try {
      const result = await toolBash({
        command: `node -e "eval(Buffer.from('${encoded}','base64').toString())"`,
      }, {
        backups: new Map(),
        toolCallId: 'bash-pass-allowed-credential',
        shellSandbox: { prepare },
        sandbox: { envPass: ['GITHUB_TOKEN'] },
      });

      expect(preparedEnvironment).toHaveProperty('GITHUB_TOKEN', 'allowed-secret');
      expect(preparedEnvironment).not.toHaveProperty('OPENAI_API_KEY');
      expect(completedCommandBody(result)).toContain('allowed-secret|missing');
    } finally {
      if (originalPass === undefined) delete process.env.KODAX_SANDBOX_ENV_PASS;
      else process.env.KODAX_SANDBOX_ENV_PASS = originalPass;
      if (originalGitHub === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = originalGitHub;
      if (originalOpenAI === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalOpenAI;
    }
  });

  it('does not fall back or spawn after cancellation during sandbox preparation', async () => {
    const controller = new AbortController();
    const reportToolSandboxObservation = vi.fn();
    const shellSandbox: KodaXShellSandbox = {
      prepare: (input) => new Promise((_, reject) => {
        input.signal?.addEventListener('abort', () => {
          reject(new DOMException('Operation aborted', 'AbortError'));
        }, { once: true });
      }),
    };
    const command = nodeOutputCommand('must not execute');
    const running = toolBash({ command }, {
      backups: new Map(),
      toolCallId: 'bash-sandbox-cancelled-prepare',
      shellSandbox,
      abortSignal: controller.signal,
      reportToolSandboxObservation,
    });

    controller.abort();
    await expect(running).resolves.toContain('[Cancelled]');
    expect(reportToolSandboxObservation).not.toHaveBeenCalled();
  });

  it('does not spawn when the command deadline expires during sandbox preparation', async () => {
    const reportToolSandboxObservation = vi.fn();
    const shellSandbox: KodaXShellSandbox = {
      async prepare() {
        await new Promise((resolve) => setTimeout(resolve, 30));
        throw new Error('late preparation failure');
      },
    };
    const command = nodeOutputCommand('must not execute');

    const result = await toolBash({ command, timeout: 0.01 }, {
      backups: new Map(),
      toolCallId: 'bash-sandbox-timeout-prepare',
      shellSandbox,
      reportToolSandboxObservation,
    });

    expect(result).toContain('[Timeout] Command was not started');
    expect(reportToolSandboxObservation).not.toHaveBeenCalled();
  });

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

  it.runIf(process.platform === 'win32')(
    'does not execute a cwd-shadowed bare command through legacy cmd',
    async () => {
      const marker = 'KODAX_CWD_SHADOW_EXECUTED';
      const comspec = process.env.ComSpec ?? process.env.COMSPEC;
      expect(comspec).toBeTruthy();
      await fs.copyFile(comspec!, path.join(tempDir, 'where.exe'));

      const result = await toolBash({ command: `where /c echo ${marker}` }, {
        backups: new Map(),
        executionCwd: tempDir,
      });

      expect(completedCommandBody(result)).not.toContain(marker);
    },
  );

  it('spills large command output at the Bash byte/line policy', async () => {
    // NOTE: keep this shell-portable — backticks / ${...} inside the double-
    // quoted -e script get interpreted by POSIX `sh` (command substitution +
    // parameter expansion) before node sees them, which on Linux CI produced
    // blank lines instead of "line-N". Use single-quoted string concatenation.
    const command = 'node -e "for (let i = 1; i <= 3000; i++) console.log(\'line-\' + i)"';
    const result = await toolBash({ command }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    expect(result).toContain('KODAX_RESULT_INCOMPLETE');
    expect(result).not.toContain('line-1\n');
    const outputPath = parseRecoveryOutputPath(result, 'stdout');
    const artifact = await fs.readFile(outputPath, 'utf-8');
    expect(artifact).toContain('line-1\n');
    expect(artifact).toContain('line-3000');
  });

  it('captures stdout and stderr from the first byte after the policy threshold is crossed', async () => {
    const command = 'node -e "process.stdout.write(\'stdout-first-byte\\n\'+\'x\'.repeat(600*1024)+\'\\nstdout-last-byte\'); process.stderr.write(\'stderr-first-byte\\n\'+\'y\'.repeat(600*1024)+\'\\nstderr-last-byte\')"';
    const result = await toolBash({ command }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    expect(result).toContain('KODAX_RESULT_INCOMPLETE');
    const stdoutPath = parseRecoveryOutputPath(result, 'stdout');
    const stderrPath = parseRecoveryOutputPath(result, 'stderr');
    await expect(fs.readFile(stdoutPath, 'utf-8')).resolves.toEqual(expect.stringContaining('stdout-first-byte'));
    await expect(fs.readFile(stdoutPath, 'utf-8')).resolves.toEqual(expect.stringContaining('stdout-last-byte'));
    await expect(fs.readFile(stderrPath, 'utf-8')).resolves.toEqual(expect.stringContaining('stderr-first-byte'));
    await expect(fs.readFile(stderrPath, 'utf-8')).resolves.toEqual(expect.stringContaining('stderr-last-byte'));
  });

  it('spills 174,763 continuous A bytes without materializing them inline', async () => {
    const content = 'A'.repeat(174_763);
    const command = 'node -e "process.stdout.write(\'A\'.repeat(174763))"';
    const result = await toolBash({ command }, {
      backups: new Map(),
      executionCwd: tempDir,
      toolCallId: 'dense-bash-output',
    });

    expect(result).toContain('KODAX_RESULT_INCOMPLETE');
    expect(result.length).toBeLessThan(4_096);
    const outputPath = parseRecoveryOutputPath(result, 'stdout');
    const artifact = await fs.readFile(outputPath, 'utf-8');
    expect(artifact).toContain(content);
    expect(artifact).toContain('KODAX_CAPTURE_COMPLETE');
  });

  it('keeps a canonical artifact when raw bytes prove the output cannot fit any request', async () => {
    const command = nodeOutputCommand(`BEGIN_SENTINEL${'x'.repeat(1024)}END_SENTINEL`);
    const recordToolResultArtifact = vi.fn();
    const result = await toolBash({ command }, {
      backups: new Map(),
      executionCwd: tempDir,
      shellSandbox: passthroughShellSandbox(),
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
    const abortWatchdog = setTimeout(() => controller.abort(), 5_000);
    const originalEmit = ChildProcess.prototype.emit;
    const delayedPids = new Set<number>();
    const recoveryPaths: string[] = [];
    const emitSpy = vi.spyOn(ChildProcess.prototype, 'emit').mockImplementation(function (
      this: ChildProcess,
      event: string | symbol,
      ...args: unknown[]
    ): boolean {
      const shouldDelay = event === 'close'
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
        shellSandbox: passthroughShellSandbox(),
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
      shellSandbox: passthroughShellSandbox(),
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
    await expect(withFileMutation(path.join(tempDir, 'after-fast-background.txt'), async () => 'ready'))
      .resolves.toBe('ready');
  });

  it.runIf(process.platform === 'win32')(
    'keeps a passthrough sandbox inside the per-effect Job until detached descendants drain',
    async () => {
      const sentinel = path.join(tempDir, 'passthrough-detached-child.txt');
      const childScript = Buffer.from(
        `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'alive'), 2500)`,
        'utf8',
      ).toString('base64');
      const rootScript = Buffer.from([
        "const {spawn}=require('node:child_process')",
        `const child=spawn(process.execPath,['-e',${JSON.stringify(`eval(Buffer.from('${childScript}','base64').toString())`)}],{detached:true,stdio:'ignore',windowsHide:true})`,
        'child.unref()',
      ].join(';'), 'utf8').toString('base64');

      await toolBash({
        command: `node -e "eval(Buffer.from('${rootScript}','base64').toString())"`,
      }, {
        backups: new Map(),
        executionCwd: tempDir,
        shellSandbox: passthroughShellSandbox(),
      });
      await expect(withFileMutation(path.join(tempDir, 'after-passthrough.txt'), async () => 'ready'))
        .resolves.toBe('ready');
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      await expect(fs.readFile(sentinel, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    },
    WINDOWS_PROCESS_TREE_TEST_TIMEOUT_MS,
  );

  it('releases the filesystem-effect lease when background log creation fails', async () => {
    const originalTemp = process.env.TEMP;
    const originalTmp = process.env.TMP;
    const originalTmpdir = process.env.TMPDIR;
    const missingTemp = path.join(tempDir, 'missing-temp');
    process.env.TEMP = missingTemp;
    process.env.TMP = missingTemp;
    process.env.TMPDIR = missingTemp;
    try {
      const failed = await toolBash({
        command: nodeOutputCommand('must-not-start'),
        run_in_background: true,
      }, {
        backups: new Map(),
        executionCwd: tempDir,
      });
      expect(failed).toContain('output file could not be created');
    } finally {
      if (originalTemp === undefined) delete process.env.TEMP;
      else process.env.TEMP = originalTemp;
      if (originalTmp === undefined) delete process.env.TMP;
      else process.env.TMP = originalTmp;
      if (originalTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmpdir;
    }

    const result = await toolBash({ command: nodeOutputCommand('lease-released') }, {
      backups: new Map(),
      executionCwd: tempDir,
    });
    expect(completedCommandBody(result)).toContain('lease-released');
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
