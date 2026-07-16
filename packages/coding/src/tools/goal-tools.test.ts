import { describe, it, expect, vi } from 'vitest';
import type { KodaXGoalState } from '@kodax-ai/agent';
import { buildCreatedGoal } from '../goal/state.js';
import type { GoalToolsContext } from '../goal/tools-context.js';
import type { KodaXToolExecutionContext } from '../types.js';
import { toolCreateGoal, toolGetGoal, toolUpdateGoal } from './goal-tools.js';

function makeGoalCtx(
  overrides: Partial<GoalToolsContext> = {},
): GoalToolsContext {
  return {
    readGoal: overrides.readGoal ?? (async () => null),
    createGoal: overrides.createGoal ?? (async () => {
      throw new Error('createGoal not stubbed');
    }),
    requestComplete:
      overrides.requestComplete ?? (async () => ({ ok: true })),
    requestBlocked:
      overrides.requestBlocked ??
      (async () => ({
        ok: true,
        statusMessage: 'blocked OK',
        counter: { current: 3, required: 3 },
      })),
  };
}

function makeExecCtx(
  goalContext?: GoalToolsContext,
): KodaXToolExecutionContext {
  return { backups: new Map(), goalContext } as unknown as KodaXToolExecutionContext;
}

describe('toolGetGoal', () => {
  it('returns "no goal" message when no goal is set', async () => {
    const ctx = makeExecCtx(makeGoalCtx());
    const r = await toolGetGoal({}, ctx);
    expect(r).toMatch(/No goal set/);
  });

  it('renders status + objective + tokens + budget remaining', async () => {
    const base = buildCreatedGoal('finish refactor', 1000, 1_700_000_000_000);
    const goal: KodaXGoalState = { ...base, tokensUsed: 400, timeUsedSeconds: 12 };
    const ctx = makeExecCtx(makeGoalCtx({ readGoal: async () => goal }));
    const r = await toolGetGoal({}, ctx);
    expect(r).toMatch(/Goal: finish refactor/);
    expect(r).toMatch(/Status: active/);
    expect(r).toMatch(/Tokens used: 400/);
    expect(r).toMatch(/Token budget: 1000 \(remaining: 600\)/);
    expect(r).toMatch(/Elapsed: 12s/);
  });

  it('omits remaining when no budget set', async () => {
    const goal = buildCreatedGoal('x', null, 1_700_000_000_000);
    const ctx = makeExecCtx(makeGoalCtx({ readGoal: async () => goal }));
    const r = await toolGetGoal({}, ctx);
    expect(r).toMatch(/Token budget: none/);
    expect(r).not.toMatch(/remaining/);
  });

  it('shows blocker when status=blocked', async () => {
    const base = buildCreatedGoal('x', null);
    const goal: KodaXGoalState = {
      ...base,
      status: 'blocked',
      lastBlockerKind: 'awaiting-user',
      blockerTurnCount: 3,
    };
    const ctx = makeExecCtx(makeGoalCtx({ readGoal: async () => goal }));
    const r = await toolGetGoal({}, ctx);
    expect(r).toMatch(/Blocker: awaiting-user/);
  });

  it('falls back to disabled-context message when goalContext is undefined', async () => {
    const ctx = makeExecCtx(undefined);
    const r = await toolGetGoal({}, ctx);
    // Disabled context returns null from readGoal → falls into NO_GOAL_MESSAGE
    expect(r).toMatch(/No goal set/);
  });
});

describe('toolCreateGoal', () => {
  it('rejects missing objective', async () => {
    const ctx = makeExecCtx(makeGoalCtx());
    const r = await toolCreateGoal({}, ctx);
    expect(r).toMatch(/\[Tool Error\]/);
    expect(r).toMatch(/objective/);
  });

  it('rejects empty/whitespace objective', async () => {
    const ctx = makeExecCtx(makeGoalCtx());
    const r = await toolCreateGoal({ objective: '   ' }, ctx);
    expect(r).toMatch(/\[Tool Error\]/);
  });

  it('rejects non-positive token_budget', async () => {
    const ctx = makeExecCtx(makeGoalCtx());
    expect(await toolCreateGoal({ objective: 'x', token_budget: 0 }, ctx)).toMatch(
      /token_budget must be a positive integer/,
    );
    expect(await toolCreateGoal({ objective: 'x', token_budget: -1 }, ctx)).toMatch(
      /token_budget must be a positive integer/,
    );
  });

  it('creates goal with budget and returns success message', async () => {
    const createGoal = vi.fn(async () => buildCreatedGoal('refactor', 50_000));
    const ctx = makeExecCtx(makeGoalCtx({ createGoal }));
    const r = await toolCreateGoal(
      { objective: 'refactor', token_budget: 50_000 },
      ctx,
    );
    expect(r).toMatch(/Goal created: "refactor"/);
    expect(r).toMatch(/budget: 50000 tokens/);
    expect(createGoal).toHaveBeenCalledWith({ objective: 'refactor', tokenBudget: 50_000 });
  });

  it('creates goal without budget when token_budget omitted', async () => {
    const createGoal = vi.fn(async () => buildCreatedGoal('x', null));
    const ctx = makeExecCtx(makeGoalCtx({ createGoal }));
    const r = await toolCreateGoal({ objective: 'x' }, ctx);
    expect(r).toMatch(/Goal created/);
    expect(r).not.toMatch(/budget/);
  });

  it('returns Tool Error when createGoal throws', async () => {
    const createGoal = vi.fn(async () => {
      throw new Error('Goal already exists; use update_goal');
    });
    const ctx = makeExecCtx(makeGoalCtx({ createGoal }));
    const r = await toolCreateGoal({ objective: 'x' }, ctx);
    expect(r).toMatch(/\[Tool Error\]/);
    expect(r).toMatch(/already exists/);
  });
});

describe('toolUpdateGoal', () => {
  it('rejects missing / invalid status', async () => {
    const ctx = makeExecCtx(makeGoalCtx({ readGoal: async () => buildCreatedGoal('x', null) }));
    expect(await toolUpdateGoal({}, ctx)).toMatch(/status must be exactly "complete" or "blocked"/);
    expect(await toolUpdateGoal({ status: 'paused' }, ctx)).toMatch(
      /status must be exactly "complete" or "blocked"/,
    );
  });

  it('rejects when no goal exists', async () => {
    const ctx = makeExecCtx(makeGoalCtx({ readGoal: async () => null }));
    const r = await toolUpdateGoal({ status: 'complete' }, ctx);
    expect(r).toMatch(/no active goal to update/);
  });

  it('complete: returns success when verifier accepts', async () => {
    const goal = buildCreatedGoal('finish refactor', null);
    const ctx = makeExecCtx(
      makeGoalCtx({
        readGoal: async () => goal,
        requestComplete: async () => ({ ok: true }),
      }),
    );
    const r = await toolUpdateGoal({ status: 'complete' }, ctx);
    expect(r).toMatch(/Goal marked complete: "finish refactor"/);
  });

  it('complete: returns Tool Error with reason when verifier rejects', async () => {
    const goal = buildCreatedGoal('x', null);
    const ctx = makeExecCtx(
      makeGoalCtx({
        readGoal: async () => goal,
        requestComplete: async () => ({
          ok: false,
          reason: 'Tests are still failing in src/foo.ts',
          suggestedFix: 'Run `npm test` and fix failing tests.',
        }),
      }),
    );
    const r = await toolUpdateGoal({ status: 'complete' }, ctx);
    expect(r).toMatch(/\[Tool Error\]/);
    expect(r).toMatch(/Tests are still failing/);
    expect(r).toMatch(/Suggested next step: Run `npm test`/);
    expect(r).toMatch(/Keep working/);
  });

  it('blocked: requires blocker_kind', async () => {
    const goal = buildCreatedGoal('x', null);
    const ctx = makeExecCtx(makeGoalCtx({ readGoal: async () => goal }));
    const r = await toolUpdateGoal({ status: 'blocked' }, ctx);
    expect(r).toMatch(/requires a non-empty `blocker_kind`/);
  });

  it('blocked: returns Tool Error message when 3-turn rule not met', async () => {
    const goal = buildCreatedGoal('x', null);
    const ctx = makeExecCtx(
      makeGoalCtx({
        readGoal: async () => goal,
        requestBlocked: async () => ({
          ok: false,
          statusMessage:
            "Blocked state requires the same blocker to persist across 3 consecutive goal turns. Current count: 1/3 for 'missing-dep'.",
          counter: { current: 1, required: 3 },
        }),
      }),
    );
    const r = await toolUpdateGoal({ status: 'blocked', blocker_kind: 'missing-dep' }, ctx);
    expect(r).toMatch(/\[Tool Error\]/);
    expect(r).toMatch(/Current count: 1\/3/);
  });

  it('blocked: returns success when 3-turn rule met', async () => {
    const goal = buildCreatedGoal('x', null);
    const ctx = makeExecCtx(
      makeGoalCtx({
        readGoal: async () => goal,
        requestBlocked: async () => ({
          ok: true,
          statusMessage: "blocked accepted (3/3 consecutive 'missing-dep' turns).",
          counter: { current: 3, required: 3 },
        }),
      }),
    );
    const r = await toolUpdateGoal({ status: 'blocked', blocker_kind: 'missing-dep' }, ctx);
    expect(r).toMatch(/Goal marked blocked/);
    expect(r).toMatch(/3\/3/);
  });
});
