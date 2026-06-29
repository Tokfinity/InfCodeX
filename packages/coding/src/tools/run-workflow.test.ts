import { describe, expect, it } from 'vitest';

import { toolRunWorkflow } from './run-workflow.js';
import type { KodaXToolExecutionContext, WorkflowToolHost, WorkflowToolHostResult } from '../types.js';

function ctxWith(host: WorkflowToolHost | undefined): KodaXToolExecutionContext {
  return { workflowHost: host } as unknown as KodaXToolExecutionContext;
}

function recordingHost(
  result: WorkflowToolHostResult | (() => Promise<WorkflowToolHostResult>),
): { host: WorkflowToolHost; calls: Array<{ manifest: unknown; source: string; args?: unknown }> } {
  const calls: Array<{ manifest: unknown; source: string; args?: unknown }> = [];
  const host: WorkflowToolHost = {
    runInline: async (input) => {
      calls.push(input);
      return typeof result === 'function' ? result() : result;
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

  it('prefixes a completed_unverified result with a warning', async () => {
    const { host } = recordingHost({ kind: 'started', runId: 'r1', status: 'completed_unverified', resultText: 'answer' });
    const out = await toolRunWorkflow({ manifest: MANIFEST, source: SOURCE }, ctxWith(host));
    expect(String(out)).toContain('verification warnings');
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
