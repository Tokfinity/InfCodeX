/**
 * Unit tests for `toolTaskOutput` (FEATURE_177 v0.7.45).
 *
 * Covers:
 *   - rejects missing/empty task_id
 *   - rejects when childProgressSnapshots is unavailable (sync-mode)
 *   - returns not_found envelope when task_id has no snapshot
 *   - running snapshot returns envelope with `<recent_tool_calls>` and no
 *     `<output>` block
 *   - empty running snapshot includes the explicit "no tool calls yet" marker
 *   - completed snapshot returns envelope with `<output>` (not `<error>`)
 *   - failed snapshot returns envelope with `<error>` (not `<output>`)
 *   - aborted snapshot routes to `<error>` (status is aborted, finalText is
 *     the crash envelope)
 *   - block:true with already-settled registry entry returns immediately
 *     with retrieval_status=success
 *   - block:true with in-flight unsettling promise + small timeout returns
 *     retrieval_status=wait_expired
 *   - block:true with no registry entry (e.g. settled & cleaned) falls
 *     through to read snapshot, retrievalStatus=success
 *   - terminal output remains complete for the shared outer capacity owner
 *   - live external output is an explicitly labelled bounded tail
 *   - pin: tool name is in CHILD_EXCLUDE_TOOLS_BASE and PLANNER_EXTRA_EXCLUDE
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _resetMessageQueueForTests,
  getMessageQueue,
  type AgentTaskSnapshot,
  type ChildTaskRegistry,
} from '@kodax-ai/agent';

import type { KodaXChildExecutionResult, KodaXToolExecutionContext } from '../types.js';

import { CHILD_EXCLUDE_TOOLS_BASE } from '../child-executor.js';
import {
  initChildSnapshot,
  applyChildSnapshotEvent,
  finalizeChildSnapshot,
  type ChildProgressSnapshot,
} from '../child-progress-snapshot.js';

import { toolTaskOutput } from './task-output.js';
import { getToolDefinition } from './registry.js';

function makeCtx(
  overrides: Partial<KodaXToolExecutionContext> = {},
): KodaXToolExecutionContext {
  return {
    gitRoot: '/tmp/repo',
    executionCwd: '/tmp/repo',
    childProgressSnapshots: new Map<string, ChildProgressSnapshot>(),
    ...overrides,
  } as KodaXToolExecutionContext;
}

describe('toolTaskOutput — input validation', () => {
  it('rejects missing task_id', async () => {
    const ctx = makeCtx();
    const out = await toolTaskOutput({}, ctx);
    expect(out).toMatch(/Missing required parameter: task_id/);
  });

  it('rejects empty task_id', async () => {
    const ctx = makeCtx();
    const out = await toolTaskOutput({ task_id: '  ' }, ctx);
    expect(out).toMatch(/Missing required parameter: task_id/);
  });

  it('rejects when childProgressSnapshots is undefined (sync-mode ctx)', async () => {
    const ctx = makeCtx({ childProgressSnapshots: undefined });
    const out = await toolTaskOutput({ task_id: 'c1' }, ctx);
    expect(out).toMatch(/Async dispatch is disabled/);
  });
});

describe('toolTaskOutput — schema wording', () => {
  it('describes block timeout as a read-window expiry, not child failure', () => {
    const def = getToolDefinition('task_output');
    const schema = def?.input_schema as {
      properties?: Record<string, { description?: string }>;
    } | undefined;
    const visibleText = [
      def?.description ?? '',
      schema?.properties?.block?.description ?? '',
      schema?.properties?.timeout_ms?.description ?? '',
    ].join('\n');

    expect(visibleText).toContain('Normal Worker usage');
    expect(visibleText).toContain('retrieval_status=wait_expired');
    expect(visibleText).toContain('not a child task timeout');
    expect(visibleText).toContain('Terminal output is emitted in full');
    expect(visibleText).toContain('output_state');
    expect(visibleText).not.toContain('retrieval_status=timeout');
  });
});

describe('toolTaskOutput — not_found path', () => {
  it('returns not_found envelope when no snapshot exists', async () => {
    const ctx = makeCtx();
    const out = await toolTaskOutput({ task_id: 'never-dispatched' }, ctx);
    expect(out).toMatch(/<retrieval_status>not_found<\/retrieval_status>/);
    expect(out).toMatch(/<task_id>never-dispatched<\/task_id>/);
    expect(out).toMatch(/<error>No snapshot for task_id/);
  });
});

describe('toolTaskOutput — workflow run-level progress (gap A)', () => {
  const progressView = {
    status: 'running' as const,
    workflowName: 'parity-audit',
    phase: 'Audit',
    phaseIndex: 1,
    phaseTotal: 2,
    activeAgents: ['structured-channel', 'concurrency-caps'],
    completedAgents: 5,
    failedAgents: 1,
    stoppedAgents: 0,
    totalSpawned: 8,
    plannedAgents: 8,
    elapsedMs: 80_000,
  };

  it('renders a running background workflow as workflow-shaped progress, not not_found', async () => {
    const ctx = makeCtx({
      workflowRunProgress: new Map([['run-1', () => progressView]]),
    });
    const out = await toolTaskOutput({ task_id: 'run-1' }, ctx);
    expect(out).toContain('<retrieval_status>success</retrieval_status>');
    expect(out).toContain('<kind>workflow</kind>');
    expect(out).toContain('<workflow>parity-audit</workflow>');
    expect(out).toContain('<status>running</status>');
    expect(out).toContain('<phase>1/2 Audit</phase>');
    expect(out).toContain('2 running, 5 completed, 1 failed (6/8 finished)');
    expect(out).toContain('<running_agents>structured-channel, concurrency-caps</running_agents>');
    expect(out).toContain('<task-completed task_id="run-1">');
    expect(out).not.toContain('not_found');
  });

  it('falls back to not_found once the run has settled (getter removed)', async () => {
    // After settle, run-workflow deletes the entry; a per-child snapshot was never
    // written under the runId, so a late peek is not_found (the synthesis already
    // arrived via <task-completed>).
    const ctx = makeCtx({ workflowRunProgress: new Map() });
    const out = await toolTaskOutput({ task_id: 'run-1' }, ctx);
    expect(out).toContain('<retrieval_status>not_found</retrieval_status>');
  });
});

describe('toolTaskOutput — running snapshot', () => {
  it('returns success envelope with iterations + recent_tool_calls', async () => {
    const snapshots = new Map<string, ChildProgressSnapshot>();
    initChildSnapshot(snapshots, {
      childId: 'c1',
      startedAt: Date.now() - 1500,
      maxIterations: 200,
    });
    applyChildSnapshotEvent(snapshots, 'c1', {
      kind: 'iteration',
      iteration: 3,
      maxIterations: 200,
    });
    applyChildSnapshotEvent(snapshots, 'c1', {
      kind: 'tool-start',
      iteration: 3,
      toolName: 'read',
      inputHint: 'src/foo.ts',
      startedAt: Date.now() - 500,
    });
    applyChildSnapshotEvent(snapshots, 'c1', {
      kind: 'tool-start',
      iteration: 4,
      toolName: 'grep',
      inputHint: 'handleAuth',
      startedAt: Date.now() - 200,
    });

    const ctx = makeCtx({ childProgressSnapshots: snapshots });
    const out = await toolTaskOutput({ task_id: 'c1' }, ctx);
    expect(out).toMatch(/<retrieval_status>success<\/retrieval_status>/);
    expect(out).toMatch(/<task_id>c1<\/task_id>/);
    expect(out).toMatch(/<status>running<\/status>/);
    expect(out).toMatch(/<iterations>3\/200<\/iterations>/);
    expect(out).toMatch(/<recent_tool_calls>/);
    expect(out).toContain('<output_state>pending</output_state>');
    expect(out).toMatch(/\[iter 3\] read src\/foo\.ts/);
    expect(out).toMatch(/\[iter 4\] grep handleAuth/);
    // No <output>/<error> blocks while running.
    expect(out).not.toMatch(/<output>/);
    expect(out).not.toMatch(/<error>/);
  });

  it('emits "no tool calls yet" marker when running with empty breadcrumbs', async () => {
    const snapshots = new Map<string, ChildProgressSnapshot>();
    initChildSnapshot(snapshots, {
      childId: 'c1',
      startedAt: Date.now() - 50,
      maxIterations: 100,
    });
    const ctx = makeCtx({ childProgressSnapshots: snapshots });
    const out = await toolTaskOutput({ task_id: 'c1' }, ctx);
    expect(out).toMatch(/no tool calls yet/);
    expect(out).toMatch(/<status>running<\/status>/);
  });
});

describe('toolTaskOutput — terminal snapshots', () => {
  it('completed → <output> with finalText (no <error>)', async () => {
    const snapshots = new Map<string, ChildProgressSnapshot>();
    initChildSnapshot(snapshots, {
      childId: 'c1',
      startedAt: 1000,
      maxIterations: 200,
    });
    finalizeChildSnapshot(snapshots, 'c1', {
      status: 'completed',
      finalText: 'All findings checked. Auth path is clean.',
      endedAt: 5000,
    });
    const ctx = makeCtx({ childProgressSnapshots: snapshots });
    const out = await toolTaskOutput({ task_id: 'c1' }, ctx);
    expect(out).toMatch(/<status>completed<\/status>/);
    expect(out).toContain('<output_state>complete</output_state>');
    expect(out).toMatch(/<output>\nAll findings checked\. Auth path is clean\.\n<\/output>/);
    expect(out).not.toMatch(/<error>/);
    expect(out).toMatch(/<duration_ms>4000<\/duration_ms>/);
  });

  it('failed → <error> with finalText (no <output>)', async () => {
    const snapshots = new Map<string, ChildProgressSnapshot>();
    initChildSnapshot(snapshots, {
      childId: 'c2',
      startedAt: 1000,
      maxIterations: 200,
    });
    finalizeChildSnapshot(snapshots, 'c2', {
      status: 'failed',
      finalText: 'status=failed mode=silent-drop iterations=0 results=0',
      endedAt: 3000,
    });
    const ctx = makeCtx({ childProgressSnapshots: snapshots });
    const out = await toolTaskOutput({ task_id: 'c2' }, ctx);
    expect(out).toMatch(/<status>failed<\/status>/);
    expect(out).toMatch(/<error>\nstatus=failed mode=silent-drop/);
    expect(out).not.toMatch(/<output>/);
  });

  it('aborted → <error> with crash envelope', async () => {
    const snapshots = new Map<string, ChildProgressSnapshot>();
    initChildSnapshot(snapshots, {
      childId: 'c3',
      startedAt: 1000,
      maxIterations: 200,
    });
    finalizeChildSnapshot(snapshots, 'c3', {
      status: 'aborted',
      finalText: 'crash: aborted by task_stop',
      endedAt: 4000,
    });
    const ctx = makeCtx({ childProgressSnapshots: snapshots });
    const out = await toolTaskOutput({ task_id: 'c3' }, ctx);
    expect(out).toMatch(/<status>aborted<\/status>/);
    expect(out).toMatch(/<error>\ncrash: aborted by task_stop\n<\/error>/);
  });

  it('completed without finalText still emits the status envelope (no <output>)', async () => {
    const snapshots = new Map<string, ChildProgressSnapshot>();
    initChildSnapshot(snapshots, {
      childId: 'c1',
      startedAt: 1000,
      maxIterations: 200,
    });
    finalizeChildSnapshot(snapshots, 'c1', {
      status: 'completed',
      endedAt: 5000,
    });
    const ctx = makeCtx({ childProgressSnapshots: snapshots });
    const out = await toolTaskOutput({ task_id: 'c1' }, ctx);
    expect(out).toMatch(/<status>completed<\/status>/);
    expect(out).not.toMatch(/<output>/);
  });
});

describe('toolTaskOutput — block parameter', () => {
  it('block:true with already-settled registry entry returns immediately (success)', async () => {
    const snapshots = new Map<string, ChildProgressSnapshot>();
    initChildSnapshot(snapshots, {
      childId: 'c1',
      startedAt: 1000,
      maxIterations: 200,
    });
    finalizeChildSnapshot(snapshots, 'c1', {
      status: 'completed',
      finalText: 'done',
      endedAt: 2000,
    });
    const registry: ChildTaskRegistry<KodaXChildExecutionResult> = new Map();
    // An already-resolved promise — Promise.race resolves to it in one tick.
    registry.set('c1', Promise.resolve({
      results: [],
      mergedFindings: [],
      mergedArtifacts: [],
      totalTokensUsed: 0,
      cancelledChildren: [],
    } as KodaXChildExecutionResult));

    const ctx = makeCtx({
      childProgressSnapshots: snapshots,
      childTaskRegistry: registry,
    });
    const out = await toolTaskOutput(
      { task_id: 'c1', block: true, timeout_ms: 1000 },
      ctx,
    );
    expect(out).toMatch(/<retrieval_status>success<\/retrieval_status>/);
    expect(out).toMatch(/<status>completed<\/status>/);
  });

  it('block:true with in-flight unsettling promise + short timeout returns wait_expired', async () => {
    const snapshots = new Map<string, ChildProgressSnapshot>();
    initChildSnapshot(snapshots, {
      childId: 'c1',
      startedAt: Date.now() - 100,
      maxIterations: 200,
    });
    const registry: ChildTaskRegistry<KodaXChildExecutionResult> = new Map();
    registry.set('c1', new Promise<KodaXChildExecutionResult>(() => {})); // never settles

    const ctx = makeCtx({
      childProgressSnapshots: snapshots,
      childTaskRegistry: registry,
    });
    const out = await toolTaskOutput(
      { task_id: 'c1', block: true, timeout_ms: 50 },
      ctx,
    );
    expect(out).toMatch(/<retrieval_status>wait_expired<\/retrieval_status>/);
    expect(out).toMatch(/<status>running<\/status>/);
    expect(out).toContain('The child task has not timed out');
  });

  it("block:true with no registry entry (cleaned post-settle) reads snapshot as success", async () => {
    const snapshots = new Map<string, ChildProgressSnapshot>();
    initChildSnapshot(snapshots, {
      childId: 'c1',
      startedAt: 1000,
      maxIterations: 200,
    });
    finalizeChildSnapshot(snapshots, 'c1', {
      status: 'completed',
      finalText: 'done',
      endedAt: 2000,
    });
    // Registry is empty — child already settled and got cleaned up.
    const registry: ChildTaskRegistry<KodaXChildExecutionResult> = new Map();

    const ctx = makeCtx({
      childProgressSnapshots: snapshots,
      childTaskRegistry: registry,
    });
    const out = await toolTaskOutput(
      { task_id: 'c1', block: true, timeout_ms: 1000 },
      ctx,
    );
    expect(out).toMatch(/<retrieval_status>success<\/retrieval_status>/);
    expect(out).toMatch(/<status>completed<\/status>/);
  });

  it('block:true swallows promise rejection (snapshot still readable)', async () => {
    const snapshots = new Map<string, ChildProgressSnapshot>();
    initChildSnapshot(snapshots, {
      childId: 'c1',
      startedAt: 1000,
      maxIterations: 200,
    });
    finalizeChildSnapshot(snapshots, 'c1', {
      status: 'failed',
      finalText: 'crash: boom',
      endedAt: 2000,
    });
    const registry: ChildTaskRegistry<KodaXChildExecutionResult> = new Map();
    registry.set('c1', Promise.reject(new Error('boom')));

    const ctx = makeCtx({
      childProgressSnapshots: snapshots,
      childTaskRegistry: registry,
    });
    const out = await toolTaskOutput(
      { task_id: 'c1', block: true, timeout_ms: 1000 },
      ctx,
    );
    expect(out).toMatch(/<retrieval_status>success<\/retrieval_status>/);
    expect(out).toMatch(/<status>failed<\/status>/);
  });

  it('block:false (default) does not race the registry — returns snapshot AS-IS', async () => {
    const snapshots = new Map<string, ChildProgressSnapshot>();
    initChildSnapshot(snapshots, {
      childId: 'c1',
      startedAt: Date.now() - 100,
      maxIterations: 200,
    });
    const registry: ChildTaskRegistry<KodaXChildExecutionResult> = new Map();
    registry.set('c1', new Promise<KodaXChildExecutionResult>(() => {})); // never settles

    const ctx = makeCtx({
      childProgressSnapshots: snapshots,
      childTaskRegistry: registry,
    });
    // No block param → block:false → returns immediately.
    const start = Date.now();
    const out = await toolTaskOutput({ task_id: 'c1' }, ctx);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(200); // should not have waited
    expect(out).toMatch(/<retrieval_status>success<\/retrieval_status>/);
    expect(out).toMatch(/<status>running<\/status>/);
  });
});

describe('toolTaskOutput — output ownership', () => {
  it('returns complete local terminal output for the shared outer capacity owner', async () => {
    const snapshots = new Map<string, ChildProgressSnapshot>();
    initChildSnapshot(snapshots, {
      childId: 'c1',
      startedAt: 1000,
      maxIterations: 200,
    });
    // 20K of 'A' chars — well above the 8KB cap.
    const huge = 'A'.repeat(20000);
    finalizeChildSnapshot(snapshots, 'c1', {
      status: 'completed',
      finalText: huge,
      endedAt: 2000,
    });
    const ctx = makeCtx({ childProgressSnapshots: snapshots });
    const out = await toolTaskOutput({ task_id: 'c1' }, ctx);
    expect(out).toContain('<output_state>complete</output_state>');
    expect(out).not.toContain('truncated to last 8192 bytes');
    expect(out).toContain(`<output>\n${huge}\n</output>`);
  });

  it('returns small terminal output unchanged', async () => {
    const snapshots = new Map<string, ChildProgressSnapshot>();
    initChildSnapshot(snapshots, {
      childId: 'c1',
      startedAt: 1000,
      maxIterations: 200,
    });
    finalizeChildSnapshot(snapshots, 'c1', {
      status: 'completed',
      finalText: 'small body',
      endedAt: 2000,
    });
    const ctx = makeCtx({ childProgressSnapshots: snapshots });
    const out = await toolTaskOutput({ task_id: 'c1' }, ctx);
    expect(out).not.toMatch(/truncated/);
    expect(out).toContain('<output_state>complete</output_state>');
    expect(out).toMatch(/<output>\nsmall body\n<\/output>/);
  });

  it('returns complete external terminal output but labels running output as a bounded live tail', async () => {
    const huge = 'R'.repeat(20000);
    const baseTask = {
      route: 'external',
      agentId: 'external:risk',
      objective: 'Review risk',
      cancellation: 'none',
      createdAt: '2026-07-14T00:00:00.000Z',
      updatedAt: '2026-07-14T00:00:01.000Z',
    } as const;
    const tasks = new Map<string, AgentTaskSnapshot>([
      ['done', {
        ...baseTask,
        taskId: 'done',
        state: 'completed',
        output: huge,
      } as unknown as AgentTaskSnapshot],
      ['live', {
        ...baseTask,
        taskId: 'live',
        state: 'working',
        output: huge,
      } as unknown as AgentTaskSnapshot],
    ]);
    const agentExecutorPlane = {
      plane: {
        tasks: {
          get: async (taskId: string) => tasks.get(taskId),
        },
      },
    } as unknown as NonNullable<KodaXToolExecutionContext['agentExecutorPlane']>;
    const ctx = makeCtx({ agentExecutorPlane });

    const completed = await toolTaskOutput({ task_id: 'done' }, ctx);
    const running = await toolTaskOutput({ task_id: 'live' }, ctx);

    expect(completed).toContain('<output_state>complete</output_state>');
    expect(completed).toContain(huge);
    expect(completed).not.toContain('truncated to last 8192 bytes');
    expect(running).toContain('<status>running</status>');
    expect(running).toContain('<output_state>live_partial</output_state>');
    expect(running).toContain('[...truncated to last 8192 bytes...]');
    expect(running.length).toBeLessThan(huge.length);
  });
});

describe('toolTaskOutput — security contract pin', () => {
  it('task_output is in CHILD_EXCLUDE_TOOLS_BASE (children cannot peek at siblings)', () => {
    expect(CHILD_EXCLUDE_TOOLS_BASE).toContain('task_output');
  });
});

describe('toolTaskOutput - completion notification consumption', () => {
  beforeEach(() => {
    _resetMessageQueueForTests();
  });

  afterEach(() => {
    _resetMessageQueueForTests();
  });

  it('drains the matching task-completed banner after reading a terminal snapshot', async () => {
    const snapshots = new Map<string, ChildProgressSnapshot>();
    initChildSnapshot(snapshots, {
      childId: 'c1',
      startedAt: 1000,
      maxIterations: 200,
    });
    finalizeChildSnapshot(snapshots, 'c1', {
      status: 'completed',
      finalText: 'c1 final output',
      endedAt: 2000,
    });

    const queue = getMessageQueue();
    queue.enqueue({
      priority: 'background',
      mode: 'task-notification',
      content: '<task-completed task_id="c1">\nc1 final output\n</task-completed>',
    });
    queue.enqueue({
      priority: 'background',
      mode: 'task-notification',
      content: '<task-completed task_id="c2">\nc2 still unread\n</task-completed>',
    });

    const ctx = makeCtx({ childProgressSnapshots: snapshots });
    const out = await toolTaskOutput({ task_id: 'c1' }, ctx);

    expect(out).toMatch(/<status>completed<\/status>/);
    const remaining = queue.peek({
      agentId: undefined,
      maxPriority: 'background',
      mode: 'task-notification',
    });
    expect(remaining.map((message) => message.content)).toEqual([
      '<task-completed task_id="c2">\nc2 still unread\n</task-completed>',
    ]);
  });

  it('does not drain task-completed banners while the task is still running', async () => {
    const snapshots = new Map<string, ChildProgressSnapshot>();
    initChildSnapshot(snapshots, {
      childId: 'c1',
      startedAt: 1000,
      maxIterations: 200,
    });

    const queue = getMessageQueue();
    queue.enqueue({
      priority: 'background',
      mode: 'task-notification',
      content: '<task-completed task_id="c1">\nc1 pending\n</task-completed>',
    });

    const ctx = makeCtx({ childProgressSnapshots: snapshots });
    const out = await toolTaskOutput({ task_id: 'c1' }, ctx);

    expect(out).toMatch(/<status>running<\/status>/);
    expect(queue.has({
      agentId: undefined,
      maxPriority: 'background',
      mode: 'task-notification',
    })).toBe(true);
  });
});
