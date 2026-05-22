/**
 * Shared interfaces used across the runner-driven managed-task internals.
 *
 * Lives here so the per-feature modules under `_internal/managed-task/`
 * (role-prompts, role-exclude, verdict-recorder, observer-bridge,
 * status-derivation, agent-chain, llm-adapter, payload-builder,
 * checkpoint-flow, …) can all import the same canonical contracts
 * without depending on the top-level `runner-driven.ts` orchestrator —
 * the original cause of cyclic references when the file was monolithic.
 *
 * Extracted as part of FEATURE_171 (v0.7.41) — `runner-driven.ts`
 * modular split. Zero behavior change: the interfaces are byte-identical
 * to the previous in-file declarations.
 */

import type { ProtocolEmitterMetadata } from '../../../agents/protocol-emitters.js';
import type {
  KodaXJsonValue,
  KodaXResult,
  KodaXTaskRole,
  KodaXTaskRoutingDecision,
  KodaXTaskToolPolicy,
} from '../../../types.js';

/**
 * Per-run capture of each emit tool's metadata. Populated by the
 * `wrapEmitterWithRecorder` wrapper on every successful emit; read by
 * downstream payload / status / observer code paths.
 *
 * Slots map 1:1 to the four runner-driven emit tools:
 *   - `scout`    → `emit_scout_verdict`
 *   - `contract` → `emit_contract`
 *   - `handoff`  → `emit_handoff`
 *   - `verdict`  → `emit_verdict`
 */
export interface VerdictRecorder {
  scout?: ProtocolEmitterMetadata;
  contract?: ProtocolEmitterMetadata;
  handoff?: ProtocolEmitterMetadata;
  verdict?: ProtocolEmitterMetadata;
}

/**
 * The set of AMA roles whose tool surface is controlled by the
 * exclude-based wiring contract. Excludes `direct` (an SA fast-path
 * pseudo-role) since direct runs do not pass through the AMA
 * chain-builder's exclude resolution.
 */
// FEATURE_184 (v0.7.45) Phase C.1: 'evaluator' removed from AmaRole.
// C.3 cleanup will remove remaining evaluator references in role-prompt.ts,
// REPL UI fixtures, verdict-recorder.ts, and sanitize.ts.
export type AmaRole = 'scout' | 'planner' | 'generator' | 'worker';

/**
 * Factory that resolves the `ManagedRolePromptContext` for a given role
 * from the current recorder state. Called by the dynamic `instructions`
 * closure on every agent invocation, so Scout's post-emit skillMap /
 * scope reach downstream role prompts in real time.
 */
export type RolePromptContextFactory = (
  role: KodaXTaskRole,
  recorder: VerdictRecorder,
) => import('./role-prompt-types.js').ManagedRolePromptContext | undefined;

/**
 * Optional prompt context plumbed into `buildRunnerAgentChain`. When
 * present, the chain builder uses `createRolePrompt` to produce a full
 * v0.7.22-parity role prompt for every turn. When absent (test paths),
 * the fallback constants in `role-prompts.ts` are used instead.
 */
export interface RunnerChainPromptContext {
  /** Original user task. Becomes `rolePromptContext.originalTask`. */
  readonly prompt: string;
  /**
   * Routing decision. Legacy callers / tests pass a static
   * `KodaXTaskRoutingDecision` captured at chain construction. The
   * runtime path passes a `() => KodaXTaskRoutingDecision` thunk so the
   * Generator / Evaluator see the post-Scout plan (M4 parity) instead of
   * the stale pre-Scout decision captured when the agent graph was
   * frozen. Without the thunk, a plan=H2 + Scout=H1 run leaks H2-only
   * prompt guidance into H1 workers.
   */
  readonly decision: KodaXTaskRoutingDecision | (() => KodaXTaskRoutingDecision);
  /** Optional structured task metadata. */
  readonly metadata?: Record<string, KodaXJsonValue>;
  /**
   * Optional static tool policy. Kept for tests / topology-only call sites
   * that don't need per-role policy. When both `toolPolicy` and
   * `toolPolicyFactory` are absent, the prompt's "## Tool Policy" section
   * is omitted (matches legacy behavior when a role falls through to
   * `undefined` in `buildManagedWorkerToolPolicy`).
   */
  readonly toolPolicy?: KodaXTaskToolPolicy;
  /**
   * P1 parity — per-role tool policy factory. Called lazily at each
   * Runner invocation so the Generator branch can see Scout's mutation
   * intent (which is only known after Scout emits). Without this, every
   * managed worker's prompt drops the "## Tool Policy" section. See
   * `buildManagedWorkerToolPolicy` for the switch body.
   */
  readonly toolPolicyFactory?: (
    role: KodaXTaskRole,
    recorder: VerdictRecorder,
  ) => KodaXTaskToolPolicy | undefined;
  /** Optional role-context factory for skillMap / scoutScope / childWriteReviewPrompt injection. */
  readonly contextFactory?: RolePromptContextFactory;
  /**
   * Pre-computed repo-intelligence context block (Repository Overview /
   * Changed Scope / Active Module / Impact / Fallback Guidance /
   * Premium Context sections). Built once per `runManagedTaskViaRunner`
   * entry via `buildAutoRepoIntelligenceContext` and prepended to every
   * role's system prompt so Scout/Planner/Generator/Evaluator see repo
   * context from turn 1.
   */
  readonly repoIntelligenceContext?: string;
}

/**
 * Observer surface the runner-driven path uses to bridge into
 * `options.events`. Built once per managed-task run by
 * `buildObserverBridge`; consumed by emit-wrapper, agent-chain, llm-
 * adapter and the outer-loop wrapper.
 */
export interface ObserverBridge {
  readonly preflight: () => void;
  readonly onRoleEmit: (role: KodaXTaskRole, recorder: VerdictRecorder) => void;
  readonly completed: (signal: KodaXResult['signal'], reason?: string) => void;
  readonly notifyBudgetApprovalRequest: () => void;
  // Shard 6d-Q (v0.7.22 parity): fire a status event when a child task
  // dispatch starts so the REPL's AmaWorkStrip can render
  // "Scout/Generator fanning out ${class} × ${count}" badge.
  readonly notifyChildFanout: (
    fanoutClass: 'finding-validation' | 'evidence-scan' | 'module-triage',
    count?: number,
  ) => void;
  /**
   * v0.7.38 FEATURE_156 — fire when the runner-driven outer loop is
   * about to park in `waitForWakeEvent` (idle-yield from FEATURE_155).
   * Surfaces "alive but suspended pending external wake" so the REPL's
   * status-bar can render "Worker - waiting for N children" instead
   * of falling back to the last role-emit label, which gives the user
   * no signal about what the spinner is waiting on.
   *
   * Agent-agnostic — caller passes the role of whichever agent just
   * exited idle (today always 'worker'; the field doesn't lock in
   * that invariant).
   *
   * No paired "resumed" emit needed: the next iteration's
   * `onRoleEmit` naturally clears `idleWaiting` because it doesn't
   * set the field, and the consumer branches on `=== true` so
   * undefined transitions out of the waiting label.
   */
  readonly idleWaiting: (
    role: KodaXTaskRole | undefined,
    pendingCount: number,
  ) => void;
  /**
   * FEATURE_166 (v0.7.41 follow-up) — fire on agent handoff transitions
   * to flip the REPL's `activeWorkerTitle` ahead of the new agent's
   * first streaming output.
   *
   * Without this, the label only updates when the new agent's first
   * `emit_*` slot tool succeeds (see `wrapEmitterWithRecorder` →
   * `onRoleEmit` at line ~1093). For Evaluator turns that emit any
   * pre-verdict text / thinking / non-verdict tool call, the label
   * lags through every such piece of output. Production session
   * 20260515_185354 confirmed: Worker→Evaluator handoff followed by
   * Evaluator's text-only summary renders the entire summary under
   * the stale `[Worker]` label.
   *
   * Pure UI-state flip: NO recorder mutation, NO budget-extension
   * dialog, NO history persistence (`persistToHistory: false`). The
   * authoritative role-emit on slot success (`onRoleEmit`) continues
   * to drive evidence entries, checkpoints, and budget accounting —
   * this hook is strictly a fast-path for the visible label.
   *
   * Agent-agnostic — `role` may be `undefined` when the new agent's
   * name doesn't map to a known `KodaXTaskRole`; in that case the
   * consumer should leave the label untouched rather than render an
   * unmapped fallback.
   */
  readonly agentSwitched: (role: KodaXTaskRole | undefined) => void;
  /**
   * FEATURE_184 Phase D.3 (v0.7.42 follow-up) — fire when the Sidecar
   * Verifier Stop hook is about to await the verifier LLM call. The
   * verifier runs out-of-chain (3-10s on inherit-main provider) and
   * the REPL would otherwise show stale "Worker" spinner state for
   * the entire window. Emit `phase: 'verifying'` so the spinner row
   * renders `[AMA Verifying] ...`.
   *
   * Pure UI label flip (same shape as `agentSwitched`):
   *   - NO recorder mutation
   *   - NO budget-extension dialog
   *   - NO checkpoint write
   *   - `persistToHistory: false` — transient REPL state
   *
   * No paired "done" emit needed: the next status event (either
   * `completed` for accept/blocked, or the next round's role-emit
   * for revise+reanimate) naturally overrides the verifying phase.
   */
  readonly sidecarStarted: () => void;
  /**
   * FEATURE_184 Phase D.3 follow-up (v0.7.42) — opt-in observability
   * for the Sidecar Verifier. Fires AFTER the verifier verdict comes
   * back so the REPL can persist a one-line summary into the transcript
   * (`[Sidecar Verifier] {verdict} · {model} · {ms}ms · {trace}`).
   *
   * Gated by `KODAX_VERIFIER_LOG=1` (env or `verifierLog:true` in
   * `~/.kodax/config.json`) — off by default. The runtime call site at
   * `runner-driven.ts` checks the env var before invoking this method.
   *
   * `persistToHistory: true` (writes to session jsonl) — diverges from
   * `sidecarStarted` which is transient spinner state. When users opt
   * in to the log they explicitly want a durable record per verifier
   * call, not just a flicker in the live spinner row.
   */
  readonly sidecarFinished: (info: SidecarFinishedInfo) => void;
  /**
   * FEATURE_187 Phase C (v0.7.43) — opt-in observability for the
   * FEATURE_178 stall sidecar. Fires AFTER each L2 sidecar verdict
   * resolves so the REPL can persist a one-line summary into the
   * transcript:
   *   `[Stall Sidecar] isStuck=true · zhipu/glm-5.1 (inherit) · 1842ms · sidecar_ok`
   *
   * Gated by `KODAX_STALL_LOG=1` (env or `stallLog: true` in
   * `~/.kodax/config.json`) — off by default. The stall sidecar
   * middleware factory checks the env var inside its `onVerdict`
   * callback before invoking this method (mirrors the FEATURE_184
   * verifier `sidecarFinished` design, with env gating moved into the
   * factory because stall verdicts arrive async / fire-and-forget —
   * the upstream call site has no synchronous moment to check env).
   *
   * `persistToHistory: true` (writes to session jsonl) — divergence
   * from `sidecarStarted` is intentional: when users opt in to the
   * log they explicitly want a durable record per stall verdict, not
   * a transient flicker.
   */
  readonly stallSidecarFired: (info: StallSidecarFiredInfo) => void;
}

/**
 * Shape passed to `ObserverBridge.stallSidecarFired`. Mirrors the
 * public fields of the FEATURE_178 `SidecarVerdict` (`stall-sidecar/
 * sidecar.ts`) plus resolution metadata the user opted in to see.
 * Same skeleton as `SidecarFinishedInfo` (FEATURE_184 verifier) but
 * carries `isStuck: boolean` instead of a 3-state verdict — that's
 * the F178 contract.
 */
export interface StallSidecarFiredInfo {
  /** Whether the L2 sidecar decided the agent is in a real stall. */
  readonly isStuck: boolean;
  /** Resolved stall-sidecar provider name (kodax provider registry id). */
  readonly providerName: string;
  /** Resolved stall-sidecar model id. `undefined` means the provider's
   *  registered default was used (no `KODAX_STALL_MODEL` override AND
   *  no main-agent model configured — log renders `(default)`). */
  readonly model: string | undefined;
  /** Whether the stall sidecar inherited from main or came from env override. */
  readonly source: 'explicit-env' | 'inherit-main';
  /** Wall-clock duration of the stall sidecar LLM call in milliseconds. */
  readonly elapsedMs: number;
  /** Diagnostic trace tag — see `SidecarVerdictTrace` in
   *  `stall-sidecar/sidecar.ts` for the closed enum
   *  (sidecar_ok / fuzzy_tool_match / timeout / provider_error /
   *  no_tool_call / invalid_isStuck / missing_nudge). */
  readonly trace: string;
}

/**
 * Shape passed to `ObserverBridge.sidecarFinished`. Mirrors the public
 * fields of `SidecarVerifierVerdict` (`verifier.ts`) plus resolution
 * metadata that the user opted in to see.
 */
export interface SidecarFinishedInfo {
  /** Three-state verdict the sidecar returned. */
  readonly verdict: 'accept' | 'revise' | 'blocked';
  /** Resolved verifier provider name (kodax provider registry id). */
  readonly providerName: string;
  /** Resolved verifier model id. `undefined` means the provider's
   *  registered default model was used (no specific `KODAX_VERIFIER_MODEL`
   *  override AND no main-agent `modelOverride` / `model` configured —
   *  the user-facing log renders this as `(default)` for clarity). */
  readonly model: string | undefined;
  /** Whether the verifier inherited from main or came from env override. */
  readonly source: 'explicit-env' | 'inherit-main';
  /** Wall-clock duration of the verifier StopHook call in milliseconds. */
  readonly elapsedMs: number;
  /** Diagnostic trace tag (verifier_ok / fuzzy_tool_match / timeout / …). */
  readonly trace: string;
}
