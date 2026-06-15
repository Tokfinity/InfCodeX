/**
 * FEATURE_217 (v0.7.49) Phase B — Coding workflow backend tests.
 *
 * Injects a fake `runChild` + minimal ctx + fake queue so no real child
 * agents run. Validates spawn → wait mapping, snapshot output, graceful
 * stop (abort), MessageQueue send routing, and synthesize.
 */

import { describe, expect, it } from 'vitest';

import type { MessageQueue } from '@kodax-ai/agent';

import {
  createCodingWorkflowBackend,
  type WorkflowChildOptions,
} from './agent-adapter.js';
import type {
  KodaXChildAgentResult,
  KodaXChildExecutionResult,
  KodaXToolExecutionContext,
} from '../types.js';

function execResult(
  over: Partial<KodaXChildAgentResult> = {},
  extra: Partial<KodaXChildExecutionResult> = {},
): KodaXChildExecutionResult {
  const child: KodaXChildAgentResult = {
    childId: 'c',
    fanoutClass: 'evidence-scan',
    status: 'completed',
    disposition: 'valid',
    summary: 'the answer',
    evidenceRefs: [],
    contradictions: [],
    ...over,
  };
  return {
    results: [child],
    mergedFindings: [],
    mergedArtifacts: [],
    totalTokensUsed: 0,
    cancelledChildren: [],
    ...extra,
  };
}

function fakeCtx(): KodaXToolExecutionContext {
  return {
    childAbortControllers: new Map<string, AbortController>(),
    childProgressSnapshots: new Map(),
  } as unknown as KodaXToolExecutionContext;
}

function fakeQueue(): {
  queue: MessageQueue;
  enqueued: Array<{ agentId?: string; content: string; priority: string; mode: string }>;
} {
  const enqueued: Array<{ agentId?: string; content: string; priority: string; mode: string }> = [];
  const queue = {
    enqueue: (input: { agentId?: string; content: string; priority: string; mode: string }) => {
      enqueued.push(input);
      return 'msg-1';
    },
  } as unknown as MessageQueue;
  return { queue, enqueued };
}

const childOptions: WorkflowChildOptions = {
  maxIterationsPerChild: 50,
  parentRole: 'worker',
  parentHarness: 'workflow',
  parentOptions: {},
};

describe('createCodingWorkflowBackend — spawn + wait', () => {
  it('spawns and maps a completed child result', async () => {
    const ctx = fakeCtx();
    const backend = createCodingWorkflowBackend({
      ctx,
      childOptions,
      runChild: async () => execResult({ status: 'completed', summary: 'found 3 bugs' }),
      generateId: () => 'task-x',
    });
    const handle = await backend.spawn({ name: 'security', prompt: 'audit' });
    expect(handle).toEqual({ taskId: 'task-x', name: 'security' });
    const result = await backend.wait(handle.taskId);
    expect(result.status).toBe('completed');
    expect(result.finalText).toBe('found 3 bugs');
    expect(result.name).toBe('security');
  });

  it('maps a failed child to status=failed', async () => {
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      runChild: async () => execResult({ status: 'failed', summary: '[Crash] boom' }),
    });
    const handle = await backend.spawn({ name: 'a', prompt: 'x' });
    expect((await backend.wait(handle.taskId)).status).toBe('failed');
  });

  it('maps a cancelled child to status=stopped', async () => {
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      runChild: async () => execResult({}, { cancelledChildren: ['task-c'] }),
      generateId: () => 'task-c',
    });
    const handle = await backend.spawn({ name: 'a', prompt: 'x' });
    expect((await backend.wait(handle.taskId)).status).toBe('stopped');
  });

  it('honors wait timeout and aborts the in-flight child', async () => {
    const ctx = fakeCtx();
    let seenSignal: AbortSignal | undefined;
    const backend = createCodingWorkflowBackend({
      ctx,
      childOptions,
      generateId: () => 'task-timeout',
      runChild: (_bundles, _ctx, opts) => {
        seenSignal = opts.abortSignal;
        return new Promise<KodaXChildExecutionResult>(() => {});
      },
    });

    const handle = await backend.spawn({ name: 'slow', prompt: 'x' });

    await expect(backend.wait(handle.taskId, { timeoutMs: 5 })).rejects.toThrow(
      /timed out after 5ms/,
    );
    expect(seenSignal?.aborted).toBe(true);
  });

  it('passes readOnly + specialist + modelHint + isolation into the bundle', async () => {
    let seenBundle:
      | {
          readOnly: boolean;
          specialistName?: string;
          modelHint?: string;
          isolation?: string;
          objective: string;
        }
      | undefined;
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      runChild: async (bundles) => {
        const b = bundles[0]!;
        seenBundle = {
          readOnly: b.readOnly,
          specialistName: b.specialistName,
          modelHint: b.modelHint,
          isolation: b.isolation,
          objective: b.objective,
        };
        return execResult();
      },
    });
    const h = await backend.spawn({
      name: 'r', prompt: 'review sql', readOnly: true, subagentType: 'db-reviewer', modelHint: 'deep', isolation: 'worktree',
    });
    await backend.wait(h.taskId);
    expect(seenBundle).toEqual({
      readOnly: true,
      specialistName: 'db-reviewer',
      modelHint: 'deep',
      isolation: 'worktree',
      objective: 'review sql',
    });
  });
});

describe('createCodingWorkflowBackend — output snapshot', () => {
  it('reports running before completion and completed after', async () => {
    const ctx = fakeCtx();
    let release: (r: KodaXChildExecutionResult) => void = () => {};
    const backend = createCodingWorkflowBackend({
      ctx,
      childOptions,
      generateId: () => 'task-o',
      runChild: () => new Promise<KodaXChildExecutionResult>((r) => { release = r; }),
    });
    const handle = await backend.spawn({ name: 'a', prompt: 'x' });
    const mid = await backend.output(handle.taskId);
    expect(mid.status).toBe('running');

    release(execResult({ status: 'completed', summary: 'done text' }));
    await backend.wait(handle.taskId);
    const final = await backend.output(handle.taskId);
    expect(final.status).toBe('completed');
    expect(final.lastText).toBe('done text');
  });
});

describe('createCodingWorkflowBackend — stop + send', () => {
  it('stop aborts the in-flight child signal', async () => {
    const ctx = fakeCtx();
    let seenSignal: AbortSignal | undefined;
    let release: (r: KodaXChildExecutionResult) => void = () => {};
    const backend = createCodingWorkflowBackend({
      ctx,
      childOptions,
      generateId: () => 'task-s',
      runChild: (_b, _c, opts) => {
        seenSignal = opts.abortSignal;
        return new Promise<KodaXChildExecutionResult>((r) => { release = r; });
      },
    });
    const handle = await backend.spawn({ name: 'a', prompt: 'x' });
    await backend.stop(handle.taskId, 'user cancel');
    expect(seenSignal?.aborted).toBe(true);
    release(execResult());
    await backend.wait(handle.taskId);
  });

  it('send routes a user-priority prompt to the child via the queue', async () => {
    const { queue, enqueued } = fakeQueue();
    let release: (r: KodaXChildExecutionResult) => void = () => {};
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      queue,
      generateId: () => 'task-m',
      runChild: () => new Promise<KodaXChildExecutionResult>((r) => { release = r; }),
    });
    const handle = await backend.spawn({ name: 'a', prompt: 'x' });
    await backend.send(handle.taskId, 'keep going');
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({ agentId: 'task-m', content: 'keep going', priority: 'user', mode: 'prompt' });
    release(execResult());
    await backend.wait(handle.taskId);
  });
});

// `synthesize` is no longer a backend method — it runs as a gated agent in
// the runtime (see runtime.test.ts + parallel-investigation.test.ts).
