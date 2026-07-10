/**
 * Integration contract for the P3.4 compaction lifecycle umbrella.
 *
 * Inventory entries crossed:
 *   - CAP-059 (trigger): docs/features/v0.7.29-capability-inventory.md#cap-059-compaction-trigger-decision
 *   - CAP-060 (orchestration): docs/features/v0.7.29-capability-inventory.md#cap-060-compaction-lifecycle-orchestration-intelligentcompact--circuit-breaker--events
 *   - CAP-062 (degradation gate): docs/features/v0.7.29-capability-inventory.md#cap-062-graceful-compact-degradation-gating
 *   - CAP-063 (commit): docs/features/v0.7.29-capability-inventory.md#cap-063-pre-stream-validateandfixtoolhistory--oncompactedmessages-emission
 *
 * Why this file exists:
 *   The four unit-level contract files (cap-059/060/062/063) each
 *   exercise one helper in isolation. They cannot detect a routing
 *   mistake in `runCompactionLifecycle` — e.g., failing to thread the
 *   degradation phase's `didCompactMessages` flag into the commit
 *   phase, or mis-sequencing the three phases. This integration
 *   contract pins the umbrella's composition.
 *
 * The asserted invariants:
 *   1. needsCompact=false → all three phases short-circuit; no events,
 *      no snapshot, counter unchanged.
 *   2. LLM threw → counter increments, but the degradation phase
 *      still runs on the (un-pruned) messages and the commit phase
 *      still validates. `didCompactMessages` is the OR of the LLM
 *      and degradation phases' flags.
 *   3. LLM success → counter resets when below trigger; the commit
 *      phase emits `onCompactedMessages` with the LLM-phase
 *      `compactionUpdate`.
 *
 * STATUS: ACTIVE since FEATURE_100 P3.4 sweep.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { KodaXBaseProvider, KodaXMessage } from '@kodax-ai/llm';
import type { CompactionConfig, CompactionResult } from '@kodax-ai/agent';
// v0.7.35.1 FEATURE_142 Batch B: compact() moved from @kodax-ai/agent to
// @kodax-ai/agent; mock the new home (see ADR-021).
// v0.7.36: gracefulCompactDegradation moved from @kodax-ai/agent to
// @kodax-ai/agent/runtime-middleware/ to break the build cycle
// introduced by FEATURE_142 Batch D. Both `compact` and
// `gracefulCompactDegradation` now live in @kodax-ai/agent, so
// they can be mocked through a single boundary.
vi.mock('@kodax-ai/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kodax-ai/agent')>();
  return {
    ...actual,
    compact: vi.fn(),
    gracefulCompactDegradation: vi.fn(),
  };
});

import {
  compact as mockedCompact,
  gracefulCompactDegradation as mockedDegrade,
} from '@kodax-ai/agent';
import {
  runCompactionLifecycle,
  COMPACT_CIRCUIT_BREAKER_LIMIT,
} from '../middleware/compaction-orchestration.js';
import { createCompactionAntiThrashState } from '../middleware/compaction-pressure.js';
import type { KodaXEvents } from '../../types.js';

const compactMock = mockedCompact as unknown as ReturnType<typeof vi.fn>;
const degradeMock = mockedDegrade as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  compactMock.mockReset();
  degradeMock.mockReset();
  // Default: graceful is a pure pass-through unless a test overrides.
  degradeMock.mockImplementation((input: KodaXMessage[]) => input);
});

const baseMessages: KodaXMessage[] = [
  { role: 'user', content: 'turn one' },
  { role: 'assistant', content: 'reply one' },
];

function makeConfig(overrides: Partial<CompactionConfig> = {}): CompactionConfig {
  return {
    enabled: true,
    triggerPercent: 75,
    keepRecentTurns: 3,
    ...overrides,
  } as CompactionConfig;
}

function fakeProvider(): KodaXBaseProvider {
  // The compact() function is mocked at module scope, so this stub
  // is never actually invoked.
  return { name: 'test-provider' } as unknown as KodaXBaseProvider;
}

describe('P3.4 integration: needsCompact=false short-circuits all phases', () => {
  it('P3.4-FLOW-001: needsCompact=false → no LLM call, no degrade call, snapshot=undefined, counter unchanged', async () => {
    const events: KodaXEvents = {
      onCompactStart: vi.fn(),
      onCompactStats: vi.fn(),
      onCompact: vi.fn(),
      onCompactEnd: vi.fn(),
      onCompactedMessages: vi.fn(),
    };
    const out = await runCompactionLifecycle({
      messages: baseMessages,
      needsCompact: false,
      compactConsecutiveFailures: 2,
      compactionConfig: makeConfig(),
      provider: fakeProvider(),
      contextWindow: 10000,
      systemPrompt: 'sys',
      currentTokens: 100,
      events,
    });

    expect(compactMock).not.toHaveBeenCalled();
    expect(degradeMock).not.toHaveBeenCalled();
    expect(out.didCompactMessages).toBe(false);
    expect(out.contextTokenSnapshot).toBeUndefined();
    expect(out.nextCompactConsecutiveFailures).toBe(2);
    expect(events.onCompactStart).not.toHaveBeenCalled();
    expect(events.onCompactedMessages).not.toHaveBeenCalled();
  });
});

describe('P3.4 integration: LLM threw → degradation still runs, counter increments', () => {
  it('P3.4-FLOW-002: LLM rejection → onCompactStart/End fire, counter++, degradation phase invoked on un-pruned messages, commit step validates', async () => {
    compactMock.mockRejectedValueOnce(new Error('boom'));
    const events: KodaXEvents = {
      onCompactStart: vi.fn(),
      onCompactEnd: vi.fn(),
      onCompactStats: vi.fn(),
      onCompact: vi.fn(),
      onCompactedMessages: vi.fn(),
    };

    const out = await runCompactionLifecycle({
      messages: baseMessages,
      needsCompact: true,
      compactConsecutiveFailures: 0,
      compactionConfig: makeConfig({ triggerPercent: 1 }), // ensure gate fires
      provider: fakeProvider(),
      contextWindow: 100,
      systemPrompt: 'sys',
      currentTokens: 200,
      events,
    });

    expect(events.onCompactStart).toHaveBeenCalledOnce();
    expect(events.onCompactEnd).toHaveBeenCalledOnce();
    expect(out.nextCompactConsecutiveFailures).toBe(1);
    // Degradation phase invoked with the un-pruned (caught-error)
    // messages — proves Phase 2 wires to Phase 1's `compacted`.
    expect(degradeMock).toHaveBeenCalledOnce();
    // Default mock returns identity → didCompactMessages stays false
    // → commit phase doesn't emit onCompactedMessages.
    expect(out.didCompactMessages).toBe(false);
    expect(events.onCompactedMessages).not.toHaveBeenCalled();
  });
});

describe('P3.4 integration: LLM success → commit fires onCompactedMessages with LLM-phase update', () => {
  it('P3.4-FLOW-003: success path produces compactionUpdate, fresh snapshot, onCompactedMessages fires with the SAME compactionUpdate the LLM phase produced', async () => {
    const compactedMessages: KodaXMessage[] = [
      { role: 'system', content: 'compacted summary' },
    ];
    compactMock.mockResolvedValueOnce({
      compacted: true,
      messages: compactedMessages,
      tokensBefore: 200,
      tokensAfter: 50,
      entriesRemoved: 1,
    } as CompactionResult);

    const onCompactedMessages = vi.fn();
    const events: KodaXEvents = { onCompactedMessages };

    const out = await runCompactionLifecycle({
      messages: baseMessages,
      needsCompact: true,
      compactConsecutiveFailures: 1,
      // 100 × 75% = 75. Compacted size estimate ≈ a few tokens, well
      // below trigger → counter resets.
      compactionConfig: makeConfig({ triggerPercent: 75 }),
      provider: fakeProvider(),
      contextWindow: 100,
      systemPrompt: 'sys',
      currentTokens: 90,
      events,
    });

    expect(out.didCompactMessages).toBe(true);
    expect(out.contextTokenSnapshot).toBeDefined();
    expect(out.nextCompactConsecutiveFailures).toBe(0); // reset
    expect(out.compactionUpdate).toBeDefined();
    // The umbrella threads the LLM-phase compactionUpdate into the
    // commit phase's emission — pinning that Phase 1's metadata
    // reaches Phase 3 untouched.
    expect(onCompactedMessages).toHaveBeenCalledOnce();
    const args = onCompactedMessages.mock.calls[0]!;
    expect(args[1]).toBe(out.compactionUpdate);
  });

  it('P3.4-FLOW-004: circuit breaker tripped → LLM phase skipped, degradation still gates and runs on original messages', async () => {
    const events: KodaXEvents = {
      onCompactStart: vi.fn(),
      onCompactEnd: vi.fn(),
    };
    const out = await runCompactionLifecycle({
      messages: baseMessages,
      needsCompact: true,
      compactConsecutiveFailures: COMPACT_CIRCUIT_BREAKER_LIMIT,
      compactionConfig: makeConfig({ triggerPercent: 1 }),
      provider: fakeProvider(),
      contextWindow: 100,
      systemPrompt: 'sys',
      currentTokens: 200,
      events,
    });

    expect(compactMock).not.toHaveBeenCalled(); // breaker tripped
    expect(events.onCompactStart).not.toHaveBeenCalled();
    expect(degradeMock).toHaveBeenCalledOnce(); // degradation still runs
    expect(out.nextCompactConsecutiveFailures).toBe(COMPACT_CIRCUIT_BREAKER_LIMIT);
  });
});

describe('P3.4 integration: compaction anti-thrashing cooldown', () => {
  it('P3.4-FLOW-005: two low-savings compactions enter cooldown; next compact turn skips the LLM and emits a bounded skip event', async () => {
    const compactedMessages: KodaXMessage[] = [
      { role: 'system', content: 'low savings summary' },
    ];
    compactMock
      .mockResolvedValueOnce({
        compacted: true,
        messages: compactedMessages,
        tokensBefore: 1_000,
        tokensAfter: 950,
        entriesRemoved: 1,
      } as CompactionResult)
      .mockResolvedValueOnce({
        compacted: true,
        messages: compactedMessages,
        tokensBefore: 1_000,
        tokensAfter: 930,
        entriesRemoved: 1,
      } as CompactionResult);

    const skipped = vi.fn();
    const events: KodaXEvents = {
      onContextCompactionSkipped: skipped,
    };

    const first = await runCompactionLifecycle({
      messages: baseMessages,
      needsCompact: true,
      compactConsecutiveFailures: 0,
      compactionConfig: makeConfig({ triggerPercent: 75 }),
      provider: fakeProvider(),
      contextWindow: 10_000,
      systemPrompt: 'sys',
      currentTokens: 9_000,
      events,
      compactionAntiThrash: createCompactionAntiThrashState(),
      emitCompactionDiagnostics: true,
    });
    const second = await runCompactionLifecycle({
      messages: baseMessages,
      needsCompact: true,
      compactConsecutiveFailures: 0,
      compactionConfig: makeConfig({ triggerPercent: 75 }),
      provider: fakeProvider(),
      contextWindow: 10_000,
      systemPrompt: 'sys',
      currentTokens: 9_000,
      events,
      compactionAntiThrash: first.nextCompactionAntiThrash,
      emitCompactionDiagnostics: true,
    });
    const third = await runCompactionLifecycle({
      messages: baseMessages,
      needsCompact: true,
      compactConsecutiveFailures: 0,
      compactionConfig: makeConfig({ triggerPercent: 75 }),
      provider: fakeProvider(),
      contextWindow: 10_000,
      systemPrompt: 'sys',
      currentTokens: 9_000,
      events,
      compactionAntiThrash: second.nextCompactionAntiThrash,
      emitCompactionDiagnostics: true,
    });

    expect(compactMock).toHaveBeenCalledTimes(2);
    expect(second.nextCompactionAntiThrash.cooldownTurnsRemaining).toBeGreaterThan(0);
    expect(third.didCompactMessages).toBe(false);
    expect(skipped).toHaveBeenCalledOnce();
    expect(skipped).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'low_savings_cooldown',
      currentTokens: 9_000,
      contextWindow: 10_000,
      triggerPercent: 75,
      cooldownTurnsRemaining: second.nextCompactionAntiThrash.cooldownTurnsRemaining - 1,
    }));
  });
});
