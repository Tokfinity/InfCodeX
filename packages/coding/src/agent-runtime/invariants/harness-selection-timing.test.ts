/**
 * FEATURE_193 (v0.7.43) — `harnessSelectionTiming` V2 no-op shell tests.
 *
 * V1 (FEATURE_106) predicate was: trigger on
 *   - event.kind === 'mutation_recorded'
 *   - event.fileCount > 1
 *   - ctx.recorder.scout.payload.scout.confirmedHarness missing
 *
 * V2 (FEATURE_193) Scout retirement neutralizes the predicate to a
 * permanent admit. These tests pin the no-op contract so future
 * changes to the file body don't accidentally re-introduce the
 * scout-dependent gate.
 */

import { describe, expect, it } from 'vitest';

import { createAgent } from '@kodax-ai/agent';
import type { ObserveCtx, ReadonlyRecorder } from '@kodax-ai/agent';
import { harnessSelectionTiming } from './harness-selection-timing.js';

const manifest = createAgent({ name: 'scout', instructions: 'classify' });

function obsCtx(recorder: ReadonlyRecorder = {}): ObserveCtx {
  return {
    manifest,
    mutationTracker: { files: new Set(), totalOps: 0 },
    recorder,
  };
}

describe('harnessSelectionTiming.observe — V2 no-op shell', () => {
  it('admits tool_call events', () => {
    expect(
      harnessSelectionTiming.observe!(
        { kind: 'tool_call', toolName: 'read' },
        obsCtx(),
      ).ok,
    ).toBe(true);
  });

  it('admits single-file mutations', () => {
    expect(
      harnessSelectionTiming.observe!(
        { kind: 'mutation_recorded', file: 'a.ts', fileCount: 1 },
        obsCtx(),
      ).ok,
    ).toBe(true);
  });

  it('admits multi-file mutations without confirmedHarness (FEATURE_193 — V1 warn path neutralized)', () => {
    const result = harnessSelectionTiming.observe!(
      { kind: 'mutation_recorded', file: 'b.ts', fileCount: 4 },
      obsCtx(),
    );
    expect(result.ok).toBe(true);
  });

  it('admits when scout block carries an empty confirmedHarness string', () => {
    const recorder: ReadonlyRecorder = {
      scout: { payload: { scout: { confirmedHarness: '' } } },
    };
    expect(
      harnessSelectionTiming.observe!(
        { kind: 'mutation_recorded', file: 'a.ts', fileCount: 2 },
        obsCtx(recorder),
      ).ok,
    ).toBe(true);
  });

  it('admits when confirmedHarness is set (no-op regardless of slot contents)', () => {
    const recorder: ReadonlyRecorder = {
      scout: { payload: { scout: { confirmedHarness: 'H1_EXECUTE_EVAL' } } },
    };
    expect(
      harnessSelectionTiming.observe!(
        { kind: 'mutation_recorded', file: 'a.ts', fileCount: 3 },
        obsCtx(recorder),
      ).ok,
    ).toBe(true);
  });
});
