/**
 * task_output — coordinator → in-flight child task snapshot query
 * (FEATURE_177 v0.7.45).
 *
 * Lets a parent agent (Worker / Scout / Generator) peek at the current
 * state of a child task launched via `dispatch_child_task`. Returns a
 * structured envelope mirroring claudecode's `TaskOutput` shape:
 *
 *   <retrieval_status>success|wait_expired|not_found</retrieval_status>
 *   <task_id>...</task_id>
 *   <status>running|completed|failed|aborted</status>
 *   <iterations>n/maxN</iterations>
 *   <duration_ms>...</duration_ms>
 *   <recent_tool_calls>...</recent_tool_calls>
 *   <output>...</output>   (only when status terminal)
 *
 * Data source: `ctx.childProgressSnapshots` — populated by the dispatch
 * tool at launch and `.finally`-finalized at terminal. Snapshots survive
 * `childTaskRegistry` cleanup, so post-completion peeks work.
 *
 * Parent-only: filtered from child agent tool lists via
 * `CHILD_EXCLUDE_TOOLS_BASE` (child-executor.ts) and `PLANNER_EXTRA_EXCLUDE`
 * (role-exclude.ts — Planner drafts contracts, doesn't dispatch).
 *
 * Substrate gap vs claudecode: KodaX has no per-child JSONL or disk
 * `<projectTempDir>/sessions/<sessionId>/tasks/<taskId>.output` file,
 * so `<output>` carries the same pre-guardrail string the
 * `<task-completed>` banner uses (the diagnostic envelope for
 * empty/failed paths, the lastText for completed) — not a real-time
 * assistant-text tail. The breadcrumb ring buffer is the only
 * mid-flight content; for granular tracing, parents fall back to
 * `KODAX_DISPATCH_CHILD_TRACE=1` post-mortem JSON.
 *
 * The `block` parameter races the child promise against `timeout_ms`.
 * On success the snapshot is read AFTER the registry promise settles
 * (snapshot is the source of truth — registry entries are deleted on
 * settle via `registerChildTask`'s built-in cleanup chain). On wait expiry
 * the snapshot is read AS-IS; the child may still be running.
 */

import { getMessageQueue } from '@kodax-ai/agent';
import type { AgentTaskSnapshot } from '@kodax-ai/agent';

import type { KodaXToolExecutionContext, WorkflowRunProgressView } from '../types.js';
import type {
  ChildProgressSnapshot,
  ChildToolCallBreadcrumb,
} from '../child-progress-snapshot.js';

const TOOL_NAME = 'task_output';

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 120000;
/** Cap on inlined `<output>` content. Mirrors the per-snapshot
 * `finalText` size which is already guardrailed by the dispatch
 * pipeline, but the tool result also enforces a tail cap so a 50KB
 * spillover preview cannot blow the parent's per-tool budget. */
const OUTPUT_TAIL_BYTES = 8192;

export async function toolTaskOutput(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  // --- Validate input ---
  const taskId = typeof input.task_id === 'string' ? input.task_id.trim() : '';
  if (!taskId) {
    return `[Tool Error] ${TOOL_NAME}: Missing required parameter: task_id (child task_id from dispatch_child_task)`;
  }

  const blockRaw = input.block;
  const block =
    typeof blockRaw === 'boolean'
      ? blockRaw
      : typeof blockRaw === 'string'
        ? blockRaw === 'true'
        : false;

  const timeoutRaw = input.timeout_ms;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (typeof timeoutRaw === 'number' && Number.isFinite(timeoutRaw)) {
    timeoutMs = Math.max(0, Math.min(MAX_TIMEOUT_MS, Math.floor(timeoutRaw)));
  }

  const ledgerTask = await findLedgerTask(ctx, taskId);
  if (ledgerTask?.route === 'external') {
    let task = ledgerTask;
    let ledgerRetrievalStatus: TaskOutputRetrievalStatus = 'success';
    if (block && !isLedgerTerminal(task)) {
      try {
        task = await ctx.agentExecutorPlane!.plane.tasks.wait(taskId, Math.max(1, timeoutMs));
      } catch {
        ledgerRetrievalStatus = 'wait_expired';
        task = await ctx.agentExecutorPlane!.plane.tasks.get(taskId);
      }
    }
    const rendered = renderLedgerTask(task, ledgerRetrievalStatus);
    if (isLedgerTerminal(task)) drainConsumedTaskNotification(taskId);
    return rendered;
  }

  // --- Reject when async dispatch is disabled (no snapshot map) ---
  const snapshots = ctx.childProgressSnapshots;
  if (!snapshots) {
    return `[Tool Error] ${TOOL_NAME}: Async dispatch is disabled (no childProgressSnapshots on context). Children run synchronously and complete inside their dispatch_child_task call — there is no in-flight target to query.`;
  }

  // --- Optional block: race the registry promise vs timeout ---
  let retrievalStatus: TaskOutputRetrievalStatus = 'success';
  if (block) {
    const registry = ctx.childTaskRegistry;
    const inFlight = registry?.get(taskId);
    if (inFlight) {
      const timeout = new Promise<'__timeout__'>((resolve) =>
        setTimeout(() => resolve('__timeout__'), timeoutMs),
      );
      // Swallow rejections — the child's `.finally` block writes the
      // terminal state into the snapshot regardless of whether the
      // promise resolves or rejects. We only need the race for timing.
      const settle = inFlight.then(
        () => '__settled__' as const,
        () => '__settled__' as const,
      );
      const winner = await Promise.race([settle, timeout]);
      if (winner === '__timeout__') {
        retrievalStatus = 'wait_expired';
      }
    }
    // If `registry.get(taskId)` is undefined here, the child already
    // settled (and its registry entry was cleaned) before block:true
    // could await. The snapshot still holds the terminal state, so we
    // fall through to read it; retrievalStatus stays 'success'.
  }

  const snap = snapshots.get(taskId);
  if (!snap) {
    // Gap A: a background run_workflow registers a run-level progress getter (not
    // a per-child snapshot) under its runId. If the peeked id is a running
    // workflow, render its live progress instead of not_found.
    const workflowProgress = ctx.workflowRunProgress?.get(taskId)?.();
    if (workflowProgress) {
      return renderWorkflowRunProgress(taskId, workflowProgress);
    }
    return renderNotFound(taskId);
  }

  const output = renderSnapshot(snap, retrievalStatus);
  if (snap.status !== 'running') {
    // task_output is an explicit read of the terminal child result; keeping
    // the same completion banner queued can wake idle-yield after final text.
    drainConsumedTaskNotification(taskId);
  }
  return output;
}

async function findLedgerTask(
  ctx: KodaXToolExecutionContext,
  taskId: string,
): Promise<AgentTaskSnapshot | undefined> {
  const plane = ctx.agentExecutorPlane?.plane;
  if (!plane) return undefined;
  try {
    return await plane.tasks.get(taskId);
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith('Agent task not found:')) return undefined;
    throw error;
  }
}

function isLedgerTerminal(task: AgentTaskSnapshot): boolean {
  return task.state === 'completed'
    || task.state === 'failed'
    || task.state === 'canceled'
    || task.state === 'rejected';
}

function ledgerDisplayStatus(task: AgentTaskSnapshot): 'running' | 'completed' | 'failed' | 'aborted' {
  if (task.state === 'completed') return 'completed';
  if (task.state === 'canceled') return 'aborted';
  if (task.state === 'failed' || task.state === 'rejected') return 'failed';
  return 'running';
}

function renderLedgerTask(
  task: AgentTaskSnapshot,
  retrievalStatus: TaskOutputRetrievalStatus,
): string {
  const duration = Math.max(0, Date.parse(task.updatedAt) - Date.parse(task.createdAt));
  const lines = [
    `<retrieval_status>${retrievalStatus}</retrieval_status>`,
    `<task_id>${escapeXmlContent(task.taskId)}</task_id>`,
    `<kind>agent</kind>`,
    `<agent_id>${escapeXmlContent(task.agentId)}</agent_id>`,
    `<status>${ledgerDisplayStatus(task)}</status>`,
    `<agent_state>${task.state}</agent_state>`,
    `<cancellation>${task.cancellation}</cancellation>`,
    `<duration_ms>${duration}</duration_ms>`,
  ];
  if (retrievalStatus === 'wait_expired') {
    lines.push('<note>The bounded read window expired; the task remains active or uncertain.</note>');
  }
  if (task.progress) {
    lines.push(`<progress>${escapeXmlContent(JSON.stringify(task.progress))}</progress>`);
  }
  if (task.artifacts && task.artifacts.length > 0) {
    lines.push(`<artifacts>${escapeXmlContent(tailToBytes(
      JSON.stringify(task.artifacts),
      OUTPUT_TAIL_BYTES,
    ))}</artifacts>`);
  }
  if (task.usage) {
    lines.push(`<usage>${escapeXmlContent(JSON.stringify(task.usage))}</usage>`);
  }
  const body = task.output ?? task.error;
  if (body !== undefined) {
    lines.push(task.output !== undefined ? '<output>' : '<error>');
    lines.push(escapeXmlContent(tailToBytes(body, OUTPUT_TAIL_BYTES)));
    lines.push(task.output !== undefined ? '</output>' : '</error>');
  }
  return lines.join('\n');
}

function drainConsumedTaskNotification(taskId: string): void {
  const prefix = `<task-completed task_id="${taskId}">`;
  getMessageQueue().dequeue({
    agentId: undefined,
    maxPriority: 'background',
    mode: 'task-notification',
    predicate: (message) => message.content.startsWith(prefix),
  });
}

/**
 * Gap A — render a background workflow's live progress for a task_output(runId)
 * peek. Workflow-shaped (phase + active/finished agents), distinct from the
 * per-child snapshot render so the Worker sees the run's shape, not a child's.
 */
function renderWorkflowRunProgress(taskId: string, view: WorkflowRunProgressView): string {
  const lines: string[] = [
    `<retrieval_status>success</retrieval_status>`,
    `<task_id>${escapeXmlContent(taskId)}</task_id>`,
    `<kind>workflow</kind>`,
    `<workflow>${escapeXmlContent(view.workflowName)}</workflow>`,
    `<status>${view.status}</status>`,
  ];
  if (view.phase !== undefined) {
    const phase =
      view.phaseIndex !== undefined && view.phaseTotal !== undefined
        ? `${view.phaseIndex}/${view.phaseTotal} ${view.phase}`
        : view.phase;
    lines.push(`<phase>${escapeXmlContent(phase)}</phase>`);
  }
  const finished = view.completedAgents + view.failedAgents + view.stoppedAgents;
  const denominator = Math.max(view.plannedAgents ?? 0, view.totalSpawned, finished);
  const agentSummary =
    `${view.activeAgents.length} running, ${view.completedAgents} completed` +
    (view.failedAgents > 0 ? `, ${view.failedAgents} failed` : '') +
    (view.stoppedAgents > 0 ? `, ${view.stoppedAgents} stopped` : '') +
    (denominator > 0 ? ` (${finished}/${denominator} finished)` : '');
  lines.push(`<agents>${agentSummary}</agents>`);
  if (view.activeAgents.length > 0) {
    lines.push(`<running_agents>${escapeXmlContent(view.activeAgents.join(', '))}</running_agents>`);
  }
  if (view.elapsedMs !== undefined) {
    lines.push(`<duration_ms>${Math.max(0, Math.floor(view.elapsedMs))}</duration_ms>`);
  }
  lines.push(
    `<note>Workflow still running — do NOT wait on it inline; its synthesized result will arrive on its own as a <task-completed task_id="${escapeXmlContent(taskId)}"> block when it finishes.</note>`,
  );
  return lines.join('\n');
}

function renderNotFound(taskId: string): string {
  return [
    `<retrieval_status>not_found</retrieval_status>`,
    `<task_id>${escapeXmlContent(taskId)}</task_id>`,
    `<error>No snapshot for task_id "${escapeXmlContent(taskId)}". The task may never have been dispatched, or it settled long enough ago that its snapshot was evicted under the per-runner cap (see CHILD_PROGRESS_SNAPSHOT_CAP).</error>`,
  ].join('\n');
}

function renderSnapshot(
  snap: ChildProgressSnapshot,
  retrievalStatus: TaskOutputRetrievalStatus,
): string {
  const now = Date.now();
  const referenceEnd = snap.endedAt ?? now;
  const duration = Math.max(0, referenceEnd - snap.startedAt);

  const lines: string[] = [
    `<retrieval_status>${retrievalStatus}</retrieval_status>`,
    `<task_id>${escapeXmlContent(snap.childId)}</task_id>`,
    `<status>${snap.status}</status>`,
    `<iterations>${snap.iterations}/${snap.maxIterations}</iterations>`,
    `<duration_ms>${duration}</duration_ms>`,
  ];

  if (retrievalStatus === 'wait_expired') {
    lines.push(
      '<note>The bounded read window expired. The child task has not timed out — read the `status` field above to decide whether it is still running.</note>',
    );
  }

  if (snap.recentToolCalls.length > 0) {
    lines.push(`<recent_tool_calls>`);
    for (const call of snap.recentToolCalls) {
      lines.push(`  ${formatBreadcrumb(call)}`);
    }
    lines.push(`</recent_tool_calls>`);
  } else if (snap.status === 'running') {
    // Empty during the brief window after dispatch + before the first
    // child tool call lands. Explicit marker so the LLM doesn't read
    // "no recent_tool_calls block" as "child crashed".
    lines.push(`<recent_tool_calls>(no tool calls yet — child has not started executing)</recent_tool_calls>`);
  }

  if (snap.status !== 'running' && snap.finalText !== undefined) {
    const body = tailToBytes(snap.finalText, OUTPUT_TAIL_BYTES);
    const tag = snap.status === 'completed' ? 'output' : 'error';
    lines.push(`<${tag}>`);
    lines.push(body);
    lines.push(`</${tag}>`);
  }

  return lines.join('\n');
}

type TaskOutputRetrievalStatus = 'success' | 'wait_expired' | 'not_found';

function formatBreadcrumb(call: ChildToolCallBreadcrumb): string {
  const hint = call.inputHint ? ` ${call.inputHint}` : '';
  return `[iter ${call.iteration}] ${call.toolName}${hint}`;
}

/**
 * Byte-aware tail. Uses Buffer to handle multi-byte chars cleanly.
 * Returns the LAST `maxBytes` bytes (claudecode-style), prefixed with
 * a truncation marker when shortened. Mid-codepoint slicing is
 * mitigated by skipping leading continuation bytes after the cut.
 */
function tailToBytes(content: string, maxBytes: number): string {
  const buf = Buffer.from(content, 'utf8');
  if (buf.byteLength <= maxBytes) {
    return content;
  }
  let start = buf.byteLength - maxBytes;
  // Skip any UTF-8 continuation bytes (10xxxxxx) at the cut so we don't
  // start mid-codepoint. The lead byte of a multi-byte sequence has
  // bits 11xx_xxxx, continuation bytes are 10xx_xxxx — bumping `start`
  // until the byte is NOT a continuation byte gives us a safe boundary.
  while (start < buf.byteLength && (buf[start] & 0b1100_0000) === 0b1000_0000) {
    start++;
  }
  const tail = buf.subarray(start).toString('utf8');
  return `[...truncated to last ${maxBytes} bytes...]\n${tail}`;
}

function escapeXmlContent(value: string): string {
  // Remote task text and metadata are untrusted; escaping prevents them
  // from closing the structured tool-result envelope.
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
