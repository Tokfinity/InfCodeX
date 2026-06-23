/**
 * Runtime agent chain for the runner-driven AMA path.
 *
 * Hosts the per-run agent graph builder (`buildRunnerAgentChain`) and
 * its private helpers (`buildCodingToolBundle`,
 * `buildAgentToolsFromRegistry`). Each of the five role agents (Scout,
 * Planner, Generator, Evaluator, Worker) is constructed here with:
 *   - dynamic `instructions` closure that resolves through
 *     `resolveRoleInstructions` (R1)
 *   - role-appropriate coding tools wrapped via R2's tool-wrappers
 *   - the recorder-wrapped emit tool via R2's `wrapEmitterWithRecorder`
 *   - the handoff topology Scout/Planner/Generator/Evaluator/Worker
 *     mirror in `coding-agents.ts`
 *
 * Extracted from `task-engine/runner-driven.ts` lines ~430–1328 of the
 * pre-FEATURE_171 monolith as part of FEATURE_171 (v0.7.41) modular
 * split. Zero behavior change — bodies are byte-identical to the
 * previous in-file declarations.
 */

import type {
  Agent,
  Handoff,
  RunnableTool,
  RunnerToolResult,
} from '@kodax-ai/agent';
// FEATURE_193 (v0.7.43): SCOUT_AGENT_NAME / PLANNER_AGENT_NAME /
// GENERATOR_AGENT_NAME imports removed alongside the V1 chain agents —
// the Worker is the only V2 chain agent.
import { WORKER_AGENT_NAME } from '../../../agents/task-engine-agents.js';
// FEATURE_193 (v0.7.43): emitContract / emitScoutVerdict imports removed —
// V1 chain agents retired. The Worker chain doesn't need any emit tool;
// Sidecar Verifier emits emit_verdict out-of-band.
import { toolBash } from '../../../tools/bash.js';
import { toolEdit } from '../../../tools/edit.js';
import { toolMultiEdit } from '../../../tools/multi-edit.js';
import { toolExitPlanMode } from '../../../tools/exit-plan-mode.js';
import { toolTodoUpdate } from '../../../tools/todo-update.js';
import { toolTodoList } from '../../../tools/todo-list.js';
import { toolTodoCreate } from '../../../tools/todo-create.js';
import { toolGlob } from '../../../tools/glob.js';
import { toolGrep } from '../../../tools/grep.js';
import { toolRead } from '../../../tools/read.js';
import { toolWrite } from '../../../tools/write.js';
import { toolRepoOverview } from '../../../tools/repo-overview.js';
import { toolChangedScope } from '../../../tools/changed-scope.js';
import { toolChangedDiff, toolChangedDiffBundle } from '../../../tools/changed-diff.js';
import { toolMcpSearch } from '../../../tools/mcp-search.js';
import { toolMcpDescribe } from '../../../tools/mcp-describe.js';
import { toolMcpCall } from '../../../tools/mcp-call.js';
import { toolMcpReadResource } from '../../../tools/mcp-read-resource.js';
import { toolMcpGetPrompt } from '../../../tools/mcp-get-prompt.js';
import {
  getToolDefinition,
  getRegisteredToolDefinition,
  isMcpToolName,
  listToolDefinitions,
  MCP_TOOL_NAMES,
} from '../../../tools/registry.js';
import type {
  KodaXEvents,
  KodaXToolExecutionContext,
  KodaXTaskVerificationContract,
} from '../../../types.js';
import type { ReasoningPlan } from '../../../reasoning.js';
import type { ManagedTaskBudgetController } from './budget.js';
import {
  resetTodoReminderState,
  type TodoReminderState,
} from '../../todo-throttle-reminder.js';
import {
  formatDeterministicEvaluatorResult,
  runDeterministicEvaluator,
  type DeterministicEvaluatorHint,
  type DeterministicEvaluatorResult,
  type RunDeterministicEvaluatorInput,
} from '../../deterministic-evaluator.js';
import type { TodoStore } from '../../todo-store.js';
import {
  // FEATURE_193 (v0.7.43): SCOUT_INSTRUCTIONS_FALLBACK, PLANNER_INSTRUCTIONS_FALLBACK,
  // GENERATOR_INSTRUCTIONS_FALLBACK removed — V1 chain roles retired.
  WORKER_INSTRUCTIONS_FALLBACK,
  resolveRoleInstructions,
} from './role-prompts.js';
import { getAmaRoleEffectiveExclude } from './role-exclude.js';
import {
  wrapCodingToolAsRunnable,
  wrapGeneratorBashWithMutationGuard,
  wrapGeneratorWriteWithMutationGuard,
} from './tool-wrappers.js';
import { wrapDispatchChildTaskForRole } from './dispatch-child.js';
import { NULL_OBSERVER } from './observer-bridge.js';
import {
  wrapEmitterWithRecorder,
  type BudgetExtensionContext,
} from './verdict-recorder.js';
import type {
  AmaRole,
  ObserverBridge,
  RunnerChainPromptContext,
  VerdictRecorder,
} from './types.js';

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
  /**
   * FEATURE_170 (v0.7.41) — per-item insertion path. Companion to
   * todo_update (status transition) and todo_update({op:'init'})
   * (batch seed). The store auto-generates the monotonic id.
   */
  readonly todoCreate: RunnableTool;
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
  const todoCreate = getToolDefinition('todo_create');
  const todoGet = getToolDefinition('todo_get');
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
    || !todoCreate
    || !todoGet
  ) {
    throw new Error(
      'Runner-driven path: expected core tools (read/grep/glob/bash/write/edit/multi_edit/exit_plan_mode/todo_update/todo_list/todo_create/todo_get) to be registered',
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
    todoCreate: wrapCodingToolAsRunnable(todoCreate, toolTodoCreate, baseCtx, budget, events),
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
    if (!ctx.extensionRuntime && isMcpToolName(def.name)) continue;

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
// Runtime Agent chain: Worker single-loop
// =============================================================================
// FEATURE_193 v0.7.43: V1 chain (Scout/Planner/Generator) retired. Worker is
// the only role in the chain. FEATURE_184 (v0.7.42) retired the in-chain
// Evaluator role too — the Sidecar Verifier StopHook handles verification
// out-of-band after Worker terminates text-only.

export interface RunnerAgentChain {
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
    // FEATURE_170 (v0.7.41) — extend the throttle-reset behavior to
    // `todo_create` too. After migration the LLM commonly emits N
    // todo_create calls (per-item) instead of a single todo_update(init).
    // Without resetting on todo_create, a model that diligently inserts
    // every item via todo_create still triggers the "you have not
    // committed a plan" reminder after the 8-round counter elapses —
    // spurious nag at the worst possible time.
    const wrapForReset = (base: RunnableTool): RunnableTool => ({
      ...base,
      execute: async (input, runnerCtx): Promise<RunnerToolResult> => {
        const result = await base.execute(input, runnerCtx);
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
    });
    const mutable = codingTools as {
      -readonly [K in keyof typeof codingTools]: typeof codingTools[K];
    };
    mutable.todoUpdate = wrapForReset(codingTools.todoUpdate);
    mutable.todoCreate = wrapForReset(codingTools.todoCreate);
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
  // Worker IS the only dispatcher after FEATURE_193 retired V1 chain
  // (Scout/Generator dispatch wrappers deleted). Worker inherits the full
  // dispatch surface: read-only fan-out via RULE A, long-running probes
  // via RULE B, write fan-out (readOnly:false) via RULE C.
  const workerDispatch = wrapDispatchChildTaskForRole(
    dispatchDefinition,
    ctx,
    'worker',
    budget,
    observer,
    events,
  );

  // FEATURE_193 (v0.7.43): scoutEmit + contractEmit deleted with V1 chain.
  // FEATURE_190 (v0.7.43) Phase 3: `handoffEmit` deleted — Worker terminates
  // text-only (Sidecar Verifier StopHook handles verification out-of-band).
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
  // FEATURE_193 v0.7.43: V1 chain (Scout/Planner/Generator) agents retired —
  // Worker is the only entry path. FEATURE_184 (v0.7.42) Phase C.1: Evaluator
  // also retired — Sidecar Verifier StopHook handles verification out-of-band.

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
          ['todo_create', codingTools.todoCreate],
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

  // FEATURE_184 (v0.7.42) Phase C.1: Worker terminates text-only —
  // Sidecar Verifier StopHook handles verification, no handoff edges.
  const workerHandoffs: Handoff[] = [];
  worker.handoffs = workerHandoffs;

  return {
    worker: Object.freeze(worker) as Agent,
  };
}

// FEATURE_193 v0.7.43: `buildRunnerScoutAgent` deleted — V1 Scout retired.
