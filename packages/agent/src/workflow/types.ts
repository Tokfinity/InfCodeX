/**
 * FEATURE_217 (v0.7.49) — Dynamic Workflow Harness Runtime: public types.
 *
 * Domain-neutral workflow orchestration surface. A workflow *script*
 * coordinates (decompose / fan-out / loop / wait / stop / verify /
 * synthesize); it never touches files or shell directly. The actual
 * agent execution is delegated to an injected `WorkflowAgentBackend`
 * (the coding layer provides the real one in Phase B; tests inject a
 * fake). This keeps `@kodax-ai/agent` free of any `@kodax-ai/coding`
 * dependency (ADR-021 layer independence).
 */

/** Lifecycle status of a single workflow-spawned agent. */
export type WorkflowTaskStatus = 'running' | 'completed' | 'failed' | 'stopped';

/** Routing hint for which provider/model tier the child should use. */
export type WorkflowModelHint = 'fast' | 'balanced' | 'deep';

/** Isolation policy for a spawned agent. `shared-cwd` is the default
 *  (FEATURE_188); `worktree` is opt-in for high-risk parallel writes. */
export type WorkflowIsolation = 'shared-cwd' | 'worktree';

export interface WorkflowSpawnAgentInput {
  /** Human-readable label for the agent — surfaces in events / UI. */
  readonly name: string;
  /** The task prompt handed to the child agent. */
  readonly prompt: string;
  /** When true, the child runs with a read-only tool whitelist. */
  readonly readOnly?: boolean;
  /** Route to a registered specialist agent (FEATURE_191). */
  readonly subagentType?: string;
  /** Provider/model tier hint (FEATURE_120 model_hint → env tier). */
  readonly modelHint?: WorkflowModelHint;
  /** Isolation policy; defaults to `shared-cwd`. */
  readonly isolation?: WorkflowIsolation;
  /** Evidence refs (`task_id:<id>` etc.) seeded into the child context. */
  readonly evidenceRefs?: readonly string[];
}

/** Returned by `spawnAgent` — the child is in-flight, not yet complete. */
export interface WorkflowTaskHandle {
  readonly taskId: string;
  readonly name: string;
}

export interface WorkflowTaskUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

/** Terminal result of a spawned agent (from `wait` / `runAgent`). */
export interface WorkflowTaskResult {
  readonly taskId: string;
  readonly name: string;
  readonly status: WorkflowTaskStatus;
  readonly finalText: string;
  /** Short user-facing digest, separate from the full finalText used for synthesis/audit. */
  readonly digest?: string;
  readonly usage?: WorkflowTaskUsage;
}

/** Point-in-time snapshot of a (possibly still-running) agent. */
export interface WorkflowTaskSnapshot {
  readonly taskId: string;
  readonly name: string;
  readonly status: WorkflowTaskStatus;
  readonly lastText?: string;
}

export interface WorkflowWaitOptions {
  readonly timeoutMs?: number;
}

export interface WorkflowParallelOptions {
  /** In-flight cap for this parallel block; clamped by workflow
   *  maxConcurrency. */
  readonly concurrency?: number;
}

export interface WorkflowSynthesizeInput {
  readonly inputs: readonly unknown[] | string | Record<string, unknown>;
  readonly rubric: string;
}

export interface WorkflowSynthesis {
  readonly text: string;
}

export interface WorkflowArtifactRef {
  readonly name: string;
  readonly path?: string;
}

export interface WorkflowLogEvent {
  readonly message: string;
  readonly data?: unknown;
}

/**
 * Token budget accounting. The runtime hard-stops before launching a new
 * agent once completed children have exhausted the configured budget.
 */
export interface WorkflowBudget {
  /** Configured token budget, or null when unbounded. */
  readonly total: number | null;
  /** Tokens accounted across completed agents so far. */
  spent(): number;
  /** `max(0, total - spent())`, or Infinity when unbounded. */
  remaining(): number;
}

export interface WorkflowLimits {
  /** Total agents spawnable across the whole run lifetime. */
  readonly maxAgents?: number;
  /** Maximum simultaneously in-flight agents (via runAgent / parallel). */
  readonly maxConcurrency?: number;
  /** Token budget. New spawns stop once completed usage exhausts it. */
  readonly tokenBudget?: number;
}

/**
 * The surface a workflow script consumes. The script never gets raw
 * fs/shell — all effects route through agent tools behind the backend.
 */
export interface WorkflowApi {
  readonly runId: string;
  readonly args: unknown;
  readonly budget: WorkflowBudget;

  /** Group operations under a named phase (emits phase_started/finished). */
  phase<T>(name: string, fn: () => Promise<T>): Promise<T>;
  /** Start a child agent; returns immediately with a handle. */
  spawnAgent(input: WorkflowSpawnAgentInput): Promise<WorkflowTaskHandle>;
  /** spawnAgent + wait convenience; returns the terminal result. */
  runAgent(input: WorkflowSpawnAgentInput): Promise<WorkflowTaskResult>;
  /** Await a spawned agent's terminal result. */
  wait(taskId: string, opts?: WorkflowWaitOptions): Promise<WorkflowTaskResult>;
  /** Snapshot a (possibly running) agent. */
  output(taskId: string): Promise<WorkflowTaskSnapshot>;
  /** Send a message to a running agent (via MessageQueue routing). */
  send(taskId: string, content: string): Promise<void>;
  /** Stop a running agent (graceful abort). */
  stop(taskId: string, reason: string): Promise<void>;
  /** Run lazy thunks concurrently under the concurrency gate. Thunks
   *  MUST be `() => Promise<T>` (not already-started promises) so the
   *  runtime can bound concurrency. */
  parallel<T>(
    items: readonly (() => Promise<T>)[],
    opts?: WorkflowParallelOptions,
  ): Promise<T[]>;
  /** Synthesize across inputs. Runs as a gated agent through the runtime
   *  (spawn → wait), so it counts toward maxAgents / concurrency / budget
   *  and emits run-graph events — it is NOT a backend side-channel. */
  synthesize(input: WorkflowSynthesizeInput): Promise<WorkflowSynthesis>;
  /** Persist a named artifact. */
  artifact(name: string, value: unknown): Promise<WorkflowArtifactRef>;
  /** Emit a free-text progress log event. */
  log(event: WorkflowLogEvent): void;
}

/** Metadata a workflow declares (name, description, default caps). */
export interface WorkflowMeta {
  readonly name: string;
  readonly description: string;
  /** Best-effort expected child-agent count for progress UI; not a hard cap. */
  readonly plannedAgents?: number;
  readonly maxAgents?: number;
  readonly maxConcurrency?: number;
  readonly tokenBudget?: number;
  /** True when the workflow only ever spawns read-only agents (no file
   *  writes) — surfaced in the approval prompt. */
  readonly readOnly?: boolean;
  /** Declared phase names, for the approval prompt preview. */
  readonly phases?: readonly string[];
}

/** Summary shown to the user before a workflow's first run. */
export interface WorkflowApprovalSummary {
  readonly name: string;
  readonly description: string;
  readonly phases: readonly string[];
  readonly plannedAgents?: number;
  readonly maxAgents: number | null;
  readonly maxConcurrency: number | null;
  readonly tokenBudget: number | null;
  /** Whether the workflow may write files (false for read-only workflows). */
  readonly writesFiles: boolean;
}

/** Approval gate — returns true to proceed, false to cancel the run. */
export type WorkflowApproval = (
  summary: WorkflowApprovalSummary,
) => boolean | Promise<boolean>;

/** A workflow's entry function: coordinates agents via the `WorkflowApi`. */
export type WorkflowRun<TArgs = unknown, TResult = unknown> = (
  wf: WorkflowApi,
  args: TArgs,
) => Promise<TResult>;

/** A self-contained workflow: metadata + entry function. Built-in
 *  workflows (Phase C) and saved `.kodax/workflows/*.ts` (Phase E) both
 *  materialize to this shape. */
export interface WorkflowModule<TArgs = unknown, TResult = unknown> {
  readonly meta: WorkflowMeta;
  readonly run: WorkflowRun<TArgs, TResult>;
}

/**
 * Injected execution backend. The coding layer implements this over its
 * child-dispatch substrate (ChildTaskRegistry / childProgressSnapshots /
 * MessageQueue / executeChildAgents); tests inject a fake. The agent
 * runtime depends ONLY on this interface — never on coding.
 */
export interface WorkflowAgentBackend {
  spawn(input: WorkflowSpawnAgentInput): Promise<WorkflowTaskHandle>;
  wait(taskId: string, opts?: WorkflowWaitOptions): Promise<WorkflowTaskResult>;
  output(taskId: string): Promise<WorkflowTaskSnapshot>;
  send(taskId: string, content: string): Promise<void>;
  stop(taskId: string, reason: string): Promise<void>;
  /** Optional durable artifact writer (Phase D wires the run graph).
   *  `wf.synthesize` is NOT a backend method — it runs as a gated agent
   *  through `spawn`/`wait` so it counts toward the runtime's caps. */
  writeArtifact?(name: string, value: unknown): Promise<WorkflowArtifactRef>;
}

export type WorkflowRunStatus = 'running' | 'completed' | 'failed' | 'stopped';

/** Immutable snapshot of a workflow run's accumulated state. */
export interface WorkflowRunState {
  readonly runId: string;
  readonly status: WorkflowRunStatus;
  readonly totalSpawned: number;
  readonly events: readonly import('./events.js').WorkflowEvent[];
  readonly artifacts: readonly WorkflowArtifactRef[];
}
