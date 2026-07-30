/**
 * Contract test for CAP-021: Extension `turn:complete` → agent-layer
 * `RunOptions.stopHook` bridge (FEATURE_184 Phase B).
 *
 * Inventory:
 * - FEATURE_184 ADR-030 at docs/ADR.md
 * - v0.7.45.md §FEATURE_184 Phase B
 *
 * Test obligations:
 * - CAP-EXT-STOP-001: bridge returns undefined when no extension is registered
 *   → agent runs the terminal path unchanged (byte-identical to v0.7.42)
 * - CAP-EXT-STOP-002: extension `turn:complete` returning `string` flows
 *   through the bridge as a StopHookResult string (reanimate signal)
 * - CAP-EXT-STOP-003: extension `turn:complete` returning `{abort, reason}`
 *   flows through the bridge as a StopHookResult abort
 * - CAP-EXT-STOP-004: extension `turn:complete` returning `void` defers
 *   (bridge surfaces undefined to caller, which means "accept")
 * - CAP-EXT-STOP-005: multiple extensions registered → first non-void
 *   return short-circuits (matches `runActiveExtensionHook` semantics)
 * - CAP-EXT-STOP-006: extension throw is caught by the runtime (fail-open),
 *   bridge surfaces undefined → run continues normally
 * - CAP-EXT-STOP-007: sessionId getter is called lazily — bridge reads
 *   the current value on every hook invocation, not once at construction
 *
 * Risk: HIGH — wires extension API to the core Runner loop. A defect
 * here can either (a) silently swallow extension verdicts (HIGH user
 * impact: verification gate becomes a no-op) or (b) crash production
 * runs when no extension is registered (CRITICAL: zero-extension is the
 * default for ~all users).
 *
 * Class: 1 — substrate bridge. Active here:
 * - `createExtensionTurnCompleteStopHook` factory returning a StopHookFn
 * - Bridge passes through the three-state result (void / string / abort)
 * - Bridge passes sessionId, lastAssistantText, signal, reanimateCount,
 *   reanimateBudget context fields to the extension
 *
 * STATUS: ACTIVE since FEATURE_184 Phase B (v0.7.45).
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import {
  setKodaXDiagnosticSink,
  type KodaXDiagnostic,
  type StopHookContext,
} from '@kodax-ai/agent';

import {
  KodaXExtensionRuntime,
  setActiveExtensionRuntime,
} from '../../extensions/runtime.js';
import { createExtensionTurnCompleteStopHook } from '../middleware/extension-queue.js';

const baseCtx: StopHookContext = {
  transcript: [],
  lastAssistantText: 'final text',
  signal: 'natural-end',
  reanimateCount: 0,
  reanimateBudget: 2,
};

describe('CAP-021: createExtensionTurnCompleteStopHook — Stop Hook bridge', () => {
  let runtime: KodaXExtensionRuntime;

  beforeEach(() => {
    runtime = new KodaXExtensionRuntime();
    setActiveExtensionRuntime(runtime);
  });

  afterEach(async () => {
    setActiveExtensionRuntime(null);
    await runtime.dispose();
  });

  it('CAP-EXT-STOP-001: no extension registered → bridge returns undefined (accept)', async () => {
    const hook = createExtensionTurnCompleteStopHook(() => 'session-1');
    const result = await hook(baseCtx);
    expect(result).toBeUndefined();
  });

  it('CAP-EXT-STOP-002: extension returning string surfaces as reanimate signal', async () => {
    runtime.registerHook('turn:complete', () => 'please fix X');

    const hook = createExtensionTurnCompleteStopHook(() => 'session-2');
    const result = await hook(baseCtx);

    expect(result).toBe('please fix X');
  });

  it('CAP-EXT-STOP-003: extension returning {abort, reason} surfaces as abort', async () => {
    runtime.registerHook('turn:complete', () => ({
      abort: true as const,
      reason: 'verifier rejected',
    }));

    const hook = createExtensionTurnCompleteStopHook(() => 'session-3');
    const result = await hook(baseCtx);

    expect(result).toEqual({ abort: true, reason: 'verifier rejected' });
  });

  it('CAP-EXT-STOP-004: extension returning void defers (bridge surfaces undefined)', async () => {
    let fired = false;
    runtime.registerHook('turn:complete', () => {
      fired = true;
      // explicit no return
    });

    const hook = createExtensionTurnCompleteStopHook(() => 'session-4');
    const result = await hook(baseCtx);

    expect(fired).toBe(true);
    expect(result).toBeUndefined();
  });

  it('CAP-EXT-STOP-005: multiple extensions → first non-void return short-circuits', async () => {
    const fired: string[] = [];
    runtime.registerHook('turn:complete', () => {
      fired.push('first-void');
      // void → defer
    });
    runtime.registerHook('turn:complete', () => {
      fired.push('second-string');
      return 'short-circuit here';
    });
    runtime.registerHook('turn:complete', () => {
      fired.push('third-should-not-fire');
      return { abort: true as const, reason: 'never reached' };
    });

    const hook = createExtensionTurnCompleteStopHook(() => 'session-5');
    const result = await hook(baseCtx);

    expect(result).toBe('short-circuit here');
    // First two fired, third short-circuited.
    expect(fired).toEqual(['first-void', 'second-string']);
  });

  it('CAP-EXT-STOP-006: extension throw is caught (fail-open) → bridge surfaces undefined', async () => {
    runtime.registerHook('turn:complete', () => {
      throw new Error('extension bug');
    });

    const hook = createExtensionTurnCompleteStopHook(() => 'session-6');
    const result = await hook(baseCtx);

    // Runtime swallows the throw and continues to next handler.
    // With no fallback handler, the chain returns undefined.
    expect(result).toBeUndefined();
  });

  it('CAP-EXT-STOP-006b: extension throw then fallback handler → fallback fires', async () => {
    runtime.registerHook('turn:complete', () => {
      throw new Error('first crashes');
    });
    runtime.registerHook('turn:complete', () => 'fallback ran');

    const hook = createExtensionTurnCompleteStopHook(() => 'session-6b');
    const result = await hook(baseCtx);

    expect(result).toBe('fallback ran');
  });

  it('CAP-EXT-STOP-007: sessionId getter is called lazily on every invocation', async () => {
    let currentId = 'initial';
    let lastSeenId: string | undefined;
    runtime.registerHook('turn:complete', (ctx) => {
      lastSeenId = ctx.sessionId;
    });

    const hook = createExtensionTurnCompleteStopHook(() => currentId);

    await hook(baseCtx);
    expect(lastSeenId).toBe('initial');

    currentId = 'updated';
    await hook(baseCtx);
    expect(lastSeenId).toBe('updated');
  });

  it('CAP-EXT-STOP-008: passes lastAssistantText / signal / reanimate counters through', async () => {
    let captured: { sessionId?: string; text?: string; sig?: string; n?: number; b?: number } = {};
    runtime.registerHook('turn:complete', (ctx) => {
      captured = {
        sessionId: ctx.sessionId,
        text: ctx.lastAssistantText,
        sig: ctx.signal,
        n: ctx.reanimateCount,
        b: ctx.reanimateBudget,
      };
    });

    const hook = createExtensionTurnCompleteStopHook(() => 'session-8');
    await hook({
      transcript: [],
      lastAssistantText: 'specific text',
      signal: 'natural-end',
      reanimateCount: 1,
      reanimateBudget: 3,
    });

    expect(captured).toEqual({
      sessionId: 'session-8',
      text: 'specific text',
      sig: 'natural-end',
      n: 1,
      b: 3,
    });
  });

  it('CAP-EXT-STOP-009: getter returning undefined skips extension dispatch entirely (fail-open)', async () => {
    // Reviewer-flagged guard: passing empty string would silently route
    // extension state lookups to the wrong bucket. Bridge defers
    // silently (returns undefined) when sessionId is absent — handler
    // should NOT fire at all.
    let fired = false;
    runtime.registerHook('turn:complete', () => {
      fired = true;
    });

    const hook = createExtensionTurnCompleteStopHook(() => undefined);
    const result = await hook(baseCtx);

    expect(fired).toBe(false);
    expect(result).toBeUndefined();
  });

  it('CAP-EXT-STOP-009b: getter returning empty string also skips extension dispatch (fail-open)', async () => {
    // Empty string is treated the same as undefined — both are "no
    // session" signals. The guard uses falsiness (`!sessionId`).
    let fired = false;
    runtime.registerHook('turn:complete', () => {
      fired = true;
    });

    const hook = createExtensionTurnCompleteStopHook(() => '');
    const result = await hook(baseCtx);

    expect(fired).toBe(false);
    expect(result).toBeUndefined();
  });

  it('CAP-EXT-STOP-010: async handler returning string awaited correctly', async () => {
    runtime.registerHook('turn:complete', async () => {
      await new Promise((r) => setTimeout(r, 1));
      return 'async-reanimate';
    });

    const hook = createExtensionTurnCompleteStopHook(() => 'session-10');
    const result = await hook(baseCtx);

    expect(result).toBe('async-reanimate');
  });

  it('CAP-EXT-STOP-010b: async handler returning {abort, reason} awaited correctly', async () => {
    runtime.registerHook('turn:complete', async () => {
      await new Promise((r) => setTimeout(r, 1));
      return { abort: true as const, reason: 'async-halt' };
    });

    const hook = createExtensionTurnCompleteStopHook(() => 'session-10b');
    const result = await hook(baseCtx);

    expect(result).toEqual({ abort: true, reason: 'async-halt' });
  });

  it('CAP-EXT-STOP-011: a hung extension cannot hold finalization open forever', async () => {
    vi.useFakeTimers();
    const diagnostics: KodaXDiagnostic[] = [];
    const restoreDiagnostics = setKodaXDiagnosticSink((diagnostic) => {
      diagnostics.push(diagnostic);
    });
    runtime.registerHook('turn:complete', () => new Promise(() => undefined));

    try {
      const resultPromise = createExtensionTurnCompleteStopHook(
        () => 'session-timeout',
      )(baseCtx);
      await vi.advanceTimersByTimeAsync(30_000);

      await expect(resultPromise).resolves.toBeUndefined();
      expect(diagnostics).toContainEqual(expect.objectContaining({
        source: 'coding:extension-turn-complete',
        level: 'warn',
        detail: expect.objectContaining({
          sessionId: 'session-timeout',
          timeoutMs: 30_000,
        }),
      }));
    } finally {
      restoreDiagnostics();
      vi.useRealTimers();
    }
  });
});
