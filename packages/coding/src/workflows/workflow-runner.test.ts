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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InputGuardrail } from '@kodax-ai/agent';
import type {
  WorkflowAgentBackend,
  WorkflowModule,
  WorkflowProcessEvent,
} from '@kodax-ai/agent/workflow';
import { WorkflowAbortError, WorkflowLimitError } from '@kodax-ai/agent/workflow';

import type { KodaXOptions } from '../types.js';
import { parallelInvestigation } from './builtin/parallel-investigation.js';
import { buildApprovalSummary, runWorkflowFromOptions, runWorkflowModule } from './workflow-runner.js';

const childExecutorMock = vi.hoisted(() => ({
  calls: [] as Array<{
    readonly options: {
      readonly guardrails?: readonly unknown[];
      readonly planModeBlockCheck?: unknown;
      readonly parentOptions?: {
        readonly effort?: unknown;
        readonly repoIntelligenceMode?: unknown;
        readonly repoIntelligenceTrace?: unknown;
      };
    };
  }>,
}));

vi.mock('../child-executor.js', () => ({
  executeChildAgents: vi.fn(async (
    _bundles: unknown,
    _ctx: unknown,
    options: {
      readonly guardrails?: readonly unknown[];
      readonly planModeBlockCheck?: unknown;
      readonly parentOptions?: {
        readonly effort?: unknown;
        readonly repoIntelligenceMode?: unknown;
        readonly repoIntelligenceTrace?: unknown;
      };
    },
  ) => {
    childExecutorMock.calls.push({ options });
    return {
      results: [{
        childId: 'wf-child-1',
        fanoutClass: 'evidence-scan',
        status: 'completed',
        disposition: 'valid',
        summary: 'child ok',
        evidenceRefs: [],
        contradictions: [],
      }],
      mergedFindings: [],
      mergedArtifacts: [],
      totalTokensUsed: 0,
      cancelledChildren: [],
    };
  }),
}));

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
    childExecutorMock.calls.length = 0;
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
    expect(runJson.resultSummary).toEqual(expect.stringContaining('result for'));

    // Live event sink saw the same envelope.
    expect(events[0]).toBe('workflow_started');
    expect(events.at(-1)).toBe('workflow_completed');
  });

  it('emits workflow process events for SDK consumers without REPL helpers', async () => {
    const processEvents: WorkflowProcessEvent[] = [];
    const outcome = await runWorkflowModule({
      module: parallelInvestigation,
      args: { question: 'where is the bug?' },
      runId: 'run-process',
      runDir: dir,
      backend: fakeBackend(),
      processMetadata: {
        source: 'sdk',
        displayName: 'SDK audit',
        goal: 'where is the bug?',
        hostMetadata: { sessionId: 'session-1', tag: 'coder' },
      },
      onWorkflowProcessEvent: (event) => processEvents.push(event),
    });

    expect(outcome.kind).toBe('completed');
    expect(processEvents.map((event) => event.type)).toContain('workflow_started');
    expect(processEvents.find((event) => event.type === 'workflow_finished')).toMatchObject({
      type: 'workflow_finished',
      snapshot: {
        runId: 'run-process',
        workflowName: 'parallel-investigation',
        displayName: 'SDK audit',
        goal: 'where is the bug?',
        source: 'sdk',
        hostMetadata: { sessionId: 'session-1', tag: 'coder' },
        status: 'completed',
        resultSummary: expect.stringContaining('result for'),
        progress: {
          spawnedAgents: 4,
          finishedAgents: 4,
        },
      },
    });
    expect(processEvents.at(-1)).toMatchObject({
      type: 'workflow_finished',
      snapshot: {
        resultSummary: expect.stringContaining('result for'),
      },
    });
  });

  it('threads parent guardrails, plan-mode checks, and repo-intelligence config into workflow children', async () => {
    const guardrail: InputGuardrail = {
      kind: 'input',
      name: 'parent-guardrail',
      check: async () => ({ action: 'allow' }),
    };
    const planModeBlockCheck = (_tool: string, _input: Record<string, unknown>): string | null =>
      null;
    const module: WorkflowModule<unknown, string> = {
      meta: {
        name: 'guarded-workflow',
        description: 'Spawns one child',
        readOnly: true,
        phases: ['spawn'],
      },
      run: async (wf) => {
        const task = await wf.spawnAgent({ name: 'child', prompt: 'check guardrails' });
        const result = await wf.wait(task.taskId);
        return result.finalText;
      },
    };
    const options: KodaXOptions = {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      modelOverride: 'claude-opus-4-8',
      effort: 'high',
      guardrails: [guardrail],
      context: {
        planModeBlockCheck,
        repoIntelligenceMode: 'off',
        repoIntelligenceTrace: true,
      },
    };

    const outcome = await runWorkflowFromOptions({
      module,
      args: {},
      options,
      runId: 'run-guardrails',
      runDir: dir,
    });

    expect(outcome.kind).toBe('completed');
    expect(childExecutorMock.calls).toHaveLength(1);
    expect(childExecutorMock.calls[0]?.options.guardrails).toBe(options.guardrails);
    expect(childExecutorMock.calls[0]?.options.planModeBlockCheck).toBe(planModeBlockCheck);
    expect(childExecutorMock.calls[0]?.options.parentOptions?.model).toBe('claude-opus-4-8');
    expect(childExecutorMock.calls[0]?.options.parentOptions?.effort).toBe('high');
    expect(childExecutorMock.calls[0]?.options.parentOptions?.repoIntelligenceMode).toBe('off');
    expect(childExecutorMock.calls[0]?.options.parentOptions?.repoIntelligenceTrace).toBe(true);
  });

  it('writes stopped status for user-aborted workflow runs', async () => {
    const module: WorkflowModule = {
      meta: {
        name: 'abort-test',
        description: 'aborts',
        readOnly: true,
        phases: ['abort'],
      },
      run: async () => {
        throw new WorkflowAbortError();
      },
    };

    const outcome = await runWorkflowModule({
      module,
      args: {},
      runId: 'run-stopped',
      runDir: dir,
      backend: fakeBackend(),
      approval: () => true,
    });

    expect(outcome.kind).toBe('failed');
    expect(outcome.state.status).toBe('stopped');
    const runJson = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as { status?: unknown };
    expect(runJson.status).toBe('stopped');
  });

  it('reclaims leftover run worktrees on the terminal path (FEATURE_217 Layer 2/3)', async () => {
    const calls: string[][] = [];
    const baseDir = join(dir, 'worktrees');
    const leftover = join(baseDir, '.kodax-worktree-wf-child-1');
    const runGit = async (args: readonly string[]): Promise<string> => {
      calls.push([...args]);
      if (args[0] === 'worktree' && args[1] === 'list') {
        return [
          'worktree /repo', 'HEAD a', 'branch refs/heads/main', '',
          `worktree ${leftover}`, 'HEAD b', 'branch refs/heads/kodax-wt-workflow-wf-child-1', '',
        ].join('\n');
      }
      return '';
    };

    const outcome = await runWorkflowModule({
      module: parallelInvestigation,
      args: { question: 'Q' },
      runId: 'run-wt',
      runDir: dir,
      backend: fakeBackend(),
      ctx: { backups: new Map(), gitRoot: '/repo' },
      approval: () => true,
      // Fresh mtime → Layer 3 startup prune leaves it; Layer 2 terminal sweep
      // (path-prefix, mtime-agnostic) is what reclaims it.
      worktreeSweepDeps: { runGit, now: () => 0, mtimeMs: () => 0 },
    });

    expect(outcome.kind).toBe('completed');
    const removed = calls
      .filter((c) => c[0] === 'worktree' && c[1] === 'remove')
      .map((c) => c[2]);
    expect(removed).toContain(leftover);
    // The main repo worktree is never touched.
    expect(removed).not.toContain('/repo');
    // Startup prune ran (Layer 3) in addition to the terminal sweep.
    expect(calls.some((c) => c[0] === 'worktree' && c[1] === 'prune')).toBe(true);
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

  it('lowers approval caps with host policy ceilings', () => {
    const module: WorkflowModule = {
      meta: {
        name: 'host-capped-summary',
        description: 'host capped',
        maxAgents: 10,
        maxConcurrency: 8,
        tokenBudget: 50_000,
      },
      run: async () => undefined,
    };

    expect(buildApprovalSummary(module, {
      maxAgents: 3,
      maxConcurrency: 2,
      tokenBudget: 1_000,
    })).toMatchObject({
      maxAgents: 3,
      maxConcurrency: 2,
      tokenBudget: 1_000,
    });
  });

  it('enforces host policy ceilings at runtime', async () => {
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
        name: 'host-capped-runtime',
        description: 'host capped runtime',
        maxAgents: 10,
        maxConcurrency: 4,
      },
      run: async (wf) => {
        await wf.runAgent({ name: 'a1', prompt: 'x' });
        await wf.runAgent({ name: 'a2', prompt: 'x' });
        await wf.runAgent({ name: 'a3', prompt: 'x' });
      },
    };

    const outcome = await runWorkflowModule({
      module,
      args: {},
      runId: 'run-host-cap',
      runDir: dir,
      backend,
      hostPolicy: { maxAgents: 2 },
    });

    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.error).toBeInstanceOf(WorkflowLimitError);
    }
    expect(spawns).toBe(2);
  });
});
