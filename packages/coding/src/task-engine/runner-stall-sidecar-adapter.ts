/**
 * FEATURE_200 Phase A (v0.7.45) — runner-driven stall-sidecar adapter.
 *
 * Behaviour-neutral extraction of the FEATURE_178 / FEATURE_187 stall
 * detector + sidecar orchestrator wiring that previously lived inline in
 * `runManagedTaskViaRunnerInner`. The factory owns three private pieces —
 * the rule-based L1 `stallDetector`, the resolved sidecar provider, and the
 * deferred `ObserverBridge` ref — and exposes only what the runner needs:
 *
 *   - `detector` : the L1 detector (runner wires `.reset()` to the compaction
 *     post-hook).
 *   - `sidecar`  : the `StallSidecarHandle` (runner threads `.observer` into
 *     the tool-observer chain and `.reset()` into compaction).
 *   - `attachObserver(observer)` : late-binds the `ObserverBridge` once it
 *     exists. The `onVerdict` callback only fires at runtime on an L2 stall
 *     judgement — always AFTER the observer is built — so the ref is safely
 *     populated before any verdict arrives.
 *
 * Construction order inside the factory is identical to the original inline
 * order (detector → provider resolve → handle), so the move is byte-faithful
 * with respect to side effects.
 */

import type { KodaXBaseProvider } from '@kodax-ai/llm';

import { createStallDetector, type StallDetector } from '../multi-instance/stall-detector.js';
import {
  createStallSidecarToolObserver,
  type StallSidecarHandle,
} from '../agent-runtime/middleware/stall-sidecar/index.js';
import { resolveStallSidecarProvider } from '../agent-runtime/middleware/stall-sidecar/provider-resolver.js';
import type { ObserverBridge } from './_internal/managed-task/types.js';

export interface RunnerStallSidecarAdapterDeps {
  /** Resolved main provider (the Worker's provider). */
  readonly mainProvider: KodaXBaseProvider;
  /** Main provider name — `options.provider ?? 'anthropic'`. */
  readonly mainProviderName: string;
  /**
   * Main model — `options.modelOverride ?? options.model`. Intentionally may
   * be `undefined` (NOT the truthy string `'unknown'`): the inherit-main path
   * threads this string down to `provider.stream(...{modelOverride: ...})`
   * via the `options.model ? {modelOverride} : undefined` guard in
   * `sidecar.ts`. A truthy sentinel would resolve to `modelOverride: 'unknown'`
   * and force the provider to call a model literally named "unknown".
   */
  readonly mainModel: string | undefined;
}

export interface RunnerStallSidecarAdapter {
  readonly detector: StallDetector;
  readonly sidecar: StallSidecarHandle;
  /** Late-bind the observer bridge used by the `onVerdict` log emit. */
  attachObserver(observer: ObserverBridge): void;
}

/**
 * Build the stall detector + sidecar orchestrator.
 *
 * FEATURE_178 (v0.7.42): the rule-based L1 detector records every tool
 * invocation and fires when `(toolName, input)` repeats hit a threshold. The
 * orchestrator wraps it with the L2 sidecar invocation (validated
 * SHIP-SIDECAR-ALL in eval `1909d5d2`); on a stall + `isStuck=true` verdict it
 * queues a nudge consumed by the next `beforeTool` gate. Killswitch
 * `KODAX_STALL_DETECT=0` returns a no-op detector (the orchestrator never sees
 * a stall signal, never fires the sidecar).
 *
 * FEATURE_187 Phase B (v0.7.43): provider resolution mirrors the FEATURE_184
 * verifier pattern — default inherit-main, env-var override via
 * `KODAX_STALL_PROVIDER` + `KODAX_STALL_MODEL` (both required; a typo on the
 * provider name silently falls through to inherit-main). F178 eval ran with
 * inherit-main on all 5 canonical aliases, so the default preserves the
 * SHIP-SIDECAR-ALL baseline exactly.
 */
export function buildRunnerStallSidecarAdapter(
  deps: RunnerStallSidecarAdapterDeps,
): RunnerStallSidecarAdapter {
  const detector = createStallDetector();
  const resolved = resolveStallSidecarProvider({
    mainProvider: deps.mainProvider,
    mainProviderName: deps.mainProviderName,
    mainModel: deps.mainModel,
  });

  // Forward ref for the stall observer's opt-in log emit. The factory is
  // built before the `ObserverBridge` exists; the `onVerdict` callback fires
  // only at runtime when a tool call triggers an L2 stall judgement, which is
  // always AFTER `attachObserver` has run.
  const observerRef: { current: ObserverBridge | undefined } = { current: undefined };

  const sidecar: StallSidecarHandle = createStallSidecarToolObserver({
    detector,
    provider: resolved.provider,
    model: resolved.model,
    onVerdict: (_signal, verdict, elapsedMs) => {
      // FEATURE_187 Phase C (v0.7.43) opt-in observability: when the user
      // enables `KODAX_STALL_LOG=1` (env or `stallLog:true` in
      // `~/.kodax/config.json`), persist a one-line summary per L2 stall
      // verdict so users can confirm the sidecar fired without reading raw
      // session jsonl. Off by default — the stall sidecar is silent on the
      // happy path (`verdict.isStuck=false` is the common case; no nudge).
      if (process.env.KODAX_STALL_LOG !== '1') return;
      const obs = observerRef.current;
      if (!obs) return;
      obs.stallSidecarFired({
        isStuck: verdict.isStuck,
        providerName: resolved.providerName,
        model: resolved.model,
        source: resolved.source,
        elapsedMs,
        // `unknown_trace` (not `sidecar_ok`) when `verdict.trace` is absent:
        // the SidecarVerdictTrace enum has a specific `'sidecar_ok'` value
        // meaning "ran cleanly". Conflating missing-trace with clean-trace
        // would mislead audit reads.
        trace: verdict.trace ?? 'unknown_trace',
      });
    },
  });

  return {
    detector,
    sidecar,
    attachObserver(observer: ObserverBridge): void {
      observerRef.current = observer;
    },
  };
}
