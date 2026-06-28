/**
 * FEATURE_200 Phase A.2 (v0.7.45) — runner-driven sidecar-verifier adapter.
 *
 * Behaviour-neutral extraction of the FEATURE_184 Sidecar Verifier stop-hook
 * wiring out of `runManagedTaskViaRunnerInner`. The factory owns the verifier
 * provider resolution, the captured-verdict ref (for the opt-in log emit), the
 * sidecar stop hook, the extension `turn:complete` fallback hook, and the
 * `currentAgentRoleRef`. It exposes:
 *
 *   - `resolvedVerifier`   : provider/model the verifier runs on (or undefined).
 *   - `composedStopHook`   : sidecar-first → extension-fallback stop hook.
 *   - `currentAgentRoleRef`: mutable role ref the caller flips on
 *     `onAgentSwitched` so the hook gates the sidecar to Worker turns.
 *
 * Decoupling: the verdict side-effect (`applySidecarVerdictToRecorder`, which
 * needs recorder/observer/todoStore/budget/budgetExtension) stays at the call
 * site and is passed in as `onVerdict`. The adapter therefore depends only on
 * the verifier primitives + a handful of accessors, not on the runner's whole
 * recorder/budget surface.
 *
 * Control flow inside `composedStopHook` is transcribed verbatim from the
 * inline original (role gate → idle-yield guard → FEATURE_196 content gate →
 * fire + log) so the move is behaviour-neutral.
 */

import type { KodaXBaseProvider } from '@kodax-ai/llm';
import type { StopHookContext, StopHookFn } from '@kodax-ai/agent';
import { getMessageQueue } from '@kodax-ai/agent';

import type { KodaXTaskRole, ManagedMutationTracker } from '../types.js';
import type { ObserverBridge } from './_internal/managed-task/types.js';
import {
  createSidecarVerifierStopHook,
  type SidecarVerifierVerdict,
} from '../agent-runtime/middleware/sidecar-verifier/verifier.js';
import { buildVerifierContext } from '../agent-runtime/middleware/sidecar-verifier/verifier-context-builder.js';
import { resolveVerifierProvider } from '../agent-runtime/middleware/sidecar-verifier/verifier-provider-resolver.js';
import { composeGateDecision } from '../agent-runtime/middleware/sidecar-verifier/gate.js';
import { createExtensionTurnCompleteStopHook } from '../agent-runtime/middleware/extension-queue.js';

export interface RunnerSidecarVerifierAdapterDeps {
  /** Resolved main provider (the Worker's provider). */
  readonly mainProvider: KodaXBaseProvider;
  /** Main provider name — `options.provider ?? 'anthropic'`. */
  readonly mainProviderName: string;
  /**
   * Main model — `options.modelOverride ?? options.model`. Intentionally may
   * be `undefined` (NOT `'unknown'`): a truthy sentinel resolves to
   * `modelOverride: 'unknown'` at `provider.stream`, forcing a model literally
   * named "unknown". The `options.model ? {modelOverride} : undefined` guard
   * inside `invokeSidecarVerifier` only works when the sentinel is `undefined`.
   */
  readonly mainModel: string | undefined;
  /** Mutation tracker fed to `buildVerifierContext` for fileEdit summary. */
  readonly mutationTracker: ManagedMutationTracker;
  /** Observer bridge — sidecar spinner (`sidecarStarted`) + opt-in log emit. */
  readonly observer: ObserverBridge;
  /**
   * Side-effect bridge: the caller wires `applySidecarVerdictToRecorder` here
   * (writes recorder.verdict, fires onRoleEmit, dispatches TodoStore action,
   * triggers budget-extension dialog). Kept at the call site so the adapter
   * need not depend on recorder/todoStore/budget/budgetExtension.
   */
  readonly onVerdict: (
    verdict: SidecarVerifierVerdict,
    context: Pick<StopHookContext, 'reanimateCount' | 'reanimateBudget'>,
  ) => void;
  /** Session id accessor for the extension turn:complete stop hook. */
  readonly getSessionId: () => string | undefined;
  /**
   * Pending-children count for the idle-yield guard. When > 0 (or a background
   * task-notification is queued) the Worker is mid idle-yield, not at a real
   * terminal turn, so the sidecar is deferred to the next stop-hook fire.
   */
  readonly getChildTaskRegistrySize: () => number;
  /** Total rounds (LLM turns) the Worker ran this task — `roundRef.current`. */
  readonly getRoundCount: () => number;
  /** Whether the Worker committed a Todolist — `todoStore.getAll().length > 0`. */
  readonly getHasPlan: () => boolean;
}

export interface RunnerSidecarVerifierAdapter {
  readonly resolvedVerifier: ReturnType<typeof resolveVerifierProvider>;
  readonly composedStopHook: StopHookFn;
  readonly currentAgentRoleRef: { current: KodaXTaskRole };
}

/**
 * Build the Sidecar Verifier stop-hook adapter.
 *
 * FEATURE_184 default behaviour is inherit-from-main-agent — the sidecar runs
 * on the same model as the Main Agent unless the user sets
 * `KODAX_VERIFIER_PROVIDER` + `KODAX_VERIFIER_MODEL`. The architectural value
 * is the out-of-chain Stop-hook shape, NOT automatic model-family decoupling
 * (decoupling is an opt-in escape hatch).
 */
export function buildRunnerSidecarVerifierAdapter(
  deps: RunnerSidecarVerifierAdapterDeps,
): RunnerSidecarVerifierAdapter {
  // FEATURE_184 Phase C.1 — current-agent role ref. FEATURE_193 retired the
  // V1 chain; the only V2 chain agent is the Worker, and `Runner.run` does NOT
  // fire `onAgentSwitched` for the entry agent on a single-agent chain, so the
  // ref must initialise directly to `'worker'` (an init of `'scout'` left the
  // sidecar permanently gated off — the bug F184 Phase C.1 fixed).
  const currentAgentRoleRef: { current: KodaXTaskRole } = { current: 'worker' };

  // FEATURE_184 Phase D.2 — resolve the verifier provider/model (inherit-main
  // by default; env override via KODAX_VERIFIER_PROVIDER + KODAX_VERIFIER_MODEL).
  const resolvedVerifier = resolveVerifierProvider({
    mainProvider: deps.mainProvider,
    mainProviderName: deps.mainProviderName,
    mainModel: deps.mainModel,
  });

  // Opt-in verifier observability: the captured verdict ref lets the
  // composedStopHook attach trace + elapsedMs to the `sidecarFinished` log
  // line after timing the await.
  const capturedSidecarVerdictRef: {
    current: SidecarVerifierVerdict | undefined;
  } = { current: undefined };

  const sidecarVerifierHook = resolvedVerifier
    ? createSidecarVerifierStopHook({
        provider: resolvedVerifier.provider,
        model: resolvedVerifier.model,
        buildContext: (ctx) =>
          buildVerifierContext({
            transcript: ctx.transcript,
            lastAssistantText: ctx.lastAssistantText,
            mutationTracker: deps.mutationTracker,
          }),
        onVerdict: (verdict) => {
          capturedSidecarVerdictRef.current = verdict;
        },
      })
    : undefined;

  const extensionTurnCompleteHook = createExtensionTurnCompleteStopHook(
    () => deps.getSessionId(),
  );

  // Composed stopHook: sidecar verifier wins when non-undefined; falls through
  // to the extension bridge on undefined (sidecar accepted, or no sidecar
  // configured). Order matters — flipping it would let user extensions
  // second-guess a sidecar `revise` / `blocked` verdict.
  const composedStopHook: StopHookFn = async (ctx) => {
    if (sidecarVerifierHook) {
      // FEATURE_184 Phase C.1 role gate: only invoke the sidecar on
      // execution-role (Worker) text-only termination.
      const isExecutionRole = currentAgentRoleRef.current === 'worker';
      if (isExecutionRole) {
        // Phase C.1 idle-yield guard: skip the sidecar on an intermediate
        // text-only idle-yield turn (Worker waiting for a pending child or a
        // queued background banner). Invoking it would waste an LLM call AND
        // set recorder.verdict synchronously, flipping
        // `hasEmittedTerminalVerdict` true and stranding the outer loop.
        const isIdleYieldTurn =
          deps.getChildTaskRegistrySize() > 0 ||
          getMessageQueue().has({
            agentId: undefined,
            maxPriority: 'background',
            mode: 'task-notification',
          });
        if (!isIdleYieldTurn) {
          // FEATURE_196 + H2 metric-refined fire gate — skip trivial chat
          // (greeting) AND trivial observed work (single small edit / grounded
          // read-only lookup); fire on substantial/risky work and on the zhipu
          // intent-vs-action floor (text-only claim, no tools). Conservative
          // default = fire. Escape hatch KODAX_VERIFIER_ALWAYS=1.
          const tracker = deps.mutationTracker;
          let estimatedChangedLines = 0;
          for (const delta of tracker.files.values()) estimatedChangedLines += delta;
          const gateMetrics = {
            riskyShellOps: tracker.riskyShellOps ?? 0,
            unattributedWriteOps: tracker.unattributedWriteOps ?? 0,
            writeOps: tracker.totalOps,
            filesChanged: tracker.files.size,
            estimatedChangedLines,
            hasPlan: deps.getHasPlan(),
            rounds: deps.getRoundCount(),
          };
          const gateDecision = composeGateDecision(ctx, gateMetrics, process.env);
          if (process.env.KODAX_VERIFIER_LOG === '1') {
            process.stderr.write(
              `[sidecar-gate] ${gateDecision.fire ? 'fire' : 'skip'}: ${gateDecision.reason}\n`,
            );
          }
          if (!gateDecision.fire) {
            return extensionTurnCompleteHook(ctx);
          }
          // FEATURE_184 Phase D.3 — surface a "Verifying..." spinner during
          // the sidecar LLM call (typically 3-10s on inherit-main).
          deps.observer.sidecarStarted();
          capturedSidecarVerdictRef.current = undefined;
          const verifierStartedAt = Date.now();
          const sidecarResult = await sidecarVerifierHook(ctx);
          // Widen with `as`: TS narrows `.current` to `undefined` after the
          // reset above and does not widen back across the awaited onVerdict
          // mutation (closure mutation is opaque to control-flow analysis).
          const captured = capturedSidecarVerdictRef.current as
            | SidecarVerifierVerdict
            | undefined;
          if (captured) {
            deps.onVerdict(captured, ctx);
          }
          if (
            process.env.KODAX_VERIFIER_LOG === '1' &&
            captured &&
            resolvedVerifier
          ) {
            deps.observer.sidecarFinished({
              verdict: captured.verdict,
              providerName: resolvedVerifier.providerName,
              model: resolvedVerifier.model,
              source: resolvedVerifier.source,
              elapsedMs: Date.now() - verifierStartedAt,
              trace: captured.trace,
            });
          }
          if (sidecarResult !== undefined) return sidecarResult;
        }
      }
    }
    return extensionTurnCompleteHook(ctx);
  };

  return { resolvedVerifier, composedStopHook, currentAgentRoleRef };
}
