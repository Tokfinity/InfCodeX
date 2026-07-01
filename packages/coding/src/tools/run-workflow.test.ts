import { describe, expect, it } from 'vitest';
import { getMessageQueue } from '@kodax-ai/agent';

import { toolRunWorkflow } from './run-workflow.js';
import type { KodaXToolExecutionContext, WorkflowToolHost, WorkflowToolHostResult } from '../types.js';

function ctxWith(host: WorkflowToolHost | undefined): KodaXToolExecutionContext {
  return { workflowHost: host } as unknown as KodaXToolExecutionContext;
}

function recordingHost(
  result: WorkflowToolHostResult | (() => Promise<WorkflowToolHostResult>),
): { host: WorkflowToolHost; calls: Array<{ manifest: unknown; source: string; args?: unknown }> } {
  const calls: Array<{ manifest: unknown; source: string; args?: unknown }> = [];
  const resolve = async (): Promise<WorkflowToolHostResult> =>
    typeof result === 'function' ? result() : result;
  const host: WorkflowToolHost = {
    // Interface-complete startInline (mirrors runInline) so the mock satisfies
    // WorkflowToolHost and stays usable if a test ever wires a childTaskRegistry.
    startInline: async (input) => {
      calls.push(input);
      const r = await resolve();
      if (r.kind === 'declined') {
        return r.reason !== undefined ? { kind: 'declined', reason: r.reason } : { kind: 'declined' };
      }
      return { kind: 'started', runId: r.runId, done: Promise.resolve(r) };
    },
    runInline: async (input) => {
      calls.push(input);
      return resolve();
    },
  };
  return { host, calls };
}

const MANIFEST = { name: 'wf', description: 'd', phases: ['p'], readOnly: true, maxAgents: 4, maxConcurrency: 2, patterns: ['fan-out-and-synthesize'] };
const SOURCE = 'async function run(wf, args) { return { synthesis: "ok" }; }';

describe('toolRunWorkflow', () => {
  it('fails closed when the workflow host is not wired', async () => {
    const out = await toolRunWorkflow({ manifest: MANIFEST, source: SOURCE }, ctxWith(undefined));
    expect(String(out)).toContain('[Tool Error]');
    expect(String(out)).toContain('unavailable');
  });

  it('rejects a missing/empty source', async () => {
    const { host } = recordingHost({ kind: 'started', runId: 'r', status: 'completed', resultText: 'x' });
    const out = await toolRunWorkflow({ manifest: MANIFEST }, ctxWith(host));
    expect(String(out)).toContain('`source`');
  });

  it('rejects a non-object manifest', async () => {
    const { host } = recordingHost({ kind: 'started', runId: 'r', status: 'completed', resultText: 'x' });
    const out = await toolRunWorkflow({ manifest: 'nope', source: SOURCE }, ctxWith(host));
    expect(String(out)).toContain('`manifest`');
  });

  it('passes manifest/source/args through to the host', async () => {
    const { host, calls } = recordingHost({ kind: 'started', runId: 'r1', status: 'completed', resultText: 'done' });
    await toolRunWorkflow({ manifest: MANIFEST, source: SOURCE, args: { request: 'go' } }, ctxWith(host));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.manifest).toBe(MANIFEST);
    expect(calls[0]?.source).toBe(SOURCE);
    expect(calls[0]?.args).toEqual({ request: 'go' });
  });

  it('returns the result text on completion', async () => {
    const { host } = recordingHost({ kind: 'started', runId: 'r1', status: 'completed', resultText: 'the synthesized answer' });
    const out = await toolRunWorkflow({ manifest: MANIFEST, source: SOURCE }, ctxWith(host));
    expect(out).toBe('the synthesized answer');
  });

  it('prefixes a completed run that has verification warnings', async () => {
    // The overall run settles `completed` even when a child agent fails its
    // sidecar verifier in warn-only mode; the host reports those via
    // `verificationWarnings` and the tool reply must flag them.
    const { host } = recordingHost({
      kind: 'started',
      runId: 'r1',
      status: 'completed',
      resultText: 'answer',
      verificationWarnings: ['reviewer', 'auditor'],
    });
    const out = await toolRunWorkflow({ manifest: MANIFEST, source: SOURCE }, ctxWith(host));
    expect(String(out)).toContain('failed verification');
    expect(String(out)).toContain('reviewer');
    expect(String(out)).toContain('answer');
  });

  it('surfaces a declined workflow without erroring', async () => {
    const { host } = recordingHost({ kind: 'declined', reason: 'too simple for a workflow' });
    const out = await toolRunWorkflow({ manifest: MANIFEST, source: SOURCE }, ctxWith(host));
    expect(out).toBe('Workflow not started: too simple for a workflow');
  });

  it('surfaces a failed run as a tool error with detail', async () => {
    const { host } = recordingHost({ kind: 'started', runId: 'r1', status: 'failed', error: 'child crashed' });
    const out = await toolRunWorkflow({ manifest: MANIFEST, source: SOURCE }, ctxWith(host));
    expect(String(out)).toContain('[Tool Error]');
    expect(String(out)).toContain('child crashed');
  });

  it('catches a thrown host (e.g. malformed script) as a tool error', async () => {
    const { host } = recordingHost(async () => {
      throw new Error('workflow manifest maxAgents must be a positive integer');
    });
    const out = await toolRunWorkflow({ manifest: { name: 'bad' }, source: SOURCE }, ctxWith(host));
    expect(String(out)).toContain('[Tool Error] run_workflow failed');
    expect(String(out)).toContain('maxAgents');
  });
});

describe('toolRunWorkflow — async / idle-yield path (ADR-049)', () => {
  function asyncCtx(done: Promise<WorkflowToolHostResult>, runId: string): {
    ctx: KodaXToolExecutionContext;
    registry: Map<string, Promise<unknown>>;
  } {
    const registry = new Map<string, Promise<unknown>>();
    const host: WorkflowToolHost = {
      runInline: async () => {
        throw new Error('async path must not call the blocking runInline');
      },
      startInline: async () => ({ kind: 'started', runId, done }),
    };
    const ctx = { workflowHost: host, childTaskRegistry: registry } as unknown as KodaXToolExecutionContext;
    return { ctx, registry };
  }

  it('returns immediately with a task_id + idle-yield instruction and registers in the registry (does NOT block on the run)', async () => {
    let resolveDone!: (r: WorkflowToolHostResult) => void;
    const done = new Promise<WorkflowToolHostResult>((res) => { resolveDone = res; });
    const { ctx, registry } = asyncCtx(done, 'run-async-1');

    // Returns while `done` is still pending → it did not block on the workflow.
    const out = await toolRunWorkflow({ manifest: MANIFEST, source: SOURCE }, ctx);
    expect(String(out)).toContain('task_id:run-async-1');
    expect(String(out)).toContain('<task-completed task_id="run-async-1"');
    expect(String(out).toLowerCase()).toContain('idle-yield');
    expect(registry.has('run-async-1')).toBe(true);

    // Settle the workflow → the registered promise resolves, the synthesis is enqueued
    // as a <task-completed> notification, and registerChildTask cleans up the entry.
    resolveDone({ kind: 'started', runId: 'run-async-1', status: 'completed', resultText: 'ASYNC SYNTH' });
    await registry.get('run-async-1')?.catch(() => {});
    await new Promise((r) => setTimeout(r, 0));
    expect(registry.has('run-async-1')).toBe(false);

    const banner = getMessageQueue()
      .dequeue({ maxPriority: 'background' })
      .map((m) => m.content)
      .join('\n');
    expect(banner).toContain('run-async-1');
    expect(banner).toContain('ASYNC SYNTH');
  });

  it('falls back to blocking runInline when no childTaskRegistry is wired (SDK/headless)', async () => {
    const { host } = recordingHost({ kind: 'started', runId: 'r', status: 'completed', resultText: 'BLOCKING SYNTH' });
    const out = await toolRunWorkflow({ manifest: MANIFEST, source: SOURCE }, ctxWith(host));
    expect(out).toBe('BLOCKING SYNTH');
  });

  it('falls back to blocking on a run-id collision and does NOT register/notify a second time', async () => {
    const done = Promise.resolve<WorkflowToolHostResult>({
      kind: 'started', runId: 'run-async-1', status: 'completed', resultText: 'COLLISION SYNTH',
    });
    const { ctx, registry } = asyncCtx(done, 'run-async-1');
    // An in-flight task already holds this run id (simulated same-ms collision).
    const inflight = new Promise<unknown>(() => {});
    registry.set('run-async-1', inflight);

    const out = await toolRunWorkflow({ manifest: MANIFEST, source: SOURCE }, ctx);
    // Blocking fallback: returns the synthesis text, NOT an idle-yield task_id message,
    // and leaves the pre-existing registry entry untouched (no orphaned settle pump).
    expect(out).toBe('COLLISION SYNTH');
    expect(String(out)).not.toContain('task_id:');
    expect(registry.get('run-async-1')).toBe(inflight);
  });

  it('registers a run-level progress getter so task_output(runId) can peek while running (gap A)', async () => {
    let resolveDone!: (r: WorkflowToolHostResult) => void;
    const done = new Promise<WorkflowToolHostResult>((res) => { resolveDone = res; });
    const progress = {
      status: 'running' as const,
      workflowName: 'wf',
      activeAgents: ['a1'],
      completedAgents: 0,
      failedAgents: 0,
      stoppedAgents: 0,
      totalSpawned: 1,
    };
    const host: WorkflowToolHost = {
      runInline: async () => { throw new Error('async path must not call runInline'); },
      startInline: async () => ({ kind: 'started', runId: 'run-peek-1', done, getProgress: () => progress }),
    };
    const workflowRunProgress = new Map<string, () => unknown>();
    const ctx = {
      workflowHost: host,
      childTaskRegistry: new Map(),
      workflowRunProgress,
    } as unknown as KodaXToolExecutionContext;

    await toolRunWorkflow({ manifest: MANIFEST, source: SOURCE }, ctx);
    // While running, the getter is registered and returns the live view.
    expect(workflowRunProgress.has('run-peek-1')).toBe(true);
    expect(workflowRunProgress.get('run-peek-1')?.()).toEqual(progress);

    // On settle the getter is removed (a late peek is then not_found).
    resolveDone({ kind: 'started', runId: 'run-peek-1', status: 'completed', resultText: 'x' });
    await new Promise((r) => setTimeout(r, 0));
    expect(workflowRunProgress.has('run-peek-1')).toBe(false);
  });

  it('registers a stop handle under the task id so task_stop can abort the running workflow', async () => {
    let capturedSignal: AbortSignal | undefined;
    let resolveDone!: (r: WorkflowToolHostResult) => void;
    const done = new Promise<WorkflowToolHostResult>((res) => { resolveDone = res; });
    const host: WorkflowToolHost = {
      runInline: async () => { throw new Error('async path must not call runInline'); },
      startInline: async (input) => {
        capturedSignal = input.signal;
        return { kind: 'started', runId: 'run-stop-1', done };
      },
    };
    const childAbortControllers = new Map<string, AbortController>();
    const ctx = {
      workflowHost: host,
      childTaskRegistry: new Map(),
      childAbortControllers,
    } as unknown as KodaXToolExecutionContext;

    const out = await toolRunWorkflow({ manifest: MANIFEST, source: SOURCE }, ctx);
    expect(String(out)).toContain('task_id:run-stop-1');
    expect(String(out)).toContain('task_stop');
    // the workflow got a per-run signal, and a stop handle is registered under the id
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(childAbortControllers.has('run-stop-1')).toBe(true);

    // task_stop aborting the registered controller fires the workflow's signal
    expect(capturedSignal!.aborted).toBe(false);
    childAbortControllers.get('run-stop-1')!.abort('goal changed');
    expect(capturedSignal!.aborted).toBe(true);

    // the stop handle is cleaned up when the run settles
    resolveDone({ kind: 'started', runId: 'run-stop-1', status: 'stopped' });
    await new Promise((r) => setTimeout(r, 0));
    expect(childAbortControllers.has('run-stop-1')).toBe(false);
  });
});
