import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setAgentConfigHome } from '@kodax-ai/agent';
import type { RunnerToolCall } from '@kodax-ai/agent';

import { replBashPathSignalCollector } from './repl-bash-signals.js';

const PROJECT_ROOT = path.resolve('/tmp/kodax-repl-bash-signals-test');
const USER_KODAX = path.resolve('/tmp/kodax-repl-bash-signals-test-home/.kodax');

function bash(command: string): RunnerToolCall {
  return { id: 'c', name: 'bash', input: { command } };
}

describe('replBashPathSignalCollector — tool name', () => {
  it('matches bash only', () => {
    expect(replBashPathSignalCollector.toolNames.has('bash')).toBe(true);
    expect(replBashPathSignalCollector.toolNames.has('write')).toBe(false);
  });
});

describe('replBashPathSignalCollector — protected_path detection', () => {
  beforeEach(() => {
    setAgentConfigHome(USER_KODAX);
  });
  afterEach(() => {
    setAgentConfigHome(undefined);
  });

  it('detects ~/.kodax write target via redirect', () => {
    const cmd = `echo x > ${USER_KODAX}/leak.txt`;
    const signals = replBashPathSignalCollector.collect(bash(cmd), PROJECT_ROOT);
    expect(signals.some((s) => s.kind === 'protected_path' && s.zone === 'user-kodax')).toBe(true);
  });

  it('detects <projectRoot>/.kodax path via argv', () => {
    const cmd = `cat ${PROJECT_ROOT}/.kodax/permissions.json`;
    const signals = replBashPathSignalCollector.collect(bash(cmd), PROJECT_ROOT);
    expect(signals.some((s) => s.kind === 'protected_path' && s.zone === 'project-kodax')).toBe(true);
  });
});

describe('replBashPathSignalCollector — outside_project', () => {
  beforeEach(() => {
    setAgentConfigHome(USER_KODAX);
  });
  afterEach(() => {
    setAgentConfigHome(undefined);
  });

  it('does NOT emit outside_project for system temp (safe scratchpad)', () => {
    // Use os.tmpdir() directly — `/tmp` is POSIX-only; on Windows it resolves
    // to `C:\tmp` which is NOT the actual system temp dir.
    const tempScratch = path.join(os.tmpdir(), 'scratch.txt');
    const signals = replBashPathSignalCollector.collect(
      bash(`echo x > ${tempScratch}`),
      PROJECT_ROOT,
    );
    expect(signals.some((s) => s.kind === 'outside_project')).toBe(false);
    expect(signals.some((s) => s.kind === 'shell_redirect_outside')).toBe(false);
  });
});

describe('replBashPathSignalCollector — empty / invalid input', () => {
  it('returns empty for empty projectRoot', () => {
    const signals = replBashPathSignalCollector.collect(bash('rm foo'), '');
    expect(signals).toEqual([]);
  });

  it('returns empty for missing command', () => {
    const signals = replBashPathSignalCollector.collect({ id: 'c', name: 'bash', input: {} }, PROJECT_ROOT);
    expect(signals).toEqual([]);
  });
});
