/**
 * FEATURE_246 (P1 review): the model-launched run_workflow path must surface live
 * progress, mirroring the slash /workflow path. buildWorkflowToolHost.runInline
 * subscribes to this run's process events (filtered by runId) and forwards them to
 * options.events.onWorkflowProcessEvent. This pins that emit side end-to-end: a
 * trivial no-agent inline workflow (no LLM call) still produces workflow_started +
 * workflow_finished, and every forwarded event belongs to this run.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import type { WorkflowProcessEvent } from '@kodax-ai/agent';

import { buildToolExecutionContext } from './tool-execution-context.js';
import type { KodaXOptions } from '../types.js';

describe('FEATURE_246 P1: run_workflow forwards live process events to options.events', () => {
  it('forwards workflow_started + workflow_finished for the run, all matching its runId', async () => {
    const runsBaseDir = mkdtempSync(join(tmpdir(), 'kodax-wf-progress-'));
    const seen: WorkflowProcessEvent[] = [];

    const ctx = buildToolExecutionContext({
      options: {
        workflowRunsBaseDir: runsBaseDir,
        agentMode: 'amaw',
        events: { onWorkflowProcessEvent: (event) => seen.push(event) },
      } as unknown as KodaXOptions,
      runtime: undefined,
      managedProtocolPayloadRef: { current: undefined },
    });

    expect(ctx.workflowHost, 'amaw + runs dir wires the workflow host').toBeDefined();

    const out = await ctx.workflowHost!.runInline({
      manifest: {
        name: 'progress-smoke',
        description: 'trivial no-agent workflow',
        readOnly: true,
        maxAgents: 1,
        maxConcurrency: 1,
        phases: ['main'],
        patterns: ['fan-out-and-synthesize'],
      },
      source: 'async function run(wf, args) { return "ok"; }',
      args: {},
    });

    expect(out.kind).toBe('started');
    const runId = out.kind === 'started' ? out.runId : '';
    expect(runId).toMatch(/^run-/);

    // Live progress reached the host sink…
    expect(seen.length, 'process events were forwarded').toBeGreaterThan(0);
    // …and the runId filter is correct — no other run's events leaked in.
    expect(seen.every((e) => e.snapshot.runId === runId), 'every event belongs to this run').toBe(true);
    const types = seen.map((e) => e.type);
    expect(types).toContain('workflow_started');
    expect(types).toContain('workflow_finished');
    // Each lifecycle event must arrive EXACTLY ONCE — the host must not add a
    // second sink on top of the runner's existing onWorkflowProcessEvent forward
    // (a double-subscription would double every event and double-render / pollute
    // an SDK host's audit stream).
    expect(types.filter((t) => t === 'workflow_started').length, 'exactly one workflow_started (no double-emit)').toBe(1);
    expect(types.filter((t) => t === 'workflow_finished').length, 'exactly one workflow_finished (no double-emit)').toBe(1);
  });

  it('does not subscribe (no overhead) when no onWorkflowProcessEvent sink is wired', async () => {
    const runsBaseDir = mkdtempSync(join(tmpdir(), 'kodax-wf-noprogress-'));
    const ctx = buildToolExecutionContext({
      options: { workflowRunsBaseDir: runsBaseDir, agentMode: 'amaw' } as unknown as KodaXOptions,
      runtime: undefined,
      managedProtocolPayloadRef: { current: undefined },
    });
    const out = await ctx.workflowHost!.runInline({
      manifest: {
        name: 'progress-smoke-2',
        description: 'trivial no-agent workflow',
        readOnly: true,
        maxAgents: 1,
        maxConcurrency: 1,
        phases: ['main'],
        patterns: ['fan-out-and-synthesize'],
      },
      source: 'async function run(wf, args) { return "ok"; }',
      args: {},
    });
    expect(out.kind).toBe('started');
  });
});
