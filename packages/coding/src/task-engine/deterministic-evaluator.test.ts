/**
 * FEATURE_114 v0.7.36 — deterministic-evaluator contract tests.
 *
 * Spawns real shell commands with the active node binary so the test
 * exercises the same code path production uses. Each test uses a
 * one-liner that finishes in well under 1s.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { KodaXShellExecutionContract } from '../types.js';
import { clearShellExecutionEnvironmentCache } from '../shell-execution/resolver.js';
import {
  formatDeterministicEvaluatorResult,
  runDeterministicEvaluator,
} from './deterministic-evaluator.js';

afterEach(() => {
  clearShellExecutionEnvironmentCache();
  vi.unstubAllEnvs();
});

describe('runDeterministicEvaluator', () => {
  it('uses the configured project shell environment without provider credentials', async () => {
    vi.stubEnv('KODAX_EVALUATOR_PROVIDER_AUTH', 'must-not-leak');
    const cwd = await mkdtemp(path.join(tmpdir(), 'kodax-evaluator-shell-'));
    const setup = process.platform === 'win32'
      ? 'set "KODAX_EVALUATOR_TOOLCHAIN=project-node"'
      : 'export KODAX_EVALUATOR_TOOLCHAIN=project-node';
    const shellExecution: KodaXShellExecutionContract = {
      version: 1,
      shell: {
        kind: process.platform === 'win32' ? 'cmd' : 'bash',
        profile: 'none',
      },
      environment: { setup },
      cache: { ttlMs: 0 },
    };
    const script = [
      "process.stdout.write(process.env.KODAX_EVALUATOR_TOOLCHAIN||'missing')",
      "process.stdout.write('|'+(process.env.KODAX_EVALUATOR_PROVIDER_AUTH||'missing'))",
    ].join(';');

    const result = await runDeterministicEvaluator({
      hint: 'test',
      cwd,
      shellExecution,
      providerCredentialEnvironmentNames: ['KODAX_EVALUATOR_PROVIDER_AUTH'],
      commandOverride: `"${process.execPath}" -e "${script}"`,
      timeoutMs: 5_000,
    });

    expect(result.status).toBe('pass');
    expect(result.stdoutTail).toBe('project-node|missing');
    expect(result.stdoutTail).not.toContain('must-not-leak');
  });

  it("reports 'pass' for an exit-0 command override", async () => {
    const result = await runDeterministicEvaluator({
      hint: 'build',
      cwd: process.cwd(),
      commandOverride: 'node -e "process.exit(0)"',
      timeoutMs: 5_000,
    });
    expect(result.status).toBe('pass');
    expect(result.exitCode).toBe(0);
    expect(result.command).toContain('process.exit(0)');
  });

  it("reports 'fail' with stderr tail for an exit-1 command", async () => {
    const result = await runDeterministicEvaluator({
      hint: 'test',
      cwd: process.cwd(),
      commandOverride: 'node -e "console.error(\'bad-thing\'); process.exit(2)"',
      timeoutMs: 5_000,
    });
    expect(result.status).toBe('fail');
    expect(result.exitCode).toBe(2);
    expect(result.stderrTail).toContain('bad-thing');
  });

  it('preserves complete stdout and stderr across the memory-to-spool boundary', async () => {
    const spoolPrefix = `kodax-bash-${process.pid}-`;
    const before = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith(spoolPrefix)));
    const result = await runDeterministicEvaluator({
      hint: 'test',
      cwd: process.cwd(),
      commandOverride: 'node -e "process.stdout.write(\'STDOUT-FIRST\\n\'+\'o\'.repeat(600000)+\'\\nSTDOUT-LAST\'); process.stderr.write(\'STDERR-FIRST\\n\'+\'e\'.repeat(600000)+\'\\nSTDERR-LAST\'); process.exitCode=3"',
      timeoutMs: 10_000,
    });

    expect(result.status).toBe('fail');
    expect(result.stdoutTail).toMatch(/^STDOUT-FIRST\r?\n/);
    expect(result.stdoutTail).toMatch(/\r?\nSTDOUT-LAST$/);
    expect(result.stdoutTail.length).toBeGreaterThan(600_000);
    expect(result.stderrTail).toMatch(/^STDERR-FIRST\r?\n/);
    expect(result.stderrTail).toMatch(/\r?\nSTDERR-LAST$/);
    expect(result.stderrTail.length).toBeGreaterThan(600_000);

    const rendered = formatDeterministicEvaluatorResult(result);
    expect(rendered).toContain('--- stdout ---');
    expect(rendered).toContain('STDOUT-FIRST');
    expect(rendered).toContain('STDOUT-LAST');
    expect(rendered).toContain('--- stderr ---');
    expect(rendered).toContain('STDERR-FIRST');
    expect(rendered).toContain('STDERR-LAST');
    expect(rendered).not.toContain('--- stdout tail');
    expect(rendered).not.toContain('--- stderr tail');

    const after = readdirSync(tmpdir()).filter(
      (name) => name.startsWith(spoolPrefix) && !before.has(name),
    );
    expect(after).toEqual([]);
  });

  it('reports exit code 0 for noop commands', async () => {
    const result = await runDeterministicEvaluator({
      hint: 'lint',
      cwd: process.cwd(),
      commandOverride: 'node -e "console.log(\'ok\')"',
      timeoutMs: 5_000,
    });
    expect(result.status).toBe('pass');
    expect(result.stdoutTail).toContain('ok');
  });

  it("reports 'error' on timeout", { timeout: 15_000 }, async () => {
    // Kill via SIGTERM on a Node child; on Windows the platform maps
    // SIGTERM to TerminateProcess so the child still exits, just may
    // take a moment more than POSIX. The 15s vitest timeout covers
    // the slowest expected reaper path.
    const result = await runDeterministicEvaluator({
      hint: 'test',
      cwd: process.cwd(),
      // Use stdin.resume() which keeps the process alive until the
      // pipes are closed by SIGTERM/TerminateProcess — slightly more
      // reliable across platforms than a long setTimeout.
      commandOverride: 'node -e "process.stdin.resume()"',
      timeoutMs: 500,
    });
    expect(result.status).toBe('error');
    expect(result.stderrTail).toContain('TIMEOUT');
  });
});

describe('formatDeterministicEvaluatorResult', () => {
  it('renders a pass header without stderr/stdout for pass', () => {
    const out = formatDeterministicEvaluatorResult({
      hint: 'build',
      command: 'npm run build',
      status: 'pass',
      exitCode: 0,
      stderrTail: '',
      stdoutTail: '',
      durationMs: 1200,
    });
    expect(out).toContain('[deterministic-evaluator:build] pass');
    expect(out).not.toContain('--- stderr tail ---');
  });

  it('includes stderr tail on fail', () => {
    const out = formatDeterministicEvaluatorResult({
      hint: 'test',
      command: 'npm test',
      status: 'fail',
      exitCode: 1,
      stderrTail: 'AssertionError: x !== y',
      stdoutTail: '',
      durationMs: 800,
    });
    expect(out).toContain('fail');
    expect(out).toContain('AssertionError: x !== y');
  });

  it('renders a soft skipped message when the script is missing', () => {
    const out = formatDeterministicEvaluatorResult({
      hint: 'build',
      command: 'npm run build',
      status: 'skipped',
      exitCode: 1,
      stderrTail: 'Missing script: build',
      stdoutTail: '',
      durationMs: 50,
    });
    expect(out).toContain('skipped');
    expect(out).toContain('Skipped: command not available');
  });
});
