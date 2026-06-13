/**
 * FEATURE_217 (v0.7.49) Phase D — Headless orchestrator tests.
 *
 * Drives `runWorkflowModule` with the built-in parallel-investigation
 * workflow + a fake backend + a temp run dir. Validates the approval
 * gate, durable run-graph output, and terminal outcome shape.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { WorkflowAgentBackend, WorkflowModule } from '@kodax-ai/agent/workflow';
import { WorkflowLimitError } from '@kodax-ai/agent/workflow';

import { parallelInvestigation } from './builtin/parallel-investigation.js';
import { buildApprovalSummary, runWorkflowModule } from './workflow-runner.js';

function fakeBackend(): WorkflowAgentBackend {
  let n = 0;
  const names = new Map<string, string>();
  return {
    spawn: async (input) => {
      n += 1;
      const taskId = `t${n}`;
      names.set(taskId, input.name);
      return { taskId, name: input.name };
    },
    wait: async (taskId) => ({
      taskId,
      name: names.get(taskId) ?? taskId,
      status: 'completed',
      finalText: `result for ${names.get(taskId)}`,
    }),
    output: async (taskId) => ({ taskId, name: names.get(taskId) ?? taskId, status: 'completed' }),
    send: async () => {},
    stop: async () => {},
  };
}

describe('buildApprovalSummary', () => {
  it('reflects read-only + phases from meta', () => {
    const summary = buildApprovalSummary(parallelInvestigation);
    expect(summary.writesFiles).toBe(false);
    expect(summary.phases).toEqual(['investigate', 'synthesize']);
    expect(summary.maxAgents).toBe(8);
    expect(summary.name).toBe('parallel-investigation');
  });
});

describe('runWorkflowModule', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wf-run-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('cancels without running when approval is denied', async () => {
    const outcome = await runWorkflowModule({
      module: parallelInvestigation,
      args: { question: 'Q' },
      runId: 'run-d',
      runDir: dir,
      backend: fakeBackend(),
      approval: () => false,
    });
    expect(outcome.kind).toBe('denied');
    expect(existsSync(join(dir, 'run.json'))).toBe(false);
  });

  it('runs end-to-end and writes the durable run graph when approved', async () => {
    const events: string[] = [];
    const outcome = await runWorkflowModule({
      module: parallelInvestigation,
      args: { question: 'where is the bug?' },
      runId: 'run-e',
      runDir: dir,
      backend: fakeBackend(),
      approval: () => true,
      onEvent: (e) => events.push(e.type),
    });

    expect(outcome.kind).toBe('completed');
    // run.json + events.jsonl + artifacts/ all present.
    expect(existsSync(join(dir, 'run.json'))).toBe(true);
    expect(existsSync(join(dir, 'events.jsonl'))).toBe(true);
    expect(existsSync(join(dir, 'artifacts'))).toBe(true);

    const runJson = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
    expect(runJson.status).toBe('completed');
    expect(runJson.workflow).toBe('parallel-investigation');
    expect(runJson.totalSpawned).toBe(4); // 3 investigators + 1 gated synthesizer

    // Live event sink saw the same envelope.
    expect(events[0]).toBe('workflow_started');
    expect(events.at(-1)).toBe('workflow_completed');
  });

  it('writes a script snapshot when a generated workflow source is provided', async () => {
    const outcome = await runWorkflowModule({
      module: parallelInvestigation,
      args: { question: 'where is the bug?' },
      runId: 'run-s',
      runDir: dir,
      backend: fakeBackend(),
      scriptSnapshot: {
        source: 'async function run() { return "ok"; }',
        manifest: {
          name: 'generated-investigation',
          description: 'generated',
          phases: ['investigate', 'synthesize'],
          readOnly: true,
          maxAgents: 4,
          maxConcurrency: 2,
          patterns: ['fan-out-and-synthesize'],
        },
      },
    });

    expect(outcome.kind).toBe('completed');
    expect(existsSync(join(dir, 'script.js'))).toBe(true);
    expect(existsSync(join(dir, 'manifest.json'))).toBe(true);
    const runJson = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
    expect(runJson.scriptSnapshotPath).toBe(join(dir, 'script.js'));
    expect(runJson.manifestSnapshotPath).toBe(join(dir, 'manifest.json'));
  });

  it('auto-proceeds with no approval callback (headless)', async () => {
    const outcome = await runWorkflowModule({
      module: parallelInvestigation,
      args: { question: 'Q' },
      runId: 'run-h',
      runDir: dir,
      backend: fakeBackend(),
    });
    expect(outcome.kind).toBe('completed');
  });

  it('throws if neither backend nor ctx+childOptions provided', async () => {
    await expect(
      runWorkflowModule({
        module: parallelInvestigation,
        args: { question: 'Q' },
        runId: 'run-x',
        runDir: dir,
        approval: () => true,
      }),
    ).rejects.toThrow(/requires either a backend/);
  });

  it('clamps manifest caps to system hard limits', async () => {
    let spawns = 0;
    const backend: WorkflowAgentBackend = {
      ...fakeBackend(),
      spawn: async (input) => {
        spawns += 1;
        return { taskId: `t${spawns}`, name: input.name };
      },
    };
    const module: WorkflowModule = {
      meta: {
        name: 'runaway-generated',
        description: 'runaway',
        maxAgents: 999999,
        maxConcurrency: 999999,
      },
      run: async (wf) => {
        for (let i = 0; i < 70; i += 1) {
          await wf.runAgent({ name: `a${i}`, prompt: 'x' });
        }
      },
    };

    const outcome = await runWorkflowModule({
      module,
      args: {},
      runId: 'run-cap',
      runDir: dir,
      backend,
    });

    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.error).toBeInstanceOf(WorkflowLimitError);
    }
    expect(spawns).toBeLessThanOrEqual(64);
  });

  it('normalizes invalid meta caps in approval summaries', () => {
    const module: WorkflowModule = {
      meta: {
        name: 'bad-caps',
        description: 'bad caps',
        maxAgents: Number.NaN,
        maxConcurrency: 0,
        tokenBudget: -1,
      },
      run: async () => undefined,
    };

    expect(buildApprovalSummary(module)).toMatchObject({
      maxAgents: 1,
      maxConcurrency: 1,
      tokenBudget: 1,
    });
  });
});
