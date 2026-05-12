import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setAgentConfigHome } from '@kodax-ai/agent';
import type { RunnerToolCall } from '@kodax-ai/agent';

import { fileSignalCollector } from './file-signals.js';

const PROJECT_ROOT = path.resolve('/tmp/kodax-test-project');
const USER_KODAX = path.resolve('/tmp/kodax-test-user-home/.kodax');

function call(tool: 'write' | 'edit', p: string): RunnerToolCall {
  return { id: 'c1', name: tool, input: { path: p } };
}

describe('fileSignalCollector — tool name match', () => {
  it('matches write and edit, not bash', () => {
    expect(fileSignalCollector.toolNames.has('write')).toBe(true);
    expect(fileSignalCollector.toolNames.has('edit')).toBe(true);
    expect(fileSignalCollector.toolNames.has('bash')).toBe(false);
    expect(fileSignalCollector.toolNames.has('read')).toBe(false);
  });
});

describe('fileSignalCollector — protected_path zones', () => {
  beforeEach(() => {
    setAgentConfigHome(USER_KODAX);
  });

  afterEach(() => {
    // Reset to env-default resolution
    setAgentConfigHome(undefined);
  });

  it('emits user-kodax zone for paths under ~/.kodax', () => {
    const signals = fileSignalCollector.collect(call('write', path.join(USER_KODAX, 'config.json')), PROJECT_ROOT);
    const pp = signals.find((s) => s.kind === 'protected_path');
    if (pp?.kind === 'protected_path') {
      expect(pp.zone).toBe('user-kodax');
    } else {
      throw new Error('expected protected_path signal');
    }
  });

  it('emits project-kodax zone for paths under <projectRoot>/.kodax', () => {
    const signals = fileSignalCollector.collect(
      call('write', path.join(PROJECT_ROOT, '.kodax', 'agents.md')),
      PROJECT_ROOT,
    );
    const pp = signals.find((s) => s.kind === 'protected_path');
    if (pp?.kind === 'protected_path') {
      expect(pp.zone).toBe('project-kodax');
    } else {
      throw new Error('expected protected_path signal');
    }
  });

  it('does NOT emit protected_path for regular project files', () => {
    const signals = fileSignalCollector.collect(call('write', path.join(PROJECT_ROOT, 'src/index.ts')), PROJECT_ROOT);
    expect(signals.some((s) => s.kind === 'protected_path')).toBe(false);
  });
});

describe('fileSignalCollector — outside_project', () => {
  beforeEach(() => {
    setAgentConfigHome(USER_KODAX);
  });

  afterEach(() => {
    setAgentConfigHome(undefined);
  });

  it('emits outside_project for paths outside projectRoot AND outside temp', () => {
    const outside = path.resolve('/var/log/app.log');
    const signals = fileSignalCollector.collect(call('write', outside), PROJECT_ROOT);
    expect(signals.some((s) => s.kind === 'outside_project')).toBe(true);
  });

  it('does NOT emit outside_project for system temp paths (safe scratchpad)', () => {
    const tempFile = path.join(os.tmpdir(), 'scratch.txt');
    const signals = fileSignalCollector.collect(call('write', tempFile), PROJECT_ROOT);
    expect(signals.some((s) => s.kind === 'outside_project')).toBe(false);
  });

  it('does NOT double-flag a path that is BOTH outside project AND in user-kodax', () => {
    // ~/.kodax is outside project; we want protected_path NOT outside_project
    // (otherwise the classifier gets confused — same target, two flags with
    // different framing).
    const signals = fileSignalCollector.collect(call('write', path.join(USER_KODAX, 'creds.json')), PROJECT_ROOT);
    const kinds = signals.map((s) => s.kind);
    expect(kinds).toContain('protected_path');
    expect(kinds).not.toContain('outside_project');
  });
});

describe('fileSignalCollector — file_modification anchor', () => {
  it('always emits file_modification with the target path', () => {
    const signals = fileSignalCollector.collect(call('write', 'src/x.ts'), PROJECT_ROOT);
    const fm = signals.find((s) => s.kind === 'file_modification');
    if (fm?.kind === 'file_modification') {
      expect(fm.targets).toEqual(['src/x.ts']);
    } else {
      throw new Error('expected file_modification signal');
    }
  });

  it('emits file_modification alongside protected_path', () => {
    setAgentConfigHome(USER_KODAX);
    try {
      const signals = fileSignalCollector.collect(call('edit', path.join(USER_KODAX, 'config.json')), PROJECT_ROOT);
      expect(signals.some((s) => s.kind === 'protected_path')).toBe(true);
      expect(signals.some((s) => s.kind === 'file_modification')).toBe(true);
    } finally {
      setAgentConfigHome(undefined);
    }
  });
});

describe('fileSignalCollector — input validation', () => {
  it('returns empty when path field is missing or non-string', () => {
    expect(fileSignalCollector.collect({ id: 'c', name: 'write', input: {} }, PROJECT_ROOT)).toEqual([]);
    expect(
      fileSignalCollector.collect({ id: 'c', name: 'write', input: { path: 42 as unknown as string } }, PROJECT_ROOT),
    ).toEqual([]);
  });
});
