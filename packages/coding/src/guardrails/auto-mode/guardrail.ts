/**
 * AutoModeToolGuardrail — FEATURE_092 Phase 2b.6 (v0.7.33).
 *
 * Assembles the auto-mode classifier modules (rules + projection +
 * classify + denial-tracker + circuit-breaker + model-resolver) into a
 * `ToolGuardrail` that the Runner calls via `beforeTool` on every
 * tool invocation.
 *
 * Decision flow (per design doc "三层权限金字塔"):
 *
 *   1. Tool projection is '' (Tier 1)        → allow (zero token cost)
 *   2. Engine has been downgraded to rules   → escalate (user confirms)
 *   3. denialTracker.shouldFallback (3/20)   → engine downgrade, then escalate
 *   4. circuitBreaker.shouldFallback (5/10m) → engine downgrade, then escalate
 *   5. classify(...) sideQuery
 *        allow                               → allow (record allow → reset consecutive)
 *        block                               → block + reason (record block)
 *        escalate                            → escalate + reason (record error)
 *        AbortError thrown                   → re-throw (propagate user cancel)
 *
 * State (mutable, session-scoped):
 *   - engine: 'llm' | 'rules' (starts at 'llm', downgrades on threshold)
 *   - denialTracker (immutable type, swapped on each event)
 *   - circuitBreaker (immutable type, swapped on each event)
 *
 * Subagent sharing:
 *   The factory accepts an optional `sharedState` ref; passing the same ref
 *   to a subagent's guardrail means denial / circuit / engine state is
 *   shared (per design doc "防绕阈值"). Without it each guardrail is
 *   independent.
 *
 * Capability check, Tier 2 path-shortcuts, and the explicit
 * `supportsAutoModeClassifier` provider flag are deferred to follow-up
 * phases — v1 of the guardrail relies on Tier 1 (projection==='') as the
 * structural opt-out and forwards everything else to the classifier.
 */

import type { CostTracker, KodaXBaseProvider } from '@kodax-ai/llm';
import type {
  GuardrailContext,
  GuardrailVerdict,
  RunnerToolCall,
  ToolGuardrail,
} from '@kodax-ai/agent';

import { checkAbsoluteDeny, type AbsoluteDenyResult } from './absolute-denylist.js';
import { bashSignalCollector } from './bash-signals.js';
import {
  classify,
  DEFAULT_CLASSIFIER_TIMEOUT_MS,
  type ClassifyDecision,
} from './classify.js';
import {
  createCircuitBreaker,
  recordError as recordBreakerError,
  shouldFallback as breakerShouldFallback,
  type CircuitBreaker,
} from './circuit-breaker.js';
import {
  createDenialTracker,
  recordAllow as recordDenialAllow,
  recordBlock as recordDenialBlock,
  shouldFallback as denialShouldFallback,
  type DenialTracker,
} from './denial-tracker.js';
import { fileSignalCollector } from './file-signals.js';
import {
  resolveClassifierModel,
  type ResolveClassifierModelOptions,
} from './model-resolver.js';
import type { AutoRules } from './rules.js';
import { collectAllSignals, type SignalCollector, type ToolCallSignal } from './signals.js';
import { speculativeRace } from './speculative.js';
import { resolveToolBridgeTarget } from '../../tools/tool-bridge.js';

export type AutoModeEngine = 'llm' | 'rules';

export interface AutoModeSharedState {
  engine: AutoModeEngine;
  denials: DenialTracker;
  breaker: CircuitBreaker;
}

/**
 * User answer for an escalated tool-call. The guardrail translates this into
 * the actual `GuardrailVerdict` returned to the Runner. `'block'` preserves
 * the original escalation reason as the verdict reason so downstream consumers
 * see why the tool was blocked.
 */
export type AutoModeAskUserVerdict = 'allow' | 'block';

/**
 * Optional REPL-supplied prompt callback for the 6 escalate paths in
 * `beforeTool` (engine-downgraded, denial-threshold-just-crossed,
 * breaker-just-tripped, classifier-error, classifier-decision-escalate,
 * provider-not-configured). When supplied, the guardrail calls this and
 * translates the user's answer into `'allow'` or `'block'`. When NOT
 * supplied, the guardrail returns `'escalate'` as before — the Runner will
 * then throw `GuardrailEscalateError` (preserves backward compat with
 * SDK-side guardrail consumers that have no askUser surface).
 *
 * Rejection propagates: if the user cancels (Ctrl-C in the prompt), throw
 * an AbortError-shaped exception and the Runner aborts the run cleanly.
 */
export type AutoModeAskUser = (
  call: RunnerToolCall,
  reason: string,
  /**
   * FEATURE_158 (v0.7.39): static-analysis signals collected for this tool
   * call. Optional + readonly so existing callers without signal-aware UI
   * keep working. REPL uses these to render Scope/Risk labels on the
   * confirm dialog (replacing the input-marker path from FEATURE_066).
   */
  signals?: readonly ToolCallSignal[],
) => Promise<AutoModeAskUserVerdict>;

export interface AutoModeGuardrailConfig {
  readonly rules: AutoRules;
  readonly claudeMd?: string;
  /**
   * FEATURE_092 follow-up (auto-mode classifier AGENTS.md staleness fix):
   * live getter for the project AGENTS.md content. Takes precedence over the
   * static `claudeMd` string and is evaluated INSIDE the classify path on
   * every call — same live-getter pattern as `getDefaultProvider` /
   * `getDefaultModel` (v0.7.34 hotfix-3).
   *
   * The bug it fixes: the guardrail is a lazy-cached singleton, so a
   * captured `claudeMd` string froze the project rules at first
   * construction. Even `/reload` couldn't refresh it — the classifier kept
   * judging tool calls against a stale AGENTS.md snapshot. The REPL wires
   * this to `loadAgentsFiles` (mtime-cached), so the classifier sees the
   * same fresh project rules the system prompt does.
   */
  readonly getClaudeMd?: () => string | undefined;
  /**
   * FEATURE_092 phase 2b.7b: optional user-prompt callback for escalate
   * paths. See `AutoModeAskUser` for semantics.
   */
  readonly askUser?: AutoModeAskUser;

  /**
   * Look up a tool's `toClassifierInput` projection by tool name.
   * Returns `undefined` when the tool isn't in the registry — guardrail
   * treats that as "no projection ⇒ Tier 1 skip" (conservative for
   * unknown tools is debatable; v1 favors not blocking on noise).
   */
  readonly getToolProjection: (
    toolName: string,
  ) => ((input: unknown) => string) | undefined;

  /**
   * Resolve a provider name to an instance. Returns `undefined` when
   * unconfigured / unknown — the guardrail then escalates.
   */
  readonly resolveProvider: (providerName: string) => KodaXBaseProvider | undefined;

  readonly defaultProvider: string;
  readonly defaultModel: string;

  /**
   * FEATURE_092 v0.7.34 hotfix-3 — defaultProvider/defaultModel staleness fix.
   *
   * When supplied, these are called on EVERY classify() invocation, so the
   * classifier follows the user's current main session provider/model even
   * after `/model` or `/provider` mid-session swaps. Falls back to
   * `defaultProvider` / `defaultModel` (static strings) when unset, preserving
   * backward compatibility for SDK consumers that pass string literals.
   */
  readonly getDefaultProvider?: () => string;
  readonly getDefaultModel?: () => string;

  // Override layers consumed by `resolveClassifierModel`
  readonly cliFlag?: string;
  readonly envVar?: string;
  readonly sessionOverride?: string;
  readonly userSettings?: string;

  /**
   * Optional cost-tracker accessors. The classifier writes its tokens to
   * the tracker under `querySource: 'auto_mode'` (handled inside sideQuery).
   */
  readonly getCostTracker?: () => CostTracker | undefined;
  readonly setCostTracker?: (t: CostTracker) => void;

  /** Optional logger for engine-downgrade and config warnings. */
  readonly log?: (level: 'info' | 'warn', msg: string) => void;

  /**
   * Fired whenever the active engine changes — both on automatic downgrades
   * (denial threshold / circuit breaker) AND on manual `setEngine(...)`
   * calls. UI surfaces (status bar engine indicator, slash-command
   * confirmations) subscribe here so the displayed engine stays in sync
   * with the guardrail's internal state without the user having to trigger
   * another mode toggle just to refresh the bar.
   */
  readonly onEngineChange?: (engine: AutoModeEngine) => void;

  /**
   * Optional shared state for subagent threshold-bypass defense
   * (design doc "防绕阈值"). When supplied, the parent and child
   * guardrails reference the SAME object — engine downgrades and
   * tracker advances are visible across the session boundary.
   */
  readonly sharedState?: AutoModeSharedState;

  /**
   * FEATURE_092 phase 2b.7b slice C: starting engine. Defaults to `'llm'`.
   * Set to `'rules'` to skip the classifier entirely from session start
   * (the rules-mode escalate path runs immediately on the first non-Tier-1
   * tool call). Resolved by the REPL from `~/.kodax/config.json`
   * `autoMode.engine` and the `KODAX_AUTO_MODE_ENGINE` env var.
   */
  readonly initialEngine?: AutoModeEngine;

  /**
   * FEATURE_092 phase 2b.7b slice C: classifier sideQuery timeout in ms.
   * Defaults to 20_000. Resolved by the REPL from `~/.kodax/config.json`
   * `autoMode.timeoutMs`.
   */
  readonly timeoutMs?: number;

  // ============== FEATURE_158 (v0.7.39) ==============

  /**
   * Project root for signal collectors. File-tool collector uses this to
   * detect `outside_project` vs project-relative paths. Bash collector
   * doesn't use it (command-string-level) but threads it for uniform
   * collector contract.
   *
   * Required by FEATURE_158: if omitted, the default coding-side
   * collectors produce no `outside_project` signal (degrades gracefully),
   * but **REPL-injected `extraCollectors` will likely require it**.
   * SDK consumers without a project root should set `projectRoot: ''`
   * and supply no `extraCollectors`.
   */
  readonly projectRoot?: string;

  /** Directory used to resolve relative tool paths. Defaults to projectRoot. */
  readonly executionCwd?: string;

  /**
   * Override the default signal-collector set. When unset, defaults to
   * `[bashSignalCollector, fileSignalCollector]` — coding-side
   * command-string + file-tool collectors that don't depend on REPL
   * path utilities.
   *
   * Use `extraCollectors` instead if you want to **add** collectors
   * without replacing the defaults.
   */
  readonly signalCollectors?: readonly SignalCollector[];

  /**
   * Additional signal collectors to merge with `signalCollectors`.
   * Primary use: REPL injects a path-aware bash collector built on its
   * own `extractPathsFromCommand` / `isAlwaysConfirmPath` utilities
   * (those live in `@kodax/repl` for historical reasons; lifting them
   * is out-of-scope for FEATURE_158 — see design doc layer-boundary
   * decision).
   *
   * Order: defaults run first, then extras (preserves per-collector
   * signal order).
   */
  readonly extraCollectors?: readonly SignalCollector[];

  /**
   * Speculative-classify quiet window (ms). When a classifier promise
   * settles within this window, the guardrail uses the verdict directly
   * with no perceptible latency.
   *
   * Issue 143 (WS1): when the window expires the guardrail does NOT
   * hard-escalate — it waits for the real classifier verdict and adopts it
   * (late-verdict adoption). The window therefore only controls "fast path
   * vs wait", never "dialog vs no dialog": an `allow` never surfaces a
   * confirm dialog regardless of how long the classifier takes, and only an
   * `escalate` verdict (explicit LLM escalation, classifier timeout, or infra
   * error — all mapped to `escalate` by classify()) reaches the user.
   * The background classifier's cost is settled exactly once inside
   * classify(), so awaiting it after window expiry does not double-count.
   *
   * Precedence: explicit arg > `KODAX_AUTO_SPECULATIVE_WINDOW_MS` env >
   * `DEFAULT_WINDOW_MS = 500`. Set to 0 to disable the speculative race
   * (degrades to a synchronous classify — identical verdict outcome).
   */
  readonly speculativeWindowMs?: number;
}

/**
 * Snapshot of the auto-mode guardrail's session-scoped state. Returned by
 * `getStats()` for diagnostic surfaces (`/auto-denials`) and the status bar
 * engine indicator. The DenialTracker / CircuitBreaker types are immutable
 * value objects, so this is a copy of the references — caller cannot mutate
 * guardrail state through it.
 */
export interface AutoModeStats {
  readonly engine: AutoModeEngine;
  readonly denials: DenialTracker;
  readonly breaker: CircuitBreaker;
}

export interface AutoModeToolGuardrail extends ToolGuardrail {
  /** Current engine for this session. */
  getEngine(): AutoModeEngine;
  /** Snapshot of engine + denial tracker + circuit breaker. */
  getStats(): AutoModeStats;
  /**
   * Manually set the engine. Used by `/auto-engine` slash command to flip
   * back to 'llm' after an automatic downgrade or to flip to 'rules' for
   * manual testing. The downgrade thresholds still operate normally — a
   * subsequent threshold cross will downgrade again.
   */
  setEngine(engine: AutoModeEngine): void;

  /** Test-only alias for getEngine(). Backward-compat for test files. */
  getEngineForTest(): AutoModeEngine;
  /** Test-only alias for getStats(). Backward-compat for test files. */
  getStatsForTest(): AutoModeStats;
  /** Test-only override: swap the provider mid-test (for downgrade scenarios). */
  setProviderForTest(provider: KodaXBaseProvider): void;
}

export function createAutoModeToolGuardrail(
  config: AutoModeGuardrailConfig,
): AutoModeToolGuardrail {
  const state: AutoModeSharedState = config.sharedState ?? {
    engine: config.initialEngine ?? 'llm',
    denials: createDenialTracker(),
    breaker: createCircuitBreaker(),
  };
  const timeoutMs = config.timeoutMs ?? DEFAULT_CLASSIFIER_TIMEOUT_MS;

  // For tests only: lets us swap the provider mid-flight to verify downgrade.
  let providerOverride: KodaXBaseProvider | undefined;

  // Single mutation point for `state.engine`. Fires `onEngineChange` on every
  // real transition (no callback when the new value equals the old) so UI
  // surfaces (status bar engine indicator) stay in sync without polling. The
  // automatic-downgrade paths (denial threshold, circuit breaker) and the
  // manual `setEngine(...)` path both go through here.
  const transitionEngine = (next: AutoModeEngine): void => {
    if (state.engine === next) return;
    state.engine = next;
    config.onEngineChange?.(next);
  };

  // FEATURE_158: signal-collector set — defaults + extras. Frozen at
  // factory time so collectors don't change mid-session.
  const signalCollectors: readonly SignalCollector[] = [
    ...(config.signalCollectors ?? [bashSignalCollector, fileSignalCollector]),
    ...(config.extraCollectors ?? []),
  ];
  const projectRoot = config.projectRoot ?? '';
  const executionCwd = config.executionCwd ?? projectRoot;

  const beforeTool = async (
    call: RunnerToolCall,
    ctx: GuardrailContext,
  ): Promise<GuardrailVerdict> => {
    const bridgeTarget = resolveToolBridgeTarget(call);
    const guardedCall = bridgeTarget?.ok ? bridgeTarget.call : call;
    // FEATURE_158: collect signals ONCE per call. Used by both the
    // classifier prompt and the escalate-to-user path (REPL UI renders
    // Scope/Risk from signals). Empty array when no collector matches.
    const signals = collectAllSignals(guardedCall, projectRoot, signalCollectors, executionCwd);

    // When the REPL has supplied askUser, every "escalate" path is resolved
    // here into a concrete allow/block; otherwise we fall through to the
    // legacy escalate verdict (Runner throws GuardrailEscalateError).
    // FEATURE_158: pass signals to askUser so REPL can render Scope/Risk.
    const escalateOrAsk = async (reason: string): Promise<GuardrailVerdict> => {
      if (!config.askUser) {
        return { action: 'escalate', reason };
      }
      const verdict = await config.askUser(guardedCall, reason, signals);
      if (verdict === 'allow') return { action: 'allow' };
      return { action: 'block', reason };
    };

    // Tier 1: tool opted out of classifier via empty projection
    const projector = config.getToolProjection(guardedCall.name);
    const action = projector ? projector(guardedCall.input) : '';
    if (action === '') {
      return { action: 'allow' };
    }

    // FEATURE_158 — Tier 0: absolute denylist. Runs BEFORE engine check so
    // catastrophic patterns (rm -rf /, mkfs, dd of=/dev/sd*, fork bomb,
    // ~/.kodax write) are blocked even when engine is downgraded to 'rules'.
    // LLM cannot override. denialTracker NOT incremented (Tier 0 isn't a
    // classifier denial — separate concern from engine downgrade).
    const tier0: AbsoluteDenyResult = checkAbsoluteDeny(guardedCall, projectRoot, executionCwd);
    if (tier0.denied) {
      config.log?.(
        'warn',
        `[auto-mode] Tier 0 absolute denylist matched (${tier0.patternId}): ${tier0.reason}`,
      );
      return { action: 'block', reason: tier0.reason };
    }

    // Engine has previously downgraded — rules-engine behavior is
    // "Tier 1/2 allow, else escalate to user"; v1 doesn't yet implement
    // Tier 2 path-shortcuts so all non-Tier-1 calls escalate.
    if (state.engine === 'rules') {
      return escalateOrAsk(
        'auto-mode engine is in rules mode (downgraded); user confirmation required',
      );
    }

    // Threshold checks — engine downgrade BEFORE making another classify call
    if (denialShouldFallback(state.denials)) {
      transitionEngine('rules');
      config.log?.('warn', '[auto-mode] denial threshold crossed — engine downgraded to rules');
      return escalateOrAsk(
        'auto-mode engine downgraded after consecutive denials; user confirmation required',
      );
    }
    if (breakerShouldFallback(state.breaker, Date.now())) {
      transitionEngine('rules');
      config.log?.('warn', '[auto-mode] circuit breaker tripped — engine downgraded to rules');
      return escalateOrAsk('classifier infrastructure unstable; engine downgraded');
    }

    // Resolve which (provider, model) the classifier should use this call
    const resolved = resolveClassifierModel(buildResolveOptions(config));
    const provider = providerOverride ?? config.resolveProvider(resolved.providerName);
    if (!provider) {
      return escalateOrAsk(`classifier provider "${resolved.providerName}" is not configured`);
    }

    // FEATURE_158: kick off classifier with signals attached. The promise is
    // held locally so speculativeRace can race it against a quiet window — when
    // the verdict arrives within the window, we use it directly with no
    // perceptible latency.
    //
    // Issue 143 (WS1): the classifier verdict is ALWAYS adopted, even when the
    // window expires. The window only decides whether we resolve instantly
    // (fast classify) or wait a bit longer (slow/remote provider) — it does NOT
    // decide "hard-escalate vs not". A late `allow`/`block` is applied directly,
    // so allow verdicts never surface a confirm dialog; only a genuine
    // `escalate` verdict (or a classifier timeout) reaches the user. This is the
    // late-verdict adoption (CC's peekSpeculativeClassifierCheck equivalent) that
    // makes auto[llm] usable on remote/slow providers where a single classify
    // round-trip routinely outruns the window. The background classifyPromise is
    // never aborted on window expiry (tokens are already in flight) and its cost
    // is settled exactly once inside classify(), so awaiting it again here does
    // not double-count.
    const classifyPromise: Promise<ClassifyDecision> = classify({
      provider,
      model: resolved.model,
      rules: config.rules,
      // FEATURE_092 follow-up: prefer the live getter so mid-session AGENTS.md
      // edits reach the classifier; fall back to the static string for SDK
      // consumers that pre-date the getter.
      claudeMd: config.getClaudeMd?.() ?? config.claudeMd,
      transcript: ctx.messages ?? [],
      action,
      signals,
      timeoutMs,
      abortSignal: ctx.abortSignal,
      costTracker: config.getCostTracker?.(),
      setCostTracker: config.setCostTracker,
    });

    // Issue 143 (WS2): the speculative window only earns its keep when a human
    // is waiting on the confirm dialog — it trades a possible early escalate for
    // hiding classifier latency. With no `askUser` surface (SDK / non-interactive
    // / child-agent contexts) there is nobody to pre-empt, so an early
    // `window-expired` escalate is pure harm: it surfaces a transient 500ms
    // timeout as a verdict even though the classifier is about to return
    // allow/block. Force the window to 0 (wait for the full verdict) in that
    // case. When askUser IS present, `undefined` flows through to
    // speculativeRace's env/default resolution unchanged.
    const effectiveWindowMs = config.askUser ? config.speculativeWindowMs : 0;

    let decision: ClassifyDecision;
    try {
      const raceResult = await speculativeRace(classifyPromise, effectiveWindowMs);
      if (raceResult.kind === 'window-expired') {
        // Issue 143 (WS1): window expired — do NOT hard-escalate. Wait for the
        // real verdict and adopt it. The existing agent spinner covers the wait;
        // allow/block resolve without ever showing a dialog, and only an
        // `escalate` verdict (handled by the switch below) reaches the user. A
        // late AbortError re-surfaces here and is re-thrown by the catch below.
        decision = await classifyPromise;
      } else {
        decision = raceResult.value;
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }
      // Any other error gets routed through the breaker
      state.breaker = recordBreakerError(state.breaker, Date.now());
      return escalateOrAsk(
        `classifier error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Map decision → verdict + update tracker / breaker.
    // After recording, immediately re-check thresholds so the engine
    // downgrades on the SAME call that crosses the line, not the next one.
    switch (decision.kind) {
      case 'allow':
        state.denials = recordDenialAllow(state.denials);
        return { action: 'allow' };

      case 'block':
        state.denials = recordDenialBlock(state.denials);
        if (denialShouldFallback(state.denials)) {
          transitionEngine('rules');
          config.log?.('warn', '[auto-mode] denial threshold crossed — engine downgraded to rules');
        }
        return { action: 'block', reason: decision.reason };

      case 'escalate':
        state.breaker = recordBreakerError(state.breaker, Date.now());
        if (breakerShouldFallback(state.breaker, Date.now())) {
          transitionEngine('rules');
          config.log?.('warn', '[auto-mode] circuit breaker tripped — engine downgraded to rules');
        }
        return escalateOrAsk(decision.reason);
    }
  };

  const getStats = (): AutoModeStats => ({
    engine: state.engine,
    denials: state.denials,
    breaker: state.breaker,
  });
  return {
    kind: 'tool',
    name: 'auto-mode',
    beforeTool,
    getEngine: () => state.engine,
    getStats,
    setEngine: (engine) => {
      transitionEngine(engine);
    },
    // Test-only aliases — kept for backward compat with the existing test files.
    getEngineForTest: () => state.engine,
    getStatsForTest: getStats,
    setProviderForTest: (p) => { providerOverride = p; },
  };
}

function buildResolveOptions(
  config: AutoModeGuardrailConfig,
): ResolveClassifierModelOptions {
  // FEATURE_092 v0.7.34 hotfix-3: normalize getDefaultProvider/getDefaultModel
  // (live getters) over defaultProvider/defaultModel (static strings) so the
  // classifier picks up mid-session `/model` and `/provider` swaps. The
  // ResolveClassifierModelOptions interface stays string-typed — normalization
  // happens here, before the call into resolveClassifierModel.
  return {
    cliFlag: config.cliFlag,
    envVar: config.envVar,
    sessionOverride: config.sessionOverride,
    userSettings: config.userSettings,
    defaultProvider: config.getDefaultProvider?.() ?? config.defaultProvider,
    defaultModel: config.getDefaultModel?.() ?? config.defaultModel,
  };
}
