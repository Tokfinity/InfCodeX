/**
 * Unit tests for `recordMutationForTool` — the mutation-tracker feeder that
 * drives the Sidecar Verifier work-scale gate. Regression coverage for the
 * P0 fixes:
 *   - `multi_edit` (registry `mutates-fs`) is now tracked (was silently
 *     omitted by the old hand-written set → gate skipped verification).
 *   - line estimation uses TOUCHED lines (max), so an equal-length rewrite
 *     is not collapsed to 1 line (which let large rewrites slip the gate).
 */
import { describe, expect, it } from 'vitest';

import { recordMutationForTool } from './tool-wrappers.js';
import type { ManagedMutationTracker } from '../../../types.js';

function tracker(): ManagedMutationTracker {
  return { files: new Map<string, number>(), totalOps: 0, riskyShellOps: 0 };
}

const lines = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n');

describe('recordMutationForTool — file mutation tracking', () => {
  it('tracks multi_edit (the bug: was omitted by the old hand-written set)', () => {
    const t = tracker();
    recordMutationForTool(t, 'multi_edit', {
      path: '/repo/foo.ts',
      edits: [
        { old_string: lines(3), new_string: lines(5) },
        { old_string: lines(2), new_string: lines(2) },
      ],
    });
    expect(t.totalOps).toBe(1);
    expect(t.files.get('/repo/foo.ts')).toBe(5 + 2); // sum of max(old,new) per edit
  });

  it('tracks write via content line count', () => {
    const t = tracker();
    recordMutationForTool(t, 'write', { path: '/repo/new.ts', content: lines(12) });
    expect(t.totalOps).toBe(1);
    expect(t.files.get('/repo/new.ts')).toBe(12);
  });

  it('counts an equal-length edit rewrite as TOUCHED lines, not 1 (touched, not delta)', () => {
    const t = tracker();
    // 80-line region rewritten into a different 80-line region.
    recordMutationForTool(t, 'edit', {
      path: '/repo/big.ts',
      old_string: lines(80),
      new_string: lines(80),
    });
    expect(t.files.get('/repo/big.ts')).toBe(80); // NOT abs(80-80)=0 -> 1
  });

  it('tracks edit via max(old,new) lines', () => {
    const t = tracker();
    recordMutationForTool(t, 'edit', { file_path: '/repo/a.ts', old_string: lines(2), new_string: lines(9) });
    expect(t.files.get('/repo/a.ts')).toBe(9);
  });

  it('accumulates across multiple edits to the same file', () => {
    const t = tracker();
    recordMutationForTool(t, 'edit', { path: '/repo/a.ts', old_string: lines(1), new_string: lines(4) });
    recordMutationForTool(t, 'edit', { path: '/repo/a.ts', old_string: lines(1), new_string: lines(6) });
    expect(t.files.get('/repo/a.ts')).toBe(10);
    expect(t.totalOps).toBe(2);
  });

  it('records a risky bash mutation as totalOps + riskyShellOps', () => {
    const t = tracker();
    recordMutationForTool(t, 'bash', { command: 'git push origin main' });
    expect(t.totalOps).toBe(1);
    expect(t.riskyShellOps).toBe(1);
    expect(t.files.size).toBe(0);
  });

  it('ignores read-only tools (no mutation recorded)', () => {
    const t = tracker();
    recordMutationForTool(t, 'grep', { pattern: 'foo' });
    recordMutationForTool(t, 'read', { path: '/repo/a.ts' });
    recordMutationForTool(t, 'bash', { command: 'ls -la' });
    expect(t.totalOps).toBe(0);
    expect(t.files.size).toBe(0);
    expect(t.riskyShellOps).toBe(0);
  });

  it('is a no-op when the tracker is undefined', () => {
    expect(() => recordMutationForTool(undefined, 'write', { path: '/x', content: 'y' })).not.toThrow();
  });
});
