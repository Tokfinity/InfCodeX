import { describe, it, expect } from 'vitest';
import { buildCreatedGoal } from './state.js';
import { verifyGoalCompletion, type GoalCompletionVerifier } from './sidecar-bind.js';
import type {
  SidecarVerifierVerdict,
} from '../agent-runtime/middleware/sidecar-verifier/verifier.js';

function makeProviderInvocation() {
  return {
    provider: {} as unknown as Parameters<GoalCompletionVerifier>[0]['provider'],
    model: 'fake-model',
    timeoutMs: 1000,
  };
}

describe('verifyGoalCompletion', () => {
  it('returns ok:true on accept verdict', async () => {
    const goal = buildCreatedGoal('x', null);
    let captured: unknown;
    const invokeVerifier: GoalCompletionVerifier = async (opts) => {
      captured = opts.inputs;
      const v: SidecarVerifierVerdict = {
        verdict: 'accept',
        reason: '',
        trace: 'verifier_ok',
      };
      return v;
    };
    const r = await verifyGoalCompletion({
      goal,
      recentTranscript: [],
      lastAssistantText: 'done',
      currentTurnUserQueries: ['original user query'],
      fileEditSummary: [],
      invokeVerifier,
      providerInvocation: makeProviderInvocation(),
    });
    expect(r.ok).toBe(true);
    expect((captured as { currentTurnUserQueries: string[] }).currentTurnUserQueries[0]).toMatch(
      /Pursue this goal until complete: x/,
    );
    expect((captured as { currentTurnUserQueries: string[] }).currentTurnUserQueries[1]).toBe(
      'original user query',
    );
  });

  it('returns ok:false with reason on revise verdict', async () => {
    const goal = buildCreatedGoal('x', null);
    const invokeVerifier: GoalCompletionVerifier = async () => ({
      verdict: 'revise',
      reason: 'Tests still failing',
      suggestedFix: 'Run npm test',
      trace: 'verifier_ok',
    });
    const r = await verifyGoalCompletion({
      goal,
      recentTranscript: [],
      lastAssistantText: 'done',
      currentTurnUserQueries: [],
      fileEditSummary: [],
      invokeVerifier,
      providerInvocation: makeProviderInvocation(),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('Tests still failing');
    expect(r.suggestedFix).toBe('Run npm test');
  });

  it('returns ok:false on blocked verdict', async () => {
    const goal = buildCreatedGoal('x', null);
    const invokeVerifier: GoalCompletionVerifier = async () => ({
      verdict: 'blocked',
      reason: 'External signal needed',
      trace: 'verifier_ok',
    });
    const r = await verifyGoalCompletion({
      goal,
      recentTranscript: [],
      lastAssistantText: 'done',
      currentTurnUserQueries: [],
      fileEditSummary: [],
      invokeVerifier,
      providerInvocation: makeProviderInvocation(),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('External signal needed');
  });

  it('synthesizes a reason when verdict has no reason text', async () => {
    const goal = buildCreatedGoal('x', null);
    const invokeVerifier: GoalCompletionVerifier = async () => ({
      verdict: 'revise',
      reason: '',
      trace: 'missing_reason',
    });
    const r = await verifyGoalCompletion({
      goal,
      recentTranscript: [],
      lastAssistantText: '',
      currentTurnUserQueries: [],
      fileEditSummary: [],
      invokeVerifier,
      providerInvocation: makeProviderInvocation(),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/verifier returned revise/);
    expect(r.reason).toMatch(/trace: missing_reason/);
  });
});
