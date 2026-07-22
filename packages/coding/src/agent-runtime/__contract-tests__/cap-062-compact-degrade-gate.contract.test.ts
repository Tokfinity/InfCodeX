import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KodaXMessage } from '@kodax-ai/llm';

vi.mock('@kodax-ai/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kodax-ai/agent')>();
  return { ...actual, gracefulCompactDegradation: vi.fn() };
});

import { gracefulCompactDegradation as mockedDegrade } from '@kodax-ai/agent';
import type { KodaXEvents } from '../../types.js';
import { applyGracefulDegradationGate } from '../middleware/compaction-orchestration.js';

const degradeMock = mockedDegrade as unknown as ReturnType<typeof vi.fn>;
const messages: KodaXMessage[] = [
  { role: 'user', content: 'complete evidence' },
  { role: 'assistant', content: 'complete response' },
];

beforeEach(() => degradeMock.mockReset());

describe('CAP-062 explicit legacy degradation gate', () => {
  it('does nothing when semantic compaction was not requested', () => {
    const out = applyGracefulDegradationGate({
      compacted: messages,
      needsCompact: false,
      contextWindow: 100_000,
      compactionConfig: { enabled: true, triggerPercent: 100 },
      currentTokens: 90_000,
      reservedResponseTokens: 10_000,
      events: {},
    });
    expect(out).toEqual({ compacted: messages, didCompactMessages: false });
  });

  it('keeps destructive fallback disabled by default even at hard pressure', () => {
    const out = applyGracefulDegradationGate({
      compacted: messages,
      needsCompact: true,
      contextWindow: 100_000,
      compactionConfig: { enabled: true, triggerPercent: 100 },
      currentTokens: 90_000,
      fixedOverheadTokens: 89_000,
      reservedResponseTokens: 10_000,
      events: {},
    });
    expect(out).toEqual({ compacted: messages, didCompactMessages: false });
    expect(degradeMock).not.toHaveBeenCalled();
  });

  it('does not run an explicit fallback while the physical envelope fits', () => {
    const out = applyGracefulDegradationGate({
      compacted: messages,
      needsCompact: true,
      contextWindow: 100_000,
      compactionConfig: {
        enabled: true,
        triggerPercent: 70,
        pruningThresholdTokens: 500,
      },
      currentTokens: 75_000,
      fixedOverheadTokens: 74_000,
      reservedResponseTokens: 10_000,
      events: {},
    });
    expect(out).toEqual({ compacted: messages, didCompactMessages: false });
    expect(degradeMock).not.toHaveBeenCalled();
  });

  it('reports no rewrite when explicit fallback returns the same history', () => {
    degradeMock.mockImplementation((input: KodaXMessage[]) => input);
    const out = applyGracefulDegradationGate({
      compacted: messages,
      needsCompact: true,
      contextWindow: 100_000,
      compactionConfig: {
        enabled: true,
        triggerPercent: 100,
        pruningThresholdTokens: 500,
      },
      currentTokens: 90_000,
      fixedOverheadTokens: 89_000,
      reservedResponseTokens: 10_000,
      events: {},
    });
    expect(degradeMock).toHaveBeenCalledOnce();
    expect(degradeMock).toHaveBeenCalledWith(
      messages,
      100_000,
      expect.objectContaining({ pruningThresholdTokens: 500 }),
      { fixedOverheadTokens: 89_000, reservedResponseTokens: 10_000 },
    );
    expect(out).toEqual({ compacted: messages, didCompactMessages: false });
  });

  it('reports no rewrite for a new array with no token reduction', () => {
    degradeMock.mockReturnValue([...messages]);
    const events: KodaXEvents = { onCompactStats: vi.fn(), onCompact: vi.fn() };
    const out = applyGracefulDegradationGate({
      compacted: messages,
      needsCompact: true,
      contextWindow: 100_000,
      compactionConfig: {
        enabled: true,
        triggerPercent: 100,
        pruningThresholdTokens: 500,
      },
      currentTokens: 90_000,
      fixedOverheadTokens: 89_000,
      reservedResponseTokens: 10_000,
      events,
    });

    expect(out).toEqual({ compacted: messages, didCompactMessages: false });
    expect(events.onCompactStats).not.toHaveBeenCalled();
    expect(events.onCompact).not.toHaveBeenCalled();
  });

  it('does not emit success when fallback still exceeds physical capacity', () => {
    const slightlySmaller = [{ role: 'user' as const, content: 'smaller' }];
    degradeMock.mockReturnValue(slightlySmaller);
    const events: KodaXEvents = { onCompactStats: vi.fn(), onCompact: vi.fn() };
    const out = applyGracefulDegradationGate({
      compacted: messages,
      needsCompact: true,
      contextWindow: 100_000,
      compactionConfig: {
        enabled: true,
        triggerPercent: 100,
        pruningThresholdTokens: 500,
      },
      currentTokens: 95_000,
      fixedOverheadTokens: 91_000,
      reservedResponseTokens: 10_000,
      events,
    });

    expect(out).toEqual({ compacted: messages, didCompactMessages: false });
    expect(events.onCompactStats).not.toHaveBeenCalled();
    expect(events.onCompact).not.toHaveBeenCalled();
  });

  it('emits physical before/after stats when an explicit fallback rewrites', () => {
    const pruned: KodaXMessage[] = [];
    degradeMock.mockReturnValue(pruned);
    const events: KodaXEvents = { onCompactStats: vi.fn(), onCompact: vi.fn() };
    const out = applyGracefulDegradationGate({
      compacted: messages,
      needsCompact: true,
      contextWindow: 100_000,
      compactionConfig: {
        enabled: true,
        triggerPercent: 100,
        pruningThresholdTokens: 500,
      },
      currentTokens: 90_000,
      fixedOverheadTokens: 87_370,
      reservedResponseTokens: 10_000,
      events,
    });
    expect(out).toEqual({ compacted: pruned, didCompactMessages: true });
    expect(events.onCompactStats).toHaveBeenCalledOnce();
    const stats = vi.mocked(events.onCompactStats!).mock.calls[0]?.[0];
    expect(events.onCompact).toHaveBeenCalledWith(stats?.tokensAfter);
  });
});
