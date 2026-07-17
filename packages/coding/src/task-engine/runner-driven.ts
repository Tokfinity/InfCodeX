/**
 * Runner-driven AMA path — FEATURE_084 (v0.7.26).
 *
 * Runner-based replacement for the legacy `runManagedTask` state machine.
 *
 *   - Scout → {Generator (H1) | Planner (H2)} → Evaluator →
 *     {accept | revise → Generator | replan → Planner | blocked}.
 *   - Env flag `KODAX_MANAGED_TASK_RUNTIME=legacy` restores the legacy
 *     path (deleted after Shard 6d-b but preserved as a code search
 *     reference through git history).
 *
 * **Parity coverage (as of v0.7.26 release):**
 *   - Checkpoint detection + per-role write (FEATURE_071) — `_internal/managed-task/checkpoint.ts`
 *   - Budget tracking (per-harness caps + 90%-threshold extension dialog) — `_internal/managed-task/budget.ts`
 *   - Observer events: managed-task status / phase / child fan-out / iteration end / context-token snapshot
 *   - Mutation tracker integration — populated by tool wrappers, surfaced via `recordMutationForTool`
 *   - Session continuity — `options.session.initialMessages` threaded into `Runner.run`'s `runnerInput`
 *   - Role prompts — `_internal/managed-task/role-prompt.ts` restores the full v0.7.22 prompt surface
 *     (decision summary, contract, metadata, verification, tool-policy, evidence strategies,
 *     dispatch_child_task guidance, H0/H1/H2 framework, handoff/verdict/contract block specs)
 *   - Tool observability — Runner `toolObserver` forwards `onToolCall` / `onToolResult`
 *     / `beforeToolExecute` / `onToolProgress`, and per-call `reportToolProgress` injection
 *   - Compaction — `_internal/managed-task/compaction.ts` wraps `intelligentCompact` behind
 *     Runner's `compactionHook`; fires `onCompactStart` / `onCompactStats` / `onCompact` / `onCompactEnd`
 *   - Cost tracking — `CostTracker` per run, `events.getCostReport` populated
 *   - Thinking blocks — preserved on assistant messages (Anthropic extended-thinking contract)
 *   - Sanitize pipeline — `_internal/managed-task/sanitize.ts` strips leaked fences / control markers
 */

import type { KodaXMessage, KodaXToolResultContentItem } from '@kodax-ai/llm';
import { mapLegacyReasoningModeToEffortIntent } from '@kodax-ai/llm';
import type {
  Agent,
  QueuedInputArtifact,
  RunnerToolObserver,
  StopHookFn,
} from '@kodax-ai/agent';
import {
  Runner,
  buildSystemPrompt,
  getMessageQueue,
  readRunnerRecoveryTranscript,
} from '@kodax-ai/agent';
// FEATURE_193 (v0.7.43): SCOUT_AGENT_NAME / PLANNER_AGENT_NAME /
// GENERATOR_AGENT_NAME imports removed alongside the V1 chain agents —
// the only remaining V2 chain agent is the Worker.
import { WORKER_AGENT_NAME } from '../agents/task-engine-agents.js';
import { resolveProvider } from '../providers/index.js';
import { estimateTokens } from '../tokenizer.js';
import { rebaseContextTokenSnapshot } from '../token-accounting.js';
import { buildCapabilityContextSections } from '../prompts/capability-sections.js';
import { getSessionScratchDir } from '../session-scratch.js';
import {
  buildAutoRepoIntelligenceContext,
  emitResilienceDebug,
  saveSessionSnapshot,
} from '../agent.js';
import {
  maybeReviewMemoryFeedbackFromPrompt,
  maybeRunMemoryMaintenanceWindow,
} from '../memory-runtime.js';
import type {
  KodaXHarnessProfile,
  KodaXImageMediaType,
  KodaXInputArtifact,
  KodaXInputArtifactSource,
  KodaXManagedTask,
  KodaXManagedProtocolPayload,
  KodaXOptions,
  KodaXResult,
  KodaXTaskEvidenceArtifact,
  KodaXTaskEvidenceEntry,
  KodaXTaskRole,
  KodaXTaskRoutingDecision,
  KodaXVideoMediaType,
  KodaXAgentProfile,
  KodaXToolEventMeta,
  KodaXToolExecutionContext,
  KodaXTurnDeliveryKind,
  ManagedMutationTracker,
} from '../types.js';
import type { ReasoningPlan } from '../reasoning.js';
import {
  applyFollowupEscalationToOptions,
} from '../reasoning.js';
import type { ManagedTaskBudgetController } from './_internal/managed-task/budget.js';
import {
  buildManagedStatusBudgetFields,
} from './_internal/managed-task/budget.js';
import { deleteCheckpoint } from './_internal/managed-task/checkpoint.js';
import {
  getManagedTaskSurface,
  getManagedTaskWorkspaceRoot,
} from './_internal/managed-task/workspace.js';
import {
  getManagedSkillArtifactPaths,
  writeManagedSkillArtifacts,
  writeManagedTaskArtifacts,
  writeManagedTaskSnapshotArtifacts,
} from './_internal/managed-task/artifacts.js';
import { attachManagedTaskRepoIntelligence } from './_internal/managed-task/repo-intelligence.js';
// FEATURE_193 (v0.7.43): `inferScoutMutationIntent` import removed —
// last consumer (Shard 6d-k Scout suspicious-completion block) deleted
// alongside the V1 `recorder.scout` slot.
import { buildManagedWorkerToolPolicy } from './_internal/managed-task/tool-policy.js';
import { applyCurrentDiffReviewRoutingFloor } from './_internal/managed-task/review-routing.js';
import { createTodoStore, type TodoStore } from './todo-store.js';
import {
  applySidecarVerdictToRecorder,
  emitSidecarMessageEvent,
} from '../agent-runtime/middleware/sidecar-verifier/verifier-recorder-bridge.js';
import { buildRunnerSidecarVerifierAdapter } from './runner-sidecar-verifier-adapter.js';
import { resolveEffectiveVerification } from '../agent-runtime/effective-config.js';
import { createTodoReminderState } from './todo-throttle-reminder.js';
// FEATURE_193 (v0.7.43) deep V1 cleanup: the entire `scout-signals.ts`
// module was deleted — `SUSPICIOUS_LAST_TEXT_PREVIEW_LIMIT` /
// `detectScoutSuspiciousSignals` / `hadPriorAssistantToolCall` etc. had
// zero callers after the V1 H0_DIRECT scout suspicious-completion gate
// (at the end of runManagedTaskViaRunnerInner) was removed. The
// `KodaXEvents.onScoutSuspiciousCompletion` callback remains exposed
// on the SDK type surface for pre-1.0 consumer compat but is no longer
// fired by the Runner-driven path.
import type { ManagedRolePromptContext } from './_internal/managed-task/role-prompt-types.js';
import {
  sanitizeEvaluatorPublicAnswer,
  sanitizeManagedUserFacingText,
} from './_internal/managed-task/sanitize.js';
import {
  buildManagedTaskCompactionHook,
  resolveManagedTaskContextCapacity,
} from './_internal/managed-task/compaction.js';
// FEATURE_155 (v0.7.39) — idle-yield outer loop primitives. The wiring
// here detects an agent turn that exited via the no-tool-calls /
// pending-children branch, waits for a wake event (child completion or
// inbound user message), and resumes Runner.run with a synthetic user
// message so the agent can react. Always-on since Slice C3 — the
// `KODAX_IDLE_YIELD` env-flag gate was retired together with the
// `await_child_task` tool because there is no working off-path now.
// v0.7.39 FEATURE_120 Step 0b/0c: idle-yield primitives + outer-loop
// wrapper lifted to `@kodax-ai/agent`'s `orchestration/` module. Bug
// A-G hotfix behavior carried over verbatim — registry cleanup (Bug
// A) is now built into `registerChildTask`; the rest live in the
// agent-side `idle-yield.ts` / `runner-with-idle-yield.ts`. Coding
// consumes the generic primitives specialized on
// `KodaXChildExecutionResult` (the generic param is inferred from
// the registry value type).
import {
  countLastAssistantToolCalls,
  runWithIdleYield,
} from '@kodax-ai/agent';

function activeDescendantTurnCount(ctx: KodaXToolExecutionContext): number {
  const control = ctx.actorControl;
  if (!control) return 0;
  const prefix = control.callerPath === '/root' ? '/root/' : `${control.callerPath}/`;
  return control.list().actors.filter((actor) => (
    actor.path.startsWith(prefix) && actor.currentTurnId !== undefined
  )).length;
}

function actorMessageQueueId(ctx: KodaXToolExecutionContext): string | undefined {
  const path = ctx.actorControl?.callerPath;
  if (!path) return undefined;
  return ctx.sessionId ? `actor:${ctx.sessionId}:${path}` : path === '/root' ? undefined : path;
}
// FEATURE_125 (v0.7.41) — Team Mode runner-side adapter.
// Per-LLM-round sibling discovery + system-prompt block + content-hash
// safety net for cross-session edits.
import {
  buildOtherInstancesPromptBlock,
  discoverInstances,
  getActiveTeamModeWriter,
  type DiscoveredInstance,
} from '@kodax-ai/agent';
import { createContentHashCache } from '../multi-instance/content-hash-cache.js';
import { createReadFileStateCache } from '../multi-instance/read-file-state-cache.js';
import { buildRunnerStallSidecarAdapter } from './runner-stall-sidecar-adapter.js';
import { composeToolObservers } from '../agent-runtime/middleware/compose-tool-observers.js';
import {
  createTodoDriftObserver,
  createTodoDriftReminderState,
  getTodoDriftWarnings,
  type TodoDriftReminderState,
} from './todo-drift-reminder.js';
// FEATURE_193 (v0.7.43): createScopeAwareHarnessGuardrail import removed —
// scope-aware-harness-guardrail.ts deleted (V1 Scout H0→H1/H2 guardrail).
import { createEnvelopeAggregateBudgetEnforcer } from '../tools/envelope-budget.js';
import { createBlobSummarizer } from '../tools/blob-summarizer.js';
import { buildPromptMessageContent } from '../input-artifacts.js';
import { validateInputArtifactsForModel } from '../media/index.js';
import {
  createRunnerToolResultBatchTransform,
  resolveRunnerToolResultBudget,
} from './runner-tool-result-batch.js';
// CAP-003/004/005/006/007: shared event emit helpers. Both SA (substrate
// frame) and AMA (this runner-driven path) fire through the same
// surface so the contract for each event lives in exactly one place.
import {
  createLiveTurnScope,
  emitComplete,
  emitError,
  emitSessionStart,
  emitTurnCompleted,
  emitTurnFailed,
  emitTurnStarted,
  isVisibleToolName,
  withLiveTurnAttribution,
} from '../agent-runtime/event-emitter.js';
// CAP-008: shared initial-messages resolver. Three-tier fallback
// (inline → storage.load → empty) for AMA frame entry; SA already
// uses this from `run-substrate.ts`.
import { resolveInitialMessages } from '../agent-runtime/middleware/auto-resume.js';
import { createExtensionRuntimeSessionController } from '../agent-runtime/middleware/extension-queue.js';
import {
  buildRuntimeSessionState,
  snapshotRuntimeSessionState,
} from '../agent-runtime/runtime-session-state.js';
// CAP-010: shared tri-state permission gate. AMA's
// `toolObserver.beforeTool` delegates to this so the extension
// `tool:before` hook fires on AMA path (pre-FEATURE_100 only SA hit
// it).
import { getToolExecutionOverride } from '../agent-runtime/permission-gate.js';
import { applyToolVisibilityPolicy, filterExcludedTools } from '../agent-runtime/tool-resolution.js';
import { listToolDefinitions } from '../tools/index.js';
import {
  CANCELLED_TOOL_RESULT_MESSAGE,
  MANAGED_TASK_MAX_TOOL_LOOP_ITERATIONS,
} from '../constants.js';
// CAP-048: shared tool-execution-context builder. Centralizes
// FEATURE_074 (set_permission_mode NOT forwarded) and FEATURE_067
// (onChildProgress undefined) invariants so AMA and SA can't drift.
import { buildToolExecutionContext } from '../agent-runtime/tool-execution-context.js';
// FEATURE_192 v0.7.44 — `/goal` lifecycle adapter. Owns the
// composition of FEATURE_164 mid-turn drain + FEATURE_192 goal
// accounting/continuation + FEATURE_123 per-turn flood counter
// reset. No-op when `options.context.goalRuntime` is undefined.
import { buildRunnerGoalAdapter } from './runner-goal-adapter.js';
import path from 'node:path';
import os from 'node:os';
import { resolveExecutionCwd } from '../runtime-paths.js';
import { mkdir } from 'node:fs/promises';

// FEATURE_171 (v0.7.41) — runner-driven.ts modular split. The shared
// interfaces and leaf modules below were extracted from this file
// without behavior change; runner-driven.ts re-exports the public names
// (`AmaRole`, `getAmaRoleEffectiveExclude`, `getAmaRoleExpectedToolNames`)
// plus the structural interfaces tests reach for via
// `Parameters<typeof ...>` so import paths in tests and downstream
// callers do not change.
//
// v0.7.42: the `write-turn-cap.ts` leaf (P2b RST-prone provider cap)
// was retired; the `streamMaxDurationMs` + non-streaming fallback
// chain in `registry.ts` is the bench-driven defense for the one
// real RST case (zhipu-coding 308s server kill window).
import {
  getAmaRoleEffectiveExclude,
  getAmaRoleExpectedToolNames,
} from './_internal/managed-task/role-exclude.js';
import {
  extractUserFacingText,
  deriveFinalStatus,
  buildManagedProtocolPayload,
} from './_internal/managed-task/status-derivation.js';
import {
  // FEATURE_193 (v0.7.43): `applyScoutDecisionToPlanRunner` import
  // removed — last consumer (H1 structural-resume overlay block at the
  // top of runManagedTaskViaRunnerInner) deleted alongside the V1
  // Scout role.
  buildObserverBridge,
  buildRunnerRoutingNote,
  MANAGED_WORK_BUDGET_CAP,
  MANAGED_MAX_ROUNDS,
} from './_internal/managed-task/observer-bridge.js';
import {
  wrapEmitterWithRecorder,
  type BudgetExtensionContext,
} from './_internal/managed-task/verdict-recorder.js';
import type {
  AmaRole,
  ObserverBridge,
  RolePromptContextFactory,
  RunnerChainPromptContext,
  VerdictRecorder,
} from './_internal/managed-task/types.js';
import {
  buildRunnerAgentChain,
  type RunnerAgentChain,
} from './_internal/managed-task/agent-chain.js';
import {
  buildRunnerLlmAdapter,
  type RunnerAdapterTokenState,
} from './_internal/managed-task/llm-adapter.js';
import { buildManagedTaskPayload } from './_internal/managed-task/payload-builder.js';
import {
  buildResumePreamble,
  buildStructuralResumeSeed,
  handlePreRunCheckpoint,
  writeCurrentCheckpoint,
  type StructuralResumeSeed,
} from './_internal/managed-task/checkpoint-flow.js';

// Re-export the public surface so existing callers
// (`task-engine.ts`, `runner-driven.test.ts`,
// `runner-driven-tool-wiring.test.ts`) continue to import everything
// from `./runner-driven.js`.
export {
  getAmaRoleEffectiveExclude,
  getAmaRoleExpectedToolNames,
  buildRunnerAgentChain,
  buildRunnerLlmAdapter,
};
export type {
  AmaRole,
  ObserverBridge,
  RolePromptContextFactory,
  RunnerChainPromptContext,
  VerdictRecorder,
  RunnerAgentChain,
  RunnerAdapterTokenState,
};

type RunnerRuntimeSessionController = ReturnType<typeof createExtensionRuntimeSessionController>;
type SessionBindableExtensionRuntime = NonNullable<KodaXOptions['extensionRuntime']> & {
  bindController(controller: RunnerRuntimeSessionController): unknown;
  hydrateSession(sessionId: string): Promise<void>;
};

function isSessionBindableExtensionRuntime(
  runtime: KodaXOptions['extensionRuntime'],
): runtime is SessionBindableExtensionRuntime {
  const candidate: Partial<SessionBindableExtensionRuntime> | undefined = runtime;
  return typeof candidate?.bindController === 'function'
    && typeof candidate.hydrateSession === 'function';
}

function toKodaXInputArtifacts(
  inputArtifacts: readonly QueuedInputArtifact[] | undefined,
): readonly KodaXInputArtifact[] | undefined {
  if (!inputArtifacts || inputArtifacts.length === 0) return undefined;

  return inputArtifacts.map((artifact): KodaXInputArtifact => {
    if (artifact.kind === 'image') {
      return {
        kind: 'image',
        path: artifact.path,
        ...(artifact.mediaType
          ? { mediaType: artifact.mediaType as KodaXImageMediaType }
          : {}),
        ...(artifact.source
          ? { source: artifact.source as KodaXInputArtifactSource }
          : {}),
        ...(artifact.description ? { description: artifact.description } : {}),
      };
    }

    if (artifact.kind === 'video') {
      return {
        kind: 'video',
        path: artifact.path,
        mediaType: artifact.mediaType as KodaXVideoMediaType,
        ...(artifact.name ? { name: artifact.name } : {}),
        ...(artifact.source
          ? { source: artifact.source as KodaXInputArtifactSource }
          : {}),
        ...(artifact.description ? { description: artifact.description } : {}),
      };
    }

    return {
      kind: 'file',
      path: artifact.path,
      ...(artifact.mediaType ? { mediaType: artifact.mediaType } : {}),
      ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {}),
      ...(artifact.name ? { name: artifact.name } : {}),
      ...(artifact.source
        ? { source: artifact.source as KodaXInputArtifactSource }
        : {}),
      ...(artifact.description ? { description: artifact.description } : {}),
    };
  });
}

/**
 * Env-flag check. `KODAX_MANAGED_TASK_RUNTIME=runner` enables the Runner-
 * driven path. Case-insensitive match.
 */
export function isRunnerDrivenRuntimeEnabled(): boolean {
  const value = process.env.KODAX_MANAGED_TASK_RUNTIME?.trim().toLowerCase();
  return value === 'runner';
}

function runnerToolEventMeta(
  events: KodaXOptions['events'] | undefined,
  toolId: string,
  attribution?: { sessionId?: string; agentProfile?: KodaXAgentProfile },
): KodaXToolEventMeta {
  return {
    toolId,
    ...(events?.workflowCorrelation !== undefined ? { workflowCorrelation: events.workflowCorrelation } : {}),
    // FEATURE_247 (R8): session + profile attribution so a host running
    // concurrent Partner/Coder sessions can route tool events. The tool NAME
    // (and thus its sideEffect) is already in the event payload, so it is not
    // duplicated here.
    ...(attribution?.sessionId ? { sessionId: attribution.sessionId } : {}),
    ...(attribution?.agentProfile ? { agentProfile: attribution.agentProfile } : {}),
  };
}

function attachTodoDriftWarnings(
  task: KodaXManagedTask,
  state: TodoDriftReminderState,
): KodaXManagedTask {
  const warnings = getTodoDriftWarnings(state);
  if (warnings.length === 0) return task;
  return {
    ...task,
    runtime: {
      ...task.runtime,
      todoDriftWarnings: [...warnings],
    },
  };
}

function resolveInitialRuntimeThinkingLevel(
  options: KodaXOptions,
): KodaXOptions['effort'] {
  if (options.effort) return options.effort;
  if (!options.reasoningMode) return undefined;
  const mapped = mapLegacyReasoningModeToEffortIntent(options.reasoningMode) as KodaXOptions['effort'] | undefined;
  return mapped ?? options.reasoningMode;
}

// =============================================================================
// Role instructions — moved to `./_internal/managed-task/role-prompts.ts`
// (FEATURE_171 v0.7.41 split). FEATURE_193 (v0.7.43) retired four of the
// five `*_INSTRUCTIONS_FALLBACK` constants (Scout/Planner/Generator/
// Evaluator) and the `renderScoutSkillMapBlock` helper. Only
// `WORKER_INSTRUCTIONS_FALLBACK` + `resolveRoleInstructions` +
// `renderRuntimeVerificationBlock` + `buildCompletionContractStatus`
// remain (imported at the top of this file).
// =============================================================================

// =============================================================================
// VerdictRecorder interface — moved to `./_internal/managed-task/types.ts`
// (FEATURE_171). The interface is re-exported at the top of this file so
// existing import paths keep working.
// =============================================================================

// =============================================================================
// Tool wrapping — moved to `./_internal/managed-task/tool-wrappers.ts` and
// `./_internal/managed-task/dispatch-child.ts` (FEATURE_171 v0.7.41 split).
// `wrapCodingToolAsRunnable` and `wrapDispatchChildTaskForRole` are the live
// tool adapters; retired Generator / Evaluator guard wrappers were removed
// with the V1 chain.
// =============================================================================

// =============================================================================
// FEATURE_168 / FEATURE_171 — AMA agent tool wiring source of truth.
//
// Per-role exclude sets, `AmaRole` type, `getAmaRoleEffectiveExclude` and
// `getAmaRoleExpectedToolNames` moved to
// `./_internal/managed-task/role-exclude.ts` (FEATURE_171 v0.7.41 split).
// The two helpers and the `AmaRole` type are re-exported at the top of
// this file so existing import paths keep working.
// =============================================================================

// =============================================================================
// Agent chain construction — moved to
// `./_internal/managed-task/agent-chain.ts` (FEATURE_171 v0.7.41 split).
// `buildTodoToolBundle`, `buildAgentToolsFromRegistry`, `RunnerAgentChain` and
// `buildRunnerAgentChain` live there. V1 Scout-agent construction has since
// been retired.
// =============================================================================

// =============================================================================
// LLM adapter: KodaX provider stream → RunnerLlmResult
//
// `RunnerAdapterTokenState`, `agentNameToManagedRole`,
// `flattenNormalizedForEmitterInput` and `buildRunnerLlmAdapter` moved to
// `./_internal/managed-task/llm-adapter.ts` (FEATURE_171 v0.7.41 split).
// The public names (`RunnerAdapterTokenState`, `buildRunnerLlmAdapter`)
// are re-exported at the top of this file.
// =============================================================================

// =============================================================================
// Result conversion: RunResult + VerdictRecorder → KodaXResult.
//
// `extractUserFacingText`, `extractUserFacingRaw`, `deriveFinalStatus`
// and `buildManagedProtocolPayload` moved to
// `./_internal/managed-task/status-derivation.ts` (FEATURE_171 v0.7.41
// split). Imported at the top of this file.
// =============================================================================

// =============================================================================
// managedTask payload construction — moved to
// `./_internal/managed-task/payload-builder.ts` (FEATURE_171 v0.7.41 split).
// `harnessToBudget`, `buildManagedTaskPayload`, `deriveQualityAssuranceMode`,
// `buildScoutDecisionRuntime` and `buildSkillMapRuntime` were lifted there
// with byte-parity behavior. `buildManagedTaskPayload` is imported at the
// top of this file (private to the runner-driven flow — not re-exported).
// =============================================================================

// =============================================================================
// Pre-run checkpoint flow + structural resume — moved to
// `./_internal/managed-task/checkpoint-flow.ts` (FEATURE_171 v0.7.41 split).
// `handlePreRunCheckpoint`, `buildResumePreamble`, `StructuralResumeSeed`,
// `buildStructuralResumeSeed` and `writeCurrentCheckpoint` were lifted
// there with byte-parity behavior. Imported at the top of this file
// (private to the runner-driven flow — not re-exported).
// =============================================================================

/**
 * Internal test surface — exports otherwise-private helpers so the
 * runner-driven test file can exercise them directly without booting a
 * full Runner chain. Only the functions / constants listed here are
 * callable from `*.test.ts`; the rest of the module surface stays
 * encapsulated.
 *
 * Added v0.7.26 Risk-5 to cover:
 *   - H1 revise cap auto-conversion (Risk 2)
 *   - Evaluator explicit `budgetRequest` triggering dialog below 90%
 *     threshold (Risk 3)
 *   - Malformed verdict payload passthrough (existing recorder behaviour)
 */
export const __runnerDrivenTestables = {
  wrapEmitterWithRecorder,
  buildStructuralResumeSeed,
  resolveInitialRuntimeThinkingLevel,
} as const;

interface ManagedLiveTurnController {
  currentTurnId(): string;
  startTurn(input: {
    readonly deliveryKind: KodaXTurnDeliveryKind;
    readonly promptId?: string;
  }): string;
}

function resolveAgentSystemPrompt(agent: Agent): string {
  const rawInstructions = typeof agent.instructions === 'function'
    ? agent.instructions(undefined)
    : agent.instructions;
  return buildSystemPrompt(agent, rawInstructions);
}

function dropRunnerInjectedSystemMessage(
  messages: readonly KodaXMessage[],
  agent: Agent,
): readonly KodaXMessage[] {
  const runnerSystemPrompt = resolveAgentSystemPrompt(agent);
  let firstTranscriptIndex = 0;
  while (firstTranscriptIndex < messages.length) {
    const message = messages[firstTranscriptIndex];
    if (
      !message
      || message.role !== 'system'
      || typeof message.content !== 'string'
      || message.content !== runnerSystemPrompt
    ) {
      break;
    }
    firstTranscriptIndex += 1;
  }
  return firstTranscriptIndex > 0 ? messages.slice(firstTranscriptIndex) : messages;
}

function attachTurnIdsFromUserBoundaries(
  messages: readonly KodaXMessage[],
): KodaXMessage[] {
  let activeTurnId: string | undefined;
  return messages.map((message) => {
    if (message.role === 'system') {
      return message;
    }

    if (message.role === 'user') {
      const userTurnId = message.turnId ?? activeTurnId;
      if (userTurnId === undefined) return message;
      activeTurnId = userTurnId;
      return message.turnId === undefined ? { ...message, turnId: userTurnId } : message;
    }

    if (message.turnId !== undefined || activeTurnId === undefined) {
      return message;
    }
    return { ...message, turnId: activeTurnId };
  });
}

export async function runManagedTaskViaRunner(
  options: KodaXOptions,
  prompt: string,
  adapterOverride?: Parameters<typeof buildRunnerLlmAdapter>[1],
  // Shard 6d-L: accept the reasoning plan produced by `createManagedReasoningPlan`
  // in `task-engine.ts`. Optional so direct Runner invocations from tests
  // (or future SDK consumers) still work without constructing a plan.
  plan?: ReasoningPlan,
): Promise<KodaXResult> {
  // FEATURE_103 (v0.7.29): apply L5 user-followup escalation once at the
  // AMA entry. Mirrors the SA `runKodaX` wiring so the bumped ceiling
  // propagates uniformly through createReasoningPlan, buildRunnerLlmAdapter,
  // and the per-iteration L1-L4 resolver inside the Runner loop. When no
  // signal fires, the helper returns the input options reference unchanged.
  const { options: effectiveOptions } = applyFollowupEscalationToOptions(options, prompt);
  await maybeRunMemoryMaintenanceWindow(effectiveOptions);
  await maybeReviewMemoryFeedbackFromPrompt(effectiveOptions, prompt);
  // Fire onSessionStart early so REPL / CLI listeners bound to session
  // init trigger for AMA runs the same way they trigger for SA runs.
  const providerName = effectiveOptions.provider ?? 'anthropic';
  const initialSessionId = effectiveOptions.session?.id
    ?? `runner-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // Ad-hoc askUser callers without a stable host session id get a run-local id:
  // checkpoint resume should prefer a safe miss over cross-session attachment.
  const shouldAttachInitialSessionId = Boolean(effectiveOptions.session?.id)
    || Boolean(effectiveOptions.session?.storage)
    || Boolean(effectiveOptions.events?.askUser);
  const baseOptionsWithSessionId: KodaXOptions = shouldAttachInitialSessionId
    ? {
      ...effectiveOptions,
      session: {
        ...(effectiveOptions.session ?? {}),
        id: initialSessionId,
      },
    }
    : effectiveOptions;
  const requestedLiveTurn = effectiveOptions.context?.liveTurn;
  const liveTurnScope = createLiveTurnScope({
    sessionId: initialSessionId,
    deliveryKind: requestedLiveTurn?.deliveryKind ?? 'initial',
    turnId: requestedLiveTurn?.turnId,
    deliveryId: requestedLiveTurn?.deliveryId,
    promptId: requestedLiveTurn?.promptId,
  });
  const liveTurnScopeRef = { current: liveTurnScope };
  const terminalTurnIds = new Set<string>();
  const liveEvents = withLiveTurnAttribution(baseOptionsWithSessionId.events ?? {}, liveTurnScopeRef);
  const optionsWithSessionId: KodaXOptions = {
    ...baseOptionsWithSessionId,
    events: liveEvents,
  };
  emitSessionStart(liveEvents, { provider: providerName, sessionId: initialSessionId });
  emitTurnStarted(liveEvents, liveTurnScopeRef.current);
  const emitLiveTurnCompleted = (
    status: 'completed' | 'cancelled' | 'interrupted',
  ): void => {
    const scope = liveTurnScopeRef.current;
    if (terminalTurnIds.has(scope.turnId)) return;
    terminalTurnIds.add(scope.turnId);
    emitTurnCompleted(liveEvents, scope, status);
  };
  const emitLiveTurnFailed = (error: Error): void => {
    const scope = liveTurnScopeRef.current;
    if (terminalTurnIds.has(scope.turnId)) return;
    terminalTurnIds.add(scope.turnId);
    emitTurnFailed(liveEvents, scope, error);
  };
  const liveTurnController: ManagedLiveTurnController = {
    currentTurnId: () => liveTurnScopeRef.current.turnId,
    startTurn: (input) => {
      emitLiveTurnCompleted('completed');
      liveTurnScopeRef.current = createLiveTurnScope({
        sessionId: initialSessionId,
        deliveryKind: input.deliveryKind,
        promptId: input.promptId,
      });
      emitTurnStarted(liveEvents, liveTurnScopeRef.current);
      return liveTurnScopeRef.current.turnId;
    },
  };
  try {
    const result = await runManagedTaskViaRunnerInner(
      optionsWithSessionId,
      prompt,
      adapterOverride,
      plan,
      initialSessionId,
      liveTurnController,
    );
    if (result.success) {
      emitLiveTurnCompleted(result.interrupted ? 'interrupted' : 'completed');
    } else {
      emitLiveTurnFailed(new Error(result.errorMetadata?.lastError ?? 'KodaX managed task failed'));
    }
    return result;
  } catch (err) {
    // Surface onError so top-level consumers can flush telemetry /
    // show UI toast before the rejection propagates.
    const error = err instanceof Error ? err : new Error(String(err));
    emitLiveTurnFailed(error);
    emitError(liveEvents, error);
    // v0.7.26 parity (C3): persist an error snapshot so /resume can
    // pick up the last turn even after a crash. Legacy does the same at
    // agent.ts:2824. Best-effort.
    //
    // Runner and the managed LLM adapter attach the latest legal transcript
    // through the shared recovery carrier, which we read via the agent helper.
    // Without that carrier we used to
    // write `messages: []`, which wiped the user's conversation on any
    // permanent error (e.g., deepseek thinking-mode 400) and made the
    // next prompt start as a fresh session.
    if (optionsWithSessionId.session?.storage) {
      try {
        const recoveredMessages = readRunnerRecoveryTranscript(err);
        const messagesToPersist = recoveredMessages
          ? [...recoveredMessages] as KodaXMessage[]
          : [];
        await saveSessionSnapshot(optionsWithSessionId, initialSessionId, {
          messages: messagesToPersist,
          title: prompt.slice(0, 80),
          gitRoot: optionsWithSessionId.context?.gitRoot ?? undefined,
          errorMetadata: {
            lastError: error.message,
            lastErrorTime: Date.now(),
            consecutiveErrors: 1,
          },
        });
      } catch {
        // best-effort.
      }
    }
    throw err;
  } finally {
    // onComplete fires on every terminal — success, block, or error —
    // so REPL can re-render its status bar. NOTE: AMA path's
    // onComplete fires in finally (i.e. AFTER onError on the error
    // branch), whereas SA's onComplete is mutually exclusive with
    // onError (CAP-084). This is a pre-FEATURE_100 behavioral
    // divergence preserved deliberately — REPL listeners on the AMA
    // path rely on the universal-cleanup semantics. Future work to
    // unify would touch REPL contract.
    emitComplete(liveEvents);
  }
}

async function runManagedTaskViaRunnerInner(
  options: KodaXOptions,
  prompt: string,
  adapterOverride: Parameters<typeof buildRunnerLlmAdapter>[1] | undefined,
  plan: ReasoningPlan | undefined,
  resolvedSessionId: string,
  liveTurnController: ManagedLiveTurnController,
): Promise<KodaXResult> {
  // F3 parity (v0.7.26) — apply the diff-driven review routing floor so
  // `decision.reviewTarget` / `reviewScale` / diff-driven `primaryTask`
  // reflect the prompt's review surface. Runs before the Agent chain is
  // built so per-role tool policy + prompt overlay + routing-note strip
  // all see the floored decision. This is informational ONLY — never
  // forces a heavier harness (Scout remains the harness authority).
  // Mirrors legacy `task-engine.ts:6536` position.
  //
  // F4 parity — also snapshot the pre-floor decision so
  // `runtime.rawRoutingDecision` / `finalRoutingDecision` /
  // `routingOverrideReason` can be populated on the managed task shape.
  let rawRoutingDecision: KodaXTaskRoutingDecision | undefined;
  let routingOverrideReason: string | undefined;
  // F4 parity — track capacity fallbacks so the managed task can surface
  // `runtime.toolOutputTruncated` + `toolOutputTruncationNotes`.
  const toolTruncationRef: { truncated: boolean; notes: string[] } = {
    truncated: false,
    notes: [],
  };
  if (plan) {
    const floored = applyCurrentDiffReviewRoutingFloor(
      plan,
      prompt,
      options.context?.repoRoutingSignals,
    );
    rawRoutingDecision = floored.rawDecision;
    routingOverrideReason = floored.routingOverrideReason;
    plan = floored.plan;
  }

  // Shard 6c: honour any pre-existing checkpoint before starting. Gated on
  // `askUser` presence — non-interactive contexts (unit tests, SDK
  // consumers without a prompt surface) skip the directory scan entirely.
  //
  // H1 structural resume (v0.7.26) — when the user picks "Resume":
  //   - Prepend a reconstructed preamble onto the prompt so the LLM has
  //     the prior findings in plain text (even structural skips still
  //     include scout's narrative + last verdict for clarity).
  //   - Build a `StructuralResumeSeed` so the recorder can be preseeded
  //     with scout/contract payloads and Runner.run can enter at
  //     planner/generator instead of scout when prior roles are complete.
  let structuralResumeSeed: StructuralResumeSeed | undefined;
  if (options.events?.askUser) {
    const checkpoint = await handlePreRunCheckpoint(options);
    if (checkpoint) {
      const preamble = buildResumePreamble(checkpoint.resumeFrom);
      prompt = `${preamble}\n${prompt}`;
      structuralResumeSeed = buildStructuralResumeSeed(checkpoint.resumeFrom);
    }
  }

  // v0.7.26 C4 parity — resolve the stable taskId + workspaceDir once and
  // reuse them across every `buildManagedTaskPayload` call in this run.
  // Without this each observer snapshot would generate a fresh id and
  // write to a different folder; skill artifacts could not be referenced
  // by a predictable path either. Mirrors legacy `task-engine.ts:2100`.
  const surface = getManagedTaskSurface(options);
  const taskId = `runner-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const workspaceDir = path.join(getManagedTaskWorkspaceRoot(options, surface), taskId);
  const skillArtifactPaths = getManagedSkillArtifactPaths(workspaceDir);

  // v0.7.26 C4 parity — best-effort pre-run persistence of the expanded
  // skill content (+ skillMap, which Scout refines after its first emit;
  // see the observer hook below). Matches legacy `task-engine.ts:2311`.
  // Role prompts quote the on-disk paths as a stable source of truth so
  // Generator / Evaluator can reopen the skill without relying on prompt-
  // resident copies.
  const skillArtifactsRef: { current: KodaXTaskEvidenceArtifact[] } = { current: [] };
  const skillInvocationCtx = options.context?.skillInvocation;
  if (skillInvocationCtx) {
    try {
      await mkdir(workspaceDir, { recursive: true });
      const initialSkillArtifacts = await writeManagedSkillArtifacts(
        workspaceDir,
        skillInvocationCtx,
        undefined,
      );
      skillArtifactsRef.current = initialSkillArtifacts;
    } catch {
      // Artifact persistence is best-effort — a filesystem error must not
      // abort the AMA run. The prompt sections still reference the paths
      // (Generator / Evaluator will see "artifact not found" if they
      // actually reopen it).
    }
  }

  // Shard 6b: per-run mutation tracker and budget controller. The tracker
  // lives on baseCtx so coding-tool wrappers (write/edit/bash) can populate
  // it via `recordMutationForTool`; the budget controller lives outside
  // and is threaded explicitly into the tool wrappers + emit wrappers.
  const mutationTracker: ManagedMutationTracker = {
    files: new Map<string, number>(),
    totalOps: 0,
    riskyShellOps: 0,
  };
  // baseCtx must carry the full KodaXToolExecutionContext
  // surface that tools expect — without these fields several tool families
  // early-return "... not available" in AMA mode:
  //   - askUser / askUserInput / askUserMulti: ask_user_question,
  //     exit_plan_mode (FEATURE_074) fail silently
  //   - extensionRuntime: all MCP tools (mcp-call / describe / get-prompt /
  //     read-resource / search), web_fetch, web_search, code_search fail
  //   - parentAgentConfig: dispatch_child_task's child-executor falls back
  //     to hardcoded 'anthropic' provider, breaking non-anthropic runs
  //   - reportToolProgress: async-generator tools (dispatch_child_task)
  //     lose their internal progress events
  //   - planModeBlockCheck: child tool calls bypass FEATURE_074 plan-mode
  //     safety boundary
  //   - exitPlanMode: FEATURE_074 exit_plan_mode tool fails
  // CAP-048: build base tool-execution-context via the shared substrate
  // helper so SA and AMA construct ctx through the same path. This
  // delivers two AMA-side regression fixes:
  //   1. `managedProtocolRole` + `emitManagedProtocol` — pre-FEATURE_100
  //      AMA's inline ctx omitted both, so worker tools that called
  //      `ctx.emitManagedProtocol(...)` were no-ops. The substrate
  //      helper wires the closure that mutates the payload ref.
  //   2. FEATURE_074 invariants centralized — set_permission_mode is
  //      explicitly NOT forwarded; FEATURE_067 `onChildProgress: undefined`
  //      is set explicitly. Both contracts now pinned in one helper.
  // The `mutationTracker` field is layered on top because AMA owns its
  // own per-run tracker (substrate has its own).
  // One mutable ledger is inherited by all descendant Agent runtimes. A nested
  // runner must charge the root run instead of silently minting another cap.
  const initialHarness: KodaXHarnessProfile = 'H0_DIRECT';
  const budget: ManagedTaskBudgetController = options.context?.managedWorkBudget ?? {
    totalBudget: MANAGED_WORK_BUDGET_CAP,
    spentBudget: 0,
    currentHarness: initialHarness,
  };
  const runtimeOptions: KodaXOptions = options.context?.managedWorkBudget
    ? options
    : {
        ...options,
        context: { ...options.context, managedWorkBudget: budget },
      };
  const extensionRuntime = options.extensionRuntime;
  const managedProtocolPayloadRef: { current: KodaXManagedProtocolPayload | undefined } = {
    current: undefined,
  };
  const substrateBaseCtx = buildToolExecutionContext({
    options: runtimeOptions,
    // FEATURE_247 (R7) — same session id `sessionIdRef` uses below, so tool
    // handlers can attribute an AMA call to the right concurrent session.
    sessionId: options.session?.id ?? resolvedSessionId,
    runtime: extensionRuntime,
    managedProtocolPayloadRef,
  });
  // FEATURE_097 (v0.7.34) — todo store for the Scout-seeded plan list.
  // Created here so its `onChange` callback can fan changes out to the
  // KodaXEvents bus (`onTodoUpdate`) without each individual mutation
  // site (the `todo_update` tool, the wrapper's verdict-slot
  // auto-handlers) having to remember to fire. Lives for one
  // managed-task run and is dropped when the function returns —
  // task-scoped, not session-scoped, per design §5 ④.
  const todoStore: TodoStore = createTodoStore({
    onChange: (items) => {
      options.events?.onTodoUpdate?.(items);
    },
  });
  // Set when the verdict-slot wrapper marks in_progress → failed
  // on a Generator-targeted revise; consumed at the start of the
  // next Generator turn (the agent's `instructions` closure).
  // Scoped to one task run; survives mid-run handoffs.
  const pendingFailedResetRef: { current: boolean } = { current: false };
  // FEATURE_097 §5 ② — Layer 2 throttle reminder state. Lives for one
  // managed-task run; the LLM adapter increments the counter on each
  // call, the `todo_update` wrapper resets it on success, the agent-
  // transition detector resets it on role switches.
  const todoReminderState = createTodoReminderState();
  const todoDriftReminderState = createTodoDriftReminderState();

  // FEATURE_121 v0.7.40 follow-up — lazy-once summarizer factory.
  // Constructed on first call (when a child task actually triggers the
  // spill-failure + >100KB path), then memoized for the rest of the run.
  // Avoids reconstructing the provider closure on every retry while still
  // keeping construction off the hot path of every Worker turn.
  let cachedSummarizer: ReturnType<typeof createBlobSummarizer> | undefined;
  const summarizeBlob: KodaXToolExecutionContext['summarizeBlob'] = (
    content,
    summaryOpts,
  ) => {
    if (!cachedSummarizer) {
      const provider = resolveProvider(options.provider ?? 'anthropic');
      // Sentinel intentionally `undefined` (not the truthy string 'unknown'):
      // diagnostic error messages in `blob-summarizer.ts` render undefined
      // as `(default)`. Same sentinel-truthiness pitfall as the
      // FEATURE_187 Phase B verifier + stall wiring fix.
      const model = options.modelOverride ?? options.model;
      cachedSummarizer = createBlobSummarizer({
        provider,
        model,
        events: options.events,
      });
    }
    return cachedSummarizer(content, summaryOpts);
  };

  // FEATURE_125 v0.7.41 — Team Mode wiring:
  //   - `contentHashCache` is per-managed-task (one instance per
  //     runner-driven entry; tools `recordRead` on Read and
  //     `checkStale` / `recordWrite` on Edit/MultiEdit/Write). When
  //     KODAX_DISABLE_MULTI_INSTANCE=1 or `getActiveTeamModeWriter()`
  //     returns null we still create the cache — the cache has no
  //     cross-process state, so the safety net is also valuable
  //     against user-manual edits in the same session.
  //   - `siblingSnapshotRef` is a mutable holder kept in sync by
  //     `rolePromptContextFactory` once per LLM round. Tools read it
  //     via the getter defined below so each tool call sees the
  //     freshest snapshot without rebuilding baseCtx.
  const contentHashCache = createContentHashCache();
  // FEATURE_177 v0.7.42 — per-task read-file-state cache (anti-loop).
  // Same lifetime / wiring story as contentHashCache: created here,
  // mounted on baseCtx for every tool execution, cleared by the
  // compaction post-hook (see `buildManagedTaskCompactionHook` call
  // below at line ~1284). Disabled at runtime by
  // KODAX_READ_DEDUP_KILLSWITCH=1 — the factory returns a no-op shim.
  const readFileStateCache = createReadFileStateCache();
  // FEATURE_178 v0.7.42 / FEATURE_187 v0.7.43 — anti-loop stall detector +
  // sidecar orchestrator. Extracted to `runner-stall-sidecar-adapter.ts`
  // (FEATURE_200 Phase A) which owns the detector, the resolved sidecar
  // provider, and the deferred observer ref. Same lifetime as
  // readFileStateCache: the compaction post-hook resets both `stallDetector`
  // and `stallSidecar` (search `stallDetector.reset` / `stallSidecar.reset`).
  // The handle's `.observer` is threaded into the tool-observer chain below;
  // the observer bridge is late-bound via `stallAdapter.attachObserver` once
  // `buildObserverBridge` has run (the onVerdict log emit only fires at
  // runtime on an L2 judgement, always after that point).
  const stallMainProviderName = options.provider ?? 'anthropic';
  const stallAdapter = buildRunnerStallSidecarAdapter({
    mainProvider: resolveProvider(stallMainProviderName),
    mainProviderName: stallMainProviderName,
    mainModel: options.modelOverride ?? options.model,
  });
  const stallDetector = stallAdapter.detector;
  const stallSidecar = stallAdapter.sidecar;
  const siblingSnapshotRef: {
    current: readonly DiscoveredInstance[] | undefined;
  } = { current: undefined };
  const baseCtx: KodaXToolExecutionContext = {
    ...substrateBaseCtx,
    mutationTracker,
    todoStore,
    // FEATURE_119 v0.7.36 Pattern B — substrate now creates the registry
    // (shared between SA and AMA paths). The spread above already carries
    // `substrateBaseCtx.childTaskRegistry`; the dispatch tool gates the
    // async-vs-sync branch on `KODAX_ASYNC_DISPATCH !== '0'`.
    //
    // FEATURE_121 v0.7.40 follow-up — last-resort LLM blob summarizer
    // bound to the Worker's own provider/model. Triggered only by
    // `dispatch-child-tasks` when `applyToolResultGuardrail` returns
    // `spillFailed:true` AND raw content > 100KB.
    summarizeBlob,
    contentHashCache,
    readFileStateCache,
    ...(skillInvocationCtx ? { skillInvocation: skillInvocationCtx } : {}),
  };
  // Mount `siblingSnapshot` as a live getter so tools always see the
  // latest per-round snapshot. The factory below updates the ref in
  // place — no need to rebuild baseCtx between rounds.
  Object.defineProperty(baseCtx, 'siblingSnapshot', {
    get: () => siblingSnapshotRef.current,
    enumerable: true,
    configurable: true,
  });

  const recorder: VerdictRecorder = {};
  // FEATURE_193 (v0.7.43): V1 `recorder.scout` / `recorder.contract`
  // resume-seed restoration removed — slots deleted in v0.7.43 along
  // with the emit tools. Pre-F193 checkpoints carrying these slots
  // resume to an empty recorder (Worker re-runs from the chain head;
  // never observed in production since F193 ships in the same
  // version that drops the emit tools).
  const harnessRef = { current: initialHarness };
  const rolesRef: { emitted: KodaXTaskRole[] } = {
    emitted: structuralResumeSeed ? [...structuralResumeSeed.rolesEmitted] : [],
  };
  const roundRef = { current: 0 };
  const maxRoundsRef = { current: MANAGED_MAX_ROUNDS };
  const budgetApprovalRef = { current: false };
  // Shard 6d-R: append-only evidence entries accumulator. Populated from
  // `onRoleEmit` so each role turn contributes exactly one entry to
  // `managedTask.evidence.entries[]`.
  const entriesRef: { items: KodaXTaskEvidenceEntry[] } = { items: [] };
  // Session id reference — propagated from `options.session` so each
  // entry's `sessionId` mirrors legacy (useful for REPL transcript dump
  // + resume flow when reconstructing per-role session lineage).
  const sessionIdRef: { current: string | undefined } = {
    current: options.session?.id ?? resolvedSessionId,
  };

  // Shard 6c + 6d-N: per-role-emit hook. Two responsibilities:
  //   1. Snapshot write (always on) — mirrors legacy
  //      `writeManagedTaskSnapshotArtifacts` calls after each terminal
  //      worker (task-engine.ts:2405, 6036, 6466, 6532). Persists
  //      `contract.json` / `managed-task.json` / `round-history.json` /
  //      `budget.json` / `memory-strategy.json` / `runtime-contract.json`
  //      / `runtime-execution.md` / `scorecard.json` under
  //      `<workspaceDir>`. Without this the files only exist at terminal
  //      exit; any crash mid-run loses them.
  //   2. Checkpoint write (gated on askUser) — mirrors Shard 6c. Without
  //      an interactive `askUser` callback the user cannot be prompted
  //      to resume, so the checkpoint ledger is dead weight for
  //      non-interactive callers (unit tests, SDK consumers).
  // Issue 127: collect every fire-and-forget checkpoint write so the
  // terminal cleanup can `await Promise.allSettled` them before deleting.
  // Without this, the delete races against the in-flight write — a write
  // that resolves AFTER the delete recreates an orphan checkpoint.json,
  // triggering the "found incomplete task" prompt on the next query
  // even though the task completed successfully.
  const checkpointingEnabled = Boolean(options.events?.askUser);
  const pendingCheckpointWrites: Array<Promise<unknown>> = [];
  const cleanupRunCheckpoint = async (): Promise<void> => {
    if (!checkpointingEnabled) return;
    await Promise.allSettled(pendingCheckpointWrites);
    try {
      await deleteCheckpoint(workspaceDir);
    } catch {
      // best-effort cleanup; stale checkpoints will be handled by
      // handlePreRunCheckpoint on the next run.
    }
  };
  const checkpointWriter = (role: KodaXTaskRole): void => {
    // FEATURE_193 (v0.7.43): legacy Scout-driven skillMap re-persist
    // block removed — Scout role retired, `recorder.scout` deleted.
    // V2 skill artefacts are written pre-run via
    // `writeManagedSkillArtifacts` at the bootstrap site (raw skill +
    // initial skillMap markdown), and never re-derived mid-run.
    void role;
    const snapshot = attachTodoDriftWarnings(buildManagedTaskPayload({
      prompt,
      options,
      recorder,
      rolesEmitted: rolesRef.emitted,
      baseCtx,
      signal: 'COMPLETE',
      budget,
      plan,
      entries: entriesRef.items,
      degradedContinue: degradedContinueRef.current,
      taskId,
      extraArtifacts: skillArtifactsRef.current,
      rawRoutingDecision,
      routingOverrideReason,
      toolOutputTruncated: toolTruncationRef.truncated,
      toolOutputTruncationNotes: toolTruncationRef.notes,
    }), todoDriftReminderState);
    // Snapshot write — best-effort, must not throw out of the observer
    // callback or we'd abort the Runner mid-emit.
    void writeManagedTaskSnapshotArtifacts(snapshot.evidence.workspaceDir, snapshot)
      .catch(() => undefined);
    if (!checkpointingEnabled) {
      return;
    }
    // FEATURE_193 (v0.7.43): `scoutCompleted` always false on V2 (Scout
    // role retired, recorder.scout slot deleted). The checkpoint
    // schema still carries the field for pre-F193 checkpoint compat;
    // V2 writes propagate `false` for every snapshot.
    const scoutCompleted = false;
    const currentRound = rolesRef.emitted.length;
    pendingCheckpointWrites.push(writeCurrentCheckpoint({
      options,
      managedTask: snapshot,
      currentRound,
      completedWorkerIds: rolesRef.emitted.map((r) => r),
      scoutCompleted,
    }));
  };

  const observer = buildObserverBridge(
    options.events,
    harnessRef,
    rolesRef,
    budget,
    roundRef,
    maxRoundsRef,
    budgetApprovalRef,
    entriesRef,
    sessionIdRef,
    checkpointWriter,
  );
  // FEATURE_187 Phase C — late-bind the stall sidecar's deferred observer
  // ref (the adapter was built before `observer` existed). All L2 stall
  // verdicts arrive async via the orchestrator promise — always after this
  // line — so the ref is safely populated before any onVerdict fires.
  stallAdapter.attachObserver(observer);

  // Emit the `routing` phase before Worker preflight so the REPL work-strip
  // can show the pre-run scope/review context before execution starts.
  if (plan && options.events?.onManagedTaskStatus) {
    const routingNote = buildRunnerRoutingNote(plan);
    options.events.onManagedTaskStatus({
      agentMode: 'ama',
      harnessProfile: plan.decision.harnessProfile,
      phase: 'routing',
      note: routingNote,
      upgradeCeiling: plan.decision.upgradeCeiling ?? plan.decision.harnessProfile,
      ...buildManagedStatusBudgetFields(budget, budgetApprovalRef.current),
    });
  }

  observer.preflight();

  const planRef = { current: plan };
  // FEATURE_193 (v0.7.43): V1 scout resume-seed → plan overlay branch
  // removed (Scout role retired, `structuralResumeSeed.recorderSlots.scout`
  // never populated on V2 checkpoints). `planRef.current` stays at the
  // pre-Worker routing decision throughout the run.
  // Shard 6d-U: degraded-continue ref. Flipped by the verdict emitter
  // wrapper when the Evaluator requests an H2 upgrade beyond the plan's
  // `upgradeCeiling`, or when budget-extension approval is denied during
  // revise. Surfaced on `managedTask.runtime.degradedContinue` so the
  // REPL / CLI can warn the user.
  const degradedContinueRef: { current: boolean } = { current: false };
  const budgetExtension: BudgetExtensionContext = {
    events: options.events,
    originalTask: prompt,
    roundRef,
    maxRoundsRef,
    budgetApprovalRef,
    planRef,
    degradedContinueRef,
    harnessRef,
  };
  const tokenStateRef: { current: RunnerAdapterTokenState } = {
    current: { totalTokens: 0, source: 'estimate' },
  };
  // v0.7.40 — API-accurate snapshot ref shared between the LLM adapter
  // (writer: refreshes after each `streamResult.usage`) and the AMA
  // compaction hook (reader: uses for trigger-threshold check via
  // `resolveContextTokenCount`). See `_internal/managed-task/compaction.ts`
  // for the bugfix history (transcript-only estimate vs API-reported
  // total tokens parity gap).
  const contextTokenSnapshotRef: import('./_internal/managed-task/compaction.js').ContextTokenSnapshotRef = {
    current: options.context?.contextTokenSnapshot,
  };
  const messageQueueAgentId = actorMessageQueueId(baseCtx);
  // Build the full role-prompt context so every role's
  // system prompt carries the full surface (decision summary + contract
  // + metadata + verification + tool policy + evidence strategies +
  // dispatch_child_task guidance + H0/H1/H2 quality framework +
  // handoff/verdict/contract block specs). The context factory closes over
  // the recorder so Scout's post-emit `skillMap` / `scope` reach
  // downstream Generator / Evaluator prompts at invocation time.
  // v0.7.26 NEW-1 — resolve workspace environment once so every role
  // prompt can tell the LLM where it is running. The SA path injects
  // `Working Directory: ${executionCwd}` via `buildSystemPrompt`, but
  // the Runner-driven path bypasses that builder. Without this block,
  // Scout/Planner/Generator/Evaluator all guess paths (e.g. the
  // reported `cd /d/user/kodax/workspace` against a real cwd of
  // `C:\Works\GitWorks\...`).
  const managedWorkspace = {
    executionCwd: resolveExecutionCwd(options.context),
    gitRoot: options.context?.gitRoot ?? undefined,
    scratchDir: getSessionScratchDir(options),
    platform: process.platform,
    osRelease: os.release(),
    // Forward the active provider/model so each role's `## Environment`
    // block discloses runtime identity. Mirrors the runtime-fact section
    // the SA path emits via `buildSystemPrompt`'s `getRuntimeFact`.
    provider: options.provider,
    model: options.modelOverride ?? options.model,
  };

  // v0.7.35.1 FEATURE_144 — pre-compute the SA path's capability-context
  // section set ONCE per AMA entry so each role's prompt assembly
  // skips the FS / extension-runtime calls. Filtered to the 6 sections
  // not already covered by `workspaceSection` /
  // `prebuiltRepoIntelligenceContext` / Shard 6d-L overlay stitching:
  //   mcp-capability-context, skills-addendum, project-agents,
  //   tool-construction, git-context, project-snapshot.
  // See `ManagedRolePromptContext.capabilityContextBlock` JSDoc for the
  // exclusion rationale.
  const isNewSessionForCapabilities = !options.session?.initialMessages
    || options.session.initialMessages.length === 0;
  let prebuiltCapabilityContextBlock: string | undefined;
  try {
    const capabilitySections = await buildCapabilityContextSections(
      options,
      isNewSessionForCapabilities,
      managedWorkspace.executionCwd,
    );
    // The AMA Worker owns these sections via `buildWorkerInstructions` /
    // `role-prompt.ts`, so they are excluded from the SA-style capability
    // block to avoid double emission. `execution-guidance` is here because the
    // Worker carries EXECUTION_GUIDANCE inside `buildWorkerInstructions`; the SA
    // path gets the same block via the capability section instead (ADR-043 P1.7).
    // The old `prompt-overlay` section was removed (router overlay retired).
    const AMA_OWNED_SECTION_IDS = new Set<string>([
      'base-system',
      'base-system-suffix',
      'environment-context',
      'runtime-fact',
      'working-directory',
      'session-scratch-directory',
      'repo-intelligence-context',
      'execution-guidance',
    ]);
    const filtered = capabilitySections.filter(
      (section) => !AMA_OWNED_SECTION_IDS.has(section.id),
    );
    if (filtered.length > 0) {
      prebuiltCapabilityContextBlock = filtered
        .map((section) => section.content)
        .join('\n\n');
    }
  } catch (error) {
    // Capability context is best-effort. A failure here must not block
    // the AMA run — workers will fall back to legacy workspaceSection
    // visibility, matching pre-FEATURE_144 behavior. Surface the error
    // through the resilience debug channel so silent degradation is
    // observable when investigating "worker should see MCP/skills/etc.
    // but doesn't" reports.
    emitResilienceDebug('[fea144:capability-context-build-failed]', {
      cwd: managedWorkspace.executionCwd,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const rolePromptContextFactory: RolePromptContextFactory = (role, currentRecorder) => {
    // FEATURE_193 (v0.7.43): `scoutPayload = currentRecorder.scout?.payload.scout`
    // read removed (V1 scout slot deleted). All downstream scoutPayload-derived
    // ctx fields (skillMap, scoutScope, previousRoleSummaries.scout/planner/
    // generator) are permanently undefined on V2.
    void currentRecorder;
    // FEATURE_125 v0.7.41 — Per-LLM-round sibling discovery. Only fires
    // when the Team Mode writer was bootstrapped (REPL session normally;
    // disabled via KODAX_DISABLE_MULTI_INSTANCE=1). The active writer's
    // pid is excluded so we never describe ourselves to the LLM.
    // `discoverInstances` does one readdir + N stat — cheap enough to
    // call on every role-prompt build without caching. Failure is
    // swallowed so a transient fs hiccup never blocks the LLM call.
    let teamModeBlock: string | undefined;
    try {
      const writer = getActiveTeamModeWriter();
      if (writer) {
        const siblings = discoverInstances({ excludePid: writer.pid });
        siblingSnapshotRef.current = siblings;
        if (siblings.length > 0) {
          teamModeBlock = buildOtherInstancesPromptBlock(siblings);
        }
      } else {
        siblingSnapshotRef.current = undefined;
      }
    } catch {
      siblingSnapshotRef.current = undefined;
    }
    const ctx: ManagedRolePromptContext = {
      originalTask: prompt,
      workspace: managedWorkspace,
      capabilityContextBlock: prebuiltCapabilityContextBlock,
      ...(teamModeBlock ? { teamModeSection: teamModeBlock } : {}),
      // FEATURE_143 (v0.7.36): routing-notes overlay flows here so the
      // role-prompt builder can emit it as a system-prompt section.
      // Pre-FEATURE_143 this was stitched onto the user prompt head;
      // see runner-driven.ts:promptWithOverlay for the migration.
      promptOverlay: promptOverlay,
      // FEATURE_114 v0.7.36 Slice 3b — Worker resume signal.
      // `pendingFailedResetRef.current === true` means the Evaluator
      // returned `revise` on the previous turn AND the verdict-slot
      // wrapper armed the failed→pending visual reset. The Worker
      // prompt picks this up via `worker-role-prompt.ts` → prepended
      // retrospective sentence so the LLM treats prior `failed` items
      // as ground truth on the retry. Only relevant for `role==='worker'`;
      // legacy roles ignore the field. Read at factory invocation time
      // (every Runner turn) so the signal stays fresh; the Worker
      // instructions closure consumes the ref AFTER prompt resolution
      // so this read sees the armed state.
      isResumeAfterReviseFailure: role === 'worker'
        ? pendingFailedResetRef.current === true
        : undefined,
    };
    // v0.7.26 C4 parity — surface the caller's skill invocation + the
    // on-disk artefact paths so role prompts can quote a stable filesystem
    // location (skill-execution.md / skill-map.md). Matches legacy
    // `task-engine.ts:withManagedSkillArtifactPromptPaths`.
    if (skillInvocationCtx) {
      ctx.skillInvocation = skillInvocationCtx;
      ctx.skillExecutionArtifactPath = skillArtifactPaths.rawSkillPath;
      ctx.skillMapArtifactPath = skillArtifactPaths.skillMapMarkdownPath;
    }
    // FEATURE_193 (v0.7.43): ctx.skillMap / ctx.scoutScope / ctx.previousRoleSummaries
    // population branches removed — all three derived from V1 `recorder.scout` /
    // `recorder.contract` / `recorder.handoff` slots, retired alongside the V1
    // chain. On V2 the Worker role gets the skillMap / scope context from
    // `ctx.skillInvocation` + the routing-overlay system-prompt section
    // (FEATURE_143). No cross-role summary is needed (single-role V2 chain).
    return ctx;
  };
  // Pre-compute the repo-intelligence context block once per
  // Runner-driven entry so every role's system prompt carries repo
  // overview + changed scope + active module + impact metadata from
  // turn 1. Best-effort: failure to build must not fail the run.
  //
  // `isNewSession` mirrors the `messages.length === 1` heuristic used by
  // `runKodaX` at agent.ts:2423 — when the session has no prior messages,
  // we're on the user's first turn and want the full repo overview.
  let prebuiltRepoIntelligenceContext: string | undefined;
  if (plan) {
    const isNewSessionRunner = !options.session?.initialMessages
      || options.session.initialMessages.length === 0;
    try {
      prebuiltRepoIntelligenceContext = await buildAutoRepoIntelligenceContext(
        options,
        plan,
        isNewSessionRunner,
        options.events,
      );
    } catch {
      // Swallow — repo-intel injection is best-effort; the run must
      // continue even if repo-intel capture fails.
    }
  }

  const chainPromptContext: RunnerChainPromptContext | undefined = plan
    ? {
      prompt,
      // M4 parity — resolve decision from planRef at invocation time so
      // post-Scout plan updates (applyScoutDecisionToPlanRunner) reach
      // downstream Generator / Evaluator prompts. Without the thunk, the
      // captured `plan.decision` would keep pre-Scout harness / routing
      // notes and leak H2-only prompt guidance into H1 workers.
      decision: () => planRef.current?.decision ?? plan.decision,
      metadata: options.context?.taskMetadata,
      repoIntelligenceContext: prebuiltRepoIntelligenceContext,
      // FEATURE_247 (R1): thread the SDK-consumer profile's instructions into
      // the Worker role prompt (prepended). Undefined for the default Coding
      // Agent, so the produced prompt is byte-identical to today.
      partnerInstructions: options.context?.agentProfile?.instructions,
      // FEATURE_193 (v0.7.43): V1 Scout-driven mutation-intent + harness
      // branching retired. `buildManagedWorkerToolPolicy` now takes only
      // `role` and returns undefined for V2 Worker (prompt-enforced
      // discipline). The factory closure stays to preserve the
      // `(role, recorder) => policy` interface the agent runtime expects.
      toolPolicyFactory: (role) => buildManagedWorkerToolPolicy(role),
      contextFactory: rolePromptContextFactory,
    }
    : undefined;
  const chain = buildRunnerAgentChain(
    baseCtx,
    recorder,
    observer,
    budget,
    budgetExtension,
    planRef,
    options.context?.taskVerification,
    chainPromptContext,
    options.events,
    todoStore,
    pendingFailedResetRef,
    todoReminderState,
    // FEATURE_114 v0.7.36 Slice 3c — workspace cwd for the
    // deterministic per-step evaluator. The check spawns
    // `npm run build/test/lint` here when a todo flips to completed
    // with an evaluator hint. Production always has a cwd; the
    // override slot is for tests only and stays undefined in the
    // hot path.
    managedWorkspace.executionCwd,
  );
  // FEATURE_193 (v0.7.43): FEATURE_078 Scout `downstream_reasoning_hint`
  // callback retired — Scout role gone, no payload to surface. The
  // adapter still accepts the getter slot for signature compatibility;
  // it permanently returns `undefined` on V2.
  // Per-run iteration counter shared with the adapter. `runOnce` resets it
  // to 0 at the top of every fresh `Runner.run` so the `iter` reported to
  // `onIterationStart`/`onIterationEnd` stays in the same per-invocation
  // scope as the Runner's tool loop (`iter <= maxIter` holds across
  // idle-yield resumes instead of accumulating past the cap).
  const iterationStateRef = { current: 0 };
  const llm = buildRunnerLlmAdapter(
    options,
    adapterOverride,
    tokenStateRef,
    () => undefined,
    contextTokenSnapshotRef,
    todoStore,
    todoReminderState,
    iterationStateRef,
    todoDriftReminderState,
  );

  // FEATURE_143 (v0.7.36) — `plan.promptOverlay` (routing-notes block:
  // task-family guidance, work intent, brainstorm directives,
  // provider-policy notes, explicit-reason trail) is now routed
  // through the role-prompt builder's system-prompt section
  // (`ManagedRolePromptContext.promptOverlay`), matching the SA-path
  // `capability-sections.ts` injection surface. The previous Shard 6d-L
  // stitching put this onto the user prompt head, which made the
  // routing notes look like user input to the LLM instead of platform
  // truth. The user prompt now carries only the actual user request.
  const promptOverlay = plan?.promptOverlay?.trim();
  const promptWithOverlay = prompt;

  // Session continuity: when the caller passes `options.session.initialMessages`
  // (REPL multi-turn, session resume, plan-mode replay), prepend them as the
  // Runner transcript so the Scout/Planner/Generator/Evaluator see full
  // prior context — same behaviour as the SA-mode entry via the session
  // loader.
  //
  // v0.7.26 parity (C1): the user message content is built through
  // `buildPromptMessageContent(prompt, inputArtifacts)` so images pasted
  // /dragged into the REPL (carried on `options.context.inputArtifacts`)
  // reach the Scout turn as multimodal content blocks. Without this the
  // LLM sees a plain-text prompt and never perceives the image —
  // round-boundary reshape only rewrites outgoing `result.messages` for
  // display, not the inbound prompt — apply the lift here so the AMA
  // entry message carries multimodal blocks like the SA entry does.
  //
  // CAP-008: resolve initial messages through the substrate helper so AMA
  // gets the same three-tier resolution SA gets:
  //   1. caller-supplied `options.session.initialMessages` (REPL multi-turn,
  //      plan-mode replay, explicit resume) — preferred
  //   2. `options.session.storage.load(sessionId)` — recover a previously
  //      persisted session (`/resume <id>` / `--continue`) when no inline
  //      messages were provided. Pre-FEATURE_100 the AMA path skipped this
  //      tier and started fresh; substrate parity restores it.
  //   3. empty messages — first turn / unknown session
  const resolvedInitial = await resolveInitialMessages(options, options.session?.id ?? resolvedSessionId);
  const runtimeSessionState = buildRuntimeSessionState({
    loadedExtensionState: resolvedInitial.loadedExtensionState,
    loadedExtensionRecords: resolvedInitial.loadedExtensionRecords,
    // FEATURE_247 (R2): profile tool-visibility policy after excludeTools.
    activeTools: applyToolVisibilityPolicy(
      filterExcludedTools(
        listToolDefinitions().map((tool) => tool.name),
        options.context?.excludeTools,
      ),
      options.context?.toolVisibilityPolicy,
    ),
    modelSelection: {
      provider: options.provider,
      model: options.modelOverride ?? options.model,
    },
    thinkingLevel: resolveInitialRuntimeThinkingLevel(options),
  });
  const userMessageContent = buildPromptMessageContent(
    promptWithOverlay,
    options.context?.inputArtifacts,
  );
  const currentUserMessage: KodaXMessage = {
    role: 'user',
    content: userMessageContent,
    turnId: liveTurnController.currentTurnId(),
    timestamp: new Date().toISOString(),
  };
  const runnerInput = resolvedInitial.messages.length > 0
    ? [...resolvedInitial.messages, currentUserMessage]
    : [currentUserMessage];

  // Load the compaction hook once per run. `intelligentCompact` runs
  // before every provider.stream call; the Runner-driven path routes
  // it through Runner's
  // `compactionHook` (FEATURE_179 v0.7.42: fired at the TOP of every
  // tool-loop iteration, BEFORE the LLM call — was previously fired after
  // each tool-result append, which skipped text-only end-of-turn + idle-
  // yield sessions and let them grow 60K+ past threshold before next
  // tool call triggered). Without this wiring, long AMA sessions hit
  // context window overflow and 400.
  //
  // v0.7.40 — pass `contextTokenSnapshotRef` so the hook's trigger
  // check uses API-accurate token accounting (`usage.totalTokens` +
  // delta) instead of the transcript-only estimate that silently
  // missed the threshold by the system + tools schema overhead.
  // FEATURE_193 (v0.7.43): V1 chain (Scout/Planner/Generator) retired. The
  // Worker single-loop is the only entry path.
  const entryAgent: Agent = chain.worker;
  const resolvedContextCapacity = await resolveManagedTaskContextCapacity(options);
  const compactionHook = await buildManagedTaskCompactionHook(options, {
    resolvedContextCapacity,
    contextTokenSnapshotRef,
    activeToolDefinitions: entryAgent.tools,
    // FEATURE_177 v0.7.42 — clear the read-file-state cache after a
    // real compaction. The cache returns stubs that point the LLM at
    // earlier `tool_result` blocks; after summarization those blocks
    // may no longer be in context, so the stub would no longer be
    // actionable. Clearing forces the next Read to serve real content.
    //
    // FEATURE_178 v0.7.42 — same logic for the stall orchestrator.
    // After compaction, the earlier tool_result content the model was
    // implicitly referencing is gone. A "repeat" call against the
    // same path after compaction is now legitimate (re-priming the
    // model with content it can no longer see). Reset the detector,
    // transcript buffer, AND any pending nudge so we don't fire on
    // legitimate post-compact re-reads or inject a now-stale nudge.
    onPostCompact: () => {
      readFileStateCache.clear();
      stallDetector.reset();
      stallSidecar.reset();
    },
  });
  const toolResultBatchOptions = {
    ctx: baseCtx,
    contextWindow: resolvedContextCapacity.contextWindow,
    reservedResponseTokens:
      resolvedContextCapacity.provider.getEffectiveMaxOutputTokens(
        resolvedContextCapacity.activeModel,
      ),
    contextTokenSnapshotRef,
    onCapacityFallback: (call: import('@kodax-ai/agent').RunnerToolCall) => {
      toolTruncationRef.truncated = true;
      toolTruncationRef.notes.push(
        `${call.name}: result spilled because the complete tool-result batch exceeded model capacity`,
      );
    },
  };
  baseCtx.maximumInputTokens = resolvedContextCapacity.contextWindow;
  baseCtx.resolveToolResultCapacityTokens = (messages) => (
    resolveRunnerToolResultBudget(messages, toolResultBatchOptions).aggregateInlineTokens
  );
  const toolResultBatchTransform = createRunnerToolResultBatchTransform(toolResultBatchOptions);

  // structuralResumeSeed survives on the type only for backward-compat
  // reading of legacy V1 checkpoints. V2 resume from V1 checkpoints isn't
  // supported, so those checkpoints fall back to a fresh Worker entry.
  // Surface Runner tool-loop invocations through the KodaXEvents
  // channels the worker ledger consumes. Without this wiring the REPL
  // worker ledger stays empty mid-run — only the final formal output
  // reaches the user (observed regression report: "除了正式输出之外的
  // 任何别的信息都看不到"). Legacy agent.ts fired events.onToolResult at
  // three sites per invocation (success / error / cancelled); the
  // Runner observer's `onToolCall` hook dispatches
  // `options.events.onToolUseStart`, and its `onToolResult` hook
  // dispatches `options.events.onToolResult`.
  //
  // FEATURE_187 (v0.7.43) Phase D — toolObserver assembled via
  // `composeToolObservers` for explicit precedence. Observers in
  // order: (1) `stallSidecar.observer` runs first so its
  // pending-nudge consume in beforeTool gates everything else (a
  // permission denial AFTER nudge consume would swallow the nudge);
  // (2) `permissionEventsObserver` handles CAP-010 permission gate +
  // CAP-035 visibility filter + events.onToolUseStart /
  // events.onToolResult dispatch + F4 truncation tracking.
  // (3) `todoDriftObserver` records warn-only todo drift telemetry and
  // arms the next-turn nudge after successful real work.
  // composeToolObservers short-circuits beforeTool on the first
  // non-pass verdict (so stall nudge correctly blocks downstream
  // permission); fans out onToolCall / onToolResult to every observer.
  const permissionEventsObserver: RunnerToolObserver = {
    // CAP-010 tri-state permission gate: plan-mode / accept-edits /
    // extension "tool:before" hooks run here. Delegates to the shared
    // substrate helper so SA and AMA evaluate the same gate chain —
    // pre-FEATURE_100 the AMA path only invoked
    // `events.beforeToolExecute` and dropped the extension
    // `tool:before` branch entirely; substrate parity restores it.
    // Tri-state contract preserved verbatim: undefined → allow;
    // CANCELLED_TOOL_RESULT_MESSAGE → cancel; other string → block
    // with that string as the synthesized tool_result content.
    beforeTool: async (call) => {
      if (options.events) {
        const override = await getToolExecutionOverride(
          options.events,
          call.name,
          call.input,
          call.id,
          options.context?.executionCwd,
          options.context?.gitRoot ?? undefined,
        );
        if (override === undefined) return true;
        if (override === CANCELLED_TOOL_RESULT_MESSAGE) return false;
        return override;
      }
      return true;
    },
    onToolCall: (call) => {
      // CAP-035: filter internal control-plane tools (emit_managed_protocol,
      // etc.) so REPL transcript doesn't surface them. Pre-FEATURE_100
      // AMA emitted every tool call regardless of visibility — REPL
      // showed `emit_managed_protocol` invocations as if they were
      // user-facing. SA always filtered via isVisibleToolName; AMA now
      // does too.
      if (!isVisibleToolName(call.name)) return;
      options.events?.onToolUseStart?.({
        name: call.name,
        id: call.id,
        input: call.input,
      }, runnerToolEventMeta(options.events, call.id, {
        sessionId: sessionIdRef.current,
        agentProfile: options.context?.agentProfile,
      }));
    },
    onToolResult: (call, result) => {
      // Track tool-declared truncation that occurred before batch admission.
      // Capacity fallback itself is recorded by `onCapacityFallback` above.
      const meta = result.metadata as { truncated?: boolean; policy?: unknown } | undefined;
      if (meta?.truncated) {
        toolTruncationRef.truncated = true;
        toolTruncationRef.notes.push(
          `${call.name}: tool returned truncated output`,
        );
      }
      // CAP-035: same visibility filter on the result side.
      if (!isVisibleToolName(call.name)) return;
      const content = result.content;
      options.events?.onToolResult?.({
        id: call.id,
        name: call.name,
        content:
          typeof content === 'string'
            ? content
            : (content as readonly KodaXToolResultContentItem[])
                .filter((i) => i.type === 'text')
                .map((i) => (i.type === 'text' ? i.text : ''))
                .join(''),
      }, runnerToolEventMeta(options.events, call.id, {
        sessionId: sessionIdRef.current,
        agentProfile: options.context?.agentProfile,
      }));
    },
  };
  const todoDriftObserver = createTodoDriftObserver({
    todoStore,
    state: todoDriftReminderState,
    onWarning: (event) => {
      options.events?.onTodoDriftWarning?.(event);
    },
  });
  const runnerToolObserver = composeToolObservers(
    stallSidecar.observer,
    permissionEventsObserver,
    todoDriftObserver,
  );

  // FEATURE_184 Sidecar Verifier stop-hook wiring — extracted to
  // `runner-sidecar-verifier-adapter.ts` (FEATURE_200 Phase A.2). The adapter
  // owns verifier provider resolution, the captured-verdict ref, the sidecar +
  // extension-fallback hooks, and `currentAgentRoleRef` (flipped below by
  // `onAgentSwitched`). The verdict side-effect (`applySidecarVerdictToRecorder`,
  // which needs recorder/todoStore/budget/budgetExtension) stays here as the
  // `onVerdict` callback so the adapter need not depend on that whole surface.
  const verifierAdapter = buildRunnerSidecarVerifierAdapter({
    mainProvider: resolveProvider(options.provider ?? 'anthropic'),
    mainProviderName: options.provider ?? 'anthropic',
    mainModel: options.modelOverride ?? options.model,
    mutationTracker,
    observer,
    // FEATURE_247 (R3): profile default merged with per-task verification.
    verification: resolveEffectiveVerification(options),
    onVerdict: (verdict, context) => {
      // FEATURE_247 (R3/R8): attribute the verdict to its session + profile.
      emitSidecarMessageEvent(options.events, verdict, context, {
        sessionId: sessionIdRef.current,
        agentProfile: options.context?.agentProfile,
      });
      void applySidecarVerdictToRecorder({
        recorder,
        observer,
        verdict,
        todoStore,
        pendingFailedResetRef,
        budget,
        budgetExtension,
      }).catch(() => undefined);
    },
    getSessionId: () => sessionIdRef.current,
    getActiveDescendantTurnCount: () => activeDescendantTurnCount(baseCtx),
    getRoundCount: () => roundRef.current,
    getHasPlan: () => todoStore.getAll().length > 0,
  });
  const resolvedVerifier = verifierAdapter.resolvedVerifier;
  const composedStopHook = verifierAdapter.composedStopHook;
  const currentAgentRoleRef = verifierAdapter.currentAgentRoleRef;

  // FEATURE_192 v0.7.44 — `/goal` lifecycle adapter. See
  // `runner-goal-adapter.ts` for the full composition rationale.
  // Pre-extraction this block was ~80 LoC inline; the adapter module
  // owns the goal-accounting + sendMessage-counter-reset + base-drain
  // composition so runner-driven stays at the dispatch-loop layer.
  const baseBeforeNextTurn: (ctx: {
    readonly transcript: readonly KodaXMessage[];
    readonly iteration: number;
  }) => Promise<readonly KodaXMessage[]> = async () => {
    // FEATURE_164 mid-turn user-prompt drain.
    const drained = getMessageQueue().dequeue({
      agentId: messageQueueAgentId,
      maxPriority: 'user',
      mode: 'prompt',
    });
    if (drained.length === 0) return [];
    const validatedMessagesWithoutTurn = drained.map((m) => {
      const inputArtifacts = toKodaXInputArtifacts(m.inputArtifacts);
      validateInputArtifactsForModel(inputArtifacts ?? [], {
        provider: options.provider,
        model: options.modelOverride ?? options.model,
      });
      return {
        role: 'user' as const,
        content: buildPromptMessageContent(m.content, inputArtifacts),
      };
    });
    const queuedTurnId = liveTurnController.startTurn({
      deliveryKind: 'queued',
      promptId: drained[0]?.id,
    });
    const timestamp = new Date().toISOString();
    const validatedMessages = validatedMessagesWithoutTurn.map((message) => ({
      ...message,
      turnId: queuedTurnId,
      timestamp,
    }));
    options.events?.onMidTurnUserMessages?.(drained.map((m) => m.content));
    return validatedMessages;
  };
  // Transcript snapshot ref — populated by the adapter's beforeNextTurn
  // each turn boundary; read by the goal verifyComplete closure when
  // `update_goal({complete})` fires mid-turn.
  const goalTranscriptRef: { current: readonly KodaXMessage[] } = {
    current: [],
  };
  const { beforeNextTurn, stopHook } = buildRunnerGoalAdapter({
    goalRuntime: options.context?.goalRuntime,
    tokenStateRef,
    baseCtx,
    baseBeforeNextTurn,
    composedStopHook,
    transcriptRef: goalTranscriptRef,
    mutationTracker,
    verifierProvider: resolvedVerifier?.provider,
    verifierModel: resolvedVerifier?.model,
  });

  // One-shot Runner invocation closure, used by the idle-yield outer
  // loop. Lifting it to a named function lets the wrapper reuse the
  // same llm / guardrails / observer / compactionHook / stop-hook the
  // chain itself runs with, so resumed turns are indistinguishable from
  // initial turns.
  //
  // Returned type retains the full `RunResult` shape (output + messages
  // + sessionId), not the wrapper's narrower `RunWithIdleYieldRunResult`
  // (the wrapper only requires `messages`, so the wider type is
  // structurally OK).
  const runOnce = (agent: Agent, input: readonly KodaXMessage[]) => {
    // Reset the iteration counter for this fresh Runner.run so the
    // reported `iter` shares scope with the Runner's tool loop (which
    // counts 0..iterationCap). Across idle-yield resumes each runOnce is a
    // new Runner.run with its own loop, so the counter restarts here —
    // keeping `iter <= maxIter` true rather than accumulating across runs.
    iterationStateRef.current = 0;
    return Runner.run(agent, input, {
      llm,
      abortSignal: options.abortSignal,
      compactionHook,
      toolResultBatchTransform,
      toolObserver: runnerToolObserver,
      // FEATURE_164 (v0.7.41) — mid-turn user-prompt injection.
      // FEATURE_192 v0.7.44 Phase F — wrapped with `withGoalBeforeNextTurn`
      // when an active `/goal` binding is present (no-op otherwise).
      // Definition is hoisted to the `beforeNextTurn` const built just
      // above `runOnce` so the wrapping happens once.
      beforeNextTurn,
      // FEATURE_166 (v0.7.41 follow-up) — agent-switch UI label flip.
      // Fires once per handoff after the agent runtime has fully
      // committed the transition (target's system prompt installed,
      // inputFilter applied). Map the new agent's name to a role
      // and ask the observer to update the REPL's
      // `activeWorkerTitle` so the next streaming output renders
      // under the correct label instead of the stale Worker label.
      //
      // The mapping is intentionally a local switch (NOT
      // `agentNameToManagedRole` at line ~3048) because that helper
      // is wired into the fenced-fallback synth path and adding
      // Worker there would change verdict-synthesis behaviour. The
      // shape duplicates `onIdleWaiting`'s mapping below — both
      // need Worker recognised; the fallback helper does not.
      onAgentSwitched: ({ to }) => {
        // FEATURE_193 (v0.7.43): V1 chain retired — `chain.worker` is the
        // only agent in the V2 chain, so SCOUT_AGENT_NAME / PLANNER_AGENT_NAME
        // / GENERATOR_AGENT_NAME branches are dead. Mapping reduced to the
        // Worker check; unknown agent names produce `undefined` (consumer
        // leaves the label untouched).
        const switchedRole: KodaXTaskRole | undefined =
          to.name === WORKER_AGENT_NAME ? 'worker' : undefined;
        // FEATURE_184 (v0.7.45) Phase C.1: update the current-agent role
        // ref so composedStopHook can gate the sidecar verifier to
        // generator/worker turns only.
        if (switchedRole) currentAgentRoleRef.current = switchedRole;
        observer.agentSwitched(switchedRole);
      },
      // FEATURE_184 (v0.7.45) Phase D.2 — Composed Stop hook:
      // sidecar verifier (first-party) → extension `turn:complete`
      // bridge (second-party). Constructed above; see comment block
      // preceding `runOnce`. When sidecar returns `revise` or `blocked`
      // the extension chain is intentionally NOT consulted — first-
      // party precedence guarantees architectural defenses cannot be
      // silently overridden by user-installed extensions.
      //
      // FEATURE_192 v0.7.44 Phase F — wrapped with `withGoalStopHook`
      // when an active `/goal` binding is present so a Worker text-
      // only termination on an active goal returns a continuation
      // prompt and the Runner reanimates the loop.
      stopHook,
      // Iteration cap for the entire chain. Core's default (20) is
      // meant for stand-alone single-agent runs and is far too low
      // for a multi-role investigation + execution + verify chain.
      // This is a hard SAFETY ceiling — the real throttle is the
      // budget controller (H0=100 / H1=H2=200 base, +100/+200 on
      // 90%-threshold user approval). A 500-turn ceiling allows
      // 2-3 extensions plus ample room for tool-heavy iterations
      // (each LLM turn can carry multiple parallel tool calls).
      // The budget-extension dialog (Shard 6b) catches the user at
      // the 90% threshold long before this cap, so reaching 500
      // genuinely indicates a prompt / tool-design bug worth
      // flagging.
      // Shared with the LLM adapter as the reported `maxIter` denominator
      // so the SDK iteration callbacks reflect the real cap, not a stale 20.
      maxToolLoopIterations: MANAGED_TASK_MAX_TOOL_LOOP_ITERATIONS,
    }).catch(async (err: unknown) => {
      // Issue 127: clean up checkpoint on abort (Esc / Ctrl-C) and
      // any LLM / Runner error before the rejection propagates.
      // Without this, a non-success terminal exit leaves a fresh
      // checkpoint.json on disk, which the next query's
      // findValidCheckpoint scan picks up and triggers the "found
      // incomplete task" prompt.
      await cleanupRunCheckpoint();
      throw err;
    });
  };

  // FEATURE_155 (v0.7.39) idle-yield outer loop, wrapped by
  // FEATURE_120 v0.7.39 Step 0c's `runWithIdleYield` generic helper.
  //
  // When the agent exits via the no-tool-calls + pending-children +
  // no-handoff branch, the loop waits for an external wake event
  // (child completion or inbound queue message), splices a synthetic
  // user message that surfaces the wake content, and re-enters
  // `Runner.run` so the agent can observe and react.
  //
  // Bug A-G hotfix invariants preserved through the wrapper:
  //   - Bug A (registry cleanup): owned by `registerChildTask`
  //     (`@kodax-ai/agent`).
  //   - Bug B+D (terminal-verdict + handoff gates): `computeSnapshot`
  //     reads from `recorder` — the canonical chain state —
  //     **not** `managedProtocolPayloadRef`. The V2 chain's
  //     `emit_handoff` / `emit_verdict` tools return metadata via
  //     `wrapEmitterWithRecorder` (line ~947); reading
  //     `managedProtocolPayloadRef.current.*` would silently make
  //     both gates always-false and break the loop only on
  //     `lastAssistantToolCallCount > 0`, masking the bug except on
  //     text-only turns after emit_verdict with pending children
  //     (the 2026-05-11 production trace). `revise` is excluded
  //     from the terminal gate (chain re-runs Worker/Generator).
  //   - Bug E (fast-child race): `hasPendingBackgroundMessages`
  //     reads the queue alongside the registry. A child that
  //     completes within the current `Runner.run` iteration has its
  //     `.finally(delete)` race with `enqueueChildTaskNotification`;
  //     the banner sits in the background queue waiting for
  //     `composeIdleYieldUserMessage` to drain it. Without this
  //     gate the loop would break and strand the banner.
  //
  //     FEATURE_159 follow-up: the filter MUST narrow to
  //     `mode:'task-notification'`. `maxPriority:'background'` is
  //     inclusive of user priority (see
  //     `packages/agent/src/messaging/queue.ts` `priorityWithinMax`
  //     — rank ≤ 1 includes user + background), so without the mode
  //     narrow, a user-priority `mode:'prompt'` queued follow-up
  //     leaks into this banner-only gate. That makes
  //     `detectIdleYield` return true even with zero pending
  //     children, splicing the user's prompt into the same round via
  //     `composeIdleYieldUserMessage` (which surfaces it as the
  //     mode-split real user message) instead of letting
  //     `runQueuedPromptSequence` start a fresh round through
  //     `stageQueuedPrompt`. End-user symptom: agent echoes Q1
  //     verbatim then stops; Q2 never gets answered.
  //   - Bug F (abort listener cleanup): owned by the agent-layer
  //     `waitForWakeEvent`.
  const runResult = await (async () => {
    const sessionRuntime = isSessionBindableExtensionRuntime(extensionRuntime)
      ? extensionRuntime
      : undefined;
    const releaseRuntimeBindingCandidate = sessionRuntime?.bindController(
      createExtensionRuntimeSessionController(runtimeSessionState),
    );
    const releaseRuntimeBinding = typeof releaseRuntimeBindingCandidate === 'function'
      ? releaseRuntimeBindingCandidate
      : undefined;

    try {
      if (sessionRuntime) {
        // Storage-hydrated state is the baseline; hydrateSession runs after
        // binding so extension runtimes can reconcile and intentionally win
        // duplicate-key conflicts for the current runtime version.
        await sessionRuntime.hydrateSession(options.session?.id ?? resolvedSessionId);
      }
      return await runWithIdleYield({
    initialAgent: entryAgent,
    initialInput: runnerInput,
    runOnce,
    computeSnapshot: (rr) => {
      // Bug B+D: read from recorder, NOT managedProtocolPayloadRef.
      const verdictStatusForGate = recorder.verdict?.payload?.verdict?.status;
      return {
        lastAssistantToolCallCount: countLastAssistantToolCalls(rr.messages),
        pendingChildTaskCount: activeDescendantTurnCount(baseCtx),
        // FEATURE_193 (v0.7.43): `recorder.handoff` deleted along with
        // `emit_handoff`. The idle-yield gate kept this flag to
        // distinguish "Generator emitted handoff" from "Worker ended
        // without dispatching" on V1; on V2 only Worker runs and the
        // gate falls through to the child-registry + verdict check.
        hasEmittedHandoff: false,
        hasEmittedTerminalVerdict:
          verdictStatusForGate === 'accept' || verdictStatusForGate === 'blocked',
        // Bug E: queue arm alongside registry arm. Strictly
        // task-notification banners — see comment above for the
        // FEATURE_159 follow-up that narrowed this filter.
        hasPendingBackgroundMessages: getMessageQueue().has({
          agentId: messageQueueAgentId,
          maxPriority: 'background',
          mode: 'task-notification',
        }),
      };
    },
    messageQueue: getMessageQueue(),
    // Worker runs as the main thread; the dispatch handler enqueues
    // child notifications with `parentAgentId: undefined` (default
    // main-thread target). Match that here so the queue arm sees
    // them.
    agentId: messageQueueAgentId,
    abortSignal: options.abortSignal,
    // Worker stays the entry agent on resume — the multi-role chain's
    // prior turns are reflected in `rr.messages`, so the Runner's
    // transition logic will pick up where the Worker left off (the
    // handoff slot is empty, so no handoff replay races).
    resumeAgent: () => chain.worker,
    // Child results stay raw at enqueue time. Immediately before resume, use
    // the same physical next-request budget as ordinary tool-result batches,
    // including any user prompt that shares this wake-up request.
    envelopeAggregateEnforcer: createEnvelopeAggregateBudgetEnforcer(
      baseCtx,
      (capacityContext) => capacityContext
        ? resolveRunnerToolResultBudget(
            [
              ...capacityContext.transcript,
              ...capacityContext.pendingMessages,
            ],
            {
              ctx: baseCtx,
              contextWindow: resolvedContextCapacity.contextWindow,
              reservedResponseTokens:
                resolvedContextCapacity.provider.getEffectiveMaxOutputTokens(
                  resolvedContextCapacity.activeModel,
                ),
              contextTokenSnapshotRef,
            },
          )
        : undefined,
    ),
    onIdleWaiting: (currentAgent) => {
      // FEATURE_156 — surface "alive but suspended" to the REPL.
      // Agent-agnostic identity lookup: today only the Worker can
      // reach this (see `dispatch-child-tasks.ts` role guard +
      // `hasEmittedHandoff` gate in `detectIdleYield`), but the
      // wiring carries no role-specific assumption — if any chain
      // ever opens idle-yield to a different role, the status emit
      // picks up the change. Note: we count the registry, NOT
      // registry + queue — the background-banner-only case is the
      // transient "fast-child race recovery" sub-state
      // (`pendingCount === 0` + `idleWaiting === true`) which the
      // status-bar renders as "idle — resuming".
      // FEATURE_193 (v0.7.43): V1 chain retired — Worker is the only
      // agent that can reach idle-yield (dispatch-child-tasks.ts role
      // guard restricts dispatch to Worker on V2). The SCOUT / PLANNER
      // / GENERATOR_AGENT_NAME branches are dead.
      const idleRole: KodaXTaskRole | undefined =
        currentAgent.name === WORKER_AGENT_NAME ? 'worker' : undefined;
      observer.idleWaiting(idleRole, activeDescendantTurnCount(baseCtx));
    },
    // FEATURE_213 (v0.7.45) — a follow-up typed while waiting for a sub-agent
    // is drained by the idle-yield WAKE path (`composeIdleYieldUserMessage`),
    // NOT the `beforeNextTurn` mid-turn drain, so it reached the agent but
    // never the UI. Route it to the same `onMidTurnUserMessages` sink so it is
    // recorded + rendered in the transcript exactly like a mid-turn message.
    onResumedUserPrompts: (contents) => {
      options.events?.onMidTurnUserMessages?.(contents);
    },
    resolveResumeTurnId: () => liveTurnController.startTurn({ deliveryKind: 'queued' }),
    // `maxIterations` omitted — wrapper defaults to 64, matching the
    // legacy `IDLE_YIELD_MAX_ITERATIONS` constant. The cap fires on
    // the (max+1)th iteration AFTER runOnce returns but BEFORE the
    // snapshot, so a legitimate run that completes at the cap still
    // returns its result.
      });
    } finally {
      releaseRuntimeBinding?.();
    }
  })();

  // Issue 127 (review feedback): clean up the checkpoint EARLY — the
  // moment Runner.run resolves successfully — so any throw from the
  // post-run synchronous block below (`buildManagedTaskPayload` /
  // `observer.completed`'s user-provided callbacks) cannot bypass
  // cleanup and leave an orphan. None of the post-run code reads
  // checkpoint.json from disk, so deleting it early is semantically
  // equivalent to the original late-cleanup placement, just with
  // broader error coverage.
  await cleanupRunCheckpoint();

  // FEATURE_184 (v0.7.45) Phase C.2: F167 Evaluator terminal-verdict
  // fallback (B0/B1/B2 retry/synth block) deleted. The in-chain Evaluator
  // is gone (Phase C.1); Sidecar Verifier StopHook (Phase D.2) handles
  // post-execution verification. No synthetic verdict path needed.
  const effectiveRunResult = runResult;

  const lastText = extractUserFacingText(effectiveRunResult);
  const { signal, verdictStatus, reason, userAnswer } = deriveFinalStatus(recorder);

  // Evaluator's user_answer may carry internal role
  // framing ("I verified the Generator…", "Let me double-check…") even
  // after the fence sanitizer runs. Strip that framing specifically for
  // review-like tasks where the evaluator was told to speak as the
  // reviewer, not about the review process. For non-review tasks, still
  // run the lighter sanitizer to drop control-plane markers + fences.
  const sanitizedUserAnswer = userAnswer
    ? (plan?.decision.primaryTask === 'review'
      ? sanitizeEvaluatorPublicAnswer(userAnswer)
      : sanitizeManagedUserFacingText(userAnswer))
    : undefined;

  // Prefer the verdict's explicit user_answer over the final transcript
  // text when the Evaluator provided one — it's the intentional final
  // answer, while transcript text may be any last assistant turn.
  const resolvedText = sanitizedUserAnswer && sanitizedUserAnswer.trim().length > 0
    ? sanitizedUserAnswer
    : lastText;

  const managedProtocolPayload = buildManagedProtocolPayload(recorder);
  const managedTask = attachTodoDriftWarnings(buildManagedTaskPayload({
    prompt,
    options,
    recorder,
    rolesEmitted: rolesRef.emitted,
    baseCtx,
    signal,
    verdictStatus,
    userAnswer,
    budget,
    plan,
    entries: entriesRef.items,
    degradedContinue: degradedContinueRef.current,
    taskId,
    extraArtifacts: skillArtifactsRef.current,
    rawRoutingDecision,
    routingOverrideReason,
    toolOutputTruncated: toolTruncationRef.truncated,
    toolOutputTruncationNotes: toolTruncationRef.notes,
  }), todoDriftReminderState);

  observer.completed(signal, reason ?? userAnswer);

  // FEATURE_193 (v0.7.43): Shard 6d-k Scout suspicious-completion
  // detection block removed. The heuristic gated on
  // `recorder.scout?.payload.scout` to infer mutation intent + flag
  // direct-path completions that lacked scout-confirmed evidence. With
  // the V1 Scout role retired, `recorder.scout` is permanently
  // undefined; the block would either no-op or false-positive on every
  // V2 H0_DIRECT run. The `onScoutSuspiciousCompletion` event remains
  // in the SDK surface (pre-1.0 compat) but is never fired by the
  // Runner-driven path.

  // Populate contextTokenSnapshot so the REPL token-counter UI can
  // refresh when the run completes. `baselineEstimatedTokens` stays
  // equal to currentTokens when the provider returned usage — the REPL
  // uses the delta only to adjust subsequent local estimates.
  const tokenState = tokenStateRef.current;
  const persistedTranscriptMessages = dropRunnerInjectedSystemMessage(
    effectiveRunResult.messages,
    entryAgent,
  );
  const resultMessages = attachTurnIdsFromUserBoundaries(persistedTranscriptMessages);
  const contextTokenSnapshot = contextTokenSnapshotRef.current
    ? rebaseContextTokenSnapshot(resultMessages, contextTokenSnapshotRef.current)
    : tokenState.source === 'api'
      ? {
          currentTokens: tokenState.totalTokens,
          baselineEstimatedTokens: estimateTokens(resultMessages),
          source: 'api' as const,
          usage: tokenState.lastUsage,
        }
      : undefined;

  const result: KodaXResult = {
    // FEATURE_184 (v0.7.45) Phase C.1: success=false when the run is
    // blocked, regardless of source — sidecar verdict (verdictStatus=
    // 'blocked') or Generator-level blocked handoff (signal='BLOCKED').
    success: signal !== 'BLOCKED' && verdictStatus !== 'blocked',
    lastText: resolvedText,
    signal,
    signalReason: reason,
    messages: resultMessages,
    // FEATURE_173 (v0.7.42) Part A — kill `runner-${epoch}` ghost-session
    // double-write. Caller-supplied `options.session.id` (the REPL session
    // file, format `YYYYMMDD_HHMMSS`) always wins. `runOnce` does NOT
    // currently pass an agent-layer Session into Runner.run (would trigger
    // `session.append()`), so `effectiveRunResult.sessionId` is always
    // undefined for production callers. The fallback is the same id emitted
    // through onSessionStart, keeping hydrate/result/snapshot keys aligned
    // even when callers omit an explicit session.id.
    sessionId: options.session?.id ?? effectiveRunResult.sessionId ?? resolvedSessionId,
    managedProtocolPayload,
    managedTask,
    contextTokenSnapshot,
    // Shard 6d-L: surface the reasoning plan's routing decision so
    // downstream consumers (REPL breadcrumb, session storage, evaluator
    // guardrails) can read `routingDecision.primaryTask` /
    // `.mutationSurface` / `.taskFamily` the same way they did on the
    // legacy path.
    routingDecision: plan?.decision,
  };
  const runtimeSessionSnapshot = snapshotRuntimeSessionState(
    runtimeSessionState,
    { includeUnchanged: false },
  );
  if (runtimeSessionSnapshot) {
    result.runtimeSessionSnapshot = runtimeSessionSnapshot;
  }

  // Shard 6d-i: capture task-scoped repo-intelligence snapshots
  // (repo-overview / changed-scope / active-module / impact-estimate /
  // summary.md) into `<workspaceDir>/repo-intelligence/` and merge the
  // resulting `KodaXTaskEvidenceArtifact` records into the task's
  // `evidence.artifacts`. Mirrors legacy `attachManagedTaskRepoIntelligence`
  // (task-engine.ts:4302). Also emits the four-stage
  // `onRepoIntelligenceTrace` events during capture.
  //
  // Best-effort: failure to capture must not fail the task run.
  let managedTaskWithRepoIntel = managedTask;
  try {
    managedTaskWithRepoIntel = await attachManagedTaskRepoIntelligence(options, managedTask);
  } catch {
    // fall through with the unaugmented task.
  }
  // Keep the KodaXResult.managedTask aligned with the augmented copy so
  // downstream consumers read the same artifact set whether they use the
  // REPL managedTask event or the final result payload.
  result.managedTask = managedTaskWithRepoIntel;

  // Shard 6d-h: persist the managed-task snapshot set under the task
  // workspace directory and leave the artifact records already attached
  // to `managedTask.evidence.artifacts` pointing at files that actually
  // exist on disk. Legacy behaviour (`writeManagedTaskArtifacts` at
  // task-engine.ts:5204) — without this, `contract.json` / `managed-
  // task.json` / `result.json` / `round-history.json` / `budget.json` /
  // `memory-strategy.json` / `runtime-contract.json` / `runtime-
  // execution.md` / `scorecard.json` / `continuation.json` are all
  // missing and any downstream consumer that reads artifact paths
  // (resume, harness UI, evaluator reshape) sees a broken ledger.
  //
  // Best-effort: an artifact-write failure (permission denied, disk
  // full) must not fail the task run itself — the in-memory result is
  // still valid.
  try {
    await writeManagedTaskArtifacts(
      managedTaskWithRepoIntel.evidence.workspaceDir,
      managedTaskWithRepoIntel,
      {
        success: result.success,
        lastText: result.lastText,
        sessionId: result.sessionId,
        signal: result.signal,
        signalReason: result.signalReason,
        signalDebugReason: result.signalDebugReason,
      },
    );
  } catch {
    // best-effort; failures should not abort the task run.
  }

  // Persist session snapshot to disk so `/resume <id>` and `--continue`
  // can reload the AMA conversation. The Runner-driven path has a
  // single non-error terminal (here). `saveSessionSnapshot` early-
  // returns when `options.session?.storage` is undefined and absorbs
  // any `storage.save` rejections internally (CAP-013-003 closed in
  // P3.6a), so we don't need a guard or try/catch at this call site.
  //
  // FEATURE_060 Track 2: pass `result.messages` by reference instead of
  // spreading. `result.messages` was already cloned at line 4676 from
  // `runResult.messages`; spreading again here would create a third
  // in-memory copy of the full transcript. `saveSessionSnapshot` does
  // not mutate the passed array (it forwards directly to
  // `storage.save`), so reference-passing is safe.
  await saveSessionSnapshot(options, result.sessionId, {
    messages: result.messages,
    title: prompt.slice(0, 80),
    gitRoot: options.context?.gitRoot ?? undefined,
    runtimeSessionState,
  });

  return result;
}
