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
import type { Agent, StopHookFn } from '@kodax-ai/agent';
import { Runner, getMessageQueue } from '@kodax-ai/agent';
import {
  GENERATOR_AGENT_NAME,
  PLANNER_AGENT_NAME,
  SCOUT_AGENT_NAME,
  WORKER_AGENT_NAME,
} from '../agents/task-engine-agents.js';
// FEATURE_114 v0.7.36 — gates the AMA Harness V2 single-loop path.
// Returns false when `KODAX_HARNESS_V2` is unset or anything other than
// 'true' (case-insensitive). Slice 3b consumes this in two places:
// (a) entry-agent selection (chain.scout vs chain.worker), and
// (b) Evaluator's revise handoff target (Generator vs Worker).
import { isHarnessV2Enabled } from '../agents/worker-role-prompt.js';

import { resolveProvider } from '../providers/index.js';
import { buildCapabilityContextSections } from '../prompts/capability-sections.js';
import {
  buildAutoRepoIntelligenceContext,
  emitResilienceDebug,
  saveSessionSnapshot,
} from '../agent.js';
import type {
  KodaXHarnessProfile,
  KodaXManagedProtocolPayload,
  KodaXOptions,
  KodaXResult,
  KodaXRoleRoundSummary,
  KodaXTaskEvidenceArtifact,
  KodaXTaskEvidenceEntry,
  KodaXTaskRole,
  KodaXTaskRoutingDecision,
  KodaXToolExecutionContext,
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
import {
  buildManagedWorkerToolPolicy,
  inferScoutMutationIntent,
} from './_internal/managed-task/tool-policy.js';
import { applyCurrentDiffReviewRoutingFloor } from './_internal/managed-task/review-routing.js';
import { createTodoStore, type TodoStore } from './todo-store.js';
import { createExtensionTurnCompleteStopHook } from '../agent-runtime/middleware/extension-queue.js';
import {
  createSidecarVerifierStopHook,
} from '../agent-runtime/middleware/sidecar-verifier/verifier.js';
import { buildVerifierContext } from '../agent-runtime/middleware/sidecar-verifier/verifier-context-builder.js';
import { applySidecarVerdictToRecorder } from '../agent-runtime/middleware/sidecar-verifier/verifier-recorder-bridge.js';
import { resolveVerifierProvider } from '../agent-runtime/middleware/sidecar-verifier/verifier-provider-resolver.js';
import { createTodoReminderState } from './todo-throttle-reminder.js';
import {
  SUSPICIOUS_LAST_TEXT_PREVIEW_LIMIT,
  detectScoutSuspiciousSignals,
} from './_internal/managed-task/scout-signals.js';
import type { ManagedRolePromptContext } from './_internal/managed-task/role-prompt-types.js';
import {
  sanitizeEvaluatorPublicAnswer,
  sanitizeManagedUserFacingText,
} from './_internal/managed-task/sanitize.js';
import { buildManagedTaskCompactionHook } from './_internal/managed-task/compaction.js';
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
import { createStallDetector } from '../multi-instance/stall-detector.js';
import { createStallOrchestrator } from '../multi-instance/stall-orchestrator.js';
import {
  REPORT_TOOL as STALL_REPORT_TOOL,
  SIDECAR_SYSTEM_PROMPT as STALL_SIDECAR_SYSTEM_PROMPT,
} from '../multi-instance/stall-sidecar-prompts.js';
import { createScopeAwareHarnessGuardrail } from '../agent-runtime/middleware/scope-aware-harness-guardrail.js';
import { createToolResultTruncationGuardrail } from '../tools/tool-result-truncation-guardrail.js';
import { createEnvelopeAggregateBudgetEnforcer } from '../tools/envelope-budget.js';
import { createBlobSummarizer } from '../tools/blob-summarizer.js';
import { buildPromptMessageContent } from '../input-artifacts.js';
// CAP-003/004/005/006/007: shared event emit helpers. Both SA (substrate
// frame) and AMA (this runner-driven path) fire through the same
// surface so the contract for each event lives in exactly one place.
import {
  emitComplete,
  emitError,
  emitSessionStart,
  isVisibleToolName,
} from '../agent-runtime/event-emitter.js';
// CAP-008: shared initial-messages resolver. Three-tier fallback
// (inline → storage.load → empty) for AMA frame entry; SA already
// uses this from `run-substrate.ts`.
import { resolveInitialMessages } from '../agent-runtime/middleware/auto-resume.js';
// CAP-010: shared tri-state permission gate. AMA's
// `toolObserver.beforeTool` delegates to this so the extension
// `tool:before` hook fires on AMA path (pre-FEATURE_100 only SA hit
// it).
import { getToolExecutionOverride } from '../agent-runtime/permission-gate.js';
import { CANCELLED_TOOL_RESULT_MESSAGE } from '../constants.js';
// CAP-048: shared tool-execution-context builder. Centralizes
// FEATURE_074 (set_permission_mode NOT forwarded) and FEATURE_067
// (onChildProgress undefined) invariants so AMA and SA can't drift.
import { buildToolExecutionContext } from '../agent-runtime/tool-execution-context.js';
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
  applyScoutDecisionToPlanRunner,
  buildObserverBridge,
  buildRunnerRoutingNote,
  BUDGET_CAP_BY_HARNESS,
  MAX_ROUNDS_BY_HARNESS,
} from './_internal/managed-task/observer-bridge.js';
import {
  H1_MAX_SAME_HARNESS_REVISES,
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
  buildRunnerScoutAgent,
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
  buildRunnerScoutAgent,
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

/**
 * Env-flag check. `KODAX_MANAGED_TASK_RUNTIME=runner` enables the Runner-
 * driven path. Case-insensitive match.
 */
export function isRunnerDrivenRuntimeEnabled(): boolean {
  const value = process.env.KODAX_MANAGED_TASK_RUNTIME?.trim().toLowerCase();
  return value === 'runner';
}

// =============================================================================
// Role instructions — moved to `./_internal/managed-task/role-prompts.ts`
// (FEATURE_171 v0.7.41 split). Five `*_INSTRUCTIONS_FALLBACK` constants,
// `renderScoutSkillMapBlock`, `resolveRoleInstructions`,
// `renderRuntimeVerificationBlock` and `buildCompletionContractStatus`
// are imported at the top of this file.
// =============================================================================

// =============================================================================
// VerdictRecorder interface — moved to `./_internal/managed-task/types.ts`
// (FEATURE_171). The interface is re-exported at the top of this file so
// existing import paths keep working.
// =============================================================================

// =============================================================================
// Tool wrapping — moved to `./_internal/managed-task/tool-wrappers.ts` and
// `./_internal/managed-task/dispatch-child.ts` (FEATURE_171 v0.7.41 split).
// `wrapCodingToolAsRunnable`, `wrapGeneratorBashWithMutationGuard`,
// `wrapGeneratorWriteWithMutationGuard`, `wrapReadOnlyBash` and
// `wrapDispatchChildTaskForRole` are imported at the top of this file.
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
// `CodingToolBundle`, `buildCodingToolBundle`, `buildAgentToolsFromRegistry`,
// `RunnerAgentChain`, `buildRunnerAgentChain` and `buildRunnerScoutAgent`
// were lifted there with byte-parity behavior. The public names
// (`RunnerAgentChain`, `buildRunnerAgentChain`, `buildRunnerScoutAgent`)
// are re-exported at the top of this file so existing import paths in
// `task-engine.ts` and tests keep working.
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
  H1_MAX_SAME_HARNESS_REVISES,
  buildStructuralResumeSeed,
} as const;

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
  // Fire onSessionStart early so REPL / CLI listeners bound to session
  // init trigger for AMA runs the same way they trigger for SA runs.
  const providerName = effectiveOptions.provider ?? 'anthropic';
  const initialSessionId = effectiveOptions.session?.id
    ?? `runner-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (effectiveOptions.events) {
    emitSessionStart(effectiveOptions.events, { provider: providerName, sessionId: initialSessionId });
  }
  try {
    return await runManagedTaskViaRunnerInner(effectiveOptions, prompt, adapterOverride, plan);
  } catch (err) {
    // Surface onError so top-level consumers can flush telemetry /
    // show UI toast before the rejection propagates.
    const error = err instanceof Error ? err : new Error(String(err));
    if (effectiveOptions.events) emitError(effectiveOptions.events, error);
    // v0.7.26 parity (C3): persist an error snapshot so /resume can
    // pick up the last turn even after a crash. Legacy does the same at
    // agent.ts:2824. Best-effort.
    //
    // Inner catch (runManagedTaskViaRunnerInner) attaches the in-flight
    // providerMessages on the thrown error via __kodaxRecoveredMessages
    // so we can persist real history. Without that carrier we used to
    // write `messages: []`, which wiped the user's conversation on any
    // permanent error (e.g., deepseek thinking-mode 400) and made the
    // next prompt start as a fresh session.
    if (effectiveOptions.session?.storage) {
      try {
        const recoveredMessages = (err as { __kodaxRecoveredMessages?: unknown })
          ?.__kodaxRecoveredMessages;
        const messagesToPersist = Array.isArray(recoveredMessages)
          ? (recoveredMessages as KodaXMessage[])
          : [];
        await saveSessionSnapshot(effectiveOptions, initialSessionId, {
          messages: messagesToPersist,
          title: prompt.slice(0, 80),
          gitRoot: effectiveOptions.context?.gitRoot ?? undefined,
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
    if (effectiveOptions.events) emitComplete(effectiveOptions.events);
  }
}

async function runManagedTaskViaRunnerInner(
  options: KodaXOptions,
  prompt: string,
  adapterOverride: Parameters<typeof buildRunnerLlmAdapter>[1] | undefined,
  plan: ReasoningPlan | undefined,
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
  // F4 parity — track tool-output truncation so the managed task can
  // surface `runtime.toolOutputTruncated` + `toolOutputTruncationNotes`.
  // The guardrail's `afterTool.rewrite` sets `result.metadata.truncated`
  // which the `toolObserver.onToolResult` hook below harvests.
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
  const extensionRuntime = options.extensionRuntime;
  const managedProtocolPayloadRef: { current: KodaXManagedProtocolPayload | undefined } = {
    current: undefined,
  };
  const substrateBaseCtx = buildToolExecutionContext({
    options,
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
      const model = options.modelOverride ?? options.model ?? 'unknown';
      cachedSummarizer = createBlobSummarizer({ provider, model });
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
  // FEATURE_178 v0.7.42 — anti-loop stall detector + sidecar
  // orchestrator. The detector (rule-based L1) records every tool
  // invocation and fires when `(toolName, input)` repeats hit a
  // threshold. The orchestrator wraps the detector with the L2
  // sidecar invocation (validated SHIP-SIDECAR-ALL in eval `1909d5d2`)
  // and a small transcript buffer; on a stall + isStuck=true verdict
  // it queues a nudge string that the next `beforeTool` gate consumes
  // as a synthesized tool_result. Same lifetime as readFileStateCache;
  // compaction post-hook resets both. Killswitch:
  // KODAX_STALL_DETECT=0 returns a no-op detector (the orchestrator
  // never sees a stall signal, never fires the sidecar).
  const stallDetector = createStallDetector();
  const stallOrchestrator = createStallOrchestrator({
    detector: stallDetector,
    provider: resolveProvider(options.provider ?? 'anthropic'),
    systemPrompt: STALL_SIDECAR_SYSTEM_PROMPT,
    reportTool: STALL_REPORT_TOOL,
  });
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
  };
  // Mount `siblingSnapshot` as a live getter so tools always see the
  // latest per-round snapshot. The factory below updates the ref in
  // place — no need to rebuild baseCtx between rounds.
  Object.defineProperty(baseCtx, 'siblingSnapshot', {
    get: () => siblingSnapshotRef.current,
    enumerable: true,
    configurable: true,
  });

  // Budget controller. Start with H0 cap (50); `wrapEmitterWithRecorder`
  // upgrades the cap when Scout confirms a non-H0 tier. Mirrors the
  // legacy `createManagedBudgetController` + Scout-commit bump pattern.
  //
  // H1 structural resume: when a checkpoint seeded a non-H0 harness,
  // start the budget at the saved tier's cap. Spent is reset — the LLM
  // enters a fresh turn on resume, so prior spend shouldn't eat into the
  // new run's envelope (same contract as legacy resumeManagedTask:
  // `createManagedBudgetController` always started at 0).
  // FEATURE_114 v0.7.36 + v0.7.39 fix — V2 Worker has no analogue of
  // Scout's `emit_scout_verdict.confirmedHarness` upgrade payload, so a
  // fresh V2 run that initialized at `H0_DIRECT` would stay there for
  // its entire lifetime and inherit the H0 budget (100 turns) /
  // max-rounds (1). Users see this as "默认轮数 200 → 100 退化" after
  // the V2 default flip in Slice 7. PLANNED is the V2-equivalent
  // profile (budget=200, max-rounds=8, identical envelope to H2) so
  // we anchor fresh V2 runs there at init. Resume seeds still
  // override — they carry the committed harness from the prior
  // session. V1 path (`KODAX_HARNESS_V2=false`) is bit-for-bit
  // preserved: it starts at H0_DIRECT and upgrades when Scout emits
  // a verdict, exactly as before.
  const initialHarness: KodaXHarnessProfile =
    structuralResumeSeed?.harness ?? (isHarnessV2Enabled() ? 'PLANNED' : 'H0_DIRECT');
  const budget: ManagedTaskBudgetController = {
    totalBudget: BUDGET_CAP_BY_HARNESS[initialHarness],
    spentBudget: 0,
    currentHarness: initialHarness,
  };

  const recorder: VerdictRecorder = {};
  if (structuralResumeSeed?.recorderSlots.scout) {
    recorder.scout = structuralResumeSeed.recorderSlots.scout;
  }
  if (structuralResumeSeed?.recorderSlots.contract) {
    recorder.contract = structuralResumeSeed.recorderSlots.contract;
  }
  const harnessRef = { current: initialHarness };
  const rolesRef: { emitted: KodaXTaskRole[] } = {
    emitted: structuralResumeSeed ? [...structuralResumeSeed.rolesEmitted] : [],
  };
  const roundRef = { current: 0 };
  const maxRoundsRef = { current: MAX_ROUNDS_BY_HARNESS[initialHarness] };
  const budgetApprovalRef = { current: false };
  // Shard 6d-R: append-only evidence entries accumulator. Populated from
  // `onRoleEmit` so each role turn contributes exactly one entry to
  // `managedTask.evidence.entries[]`.
  const entriesRef: { items: KodaXTaskEvidenceEntry[] } = { items: [] };
  // Session id reference — propagated from `options.session` so each
  // entry's `sessionId` mirrors legacy (useful for REPL transcript dump
  // + resume flow when reconstructing per-role session lineage).
  const sessionIdRef: { current: string | undefined } = {
    current: options.session?.id,
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
    // v0.7.26 C4 parity — when Scout emits with a freshly derived
    // skillMap, re-persist the skill artefacts so downstream roles and
    // resume consumers can reach the structured map on disk. Best-effort;
    // the artefact paths in the role prompt stay valid even when the
    // re-write fails (the raw skill was written pre-run).
    if (role === 'scout' && skillInvocationCtx) {
      const scoutSkillMap = recorder.scout?.payload.scout?.skillMap;
      // Reconstruct the full KodaXSkillMap shape from Scout's emit payload
      // (which only carries a subset of fields). Missing fields fall back
      // to safe defaults so `writeManagedSkillArtifacts` + downstream
      // consumers render correctly.
      const fullSkillMap = scoutSkillMap
        ? {
            skillSummary: scoutSkillMap.skillSummary ?? '',
            executionObligations: scoutSkillMap.executionObligations ?? [],
            verificationObligations: scoutSkillMap.verificationObligations ?? [],
            requiredEvidence: [],
            ambiguities: scoutSkillMap.ambiguities ?? [],
            projectionConfidence: scoutSkillMap.projectionConfidence ?? 'medium',
            rawSkillFallbackAllowed: true,
          }
        : undefined;
      void writeManagedSkillArtifacts(workspaceDir, skillInvocationCtx, fullSkillMap)
        .then((records) => {
          skillArtifactsRef.current = records;
        })
        .catch(() => undefined);
    }
    const snapshot = buildManagedTaskPayload({
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
    });
    // Snapshot write — best-effort, must not throw out of the observer
    // callback or we'd abort the Runner mid-emit.
    void writeManagedTaskSnapshotArtifacts(snapshot.evidence.workspaceDir, snapshot)
      .catch(() => undefined);
    if (!checkpointingEnabled) {
      return;
    }
    const scoutCompleted = Boolean(recorder.scout);
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

  // H3 parity (v0.7.26) — emit the `routing` phase before Scout's
  // preflight. Legacy `task-engine.ts:6545` fired this event right after
  // the routing decision was finalised so the REPL's AMA work-strip could
  // render "AMA routing · <scope>" before Scout starts thinking. Without
  // it, the UI jumped straight to `preflight` and the routing context
  // (review target, repo signals, override reason) was invisible.
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
  // H1 structural resume (v0.7.26) — when scout is pre-seeded from a
  // checkpoint, the observer's `onRoleEmit` path never runs for scout on
  // this turn, so downstream role prompts would otherwise see the pre-
  // scout plan decision (wrong harness, wrong routing notes). Apply the
  // seeded scout payload to the plan immediately so planner/generator/
  // evaluator see the post-scout plan on their first turn. Mirrors the
  // legacy `applyScoutDecisionToPlan` invocation inside
  // `resumeManagedTask`.
  if (structuralResumeSeed?.recorderSlots.scout?.payload.scout && planRef.current) {
    const seededScout = structuralResumeSeed.recorderSlots.scout.payload.scout;
    planRef.current = applyScoutDecisionToPlanRunner(planRef.current, {
      confirmedHarness: seededScout.confirmedHarness,
      harnessRationale: seededScout.harnessRationale,
      summary: seededScout.summary,
    });
  }
  // Shard 6d-U: degraded-continue ref. Flipped by the verdict emitter
  // wrapper when the Evaluator requests an H2 upgrade beyond the plan's
  // `upgradeCeiling`, or when budget-extension approval is denied during
  // revise. Surfaced on `managedTask.runtime.degradedContinue` so the
  // REPL / CLI can warn the user.
  const degradedContinueRef: { current: boolean } = { current: false };
  // Risk-2 fix — per-harness revise counter. The wrapper mutates this
  // map in place so consecutive Evaluator emits across the same run
  // share state. Initialised empty; first revise of any harness passes
  // through and bumps to 1, second triggers the cap logic.
  const reviseCountByHarnessRef: { current: Map<KodaXHarnessProfile, number> } = {
    current: new Map(),
  };
  const budgetExtension: BudgetExtensionContext = {
    events: options.events,
    originalTask: prompt,
    roundRef,
    maxRoundsRef,
    budgetApprovalRef,
    planRef,
    degradedContinueRef,
    harnessRef,
    reviseCountByHarnessRef,
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
    current: undefined,
  };
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
    // FEATURE_143 (v0.7.36): `prompt-overlay` is no longer "AMA-owned"
    // via the user-prompt stitching path — it now flows through the
    // role-prompt builder's `promptOverlaySection`. Keeping it in the
    // exclusion list still makes sense (we don't want SA-style
    // duplicate emission alongside the role-prompt section), so the
    // ID stays in this set as a deduplication guard.
    const AMA_OWNED_SECTION_IDS = new Set<string>([
      'base-system',
      'base-system-suffix',
      'environment-context',
      'runtime-fact',
      'working-directory',
      'repo-intelligence-context',
      'prompt-overlay',
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
    const scoutPayload = currentRecorder.scout?.payload.scout;
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
    if (scoutPayload?.skillMap) {
      // The scout emit payload carries a subset of KodaXSkillMap fields
      // (skill_summary, execution_obligations, verification_obligations,
      // ambiguities, projection_confidence). Fill the remaining fields
      // with safe defaults so `formatSkillMapSection` renders correctly.
      ctx.skillMap = {
        skillSummary: scoutPayload.skillMap.skillSummary ?? '',
        executionObligations: scoutPayload.skillMap.executionObligations ?? [],
        verificationObligations: scoutPayload.skillMap.verificationObligations ?? [],
        requiredEvidence: [],
        ambiguities: scoutPayload.skillMap.ambiguities ?? [],
        projectionConfidence: scoutPayload.skillMap.projectionConfidence ?? 'medium',
        rawSkillFallbackAllowed: true,
      };
    }
    // Scout's scope hints are only relevant to post-Scout roles (Issue 119).
    // v0.7.26 loop-fix: also carry `confirmedHarness` so downstream
    // `inferScoutMutationIntent` calls can recognise execute harnesses
    // and stop misclassifying "review primaryTask + empty scope" as
    // review-only when Scout actually picked H1_EXECUTE_EVAL or
    // H2_PLAN_EXECUTE_EVAL.
    if (role !== 'scout') {
      const scope = scoutPayload?.scope ?? [];
      const reviewFilesOrAreas = scoutPayload?.reviewFilesOrAreas ?? [];
      const confirmedHarness = scoutPayload?.confirmedHarness;
      if (scope.length > 0 || reviewFilesOrAreas.length > 0 || confirmedHarness) {
        ctx.scoutScope = {
          scope: [...scope],
          reviewFilesOrAreas: [...reviewFilesOrAreas],
          confirmedHarness,
        };
      }
    }
    // M1 parity (v0.7.26) — populate `previousRoleSummaries` from the
    // recorder so each downstream role sees a distilled summary of what
    // the prior roles produced. Legacy carried this via
    // `ManagedWorkerSessionStorage`, where per-worker state accumulated
    // across rounds. Runner-driven doesn't have that storage; as a
    // minimum faithful port, synthesise each `KodaXRoleRoundSummary`
    // directly from the recorder's captured emit payloads so
    // role-prompt's `previousRoleSummarySection` stops being empty.
    if (role !== 'scout') {
      const summaries: Partial<Record<KodaXTaskRole, KodaXRoleRoundSummary>> = {};
      const nowIso = new Date().toISOString();
      if (currentRecorder.scout?.payload.scout) {
        const s = currentRecorder.scout.payload.scout;
        summaries.scout = {
          role: 'scout',
          round: 1,
          objective: 'Investigate task scope and confirm harness tier',
          confirmedConclusions: [
            s.summary ? `Summary: ${s.summary}` : undefined,
            s.confirmedHarness ? `Confirmed harness: ${s.confirmedHarness}` : undefined,
          ].filter((v): v is string => Boolean(v)),
          unresolvedQuestions: [],
          nextFocus: Array.isArray(s.scope) ? [...s.scope] : [],
          summary: s.summary ?? '',
          updatedAt: nowIso,
        };
      }
      if (currentRecorder.contract?.payload.contract && role !== 'planner') {
        const c = currentRecorder.contract.payload.contract;
        summaries.planner = {
          role: 'planner',
          round: 1,
          objective: 'Produce the H2 execution contract',
          confirmedConclusions: c.summary ? [c.summary] : [],
          unresolvedQuestions: [],
          nextFocus: Array.isArray(c.successCriteria) ? [...c.successCriteria] : [],
          summary: c.summary ?? '',
          updatedAt: nowIso,
        };
      }
      if (currentRecorder.handoff?.payload.handoff && role === 'evaluator') {
        const h = currentRecorder.handoff.payload.handoff;
        summaries.generator = {
          role: 'generator',
          round: 1,
          objective: 'Execute the task per the handoff',
          confirmedConclusions: h.summary ? [h.summary] : [],
          unresolvedQuestions: Array.isArray(h.followup) ? [...h.followup] : [],
          nextFocus: [],
          summary: h.summary ?? '',
          updatedAt: nowIso,
        };
      }
      if (Object.keys(summaries).length > 0) {
        ctx.previousRoleSummaries = summaries;
      }
    }
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
      // P1 parity — per-role tool policy computed lazily so Generator
      // can see Scout's mutation intent after emit. Legacy routed this
      // through `buildManagedWorkerToolPolicy` per role; the Runner-driven
      // path needs the same branching to keep the "## Tool Policy"
      // section in each worker's system prompt (allow-lists, shell
      // patterns, docs-only write boundary).
      //
      // M4 parity extension — also read the current plan via `planRef`
      // so the Generator's H1 review-only / docs-scoped branch triggers
      // off Scout's post-decision harness + primaryTask, not the stale
      // pre-Scout snapshot.
      toolPolicyFactory: (role, currentRecorder) => {
        const currentDecision = planRef.current?.decision ?? plan.decision;
        return buildManagedWorkerToolPolicy(
          role,
          options.context?.taskVerification,
          currentDecision.harnessProfile,
          inferScoutMutationIntent(
            {
              scope: currentRecorder.scout?.payload.scout?.scope,
              reviewFilesOrAreas: currentRecorder.scout?.payload.scout?.reviewFilesOrAreas,
            },
            currentDecision.primaryTask,
            currentRecorder.scout?.payload.scout?.confirmedHarness,
          ),
          options.context?.repoIntelligenceMode,
        );
      },
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
  // FEATURE_078: provide a callback that surfaces Scout's
  // `downstream_reasoning_hint` to the per-role adapter. Read lazily —
  // Scout's payload only populates after Scout's own turn returns, so
  // the callback closes over `recorder` and reads on each adapter call.
  const llm = buildRunnerLlmAdapter(
    options,
    adapterOverride,
    tokenStateRef,
    () => recorder.scout?.payload.scout?.downstreamReasoningHint,
    contextTokenSnapshotRef,
    todoStore,
    todoReminderState,
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
  const resolvedInitial = await resolveInitialMessages(options, options.session?.id);
  const userMessageContent = buildPromptMessageContent(
    promptWithOverlay,
    options.context?.inputArtifacts,
  );
  const runnerInput = resolvedInitial.messages.length > 0
    ? [...resolvedInitial.messages, { role: 'user' as const, content: userMessageContent }]
    : [{ role: 'user' as const, content: userMessageContent }];

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
  const compactionHook = await buildManagedTaskCompactionHook(options, {
    contextTokenSnapshotRef,
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
      stallOrchestrator.reset();
    },
  });

  // H1 structural resume: when a checkpoint seeded the recorder with a
  // completed scout (and optionally contract), skip straight to the
  // first unfinished role. The role-prompt factory reads the seeded
  // recorder slots so planner/generator/evaluator see `scoutScope` +
  // `previousRoleSummaries` on turn 1, matching what they'd see mid-run.
  //
  // FEATURE_114 v0.7.36 — when `KODAX_HARNESS_V2=true` AND the run is
  // a fresh start (no structural resume), the AMA Harness V2 single-
  // loop entry is `chain.worker` instead of `chain.scout`. V2 resume
  // is intentionally out of scope for v0.7.38 (the V2 entry path
  // doesn't yet have a checkpoint shape — checkpoints carry
  // scout/contract/handoff slots, not worker slots). When the flag is
  // off the literal V1 entry-agent select is preserved bit-for-bit so
  // the legacy path stays a verbatim baseline.
  const harnessV2Active = isHarnessV2Enabled();
  const entryAgent: Agent = structuralResumeSeed
    ? (structuralResumeSeed.startingRole === 'generator'
      ? chain.generator
      : structuralResumeSeed.startingRole === 'planner'
        ? chain.planner
        : chain.scout)
    : harnessV2Active
      ? chain.worker
      : chain.scout;
  // Run-scoped guardrails — built ONCE so the FEATURE_155 idle-yield
  // outer loop can re-enter `Runner.run` cheaply. The factories return
  // stateless objects (idempotency state lives on the closed-over
  // `mutationTracker` / `payloadRef`, which persist across iterations
  // either way), so reusing is purely a small allocation saving on the
  // resume path; correctness is unchanged from the pre-loop shape.
  const runnerGuardrails = [
    // 1. tool-result-truncation: post-execute size policy parity with
    //    the SA substrate (`applyToolResultGuardrail`). Without it the
    //    LLM sees raw unbounded tool output, blowing the context window
    //    on read/grep of large files.
    createToolResultTruncationGuardrail(baseCtx),
    // 2. scope-aware-harness (FEATURE_106 v0.7.31): when Scout has
    //    committed to H0_DIRECT (or hasn't committed at all) and
    //    Generator-stage mutations cross the significance threshold
    //    (≥3 files OR ≥100 lines), append the canonical
    //    emit_scout_verdict hint so the LLM can promote to H1/H2.
    //    Idempotent on `mutationTracker.reflectionInjected`; reads
    //    `managedProtocolPayloadRef.current.scout.confirmedHarness` to
    //    skip when Scout already escalated.
    createScopeAwareHarnessGuardrail({
      mutationTracker,
      payloadRef: managedProtocolPayloadRef,
    }),
  ] as const;
  // Surface Runner tool-loop invocations through the KodaXEvents
  // channels the worker ledger consumes. Without this wiring the REPL
  // worker ledger stays empty mid-run — only the final formal output
  // reaches the user (observed regression report: "除了正式输出之外的
  // 任何别的信息都看不到"). Legacy agent.ts fired events.onToolResult at
  // three sites per invocation (success / error / cancelled); the
  // Runner observer maps 1:1 onto `onToolUseStart` + `onToolResult`
  // here.
  const runnerToolObserver = {
    // CAP-010 tri-state permission gate: plan-mode / accept-edits /
    // extension "tool:before" hooks run here. Delegates to the shared
    // substrate helper so SA and AMA evaluate the same gate chain —
    // pre-FEATURE_100 the AMA path only invoked
    // `events.beforeToolExecute` and dropped the extension
    // `tool:before` branch entirely; substrate parity restores it.
    // Tri-state contract preserved verbatim: undefined → allow;
    // CANCELLED_TOOL_RESULT_MESSAGE → cancel; other string → block
    // with that string as the synthesized tool_result content.
    beforeTool: async (call: { name: string; id: string; input: Record<string, unknown> }) => {
      // FEATURE_178 v0.7.42 — consume any pending nudge first. If the
      // previous tool's onToolCall fired a stall signal and the L2
      // sidecar resolved with isStuck=true, the nudge text is sitting
      // in the orchestrator's pending ref. Returning it as a string
      // here blocks the current tool with the nudge as its synthesized
      // tool_result — the model sees the nudge instead of the actual
      // tool output and rethinks. This is the only path that converts
      // an L1+L2 verdict into model-visible behaviour.
      const pendingNudge = stallOrchestrator.consumePendingNudge();
      if (pendingNudge !== undefined) {
        return pendingNudge;
      }
      // Existing permission / policy override path. Only runs when
      // `options.events` is set (interactive callers); SDK / tests
      // bypass entirely.
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
    onToolCall: (call: { name: string; id: string; input: Record<string, unknown> }) => {
      // FEATURE_178 v0.7.42 — record into the orchestrator (which
      // records into the L1 detector AND the transcript buffer, and
      // fires the L2 sidecar non-awaited when stall is detected). The
      // sidecar verdict surfaces on the NEXT beforeTool call via
      // consumePendingNudge(); this call returns immediately.
      stallOrchestrator.recordToolUse(call);
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
      });
    },
    onToolResult: (
      call: { name: string; id: string },
      result: { content: string | readonly KodaXToolResultContentItem[]; metadata?: unknown },
    ) => {
      // FEATURE_178 v0.7.42 — feed the tool_result content into the
      // orchestrator's transcript buffer so subsequent sidecar prompts
      // include the actual return values, not just bare tool_use
      // blocks. We string-coerce to keep the buffer type-clean — the
      // sidecar only reads text.
      stallOrchestrator.recordToolResult(
        { id: call.id },
        typeof result.content === 'string' ? result.content : '[non-text content]',
      );
      // F4 parity — track whether any tool result was truncated by the
      // tool-result-truncation guardrail. `result.metadata.truncated`
      // is set by the guardrail's rewrite step. Observed values feed
      // into `runtime.toolOutputTruncated` / `toolOutputTruncationNotes`.
      const meta = result.metadata as { truncated?: boolean; policy?: unknown } | undefined;
      if (meta?.truncated) {
        toolTruncationRef.truncated = true;
        toolTruncationRef.notes.push(
          `${call.name}: result was truncated to guardrail policy`,
        );
      }
      // CAP-035: same visibility filter on the result side.
      if (!isVisibleToolName(call.name)) return;
      options.events?.onToolResult?.({
        id: call.id,
        name: call.name,
        content: typeof result.content === 'string' ? result.content : result.content.filter(i => i.type === 'text').map(i => i.type === 'text' ? i.text : '').join(''),
      });
    },
  };

  // FEATURE_184 (v0.7.45) Phase C.1 — current-agent role ref.
  // Tracks which role is currently executing so composedStopHook can gate
  // the sidecar verifier to generator/worker turns only. The sidecar should
  // NOT fire on Scout or Planner text-only turns (H0_DIRECT Scout answer,
  // zero-tool Planner fallback) — those are not the "execution terminal" the
  // verifier is designed to review. Initialised to 'scout' (chain starts
  // there); updated by onAgentSwitched below.
  const currentAgentRoleRef: { current: KodaXTaskRole | 'scout' | 'planner' } = {
    current: 'scout',
  };

  // FEATURE_184 (v0.7.45) Phase D.2 — Sidecar Verifier wiring.
  //
  // Resolve the verifier's (provider, model). **Default behaviour is
  // inherit-from-main-agent** — sidecar runs on the same model as the
  // Main Agent unless the user explicitly sets KODAX_VERIFIER_PROVIDER
  // + KODAX_VERIFIER_MODEL. The architectural value of FEATURE_184 is
  // the Stop-hook shape (out-of-chain verification fires after Worker
  // text-only termination), NOT automatic model-family decoupling.
  // Decoupling is an opt-in escape hatch for users routing around
  // documented quirks (e.g. zhipu/glm-5.1 intent-vs-action floor,
  // memory: project_feature_167).
  //
  // The verifier StopHook is composed with the extension `turn:complete`
  // bridge below: sidecar tries first; on `accept` (undefined) we defer
  // to the extension bridge so user-installed extensions still see the
  // turn-complete event and can override (e.g. their own validation
  // rule that wants another round). This is the "first-party first,
  // second-party fallback" precedence documented in v0.7.45.md §D.
  // FEATURE_184 (v0.7.45) Phase C.1: Transient gate dropped — chain no
  // longer has an in-chain evaluator slot, so Sidecar Verifier always
  // activates when a verifier provider can be resolved.
  const mainProviderName = options.provider ?? 'anthropic';
  const resolvedVerifier = resolveVerifierProvider({
    mainProvider: resolveProvider(mainProviderName),
    mainProviderName,
    mainModel: options.modelOverride ?? options.model ?? 'unknown',
  });
  const sidecarVerifierHook = resolvedVerifier
    ? createSidecarVerifierStopHook({
        provider: resolvedVerifier.provider,
        model: resolvedVerifier.model,
        buildContext: (ctx) =>
          buildVerifierContext({
            transcript: ctx.transcript,
            lastAssistantText: ctx.lastAssistantText,
            mutationTracker,
          }),
        onVerdict: (verdict) => {
          // Side-effect bridge: writes recorder.verdict in Evaluator-
          // shape, fires observer.onRoleEmit('evaluator', recorder)
          // for downstream parity, dispatches TodoStore action keyed
          // on verdict.status, and triggers the 90%-threshold budget-
          // extension dialog when sidecar returns revise on a high-
          // utilisation run. Mirrors the legacy wrapEmitterWithRecorder
          // verdict-slot behaviour minus the V1 H1-cap / handoff-rewrite
          // branches that the sidecar architecturally retires. Errors
          // are swallowed (best-effort) — the stop-hook return value is
          // the user-visible contract; bridge failures must not crash
          // the run.
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
      })
    : undefined;

  const extensionTurnCompleteHook = createExtensionTurnCompleteStopHook(
    () => sessionIdRef.current,
  );

  // Composed stopHook: sidecar verifier wins when non-undefined; falls
  // through to extension bridge on undefined (sidecar accepted, or no
  // sidecar configured). Order matters — flip it and user extensions
  // could second-guess a sidecar `revise` / `blocked` verdict.
  //
  // FEATURE_184 (v0.7.45) Phase C.1 idle-yield guard: skip the sidecar
  // verifier when the stop hook fires on an intermediate text-only idle-
  // yield turn (i.e. Worker is waiting for a pending child or a queued
  // background banner). Invoking the verifier here would:
  //   (a) waste an LLM call on a non-terminal agent state, and
  //   (b) set recorder.verdict synchronously inside onVerdict, which
  //       makes computeSnapshot's `hasEmittedTerminalVerdict` flip to
  //       true, causing detectIdleYield to return false and stranding
  //       the outer loop — Worker never resumes after the child settles.
  // The guard mirrors the detectIdleYield conditions: if there are still
  // pending children OR pending background banners, defer verification to
  // the next stop-hook invocation that fires after the real terminal turn.
  const composedStopHook: StopHookFn = async (ctx) => {
    if (sidecarVerifierHook) {
      // FEATURE_184 (v0.7.45) Phase C.1 role gate: only invoke the sidecar
      // verifier when the *execution* agent (generator / worker) terminates
      // text-only. Scout and Planner text-only turns (H0_DIRECT Scout
      // answer, zero-tool Planner fallback) are pre-execution roles — they
      // do not produce work that needs post-execution verification.
      // Without this gate the verifier fires on every Scout turn, sets
      // recorder.verdict='accept', and breaks H0_DIRECT verdict.status
      // ('running' → 'completed') and roleAssignments (['direct'] →
      // ['scout', 'evaluator']).
      const isExecutionRole =
        currentAgentRoleRef.current === 'generator' ||
        currentAgentRoleRef.current === 'worker';
      if (isExecutionRole) {
        const isIdleYieldTurn =
          (baseCtx.childTaskRegistry?.size ?? 0) > 0 ||
          getMessageQueue().has({
            agentId: undefined,
            maxPriority: 'background',
            mode: 'task-notification',
          });
        if (!isIdleYieldTurn) {
          // FEATURE_184 Phase D.3 — surface a "Verifying..." spinner via
          // the observer so the user sees something during the sidecar
          // LLM call (typically 3-10s on inherit-main provider).
          observer.sidecarStarted();
          const sidecarResult = await sidecarVerifierHook(ctx);
          if (sidecarResult !== undefined) return sidecarResult;
        }
      }
    }
    return extensionTurnCompleteHook(ctx);
  };

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
  const runOnce = (agent: Agent, input: readonly KodaXMessage[]) =>
    Runner.run(agent, input, {
      llm,
      abortSignal: options.abortSignal,
      compactionHook,
      guardrails: [...runnerGuardrails],
      toolObserver: runnerToolObserver,
      // FEATURE_164 (v0.7.41) — mid-turn user-prompt injection.
      // Replaces the legacy mid-iteration empty-turn yield (see the
      // retirement note in `streamingLLM` above). On every tool-turn
      // boundary, drain main-thread `mode:'prompt'` messages from the
      // canonical MessageQueue and splice them into the transcript
      // as real user messages — Worker continues its loop, the next
      // LLM call sees the new prompts in natural conversation order,
      // and the REPL gets a chance to render them via
      // `events.onMidTurnUserMessages` so the user sees their typed
      // query echoed without waiting for the round to end.
      //
      // Scope is intentionally narrow: only `agentId:undefined`
      // (main-thread) `mode:'prompt'` messages. Background banners
      // (task-notification) remain on the idle-yield path, which is
      // the only safe place to drain them given the fast-child race
      // (see Bug E hotfix at `hasPendingBackgroundMessages`).
      beforeNextTurn: async () => {
        const drained = getMessageQueue().dequeue({
          agentId: undefined,
          maxPriority: 'user',
          mode: 'prompt',
        });
        if (drained.length === 0) return [];
        const contents = drained.map((m) => m.content);
        options.events?.onMidTurnUserMessages?.(contents);
        return drained.map((m) => ({
          role: 'user' as const,
          content: m.content,
        }));
      },
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
        const switchedRole: KodaXTaskRole | undefined =
          to.name === SCOUT_AGENT_NAME ? 'scout'
            : to.name === PLANNER_AGENT_NAME ? 'planner'
              : to.name === GENERATOR_AGENT_NAME ? 'generator'
                : to.name === WORKER_AGENT_NAME ? 'worker'
                  : undefined;
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
      stopHook: composedStopHook,
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
      maxToolLoopIterations: 500,
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
  const runResult = await runWithIdleYield({
    initialAgent: entryAgent,
    initialInput: runnerInput,
    runOnce,
    computeSnapshot: (rr) => {
      // Bug B+D: read from recorder, NOT managedProtocolPayloadRef.
      const verdictStatusForGate = recorder.verdict?.payload?.verdict?.status;
      return {
        lastAssistantToolCallCount: countLastAssistantToolCalls(rr.messages),
        pendingChildTaskCount: baseCtx.childTaskRegistry?.size ?? 0,
        hasEmittedHandoff: Boolean(recorder.handoff),
        hasEmittedTerminalVerdict:
          verdictStatusForGate === 'accept' || verdictStatusForGate === 'blocked',
        // Bug E: queue arm alongside registry arm. Strictly
        // task-notification banners — see comment above for the
        // FEATURE_159 follow-up that narrowed this filter.
        hasPendingBackgroundMessages: getMessageQueue().has({
          agentId: undefined,
          maxPriority: 'background',
          mode: 'task-notification',
        }),
      };
    },
    registry: baseCtx.childTaskRegistry ?? new Map(),
    messageQueue: getMessageQueue(),
    // Worker runs as the main thread; the dispatch handler enqueues
    // child notifications with `parentAgentId: undefined` (default
    // main-thread target). Match that here so the queue arm sees
    // them.
    agentId: undefined,
    abortSignal: options.abortSignal,
    // Worker stays the entry agent on resume — the multi-role chain's
    // prior turns are reflected in `rr.messages`, so the Runner's
    // transition logic will pick up where the Worker left off (the
    // handoff slot is empty, so no handoff replay races).
    resumeAgent: () => chain.worker,
    // FEATURE_121 (v0.7.40) — envelope aggregate budget enforcer.
    // Per-banner guardrail already happens at enqueue time
    // (dispatch-child-tasks.ts). This second-line hook fires only when
    // N banners' combined size after per-banner spillover still exceeds
    // ENVELOPE_AGGREGATE_LIMIT_CHARS (200_000, claudecode parity), and
    // forces additional banners to spill until total fits.
    envelopeAggregateEnforcer: createEnvelopeAggregateBudgetEnforcer(baseCtx),
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
      const idleRole: KodaXTaskRole | undefined =
        currentAgent.name === SCOUT_AGENT_NAME ? 'scout'
          : currentAgent.name === PLANNER_AGENT_NAME ? 'planner'
            : currentAgent.name === GENERATOR_AGENT_NAME ? 'generator'
              : currentAgent.name === WORKER_AGENT_NAME ? 'worker'
                : undefined;
      observer.idleWaiting(idleRole, baseCtx.childTaskRegistry?.size ?? 0);
    },
    // `maxIterations` omitted — wrapper defaults to 64, matching the
    // legacy `IDLE_YIELD_MAX_ITERATIONS` constant. The cap fires on
    // the (max+1)th iteration AFTER runOnce returns but BEFORE the
    // snapshot, so a legitimate run that completes at the cap still
    // returns its result.
  });

  // Issue 127 (review feedback): clean up the checkpoint EARLY — the
  // moment Runner.run resolves successfully — so any throw from the
  // post-run synchronous block below (`buildManagedTaskPayload` /
  // `observer.completed`'s user-provided callbacks /
  // `detectScoutSuspiciousSignals`) cannot bypass cleanup and leave an
  // orphan. None of the post-run code reads checkpoint.json from disk,
  // so deleting it early is semantically equivalent to the original
  // late-cleanup placement, just with broader error coverage.
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
  const managedTask = buildManagedTaskPayload({
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
  });

  observer.completed(signal, reason ?? userAnswer);

  // Shard 6d-k: Scout suspicious-completion detection (legacy
  // task-engine.ts:4844). When harness is H0_DIRECT and Scout did not
  // declare an explicit completion signal, the harness inspects the
  // final transcript + mutation tracker + budget and surfaces
  // `onScoutSuspiciousCompletion` for the REPL to render an "uncertain"
  // warning. This is a passive signal — we do not change the verdict,
  // only annotate it.
  if (harnessRef.current === 'H0_DIRECT') {
    // Shard 6d-M: infer the mutation intent from Scout's emitted scope
    // list instead of reading a self-declared field. This matches legacy
    // `inferScoutMutationIntent` (Issue 119) — Scout's scope IS the
    // evidence.
    const scoutMutationIntent = recorder.scout
      ? inferScoutMutationIntent(
          {
            scope: recorder.scout.payload.scout?.scope,
            reviewFilesOrAreas: recorder.scout.payload.scout?.reviewFilesOrAreas,
          },
          plan?.decision.primaryTask,
          recorder.scout.payload.scout?.confirmedHarness,
        )
      : undefined;
    const budgetExhausted = budget.totalBudget > 0 && budget.spentBudget >= budget.totalBudget;
    const suspiciousSignals = detectScoutSuspiciousSignals({
      messages: effectiveRunResult.messages,
      lastText: resolvedText,
      hasScoutPayload: Boolean(recorder.scout),
      scoutMutationIntent,
      mutationTracker,
      budgetExhausted,
    });
    if (suspiciousSignals.length > 0) {
      options.events?.onScoutSuspiciousCompletion?.({
        confidence: 'uncertain',
        signals: suspiciousSignals,
        sessionId: effectiveRunResult.sessionId,
        lastTextPreview: (resolvedText ?? '').slice(0, SUSPICIOUS_LAST_TEXT_PREVIEW_LIMIT),
      });
    }
  }

  // Populate contextTokenSnapshot so the REPL token-counter UI can
  // refresh when the run completes. `baselineEstimatedTokens` stays
  // equal to currentTokens when the provider returned usage — the REPL
  // uses the delta only to adjust subsequent local estimates.
  const tokenState = tokenStateRef.current;
  const contextTokenSnapshot =
    tokenState.source === 'api'
      ? {
          currentTokens: tokenState.totalTokens,
          baselineEstimatedTokens: tokenState.totalTokens,
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
    messages: [...effectiveRunResult.messages],
    // FEATURE_173 (v0.7.42) Part A — kill `runner-${epoch}` ghost-session
    // double-write. Caller-supplied `options.session.id` (the REPL session
    // file, format `YYYYMMDD_HHMMSS`) always wins. `runOnce` does NOT
    // currently pass an agent-layer Session into Runner.run (would trigger
    // `session.append()`), so `effectiveRunResult.sessionId` is always
    // undefined for production callers — the `runner-${Date.now()}`
    // synthetic-id branch is left as a last-resort for SDK callers that
    // explicitly opt out of session.id (vanishingly rare).
    sessionId: options.session?.id ?? effectiveRunResult.sessionId ?? `runner-${Date.now()}`,
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
  });

  return result;
}
