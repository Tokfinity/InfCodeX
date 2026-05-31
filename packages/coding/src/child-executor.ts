/**
 * Child Agent Executor — FEATURE_067
 *
 * Core execution engine for parallel child agents.
 * Called by dispatch_child_tasks tool (v2) or directly by orchestration layer.
 * Read children share parent cwd; write children share parent cwd as well
 * (FEATURE_188 v0.7.42 dropped forced worktree — per-file `backups` Map is
 * the per-child rollback substrate; prompt-level peer coordination handles
 * concurrent conflict avoidance, see ADR-034).
 */

import { execSync } from 'child_process';
import fsPromises from 'fs/promises';
import os from 'os';
import type {
  KodaXChildContextBundle,
  KodaXChildAgentResult,
  KodaXChildExecutionResult,
  KodaXChildFinding,
  KodaXEvents,
  KodaXOptions,
  KodaXResult,
  KodaXToolExecutionContext,
} from './types.js';
import { resolveExecutionCwd } from './runtime-paths.js';
import { resolveModelHintTier } from './model-hint-routing.js';
// FEATURE_093 (v0.7.24): lazy-load `runKodaX` to break the cycle
// `agent.ts → extensions/runtime.ts → tools/index.ts → tools/registry.ts
// → tools/dispatch-child-tasks.ts → child-executor.ts → agent.ts`.
// `dispatch_child_tasks` is a coarse-grained tool that spins up a fresh
// KodaX agent per child; the runtime import defers agent module resolution
// until a child is actually spawned, by which point the parent module graph
// has fully initialised. No top-level `import ... from './agent.js'` or
// `typeof import('./agent.js')` references — both count as edges in madge.
type RunKodaXFn = (options: KodaXOptions, prompt: string) => Promise<KodaXResult>;
let _runKodaXCache: RunKodaXFn | undefined;
async function getRunKodaX(): Promise<RunKodaXFn> {
  if (!_runKodaXCache) {
    // Computed module specifier hides the edge from madge while TypeScript
    // keeps the string literal at compile time.
    const spec = './agent.js' as const;
    // v0.7.26 Risk-6 fix — wrap the dynamic import in an explicit
    // error envelope. The cycle-break via dynamic-import is a deliberate
    // design choice (FEATURE_093), but if `./agent.js` ever fails to
    // resolve at runtime (broken build, moved export, circular-import
    // still tripping), the vanilla native error surfaces as a cryptic
    // "Cannot find module './agent.js'" deep inside a dispatch call.
    // Restate what went wrong + what the caller should check.
    let agentModule: { runKodaX?: RunKodaXFn };
    try {
      agentModule = (await import(spec)) as { runKodaX?: RunKodaXFn };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[child-executor] Failed to lazy-load agent module (\`${spec}\`) for dispatch_child_task. ` +
        `This usually means the @kodax-ai/coding build is broken or out of date. ` +
        `Underlying cause: ${detail}`,
      );
    }
    const runKodaX = agentModule.runKodaX;
    if (typeof runKodaX !== 'function') {
      throw new Error(
        `[child-executor] Agent module loaded but \`runKodaX\` export is missing or not a function. ` +
        `This indicates an API break in packages/coding/src/agent.ts. ` +
        `Check that \`export { runKodaX }\` is still present.`,
      );
    }
    _runKodaXCache = runKodaX;
  }
  return _runKodaXCache;
}
import { loadAgentsFiles, formatAgentsForPrompt } from './context/agents-loader.js';
// FEATURE_120 v0.7.39 Step 0d (Option D) — generic fan-out lifted to
// @kodax-ai/agent (ADR-021). All coding-side concerns (read vs write,
// worktree isolation, briefing, role policy) stay below; the wrapper
// owns only bounded concurrency + abort + progress eventing.
import { runFanOut } from '@kodax-ai/agent';
// FEATURE_191 — specialist agent override resolution. `resolveConstructedAgent`
// returns `Agent | undefined`; the dispatch-child-tasks layer has already
// rejected unknown names before bundle construction, so a re-resolve here is
// expected to succeed for any bundle that carries `specialistName`.
// `getAllRegisteredTools` powers the complementary excludeTools computation
// (`KodaXOptions.context` has no `includeOnlyTools` API; the inverse subset
// is the YAGNI-compliant substitute per ADR-035 R11).
import { resolveConstructedAgent } from './construction/agent-resolver.js';
import { getAllRegisteredTools } from './tools/registry.js';
import type { Agent } from '@kodax-ai/agent';

/* ---------- Public API ---------- */

/**
 * Predicate the parent REPL injects so the child executor can enforce plan-mode
 * constraints without `packages/coding` reverse-depending on `packages/repl`.
 *
 * The predicate MUST read the parent's permission mode lazily (e.g., through a
 * closure over a ref), so mid-run mode toggles propagate to in-flight child tool
 * calls. Returns the block reason (string) for tools/inputs that are currently
 * plan-mode-violating, or `null` when the call is allowed right now.
 */
export type PlanModeBlockCheck = (
  tool: string,
  input: Record<string, unknown>,
) => string | null;

export interface ChildExecutorOptions {
  readonly maxParallel: number;
  readonly maxIterationsPerChild: number;
  readonly abortSignal?: AbortSignal;
  readonly parentOptions: Readonly<Partial<Pick<KodaXOptions, 'provider' | 'model' | 'reasoningMode' | 'extensionRuntime'>>>;
  readonly parentRole: string;
  readonly parentHarness: string;
  /** Progress callback for REPL status display. Called when children start, progress, and complete. */
  readonly onProgress?: (status: string) => void;
  /**
   * FEATURE_074: Predicate provided by the parent REPL to evaluate plan-mode block
   * reasons at each child tool call. The predicate closes over parent state so
   * mid-run mode toggles propagate to in-flight children. When absent, children
   * run without plan-mode enforcement.
   */
  readonly planModeBlockCheck?: PlanModeBlockCheck;

  /**
   * FEATURE_092 phase 2b.7b slice D: parent-Runner guardrails forwarded into
   * each child's `Runner.run` via `KodaXOptions.guardrails`. The auto-mode
   * guardrail's mutable state (engine + denialTracker + circuitBreaker) is
   * shared by passing the SAME instance — preventing children from reaching
   * a fresh threshold and bypassing the parent's downgrade.
   */
  readonly guardrails?: readonly import('@kodax-ai/agent').Guardrail[];

  /**
   * FEATURE_177 v0.7.45: optional bridge that feeds per-child events
   * (iteration start, tool-use start) into the parent's snapshot map.
   * Closes over `ctx.childProgressSnapshots` at the dispatch site so
   * the writer and `task_output` reader share one Map instance. Absent
   * on the sync-dispatch path (no in-flight state to peek at).
   */
  readonly snapshotUpdater?: (
    event: import('./child-progress-snapshot.js').ChildSnapshotEvent,
  ) => void;
}

export async function executeChildAgents(
  bundles: readonly KodaXChildContextBundle[],
  parentCtx: KodaXToolExecutionContext,
  options: ChildExecutorOptions,
): Promise<KodaXChildExecutionResult> {
  if (bundles.length === 0) {
    return EMPTY_RESULT;
  }

  const readBundles = bundles.filter((b) => b.readOnly);
  const writeBundles = bundles.filter((b) => !b.readOnly);

  // Validate write bundles: only H2 Generator allowed
  const allowedWriteBundles = validateWriteBundles(
    writeBundles,
    options.parentRole,
    options.parentHarness,
  );

  const allBundles = [...readBundles, ...allowedWriteBundles];
  if (allBundles.length === 0) {
    return EMPTY_RESULT;
  }

  const results: KodaXChildAgentResult[] = [];
  const cancelledChildren: string[] = [];
  const report = options.onProgress ?? (() => {});

  report(`Starting ${allBundles.length} child tasks in parallel`);

  // FEATURE_120 v0.7.39 Step 0d — bounded-concurrency + abort + progress
  // events are owned by `runFanOut` (agent-layer, ADR-021). This call
  // preserves the previous semantics:
  //   - Promise.allSettled-style rejection capture → `result.results`
  //   - Pre-execution abort check → `result.cancelled`
  //   - Per-bundle progress callbacks adapted to the legacy string-based
  //     `onProgress` contract.
  // Note: `result.results` is in COMPLETION order (not bundle order). We
  // use the embedded bundle reference on each outcome, not array index,
  // to attribute crashes back to their bundle.
  const fanOut = await runFanOut<KodaXChildContextBundle, KodaXChildAgentResult>({
    bundles: allBundles,
    runOne: (bundle) =>
      bundle.readOnly
        ? executeReadChild(bundle, parentCtx, options)
        : executeWriteChild(bundle, parentCtx, options),
    maxParallel: options.maxParallel,
    abortSignal: options.abortSignal,
    onProgress: (event, ctx) => {
      if (event.kind === 'start') {
        report(`[${ctx.completedCount}/${ctx.totalCount}] Running: ${event.bundle.id}`);
      } else if (event.kind === 'item-done') {
        report(`[${ctx.completedCount}/${ctx.totalCount}] Done: ${event.bundle.id} → ${event.result.status}`);
      }
      // `item-failed` events are absorbed into the crash branch below —
      // the rejection's bundle.id was already surfaced via `start`, and
      // the synthesized `[Crash]` result will appear in `results`.
    },
  });

  for (const r of fanOut.results) {
    if (r.status === 'fulfilled') {
      results.push(r.value);
    } else {
      results.push(extractChildResult(r.bundle, `[Crash] ${r.reason.message}`, 'failed'));
    }
  }
  for (const b of fanOut.cancelled) {
    cancelledChildren.push(b.id);
  }

  return mergeChildResults(allBundles, results, cancelledChildren);
}

/* ---------- Specialist override helper (FEATURE_191) ---------- */

/**
 * Compute `(systemPromptOverride, excludeTools)` for a child given the
 * bundle's `specialistName`. When set, the specialist's instructions
 * replace the default child system prompt, and the excludeTools list
 * becomes the complement of the specialist's `tools` array (full tool
 * universe minus what the specialist whitelists). When unset, the
 * defaults the caller passes through are used.
 *
 * Resolution is best-effort: if the specialist was unregistered between
 * dispatch and execution (a rare race the dispatch-child-tasks guard
 * cannot fully prevent in async fan-out), the defaults fire as a fail-
 * safe — the child still runs, just without specialist overrides. This
 * matches the "specialist override is opportunistic, not load-bearing"
 * semantic of the FEATURE_191 design.
 */
interface SpecialistOverride {
  systemPromptOverride: string;
  excludeTools: readonly string[];
  /**
   * FEATURE_102 Phase 1 (v0.7.45): the specialist agent's explicit model /
   * provider, when its manifest declared them. The child-executor prefers
   * these over the parent's. This is the SAFE, explicit (user-authored) slice
   * of model routing — no capability auto-inference (that is billing-sensitive
   * and gated on the Phase 4 quality eval). Undefined when the specialist set
   * no model/provider → falls through to the parent default.
   */
  modelOverride?: string;
  providerOverride?: string;
}

function resolveSpecialistOverride(
  bundle: KodaXChildContextBundle,
  defaultSystemPrompt: string,
  defaultExcludeTools: readonly string[],
): SpecialistOverride {
  if (!bundle.specialistName) {
    return { systemPromptOverride: defaultSystemPrompt, excludeTools: defaultExcludeTools };
  }
  const specialist: Agent | undefined = resolveConstructedAgent(bundle.specialistName);
  if (!specialist) {
    // Defensive fail-safe — should not happen because the dispatch layer
    // already rejected unknown names. If it does (e.g. registry mutated
    // mid-flight), fall through to defaults rather than blocking the
    // child run.
    return { systemPromptOverride: defaultSystemPrompt, excludeTools: defaultExcludeTools };
  }
  // FEATURE_102 Phase 1: surface the specialist's explicit model/provider.
  const modelProvider: Pick<SpecialistOverride, 'modelOverride' | 'providerOverride'> = {
    ...(specialist.model ? { modelOverride: specialist.model } : {}),
    ...(specialist.provider ? { providerOverride: specialist.provider } : {}),
  };
  // Agent.instructions is `string | ((ctx) => string)`. Constructed agents
  // built by agent-resolver.buildAgentFromContent assign the literal
  // string straight through; the function variant is reserved for
  // platform-level dynamic prompts (built-in agents). Specialist override
  // therefore safely narrows to the string branch.
  const systemPromptOverride = typeof specialist.instructions === 'string'
    ? specialist.instructions
    : defaultSystemPrompt;

  // Complementary exclusion: KodaXOptions.context has no `includeOnlyTools`
  // API. Computing `allTools - specialist.tools` as the excludeTools list
  // is semantically equivalent to an allowlist intersect without
  // requiring a new option schema (ADR-035 R11, YAGNI-compliant).
  if (!specialist.tools || specialist.tools.length === 0) {
    // Specialist declared no tools — fall back to defaults so the child
    // still has the standard CHILD_EXCLUDE_TOOLS_BASE/READONLY guard
    // rather than an unrestricted toolset.
    return { systemPromptOverride, excludeTools: defaultExcludeTools, ...modelProvider };
  }
  const specialistToolNames = new Set(specialist.tools.map(t => t.name));
  const allToolNames = getAllRegisteredTools().map(t => t.name);
  const excludeTools = allToolNames.filter(n => !specialistToolNames.has(n));
  return { systemPromptOverride, excludeTools, ...modelProvider };
}

/* ---------- Read-only child execution ---------- */

async function executeReadChild(
  bundle: KodaXChildContextBundle,
  parentCtx: KodaXToolExecutionContext,
  options: ChildExecutorOptions,
): Promise<KodaXChildAgentResult> {
  const briefing = await buildChildBriefing(bundle, parentCtx, options.maxIterationsPerChild);
  const childEvents = buildChildEvents(
    bundle.id,
    options.onProgress,
    options.planModeBlockCheck,
    options.snapshotUpdater,
  );

  // FEATURE_191 — specialist override switch (no-op when bundle.specialistName
  // is undefined; falls through to v0.7.42 defaults).
  // FEATURE_102 Phase 1 — also surfaces the specialist's explicit model/provider.
  const { systemPromptOverride, excludeTools, modelOverride, providerOverride } =
    resolveSpecialistOverride(
      bundle,
      CHILD_AGENT_SYSTEM_PROMPT,
      CHILD_EXCLUDE_TOOLS_READONLY,
    );

  // FEATURE_102 P1-auto — model_hint routing applies only when the dispatcher
  // gave neither an explicit provider/model (P2) nor a specialist (P1).
  const hintTier =
    bundle.provider === undefined &&
    bundle.model === undefined &&
    providerOverride === undefined &&
    modelOverride === undefined
      ? resolveModelHintTier(bundle.modelHint, /* readOnly */ true)
      : undefined;

  const provider =
    bundle.provider ?? providerOverride ?? hintTier?.provider ?? options.parentOptions.provider ?? 'anthropic';

  try {
    const result = await (await getRunKodaX())(
      {
        provider,
        model: bundle.model ?? modelOverride ?? hintTier?.model ?? options.parentOptions.model,
        reasoningMode: options.parentOptions.reasoningMode,
        agentMode: 'sa',
        maxIter: options.maxIterationsPerChild,
        abortSignal: options.abortSignal,
        extensionRuntime: options.parentOptions.extensionRuntime,
        // FEATURE_092 phase 2b.7b slice D: forward parent-Runner guardrails so
        // child tool calls go through the SAME auto-mode classifier instance
        // (shared engine + denialTracker + circuitBreaker state).
        guardrails: options.guardrails,
        context: {
          gitRoot: parentCtx.gitRoot,
          executionCwd: parentCtx.executionCwd ?? parentCtx.gitRoot,
          systemPromptOverride,
          excludeTools,
          // FEATURE_123 v0.7.44 — propagate agentId + registry so the
          // child runtime can answer peer `send_message` calls. The
          // child stays unable to mutate the registry (no
          // dispatch_child_task tool).
          currentAgentId: bundle.id,
          parentAgentId: parentCtx.currentAgentId,
          inheritedChildTaskRegistry: parentCtx.childTaskRegistry,
        },
        events: childEvents,
      },
      briefing,
    );

    const iterations = result.messages.filter((m) => m.role === 'assistant').length;
    return extractChildResult(
      bundle,
      result.lastText,
      result.success ? 'completed' : 'failed',
      iterations,
      result.interrupted === true,
    );
  } catch (error) {
    return extractChildResult(
      bundle,
      error instanceof Error ? error.message : String(error),
      'failed',
      0,
      false,
    );
  }
}

/* ---------- Write child execution ---------- */
// FEATURE_188 v0.7.42 (ADR-034) — write children no longer get an
// isolated git worktree. They share parent cwd + gitRoot, with a fresh
// per-child `backups` Map providing per-file rollback. Prompt-level
// peer-coordination (added to write-child briefing) handles concurrent
// conflict avoidance.

async function executeWriteChild(
  bundle: KodaXChildContextBundle,
  parentCtx: KodaXToolExecutionContext,
  options: ChildExecutorOptions,
): Promise<KodaXChildAgentResult> {
  // Child shares parent cwd + gitRoot. Fresh `backups` Map gives per-child
  // per-file rollback; AGENTS.md resolution uses the parent gitRoot.
  const childCtx: KodaXToolExecutionContext = {
    ...parentCtx,
    backups: new Map(),
  };

  const briefing = await buildChildBriefing(bundle, childCtx, options.maxIterationsPerChild);
  const childEvents = buildChildEvents(
    bundle.id,
    options.onProgress,
    options.planModeBlockCheck,
    options.snapshotUpdater,
  );
  // FEATURE_117 v2 (v0.7.38): write children inherit AGENTS.md mutation
  // policy. Read-only children stay on the bare `CHILD_AGENT_SYSTEM_PROMPT`
  // (they don't mutate, so project rules don't apply).
  const writeSystemPrompt = buildWriteSystemPrompt(parentCtx.gitRoot ?? parentCtx.executionCwd ?? process.cwd());

  // FEATURE_191 — specialist override switch on the write path. Same fail-safe
  // semantic as the read path: unknown specialist falls back to defaults.
  // FEATURE_102 Phase 1 — also surfaces the specialist's explicit model/provider.
  const { systemPromptOverride, excludeTools, modelOverride, providerOverride } =
    resolveSpecialistOverride(
      bundle,
      writeSystemPrompt,
      CHILD_EXCLUDE_TOOLS_BASE,
    );

  // FEATURE_102 P1-auto — write children are NOT eligible for `fast`→cheap
  // (eval covered read-only only); `deep`→strong still applies. Same gate:
  // only when no explicit (P2) / specialist (P1) override is present.
  const hintTier =
    bundle.provider === undefined &&
    bundle.model === undefined &&
    providerOverride === undefined &&
    modelOverride === undefined
      ? resolveModelHintTier(bundle.modelHint, /* readOnly */ false)
      : undefined;

  const provider =
    bundle.provider ?? providerOverride ?? hintTier?.provider ?? options.parentOptions.provider ?? 'anthropic';

  try {
    const result = await (await getRunKodaX())(
      {
        provider,
        model: bundle.model ?? modelOverride ?? hintTier?.model ?? options.parentOptions.model,
        reasoningMode: options.parentOptions.reasoningMode,
        agentMode: 'sa',
        maxIter: options.maxIterationsPerChild,
        abortSignal: options.abortSignal,
        extensionRuntime: options.parentOptions.extensionRuntime,
        // FEATURE_092 phase 2b.7b slice D: forward parent-Runner guardrails so
        // child tool calls go through the SAME auto-mode classifier instance
        // (shared engine + denialTracker + circuitBreaker state).
        guardrails: options.guardrails,
        context: {
          gitRoot: parentCtx.gitRoot,
          executionCwd: parentCtx.executionCwd ?? parentCtx.gitRoot,
          systemPromptOverride,
          excludeTools,
          // FEATURE_123 v0.7.44 — write children share the same peer-
          // routing surface as read children (same agentId + registry
          // propagation rules).
          currentAgentId: bundle.id,
          parentAgentId: parentCtx.currentAgentId,
          inheritedChildTaskRegistry: parentCtx.childTaskRegistry,
        },
        events: childEvents,
      },
      briefing,
    );

    const iterations = result.messages.filter((m) => m.role === 'assistant').length;

    return extractChildResult(
      bundle,
      result.lastText,
      result.success ? 'completed' : 'failed',
      iterations,
      result.interrupted === true,
    );
  } catch (error) {
    return extractChildResult(
      bundle,
      error instanceof Error ? error.message : String(error),
      'failed',
      0,
      false,
    );
  }
}

/* ---------- Structured briefing ---------- */

async function buildChildBriefing(
  bundle: KodaXChildContextBundle,
  ctx: KodaXToolExecutionContext,
  maxIter: number,
): Promise<string> {
  // v0.7.26 NEW-2 — give the child agent explicit cwd / git root /
  // platform context. Without this block, the child's LLM has to guess
  // its working directory (it doesn't inherit the parent's system
  // prompt) and routinely `cd`s into invented paths, causing 200
  // iterations of ENOENT bash failures before timeout and an empty
  // result that surfaces to the parent as a mysterious "child failed".
  const childCwd = resolveExecutionCwd(ctx);
  const childGitRoot = ctx.gitRoot;
  const platform = os.platform();
  const platformLabel =
    platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : platform;
  const shellHint = platform === 'win32'
    ? 'Shell defaults: Windows. Use: dir, move, copy, del, type. Avoid Unix-only tools like `head`, `tail`, `rm`, `cp`, `mv`.'
    : 'Shell defaults: Unix. Use: ls, mv, cp, rm, cat, head, tail.';

  const parts: string[] = [
    `# Child Agent Task`,
    ``,
    `You are a focused sub-agent executing a specific task in parallel with siblings.`,
    `Complete this task efficiently — every iteration the parent waits on adds end-to-end latency. You have a hard limit of ${maxIter} iterations.`,
    ``,
    `## Environment`,
    `Working Directory: ${childCwd}`,
    ...(childGitRoot && childGitRoot !== childCwd ? [`Git Root: ${childGitRoot}`] : []),
    `Platform: ${platformLabel} (${os.release()})`,
    shellHint,
    `All relative paths in your tool calls (read/write/edit/bash) resolve against the Working Directory above. Do NOT \`cd\` into invented paths — the working directory is fixed for the duration of this task, and each \`bash\` call runs in a fresh subprocess so a \`cd\` would not persist across calls anyway.`,
    ``,
    `## Objective`,
    bundle.objective,
    ``,
    `## Scope`,
    bundle.scopeSummary ?? (bundle.constraints.join(', ') || 'No specific scope constraints.'),
    ``,
    `## Constraints`,
    bundle.readOnly
      ? '- This is a READ-ONLY task. Do NOT modify any files — the parent dispatched this child specifically for investigation, and a sibling write-child (or the parent itself) will handle any mutations the findings imply.'
      : '- You may modify files within the scope listed above.',
    `- You CANNOT spawn child agents or call dispatch_child_tasks — recursion is disabled at the tool layer to keep fan-out bounded.`,
    ...(bundle.readOnly
      ? []
      : [
          ``,
          // FEATURE_188 v0.7.42 (ADR-034) — write children share parent
          // cwd with siblings, so peer-coordination is prompt-enforced.
          `## Coordination with peers`,
          `Other agents may be working in parallel in this same repository. Before making any file modification, briefly check whether your target path could be touched by a peer (e.g. the coordinator dispatched another sibling whose scope overlaps yours, or the user mentioned a parallel thread). If you cannot confidently rule out a conflict, STOP and report back to the coordinator with what you observed rather than proceeding with the edit. The coordinator will resolve the conflict or hand you an updated scope.`,
        ]),
    ``,
    `## Execution Strategy (use parallel tool calls)`,
    `- Open broad: scope-scan turn emits parallel \`glob\` for structure + \`grep\` for key patterns + \`read\` on the obvious entry files, all in one response.`,
    `- Iterate narrow: deep-read on files identified by the scope scan, again emitting multiple reads in parallel per turn.`,
    `- Synthesize early: stop investigating once the evidence is sufficient to answer the objective. Extra iterations waste tokens and delay the parent's synthesis.`,
    `- Signal completion with a text-only response (no tool calls). Any final tool call re-opens the turn and forces another LLM round without giving the parent new information.`,
  ];

  if (bundle.evidenceRefs.length > 0) {
    parts.push(``, `## Known Evidence`);
    for (const ref of bundle.evidenceRefs) {
      const resolved = await resolveEvidenceRef(ref, ctx);
      parts.push(resolved);
    }
  }

  parts.push(
    ``,
    `## Output Format`,
    `When done, provide a concise text summary:`,
    `- Key findings (file:line references)`,
    `- Severity assessment (if applicable)`,
    `- Specific recommendations`,
    `Do NOT call any more tools in your final response.`,
  );

  return parts.join('\n');
}

/**
 * Exported for unit testing of the `evidence_refs[]` resolution contract
 * (FEATURE_199 + pre-existing `file:` / `diff:` / `finding:` regression
 * coverage). Not part of the SDK public surface — callers in production
 * still hit it only through `buildChildBriefing`. Keep the implementation
 * private semantics intact: every branch must produce a visible briefing
 * fragment, no silent fallthrough.
 */
export async function resolveEvidenceRef(
  ref: string,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  if (ref.startsWith('file:')) {
    const filePath = ref.slice(5);
    try {
      const content = await fsPromises.readFile(filePath, 'utf-8');
      const lines = content.split('\n').slice(0, 200);
      return `### ${filePath}\n\`\`\`\n${lines.join('\n')}\n\`\`\``;
    } catch {
      return `- ${ref} (could not read file)`;
    }
  }
  if (ref.startsWith('diff:')) {
    const filePath = ref.slice(5);
    try {
      const diff = execSync(`git diff HEAD -- "${filePath}"`, {
        cwd: ctx.gitRoot ?? undefined,
        encoding: 'utf-8',
        timeout: 10_000,
      });
      return diff.length > 0
        ? `### diff: ${filePath}\n\`\`\`diff\n${diff.slice(0, 4000)}\n\`\`\``
        : `- ${ref} (no changes)`;
    } catch {
      return `- ${ref} (could not get diff)`;
    }
  }
  if (ref.startsWith('finding:')) {
    return `- **Known fact**: ${ref.slice(8)}`;
  }
  // FEATURE_199 (v0.7.44) — sibling-aware child dispatch.
  // Looks up a completed sibling child's `finalText` from the shared
  // FEATURE_177 `childProgressSnapshots` ring buffer (cap=200, finalized
  // in the dispatch tool's inner-IIFE `.finally`). All lifecycle states
  // produce visible briefing output so a Worker that ref'd a stale id
  // sees a friendly fallback instead of a silent miss.
  if (ref.startsWith('task_id:')) {
    const childId = ref.slice('task_id:'.length).trim();
    if (!childId) {
      return `- [evidence_refs error] task_id: prefix is missing the child id (write \`task_id:<id>\` where <id> is the value returned from a prior dispatch_child_task call)`;
    }
    const snap = ctx.childProgressSnapshots?.get(childId);
    if (!snap) {
      return `- task_id:${childId} (not found — child unknown, already cap-pruned, or sync-dispatch mode without snapshot map; verify the id matches a recent dispatch_child_task return)`;
    }
    if (snap.status === 'running') {
      return `- task_id:${childId} (still running — use the \`task_output\` tool to poll, or wait for the \`<task-completed task_id="${childId}">\` block in your next user message)`;
    }
    // Cap + code-fence wrap finalText so multi-hop prompt injection
    // through a compromised child cannot escape the briefing framing.
    // Mirrors the `diff:` branch's slice(0, 4000) cap pattern. The
    // ``` fence prevents internal Markdown / XML tags in finalText
    // from being interpreted as new briefing sections by the next
    // child's LLM. Cap is 10000 chars — large enough for a thorough
    // scout report, small enough to bound a hostile payload.
    const FINAL_TEXT_CAP = 10000;
    const FENCE = '```';
    const rawBody = snap.finalText ?? '(no final text recorded)';
    let body = rawBody.length > FINAL_TEXT_CAP
      ? `${rawBody.slice(0, FINAL_TEXT_CAP)}\n[…truncated ${rawBody.length - FINAL_TEXT_CAP} chars; use \`task_output\` for the full text]`
      : rawBody;
    // Defensive: if the body itself contains the exact fence
    // sequence, escape it so the fence cannot be closed mid-body.
    if (body.includes(FENCE)) {
      body = body.replace(/```/g, '`​`​`');
    }
    return `### task: ${childId} (${snap.status})\n${FENCE}\n${body}\n${FENCE}`;
  }
  // FEATURE_199 (v0.7.44) — unknown prefix → visible error instead of
  // silent fallthrough. Pre-F199 this returned `- ${ref}` verbatim,
  // which made `path:packages/x` (typo for `file:`) / `diff packages/x`
  // (missing colon) / `file: packages/x` (stray whitespace) appear in
  // the child briefing as a useless literal string while the parent LLM
  // believed it had forwarded the evidence. The error string surfaces
  // the failure to the parent on the next turn (it appears in the
  // dispatch tool_result that wraps the child summary) so the Worker
  // can self-correct the prefix.
  return `- [evidence_refs error] unrecognized prefix in "${ref}" — valid prefixes: file:, diff:, finding:, task_id:`;
}

/* ---------- Child events (progress visibility) ---------- */

/**
 * Focused system prompt for child agents — replaces the full system prompt entirely.
 * Mirrors Claude Code's DEFAULT_AGENT_PROMPT: lightweight, task-focused, no AMA overhead.
 * KodaX-specific: emphasizes parallel tool calls and structured output.
 *
 * Read-only children use this verbatim. Write children get an additional
 * mutation-policy section appended via `buildWriteSystemPrompt` (FEATURE_117).
 */
export const CHILD_AGENT_SYSTEM_PROMPT = [
  'You are a focused sub-agent executing a specific task assigned by a parent agent.',
  'Use the available tools to complete the task fully. Do not gold-plate, but do not leave it half-done.',
  '',
  '## Tool Use — Prefer Parallel Calls',
  '',
  'When multiple tool calls are independent of each other, emit them all in the SAME response. The execution engine runs non-bash tools concurrently via Promise.all, so serial calls add real wall-clock latency the parent waits on.',
  '',
  'Concrete rules:',
  '- For module exploration or change review, lead with pull-tools (`module_context` / `symbol_context` / `changed_scope` / `changed_diff_bundle`) — each replaces several read+grep calls so the same investigation finishes in fewer turns.',
  '- For single-file lookup or byte-exact verification, use `glob` + `grep` + targeted `read`.',
  '- When you need multiple independent tool calls (pull-tools, reads, or greps), emit them all in one response. Only serialize when a later call genuinely depends on an earlier result (e.g., you need a file path from grep before you can read it).',
  '- Open broad with a parallel fan-out covering the obvious scope axes, then narrow on follow-up turns. Prefer a few targeted calls over many tiny sequential probes.',
  '',
  '## Peer Communication',
  '',
  'You can send short messages to other in-flight agents in this session with `send_message`:',
  '- `send_message(to="<peer task_id>", content="…")` — notify a sibling child that your work overlaps with theirs or that you found something they need to know.',
  '- `send_message(to="worker", content="…")` — surface a mid-flight finding to your parent Worker (drains when the Worker next yields).',
  '- `send_message(to="*", content="…")` — broadcast to every sibling plus the parent Worker. Capped at 20 recipients per call.',
  '',
  'Send a peer message when it would change another agent\'s plan: a file you both edit, a fact you discovered that changes their scope, a blocker the parent should know about. Do not send routine status pings — peer chatter that does not change anyone\'s plan is noise.',
  '',
  'Forwarding: peer wrappers carry a `seen_by="A,B,…"` attribute listing every agent that has already handled the chain. If you intentionally forward a received peer message, pass that list as the `seen_by` parameter so the tool can reject cycles (forwarding back to a prior sender) and cap chain depth. Omit `seen_by` for fresh sends — the tool always auto-appends you.',
  '',
  '## Execution Guidelines',
  '- Focus on the objective described in the user message. Do not deviate.',
  '- When you have sufficient evidence, stop investigating and synthesize your findings.',
  '- Your final response MUST be text only — the parent reads your text directly as the dispatch result, and a final tool call would re-open the turn and force another LLM round without giving the parent new information.',
  '',
  '## Output Format',
  'Respond with a concise report covering:',
  '- Key findings with specific file:line references',
  '- Severity or priority assessment (if applicable)',
  '- Concrete recommendations',
  '',
  'Keep the report focused — the parent will relay it to the user.',
].join('\n');

/**
 * FEATURE_117 v2 (v0.7.38, 2026-05-09) — write-child mutation context.
 *
 * Read-only children get `CHILD_AGENT_SYSTEM_PROMPT` verbatim — they only
 * navigate code, so AGENTS.md mutation policy is irrelevant. Write children
 * (H2 Generator / Worker fan-out) actually edit files and would silently
 * violate project rules ("NEVER use `any`", forbidden imports, coding-style
 * conventions) unless the project's AGENTS.md is in their system prompt.
 *
 * The original FEATURE_117 design ("strip read-path context") was inverted
 * after Phase 3 fact-check showed `systemPromptOverride` already short-
 * circuits `buildSystemPrompt` for ALL children — there was nothing to
 * strip. The real gap is the opposite direction: write children silently
 * skip the project rules. This helper restores them only for the write
 * path.
 *
 * Cost: AGENTS.md is loaded once via `loadAgentsFiles` (mtime-cached by
 * FEATURE_149 Phase 1.2), formatted, and prepended to the override.
 * Anthropic `cache_control: ephemeral` covers the system prompt block,
 * so the AGENTS.md tokens are billed once per ~5 min cache window
 * regardless of fan-out size.
 *
 * Returns the base prompt unchanged when no AGENTS.md exists.
 */
function buildWriteSystemPrompt(gitRoot: string): string {
  // Sync — `loadAgentsFiles` reads via `readFileSync` and the helper has no
  // async I/O. Kept synchronous so the single mtime-stat-and-cache walk
  // does not pay an unnecessary microtask boundary on every write-child
  // spawn (FEATURE_119 H2 fan-out can dispatch 4-8 children in one wave).
  const agentsFiles = loadAgentsFiles({ cwd: gitRoot, projectRoot: gitRoot });
  const formatted = formatAgentsForPrompt(agentsFiles);
  if (!formatted) return CHILD_AGENT_SYSTEM_PROMPT;

  // `formatted` already has its own `# Project Context` H1 + `## … Rules`
  // H2s + `---` dividers. Don't re-wrap with another H2 (`## Mutation
  // Policy`) — the heading hierarchy would invert (H2 → H1 inside) and
  // muddle the structure for the LLM. Just prepend a short framing
  // sentence so the child knows these rules apply to its mutations.
  return [
    CHILD_AGENT_SYSTEM_PROMPT,
    '',
    'Project rules apply to your mutations. Follow them as the parent agent would:',
    formatted,
  ].join('\n');
}

/**
 * Tools excluded from child agents at API level (LLM never sees these definitions).
 * Mirrors Claude Code's filterToolsForAgent: no AMA, no recursion, no user interaction,
 * no parent-only permission controls.
 *
 * Exported for unit-testing the security contract. Treat as read-only at runtime.
 */
export const CHILD_EXCLUDE_TOOLS_BASE: readonly string[] = [
  'emit_managed_protocol',  // AMA protocol; children are SA mode
  'dispatch_child_task',    // Prevent recursive child spawning
  // FEATURE_155 v0.7.39 Slice C1 — `await_child_task` removed; the
  // tool no longer exists, so excluding it from children is moot.
  // FEATURE_123 v0.7.44 — `send_message` is no longer coordinator-only.
  // Children can now address peers via task_id, the parent Worker via
  // `'worker'`, and all running siblings + Worker via `'*'`. The tool
  // itself enforces target shapes (self-rejection, broadcast cap,
  // priority/framing rules) so removing it from the exclusion list is
  // safe — the policy lives in the tool, not the whitelist.
  'task_stop',              // FEATURE_120: coordinator-only — children cannot stop siblings
  'task_output',            // FEATURE_177: coordinator-only — children cannot peek at sibling progress
  'ask_user_question',      // Children cannot prompt the user
  'worktree_create',        // Worktree lifecycle managed by parent
  'worktree_remove',        // Worktree lifecycle managed by parent
  'exit_plan_mode',         // Plan-mode exit requires user UI; only the parent REPL wires the callback
];

/** Additional tools excluded for read-only children (no file mutations). */
const CHILD_EXCLUDE_TOOLS_READONLY: readonly string[] = [
  ...CHILD_EXCLUDE_TOOLS_BASE,
  'write',
  'edit',
  'multi_edit',
  'insert_after_anchor',
  'undo',
];

/**
 * Tools blocked at execution time (defense-in-depth, in case tool list filtering is bypassed).
 * Unified with CHILD_EXCLUDE_TOOLS_BASE to prevent the two lists from drifting again.
 */
const CHILD_BLOCKED_TOOLS = new Set<string>(CHILD_EXCLUDE_TOOLS_BASE);

/**
 * @param planModeBlockCheck FEATURE_074: parent-injected predicate that returns the
 *   block reason for currently-plan-mode-violating tool calls, or `null` when allowed.
 *   The predicate closes over live parent state, so mid-run mode toggles propagate.
 */
export function buildChildEvents(
  childId: string,
  onProgress?: (status: string) => void,
  planModeBlockCheck?: PlanModeBlockCheck,
  snapshotUpdater?: (
    event: import('./child-progress-snapshot.js').ChildSnapshotEvent,
  ) => void,
): KodaXEvents | undefined {
  let iterationCount = 0;
  let maxIterations = 200;
  let lastProgressTime = 0;
  const PROGRESS_THROTTLE_MS = 150; // Limit updates to ~6/sec per child

  const throttledProgress = (msg: string, force = false): void => {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - lastProgressTime < PROGRESS_THROTTLE_MS) return;
    lastProgressTime = now;
    onProgress(msg);
  };

  return {
    // Block AMA-specific and recursive tools, then enforce live plan mode.
    // planModeBlockCheck reads parent state at call time, so mid-run mode toggles
    // (common: user flips plan ↔ accept-edits mid-stream) propagate immediately.
    beforeToolExecute: async (tool: string, input: Record<string, unknown>) => {
      if (CHILD_BLOCKED_TOOLS.has(tool)) {
        return `[Tool Error] ${tool}: Not available in child agent context.`;
      }
      if (planModeBlockCheck) {
        const reason = planModeBlockCheck(tool, input);
        if (reason) {
          return `${reason} You are a child agent inheriting plan-mode constraints. Complete investigation and return findings as text — the parent agent will request user approval for any implementation.`;
        }
      }
      return true;
    },
    // Silently update counter; tool use line will include it.
    onIterationStart: (iter: number, maxIter: number) => {
      iterationCount = iter;
      maxIterations = maxIter;
      // FEATURE_177: feed iteration into snapshot. Not throttled — one
      // event per iteration is at most a few times per second and we
      // want the snapshot iteration count to be exact, not approximate.
      if (snapshotUpdater) {
        snapshotUpdater({ kind: 'iteration', iteration: iter, maxIterations: maxIter });
      }
    },
    // Combined progress: "sec-coding [3/200] → read src/foo.ts" (throttled)
    onToolUseStart: (tool) => {
      const inputHint = tool.input
        ? (typeof tool.input === 'object'
          ? (tool.input as Record<string, unknown>).path
            ?? (tool.input as Record<string, unknown>).pattern
            ?? (tool.input as Record<string, unknown>).command
            ?? ''
          : '')
        : '';
      const hintStr = typeof inputHint === 'string' ? inputHint.slice(0, 60) : '';
      const hint = hintStr ? ` ${hintStr}` : '';
      throttledProgress(`${childId} [${iterationCount}/${maxIterations}] → ${tool.name}${hint}`);
      // FEATURE_177: feed tool-call breadcrumb into snapshot. Independent
      // of the REPL throttle — breadcrumbs are bounded by the
      // ring-buffer cap, so emitting one per tool call cannot grow the
      // snapshot unbounded.
      if (snapshotUpdater) {
        snapshotUpdater({
          kind: 'tool-start',
          iteration: iterationCount,
          toolName: tool.name,
          inputHint: hintStr,
          startedAt: Date.now(),
        });
      }
    },
  };
}

/* ---------- Result extraction ---------- */

function extractChildResult(
  bundle: KodaXChildContextBundle,
  summary: string,
  status: KodaXChildAgentResult['status'],
  actualIterations?: number,
  interrupted?: boolean,
): KodaXChildAgentResult {
  return {
    childId: bundle.id,
    fanoutClass: bundle.fanoutClass,
    status,
    disposition: status === 'completed' ? 'valid' : 'needs-more-evidence',
    summary,
    evidenceRefs: bundle.evidenceRefs,
    contradictions: [],
    actualIterations,
    interrupted,
  };
}

/* ---------- Result merging (anchored incremental) ---------- */

function mergeChildResults(
  bundles: readonly KodaXChildContextBundle[],
  results: readonly KodaXChildAgentResult[],
  cancelledChildren: readonly string[],
): KodaXChildExecutionResult {
  const bundleMap = new Map(bundles.map((b) => [b.id, b]));
  const resultByChildId = new Map(results.map((r) => [r.childId, r]));

  // Findings follow dispatch (bundle) order, not completion order. `results`
  // intentionally stays in completion order for crash attribution, but
  // consumers read `mergedFindings` positionally against the order they
  // requested — so we re-align here. Without this, parallel children that
  // finish out of order produce nondeterministic finding ordering.
  const mergedFindings: KodaXChildFinding[] = bundles
    .map((b) => resultByChildId.get(b.id))
    .filter(
      (r): r is KodaXChildAgentResult =>
        r !== undefined && (r.status === 'completed' || r.summary.length > 0),
    )
    .map((r) => ({
      childId: r.childId,
      objective: bundleMap.get(r.childId)?.objective ?? '',
      evidence: [r.summary, ...r.evidenceRefs],
      artifacts: r.artifactPaths ?? [],
    }));

  const mergedArtifacts = [
    ...new Set(results.flatMap((r) => r.artifactPaths ?? [])),
  ];

  return {
    results,
    mergedFindings,
    mergedArtifacts,
    totalTokensUsed: 0, // Tracked via FEATURE_064 cost observatory when available
    cancelledChildren: [...cancelledChildren],
  };
}

/* ---------- Validation ---------- */

function validateWriteBundles(
  writeBundles: readonly KodaXChildContextBundle[],
  parentRole: string,
  parentHarness: string,
): readonly KodaXChildContextBundle[] {
  if (writeBundles.length === 0) return [];

  // Worker (V2 AMA single-loop primary) is the sole dispatcher allowed to
  // emit write fan-out, signalled by `parentHarness === 'tool-dispatch'`
  // (set by `dispatch-child-tasks.ts` via `wrapDispatchChildTaskForRole`,
  // which only accepts `role === 'worker'`).
  //
  // If this gate rejects a role/harness pair that the wrapper accepts, the
  // write bundle is silently dropped: `executeChildAgents` returns
  // `EMPTY_RESULT`, `dispatch-child-tasks.ts` unpacks
  // `result.results[0] === undefined`, and the Worker sees
  // `failed: no result` with no diagnostic signal. The async branch's
  // empty-banner fallback covers the success-empty case; the
  // failed-empty diagnostic envelope covers the post-fix residual paths.
  if (parentRole !== 'worker') {
    return [];
  }
  if (parentHarness !== 'tool-dispatch') {
    return [];
  }

  return writeBundles;
}

/* ---------- Constants ---------- */

const EMPTY_RESULT: KodaXChildExecutionResult = {
  results: [],
  mergedFindings: [],
  mergedArtifacts: [],
  totalTokensUsed: 0,
  cancelledChildren: [],
};
