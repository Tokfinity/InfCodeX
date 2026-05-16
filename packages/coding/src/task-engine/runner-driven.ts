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

import type {
  KodaXContentBlock,
  KodaXMessage,
  KodaXToolDefinition,
  KodaXToolUseBlock,
} from '@kodax-ai/llm';
import { KODAX_ESCALATED_MAX_OUTPUT_TOKENS } from '@kodax-ai/llm';
// CAP-012: per-session cost tracker. Import via the substrate re-export
// shim (`agent-runtime/middleware/cost-tracker.ts`) instead of reaching
// directly into `@kodax-ai/llm`, so AMA and SA share one declared substrate
// surface. Runtime implementation is identical (the shim re-exports the
// same `@kodax-ai/llm` symbols); the difference is documented sharing — any
// future cost-tracker substrate wrapper added there is automatically
// picked up by AMA.
import {
  createCostTracker,
  formatCostReport,
  getSummary as getCostSummary,
  recordUsage as recordCostUsage,
  type CostTracker,
} from '../agent-runtime/middleware/cost-tracker.js';
import { KODAX_MAX_MAXTOKENS_RETRIES } from '../constants.js';
import type {
  Agent,
  Handoff,
  RunnableTool,
  RunnerLlmResult,
  RunnerToolResult,
} from '@kodax-ai/agent';
import { Runner, getMessageQueue } from '@kodax-ai/agent';
import {
  EVALUATOR_AGENT_NAME,
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
// FEATURE_114 v0.7.36 Slice 3c — deterministic per-step evaluator.
// When a `todo_update` flips an item with an `evaluator` hint to
// `completed`, the runner runs the corresponding npm command and
// threads stderr back into the next tool result. Pure helper; the
// runner wrapper is right below the existing todoReminderState wrap.
import {
  formatDeterministicEvaluatorResult,
  runDeterministicEvaluator,
  type DeterministicEvaluatorHint,
  type DeterministicEvaluatorResult,
  type RunDeterministicEvaluatorInput,
} from './deterministic-evaluator.js';

import { resolveProvider } from '../providers/index.js';
import { buildCapabilityContextSections } from '../prompts/capability-sections.js';
import {
  buildAutoRepoIntelligenceContext,
  bucketProviderPayloadSize,
  cleanupIncompleteToolCalls,
  describeTransientProviderRetry,
  emitResilienceDebug,
  estimateProviderPayloadBytes,
  saveSessionSnapshot,
  validateAndFixToolHistory,
} from '../agent.js';
import {
  ProviderRecoveryCoordinator,
  StableBoundaryTracker,
  classifyResilienceError,
  resolveResilienceConfig,
  telemetryBoundary,
  telemetryClassify,
  telemetryDecision,
  telemetryRecovery,
} from '../resilience/index.js';
import { waitForRetryDelay } from '../retry-handler.js';
import {
  emitContract,
  emitHandoff,
  emitScoutVerdict,
  emitVerdict,
  resolveHandoffTarget,
  type ProtocolEmitterMetadata,
} from '../agents/protocol-emitters.js';
import { toolBash } from '../tools/bash.js';
import { toolEdit } from '../tools/edit.js';
import { toolMultiEdit } from '../tools/multi-edit.js';
import { toolExitPlanMode } from '../tools/exit-plan-mode.js';
import { toolTodoUpdate } from '../tools/todo-update.js';
import { toolTodoList } from '../tools/todo-list.js';
import { toolGlob } from '../tools/glob.js';
import { toolGrep } from '../tools/grep.js';
import { toolRead } from '../tools/read.js';
import { toolWrite } from '../tools/write.js';
// FEATURE_155 v0.7.39 Slice C1 — `await_child_task` tool removed.
// All chains (V1 Scout/Generator + V2 Worker) now wait via idle-yield;
// the runner-driven outer loop in `runManagedTaskViaRunnerInner`
// resumes them on `<task-completed>` notifications. The legacy import
// path is gone; `await-child-task.ts` is deleted.
// M1 parity (v0.7.26) — repo-intel + MCP handlers required to give Planner
// the same inspection surface it had under v0.7.22's
// `buildManagedWorkerToolPolicy('planner')` allow-list.
import { toolRepoOverview } from '../tools/repo-overview.js';
import { toolChangedScope } from '../tools/changed-scope.js';
import { toolChangedDiff, toolChangedDiffBundle } from '../tools/changed-diff.js';
import { toolMcpSearch } from '../tools/mcp-search.js';
import { toolMcpDescribe } from '../tools/mcp-describe.js';
import { toolMcpCall } from '../tools/mcp-call.js';
import { toolMcpReadResource } from '../tools/mcp-read-resource.js';
import { toolMcpGetPrompt } from '../tools/mcp-get-prompt.js';
import {
  getToolDefinition,
  getRegisteredToolDefinition,
  listToolDefinitions,
  MCP_TOOL_NAMES,
} from '../tools/registry.js';
import type {
  KodaXEvents,
  KodaXHarnessProfile,
  KodaXManagedProtocolPayload,
  KodaXManagedTask,
  KodaXOptions,
  KodaXReasoningMode,
  KodaXResult,
  KodaXRoleRoundSummary,
  KodaXTaskContract,
  KodaXTaskEvidenceArtifact,
  KodaXTaskEvidenceEntry,
  KodaXTaskRole,
  KodaXTaskRoleAssignment,
  KodaXTaskRoutingDecision,
  KodaXTaskVerificationContract,
  KodaXToolExecutionContext,
  ManagedMutationTracker,
} from '../types.js';
import { estimateTokens } from '../tokenizer.js';
import type { ReasoningPlan } from '../reasoning.js';
import {
  applyFollowupEscalationToOptions,
  reasoningModeToDepth,
  resolveReasoningMode,
  resolveRoleReasoning,
  type ReasoningRole,
} from '../reasoning.js';
import type { ManagedTaskBudgetController } from './_internal/managed-task/budget.js';
import {
  buildManagedStatusBudgetFields,
} from './_internal/managed-task/budget.js';
import type {
  ManagedTaskCheckpoint,
  ValidatedCheckpoint,
} from './_internal/managed-task/checkpoint.js';
import {
  deleteCheckpoint,
  findValidCheckpoint,
  getGitHeadCommit,
  writeCheckpoint,
} from './_internal/managed-task/checkpoint.js';
import {
  getManagedTaskSurface,
  getManagedTaskWorkspaceRoot,
} from './_internal/managed-task/workspace.js';
import {
  buildManagedTaskArtifactRecords,
  getManagedSkillArtifactPaths,
  mergeEvidenceArtifacts,
  writeManagedSkillArtifacts,
  writeManagedTaskArtifacts,
  writeManagedTaskSnapshotArtifacts,
} from './_internal/managed-task/artifacts.js';
import { attachManagedTaskRepoIntelligence } from './_internal/managed-task/repo-intelligence.js';
import {
  buildManagedWorkerToolPolicy,
  inferScoutMutationIntent,
} from './_internal/managed-task/tool-policy.js';
import {
  createVerificationScorecard,
  type ScorecardVerdictDirective,
} from './_internal/managed-task/scorecard.js';
import { applyCurrentDiffReviewRoutingFloor } from './_internal/managed-task/review-routing.js';
import { createTodoStore, type TodoStore } from './todo-store.js';
import {
  buildTodoReminderText,
  createTodoReminderState,
  detectAgentTransition,
  resetTodoReminderState,
  shouldFireTodoReminder,
  tickTodoReminder,
  type TodoReminderState,
} from './todo-throttle-reminder.js';
import {
  SUSPICIOUS_LAST_TEXT_PREVIEW_LIMIT,
  detectScoutSuspiciousSignals,
} from './_internal/managed-task/scout-signals.js';
import type { ManagedRolePromptContext } from './_internal/managed-task/role-prompt-types.js';
import {
  attemptProtocolTextFallback,
  getEmitToolNameForRole,
} from './_internal/managed-task/parse-helpers.js';
import { getManagedBlockNameForRole } from '../managed-protocol.js';
import {
  MANAGED_CONTROL_PLANE_MARKERS,
  sanitizeEvaluatorPublicAnswer,
  sanitizeManagedStreamingText,
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
  detectMissingTerminalVerdict,
  runWithIdleYield,
} from '@kodax-ai/agent';
// FEATURE_167 (v0.7.41) — Evaluator terminal-verdict fallback constants.
import {
  EVALUATOR_VERDICT_RETRY_PROMPT,
  resolveEvaluatorVerdictRetryCap,
} from './_internal/managed-task/evaluator-verdict-retry.js';
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
  emitProviderRateLimit,
  emitSessionStart,
  emitStreamEnd,
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
// interfaces and four leaf modules below were extracted from this file
// without behavior change; runner-driven.ts re-exports the public names
// (`AmaRole`, `getAmaRoleEffectiveExclude`, `getAmaRoleExpectedToolNames`,
// `maybeApplyP2bWriteTurnCap`) plus the structural interfaces tests
// reach for via `Parameters<typeof ...>` so import paths in tests and
// downstream callers do not change.
import {
  SCOUT_INSTRUCTIONS_FALLBACK,
  PLANNER_INSTRUCTIONS_FALLBACK,
  GENERATOR_INSTRUCTIONS_FALLBACK,
  EVALUATOR_INSTRUCTIONS_FALLBACK,
  WORKER_INSTRUCTIONS_FALLBACK,
  resolveRoleInstructions,
  buildCompletionContractStatus,
} from './_internal/managed-task/role-prompts.js';
import {
  getAmaRoleEffectiveExclude,
  getAmaRoleExpectedToolNames,
} from './_internal/managed-task/role-exclude.js';
import { maybeApplyP2bWriteTurnCap } from './_internal/managed-task/write-turn-cap.js';
import {
  extractUserFacingText,
  deriveFinalStatus,
  buildManagedProtocolPayload,
} from './_internal/managed-task/status-derivation.js';
import {
  wrapCodingToolAsRunnable,
  wrapGeneratorBashWithMutationGuard,
  wrapGeneratorWriteWithMutationGuard,
  wrapReadOnlyBash,
} from './_internal/managed-task/tool-wrappers.js';
import { wrapDispatchChildTaskForRole } from './_internal/managed-task/dispatch-child.js';
import {
  applyScoutDecisionToPlanRunner,
  buildObserverBridge,
  buildRunnerRoutingNote,
  BUDGET_CAP_BY_HARNESS,
  MAX_ROUNDS_BY_HARNESS,
  NULL_OBSERVER,
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

// Re-export the public surface so existing callers
// (`task-engine.ts`, `runner-driven.test.ts`,
// `runner-driven-tool-wiring.test.ts`, `p2b-write-turn-cap.test.ts`)
// continue to import everything from `./runner-driven.js`.
export {
  getAmaRoleEffectiveExclude,
  getAmaRoleExpectedToolNames,
  maybeApplyP2bWriteTurnCap,
};
export type {
  AmaRole,
  ObserverBridge,
  RolePromptContextFactory,
  RunnerChainPromptContext,
  VerdictRecorder,
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
// Tool wrapping: coding handler → RunnableTool
// =============================================================================


/**
 * Shard 6d-Q: wrap the dispatch_child_task async-generator tool as a
 * Runner-compatible tool.
 *
 * Differences from coding tools handled by `wrapCodingToolAsRunnable`:
 *   - The handler is `AsyncGenerator<ToolProgress, string, void>`. The
 *     Runner loop does not consume progress events directly; we drive
 *     the generator here, forward progress notes through
 *     `ctx.reportToolProgress` on the parent exec context (best-effort),
 *     and return only the final string.
 *   - `dispatch_child_task` enforces `ctx.managedProtocolRole` for role
 *     gating (Scout: read-only only; Planner/Evaluator: blocked;
 *     Generator: full). The Runner path does not set
 *     `managedProtocolRole` on the base ctx, so each role-specific
 *     wrapper injects the right role on the per-call ctx. Also captures
 *     any write worktrees into `childWriteWorktreePathsRef` so the
 *     Evaluator diff injection parity (FEATURE_067 v2) is preserved.
 */

// =============================================================================
// FEATURE_168 / FEATURE_171 — AMA agent tool wiring source of truth.
//
// Per-role exclude sets, `AmaRole` type, `getAmaRoleEffectiveExclude` and
// `getAmaRoleExpectedToolNames` moved to
// `./_internal/managed-task/role-exclude.ts` (FEATURE_171 v0.7.41 split).
// The two helpers and the `AmaRole` type are re-exported at the top of
// this file so existing import paths keep working.
// =============================================================================

interface CodingToolBundle {
  readonly read: RunnableTool;
  readonly grep: RunnableTool;
  readonly glob: RunnableTool;
  readonly bash: RunnableTool;
  readonly write: RunnableTool;
  readonly edit: RunnableTool;
  /** P2a (v0.7.26) — batched-edit tool for single-file skeleton-fill flows. */
  readonly multiEdit: RunnableTool;
  /** FEATURE_074 parity — exit_plan_mode approval tool (Generator only). */
  readonly exitPlanMode: RunnableTool;
  /**
   * FEATURE_097 (v0.7.34) — todo_update drives the Scout-seeded plan
   * checklist visible in the AMA REPL surface. Injected into Scout
   * (H0 path), Generator, and Planner tool sets unconditionally; the
   * tool gracefully degrades to `{ok:false, reason:"not active"}` when
   * Scout produced fewer than 2 obligations and no store was wired.
   */
  readonly todoUpdate: RunnableTool;
  /**
   * FEATURE_151 (v0.7.38) Slice D — `todo_list` read-only query, mirroring
   * Claude Code's `TaskListTool`. Lets the model inspect its own plan
   * (especially after Unknown-id errors or long quiet stretches).
   */
  readonly todoList: RunnableTool;
  /** M1 parity (v0.7.26) — repo-intel + MCP surface restored to Planner.
   * v0.7.22's `buildManagedWorkerToolPolicy('planner')` exposed
   * `changed_scope`, `repo_overview`, `changed_diff_bundle`, `read`,
   * `grep`, `glob`, and all MCP_TOOL_NAMES as an allow-list. The initial
   * Runner-driven Planner only carried `read/grep/glob`, so H2 Planner
   * couldn't read repo-overview or scoped diffs and was forced to draft
   * contracts from Scout memory alone. These fields re-wire the same
   * inventory. Each field is undefined when the corresponding tool
   * isn't registered (optional capability / missing MCP runtime) so the
   * bundle stays usable in test fixtures that don't register them. */
  readonly repoOverview?: RunnableTool;
  readonly changedScope?: RunnableTool;
  readonly changedDiff?: RunnableTool;
  readonly changedDiffBundle?: RunnableTool;
  readonly mcp: readonly RunnableTool[];
}

function buildCodingToolBundle(
  baseCtx: KodaXToolExecutionContext,
  budget?: ManagedTaskBudgetController,
  events?: KodaXEvents,
): CodingToolBundle {
  const read = getToolDefinition('read');
  const grep = getToolDefinition('grep');
  const glob = getToolDefinition('glob');
  const bash = getToolDefinition('bash');
  const write = getToolDefinition('write');
  const edit = getToolDefinition('edit');
  const multiEdit = getToolDefinition('multi_edit');
  const exitPlanMode = getToolDefinition('exit_plan_mode');
  const todoUpdate = getToolDefinition('todo_update');
  const todoList = getToolDefinition('todo_list');
  if (
    !read
    || !grep
    || !glob
    || !bash
    || !write
    || !edit
    || !multiEdit
    || !exitPlanMode
    || !todoUpdate
    || !todoList
  ) {
    throw new Error(
      'Runner-driven path: expected core tools (read/grep/glob/bash/write/edit/multi_edit/exit_plan_mode/todo_update/todo_list) to be registered',
    );
  }
  // M1 parity (v0.7.26) — optionally wrap repo-intel + MCP tools so
  // Planner can be given the same inspection allow-list it had under
  // v0.7.22's `buildManagedWorkerToolPolicy('planner')`. Each tool is
  // only wrapped when its definition is registered — test fixtures that
  // bootstrap a minimal registry should still work.
  const repoOverviewDef = getToolDefinition('repo_overview');
  const changedScopeDef = getToolDefinition('changed_scope');
  const changedDiffDef = getToolDefinition('changed_diff');
  const changedDiffBundleDef = getToolDefinition('changed_diff_bundle');
  const mcpHandlers: Record<string, (input: Record<string, unknown>, ctx: KodaXToolExecutionContext) => Promise<string>> = {
    mcp_search: toolMcpSearch,
    mcp_describe: toolMcpDescribe,
    mcp_call: toolMcpCall,
    mcp_read_resource: toolMcpReadResource,
    mcp_get_prompt: toolMcpGetPrompt,
  };
  const mcp: RunnableTool[] = MCP_TOOL_NAMES.reduce<RunnableTool[]>((acc, name) => {
    const def = getToolDefinition(name);
    const handler = mcpHandlers[name];
    if (def && handler) {
      acc.push(wrapCodingToolAsRunnable(def, handler, baseCtx, budget, events));
    }
    return acc;
  }, []);

  return {
    read: wrapCodingToolAsRunnable(read, toolRead, baseCtx, budget, events),
    grep: wrapCodingToolAsRunnable(grep, toolGrep, baseCtx, budget, events),
    glob: wrapCodingToolAsRunnable(glob, toolGlob, baseCtx, budget, events),
    bash: wrapCodingToolAsRunnable(bash, toolBash, baseCtx, budget, events),
    write: wrapCodingToolAsRunnable(write, toolWrite, baseCtx, budget, events),
    edit: wrapCodingToolAsRunnable(edit, toolEdit, baseCtx, budget, events),
    multiEdit: wrapCodingToolAsRunnable(multiEdit, toolMultiEdit, baseCtx, budget, events),
    exitPlanMode: wrapCodingToolAsRunnable(exitPlanMode, toolExitPlanMode, baseCtx, budget, events),
    todoUpdate: wrapCodingToolAsRunnable(todoUpdate, toolTodoUpdate, baseCtx, budget, events),
    todoList: wrapCodingToolAsRunnable(todoList, toolTodoList, baseCtx, budget, events),
    repoOverview: repoOverviewDef
      ? wrapCodingToolAsRunnable(repoOverviewDef, toolRepoOverview, baseCtx, budget, events)
      : undefined,
    changedScope: changedScopeDef
      ? wrapCodingToolAsRunnable(changedScopeDef, toolChangedScope, baseCtx, budget, events)
      : undefined,
    changedDiff: changedDiffDef
      ? wrapCodingToolAsRunnable(changedDiffDef, toolChangedDiff, baseCtx, budget, events)
      : undefined,
    changedDiffBundle: changedDiffBundleDef
      ? wrapCodingToolAsRunnable(changedDiffBundleDef, toolChangedDiffBundle, baseCtx, budget, events)
      : undefined,
    mcp,
  };
}

/**
 * FEATURE_168 (v0.7.40 hotfix) — build an AMA role's runtime tool list from the
 * registry, applying role-specific wraps and the role's effective exclude set.
 *
 * Caller MUST splice the role's emit tool in separately (emit tools are not
 * registry-borne — they're built per-run in `buildRunnerAgentChain` via
 * `wrapEmitterWithRecorder`).
 *
 * @param role       Target AMA role (drives the exclude set).
 * @param ctx        Tool execution context.
 * @param budget     Optional budget controller.
 * @param events     Optional events bus for tool progress.
 * @param overrides  Role-specific wraps keyed by tool name. Any tool present
 *                   in this map replaces the default `wrapCodingToolAsRunnable`
 *                   wrap. Used for mutation-guards on bash/write/edit/
 *                   multi_edit, readonly bash for Evaluator, and
 *                   dispatch_child_task per-role drain wrappers.
 */
function buildAgentToolsFromRegistry(
  role: AmaRole,
  ctx: KodaXToolExecutionContext,
  budget: ManagedTaskBudgetController | undefined,
  events: KodaXEvents | undefined,
  overrides: ReadonlyMap<string, RunnableTool>,
): RunnableTool[] {
  const exclude = getAmaRoleEffectiveExclude(role);
  const tools: RunnableTool[] = [];

  for (const def of listToolDefinitions()) {
    if (exclude.has(def.name)) continue;

    const override = overrides.get(def.name);
    if (override) {
      tools.push(override);
      continue;
    }

    // Streaming tools (async-generator handlers, currently only
    // `dispatch_child_task`) require role-specific drain wraps and MUST
    // be supplied via overrides — otherwise the generator never resolves
    // and the tool call hangs.
    const registration = getRegisteredToolDefinition(def.name);
    if (!registration) continue;

    const handler = registration.handler;
    if (handler.constructor.name === 'AsyncGeneratorFunction') {
      throw new Error(
        `buildAgentToolsFromRegistry: streaming tool "${def.name}" requires a role-specific wrap in overrides for role "${role}"`,
      );
    }

    tools.push(
      wrapCodingToolAsRunnable(
        def,
        handler as (
          input: Record<string, unknown>,
          execCtx: KodaXToolExecutionContext,
        ) => Promise<string>,
        ctx,
        budget,
        events,
      ),
    );
  }

  return tools;
}

// =============================================================================
// Runtime Agent chain: Scout / Planner / Generator / Evaluator
// =============================================================================

export interface RunnerAgentChain {
  readonly scout: Agent;
  readonly planner: Agent;
  readonly generator: Agent;
  readonly evaluator: Agent;
  /**
   * FEATURE_114 v0.7.36 — AMA Harness V2 single-loop primary agent.
   * Active only when `KODAX_HARNESS_V2=true` (gate wired in Slice 3b).
   * In V1 runs the Worker slot is built but never dispatched, so its
   * presence here costs nothing structural. Worker handoffs target
   * Evaluator (the structural gate KodaX preserves).
   */
  readonly worker: Agent;
}

/**
 * Build the full runtime agent chain. Each agent carries:
 *   - self-contained role instructions (no legacy prompt context)
 *   - role-appropriate coding tools
 *   - the recorder-wrapped emit tool
 *   - handoff topology matching @kodax-ai/coding/agents/coding-agents.ts:
 *       Scout → Gen (H1) | Planner (H2)
 *       Planner → Gen
 *       Generator → Evaluator
 *       Evaluator → Gen (revise) | Planner (replan)
 *
 * Uses the same closure-before-freeze pattern as `coding-agents.ts` to
 * build the handoff graph despite cyclic references.
 */
export function buildRunnerAgentChain(
  ctx: KodaXToolExecutionContext,
  recorder: VerdictRecorder,
  observer: ObserverBridge = NULL_OBSERVER,
  budget?: ManagedTaskBudgetController,
  budgetExtension?: BudgetExtensionContext,
  // Shard 6d-M: plan ref lets the Generator mutation-intent guards read
  // `plan.decision.primaryTask` at tool-invocation time (the plan is
  // resolved before Runner.run, but the agent chain is frozen earlier).
  planRef: { current: ReasoningPlan | undefined } = { current: undefined },
  // Shard 6d-S: task verification contract surfaces runtime obligations
  // (startup command, ready signal, UI flows, API/DB checks) into the
  // Evaluator prompt so the model actually probes the runtime instead
  // of writing a verdict from static file reads.
  verification?: KodaXTaskVerificationContract,
  // Shard 6d-Q: shared ref so Scout/Generator dispatch_child_task invocations
  // can register write worktree paths for Evaluator diff injection
  // (FEATURE_067 v2 parity). The caller owns the map; the Runner-internal
  // wrappers only append.
  childWriteWorktreePathsRef: { current: Map<string, string> } = { current: new Map() },
  // Full role-prompt context (original task, decision,
  // metadata, tool policy, skill / scope factory). When provided, every
  // role's `instructions` resolves through `createRolePrompt` — the
  // v0.7.22 prompt surface (decision summary, contract, metadata,
  // verification contract, tool policy, evidence strategies,
  // dispatch_child_task guidance, H0/H1/H2 quality framework,
  // handoff/verdict/contract block specs, shared closing rules). When
  // absent (test paths), the fallback minimal instructions are used.
  promptContext?: RunnerChainPromptContext,
  // Events bus so coding-tool wrappers can attach
  // `reportToolProgress` per tool_use call. Without this wiring,
  // async-generator tools (dispatch_child_task) fire progress events
  // that vanish silently — the REPL transcript's "Running: ..." line
  // never updates mid-run.
  events?: KodaXEvents,
  // FEATURE_097 (v0.7.34) — see wrapEmitterWithRecorder docstring.
  // Optional: when omitted, the chain runs without the Scout-seeded
  // plan list (older test fixtures, callers that never enabled
  // FEATURE_097). The `todo_update` tool soft-fails with "not active".
  todoStore?: TodoStore,
  pendingFailedResetRef?: { current: boolean },
  // FEATURE_097 §5 ② — when provided, every successful `todo_update`
  // call resets the throttle reminder counter (model is making
  // progress; the no-update streak is broken).
  todoReminderState?: TodoReminderState,
  // FEATURE_114 v0.7.36 Slice 3c — deterministic per-step evaluator
  // hook. When provided, the `todo_update` wrapper detects items that
  // flip to `completed` AND carry an `evaluator: 'build'|'test'|'lint'`
  // hint, runs the corresponding command in `runtimeCwd`, and appends
  // a formatted result to the tool's output so the LLM sees the check
  // outcome on its next turn. Omitted → no-op (tests / legacy callers).
  runtimeCwd?: string,
  // FEATURE_114 v0.7.36 Slice 3c — injectable evaluator runner. Tests
  // pass a stub here to avoid spawning real shell commands; production
  // omits this and uses the real `runDeterministicEvaluator`.
  runDeterministicEvaluatorOverride?: (
    input: RunDeterministicEvaluatorInput,
  ) => Promise<DeterministicEvaluatorResult>,
): RunnerAgentChain {
  const codingTools = buildCodingToolBundle(ctx, budget, events);
  // FEATURE_097 (v0.7.34) §5 ② — wrap `todo_update` so every successful
  // call resets the Layer 2 throttle counter. The base tool already
  // returns `{ok:true}` on success and `{ok:false, reason:...}` on
  // failure (unknown id / bad input / store inactive); only the success
  // path resets the counter so a model spamming malformed updates does
  // NOT escape the reminder. Read the JSON envelope to discriminate.
  if (todoReminderState) {
    const baseTodoUpdate = codingTools.todoUpdate;
    const wrappedTodoUpdate: RunnableTool = {
      ...baseTodoUpdate,
      execute: async (input, runnerCtx): Promise<RunnerToolResult> => {
        const result = await baseTodoUpdate.execute(input, runnerCtx);
        if (!result.isError && typeof result.content === 'string') {
          try {
            const parsed = JSON.parse(result.content) as { ok?: boolean };
            if (parsed.ok === true) {
              resetTodoReminderState(todoReminderState);
            }
          } catch {
            // Tool output should always be JSON, but if a future change
            // breaks that contract we silently skip the reset rather
            // than crash the Runner mid-turn.
          }
        }
        return result;
      },
    };
    (codingTools as { -readonly [K in keyof typeof codingTools]: typeof codingTools[K] }).todoUpdate = wrappedTodoUpdate;
  }
  // FEATURE_114 v0.7.36 Slice 3c — deterministic per-step evaluator.
  // When `todoStore` + `runtimeCwd` are wired, wrap `todo_update` so a
  // successful `pending|in_progress → completed` transition on an
  // item with `evaluator: 'build'|'test'|'lint'` triggers the
  // corresponding npm command. The check's outcome (pass / fail with
  // stderr tail / skipped on missing script / error on timeout) is
  // appended to the tool result so the Worker reads it on the next
  // turn and self-corrects. No-op when either dependency is missing
  // — keeps test fixtures + V1 callers untouched.
  //
  // The wrapper composes AFTER the throttle-reminder wrap above so
  // both effects fire on the same tool call.
  if (todoStore && runtimeCwd) {
    const runEvaluator = runDeterministicEvaluatorOverride ?? runDeterministicEvaluator;
    const baseTodoUpdate = codingTools.todoUpdate;
    const wrappedTodoUpdate: RunnableTool = {
      ...baseTodoUpdate,
      execute: async (input, runnerCtx): Promise<RunnerToolResult> => {
        // Snapshot pre-state so we can detect status transitions on
        // the items the tool call touches. Cheap (O(N), N small).
        const preState = new Map<string, { status: string; evaluator?: string }>();
        for (const item of todoStore.getAll()) {
          preState.set(item.id, { status: item.status, evaluator: item.evaluator });
        }
        const result = await baseTodoUpdate.execute(input, runnerCtx);
        if (result.isError) return result;
        // Find items whose status freshly flipped to `completed` AND
        // carry an evaluator hint. In the typical update-op path
        // exactly one item flips per call; on init-op N items can be
        // seeded but they all start at `pending` (no completion to
        // check). Scan all items defensively — cheap.
        const transitions: Array<{ id: string; hint: DeterministicEvaluatorHint }> = [];
        for (const item of todoStore.getAll()) {
          if (item.status !== 'completed') continue;
          if (!item.evaluator) continue;
          const before = preState.get(item.id);
          // Skip items that were already `completed` BEFORE this call —
          // re-running checks on no-op transitions would double the
          // cost and confuse the LLM with stale results.
          if (before?.status === 'completed') continue;
          // Type-narrow the hint — todo-store stores the schema-validated
          // value already, but TS can't prove that across the boundary.
          const hint = item.evaluator;
          if (hint !== 'build' && hint !== 'test' && hint !== 'lint') continue;
          transitions.push({ id: item.id, hint });
        }
        if (transitions.length === 0) return result;
        // Run each check sequentially. Worker prompt guidance steers
        // toward only-one-in_progress-at-a-time, so the typical case
        // is a single transition per call; sequential keeps stdout
        // tails interpretable when multiple do co-occur.
        const evaluatorOutputs: string[] = [];
        for (const { id, hint } of transitions) {
          try {
            const checkResult = await runEvaluator({
              hint,
              cwd: runtimeCwd,
            });
            evaluatorOutputs.push(
              `[evaluator:${id}] ${formatDeterministicEvaluatorResult(checkResult)}`,
            );
          } catch (err) {
            // Defensive: a thrown evaluator surfaces as a soft
            // diagnostic in the tool result, not a runner crash.
            const message = err instanceof Error ? err.message : String(err);
            evaluatorOutputs.push(
              `[evaluator:${id}] [deterministic-evaluator:${hint}] error — ${message}`,
            );
          }
        }
        // Thread the evaluator output into the tool result. Preserve
        // the original JSON envelope as the first line so existing
        // parsers (`todoReminderState` reset above) stay happy; the
        // evaluator output is a tail block.
        const baseContent = typeof result.content === 'string' ? result.content : '';
        const enrichedContent = [baseContent, '', ...evaluatorOutputs].join('\n');
        return { ...result, content: enrichedContent };
      },
    };
    (codingTools as { -readonly [K in keyof typeof codingTools]: typeof codingTools[K] }).todoUpdate = wrappedTodoUpdate;
  }
  const dispatchDefinition = getToolDefinition('dispatch_child_task');
  if (!dispatchDefinition) {
    throw new Error('dispatch_child_task tool not registered — tools/registry.ts bootstrap failure');
  }
  const scoutDispatch = wrapDispatchChildTaskForRole(
    dispatchDefinition,
    ctx,
    'scout',
    budget,
    childWriteWorktreePathsRef,
    observer,
    events,
  );
  const generatorDispatch = wrapDispatchChildTaskForRole(
    dispatchDefinition,
    ctx,
    'generator',
    budget,
    childWriteWorktreePathsRef,
    observer,
    events,
  );
  // FEATURE_114 v0.7.36 — Worker dispatch wrapper for the V2 single-loop
  // path. Worker IS the executor (no separate Generator), so it inherits
  // Generator's full dispatch surface: read-only fan-out via RULE A,
  // long-running probes via RULE B, and write fan-out (readOnly:false)
  // via RULE C. Worker stays dead code in the V1 path until Slice 3b
  // flips the entry agent under `KODAX_HARNESS_V2=true`.
  const workerDispatch = wrapDispatchChildTaskForRole(
    dispatchDefinition,
    ctx,
    'worker',
    budget,
    childWriteWorktreePathsRef,
    observer,
    events,
  );

  // M5 (v0.7.26) — only the scout slot needs the mutation-tracker /
  // events channel to surface "Scout wrote files before handing off"
  // warnings. The other slots don't need that wiring.
  // FEATURE_097 (v0.7.34) — scout/contract/verdict slots need the
  // todoStore for seeding + Evaluator auto-handling; handoff slot does
  // not (Generator's tool calls already mutate via `todo_update`).
  const scoutEmit = wrapEmitterWithRecorder(
    emitScoutVerdict,
    'scout',
    recorder,
    observer,
    budget,
    undefined,
    ctx.mutationTracker,
    events,
    todoStore,
    pendingFailedResetRef,
  );
  const contractEmit = wrapEmitterWithRecorder(
    emitContract,
    'contract',
    recorder,
    observer,
    budget,
    undefined,
    undefined,
    undefined,
    todoStore,
    pendingFailedResetRef,
  );
  // FEATURE_165 (v0.7.41) — pending-children gate on emit_handoff.
  //
  // The outer idle-yield loop's `detectIdleYield` treats
  // `hasEmittedHandoff=true` as a terminal exit (Worker hands off →
  // Evaluator owns the rest). This is correct for the normal flow,
  // but if the LLM calls emit_handoff while `dispatch_child_task`
  // children are still in flight, the registry is non-empty at exit,
  // banners are stranded in the background queue, and the user-visible
  // run-summary is missing the child outputs (production trace
  // 2026-05-15: zhipu/glm51 worker emit_handoff'd mid-fanout, 3
  // children orphaned).
  //
  // Gate behaviour: when invoked with a non-empty `childTaskRegistry`,
  // returns `isError:true` AND omits `metadata`. Two invariants the
  // rest of the pipeline depends on are observed by this shape:
  //
  //   1. `wrapEmitterWithRecorder` (line ~821) guards
  //      `recorder[slot] = result.metadata` behind
  //      `if (!result.isError && result.metadata)`, so `recorder.handoff`
  //      stays `undefined` when the gate fires. The outer-loop
  //      `computeSnapshot` (line ~5645) reads `Boolean(recorder.handoff)`,
  //      so `hasEmittedHandoff` stays false → idle-yield engages →
  //      `<task-completed>` banners get woven into the next Worker turn
  //      as designed.
  //
  //   2. `detectHandoffSignal`
  //      (`agent/src/primitives/runner-handoff.ts:53`) reads
  //      `result.metadata.handoffTarget`; without metadata, no handoff
  //      signal fires, so `currentAgent` does NOT switch from Worker →
  //      Evaluator on this turn. Worker sees the error tool_result on
  //      its next turn and (per role prompt) ends text-only so
  //      idle-yield picks up.
  //
  // Scope: gates BOTH V1 Generator and V2 Worker uses of `handoffEmit`
  // (the variable is shared at lines 2558 / 2682). Evaluator's
  // `emit_verdict` has its own analogous discipline via the prompt's
  // CHILD-TASK WAIT DISCIPLINE block (FEATURE_155 v0.7.38) AND the
  // outer-loop's `hasEmittedTerminalVerdict` gate — those are
  // unaffected here.
  //
  // Same-batch race (resolved empirically — `runner-driven.test.ts`
  // FEATURE_165 race-regression test pins the behaviour): when the
  // LLM emits `[dispatch_child_task, emit_handoff]` in ONE tool_use
  // batch, `runner.ts:737-739` runs both via `Promise.all`. The
  // `wrapDispatchChildTaskForRole` wrapper calls `gen.next()` on
  // `toolDispatchChildTask`'s async generator BEFORE its first
  // `await` — V8 / modern engines run async-generator bodies
  // synchronously through the first `yield`, so `registerChildTask`
  // (registry.set) executes before `gen.next()` returns control to
  // the awaiter. By the time `emit_handoff`'s wrapper sync prefix
  // (this gate) runs, the registry is already populated. The race
  // regression test exercises this exact `Promise.all` shape and
  // expects the gate to fire — if a future Node version defers
  // async-generator body execution, that test pins the regression.
  //
  // Budget accounting: when the gate fires, `incrementManagedBudgetUsage`
  // inside `wrapEmitterWithRecorder` does NOT run (we short-circuit
  // before delegating). Matches the broader pattern that a failed /
  // rejected tool call does not consume the recorder slot, so it
  // should not consume the budget either.
  const handoffEmitBase = wrapEmitterWithRecorder(
    emitHandoff,
    'handoff',
    recorder,
    observer,
    budget,
  );
  const handoffEmit: RunnableTool = {
    ...handoffEmitBase,
    execute: async (input, runnerCtx): Promise<RunnerToolResult> => {
      const registry = ctx.childTaskRegistry;
      if (registry && registry.size > 0) {
        const pendingIds = [...registry.keys()].slice(0, 5).join(', ');
        const more = registry.size > 5 ? `, +${registry.size - 5} more` : '';
        return {
          content:
            `[emit_handoff] cannot hand off while ${registry.size} child task(s) `
            + `are still in flight: ${pendingIds}${more}. Each dispatched child `
            + `must produce a matching <task-completed task_id="…"> in your `
            + `transcript before you can hand off — otherwise the Evaluator `
            + `audits a half-finished run and the child work is orphaned. End `
            + `your turn with text only; the runner will resume you when each `
            + `child completes. To abandon a child instead of waiting, call `
            + `task_stop(task_id, reason="…") first and wait for the resulting `
            + `<task-completed> (it carries error="stopped: …").`,
          isError: true,
        };
      }
      return handoffEmitBase.execute(input, runnerCtx);
    },
  };
  const verdictEmit = wrapEmitterWithRecorder(
    emitVerdict,
    'verdict',
    recorder,
    observer,
    budget,
    budgetExtension,
    undefined,
    undefined,
    todoStore,
    pendingFailedResetRef,
  );

  type WritableAgent = { -readonly [K in keyof Agent]: Agent[K] };

  // Dynamic role instructions. Every agent's `instructions`
  // closure resolves on each Runner invocation so Scout's post-emit
  // skillMap / scoutScope reach downstream prompts. When `promptContext`
  // is provided, each role gets the full v0.7.22 prompt surface via
  // `createRolePrompt` (decision summary + contract + metadata +
  // verification + tool policy + evidence strategies + dispatch_child_task
  // guidance + H0/H1/H2 quality framework + handoff/verdict/contract
  // block specs + shared closing rules). Tests that don't pass a
  // `promptContext` continue to see the minimal static fallback.
  const scout: WritableAgent = {
    name: SCOUT_AGENT_NAME,
    instructions: () => resolveRoleInstructions(
      'scout',
      SCOUT_AGENT_NAME,
      SCOUT_INSTRUCTIONS_FALLBACK,
      recorder,
      promptContext,
      verification,
    ),
    // FEATURE_168 (v0.7.40 hotfix) — Scout's tool surface is derived from the
    // registry minus `AMA_BASELINE_EXCLUDE ∪ SCOUT_EXTRA_EXCLUDE`. SCOUT_EXTRA
    // is empty: Scout is the H0 executor + dispatcher, so it carries the full
    // execution surface (bash/write/edit/multi_edit raw — v0.7.26 Scout-tool-
    // restoration discipline). Dispatch is role-wrapped for the read-only
    // enforcement (`managedProtocolRole='scout'` enforces read-only fan-out
    // inside dispatch_child_task). The throttle+evaluator-aware todo_update
    // built above is supplied as an override so the FEATURE_097 §5 ② reminder
    // reset still fires on Scout's H0 turns.
    tools: [
      scoutEmit,
      ...buildAgentToolsFromRegistry(
        'scout',
        ctx,
        budget,
        events,
        new Map<string, RunnableTool>([
          ['dispatch_child_task', scoutDispatch],
          ['todo_update', codingTools.todoUpdate],
        ]),
      ),
    ],
    handoffs: undefined,
    reasoning: { default: 'quick', max: 'balanced', escalateOnRevise: false },
  };
  // FEATURE_168 (v0.7.40 hotfix) — Planner's tool surface is derived from the
  // registry minus the PLANNER_EXTRA_EXCLUDE set defined at the top of this
  // file. Planner is planning-only — no mutation (write/edit/multi_edit/
  // insert_after_anchor/undo), no shell (bash), no dispatch (dispatch_child_
  // task / send_message / task_stop), no worktree management, no exit_plan_
  // mode, no user interaction. What remains: read/grep/glob + all 8 repo-
  // intel pull tools (repo_overview / changed_scope / changed_diff /
  // changed_diff_bundle / module_context / symbol_context / process_context
  // / impact_estimate — note the latter 4 were absent in v0.7.41 despite
  // being in legacy `PLANNER_ALLOWED_TOOLS`, recovered by this refactor),
  // 5 MCP tools, web tools (web_search / web_fetch / code_search /
  // semantic_lookup), and todo_update/todo_list. The throttle+evaluator-
  // aware todo_update is supplied as an override so the FEATURE_097 §5 ②
  // reminder reset still fires when Planner replaces the plan.
  const plannerTools: RunnableTool[] = [
    contractEmit,
    ...buildAgentToolsFromRegistry(
      'planner',
      ctx,
      budget,
      events,
      new Map<string, RunnableTool>([
        ['todo_update', codingTools.todoUpdate],
      ]),
    ),
  ];
  const planner: WritableAgent = {
    name: PLANNER_AGENT_NAME,
    instructions: () => resolveRoleInstructions(
      'planner',
      PLANNER_AGENT_NAME,
      PLANNER_INSTRUCTIONS_FALLBACK,
      recorder,
      promptContext,
      verification,
    ),
    tools: plannerTools,
    handoffs: undefined,
    reasoning: { default: 'balanced', max: 'deep', escalateOnRevise: true },
  };
  const generator: WritableAgent = {
    name: GENERATOR_AGENT_NAME,
    instructions: () => {
      // FEATURE_097 (v0.7.34) — consume pending failed → pending reset
      // at the start of every Generator turn. The verdict-slot wrapper
      // arms this flag on `revise` (Generator-targeted route); reading
      // + clearing it here gives the user the ● → ✗ → ☐ → ● visual
      // sequence across the retry boundary. The closure resolves on
      // every Runner invocation of Generator, so the reset fires at
      // the natural "Generator turn starts" boundary.
      if (
        pendingFailedResetRef
        && pendingFailedResetRef.current
        && todoStore
      ) {
        todoStore.resetFailed();
        pendingFailedResetRef.current = false;
      }
      return resolveRoleInstructions(
        'generator',
        GENERATOR_AGENT_NAME,
        GENERATOR_INSTRUCTIONS_FALLBACK,
        recorder,
        promptContext,
        verification,
      );
    },
    // FEATURE_168 (v0.7.40 hotfix) — Generator's tool surface is derived from the
    // registry minus `AMA_BASELINE_EXCLUDE` (no extra excludes — full
    // execution surface). Mutation-guard wraps applied to bash/write/edit/
    // multi_edit so `plan.decision.primaryTask='review'` or scout-scoped
    // review-only intent still blocks accidental mutations. Dispatch is
    // role-wrapped for FEATURE_067 v2 parity (write-fan-out worktree
    // tracking). FEATURE_097 §5 ② throttle reset + Slice 3c per-step
    // deterministic evaluator wraps flow through `codingTools.todoUpdate`.
    tools: [
      handoffEmit,
      ...buildAgentToolsFromRegistry(
        'generator',
        ctx,
        budget,
        events,
        new Map<string, RunnableTool>([
          ['bash', wrapGeneratorBashWithMutationGuard(codingTools.bash, recorder, planRef)],
          ['write', wrapGeneratorWriteWithMutationGuard(codingTools.write, recorder, planRef)],
          ['edit', wrapGeneratorWriteWithMutationGuard(codingTools.edit, recorder, planRef)],
          ['multi_edit', wrapGeneratorWriteWithMutationGuard(codingTools.multiEdit, recorder, planRef)],
          ['dispatch_child_task', generatorDispatch],
          ['todo_update', codingTools.todoUpdate],
        ]),
      ),
    ],
    handoffs: undefined,
    reasoning: { default: 'balanced', max: 'deep', escalateOnRevise: true },
  };
  const evaluator: WritableAgent = {
    name: EVALUATOR_AGENT_NAME,
    instructions: () => resolveRoleInstructions(
      'evaluator',
      EVALUATOR_AGENT_NAME,
      EVALUATOR_INSTRUCTIONS_FALLBACK,
      recorder,
      promptContext,
      verification,
    ),
    // FEATURE_168 (v0.7.40 hotfix) — Evaluator's tool surface is derived from the
    // registry minus `AMA_BASELINE_EXCLUDE ∪ EVALUATOR_EXTRA_EXCLUDE`.
    // EVALUATOR_EXTRA_EXCLUDE is the strictest set in this file — every file
    // mutation, dispatch, plan-state change, and user-interaction tool is
    // hard-excluded so the audit security boundary is architectural, not
    // prompt-dependent. What remains: read/grep/glob + readonly bash + all 8
    // repo-intel pull tools + 5 MCP tools + 4 web tools + todo_list. Note
    // `todo_update` is excluded (audit role must not mutate Worker's plan)
    // — pre-FEATURE_168 Evaluator already did not have it, just made explicit.
    tools: [
      verdictEmit,
      ...buildAgentToolsFromRegistry(
        'evaluator',
        ctx,
        budget,
        events,
        new Map<string, RunnableTool>([
          ['bash', wrapReadOnlyBash(codingTools.bash, 'Evaluator')],
        ]),
      ),
    ],
    handoffs: undefined,
    reasoning: { default: 'balanced', max: 'deep', escalateOnRevise: false },
  };

  // FEATURE_114 v0.7.36 — AMA Harness V2 Worker agent.
  //
  // Tool surface: union of Scout's H0 executor (read/grep/glob + bash/
  // write/edit/multi_edit + exitPlanMode) and Generator's mutation-
  // guarded execution (mutation-guard wrappers for bash/write/edit/
  // multi_edit so plan.decision.primaryTask='review' still blocks
  // accidental mutations) plus dispatch (with write fan-out) and
  // todo_update / todo_list. FEATURE_155 (v0.7.38) Slice C1 removed
  // `await_child_task`; Worker now reclaims async-dispatched children
  // via the idle-yield wait mechanic in the outer runner loop
  // (`detectIdleYield` + `waitForWakeEvent`).
  // Discipline (plan-first, scope commitment, dispatch RULE A/B/C,
  // mutation discipline) lives in `worker-role-prompt.ts`; the
  // tool-policy layer returns `undefined` for `'worker'` (matches Scout).
  //
  // Slice 3a is intentionally additive: the Worker agent is built but
  // never dispatched until Slice 3b flips the entry agent under
  // `KODAX_HARNESS_V2=true`. V1 runs are unaffected.
  const worker: WritableAgent = {
    name: WORKER_AGENT_NAME,
    instructions: () => {
      // FEATURE_114 v0.7.36 Slice 3b — Worker resume handling.
      //
      // Order matters: build the prompt BEFORE consuming the ref so
      // the role-prompt context factory's `isResumeAfterReviseFailure`
      // read sees the armed state. If we reset first, the
      // contextFactory reads `false` and the Worker prompt loses the
      // retrospective sentence on the retry turn.
      //
      // 1. Build prompt — contextFactory reads pendingFailedResetRef.current
      //    and writes ctx.isResumeAfterReviseFailure when role==='worker'.
      const resolved = resolveRoleInstructions(
        'worker',
        WORKER_AGENT_NAME,
        WORKER_INSTRUCTIONS_FALLBACK,
        recorder,
        promptContext,
        verification,
      );
      // 2. Visual reset + ref clear. Mirrors Generator's same-turn
      //    consumption (kept identical so the retry UX is bit-for-bit
      //    consistent across V1 and V2 — the user sees ● → ✗ → ☐ → ●).
      if (
        pendingFailedResetRef
        && pendingFailedResetRef.current
        && todoStore
      ) {
        todoStore.resetFailed();
        pendingFailedResetRef.current = false;
      }
      return resolved;
    },
    // FEATURE_168 (v0.7.40 hotfix) — Worker's tool surface is derived from the
    // registry minus `AMA_BASELINE_EXCLUDE` (no extra excludes — Worker
    // collapses Scout+Generator and carries the union of their execution
    // surfaces). Mutation-guard wraps applied to bash/write/edit/multi_edit
    // for `plan.decision.primaryTask='review'` discipline. Dispatch is
    // role-wrapped (V2 dispatch uses the same write-fan-out wiring as
    // Generator). FEATURE_120 send_message / task_stop now land in the
    // schema (previously missing — see CHANGELOG / commit log). FEATURE_161
    // module_context / symbol_context / process_context / impact_estimate
    // pull tools also now land in the schema (previously missing).
    tools: [
      handoffEmit,
      ...buildAgentToolsFromRegistry(
        'worker',
        ctx,
        budget,
        events,
        new Map<string, RunnableTool>([
          ['bash', wrapGeneratorBashWithMutationGuard(codingTools.bash, recorder, planRef)],
          ['write', wrapGeneratorWriteWithMutationGuard(codingTools.write, recorder, planRef)],
          ['edit', wrapGeneratorWriteWithMutationGuard(codingTools.edit, recorder, planRef)],
          ['multi_edit', wrapGeneratorWriteWithMutationGuard(codingTools.multiEdit, recorder, planRef)],
          ['dispatch_child_task', workerDispatch],
          ['todo_update', codingTools.todoUpdate],
        ]),
      ),
    ],
    handoffs: undefined,
    // Worker plans + executes, so it warrants the deeper reasoning
    // budget Generator gets in the V1 path. `escalateOnRevise:true`
    // matches Generator: when Evaluator returns `revise`, the next
    // Worker turn lifts to deep reasoning to break the retry loop
    // (Slice 3b wires the revise transition).
    reasoning: { default: 'balanced', max: 'deep', escalateOnRevise: true },
  };

  const scoutHandoffs: Handoff[] = [
    { target: generator, kind: 'continuation', description: 'Upgrade to H1 — execute + evaluate' },
    { target: planner, kind: 'continuation', description: 'Upgrade to H2 — plan + execute + evaluate' },
  ];
  // FEATURE_107 (v0.7.32) — empirical conclusion: H2-A (full Planner
  // transcript) and H2-B (only emit_contract artifact) produce identical
  // Generator outcomes across 6 aliases × 3 cases (boundary suite, 0pp
  // delta). Therefore the v0.7.16 design "new session + plan artifact" is
  // not implemented — the current full-transcript behaviour is equivalent
  // and simpler. No inputFilter is wired.
  const plannerHandoffs: Handoff[] = [
    { target: generator, kind: 'continuation', description: 'Hand off execution to Generator' },
  ];
  const generatorHandoffs: Handoff[] = [
    { target: evaluator, kind: 'continuation', description: 'Hand off to Evaluator for verification' },
  ];
  // FEATURE_114 v0.7.36 Slice 3b — Evaluator's revise handoff target
  // depends on which executor is active for this run. V1: revise →
  // Generator. V2: revise → Worker. The handoff list always carries
  // Planner (replan path: works for both V1 and V2 H2 escalation) and
  // exactly one executor target; the LLM-driven handoff selection
  // route via `resolveHandoffTarget` rewrite (verdict-slot wrapper
  // below) targets the same executor literally.
  //
  // Reading `isHarnessV2Enabled()` at chain-build time is safe: a run
  // can't change harness mid-flight (the flag is a process-level
  // env var, not per-request), so the chain's structural target
  // matches the runtime's selected entry agent.
  const v2ActiveAtChainBuild = isHarnessV2Enabled();
  const evaluatorHandoffs: Handoff[] = v2ActiveAtChainBuild
    ? [
      { target: worker, kind: 'continuation', description: 'V2 revise — retry execution via Worker' },
      { target: planner, kind: 'continuation', description: 'replan — revise the contract' },
    ]
    : [
      { target: generator, kind: 'continuation', description: 'revise — retry execution' },
      { target: planner, kind: 'continuation', description: 'replan — revise the contract' },
    ];
  const workerHandoffs: Handoff[] = [
    { target: evaluator, kind: 'continuation', description: 'Hand off to Evaluator for verification' },
  ];

  scout.handoffs = scoutHandoffs;
  planner.handoffs = plannerHandoffs;
  generator.handoffs = generatorHandoffs;
  evaluator.handoffs = evaluatorHandoffs;
  worker.handoffs = workerHandoffs;

  return {
    scout: Object.freeze(scout) as Agent,
    planner: Object.freeze(planner) as Agent,
    generator: Object.freeze(generator) as Agent,
    evaluator: Object.freeze(evaluator) as Agent,
    worker: Object.freeze(worker) as Agent,
  };
}

/**
 * Shard 5a backward-compat: returns just the Scout from a chain (used by
 * existing callers that expected a single Scout agent). Tests that
 * previously asserted `scout.handoffs === undefined` need updating — Shard 5b
 * wires the full topology.
 */
export function buildRunnerScoutAgent(ctx: KodaXToolExecutionContext): Agent {
  const recorder: VerdictRecorder = {};
  return buildRunnerAgentChain(ctx, recorder).scout;
}

// =============================================================================
// LLM adapter: KodaX provider stream → RunnerLlmResult
// =============================================================================

/**
 * Cumulative token state captured by the LLM adapter across a full
 * runner chain, exposed back to `runManagedTaskViaRunner` so it can
 * populate `result.contextTokenSnapshot`. The REPL UI uses the snapshot
 * to refresh its token counter after every run.
 */
export interface RunnerAdapterTokenState {
  totalTokens: number;
  lastUsage?: import('@kodax-ai/llm').KodaXTokenUsage;
  source: 'api' | 'estimate';
}

// P2b write-turn max_output_tokens cap — moved to
// `./_internal/managed-task/write-turn-cap.ts` (FEATURE_171 v0.7.41 split).
// `maybeApplyP2bWriteTurnCap` is re-exported at the top of this file.

/**
 * C1 parity helper — map a registered Runner Agent name to its managed
 * task role. Used by the fenced-block fallback path in the LLM adapter
 * to decide which emit tool to synthesize when the LLM wrote the
 * fence but skipped the tool call.
 */
function agentNameToManagedRole(
  name: string,
): Exclude<KodaXTaskRole, 'direct'> | undefined {
  switch (name) {
    case SCOUT_AGENT_NAME: return 'scout';
    case PLANNER_AGENT_NAME: return 'planner';
    case GENERATOR_AGENT_NAME: return 'generator';
    case EVALUATOR_AGENT_NAME: return 'evaluator';
    default: return undefined;
  }
}

/**
 * C1 parity helper — unwrap the per-role slice from a normalized
 * managed-protocol payload so it matches the emit tool's snake_case
 * input schema. The real emitter re-runs `coerceManagedProtocolToolPayload`
 * on this input, so the shape just needs to round-trip cleanly; we
 * intentionally emit snake_case keys matching the tool schema.
 */
function flattenNormalizedForEmitterInput(
  payload: Partial<KodaXManagedProtocolPayload>,
): Record<string, unknown> {
  if (payload.scout) {
    const s = payload.scout;
    return {
      summary: s.summary,
      scope: s.scope,
      required_evidence: s.requiredEvidence,
      review_files_or_areas: s.reviewFilesOrAreas,
      evidence_acquisition_mode: s.evidenceAcquisitionMode,
      confirmed_harness: s.confirmedHarness,
      harness_rationale: s.harnessRationale,
      blocking_evidence: s.blockingEvidence,
      direct_completion_ready: s.directCompletionReady,
      skill_map: s.skillMap
        ? {
          skill_summary: s.skillMap.skillSummary,
          execution_obligations: s.skillMap.executionObligations,
          verification_obligations: s.skillMap.verificationObligations,
          ambiguities: s.skillMap.ambiguities,
          projection_confidence: s.skillMap.projectionConfidence,
        }
        : undefined,
    };
  }
  if (payload.contract) {
    return {
      summary: payload.contract.summary,
      success_criteria: payload.contract.successCriteria,
      required_evidence: payload.contract.requiredEvidence,
      constraints: payload.contract.constraints,
    };
  }
  if (payload.handoff) {
    return {
      status: payload.handoff.status,
      summary: payload.handoff.summary,
      evidence: payload.handoff.evidence,
      followup: payload.handoff.followup,
    };
  }
  if (payload.verdict) {
    return {
      status: payload.verdict.status,
      reason: payload.verdict.reason,
      followup: payload.verdict.followups,
      user_answer: payload.verdict.userAnswer,
      next_harness: payload.verdict.nextHarness,
    };
  }
  return {};
}

export function buildRunnerLlmAdapter(
  options: KodaXOptions,
  overrideStream?: (
    messages: readonly KodaXMessage[],
    tools: readonly KodaXToolDefinition[],
    system: string,
  ) => Promise<{ textBlocks?: readonly { text: string }[]; toolBlocks?: readonly KodaXToolUseBlock[] }>,
  tokenStateRef?: { current: RunnerAdapterTokenState },
  /**
   * FEATURE_078: optional callback that returns Scout's current
   * `downstream_reasoning_hint` (L3 input). Called once per per-role
   * adapter invocation so the resolver sees the hint as soon as the
   * Scout payload is populated. Returning `undefined` bypasses L3 and
   * falls back to L2 (`agent.reasoning.default`) clamped by L1
   * (user ceiling). The callback closes over the AMA frame's recorder.
   */
  getScoutReasoningHint?: () => KodaXReasoningMode | undefined,
  /**
   * v0.7.40 — optional API-accurate context-size snapshot ref. The
   * adapter writes this ref after each successful LLM stream so the
   * AMA compaction hook (`buildManagedTaskCompactionHook`) can read
   * `usage.totalTokens` + delta-adjusted message growth instead of
   * the transcript-only estimate. Without this wiring, the hook
   * systematically underestimated context by the system + tools
   * schema overhead (~20-35k after FEATURE_114 4→2 role
   * consolidation) and never triggered compaction. See
   * `_internal/managed-task/compaction.ts` for the consumer side.
   */
  contextTokenSnapshotRef?: import('./_internal/managed-task/compaction.js').ContextTokenSnapshotRef,
  /**
   * FEATURE_097 (v0.7.34) §5 ② — Layer 2 throttle reminder hook. When
   * provided, the adapter:
   *   1. detects agent transitions and resets the counter on each one
   *   2. checks `shouldFireTodoReminder` before each provider call;
   *      if it fires, appends the `<system-reminder>` text to `system`
   *      so the model sees it before its next response
   *   3. ticks the counter forward (one round = one adapter call)
   * Omitting either argument disables the reminder logic entirely
   * (older callers / unit-test fixtures).
   */
  todoStore?: TodoStore,
  todoReminderState?: TodoReminderState,
): (messages: readonly KodaXMessage[], agent: Agent) => Promise<RunnerLlmResult> {
  // FEATURE_072 parity: the REPL's token-count indicator reads
  // `onIterationEnd` to refresh after each worker LLM turn. Track a
  // monotonically-increasing iteration counter across the entire runner
  // chain so the REPL sees progress for every role's turn.
  let iteration = 0;
  const MAX_ITER_HINT = 20; // matches core/src/runner-tool-loop.ts MAX_TOOL_LOOP_ITERATIONS

  // Cost tracker — one per session; `recordUsage` is called after every
  // provider.stream usage payload. REPL /cost reads through
  // `events.getCostReport.current`.
  let costTracker: CostTracker = createCostTracker();
  if (options.events?.getCostReport) {
    options.events.getCostReport.current = () =>
      formatCostReport(getCostSummary(costTracker));
  }

  return async (messages, agent) => {
    // Strip every leading contiguous system message and concatenate their
    // content. v0.7.22-style flows pushed a single agent-instructions system
    // prompt and nothing else, so taking only `messages[0]` was enough. The
    // Runner-driven path stacks [compaction-summary, post-compact-ledger,
    // post-compact-file-content, ...] after compaction+inject, and after a
    // handoff `replaceSystemMessage` only swaps [0] — the rest stay leading
    // system entries. Keeping only the first one would strand agent role
    // instructions (Scout/Planner/Generator/Evaluator) behind the summary and
    // still leak secondary system messages into the transcript, which the
    // provider layer now merges but which would otherwise confuse strict
    // proxies that reject any non-leading system message.
    let cut = 0;
    while (cut < messages.length && messages[cut]?.role === 'system') {
      cut += 1;
    }
    const systemParts: string[] = [];
    for (let i = 0; i < cut; i += 1) {
      const content = messages[i]!.content;
      const text = typeof content === 'string' ? content : '';
      if (text.trim().length > 0) {
        systemParts.push(text);
      }
    }
    let system = systemParts.join('\n\n');
    const transcript = messages.slice(cut);

    // FEATURE_097 (v0.7.34) §5 ② — Layer 2 throttle reminder. Detect
    // agent transitions to reset the counter (per-task scope, but a
    // role swap is a natural reset point — Scout → Planner → Generator
    // → Evaluator each represent a fresh attempt at making progress on
    // the list). Then, if the threshold has been hit and we're armed,
    // append the reminder text to `system` so the model reads it
    // alongside its role instructions on this exact turn. Finally,
    // tick the counter forward — one adapter call = one round.
    if (todoStore && todoReminderState) {
      if (detectAgentTransition(todoReminderState, agent.name)) {
        resetTodoReminderState(todoReminderState);
      }
      if (shouldFireTodoReminder(todoReminderState, todoStore)) {
        const reminder = buildTodoReminderText(todoStore);
        system = system.length > 0 ? `${system}\n\n${reminder}` : reminder;
      }
      tickTodoReminder(todoReminderState);
    }

    const wireTools: KodaXToolDefinition[] = (agent.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));

    // FEATURE_078 (v0.7.29): resolve per-role reasoning through the L1-L4
    // chain rather than reading `agent.reasoning?.default` directly:
    //   L1 (user ceiling)   ← `--reasoning <mode>` / options.reasoningMode
    //   L2 (agent default)  ← agent.reasoning.default + .max
    //   L3 (scout hint)     ← Scout's downstream_reasoning_hint, if any
    //   L4 (revise escalate) — handled later by escalateThinkingDepth
    // Pre-FEATURE_078 path was L2 only; that path is preserved when no
    // user ceiling override + no scout hint is in play (resolver collapses).
    const userCeiling = resolveReasoningMode(options);
    const scoutHint = getScoutReasoningHint?.();
    const role: ReasoningRole =
      agent.name === SCOUT_AGENT_NAME ? 'scout'
      : agent.name === PLANNER_AGENT_NAME ? 'planner'
      : agent.name === GENERATOR_AGENT_NAME ? 'generator'
      : agent.name === EVALUATOR_AGENT_NAME ? 'evaluator'
      : 'sa';
    const reasoningMode = resolveRoleReasoning(role, userCeiling, agent.reasoning, scoutHint);
    const providerReasoning: import('@kodax-ai/llm').KodaXReasoningRequest | undefined =
      reasoningMode === 'off'
        ? { enabled: false, mode: 'off' }
        : {
            enabled: true,
            mode: reasoningMode,
            depth: reasoningModeToDepth(reasoningMode),
          };

    iteration += 1;
    options.events?.onIterationStart?.(iteration, MAX_ITER_HINT);

    // FEATURE_164 (v0.7.41) — mid-iteration yield retired here.
    //
    // The legacy v0.7.26 F1 parity check used to fire `hasQueuedFollowUp`
    // at this exact boundary and `return { text:'', toolCalls:[] }` to
    // force Runner.run to exit the loop. v0.7.40 FEATURE_159 made it
    // worse by routing the predicate through MessageQueue directly —
    // any user-typed prompt entering the queue mid-Q1 triggered the
    // empty-turn yield, polluting the transcript with `{type:'text',
    // text:''}` placeholder, surfacing `[No response text was produced
    // for this round]` in the REPL, and feeding the model an empty
    // assistant turn before the next user message.
    //
    // Replacement: claudecode-style mid-turn injection via the agent
    // package's `beforeNextTurn` hook (see the Runner.run wiring in
    // `runManagedTaskViaRunnerInner`). The hook drains queued user
    // prompts AFTER tool execution and BEFORE the next LLM call,
    // splicing them as real user messages into the transcript — Worker
    // keeps running, the LLM sees the new prompts in its next turn,
    // and no empty assistant turn ever reaches the transcript.

    let streamResult: {
      textBlocks?: readonly { text: string }[];
      toolBlocks?: readonly KodaXToolUseBlock[];
      thinkingBlocks?: readonly (
        | import('@kodax-ai/llm').KodaXThinkingBlock
        | import('@kodax-ai/llm').KodaXRedactedThinkingBlock
      )[];
      usage?: import('@kodax-ai/llm').KodaXTokenUsage;
    };
    if (overrideStream) {
      streamResult = await overrideStream(transcript, wireTools, system);
    } else {
      const provider = resolveProvider(options.provider ?? 'anthropic');
      const providerName = options.provider ?? provider.name ?? 'anthropic';
      // Shard 6d-P: restore the legacy second-tier retry/recovery loop
      // (agent.ts:1955-2198). Without this, any transient stream error
      // (network/terminated/stream-incomplete/idle-timeout) aborts the
      // whole managed run on the first failure — no retry, no
      // `onProviderRecovery` event, and the REPL's onError handler ends
      // up printing the raw error via console.log which Ink places below
      // the user prompt instead of inline with the worker output.
      //
      // Mirrors the legacy loop: classify → decide → onProviderRecovery →
      // optional non-streaming fallback → executeRecovery (prune
      // incomplete tool_use turns) → waitForRetryDelay → retry.
      const resilienceCfg = resolveResilienceConfig(providerName);
      const API_HARD_TIMEOUT_MS = resilienceCfg.requestTimeoutMs;
      const API_IDLE_TIMEOUT_MS = resilienceCfg.streamIdleTimeoutMs;
      const boundaryTracker = new StableBoundaryTracker();
      const supportsFallback = typeof provider.supportsNonStreamingFallback === 'function'
        ? provider.supportsNonStreamingFallback()
        : false;
      const recoveryCoordinator = new ProviderRecoveryCoordinator(boundaryTracker, {
        ...resilienceCfg,
        enableNonStreamingFallback: resilienceCfg.enableNonStreamingFallback && supportsFallback,
      });
      // P2b (v0.7.26) — cap max_output_tokens on turns where the tool
      // inventory exposes `write` / `edit` / `multi_edit` for providers
      // that reproducibly RST the streaming connection during large
      // tool_use buffering (zhipu-coding / kimi-code / minimax-coding
      // observed). Rationale: an 8K ceiling physically prevents the
      // model from emitting a tool_use payload large enough to hit the
      // RST window, closing the "Scout jumps to Python to avoid write
      // streaming issues" escape path at the provider layer instead of
      // relying on prompt compliance. Works together with P2a
      // (multi_edit makes skeleton + batched edits cheap, so the cap
      // doesn't force awkward workflows).
      //
      // Override list: `KODAX_RST_PRONE_PROVIDERS` (comma-separated).
      // Override cap:  `KODAX_WRITE_TURN_MAX_TOKENS` (integer).
      // L4 escalation (64K) still fires on stop_reason=max_tokens and
      // takes precedence if the LLM genuinely needs more headroom.
      // `hasAppliedP2bWriteCap` tracks per-turn application so we can
      // clear the override on cleanup (prevents the cap from leaking to
      // the NEXT adapter invocation on the same provider instance).
      const hasAppliedP2bWriteCap = maybeApplyP2bWriteTurnCap(
        provider,
        providerName,
        wireTools,
      );
      let providerMessages: KodaXMessage[] = [...transcript];
      // Clean incomplete tool calls and validate tool history before
      // every provider call (CAP-002). Both helpers come from
      // `agent-runtime/history-cleanup.ts` and are shared with the
      // SA-mode substrate (see catch-terminals.ts:runCatchCleanup).
      providerMessages = cleanupIncompleteToolCalls(providerMessages);
      providerMessages = validateAndFixToolHistory(providerMessages);
      let attempt = 0;
      let raw!: Awaited<ReturnType<typeof provider.stream>>;
      // FEATURE_085 parity for the Scout/Runner path: mirror the main
      // agent loop's max_tokens escalation (cd213e4). When a capped-budget
      // turn returns stop_reason:max_tokens we retry the SAME stream call
      // once with KODAX_ESCALATED_MAX_OUTPUT_TOKENS (64K). At most one
      // escalation per adapter invocation — if 64K still hits the cap,
      // we surface the partial result so the Runner's outer loop can see
      // it and decide next steps. Full L5 continuation (meta "break into
      // smaller pieces") is handled by prompt-level guidance in system.ts
      // + write/edit tool descriptions rather than framework plumbing
      // through the Runner turn boundary.
      let hasEscalatedForCurrentAdapterCall = false;
      while (true) {
        attempt += 1;
        boundaryTracker.beginRequest(
          providerName,
          provider.getModel?.() ?? options.modelOverride ?? 'unknown',
          providerMessages,
          attempt,
          false,
        );
        telemetryBoundary(boundaryTracker.snapshot());

        const retryTimeoutController = new AbortController();
        let hardTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
          retryTimeoutController.abort(new Error('API Hard Timeout (10 minutes)'));
        }, API_HARD_TIMEOUT_MS);
        const idleEnabled = API_IDLE_TIMEOUT_MS > 0;
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        if (idleEnabled) {
          idleTimer = setTimeout(() => {
            retryTimeoutController.abort(
              new Error(`Stream stalled or delayed response (${API_IDLE_TIMEOUT_MS}ms idle)`),
            );
          }, API_IDLE_TIMEOUT_MS);
        }
        const resetIdleTimer = () => {
          if (!idleEnabled) return;
          if (idleTimer) clearTimeout(idleTimer);
          if (!retryTimeoutController.signal.aborted) {
            idleTimer = setTimeout(() => {
              retryTimeoutController.abort(
                new Error(`Stream stalled or delayed response (${API_IDLE_TIMEOUT_MS}ms idle)`),
              );
            }, API_IDLE_TIMEOUT_MS);
          }
        };
        const retrySignal = options.abortSignal
          ? AbortSignal.any([options.abortSignal, retryTimeoutController.signal])
          : retryTimeoutController.signal;

        const payloadBytes = estimateProviderPayloadBytes(providerMessages, system);
        emitResilienceDebug('[resilience:request]', {
          provider: providerName,
          attempt,
          fallbackActive: false,
          payloadBytes,
          payloadBucket: bucketProviderPayloadSize(payloadBytes),
        });

        // Wire the boundary tracker into the stream callbacks — the
        // coordinator inspects these markers to decide whether a failure
        // happened before the first delta, mid-stream, post-tool, etc.
        const streamOptions = {
          onTextDelta: (text: string) => {
            boundaryTracker.markTextDelta(text);
            resetIdleTimer();
            // M2 parity (v0.7.26) — scrub managed control-plane markers
            // and incomplete managed fences from the streamed delta
            // before surfacing to `events.onTextDelta`. Without this,
            // mid-turn `[managed-task] ...` / `<scout_verdict>` tags
            // briefly appear in REPL live output even though they're
            // stripped from the final turn text. Matches legacy
            // behaviour where managed-worker streams routed through
            // `sanitizeManagedStreamingText` before the REPL saw them.
            // The sanitize call trims — only apply it when we actually
            // detect a marker in this delta to preserve mid-token
            // whitespace in the common clean-delta case.
            const hasMarker = text.includes('```')
              || MANAGED_CONTROL_PLANE_MARKERS.some((marker) => text.includes(marker));
            const outText = hasMarker ? sanitizeManagedStreamingText(text) : text;
            if (outText.length === 0) return;
            options.events?.onTextDelta?.(outText);
          },
          onThinkingDelta: (text: string) => {
            boundaryTracker.markThinkingDelta(text);
            resetIdleTimer();
            options.events?.onThinkingDelta?.(text);
          },
          onThinkingEnd: (thinking: string) => {
            options.events?.onThinkingEnd?.(thinking);
          },
          onToolInputDelta: options.events?.onToolInputDelta,
        };

        try {
          raw = await provider.stream(
            providerMessages,
            [...wireTools],
            system,
            providerReasoning,
            streamOptions,
            retrySignal,
          );
          // max_tokens escalation: if the capped budget hit the cap and
          // we haven't yet escalated this adapter call, stage
          // KODAX_ESCALATED_MAX_OUTPUT_TOKENS for the next iteration and
          // re-enter the loop. Skipped when the user explicitly set
          // KODAX_MAX_OUTPUT_TOKENS or the effective budget already meets
          // the escalated threshold. Mirrors agent.ts:2264-2284.
          if (
            raw.stopReason === 'max_tokens'
            && !hasEscalatedForCurrentAdapterCall
            && !process.env.KODAX_MAX_OUTPUT_TOKENS
            && provider.getEffectiveMaxOutputTokens() < KODAX_ESCALATED_MAX_OUTPUT_TOKENS
          ) {
            hasEscalatedForCurrentAdapterCall = true;
            provider.setMaxOutputTokensOverride(KODAX_ESCALATED_MAX_OUTPUT_TOKENS);
            options.events?.onRetry?.(
              `Output budget reached, escalating to ${KODAX_ESCALATED_MAX_OUTPUT_TOKENS} tokens and retrying the same turn`,
              1,
              1,
            );
            if (hardTimer) clearTimeout(hardTimer);
            if (idleTimer) clearTimeout(idleTimer);
            hardTimer = undefined;
            idleTimer = undefined;
            // Escalation is a same-turn re-issue (change max_tokens, replay same messages),
            // not an error recovery. Reverse the `attempt += 1` at the top of the loop so
            // this iteration does not consume a slot from `resilienceCfg.maxRetries`. The
            // next iteration's attempt will be the same as this one, and subsequent real
            // errors still get the full retry budget.
            attempt -= 1;
            continue;
          }
          break;
        } catch (rawError) {
          let error = rawError instanceof Error ? rawError : new Error(String(rawError));
          if (
            error.name === 'AbortError'
              && retryTimeoutController.signal.aborted
              && !options.abortSignal?.aborted
          ) {
            const reason = (retryTimeoutController.signal as { reason?: { message?: string } })
              .reason?.message ?? 'Stream stalled';
            const { KodaXNetworkError } = await import('@kodax-ai/llm');
            error = new KodaXNetworkError(reason, true);
          }

          const failureStage = boundaryTracker.inferFailureStage();
          const classified = classifyResilienceError(error, failureStage);
          telemetryClassify(error, classified);
          const decision = recoveryCoordinator.decideRecoveryAction(error, classified, attempt);
          telemetryDecision(decision, attempt);

          options.events?.onProviderRecovery?.({
            stage: decision.failureStage,
            errorClass: decision.reasonCode,
            attempt,
            maxAttempts: resilienceCfg.maxRetries,
            delayMs: decision.delayMs,
            recoveryAction: decision.action,
            ladderStep: decision.ladderStep,
            fallbackUsed: decision.shouldUseNonStreaming,
            serverRetryAfterMs: decision.serverRetryAfterMs,
          });
          // Dedicated rate-limit event so REPL can render a distinct 429
          // banner (separate from the generic retry UI).
          if (decision.reasonCode === 'rate_limit' && options.events) {
            emitProviderRateLimit(
              options.events,
              attempt,
              resilienceCfg.maxRetries,
              decision.delayMs,
            );
          }
          if (!options.events?.onProviderRecovery && decision.action !== 'manual_continue') {
            options.events?.onRetry?.(
              `${describeTransientProviderRetry(error)} · retry ${attempt}/${resilienceCfg.maxRetries} in ${Math.round(decision.delayMs / 1000)}s`,
              attempt,
              resilienceCfg.maxRetries,
            );
          }

          if (decision.shouldUseNonStreaming && typeof provider.complete === 'function') {
            const fallbackTimeoutController = new AbortController();
            const fallbackSignal = options.abortSignal
              ? AbortSignal.any([options.abortSignal, fallbackTimeoutController.signal])
              : fallbackTimeoutController.signal;
            const fallbackHardTimer = setTimeout(() => {
              fallbackTimeoutController.abort(new Error('API Hard Timeout (10 minutes)'));
            }, API_HARD_TIMEOUT_MS);
            try {
              if (idleTimer) clearTimeout(idleTimer);
              if (hardTimer) clearTimeout(hardTimer);
              hardTimer = undefined;
              idleTimer = undefined;
              boundaryTracker.beginRequest(
                providerName,
                provider.getModel?.() ?? options.modelOverride ?? 'unknown',
                providerMessages,
                attempt,
                true,
              );
              telemetryBoundary(boundaryTracker.snapshot());
              raw = await provider.complete(
                providerMessages,
                [...wireTools],
                system,
                providerReasoning,
                {
                  onTextDelta: (text: string) => {
                    boundaryTracker.markTextDelta(text);
                    options.events?.onTextDelta?.(text);
                  },
                  onThinkingDelta: (text: string) => {
                    boundaryTracker.markThinkingDelta(text);
                    options.events?.onThinkingDelta?.(text);
                  },
                  onThinkingEnd: (thinking: string) => {
                    options.events?.onThinkingEnd?.(thinking);
                  },
                  signal: fallbackSignal,
                },
                fallbackSignal,
              );
              break;
            } catch (fallbackError) {
              error = fallbackError instanceof Error ? fallbackError : new Error(String(fallbackError));
            } finally {
              clearTimeout(fallbackHardTimer);
            }
          }

          // sanitize_thinking_and_retry is a single-shot history-mutation
          // recovery (drop thinking blocks once, retry once) and must
          // bypass the regular retry-budget gate. It's gated by its own
          // `thinkingSanitizationUsed` latch inside the coordinator, so
          // it can fire at most once per request chain regardless of how
          // many normal retries already happened. v0.7.28.
          if (decision.action === 'sanitize_thinking_and_retry') {
            const recovery = recoveryCoordinator.executeRecovery(providerMessages, decision);
            telemetryRecovery(decision.action, recovery);
            providerMessages = recovery.messages;
            if (hardTimer) clearTimeout(hardTimer);
            if (idleTimer) clearTimeout(idleTimer);
            hardTimer = undefined;
            idleTimer = undefined;
            // Don't bill an attempt slot for the sanitize step — same
            // rationale as the L1 escalation reversal at line ~2546.
            attempt -= 1;
            await waitForRetryDelay(decision.delayMs, options.abortSignal);
            continue;
          }

          if (decision.action === 'manual_continue' || attempt >= resilienceCfg.maxRetries) {
            // Preserve in-flight providerMessages on the thrown error so the
            // outer wrapper's session-snapshot save can persist real history
            // instead of `[]`. Non-enumerable so JSON-serializing telemetry
            // does not dump conversation history into logs. The outer catch
            // uses Array.isArray as a guard.
            Object.defineProperty(error, '__kodaxRecoveredMessages', {
              value: providerMessages,
              enumerable: false,
            });
            throw error;
          }

          const recovery = recoveryCoordinator.executeRecovery(providerMessages, decision);
          telemetryRecovery(decision.action, recovery);
          providerMessages = recovery.messages;

          if (hardTimer) clearTimeout(hardTimer);
          if (idleTimer) clearTimeout(idleTimer);
          hardTimer = undefined;
          idleTimer = undefined;
          await waitForRetryDelay(decision.delayMs, options.abortSignal);
          continue;
        } finally {
          if (hardTimer) clearTimeout(hardTimer);
          if (idleTimer) clearTimeout(idleTimer);
        }
      }

      // M6 parity (v0.7.26) — L5 continuation ladder. When L1 escalation
      // is exhausted and the model still hit max_tokens mid-text (no
      // tool blocks, has text), inject a synthetic user "Continue from
      // where you left off" message and re-stream up to
      // KODAX_MAX_MAXTOKENS_RETRIES times, accumulating text +
      // thinkingBlocks across turns. Mirrors legacy agent.ts:2316-2334.
      // Without this, long Generator replies that blow through the
      // escalated 64K cap get truncated silently — the assistant stops
      // mid-sentence and the Runner exits with a partial answer.
      let l5Retries = 0;
      let accumulatedText = (raw.textBlocks ?? []).map((b) => b.text).join('');
      type ThinkingBlock = import('@kodax-ai/llm').KodaXThinkingBlock
        | import('@kodax-ai/llm').KodaXRedactedThinkingBlock;
      const accumulatedThinking: ThinkingBlock[] | undefined = raw.thinkingBlocks
        ? [...raw.thinkingBlocks]
        : undefined;
      while (
        raw.stopReason === 'max_tokens'
        && (raw.toolBlocks?.length ?? 0) === 0
        && accumulatedText.trim().length > 0
        && l5Retries < KODAX_MAX_MAXTOKENS_RETRIES
      ) {
        l5Retries += 1;
        options.events?.onTextDelta?.('\n\n[max_tokens reached, continuing...]\n\n');
        // Push the partial assistant turn + synthetic user continuation
        // onto the outgoing transcript. The provider will see the full
        // mid-thought state and pick up seamlessly.
        //
        // Thinking blocks accumulated so far must ride along on the
        // synthetic assistant turn. Without them, providers in strict
        // thinking-mode (deepseek V4) reject the next replay with
        // "reasoning_content must be passed back to the API" — the
        // synthetic turn would be a thinking-less assistant message in
        // a thinking-enabled request, which violates their per-turn
        // contract. Mirrors what agent.ts:2294 does for the legacy
        // path: thinking + text + tool_use stack on the assistant
        // message in history.
        const assistantContent: KodaXContentBlock[] = [
          ...(accumulatedThinking ?? []),
          { type: 'text', text: accumulatedText },
        ];
        providerMessages = [
          ...providerMessages,
          { role: 'assistant', content: assistantContent } as KodaXMessage,
          {
            role: 'user',
            content: [{
              type: 'text',
              text:
                'Output token limit hit. Resume directly — no apology, no recap of what you were doing. '
                + 'Pick up mid-thought if that is where the cut happened. '
                + 'Break remaining work into smaller pieces.',
            }],
          } as KodaXMessage,
        ];
        options.events?.onRetry?.(
          `max_tokens mid-text, appending continuation ${l5Retries}/${KODAX_MAX_MAXTOKENS_RETRIES}`,
          l5Retries,
          KODAX_MAX_MAXTOKENS_RETRIES,
        );
        const l5Signal = options.abortSignal ?? undefined;
        try {
          raw = await provider.stream(
            providerMessages,
            [...wireTools],
            system,
            providerReasoning,
            {
              onTextDelta: (text: string) => {
                const hasMarker = text.includes('```')
                  || MANAGED_CONTROL_PLANE_MARKERS.some((marker) => text.includes(marker));
                const outText = hasMarker ? sanitizeManagedStreamingText(text) : text;
                if (outText.length === 0) return;
                options.events?.onTextDelta?.(outText);
              },
              onThinkingDelta: (text: string) => {
                options.events?.onThinkingDelta?.(text);
              },
              onThinkingEnd: (thinking: string) => {
                options.events?.onThinkingEnd?.(thinking);
              },
              onToolInputDelta: options.events?.onToolInputDelta,
            },
            l5Signal,
          );
        } catch {
          // L5 retries are best-effort — any failure here falls back to
          // the partial result we already have.
          break;
        }
        const nextText = (raw.textBlocks ?? []).map((b) => b.text).join('');
        if (nextText) accumulatedText += nextText;
        if (raw.thinkingBlocks && accumulatedThinking) {
          accumulatedThinking.push(...raw.thinkingBlocks);
        }
        // Exit early on tool calls or natural stop.
        if ((raw.toolBlocks?.length ?? 0) > 0 || raw.stopReason !== 'max_tokens') {
          break;
        }
      }

      streamResult = {
        textBlocks: accumulatedText ? [{ text: accumulatedText }] : raw.textBlocks,
        toolBlocks: raw.toolBlocks,
        thinkingBlocks: accumulatedThinking ?? raw.thinkingBlocks,
        usage: raw.usage,
      };

      // P2b cleanup — if we applied the write-turn cap, ensure the
      // override doesn't leak to the next adapter invocation on this
      // same provider instance. Base provider clears on success inside
      // withRateLimit, but failure paths keep the override. Clearing
      // unconditionally here is safe: L4 escalation sets and clears
      // its own override within the retry loop, and any fresh
      // invocation will re-apply its own policy.
      if (hasAppliedP2bWriteCap) {
        provider.setMaxOutputTokensOverride(undefined);
      }
    }

    // Update cumulative token state for the final contextTokenSnapshot.
    if (tokenStateRef && streamResult.usage) {
      const current = tokenStateRef.current;
      tokenStateRef.current = {
        totalTokens: streamResult.usage.totalTokens ?? current.totalTokens,
        lastUsage: streamResult.usage,
        source: 'api',
      };
    }

    // v0.7.40 — refresh the API-accurate snapshot ref so the AMA
    // compaction hook can compute `resolveContextTokenCount(transcript,
    // snapshot)` on its next call. `messages` here is the adapter's
    // input (the transcript at LLM-call time); subsequent Runner
    // appends (assistant + tool_results) become the delta on top of
    // this baseline. Mirrors SA path's `createCompletedTurnTokenSnapshot`
    // in `run-substrate.ts`. Inlined rather than imported to keep the
    // snapshot-construction logic colocated with its single consumer.
    if (contextTokenSnapshotRef && streamResult.usage) {
      const baselineEstimatedTokens = estimateTokens(messages as KodaXMessage[]);
      const apiTotal = streamResult.usage.totalTokens;
      if (typeof apiTotal === 'number' && Number.isFinite(apiTotal) && apiTotal >= 0) {
        contextTokenSnapshotRef.current = {
          currentTokens: apiTotal,
          baselineEstimatedTokens,
          source: 'api',
          usage: streamResult.usage,
        };
      }
    }

    // Record turn usage into the cost tracker so `/cost` reflects AMA spend.
    if (streamResult.usage) {
      const providerName = options.provider ?? 'anthropic';
      costTracker = recordCostUsage(costTracker, {
        provider: providerName,
        model: options.modelOverride ?? options.model ?? 'unknown',
        inputTokens: streamResult.usage.inputTokens,
        outputTokens: streamResult.usage.outputTokens,
        cacheReadTokens: streamResult.usage.cachedReadTokens,
        cacheWriteTokens: streamResult.usage.cachedWriteTokens,
      });
    }

    // onStreamEnd fires after the provider finishes the current turn's
    // stream. The Runner-driven adapter funnels every turn through this
    // single return-path so the event fires once per stream.
    if (options.events) emitStreamEnd(options.events);

    // Fire onIterationEnd so the REPL token-count indicator can refresh
    // after each worker turn. `scope: 'worker'` mirrors the FEATURE_072
    // tagging — every Runner-driven iteration runs inside a worker role,
    // never the top-level REPL agent.
    if (options.events?.onIterationEnd) {
      const usage = streamResult.usage;
      const tokenCount = usage?.totalTokens ?? usage?.outputTokens ?? 0;
      options.events.onIterationEnd({
        iter: iteration,
        maxIter: MAX_ITER_HINT,
        tokenCount,
        tokenSource: usage ? 'api' : 'estimate',
        usage,
        scope: 'worker',
      });
    }

    const text = (streamResult.textBlocks ?? []).map((b) => b.text).join('');
    const toolCalls = (streamResult.toolBlocks ?? []).map((b) => ({
      id: b.id,
      name: b.name,
      input: b.input ?? {},
    }));

    // C1 parity (v0.7.26) — fenced-block fallback. v0.7.22 ran
    // `managedProtocolPayload?.scout ?? parseManagedTaskScoutDirective(text)`
    // at 4 call sites so an LLM that writes a well-formed `kodax-task-*`
    // block but forgets to call the emit tool still advances the
    // pipeline. The Runner-driven path lost this until now — a missed
    // emit stalls the entire run (task never records Scout/Handoff/
    // Verdict, Runner loops until the 500-iteration safety cap trips).
    //
    // Strategy: detect "LLM didn't call the expected emit_* tool this
    // turn, but assistant text contains the role's kodax-task-* fence"
    // → parse the fence via `attemptProtocolTextFallback`, synthesize a
    // matching tool_call entry. The Runner will dispatch it through
    // the agent's already-registered emit tool + `wrapEmitterWithRecorder`,
    // so recorder / budget / handoff bookkeeping flows through the
    // exact same code path as a real tool call. Zero new state
    // machinery. Mirrors v0.7.22's `?? parseManagedTask*Directive`
    // fallback at task-engine.ts:3242 / 3297 / 3371 / 3416.
    const fallbackRole = agentNameToManagedRole(agent.name);
    if (fallbackRole && text.length > 0) {
      const expectedEmit = getEmitToolNameForRole(fallbackRole);
      const alreadyEmitted = expectedEmit
        ? toolCalls.some((tc) => tc.name === expectedEmit)
        : false;
      if (expectedEmit && !alreadyEmitted) {
        const synthesized = attemptProtocolTextFallback(fallbackRole, text);
        if (synthesized) {
          toolCalls.push({
            id: `fallback-${fallbackRole}-${Date.now()}`,
            name: expectedEmit,
            // Re-serialize the normalized payload as the synthetic tool
            // input. The real emitter will re-run `coerceManagedProtocolToolPayload`,
            // which is idempotent on already-normalized input (keys
            // already snake_case via the block body; camelCase fields
            // the normalizer produced round-trip cleanly via the
            // tool's schema).
            input: flattenNormalizedForEmitterInput(synthesized.payload) as Record<string, unknown>,
          });
          options.events?.onRetry?.(
            `[fallback] ${fallbackRole} emitted ${getManagedBlockNameForRole(fallbackRole) ?? 'fenced block'} without calling ${expectedEmit}; synthesizing tool call from block body`,
            0,
            0,
          );
        }
      }
    }
    // Forward thinking blocks so
    // `buildAssistantMessageFromLlmResult` can prepend them to the
    // assistant content. Required for Anthropic extended thinking —
    // provider returns 400 if prior assistant turns with tool_use are
    // missing the thinking block in history.
    const thinkingBlocks = streamResult.thinkingBlocks;
    return { text, toolCalls, thinkingBlocks };
  };
}

// =============================================================================
// Result conversion: RunResult + VerdictRecorder → KodaXResult.
//
// `extractUserFacingText`, `extractUserFacingRaw`, `deriveFinalStatus`
// and `buildManagedProtocolPayload` moved to
// `./_internal/managed-task/status-derivation.ts` (FEATURE_171 v0.7.41
// split). Imported at the top of this file.
// =============================================================================

// =============================================================================
// managedTask payload construction — Shard 6a
// =============================================================================

/**
 * Map the harness tier to the assignment-id convention legacy consumers
 * expect. H0 uses 'direct', H1/H2 use the role name.
 */
function harnessToBudget(harness: KodaXHarnessProfile): number {
  // Legacy per-harness global work budget constants (approximate; tests
  // only assert aggregate totals, not exact ceilings).
  if (harness === 'H0_DIRECT') return 50;
  if (harness === 'H1_EXECUTE_EVAL') return 400;
  return 600;
}

/**
 * Build the full `KodaXManagedTask` payload from the recorder, role
 * sequence, and run metadata. Fields are populated to the minimum
 * necessary for round-boundary reshape + REPL consumers + the subset of
 * test assertions mapped in Shard 6a's inventory.
 */
function buildManagedTaskPayload(args: {
  readonly prompt: string;
  readonly options: KodaXOptions;
  readonly recorder: VerdictRecorder;
  readonly rolesEmitted: readonly KodaXTaskRole[];
  readonly baseCtx: KodaXToolExecutionContext;
  readonly signal: KodaXResult['signal'];
  readonly verdictStatus?: 'accept' | 'revise' | 'blocked';
  readonly userAnswer?: string;
  readonly budget?: ManagedTaskBudgetController;
  readonly plan?: ReasoningPlan;
  readonly entries?: readonly KodaXTaskEvidenceEntry[];
  readonly degradedContinue?: boolean;
  readonly childWriteWorktreePaths?: ReadonlyMap<string, string>;
  /**
   * Stable taskId for the run. Callers that need deterministic snapshot
   * paths (runManagedTaskViaRunnerInner, checkpoint writer, skill-artifact
   * persistence) must pass the same id for every invocation in a run; if
   * omitted a fresh id is generated (back-compat for legacy callers).
   */
  readonly taskId?: string;
  /**
   * v0.7.26 C4 parity — extra evidence artefact records (e.g. skill
   * artifacts) that the caller has already persisted to disk and wants
   * merged into `evidence.artifacts` alongside the built-in snapshot set.
   */
  readonly extraArtifacts?: readonly KodaXTaskEvidenceArtifact[];
  /**
   * F4 parity (v0.7.26) — pre-floor routing decision (before
   * `applyCurrentDiffReviewRoutingFloor` runs). Populates
   * `runtime.rawRoutingDecision`.
   */
  readonly rawRoutingDecision?: KodaXTaskRoutingDecision;
  /**
   * F4 parity — human-readable explanation when the routing floor or
   * Scout overrides the initial decision. Populates
   * `runtime.routingOverrideReason`.
   */
  readonly routingOverrideReason?: string;
  /**
   * F4 parity — tool-output truncation ledger captured from the
   * tool-result-truncation guardrail's `afterTool` hook. Populates
   * `runtime.toolOutputTruncated` + `runtime.toolOutputTruncationNotes`.
   */
  readonly toolOutputTruncated?: boolean;
  readonly toolOutputTruncationNotes?: readonly string[];
}): KodaXManagedTask {
  const {
    prompt,
    options,
    recorder,
    rolesEmitted,
    baseCtx,
    signal,
    verdictStatus,
    userAnswer,
    budget,
    plan,
    entries,
    degradedContinue,
    childWriteWorktreePaths,
    taskId: providedTaskId,
    extraArtifacts,
    rawRoutingDecision,
    routingOverrideReason,
    toolOutputTruncated,
    toolOutputTruncationNotes,
  } = args;

  // Shard 6d-L: Scout's emitted harness still wins over the plan's
  // recommendation (FEATURE_061 — Scout is the routing authority). Fall
  // back to plan.decision.harnessProfile when Scout has not emitted yet,
  // then to H0_DIRECT.
  const harness: KodaXHarnessProfile =
    recorder.scout?.payload.scout?.confirmedHarness
      ?? plan?.decision.harnessProfile
      ?? 'H0_DIRECT';
  const contractPayload = recorder.contract?.payload.contract;

  const nowIso = new Date().toISOString();
  // v0.7.26 C4 parity — honour the caller-supplied taskId so every
  // `buildManagedTaskPayload` call within a single run reuses the same
  // workspaceDir. Prior behaviour generated a fresh id on every invocation,
  // so every observer snapshot wrote to a different folder and skill
  // artifacts could not be referenced by a stable path.
  const taskId = providedTaskId ?? `runner-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const surface = getManagedTaskSurface(options);
  // Resolve the per-task workspace directory (e.g. `<cwd>/.agent/
  // managed-tasks/<taskId>/`) so downstream snapshot files and
  // `evidence.artifacts` point at a stable, writable location — matches
  // legacy `task-engine.ts:2106` and is required for checkpoint/resume
  // parity.
  const workspaceDir = path.join(getManagedTaskWorkspaceRoot(options, surface), taskId);

  const contractStatus =
    signal === 'BLOCKED' ? 'blocked' : verdictStatus === 'accept' ? 'completed' : 'running';

  // Shard 6d-L: honour the reasoning plan's routing decision when filling
  // `contract.*`. Legacy (`task-engine.ts:2160-2180`) populated every
  // contract field from `plan.decision`; the earlier Runner-driven payload
  // hard-coded `primaryTask:'conversation'` / `complexity:simple` /
  // `riskLevel:'low'` and broke every downstream branch that read these
  // values (agent.ts has ~10 `decision.primaryTask === 'review' | 'bugfix'
  // | ...` branches). When the plan is absent we still fall back to the
  // placeholders — keeps callers without a plan (test harness, direct
  // API use) working.
  const decision = plan?.decision;
  const contract: KodaXTaskContract = {
    taskId,
    surface,
    objective: prompt,
    createdAt: nowIso,
    updatedAt: nowIso,
    status: contractStatus,
    primaryTask: decision?.primaryTask ?? 'conversation',
    workIntent: decision?.workIntent ?? 'new',
    complexity:
      decision?.complexity
        ?? (harness === 'H0_DIRECT' ? 'simple' : harness === 'H1_EXECUTE_EVAL' ? 'moderate' : 'complex'),
    riskLevel: decision?.riskLevel ?? 'low',
    harnessProfile: harness,
    recommendedMode: decision?.recommendedMode ?? 'conversation',
    requiresBrainstorm: decision?.requiresBrainstorm ?? false,
    reason: decision?.reason ?? 'Runner-driven AMA path',
    contractSummary: contractPayload?.summary,
    successCriteria: contractPayload?.successCriteria ?? [],
    requiredEvidence: contractPayload?.requiredEvidence ?? [],
    constraints: contractPayload?.constraints ?? [],
    verification: options.context?.taskVerification,
  };

  // De-dup roles while preserving first-occurrence order. The assignment
  // list is a historical record of who participated, not a schedule.
  const roleOrder: KodaXTaskRole[] = [];
  for (const r of rolesEmitted) {
    if (!roleOrder.includes(r)) roleOrder.push(r);
  }
  // H0_DIRECT convention: use 'direct' as the role when Scout answers
  // without handoff. The legacy path emits a single 'direct' assignment.
  const assignmentRoles: KodaXTaskRole[] =
    harness === 'H0_DIRECT' && roleOrder.length <= 1 ? ['direct'] : roleOrder;
  const roleAssignments: KodaXTaskRoleAssignment[] = assignmentRoles.map((role) => ({
    id: role,
    role,
    title: role.charAt(0).toUpperCase() + role.slice(1),
    dependsOn: [],
    status: contractStatus,
  }));

  const decidedByAssignmentId =
    harness === 'H0_DIRECT' ? 'direct' : verdictStatus ? 'evaluator' : 'generator';
  // FEATURE_159 follow-up (v0.7.40): fallback to '' instead of `prompt`.
  // The legacy `?? prompt` fallback was a copy from SA fast-path days when
  // the Scout always provided a `userAnswer`, so `?? prompt` was a never-
  // reached safety net. Under V2 chain (FEATURE_114) Worker runs first and
  // a Worker round can legitimately end without `emit_verdict` (e.g. the
  // chain hands off to Generator or Evaluator on the next iteration). In
  // that case `userAnswer` and `verdict.reason` are both undefined, and
  // `?? prompt` populated `verdict.summary` with the user's raw query
  // verbatim.
  //
  // Downstream this surfaced as an end-user UX bug: when the Worker round
  // produced no plain-text assistant turn (e.g. only tool_use + thinking,
  // or only emit_handoff), `resolveCompletedAssistantText` (REPL
  // message-utils.ts) iterates candidates and skips empty ones — falling
  // through to `managedTask.verdict.summary` as the third candidate. With
  // the legacy fallback that candidate held the user's own query, so the
  // REPL rendered a prefix-less `Assistant: <Q verbatim>` item (the user
  // sees their own question echoed back as the assistant's reply).
  //
  // Empty-string fallback is safe for all consumers we verified:
  //   - REPL `resolveCompletedAssistantText`: empty candidate is skipped
  //     (sanitize-and-pick-first-truthy loop).
  //   - `runner-driven.ts` transcript dump: `if (task.verdict?.summary)`
  //     gate already filters falsy, the "Last verdict" block silently
  //     drops.
  //   - `scorecard.ts`: `directive?.reason ?? task.verdict.summary` —
  //     audit artefact, empty string is acceptable when no verdict ran.
  //   - `json-guards.ts`: only checks `typeof === 'string'`.
  const verdictSummary =
    userAnswer ?? recorder.verdict?.payload.verdict?.reason ?? '';

  const task: KodaXManagedTask = {
    contract,
    roleAssignments,
    workItems: [],
    evidence: {
      workspaceDir,
      // Every managed task advertises a fixed set of 10 snapshot files
      // the writeManagedTaskArtifacts
      // pass is expected to produce. Downstream consumers (`resumeManagedTask`,
      // harness observers, the REPL transcript dump) index evidence by
      // artifact path, so we surface the records here even when the actual
      // files are written asynchronously at terminal exit.
      //
      // v0.7.26 C4 parity — merge any caller-supplied artefact records
      // (e.g. skill-execution.md / skill-map.md persisted by
      // `writeManagedSkillArtifacts`) alongside the built-in snapshot set
      // so the REPL + resume flow can resolve them by path.
      artifacts: mergeEvidenceArtifacts(
        buildManagedTaskArtifactRecords(workspaceDir),
        extraArtifacts,
      ),
      // Shard 6d-R: surface the per-role turn ledger and routing notes.
      // Legacy `task-engine.ts` fed these fields from each role completion
      // + `plan.decision.routingNotes`. Without them, snapshot consumers
      // (`buildManagedTaskRoundHistory`, REPL transcript dump, resume)
      // see empty history + no routing context.
      entries: entries ? [...entries] : [],
      routingNotes: plan?.decision.routingNotes ? [...plan.decision.routingNotes] : [],
    },
    verdict: {
      status:
        signal === 'BLOCKED'
          ? 'blocked'
          : verdictStatus === 'accept'
            ? 'completed'
            : 'running',
      decidedByAssignmentId,
      summary: verdictSummary,
      signal,
      continuationSuggested: recorder.handoff?.payload.handoff?.status === 'ready' && verdictStatus !== 'accept',
    },
    runtime: {
      globalWorkBudget: budget?.totalBudget ?? harnessToBudget(harness),
      budgetUsage: budget?.spentBudget ?? rolesEmitted.length,
      // `harnessTransitions` in legacy semantics records harness-tier
      // upgrades (e.g. H1 → H2 on revise+next_harness=H2), not individual
      // role transitions. For the Runner path we synthesise one transition
      // when Scout picks a non-H0 tier (the only case tests observe today).
      harnessTransitions:
        harness !== 'H0_DIRECT'
          ? [
              {
                from: 'H0_DIRECT',
                to: harness,
                round: 1,
                source: 'scout',
                reason: 'Scout confirmed harness tier',
                approved: true,
              },
            ]
          : [],
      // Shard 6d-O: fill runtime fields the legacy path populated so
      // downstream consumers (REPL harness UI, evaluator guardrails,
      // resume flow, session storage) see the same shape they did on
      // the legacy path. Empty-ish runtime defaulted to placeholder
      // values before this shard; the harness UI silently fell back to
      // defaults and lost context for `amaProfile` / `upgradeCeiling` /
      // `scoutDecision` etc.
      amaProfile: plan?.amaControllerDecision?.profile,
      amaTactics: plan?.amaControllerDecision?.tactics,
      amaControllerReason: plan?.amaControllerDecision?.reason,
      routingAttempts: plan?.decision.routingAttempts,
      routingSource: plan?.decision.routingSource,
      currentHarness: harness,
      upgradeCeiling: plan?.decision.upgradeCeiling ?? harness,
      qualityAssuranceMode: deriveQualityAssuranceMode(plan, harness),
      scoutDecision: recorder.scout?.payload.scout
        ? buildScoutDecisionRuntime(recorder.scout.payload.scout)
        : undefined,
      skillMap: buildSkillMapRuntime(recorder.scout?.payload.scout?.skillMap),
      // Shard 6d-U: propagate the degraded-continue signal. `true` when the
      // Evaluator requested an upgrade beyond `plan.decision.upgradeCeiling`
      // (rewritten back to Generator) or when budget-extension approval was
      // denied / skipped during revise. `undefined` when no degradation.
      degradedContinue: degradedContinue || undefined,
      // Shard 6d-S: derive per-criterion / per-runtime-check completion
      // status from the final verdict. Absent when no verification
      // contract was declared.
      completionContractStatus: buildCompletionContractStatus(
        options.context?.taskVerification,
        verdictStatus,
      ),
      // Shard 6d-Q: surface the dispatch_child_task write-fan-out ledger
      // so Evaluator diff injection (FEATURE_067 v2 parity) can find
      // per-child worktree paths. Undefined when no children dispatched.
      childWriteWorktreePaths:
        childWriteWorktreePaths && childWriteWorktreePaths.size > 0
          ? childWriteWorktreePaths
          : undefined,
      // F4 parity (v0.7.26) — surface routing provenance + tool
      // truncation state. `rawRoutingDecision` is the pre-floor snapshot
      // (before `applyCurrentDiffReviewRoutingFloor`); `finalRoutingDecision`
      // mirrors the active plan.decision; `routingOverrideReason` carries
      // any human-readable override explanation. Truncation tracking
      // lets downstream review UIs highlight when tool output was
      // clipped.
      rawRoutingDecision,
      finalRoutingDecision: plan?.decision,
      routingOverrideReason,
      toolOutputTruncated: toolOutputTruncated || undefined,
      toolOutputTruncationNotes:
        toolOutputTruncationNotes && toolOutputTruncationNotes.length > 0
          ? [...toolOutputTruncationNotes]
          : undefined,
    },
  };

  // H2 parity (v0.7.26) — populate the verification scorecard after the
  // task shape is built, mirroring legacy `createVerificationScorecard`.
  // Without this, `task.runtime.scorecard` stayed undefined and
  // `scorecard.json` persisted as `null`, starving downstream consumers
  // (review-scale UI, session-storage replay, rubric-family branches).
  const verdictPayload = recorder.verdict?.payload.verdict;
  const scorecardDirective: ScorecardVerdictDirective | undefined = verdictPayload
    ? { status: verdictPayload.status, reason: verdictPayload.reason }
    : undefined;
  const scorecard = createVerificationScorecard(task, scorecardDirective);
  return scorecard && task.runtime
    ? { ...task, runtime: { ...task.runtime, scorecard } }
    : task;
}

/**
 * Shard 6d-O: quality-assurance mode mirrors legacy
 * `resolveManagedTaskQualityAssuranceMode` (task-engine.ts:1108).
 * Runner simplification — legacy's branch depended on
 * `plan.decision.mutationSurface` / `assuranceIntent` /
 * `needsIndependentQA` / `riskLevel` / etc.; we reproduce the key
 * decisions:
 *   - H1 / H2 → 'required' (evaluator-mandatory).
 *   - H0 with explicit verification obligations or plan flags → 'required'.
 *   - Otherwise → 'optional'.
 */
function deriveQualityAssuranceMode(
  plan: ReasoningPlan | undefined,
  harness: KodaXHarnessProfile,
): 'required' | 'optional' {
  if (harness !== 'H0_DIRECT') return 'required';
  const decision = plan?.decision;
  if (!decision) return 'optional';
  if (decision.assuranceIntent === 'explicit-check') return 'required';
  if (decision.needsIndependentQA === true) return 'required';
  if (decision.riskLevel === 'high') return 'required';
  if (decision.primaryTask === 'qa' || decision.primaryTask === 'plan') return 'required';
  if (decision.recommendedMode === 'pr-review' || decision.recommendedMode === 'strict-audit') return 'required';
  return 'optional';
}

function buildScoutDecisionRuntime(
  scout: NonNullable<KodaXManagedProtocolPayload['scout']>,
): NonNullable<KodaXManagedTask['runtime']>['scoutDecision'] | undefined {
  if (!scout.summary && !scout.confirmedHarness) return undefined;
  return {
    summary: scout.summary ?? '',
    recommendedHarness: scout.confirmedHarness ?? 'H0_DIRECT',
    readyForUpgrade: scout.directCompletionReady !== 'yes',
    scope: scout.scope,
    requiredEvidence: scout.requiredEvidence,
    reviewFilesOrAreas: scout.reviewFilesOrAreas,
    evidenceAcquisitionMode: scout.evidenceAcquisitionMode,
    harnessRationale: scout.harnessRationale,
    blockingEvidence: scout.blockingEvidence,
    directCompletionReady: scout.directCompletionReady,
    skillSummary: scout.skillMap?.skillSummary,
    executionObligations: scout.skillMap?.executionObligations,
    verificationObligations: scout.skillMap?.verificationObligations,
    ambiguities: scout.skillMap?.ambiguities,
    projectionConfidence: scout.skillMap?.projectionConfidence,
  };
}

function buildSkillMapRuntime(
  scoutSkillMap: NonNullable<KodaXManagedProtocolPayload['scout']>['skillMap'],
): KodaXManagedTask['runtime'] extends infer R
  ? R extends { skillMap?: infer M } ? M : never
  : never {
  if (!scoutSkillMap) return undefined as never;
  return {
    summary: scoutSkillMap.skillSummary,
    executionObligations: scoutSkillMap.executionObligations ?? [],
    verificationObligations: scoutSkillMap.verificationObligations ?? [],
    ambiguities: scoutSkillMap.ambiguities ?? [],
    projectionConfidence: scoutSkillMap.projectionConfidence,
  } as never;
}

// =============================================================================
// Main entry
// =============================================================================

/**
 * Shard 6c + H1 structural resume (v0.7.26).
 *
 * Legacy behaviour (task-engine.ts:~6644 + `resumeManagedTask`): ask the
 * user whether to continue or restart, then either replay the partial
 * state (seeded plan, scoutDecision, budget) or drop the checkpoint.
 *
 *   - "restart" → delete stale checkpoint, start fresh.
 *   - "resume" → keep the checkpoint, return `{ resumeFrom }` so the
 *     caller can seed the recorder via `buildStructuralResumeSeed` and
 *     (depending on what roles already completed) start Runner.run at
 *     planner / generator / evaluator instead of scout. The textual
 *     preamble (`buildResumePreamble`) is still prepended for readability
 *     and to give any resumed-scout retries the prior findings in plain
 *     text.
 *   - "cancel" → delete the checkpoint + throw — the user asked to abort.
 *   - no askUser callback → silently clean up; non-interactive contexts
 *     can't prompt for a decision.
 */
async function handlePreRunCheckpoint(
  options: KodaXOptions,
): Promise<{ resumeFrom: ValidatedCheckpoint } | undefined> {
  let validated: ValidatedCheckpoint | undefined;
  try {
    validated = await findValidCheckpoint(options);
  } catch {
    return undefined;
  }
  if (!validated) return undefined;

  const deleteSafely = async (): Promise<void> => {
    try {
      await deleteCheckpoint(validated!.workspaceDir);
    } catch {
      // Delete failure is non-fatal; the next run will see the same
      // stale checkpoint and reach this branch again.
    }
  };

  if (!options.events?.askUser) {
    await deleteSafely();
    return undefined;
  }

  const useChinese = /[\u4e00-\u9fff]/.test(validated.managedTask.contract.objective ?? '');
  const answer = await options.events.askUser({
    question: useChinese ? '发现未完成的任务' : 'Found incomplete task',
    options: [
      {
        // H1 parity (v0.7.26) — text-level resume. The next run's prompt
        // receives a reconstructed preamble (Scout findings, contract,
        // last verdict) so the LLM can pick up where it left off
        // without re-investigating. Full structural replay of the
        // recorder state is deliberately out of scope for this MVP.
        label: useChinese ? '继续未完成的工作' : 'Resume',
        value: 'resume',
        description: useChinese
          ? '在先前 Scout/执行结果的基础上继续（上下文保留）'
          : 'Continue with preserved prior Scout / execution context',
      },
      {
        label: useChinese ? '重新开始' : 'Restart',
        value: 'restart',
        description: useChinese ? '丢弃之前的进度，重新开始' : 'Discard previous progress and start fresh',
      },
      {
        label: useChinese ? '取消' : 'Cancel',
        value: 'cancel',
        description: useChinese ? '中止当前请求' : 'Abort the current request',
      },
    ],
    default: 'resume',
  });
  if (answer === 'cancel') {
    await deleteSafely();
    throw new Error('Runner-driven path: user cancelled due to pre-existing checkpoint');
  }
  if (answer === 'resume') {
    // Keep the checkpoint in place — it gets rewritten fresh on the
    // next role emit. The caller builds a preamble from the validated
    // state and feeds it into the prompt.
    return { resumeFrom: validated };
  }
  await deleteSafely();
  return undefined;
}

/**
 * H1 parity (v0.7.26) — reconstruct a human-readable preamble from the
 * checkpoint's managedTask state. The next run pre-pends this onto the
 * user prompt so Scout / Generator / Evaluator see the prior
 * investigation + findings and can pick up the work instead of
 * rediscovering it. Text-level resume — not a full structural replay
 * of the recorder — but a meaningful quality-of-life improvement over
 * the prior "restart from scratch" behaviour.
 */
function buildResumePreamble(checkpoint: ValidatedCheckpoint): string {
  const task = checkpoint.managedTask;
  const lines: string[] = [
    '=== RESUMING INCOMPLETE TASK ===',
    `Checkpoint from: ${checkpoint.checkpoint.createdAt}`,
    `Original objective: ${task.contract.objective}`,
    `Harness: ${task.contract.harnessProfile}`,
    `Roles already executed: ${checkpoint.checkpoint.completedWorkerIds.join(', ') || 'none'}`,
  ];
  const scout = task.runtime?.scoutDecision;
  if (scout) {
    lines.push('', '--- Scout findings (already complete) ---');
    if (scout.summary) lines.push(`Summary: ${scout.summary}`);
    if (scout.harnessRationale) lines.push(`Harness rationale: ${scout.harnessRationale}`);
    if (scout.scope && scout.scope.length > 0) {
      lines.push(`Scope: ${scout.scope.join(', ')}`);
    }
    if (scout.reviewFilesOrAreas && scout.reviewFilesOrAreas.length > 0) {
      lines.push(`Review files/areas: ${scout.reviewFilesOrAreas.join(', ')}`);
    }
    if (scout.executionObligations && scout.executionObligations.length > 0) {
      lines.push('Execution obligations:');
      for (const ob of scout.executionObligations) lines.push(`  - ${ob}`);
    }
  }
  const contract = task.contract.contractSummary;
  if (contract) {
    lines.push('', '--- Contract (already produced) ---');
    lines.push(contract);
    if (task.contract.successCriteria.length > 0) {
      lines.push('Success criteria:');
      for (const c of task.contract.successCriteria) lines.push(`  - ${c}`);
    }
  }
  if (task.verdict?.summary) {
    lines.push('', '--- Last verdict ---');
    lines.push(`Status: ${task.verdict.status}`);
    lines.push(`Summary: ${task.verdict.summary}`);
  }
  lines.push(
    '',
    'Use this preserved context to avoid redundant investigation. Continue the work from where it was interrupted.',
    '=== END RESUME CONTEXT ===',
    '',
  );
  return lines.join('\n');
}

/**
 * H1 structural resume seed (v0.7.26) — reconstruct recorder slots, harness
 * tier, budget, and the agent entry-point from a validated checkpoint.
 *
 * Legacy `resumeManagedTask` synthesised a `ManagedTaskScoutDirective`
 * from `managedTask.runtime.scoutDecision`, applied it to the plan, then
 * filtered out `completedWorkerIds` so the resumed round skipped
 * already-completed workers. The Runner-driven path equivalent:
 *
 *   1. If Scout completed, re-emit the captured Scout directive into the
 *      recorder so `rolePromptContextFactory` → `previousRoleSummaries`
 *      + `scoutScope` still reach downstream roles.
 *   2. If the saved harness is H2 and `contract.contractSummary` is set,
 *      also seed the contract slot so the Planner turn can be skipped.
 *   3. Pick the entry agent based on which slots are seeded:
 *        - no scout      → scout (plain restart with preamble context)
 *        - scout + H0    → scout (re-emit H0 with saved findings)
 *        - scout + H1    → generator
 *        - scout + H2, no contract → planner
 *        - scout + H2 + contract  → generator
 *   4. Carry forward the harness tier + budget so budget caps + role-
 *      specific tool allow-lists are correct from turn 1. Budget spent is
 *      reset — the LLM is starting a fresh turn even if logically
 *      resuming, so old spend shouldn't eat into the new run's envelope.
 *
 * Handoff and verdict slots are deliberately NOT seeded: the legacy
 * resume also didn't replay them (it re-ran the terminal round). This
 * keeps the semantics simple — resume picks up at the last *role* that
 * needs to run, not at a specific revise-cycle iteration inside the
 * Evaluator loop.
 */
interface StructuralResumeSeed {
  readonly recorderSlots: {
    readonly scout?: ProtocolEmitterMetadata;
    readonly contract?: ProtocolEmitterMetadata;
  };
  readonly harness: KodaXHarnessProfile;
  readonly rolesEmitted: readonly KodaXTaskRole[];
  readonly startingRole: 'scout' | 'planner' | 'generator';
}

function buildStructuralResumeSeed(validated: ValidatedCheckpoint): StructuralResumeSeed {
  const task = validated.managedTask;
  const checkpoint = validated.checkpoint;
  const scoutDecision = task.runtime?.scoutDecision;
  const harness: KodaXHarnessProfile = task.contract.harnessProfile ?? 'H0_DIRECT';

  const recorderSlots: { scout?: ProtocolEmitterMetadata; contract?: ProtocolEmitterMetadata } = {};
  const rolesEmitted: KodaXTaskRole[] = [];

  if (checkpoint.scoutCompleted && scoutDecision) {
    const scoutPayload: Partial<KodaXManagedProtocolPayload> = {
      scout: {
        summary: scoutDecision.summary,
        scope: scoutDecision.scope ?? [],
        requiredEvidence: scoutDecision.requiredEvidence ?? [],
        reviewFilesOrAreas: scoutDecision.reviewFilesOrAreas,
        evidenceAcquisitionMode: scoutDecision.evidenceAcquisitionMode,
        confirmedHarness: scoutDecision.recommendedHarness,
        harnessRationale: scoutDecision.harnessRationale,
        blockingEvidence: scoutDecision.blockingEvidence,
        directCompletionReady: scoutDecision.directCompletionReady,
        skillMap: scoutDecision.skillSummary
          ? {
            skillSummary: scoutDecision.skillSummary,
            executionObligations: scoutDecision.executionObligations ?? [],
            verificationObligations: scoutDecision.verificationObligations ?? [],
            ambiguities: scoutDecision.ambiguities ?? [],
            projectionConfidence: scoutDecision.projectionConfidence,
          }
          : undefined,
      },
    };
    const { handoffTarget, isTerminal } = resolveHandoffTarget('scout', scoutPayload);
    recorderSlots.scout = {
      role: 'scout',
      payload: scoutPayload,
      handoffTarget,
      isTerminal,
    };
    rolesEmitted.push('scout');
  }

  const contractSummary = task.contract.contractSummary;
  if (
    harness === 'H2_PLAN_EXECUTE_EVAL'
    && contractSummary
    && contractSummary.trim().length > 0
  ) {
    const contractPayload: Partial<KodaXManagedProtocolPayload> = {
      contract: {
        summary: contractSummary,
        successCriteria: task.contract.successCriteria ?? [],
        requiredEvidence: task.contract.requiredEvidence ?? [],
        constraints: task.contract.constraints ?? [],
      },
    };
    const { handoffTarget, isTerminal } = resolveHandoffTarget('planner', contractPayload);
    recorderSlots.contract = {
      role: 'planner',
      payload: contractPayload,
      handoffTarget,
      isTerminal,
    };
    rolesEmitted.push('planner');
  }

  let startingRole: 'scout' | 'planner' | 'generator' = 'scout';
  if (recorderSlots.scout) {
    if (harness === 'H0_DIRECT') {
      startingRole = 'scout';
    } else if (harness === 'H1_EXECUTE_EVAL') {
      startingRole = 'generator';
    } else {
      startingRole = recorderSlots.contract ? 'generator' : 'planner';
    }
  }

  return { recorderSlots, harness, rolesEmitted, startingRole };
}

/**
 * Shard 6c: write a crash-safe checkpoint after each role transition.
 * Allows legacy tools and future resume logic to inspect partial state.
 */
async function writeCurrentCheckpoint(args: {
  readonly options: KodaXOptions;
  readonly managedTask: KodaXManagedTask;
  readonly currentRound: number;
  readonly completedWorkerIds: readonly string[];
  readonly scoutCompleted: boolean;
}): Promise<string | undefined> {
  const { options, managedTask, currentRound, completedWorkerIds, scoutCompleted } = args;
  try {
    const surface = getManagedTaskSurface(options);
    const workspaceRoot = getManagedTaskWorkspaceRoot(options, surface);
    const workspaceDir = path.join(workspaceRoot, managedTask.contract.taskId);
    const gitCommit = (await getGitHeadCommit(options.context?.gitRoot)) ?? 'unknown';
    const checkpoint: ManagedTaskCheckpoint = {
      version: 1,
      taskId: managedTask.contract.taskId,
      createdAt: managedTask.contract.createdAt,
      gitCommit,
      objective: managedTask.contract.objective,
      harnessProfile: managedTask.contract.harnessProfile,
      currentRound,
      completedWorkerIds: [...completedWorkerIds],
      scoutCompleted,
    };
    await writeCheckpoint(workspaceDir, checkpoint);
    return workspaceDir;
  } catch {
    // Checkpoint write is best-effort — failures should not abort the run.
    return undefined;
  }
}

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
  };

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
      childWriteWorktreePaths: childWriteWorktreePathsRef.current,
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
  // Shard 6d-Q: dispatch_child_task write-fan-out ledger. Generator's
  // dispatch invocations populate this map (childId → worktreePath);
  // the Evaluator reads it at verdict time to inject per-child diffs.
  // FEATURE_067 v2 parity.
  const childWriteWorktreePathsRef: { current: Map<string, string> } = {
    current: new Map(),
  };
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
    const ctx: ManagedRolePromptContext = {
      originalTask: prompt,
      workspace: managedWorkspace,
      capabilityContextBlock: prebuiltCapabilityContextBlock,
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
    childWriteWorktreePathsRef,
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
  // `compactionHook` (fired after each tool-result append). Without this
  // wiring, long AMA sessions hit context window overflow and 400.
  //
  // v0.7.40 — pass `contextTokenSnapshotRef` so the hook's trigger
  // check uses API-accurate token accounting (`usage.totalTokens` +
  // delta) instead of the transcript-only estimate that silently
  // missed the threshold by the system + tools schema overhead.
  const compactionHook = await buildManagedTaskCompactionHook(options, {
    contextTokenSnapshotRef,
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
    beforeTool: options.events
      ? async (call: { name: string; id: string; input: Record<string, unknown> }) => {
        const override = await getToolExecutionOverride(
          options.events!,
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
      : undefined,
    onToolCall: (call: { name: string; id: string; input: Record<string, unknown> }) => {
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
      result: { content: string; metadata?: unknown },
    ) => {
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
        content: result.content,
      });
    },
  };

  // FEATURE_167 (v0.7.41): one-shot Runner invocation closure, used by
  // both the idle-yield outer loop AND the B1 evaluator-verdict retry
  // path post-loop. Lifting it to a named function lets the B1 retries
  // reuse the same llm / guardrails / observer / compactionHook / agent-
  // switch hook the chain itself runs with, so the retry's transcript +
  // tool emissions / status updates are indistinguishable from a "normal"
  // turn (the LLM never knows it's the B2-prelude).
  //
  // Returned type retains the full `RunResult` shape (output + messages
  // + sessionId), not the wrapper's narrower `RunWithIdleYieldRunResult`.
  // The B1 path reads `messages` to thread the next retry's input; the
  // existing `runWithIdleYield` call sees the same shape (the wrapper
  // only requires `messages`, so the wider type is structurally OK).
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
                : to.name === EVALUATOR_AGENT_NAME ? 'evaluator'
                  : to.name === WORKER_AGENT_NAME ? 'worker'
                    : undefined;
        observer.agentSwitched(switchedRole);
      },
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
              : currentAgent.name === EVALUATOR_AGENT_NAME ? 'evaluator'
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

  // FEATURE_167 (v0.7.41) — Evaluator terminal-verdict fallback.
  //
  // The runner-driven outer loop above (runWithIdleYield) exits when:
  //   (a) the run is genuinely terminal (verdict emitted), OR
  //   (b) `hasEmittedHandoff=true` but the assistant produced no tool
  //       calls and no children are pending — the Evaluator-text-only
  //       smoking gun (session 20260515_185354).
  //
  // Case (b) is what we recover here. Without intervention,
  // `deriveFinalStatus` would see `recorder.verdict===undefined` and
  // synthesize a `signal:'COMPLETE'` final status, silently turning a
  // failed audit into a reported success.
  //
  // 3-layer defense per the FEATURE_167 design doc:
  //   - B0 (fenced parser): SKIPPED — probe C3 showed 0/25 emissions
  //     across the 5-alias panel. No model writes the fence; carrying
  //     the parser would be dead code.
  //   - B1 (retry-prompt loop): inject the canonical
  //     `EVALUATOR_VERDICT_RETRY_PROMPT` as a user message + re-run
  //     `chain.evaluator` via the same `runOnce` closure the main loop
  //     uses, up to `resolveEvaluatorVerdictRetryCap(alias)` times.
  //     Probe C2 data showed kimi recovers 100% at retry 1, ds/v4pro
  //     and mmx/m27 plateau at 80% within 1-2 retries; zhipu cap=1
  //     because the intent-vs-action floor is structurally unrecoverable
  //     ([[project_zhipu_send_message_floor]]).
  //   - B2 (synth fallback): if B1 exhausts cap without a verdict,
  //     synthesize one. Status is `'accept'` because the Evaluator did
  //     produce a useful review text — marking it `'blocked'` would
  //     false-fail the run for what was really a tool-protocol failure
  //     on top of correct review content. The
  //     `onEvaluatorFallbackSynthesized` event lets SDK consumers
  //     distinguish the synthesized verdict from a real `accept`.
  //
  // Ordering invariant: write `recorder.verdict` BEFORE firing the
  // telemetry event so consumers see causal order (recorder committed
  // → event fires → `deriveFinalStatus` reads the committed verdict).
  // The abort signal short-circuits the loop at entry of each retry
  // so a mid-B1 Esc/Ctrl-C doesn't burn extra LLM turns.
  let effectiveRunResult = runResult;
  if (
    !options.abortSignal?.aborted &&
    detectMissingTerminalVerdict({
      lastAssistantToolCallCount: countLastAssistantToolCalls(runResult.messages),
      pendingChildTaskCount: baseCtx.childTaskRegistry?.size ?? 0,
      hasEmittedHandoff: Boolean(recorder.handoff),
      hasEmittedTerminalVerdict: (() => {
        const s = recorder.verdict?.payload?.verdict?.status;
        return s === 'accept' || s === 'blocked';
      })(),
      hasPendingBackgroundMessages: getMessageQueue().has({
        agentId: undefined,
        maxPriority: 'background',
        mode: 'task-notification',
      }),
    })
  ) {
    const resolvedAlias = options.modelOverride ?? options.model;
    const verdictRetryCap = resolveEvaluatorVerdictRetryCap(resolvedAlias);
    let retriesAttempted = 0;
    let currentMessages = runResult.messages;
    let currentOutput = runResult.output;

    // Capture the recorder.verdict OBJECT identity before retries. Each
    // successful `emit_verdict` tool call assigns a fresh
    // `ProtocolEmitterMetadata` to `recorder.verdict` (see line ~967),
    // so identity comparison correctly detects "a new tool call
    // happened in this retry" regardless of whether the new status
    // equals the prior one. Checking status alone would falsely break
    // the loop when a stale `revise` from a prior round is still
    // in the recorder and the current Evaluator turn didn't emit —
    // the synth path would never fire, and the stale revise would
    // propagate as if it were the final answer.
    const priorVerdictObject = recorder.verdict;

    for (let i = 0; i < verdictRetryCap; i++) {
      if (options.abortSignal?.aborted) break;
      const retryInput: KodaXMessage[] = [
        ...currentMessages,
        { role: 'user', content: EVALUATOR_VERDICT_RETRY_PROMPT },
      ];
      const retryResult = await runOnce(chain.evaluator, retryInput);
      retriesAttempted++;
      currentMessages = retryResult.messages;
      currentOutput = retryResult.output;
      if (recorder.verdict !== priorVerdictObject) {
        // Retry succeeded — Evaluator emitted a structured verdict
        // (fresh object reference, regardless of status value).
        break;
      }
    }

    // The retry calls may have written a new checkpoint mid-loop;
    // clear it now so a successful B1 recovery doesn't leave an orphan
    // for the next session to discover.
    await cleanupRunCheckpoint();

    effectiveRunResult = { ...runResult, messages: currentMessages, output: currentOutput };

    // B2 synth fallback — fires only if STILL no fresh verdict after
    // exhausting cap. Identity comparison matches the loop break
    // condition: recorder unchanged from before retries === no real
    // emit_verdict landed. A stale `revise` from a prior round
    // counts as "no fresh emit" here and correctly triggers B2.
    if (recorder.verdict === priorVerdictObject) {
      const userFacingText = extractUserFacingText(effectiveRunResult);
      const synthReason =
        `Evaluator failed to emit a terminal verdict after ${retriesAttempted} retries.`;
      recorder.verdict = {
        role: 'evaluator',
        payload: {
          verdict: {
            source: 'evaluator',
            status: 'accept',
            reason: synthReason,
            followups: [],
            userFacingText,
            userAnswer: userFacingText,
          },
        },
        isTerminal: true,
      };
      options.events?.onEvaluatorFallbackSynthesized?.({
        retriesAttempted,
        cap: verdictRetryCap,
        modelAlias: resolvedAlias,
        userFacingText,
        reason: synthReason,
      });
    }
  }

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
    childWriteWorktreePaths: childWriteWorktreePathsRef.current,
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
    success: verdictStatus !== 'blocked',
    lastText: resolvedText,
    signal,
    signalReason: reason,
    messages: [...effectiveRunResult.messages],
    sessionId: effectiveRunResult.sessionId ?? `runner-${Date.now()}`,
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
