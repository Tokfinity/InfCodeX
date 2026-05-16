/**
 * FEATURE_125 (v0.7.41) — active-file-warning hermetic tests.
 *
 * Pure function tests; no fs / clock / network. Fixtures construct
 * `DiscoveredInstance` shapes inline to pin overlap semantics.
 */

import { describe, expect, it } from 'vitest';

import type { DiscoveredInstance, PersistedSessionState, SessionMeta } from '@kodax-ai/agent';

import {
  buildActiveFileWarningBanner,
  detectActiveFileOverlap,
  formatActiveFileWarning,
} from './active-file-warning.js';

const baseMeta: SessionMeta = {
  cwd: '/Users/test/repo',
  startedAt: 1_700_000_000_000,
  gitBranch: 'main',
};

function makeSibling(overrides: {
  pid: number;
  state?: Partial<PersistedSessionState>;
}): DiscoveredInstance {
  const state: PersistedSessionState = {
    version: '1',
    pid: overrides.pid,
    updatedAt: 1_700_000_000_000,
    meta: baseMeta,
    agentPhase: 'running_tool',
    ...overrides.state,
  };
  return {
    pid: overrides.pid,
    state,
    heartbeatMtimeMs: 1_700_000_000_000,
  };
}

describe('detectActiveFileOverlap', () => {
  it('returns null when there are no siblings', () => {
    expect(detectActiveFileOverlap('/r/a.ts', [])).toBeNull();
  });

  it('returns null when no sibling has an activeFiles list', () => {
    const siblings = [makeSibling({ pid: 100, state: { activeFiles: undefined } })];
    expect(detectActiveFileOverlap('/r/a.ts', siblings)).toBeNull();
  });

  it('returns null when no sibling matches the path', () => {
    const siblings = [makeSibling({ pid: 100, state: { activeFiles: ['/r/b.ts'] } })];
    expect(detectActiveFileOverlap('/r/a.ts', siblings)).toBeNull();
  });

  it('returns one conflicting peer when a single sibling is editing the path', () => {
    const siblings = [
      makeSibling({
        pid: 100,
        state: { activeFiles: ['/r/a.ts'], currentIntent: 'refactor auth' },
      }),
    ];
    const overlap = detectActiveFileOverlap('/r/a.ts', siblings);
    expect(overlap).not.toBeNull();
    expect(overlap?.filePath).toBe('/r/a.ts');
    expect(overlap?.conflictingPeers).toHaveLength(1);
    expect(overlap?.conflictingPeers[0]).toEqual({
      pid: 100,
      intent: 'refactor auth',
      cwd: '/Users/test/repo',
    });
  });

  it('returns multiple peers when several siblings are editing the same path', () => {
    const siblings = [
      makeSibling({ pid: 100, state: { activeFiles: ['/r/a.ts'] } }),
      makeSibling({ pid: 200, state: { activeFiles: ['/r/a.ts', '/r/b.ts'] } }),
      makeSibling({ pid: 300, state: { activeFiles: ['/r/c.ts'] } }),
    ];
    const overlap = detectActiveFileOverlap('/r/a.ts', siblings);
    expect(overlap?.conflictingPeers.map((p) => p.pid).sort()).toEqual([100, 200]);
  });

  it('omits the intent field when currentIntent is absent', () => {
    const siblings = [
      makeSibling({ pid: 100, state: { activeFiles: ['/r/a.ts'], currentIntent: undefined } }),
    ];
    const overlap = detectActiveFileOverlap('/r/a.ts', siblings);
    expect(overlap?.conflictingPeers[0]).toEqual({ pid: 100, cwd: '/Users/test/repo' });
    expect(overlap?.conflictingPeers[0]).not.toHaveProperty('intent');
  });

  it('does NOT match on prefix / directory containment (exact-path only)', () => {
    // packages/foo is NOT the same as packages/foo/Button.tsx
    const siblings = [makeSibling({ pid: 100, state: { activeFiles: ['/r/packages/foo'] } })];
    expect(detectActiveFileOverlap('/r/packages/foo/Button.tsx', siblings)).toBeNull();
  });

  it('matches case-sensitively (caller normalizes paths upstream)', () => {
    const siblings = [makeSibling({ pid: 100, state: { activeFiles: ['/r/A.ts'] } })];
    expect(detectActiveFileOverlap('/r/a.ts', siblings)).toBeNull();
  });
});

describe('buildActiveFileWarningBanner', () => {
  it('renders single-peer banner with intent', () => {
    const banner = buildActiveFileWarningBanner({
      filePath: '/r/a.ts',
      conflictingPeers: [{ pid: 100, intent: 'refactor auth', cwd: '/r' }],
    });
    expect(banner).toContain('[Warning: Another session is editing this file]');
    expect(banner).toContain('pid 100 is editing /r/a.ts');
    expect(banner).toContain('intent: "refactor auth"');
    expect(banner).toContain('Your edit may overwrite or conflict');
  });

  it('renders single-peer banner without intent', () => {
    const banner = buildActiveFileWarningBanner({
      filePath: '/r/a.ts',
      conflictingPeers: [{ pid: 100, cwd: '/r' }],
    });
    expect(banner).toContain('pid 100 is editing /r/a.ts');
    expect(banner).not.toContain('intent:');
  });

  it('renders multi-peer banner with one line per peer', () => {
    const banner = buildActiveFileWarningBanner({
      filePath: '/r/a.ts',
      conflictingPeers: [
        { pid: 100, intent: 'a', cwd: '/r' },
        { pid: 200, intent: 'b', cwd: '/r' },
      ],
    });
    expect(banner).toContain('pid 100');
    expect(banner).toContain('pid 200');
    expect(banner.split('\n').filter((l) => l.startsWith('- pid'))).toHaveLength(2);
  });

  it('tells the LLM to NOT verbatim-quote the warning to the user', () => {
    const banner = buildActiveFileWarningBanner({
      filePath: '/r/a.ts',
      conflictingPeers: [{ pid: 100, cwd: '/r' }],
    });
    expect(banner).toMatch(/Do NOT mention this warning to the user verbatim/);
  });

  it('returns a bare string with no trailing newline', () => {
    const banner = buildActiveFileWarningBanner({
      filePath: '/r/a.ts',
      conflictingPeers: [{ pid: 100, cwd: '/r' }],
    });
    expect(banner.endsWith('\n')).toBe(false);
  });
});

describe('formatActiveFileWarning (one-shot convenience)', () => {
  it('returns null when no overlap (caller can splice unconditionally)', () => {
    expect(formatActiveFileWarning('/r/a.ts', [])).toBeNull();
    const siblings = [makeSibling({ pid: 100, state: { activeFiles: ['/r/other.ts'] } })];
    expect(formatActiveFileWarning('/r/a.ts', siblings)).toBeNull();
  });

  it('returns the rendered banner when overlap exists', () => {
    const siblings = [
      makeSibling({ pid: 100, state: { activeFiles: ['/r/a.ts'], currentIntent: 'edit' } }),
    ];
    const banner = formatActiveFileWarning('/r/a.ts', siblings);
    expect(banner).toContain('[Warning: Another session is editing this file]');
    expect(banner).toContain('pid 100');
  });
});
