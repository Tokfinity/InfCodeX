/**
 * FEATURE_217 (v0.7.49) Phase D.2 — /workflow command pure-helper tests.
 *
 * Covers the testable core (invocation parse, args parse, list/runs
 * formatting, approval prompt, run-graph reading). The live execution
 * path (ctx + real agents) is exercised via the headless
 * `workflow-runner` tests in @kodax-ai/coding.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  parseWorkflowInvocation,
  parseWorkflowArgs,
  formatWorkflowList,
  renderApprovalPrompt,
  readWorkflowRuns,
  formatRunsList,
  formatManagedRunsList,
  formatWorkflowRunSnapshot,
  savedWorkflowDirs,
  formatSavedList,
  isSafeWorkflowRunId,
  renderWorkflowHelp,
  resolveConfirm,
  workflowCommand,
} from './workflow-command.js';

describe('parseWorkflowInvocation', () => {
  it('defaults to list', () => {
    expect(parseWorkflowInvocation([]).kind).toBe('list');
    expect(parseWorkflowInvocation(['list']).kind).toBe('list');
  });
  it('detects runs', () => {
    expect(parseWorkflowInvocation(['runs']).kind).toBe('runs');
  });
  it('detects help aliases', () => {
    expect(parseWorkflowInvocation(['help'])).toEqual({ kind: 'help' });
    expect(parseWorkflowInvocation(['--help'])).toEqual({ kind: 'help' });
    expect(parseWorkflowInvocation(['-h'])).toEqual({ kind: 'help' });
  });
  it('detects run-control subcommands', () => {
    expect(parseWorkflowInvocation(['show', 'run-1'])).toEqual({ kind: 'show', runId: 'run-1' });
    expect(parseWorkflowInvocation(['pause', 'run-1'])).toEqual({ kind: 'pause', runId: 'run-1' });
    expect(parseWorkflowInvocation(['resume', 'run-1'])).toEqual({ kind: 'resume', runId: 'run-1' });
    expect(parseWorkflowInvocation(['stop', 'run-1'])).toEqual({ kind: 'stop', runId: 'run-1' });
    expect(parseWorkflowInvocation(['save', 'run-1', 'audit'])).toEqual({
      kind: 'save',
      runId: 'run-1',
      name: 'audit',
    });
    expect(parseWorkflowInvocation(['rerun', 'run-1', '{"request":"请复查"}'])).toEqual({
      kind: 'rerun',
      runId: 'run-1',
      rawArgs: '{"request":"请复查"}',
    });
    expect(parseWorkflowInvocation(['create', 'compare', 'three', 'hypotheses'])).toEqual({
      kind: 'create',
      request: 'compare three hypotheses',
    });
  });
  it('treats other first tokens as a start invocation', () => {
    const inv = parseWorkflowInvocation(['parallel-investigation', 'where', 'is', 'the', 'bug']);
    expect(inv).toEqual({ kind: 'start', name: 'parallel-investigation', rawArgs: 'where is the bug' });
  });
});

describe('parseWorkflowArgs', () => {
  it('parses JSON object args', () => {
    expect(parseWorkflowArgs('{"question":"x","maxAgents":3}')).toEqual({ question: 'x', maxAgents: 3 });
  });
  it('wraps bare text as a question', () => {
    expect(parseWorkflowArgs('where is the bug')).toEqual({ question: 'where is the bug' });
  });
  it('falls back to question on malformed JSON', () => {
    expect(parseWorkflowArgs('{not json')).toEqual({ question: '{not json' });
  });
  it('returns empty object for blank', () => {
    expect(parseWorkflowArgs('   ')).toEqual({});
  });
});

describe('formatWorkflowList', () => {
  it('lists names + descriptions', () => {
    const out = formatWorkflowList([{ name: 'demo', description: 'a demo' }]);
    expect(out).toContain('demo');
    expect(out).toContain('a demo');
  });
  it('handles empty', () => {
    expect(formatWorkflowList([])).toContain('no built-in');
  });
});

describe('renderApprovalPrompt', () => {
  it('shows read-only + phases + caps', () => {
    const text = renderApprovalPrompt({
      name: 'parallel-investigation',
      description: 'fan out',
      phases: ['investigate', 'synthesize'],
      maxAgents: 8,
      maxConcurrency: 4,
      tokenBudget: null,
      writesFiles: false,
    });
    expect(text).toContain('parallel-investigation');
    expect(text).toContain('investigate → synthesize');
    expect(text).toContain('max agents: 8');
    expect(text).toContain('token budget: ∞');
    expect(text).toContain('read-only');
  });

  it('shows source, sandbox, and worktree context when provided', () => {
    const text = renderApprovalPrompt(
      {
        name: 'generated',
        description: 'generated workflow',
        phases: ['run'],
        maxAgents: 2,
        maxConcurrency: 1,
        tokenBudget: 1000,
        writesFiles: true,
      },
      {
        source: 'generated',
        sandbox: 'capability-generated',
        mayUseWorktree: true,
        rawScript: 'async function run() { return "ok"; }',
      },
    );
    expect(text).toContain('source: generated');
    expect(text).toContain('sandbox/trust: capability-generated');
    expect(text).toContain('worktree isolation: may request worktree');
    expect(text).toContain('raw script:');
    expect(text).toContain('async function run()');
  });
});

describe('readWorkflowRuns + formatRunsList', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wf-runs-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeRun(runId: string, data: Record<string, unknown>): void {
    const runDir = join(dir, runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'run.json'), JSON.stringify(data), 'utf8');
  }

  it('returns empty for a missing dir', () => {
    expect(readWorkflowRuns(join(dir, 'nope'))).toEqual([]);
  });

  it('reads run.json files and sorts by endedAt desc', () => {
    writeRun('run-a', { runId: 'run-a', workflow: 'wf', status: 'completed', totalSpawned: 3, endedAt: 100 });
    writeRun('run-b', { runId: 'run-b', workflow: 'wf', status: 'failed', totalSpawned: 1, endedAt: 200 });
    const runs = readWorkflowRuns(dir);
    expect(runs.map((r) => r.runId)).toEqual(['run-b', 'run-a']);
    expect(runs[0]!.status).toBe('failed');
  });

  it('skips malformed run.json', () => {
    const runDir = join(dir, 'run-bad');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'run.json'), '{not json', 'utf8');
    expect(readWorkflowRuns(dir)).toEqual([]);
  });

  it('formats runs list', () => {
    const out = formatRunsList([
      { runId: 'r1', workflow: 'wf', status: 'completed', totalSpawned: 2, endedAt: 1 },
    ]);
    expect(out).toContain('wf');
    expect(out).toContain('r1');
    expect(out).toContain('2 agents');
  });

  it('formats active manager runs and a single run snapshot', () => {
    const run = {
      runId: 'run-active',
      workflow: 'wf',
      status: 'paused' as const,
      runDir: '/tmp/run-active',
      totalSpawned: 2,
      eventCount: 5,
      startedAt: 1,
    };
    expect(formatManagedRunsList([run])).toContain('paused');
    expect(formatManagedRunsList([run])).toContain('5 events');
    expect(formatWorkflowRunSnapshot(run)).toContain('/tmp/run-active');
    expect(formatWorkflowRunSnapshot(undefined)).toContain('unknown active');
  });
});

describe('saved workflow dirs + formatting', () => {
  it('derives project + personal dirs from cwd', () => {
    const dirs = savedWorkflowDirs('/repo');
    expect(dirs.project).toContain('.kodax');
    expect(dirs.project).toContain('workflows');
    expect(dirs.personal).toContain('workflows');
  });
  it('formats saved workflow refs with source + path', () => {
    const out = formatSavedList([
      {
        name: 'audit',
        path: '/p/.kodax/workflows/audit.ts',
        source: 'project',
        execution: 'trusted-local',
      },
    ]);
    expect(out).toContain('audit');
    expect(out).toContain('project');
    expect(out).toContain('trusted-local');
  });
  it('handles empty saved list', () => {
    expect(formatSavedList([])).toContain('no saved');
  });
});

describe('renderWorkflowHelp', () => {
  it('documents every workflow subcommand and safety boundary', () => {
    const text = renderWorkflowHelp();
    expect(text).toContain('/workflow create <request>');
    expect(text).toContain('/workflow <name> [args]');
    expect(text).toContain('/workflow runs');
    expect(text).toContain('/workflow show <runId>');
    expect(text).toContain('/workflow pause <runId>');
    expect(text).toContain('/workflow resume <runId>');
    expect(text).toContain('/workflow stop <runId>');
    expect(text).toContain('/workflow save <runId> <name>');
    expect(text).toContain('/workflow rerun <runId> [args]');
    expect(text).toContain('/workflow help');
    expect(text).toContain('workflow capsule');
    expect(text).toContain('capability WorkflowApi runner');
    expect(text).toContain('trusted-local');
  });
});

describe('isSafeWorkflowRunId', () => {
  it('allows generated run ids and rejects path traversal', () => {
    expect(isSafeWorkflowRunId('run-lx3')).toBe(true);
    expect(isSafeWorkflowRunId('run_2026-06-13')).toBe(true);
    expect(isSafeWorkflowRunId('../run-lx3')).toBe(false);
    expect(isSafeWorkflowRunId('..\\run-lx3')).toBe(false);
    expect(isSafeWorkflowRunId('')).toBe(false);
  });
});

describe('resolveConfirm', () => {
  it('prefers callbacks.confirm', async () => {
    const confirm = resolveConfirm({ confirm: async () => true });
    expect(confirm).toBeDefined();
    expect(await confirm!('ok?')).toBe(true);
  });

  it('falls back to a readline (y/N) prompt', async () => {
    const asked: string[] = [];
    const rl = {
      question: (query: string, cb: (answer: string) => void) => {
        asked.push(query);
        cb('y');
      },
    };
    const confirm = resolveConfirm({ readline: rl });
    expect(confirm).toBeDefined();
    expect(await confirm!('proceed?')).toBe(true);
    expect(asked[0]).toContain('(y/N)');
  });

  it('readline fallback treats non-yes as false', async () => {
    const rl = { question: (_q: string, cb: (a: string) => void) => cb('n') };
    expect(await resolveConfirm({ readline: rl })!('x?')).toBe(false);
  });

  it('returns undefined with no confirm channel (caller must fail safe)', () => {
    expect(resolveConfirm({})).toBeUndefined();
  });
});

describe('workflowCommand registration shape', () => {
  it('exposes name + usage + handler', () => {
    expect(workflowCommand.name).toBe('workflow');
    expect(typeof workflowCommand.handler).toBe('function');
    expect(workflowCommand.usage).toContain('/workflow');
    expect(workflowCommand.argumentHint).toContain('help');
    expect(workflowCommand.argumentHint).toContain('rerun');
    expect(workflowCommand.detailedHelp).toBeDefined();
  });
});

describe('workflowCommand saved capsule preflight', () => {
  let dir = '';
  let previousCwd = '';
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wf-command-'));
    previousCwd = process.cwd();
    process.chdir(dir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    process.chdir(previousCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  it('prints dependency-inventory warnings before saved capsule approval', async () => {
    const workflowsDir = join(dir, '.kodax', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(
      join(workflowsDir, 'needs-inventory.workflow.json'),
      JSON.stringify({
        format: 'kodax.workflow',
        version: 1,
        workflowApiVersion: 1,
        minKodaxVersion: '0.7.49',
        manifest: {
          name: 'needs-inventory',
          description: 'requires an external shell tool',
          phases: ['run'],
          readOnly: true,
          maxAgents: 1,
          maxConcurrency: 1,
          patterns: ['classify-and-act'],
        },
        source: 'async function run() { return "ok"; }',
        requires: {
          tools: ['bash'],
        },
      }),
      'utf8',
    );
    const prompts: string[] = [];
    type WorkflowHandlerCallbacks = Parameters<typeof workflowCommand.handler>[2];
    const callbacks = {
      confirm: async (message: string) => {
        prompts.push(message);
        return false;
      },
      createKodaXOptions: () => ({}) as ReturnType<NonNullable<WorkflowHandlerCallbacks['createKodaXOptions']>>,
    } as WorkflowHandlerCallbacks;

    await workflowCommand.handler(
      ['needs-inventory'],
      {} as Parameters<typeof workflowCommand.handler>[1],
      callbacks,
      {} as Parameters<typeof workflowCommand.handler>[3],
    );

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('capsule preflight warnings');
    expect(output).toContain('tools:bash');
    expect(prompts[0]).toContain('raw script:');
  });
});
