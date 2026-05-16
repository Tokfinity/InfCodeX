/**
 * FEATURE_125 (v0.7.41) — system-prompt-injection hermetic tests.
 *
 * buildOtherInstancesPromptBlock is a pure formatter; tests pin
 * output shape, ordering, truncation, and empty-input semantics
 * against fixtures.
 */

import { describe, expect, it } from 'vitest';

import { buildOtherInstancesPromptBlock } from './system-prompt-injection.js';
import type { DiscoveredInstance } from './instance-discovery.js';
import type { PersistedSessionState, SessionMeta } from './state-writer.js';

const NOW = 1_700_000_500_000;

const baseMeta: SessionMeta = {
  cwd: '/Users/me/work/myrepo',
  startedAt: NOW - 5 * 60_000,
  gitBranch: 'main',
};

function makeInstance(overrides: {
  pid: number;
  state?: Partial<PersistedSessionState>;
  heartbeatMtimeMs?: number;
}): DiscoveredInstance {
  const state: PersistedSessionState = {
    version: '1',
    pid: overrides.pid,
    updatedAt: NOW - 100,
    meta: baseMeta,
    agentPhase: 'running_tool',
    currentIntent: 'implementing dark mode toggle',
    activeFiles: ['packages/ui/Button.tsx'],
    ...overrides.state,
  };
  return {
    pid: overrides.pid,
    state,
    heartbeatMtimeMs: overrides.heartbeatMtimeMs ?? NOW - 100,
  };
}

describe('buildOtherInstancesPromptBlock — empty input', () => {
  it("returns '' so the caller can splice unconditionally", () => {
    expect(buildOtherInstancesPromptBlock([], { nowMs: NOW })).toBe('');
  });
});

describe('buildOtherInstancesPromptBlock — single sibling', () => {
  it('renders a header + one peer block + coordination guidance', () => {
    const out = buildOtherInstancesPromptBlock(
      [makeInstance({ pid: 12389 })],
      { nowMs: NOW },
    );

    expect(out).toContain('=== Other active KodaX sessions ===');
    expect(out).toContain('1 other KodaX session running');
    expect(out).toContain('pid 12389 @ /Users/me/work/myrepo');
    expect(out).toContain('Phase: running_tool');
    expect(out).toContain('Intent: "implementing dark mode toggle"');
    expect(out).toContain('Currently editing: packages/ui/Button.tsx');
    expect(out).toContain('Coordination guidance:');
    // Block must NOT prescribe a hard action ("You MUST avoid").
    expect(out).not.toMatch(/MUST avoid|must NOT/i);
  });

  it('omits the Intent line when currentIntent is absent', () => {
    const out = buildOtherInstancesPromptBlock(
      [makeInstance({ pid: 100, state: { currentIntent: undefined } })],
      { nowMs: NOW },
    );
    expect(out).not.toContain('Intent:');
  });

  it('omits "Currently editing" when activeFiles is empty or undefined', () => {
    const empty = buildOtherInstancesPromptBlock(
      [makeInstance({ pid: 100, state: { activeFiles: [] } })],
      { nowMs: NOW },
    );
    expect(empty).not.toContain('Currently editing');

    const undef = buildOtherInstancesPromptBlock(
      [makeInstance({ pid: 100, state: { activeFiles: undefined } })],
      { nowMs: NOW },
    );
    expect(undef).not.toContain('Currently editing');
  });

  it("renders Currently editing list comma-separated when multiple files are active", () => {
    const out = buildOtherInstancesPromptBlock(
      [makeInstance({ pid: 100, state: { activeFiles: ['a.ts', 'b.ts'] } })],
      { nowMs: NOW },
    );
    expect(out).toContain('Currently editing (multiple): a.ts, b.ts');
  });
});

describe('buildOtherInstancesPromptBlock — recentlyModifiedFiles', () => {
  it('renders up to 3 recent files per peer with relative timestamps', () => {
    const out = buildOtherInstancesPromptBlock(
      [makeInstance({
        pid: 100,
        state: {
          recentlyModifiedFiles: [
            { path: 'a.ts', modifiedAt: NOW - 2 * 60_000 },
            { path: 'b.ts', modifiedAt: NOW - 5 * 60_000 },
          ],
        },
      })],
      { nowMs: NOW },
    );
    expect(out).toContain('Recently modified: a.ts (2 min ago), b.ts (5 min ago)');
    expect(out).not.toContain('+0 more');
  });

  it('truncates to maxRecentFilesPerPeer with a "+N more" suffix', () => {
    const files = Array.from({ length: 7 }, (_, i) => ({
      path: `file_${i}.ts`,
      modifiedAt: NOW - (i + 1) * 1000,
    }));
    const out = buildOtherInstancesPromptBlock(
      [makeInstance({ pid: 100, state: { recentlyModifiedFiles: files } })],
      { nowMs: NOW, maxRecentFilesPerPeer: 2 },
    );
    expect(out).toContain('Recently modified: file_0.ts (1s ago), file_1.ts (2s ago), +5 more');
  });
});

describe('buildOtherInstancesPromptBlock — multiple peers + truncation', () => {
  it('renders all peers when count <= maxRendered (default 5)', () => {
    const peers = [100, 200, 300].map((pid) => makeInstance({ pid }));
    const out = buildOtherInstancesPromptBlock(peers, { nowMs: NOW });
    expect(out).toContain('3 other KodaX sessions running');
    expect(out).toContain('pid 100');
    expect(out).toContain('pid 200');
    expect(out).toContain('pid 300');
    expect(out).not.toContain('more session');
  });

  it('truncates to maxRendered + emits a "+N more sessions omitted" line', () => {
    const peers = [100, 200, 300, 400, 500, 600, 700].map((pid) =>
      makeInstance({ pid }),
    );
    const out = buildOtherInstancesPromptBlock(peers, { nowMs: NOW, maxRendered: 3 });
    expect(out).toContain('pid 100');
    expect(out).toContain('pid 200');
    expect(out).toContain('pid 300');
    expect(out).not.toContain('pid 400');
    expect(out).toContain('+4 more sessions omitted');
  });

  it("uses singular grammar for the truncation tail when N=1", () => {
    const peers = Array.from({ length: 6 }, (_, i) => makeInstance({ pid: 100 + i }));
    const out = buildOtherInstancesPromptBlock(peers, { nowMs: NOW, maxRendered: 5 });
    expect(out).toContain('+1 more session omitted');
    expect(out).not.toContain('+1 more sessions omitted');
  });
});

describe('buildOtherInstancesPromptBlock — currentTodoSummary (FEATURE_170 hook)', () => {
  it('renders inProgress / pending / completed counts when summary is present', () => {
    const out = buildOtherInstancesPromptBlock(
      [makeInstance({
        pid: 100,
        state: {
          currentTodoSummary: {
            inProgress: 'Refactor auth module',
            pendingCount: 3,
            completedCount: 5,
          },
        },
      })],
      { nowMs: NOW },
    );
    expect(out).toContain('Todo: in-progress: "Refactor auth module", 3 pending, 5 completed');
  });

  it('omits the in-progress phrase when no item is in_progress', () => {
    const out = buildOtherInstancesPromptBlock(
      [makeInstance({
        pid: 100,
        state: {
          currentTodoSummary: { pendingCount: 0, completedCount: 4 },
        },
      })],
      { nowMs: NOW },
    );
    expect(out).toContain('Todo: 0 pending, 4 completed');
    expect(out).not.toMatch(/in-progress:/);
  });

  it('omits the Todo line when summary is absent', () => {
    const out = buildOtherInstancesPromptBlock(
      [makeInstance({ pid: 100, state: { currentTodoSummary: undefined } })],
      { nowMs: NOW },
    );
    expect(out).not.toContain('Todo:');
  });
});

describe('buildOtherInstancesPromptBlock — relative time formatting', () => {
  it('renders "just now" for sub-second deltas', () => {
    const out = buildOtherInstancesPromptBlock(
      [makeInstance({
        pid: 100,
        state: { meta: { ...baseMeta, startedAt: NOW - 500 } },
      })],
      { nowMs: NOW },
    );
    expect(out).toMatch(/started just now/);
  });

  it('renders "Ns ago" for sub-minute deltas', () => {
    const out = buildOtherInstancesPromptBlock(
      [makeInstance({
        pid: 100,
        state: { meta: { ...baseMeta, startedAt: NOW - 45_000 } },
      })],
      { nowMs: NOW },
    );
    expect(out).toMatch(/started 45s ago/);
  });

  it('renders "N min ago" for sub-hour deltas', () => {
    const out = buildOtherInstancesPromptBlock(
      [makeInstance({
        pid: 100,
        state: { meta: { ...baseMeta, startedAt: NOW - 5 * 60_000 } },
      })],
      { nowMs: NOW },
    );
    expect(out).toMatch(/started 5 min ago/);
  });

  it('renders "Nh ago" for sub-day deltas', () => {
    const out = buildOtherInstancesPromptBlock(
      [makeInstance({
        pid: 100,
        state: { meta: { ...baseMeta, startedAt: NOW - 3 * 3_600_000 } },
      })],
      { nowMs: NOW },
    );
    expect(out).toMatch(/started 3h ago/);
  });

  it('renders "Nd ago" for >24h deltas', () => {
    const out = buildOtherInstancesPromptBlock(
      [makeInstance({
        pid: 100,
        state: { meta: { ...baseMeta, startedAt: NOW - 2 * 24 * 3_600_000 } },
      })],
      { nowMs: NOW },
    );
    expect(out).toMatch(/started 2d ago/);
  });
});

describe('buildOtherInstancesPromptBlock — branch + cwd display', () => {
  it('appends ", on branch <name>" when gitBranch is present', () => {
    const out = buildOtherInstancesPromptBlock(
      [makeInstance({
        pid: 100,
        state: { meta: { ...baseMeta, gitBranch: 'feature/auth' } },
      })],
      { nowMs: NOW },
    );
    expect(out).toContain(', on branch feature/auth)');
  });

  it('omits the branch clause when gitBranch is undefined', () => {
    const out = buildOtherInstancesPromptBlock(
      [makeInstance({
        pid: 100,
        state: { meta: { ...baseMeta, gitBranch: undefined } },
      })],
      { nowMs: NOW },
    );
    expect(out).not.toContain('on branch');
  });
});
