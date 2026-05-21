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
 *     retrieval_status=timeout
 *   - block:true with no registry entry (e.g. settled & cleaned) falls
 *     through to read snapshot, retrievalStatus=success
 *   - tail-to-bytes caps very large finalText at OUTPUT_TAIL_BYTES with
 *     the truncation marker
 *   - pin: tool name is in CHILD_EXCLUDE_TOOLS_BASE and PLANNER_EXTRA_EXCLUDE
 */

import { describe, expect, it } from 'vitest';

import type { ChildTaskRegistry } from '@kodax-ai/agent';

import type { KodaXChildExecutionResult, KodaXToolExecutionContext } from '../types.js';

import { CHILD_EXCLUDE_TOOLS_BASE } from '../child-executor.js';
import {
  initChildSnapshot,
  applyChildSnapshotEvent,
  finalizeChildSnapshot,
  type ChildProgressSnapshot,
} from '../child-progress-snapshot.js';

import { toolTaskOutput } from './task-output.js';

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

describe('toolTaskOutput — not_found path', () => {
  it('returns not_found envelope when no snapshot exists', async () => {
    const ctx = makeCtx();
    const out = await toolTaskOutput({ task_id: 'never-dispatched' }, ctx);
    expect(out).toMatch(/<retrieval_status>not_found<\/retrieval_status>/);
    expect(out).toMatch(/<task_id>never-dispatched<\/task_id>/);
    expect(out).toMatch(/<error>No snapshot for task_id/);
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

  it('block:true with in-flight unsettling promise + short timeout returns timeout', async () => {
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
    expect(out).toMatch(/<retrieval_status>timeout<\/retrieval_status>/);
    expect(out).toMatch(/<status>running<\/status>/);
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

describe('toolTaskOutput — tail-to-bytes', () => {
  it('caps very large finalText at OUTPUT_TAIL_BYTES with truncation marker', async () => {
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
    expect(out).toMatch(/\[\.\.\.truncated to last 8192 bytes\.\.\.\]/);
    // Sanity: the entire response should be much smaller than the input.
    expect(out.length).toBeLessThan(huge.length);
  });

  it('does NOT truncate finalText that fits within the cap', async () => {
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
    expect(out).toMatch(/<output>\nsmall body\n<\/output>/);
  });
});

describe('toolTaskOutput — security contract pin', () => {
  it('task_output is in CHILD_EXCLUDE_TOOLS_BASE (children cannot peek at siblings)', () => {
    expect(CHILD_EXCLUDE_TOOLS_BASE).toContain('task_output');
  });
});
