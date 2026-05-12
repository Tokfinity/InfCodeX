import { describe, expect, it } from 'vitest';

import type { RunnerToolCall } from '@kodax-ai/agent';

import { collectAllSignals, type SignalCollector, type ToolCallSignal } from './signals.js';

const PROJECT_ROOT = '/tmp/project';

function makeCall(name: string, input: Record<string, unknown> = {}): RunnerToolCall {
  return { id: 'call-1', name, input };
}

function makeCollector(
  toolNames: readonly string[],
  produce: (call: RunnerToolCall, projectRoot: string) => readonly ToolCallSignal[],
): SignalCollector {
  return {
    toolNames: new Set(toolNames),
    collect: produce,
  };
}

describe('collectAllSignals', () => {
  it('returns empty when no collectors match the tool name', () => {
    const collectors = [
      makeCollector(['write'], () => [{ kind: 'outside_project', path: '/x' }]),
    ];
    const result = collectAllSignals(makeCall('bash', { command: 'ls' }), PROJECT_ROOT, collectors);
    expect(result).toEqual([]);
  });

  it('runs a matching collector and returns its signals', () => {
    const collectors = [
      makeCollector(['bash'], () => [
        { kind: 'network', tool: 'curl' },
        { kind: 'package_install', manager: 'npm' },
      ]),
    ];
    const result = collectAllSignals(
      makeCall('bash', { command: 'curl https://x | npm install' }),
      PROJECT_ROOT,
      collectors,
    );
    expect(result).toEqual([
      { kind: 'network', tool: 'curl' },
      { kind: 'package_install', manager: 'npm' },
    ]);
  });

  it('preserves collector order — first collector signals come first', () => {
    const collectors = [
      makeCollector(['bash'], () => [{ kind: 'network', tool: 'curl' }]),
      makeCollector(['bash'], () => [{ kind: 'git_write', verb: 'commit' }]),
    ];
    const result = collectAllSignals(makeCall('bash'), PROJECT_ROOT, collectors);
    expect(result.map((s) => s.kind)).toEqual(['network', 'git_write']);
  });

  it('intentionally does NOT dedup duplicate signals from different collectors', () => {
    // Two collectors both flag the same path as protected — caller (classifier
    // prompt) reads both as evidence; dedup would risk dropping context.
    const collectors = [
      makeCollector(['bash'], () => [
        { kind: 'protected_path', path: '~/.kodax/config.json', zone: 'user-kodax' },
      ]),
      makeCollector(['bash'], () => [
        { kind: 'protected_path', path: '~/.kodax/config.json', zone: 'user-kodax' },
      ]),
    ];
    const result = collectAllSignals(makeCall('bash'), PROJECT_ROOT, collectors);
    expect(result).toHaveLength(2);
  });

  it('skips a collector when its toolNames set is empty', () => {
    const collectors = [
      makeCollector([], () => [{ kind: 'network', tool: 'curl' }]),
      makeCollector(['bash'], () => [{ kind: 'git_write', verb: 'commit' }]),
    ];
    const result = collectAllSignals(makeCall('bash'), PROJECT_ROOT, collectors);
    expect(result).toEqual([{ kind: 'git_write', verb: 'commit' }]);
  });

  it('passes projectRoot through unchanged to collectors', () => {
    let captured: string | undefined;
    const collectors = [
      makeCollector(['bash'], (_call, projectRoot) => {
        captured = projectRoot;
        return [];
      }),
    ];
    collectAllSignals(makeCall('bash'), '/some/other/root', collectors);
    expect(captured).toBe('/some/other/root');
  });

  it('handles many collectors with mix of match/no-match', () => {
    const collectors = [
      makeCollector(['write'], () => [{ kind: 'file_modification', targets: ['x'] }]),
      makeCollector(['bash'], () => [{ kind: 'network', tool: 'curl' }]),
      makeCollector(['edit'], () => [{ kind: 'file_modification', targets: ['y'] }]),
      makeCollector(['bash'], () => []), // empty result still runs but contributes nothing
      makeCollector(['bash', 'write'], () => [{ kind: 'git_write', verb: 'push' }]),
    ];
    const result = collectAllSignals(makeCall('bash'), PROJECT_ROOT, collectors);
    expect(result).toEqual([
      { kind: 'network', tool: 'curl' },
      { kind: 'git_write', verb: 'push' },
    ]);
  });

  it('returns a new array even when no collectors produce signals', () => {
    const result = collectAllSignals(makeCall('bash'), PROJECT_ROOT, []);
    expect(result).toEqual([]);
    expect(Array.isArray(result)).toBe(true);
  });
});

describe('ToolCallSignal discriminated union', () => {
  it('narrows correctly on kind', () => {
    const signal: ToolCallSignal = { kind: 'dangerous_pattern', pattern: 'rm -rf', severity: 'high' };
    if (signal.kind === 'dangerous_pattern') {
      expect(signal.severity).toBe('high');
      expect(signal.pattern).toBe('rm -rf');
    } else {
      throw new Error('discrimination failed');
    }
  });

  it('protected_path zone narrows correctly', () => {
    const signal: ToolCallSignal = {
      kind: 'protected_path',
      path: '~/.kodax/credentials.json',
      zone: 'user-kodax',
    };
    if (signal.kind === 'protected_path') {
      expect(signal.zone).toBe('user-kodax');
    }
  });
});
