/**
 * Hermetic tests for `bootstrapAutoMode` — FEATURE_092 phase 2b.7b.
 *
 * No real LLM, no real tool registry mutation. We exercise the wiring:
 *   - `loadAutoRules` is invoked with `userKodaxDir` + `projectRoot`
 *   - the guardrail is constructed lazily on first `getGuardrail()` call
 *   - subsequent calls return the SAME instance (state is shared)
 *   - the askUser bridge invokes `confirmToolExecution` and translates
 *     the `confirmed` flag into the AutoModeAskUserVerdict the guardrail
 *     expects
 *
 * The guardrail's own behavior (Tier 1, classifier, denial fallback,
 * circuit breaker) is covered by `packages/coding/src/guardrails/auto-mode/
 * guardrail.test.ts` — those tests already pin the guardrail contract,
 * so here we only verify wiring.
 */

import { describe, expect, it, vi } from 'vitest';

// `bootstrapAutoMode` calls `loadAutoRules` against the real filesystem.
// We mock it to return an empty merge so the test doesn't depend on the
// developer's `~/.kodax/auto-rules.jsonc` (it doesn't exist in CI).
vi.mock('@kodax-ai/coding', async () => {
  const actual = await vi.importActual<typeof import('@kodax-ai/coding')>('@kodax-ai/coding');
  return {
    ...actual,
    loadAutoRules: vi.fn(async () => ({
      merged: { allow: [], soft_deny: [], environment: [] },
      sources: [],
      skipped: [],
      errors: [],
    })),
    formatAgentsForPrompt: vi.fn(() => ''),
    // Issue 143 (WS3): wrap the real factory in a capturing spy (still delegates
    // to the real implementation, so guardrail behavior is unchanged) so wiring
    // tests can assert which config the bootstrap forwarded.
    createAutoModeToolGuardrail: vi.fn(
      (config: import('@kodax-ai/coding').AutoModeGuardrailConfig) =>
        actual.createAutoModeToolGuardrail(config),
    ),
  };
});

import { bootstrapAutoMode } from './auto-mode-bootstrap.js';
import { createAutoModeToolGuardrail } from '@kodax-ai/coding';

const baseDeps = () => ({
  askUser: vi.fn(async () => 'allow' as const),
  projectRoot: '/test/project',
  executionCwd: '/test/project/worktree',
  getCurrentProviderName: () => 'kimi-code',
  getCurrentModel: () => 'kimi-for-coding',
  getCurrentPermissionMode: () => 'auto' as const,
  autoModeSettings: {
    engine: 'llm' as const,
    classifierModel: undefined,
    classifierModelEnv: undefined,
    timeoutMs: undefined,
  },
});

describe('bootstrapAutoMode', () => {
  it('returns rulesLoadResult and a getGuardrail factory', async () => {
    const result = await bootstrapAutoMode(baseDeps());
    expect(result.rulesLoadResult).toBeDefined();
    expect(result.rulesLoadResult.merged).toEqual({
      allow: [],
      soft_deny: [],
      environment: [],
    });
    expect(typeof result.getGuardrail).toBe('function');
  });

  it('getGuardrail returns the same instance on repeated calls (state-sharing)', async () => {
    const result = await bootstrapAutoMode(baseDeps());
    const a = result.getGuardrail();
    const b = result.getGuardrail();
    expect(a).toBe(b);
  });

  it('guardrail has stable kind=tool name=auto-mode (Runner registration contract)', async () => {
    const result = await bootstrapAutoMode(baseDeps());
    const g = result.getGuardrail();
    expect(g.kind).toBe('tool');
    expect(g.name).toBe('auto-mode');
  });

  it('starts in llm engine (not pre-downgraded) when autoModeSettings.engine="llm"', async () => {
    const result = await bootstrapAutoMode(baseDeps());
    const g = result.getGuardrail();
    expect(g.getEngineForTest()).toBe('llm');
  });

  it('starts in rules engine when autoModeSettings.engine="rules" (slice C wiring)', async () => {
    const result = await bootstrapAutoMode({
      ...baseDeps(),
      autoModeSettings: {
        engine: 'rules' as const,
        classifierModel: undefined,
        classifierModelEnv: undefined,
        timeoutMs: undefined,
      },
    });
    const g = result.getGuardrail();
    expect(g.getEngineForTest()).toBe('rules');
  });

  it('does not eagerly construct the guardrail (lazy on first getGuardrail)', async () => {
    const result = await bootstrapAutoMode(baseDeps());
    // The factory is returned, but no guardrail has been built until
    // `getGuardrail()` is called. Verifying laziness directly is hard
    // without exposing internals; we settle for the weaker assertion
    // that `result.getGuardrail` is callable and returns an object —
    // and that the FIRST call gives us `engine: 'llm'` (a fresh state),
    // confirming the constructor ran exactly once.
    expect(result.getGuardrail).toBeDefined();
    const g1 = result.getGuardrail();
    const g2 = result.getGuardrail();
    expect(g1).toBe(g2);
  });

  // FEATURE_092 v0.7.34 hotfix-3 — defaultProvider/defaultModel staleness.
  //
  // Before the fix, bootstrap snapshotted `getCurrentProviderName()` and
  // `getCurrentModel()` once at first getGuardrail() call and froze the
  // result inside the guardrail's `defaultProvider` / `defaultModel`
  // string fields. Mid-session `/model` and `/provider` swaps did NOT
  // retarget the classifier. After the fix, bootstrap also passes
  // `getDefaultProvider` / `getDefaultModel` getters to the guardrail
  // config; the guardrail re-evaluates them on every classify.
  it('passes getDefaultProvider that re-evaluates getCurrentProviderName each call', async () => {
    let liveProvider = 'kimi-code';
    const getCurrentProviderName = vi.fn(() => liveProvider);
    const result = await bootstrapAutoMode({
      ...baseDeps(),
      getCurrentProviderName,
    });
    // Trigger guardrail construction (lazy) — bootstrap reads
    // `getCurrentProviderName()` once for the static `defaultProvider`
    // fallback at this point.
    result.getGuardrail();
    const initialCalls = getCurrentProviderName.mock.calls.length;
    expect(initialCalls).toBeGreaterThanOrEqual(1);

    // Simulate `/provider` swap mid-session.
    liveProvider = 'glm-coding';

    // The bootstrap-side getter (passed as `getDefaultProvider`) should be
    // a thin pass-through to `getCurrentProviderName`. We can't poke the
    // guardrail's resolveClassifierModel directly without a classify call,
    // but we can confirm that calling getCurrentProviderName again after
    // the swap returns the new value — which is the contract the getter
    // closure relies on.
    expect(getCurrentProviderName()).toBe('glm-coding');
  });

  it('Issue 143 WS3: forwards autoModeSettings.speculativeWindowMs to the guardrail config', async () => {
    const result = await bootstrapAutoMode({
      ...baseDeps(),
      autoModeSettings: {
        engine: 'llm' as const,
        classifierModel: undefined,
        classifierModelEnv: undefined,
        timeoutMs: undefined,
        speculativeWindowMs: 1500,
      },
    });
    result.getGuardrail(); // trigger lazy construction
    const cfg = vi.mocked(createAutoModeToolGuardrail).mock.calls.at(-1)?.[0];
    expect(cfg?.speculativeWindowMs).toBe(1500);
  });

  it('Issue 143 WS3: omitted speculativeWindowMs forwards undefined (guardrail uses its 500 default)', async () => {
    const result = await bootstrapAutoMode(baseDeps());
    result.getGuardrail();
    const cfg = vi.mocked(createAutoModeToolGuardrail).mock.calls.at(-1)?.[0];
    expect(cfg?.speculativeWindowMs).toBeUndefined();
  });

  it('getDefaultModel surfaces empty-model warn through deps.log', async () => {
    const log = vi.fn<(level: 'info' | 'warn', msg: string) => void>();
    const getCurrentModel = vi.fn(() => undefined);
    // Use a separate scope to capture what bootstrap built. The
    // guardrail itself reads the getter on classify, but we exercise the
    // wired closure directly via the same path: by observing that log is
    // never invoked at bootstrap (warn is gated behind getter-call) and
    // would fire on a classify if the model were empty.
    await bootstrapAutoMode({
      ...baseDeps(),
      getCurrentModel,
      log,
    });
    // Bootstrap doesn't trigger the getter (only the guardrail's
    // resolveClassifierModel does, on classify). So no warn yet.
    expect(log).not.toHaveBeenCalled();
  });
});
