/**
 * FEATURE_217 (v0.7.49) Phase C — parallel-investigation workflow tests.
 *
 * Drives the built-in workflow through the agent-layer `runWorkflow` with
 * a configurable fake backend (no real agents). Validates fan-out shape,
 * read-only investigators, target splitting, the maxAgents reservation
 * for synthesis, and degraded synthesis on investigator failure/crash.
 */

import { describe, expect, it } from 'vitest';

import {
  runWorkflow,
  type WorkflowAgentBackend,
  type WorkflowSpawnAgentInput,
  type WorkflowTaskStatus,
} from '@kodax-ai/agent/workflow';

import {
  parallelInvestigation,
  type ParallelInvestigationArgs,
  type ParallelInvestigationResult,
} from './parallel-investigation.js';

interface Behavior {
  readonly status?: WorkflowTaskStatus;
  readonly finalText?: string;
  readonly throw?: boolean;
}

function fakeBackend(behaviors: Record<string, Behavior> = {}): {
  backend: WorkflowAgentBackend;
  spawned: WorkflowSpawnAgentInput[];
  synthInputs: () => number;
} {
  const byId = new Map<string, WorkflowSpawnAgentInput>();
  const spawned: WorkflowSpawnAgentInput[] = [];
  let counter = 0;
  let synthCount = 0;
  const backend: WorkflowAgentBackend = {
    spawn: async (input) => {
      counter += 1;
      const taskId = `t${counter}`;
      byId.set(taskId, input);
      spawned.push(input);
      return { taskId, name: input.name };
    },
    wait: async (taskId) => {
      const input = byId.get(taskId)!;
      const b = behaviors[input.name] ?? {};
      if (b.throw) throw new Error('child crashed');
      return {
        taskId,
        name: input.name,
        status: b.status ?? 'completed',
        finalText: b.finalText ?? `text-${input.name}`,
      };
    },
    output: async (taskId) => ({ taskId, name: byId.get(taskId)?.name ?? taskId, status: 'completed' }),
    send: async () => {},
    stop: async () => {},
    synthesize: async (input) => {
      synthCount = input.inputs.length;
      return { text: `SYNTH(${input.inputs.length})` };
    },
  };
  return { backend, spawned, synthInputs: () => synthCount };
}

function drive(backend: WorkflowAgentBackend, args: ParallelInvestigationArgs) {
  return runWorkflow<ParallelInvestigationResult>(
    {
      runId: 'run-c',
      backend,
      limits: {
        maxAgents: parallelInvestigation.meta.maxAgents,
        maxConcurrency: parallelInvestigation.meta.maxConcurrency,
      },
    },
    (wf) => parallelInvestigation.run(wf, args),
  );
}

describe('parallel-investigation — fan-out + synthesis', () => {
  it('runs 3 read-only investigators by default and synthesizes', async () => {
    const { backend, spawned, synthInputs } = fakeBackend();
    const outcome = await drive(backend, { question: 'where is the auth bug?' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.findings).toHaveLength(3);
    expect(spawned.every((s) => s.readOnly === true)).toBe(true);
    expect(outcome.result.degraded).toBe(false);
    expect(outcome.result.synthesis).toBe('SYNTH(3)');
    expect(synthInputs()).toBe(3);
  });

  it('splits one investigator per target and embeds question + target in the prompt', async () => {
    const { backend, spawned } = fakeBackend();
    await drive(backend, { question: 'Q', targets: ['packages/llm', 'packages/agent'] });
    expect(spawned).toHaveLength(2);
    expect(spawned[0]!.prompt).toContain('Q');
    expect(spawned[0]!.prompt).toContain('packages/llm');
    expect(spawned[1]!.prompt).toContain('packages/agent');
  });

  it('reserves one agent for synthesis (maxAgents cap)', async () => {
    const { backend, spawned } = fakeBackend();
    await drive(backend, { question: 'Q', targets: ['a', 'b', 'c', 'd', 'e'], maxAgents: 3 });
    expect(spawned).toHaveLength(2); // maxAgents 3 → 2 investigators + 1 synthesis
  });
});

describe('parallel-investigation — degraded synthesis', () => {
  it('marks degraded when an investigator returns failed status', async () => {
    const { backend } = fakeBackend({ 'investigate-2': { status: 'failed', finalText: 'partial' } });
    const outcome = await drive(backend, { question: 'Q' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.degraded).toBe(true);
    expect(outcome.result.findings.filter((f) => f.status === 'failed')).toHaveLength(1);
    expect(outcome.result.synthesis).toBe('SYNTH(3)'); // synthesis still runs over all
  });

  it('catches a crashing investigator and keeps the run alive', async () => {
    const { backend } = fakeBackend({ 'investigate-1': { throw: true } });
    const outcome = await drive(backend, { question: 'Q' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.degraded).toBe(true);
    const failed = outcome.result.findings.find((f) => f.angle === 'investigate-1');
    expect(failed?.status).toBe('failed');
    expect(failed?.text).toContain('[investigation failed]');
  });
});
