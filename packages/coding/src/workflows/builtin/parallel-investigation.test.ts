/**
 * FEATURE_217 (v0.7.49) Phase C — parallel-investigation workflow tests.
 *
 * Drives the built-in workflow through the agent-layer `runWorkflow` with
 * a configurable fake backend (no real agents). Validates fan-out shape,
 * read-only investigators, target splitting, the maxAgents reservation
 * for synthesis, and degraded synthesis on investigator failure/crash.
 *
 * NOTE: `wf.synthesize` runs as a gated agent (spawned through the backend
 * like any other), so a default run spawns 3 investigators + 1 synthesizer
 * = 4 agents, and the synthesis text is the synthesis agent's finalText.
 */

import { describe, expect, it } from 'vitest';

import {
  runWorkflow,
  type WorkflowAgentBackend,
  type WorkflowSpawnAgentInput,
  type WorkflowTaskStatus,
} from '@kodax-ai/agent';

import {
  parallelInvestigation,
  type ParallelInvestigationArgs,
  type ParallelInvestigationResult,
} from './parallel-investigation.js';

interface Behavior {
  readonly status?: WorkflowTaskStatus;
  readonly finalText?: string;
  readonly structured?: unknown;
  readonly throw?: boolean;
}

function fakeBackend(behaviors: Record<string, Behavior> = {}): {
  backend: WorkflowAgentBackend;
  spawned: WorkflowSpawnAgentInput[];
} {
  const byId = new Map<string, WorkflowSpawnAgentInput>();
  const spawned: WorkflowSpawnAgentInput[] = [];
  let counter = 0;
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
        ...(b.structured !== undefined ? { structured: b.structured } : {}),
      };
    },
    output: async (taskId) => ({ taskId, name: byId.get(taskId)?.name ?? taskId, status: 'completed' }),
    send: async () => {},
    stop: async () => {},
  };
  return { backend, spawned };
}

const investigators = (spawned: readonly WorkflowSpawnAgentInput[]) =>
  spawned.filter((s) => s.name.startsWith('investigate'));

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
  it('runs 3 read-only investigators + 1 synthesizer, all read-only', async () => {
    const { backend, spawned } = fakeBackend();
    const outcome = await drive(backend, { question: 'where is the auth bug?' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.findings).toHaveLength(3);
    expect(investigators(spawned)).toHaveLength(3);
    expect(spawned).toHaveLength(4); // 3 investigators + 1 synthesizer
    expect(spawned.every((s) => s.readOnly === true)).toBe(true);
    expect(outcome.result.degraded).toBe(false);
    expect(outcome.result.synthesis).toBe('text-synthesize');
  });

  it('declares an outputSchema on every investigator (structured is the reliable field)', async () => {
    const { backend, spawned } = fakeBackend();
    await drive(backend, { question: 'Q' });
    expect(investigators(spawned).every((s) => s.outputSchema !== undefined)).toBe(true);
  });

  it('uses the structured finding when finalText is empty (FEATURE_246 digest-timing bug)', async () => {
    // Reproduce the report: the child ended on a tool_use so finalText is empty
    // and the digest is async — but the schema-validated structured finding is
    // present synchronously. The finding text must come from structured, not "".
    const { backend } = fakeBackend({
      'investigate-1': { finalText: '', structured: { finding: 'AUTH BUG at auth.ts:42' } },
    });
    const outcome = await drive(backend, { question: 'Q' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const first = outcome.result.findings.find((f) => f.angle === 'investigate-1');
    expect(first?.text).toBe('AUTH BUG at auth.ts:42');
    // Never surface a silent empty finding.
    expect(first?.text.trim().length).toBeGreaterThan(0);
  });

  it('marks an empty investigator honestly when neither structured nor finalText has content', async () => {
    const { backend } = fakeBackend({ 'investigate-1': { finalText: '   ' } });
    const outcome = await drive(backend, { question: 'Q' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const first = outcome.result.findings.find((f) => f.angle === 'investigate-1');
    expect(first?.text).toContain('no finding text');
  });

  it('splits one investigator per target and embeds question + target in the prompt', async () => {
    const { backend, spawned } = fakeBackend();
    await drive(backend, { question: 'Q', targets: ['packages/llm', 'packages/agent'] });
    const inv = investigators(spawned);
    expect(inv).toHaveLength(2);
    expect(inv[0]!.prompt).toContain('Q');
    expect(inv[0]!.prompt).toContain('packages/llm');
    expect(inv[1]!.prompt).toContain('packages/agent');
  });

  it('reserves one agent for synthesis (maxAgents cap)', async () => {
    const { backend, spawned } = fakeBackend();
    await drive(backend, { question: 'Q', targets: ['a', 'b', 'c', 'd', 'e'], maxAgents: 3 });
    expect(investigators(spawned)).toHaveLength(2); // maxAgents 3 → 2 investigators
    expect(spawned).toHaveLength(3); // + 1 synthesizer = exactly maxAgents
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
    expect(outcome.result.synthesis).toBe('text-synthesize'); // synthesis still runs
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
