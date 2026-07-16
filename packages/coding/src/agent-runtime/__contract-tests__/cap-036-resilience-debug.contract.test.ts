/**
 * Contract test for CAP-036: resilience debug telemetry
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-036-resilience-debug-telemetry
 *
 * Test obligations:
 * - CAP-RESILIENCE-DEBUG-001: env gated (only emits when KODAX_DEBUG_RESILIENCE
 *   or KODAX_DEBUG_STREAM is set)
 *
 * Risk: LOW
 *
 * Class: 1
 *
 * Verified location: agent-runtime/resilience-debug.ts (extracted from
 * agent.ts:886-895 — pre-FEATURE_100 baseline — during FEATURE_100 P2)
 *
 * Time-ordering constraint: at retry decision points.
 *
 * STATUS: ACTIVE since FEATURE_100 P2.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  setKodaXDiagnosticSink,
  type KodaXDiagnostic,
} from '@kodax-ai/agent';

import { emitResilienceDebug, shouldDebugResilience } from '../resilience-debug.js';

describe('CAP-036: resilience debug telemetry contract', () => {
  const originalStream = process.env.KODAX_DEBUG_STREAM;
  const originalResilience = process.env.KODAX_DEBUG_RESILIENCE;

  beforeEach(() => {
    delete process.env.KODAX_DEBUG_STREAM;
    delete process.env.KODAX_DEBUG_RESILIENCE;
  });

  afterEach(() => {
    if (originalStream === undefined) {
      delete process.env.KODAX_DEBUG_STREAM;
    } else {
      process.env.KODAX_DEBUG_STREAM = originalStream;
    }
    if (originalResilience === undefined) {
      delete process.env.KODAX_DEBUG_RESILIENCE;
    } else {
      process.env.KODAX_DEBUG_RESILIENCE = originalResilience;
    }
    vi.restoreAllMocks();
  });

  it('CAP-RESILIENCE-DEBUG-001a: emits nothing to stderr when neither env var is set', () => {
    const diagnostics: KodaXDiagnostic[] = [];
    const restoreDiagnostics = setKodaXDiagnosticSink((diagnostic) => diagnostics.push(diagnostic));
    emitResilienceDebug('[resilience:request]', { foo: 1 });
    expect(diagnostics).toHaveLength(0);
    expect(shouldDebugResilience()).toBe(false);
    restoreDiagnostics();
  });

  it('CAP-RESILIENCE-DEBUG-001b: emits structured payload when KODAX_DEBUG_RESILIENCE=1', () => {
    process.env.KODAX_DEBUG_RESILIENCE = '1';
    const diagnostics: KodaXDiagnostic[] = [];
    const restoreDiagnostics = setKodaXDiagnosticSink((diagnostic) => diagnostics.push(diagnostic));
    emitResilienceDebug('[resilience:request]', { provider: 'deepseek', bytes: 1234 });
    expect(diagnostics).toEqual([
      expect.objectContaining({
        source: 'coding:resilience',
        level: 'debug',
        message: '[resilience:request]',
        detail: { provider: 'deepseek', bytes: 1234 },
      }),
    ]);
    expect(shouldDebugResilience()).toBe(true);
    restoreDiagnostics();
  });

  it('CAP-RESILIENCE-DEBUG-001c: KODAX_DEBUG_STREAM=1 also enables resilience telemetry (broader debug umbrella)', () => {
    process.env.KODAX_DEBUG_STREAM = '1';
    const diagnostics: KodaXDiagnostic[] = [];
    const restoreDiagnostics = setKodaXDiagnosticSink((diagnostic) => diagnostics.push(diagnostic));
    emitResilienceDebug('[resilience:fallback]', { reason: 'overflow' });
    expect(diagnostics).toEqual([
      expect.objectContaining({
        source: 'coding:resilience',
        level: 'debug',
        message: '[resilience:fallback]',
        detail: { reason: 'overflow' },
      }),
    ]);
    expect(shouldDebugResilience()).toBe(true);
    restoreDiagnostics();
  });

  it('CAP-RESILIENCE-DEBUG-001d: env values other than "1" are NOT considered enabled (strict equality)', () => {
    process.env.KODAX_DEBUG_RESILIENCE = 'true';
    const diagnostics: KodaXDiagnostic[] = [];
    const restoreDiagnostics = setKodaXDiagnosticSink((diagnostic) => diagnostics.push(diagnostic));
    emitResilienceDebug('[resilience:request]', {});
    expect(diagnostics).toHaveLength(0);
    expect(shouldDebugResilience()).toBe(false);
    restoreDiagnostics();
  });
});
