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

import type { WorkflowGenerationResult } from '@kodax-ai/coding';

import {
  parseWorkflowInvocation,
  parseWorkflowArgs,
  parseWorkflowRunsOptions,
  parseWorkflowPruneOptions,
  formatWorkflowList,
  renderApprovalPrompt,
  readWorkflowRuns,
  readWorkflowRunDetail,
  formatRunsList,
  formatManagedRunsList,
  formatWorkflowPruneCandidates,
  formatWorkflowRunSnapshot,
  isActiveManagedWorkflowRun,
  selectWorkflowPruneCandidates,
  selectDefaultWorkflowRunId,
  savedWorkflowDirs,
  formatSavedList,
  isSafeWorkflowRunId,
  renderWorkflowHelp,
  resolveConfirm,
  startGeneratedWorkflowFromRequest,
  workflowCommand,
} from './workflow-command.js';

function fakeGeneratedWorkflow(): Extract<WorkflowGenerationResult, { readonly kind: 'generated' }> {
  const manifest = {
    name: 'generated-fast-audit',
    description: 'Generated workflow for fast audit',
    phases: ['investigate', 'synthesize'],
    readOnly: true,
    maxAgents: 2,
    maxConcurrency: 2,
    patterns: ['fan-out-and-synthesize'],
  } as const;
  const source = 'async function run(wf, args) { return { synthesis: String(args.request || "") }; }';
  return {
    kind: 'generated',
    manifest,
    source,
    module: {
      meta: {
        name: manifest.name,
        description: manifest.description,
        phases: manifest.phases,
        readOnly: manifest.readOnly,
        maxAgents: manifest.maxAgents,
        maxConcurrency: manifest.maxConcurrency,
      },
      run: async (_wf, args) => ({ synthesis: String((args as { request?: unknown }).request ?? '') }),
    },
    scriptSnapshot: { manifest, source },
    approvalSummary: 'Generated two-agent audit workflow.',
    rawText: '{}',
  };
}

describe('parseWorkflowInvocation', () => {
  it('defaults to list', () => {
    expect(parseWorkflowInvocation([]).kind).toBe('list');
    expect(parseWorkflowInvocation(['list']).kind).toBe('list');
  });
  it('detects runs', () => {
    expect(parseWorkflowInvocation(['runs']).kind).toBe('runs');
    expect(parseWorkflowInvocation(['runs', '--limit', '5'])).toEqual({
      kind: 'runs',
      rawArgs: ['--limit', '5'],
    });
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
    expect(parseWorkflowInvocation(['delete', 'run-1'])).toEqual({ kind: 'delete', runId: 'run-1' });
    expect(parseWorkflowInvocation(['prune', '--dry-run'])).toEqual({ kind: 'prune', rawArgs: ['--dry-run'] });
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

describe('workflow run cleanup options', () => {
  it('parses run listing flags conservatively', () => {
    expect(parseWorkflowRunsOptions([])).toEqual({ all: false, limit: 20 });
    expect(parseWorkflowRunsOptions(['--all'])).toEqual({ all: true, limit: 20 });
    expect(parseWorkflowRunsOptions(['--limit', '3'])).toEqual({ all: false, limit: 3 });
    expect(parseWorkflowRunsOptions(['--limit', '0']).error).toContain('positive integer');
    expect(parseWorkflowRunsOptions(['--unknown']).error).toContain('unknown option');
  });

  it('parses prune flags and makes dry-run preview useful by default', () => {
    expect(parseWorkflowPruneOptions(['--dry-run'])).toEqual({ dryRun: true, keep: 50 });
    expect(parseWorkflowPruneOptions(['--keep', '2'])).toEqual({ dryRun: false, keep: 2 });
    expect(parseWorkflowPruneOptions(['--older-than', '7d'])).toEqual({
      dryRun: false,
      olderThanMs: 7 * 24 * 60 * 60 * 1000,
    });
    expect(parseWorkflowPruneOptions(['--older-than', '12h'])).toEqual({
      dryRun: false,
      olderThanMs: 12 * 60 * 60 * 1000,
    });
    expect(parseWorkflowPruneOptions(['--older-than', 'soon']).error).toContain('older-than');
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
    expect(text).toContain('agent total cap: 8');
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

  it('uses the storage directory name as the authoritative run id', () => {
    writeRun('run-safe', {
      runId: '../../outside',
      workflow: 'wf',
      status: 'completed',
      totalSpawned: 1,
      endedAt: 100,
    });

    const runs = readWorkflowRuns(dir);

    expect(runs.map((run) => run.runId)).toEqual(['run-safe']);
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

  it('limits persisted runs output with a clear hint', () => {
    const out = formatRunsList([
      { runId: 'r3', workflow: 'wf', status: 'completed', totalSpawned: 1, endedAt: 3 },
      { runId: 'r2', workflow: 'wf', status: 'failed', totalSpawned: 1, endedAt: 2 },
      { runId: 'r1', workflow: 'wf', status: 'completed', totalSpawned: 1, endedAt: 1 },
    ], { limit: 2, showLimitHint: true });

    expect(out).toContain('r3');
    expect(out).toContain('r2');
    expect(out).not.toContain('r1');
    expect(out).toContain('Showing 2 of 3 persisted runs');
  });

  it('selects prune candidates from terminal runs only and protects keep/age rules', () => {
    const now = 20 * 24 * 60 * 60 * 1000;
    const day = 24 * 60 * 60 * 1000;
    const runs = [
      { runId: 'new', workflow: 'wf', status: 'completed', totalSpawned: 1, endedAt: now },
      { runId: 'old-failed', workflow: 'wf', status: 'failed', totalSpawned: 1, endedAt: now - 8 * day },
      { runId: 'old-running', workflow: 'wf', status: 'running', totalSpawned: 1, endedAt: now - 9 * day },
      { runId: 'old-completed', workflow: 'wf', status: 'completed', totalSpawned: 1, endedAt: now - 10 * day },
    ];

    expect(selectWorkflowPruneCandidates(runs, { dryRun: false, keep: 2 }, now).map((run) => run.runId))
      .toEqual(['old-completed']);
    expect(selectWorkflowPruneCandidates(runs, { dryRun: false, olderThanMs: 7 * day }, now).map((run) => run.runId))
      .toEqual(['old-failed', 'old-completed']);
    expect(selectWorkflowPruneCandidates(runs, { dryRun: false, keep: 2, olderThanMs: 7 * day }, now).map((run) => run.runId))
      .toEqual(['old-completed']);
    expect(formatWorkflowPruneCandidates([])).toContain('no workflow runs');
  });

  it('protects newest terminal runs even when prune input is unsorted', () => {
    const runs = [
      { runId: 'old', workflow: 'wf', status: 'completed', totalSpawned: 1, endedAt: 10 },
      { runId: 'newest', workflow: 'wf', status: 'completed', totalSpawned: 1, endedAt: 30 },
      { runId: 'middle', workflow: 'wf', status: 'completed', totalSpawned: 1, endedAt: 20 },
    ];

    expect(selectWorkflowPruneCandidates(runs, { dryRun: false, keep: 1 }).map((run) => run.runId))
      .toEqual(['middle', 'old']);
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
      resultText: 'final workflow report',
    };
    expect(formatManagedRunsList([run])).toContain('paused');
    expect(formatManagedRunsList([run])).toContain('5 events');
    expect(formatWorkflowRunSnapshot(run)).toContain('/tmp/run-active');
    expect(formatWorkflowRunSnapshot(run)).toContain('final workflow report');
    expect(formatWorkflowRunSnapshot(run)).not.toContain('/workflow rerun run-active');
    expect(formatWorkflowRunSnapshot(undefined)).toContain('unknown workflow');
  });

  it('selects an active run by default, then latest managed, then persisted run', () => {
    const managed = [
      {
        runId: 'run-completed',
        workflow: 'wf',
        status: 'completed' as const,
        runDir: '/tmp/run-completed',
        totalSpawned: 1,
        eventCount: 1,
        startedAt: 20,
      },
      {
        runId: 'run-active',
        workflow: 'wf',
        status: 'running' as const,
        runDir: '/tmp/run-active',
        totalSpawned: 1,
        eventCount: 1,
        startedAt: 10,
      },
    ];
    const persisted = [
      { runId: 'run-persisted', workflow: 'wf', status: 'completed', totalSpawned: 1, endedAt: 30 },
    ];

    expect(selectDefaultWorkflowRunId(managed, persisted)).toBe('run-active');
    expect(selectDefaultWorkflowRunId([managed[0]!], persisted)).toBe('run-completed');
    expect(selectDefaultWorkflowRunId([], persisted)).toBe('run-persisted');
    expect(selectDefaultWorkflowRunId([], [])).toBeUndefined();
  });

  it('reads run details from run.json plus events and surfaces failure context', () => {
    const runDir = join(dir, 'run-detail');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'run.json'), JSON.stringify({
      runId: 'run-detail',
      workflow: 'wf',
      status: 'failed',
      totalSpawned: 2,
      eventCount: 4,
      startedAt: 1,
      endedAt: 2,
      artifacts: ['report'],
    }), 'utf8');
    writeFileSync(join(runDir, 'events.jsonl'), [
      JSON.stringify({ seq: 0, type: 'phase_started', data: { name: 'audit' } }),
      JSON.stringify({ seq: 1, type: 'agent_spawned', data: { taskId: 't1', name: 'reader' } }),
      JSON.stringify({ seq: 2, type: 'workflow_failed', data: { error: 'boom' } }),
      '',
    ].join('\n'), 'utf8');

    const detail = readWorkflowRunDetail(dir, 'run-detail');
    expect(detail?.error).toBe('boom');
    expect(detail?.artifacts).toEqual(['report']);
    const out = formatWorkflowRunSnapshot(undefined, detail);
    expect(out).toContain('recent events');
    expect(out).toContain('phase: audit');
    expect(out).toContain('workflow failed: boom');
    expect(out).not.toContain('/workflow rerun run-detail');
  });

  it('shows rerun only for generated runs with script snapshots', () => {
    const runDir = join(dir, 'run-generated');
    mkdirSync(runDir, { recursive: true });
    const scriptPath = join(runDir, 'script.js');
    const manifestPath = join(runDir, 'manifest.json');
    writeFileSync(scriptPath, 'export default {};\n', 'utf8');
    writeFileSync(manifestPath, '{"name":"wf"}\n', 'utf8');
    writeFileSync(join(runDir, 'run.json'), JSON.stringify({
      runId: 'run-generated',
      workflow: 'wf',
      status: 'failed',
      totalSpawned: 1,
      eventCount: 1,
      startedAt: 1,
      endedAt: 2,
      artifacts: [],
      scriptSnapshotPath: scriptPath,
      manifestSnapshotPath: manifestPath,
    }), 'utf8');

    const detail = readWorkflowRunDetail(dir, 'run-generated');
    expect(detail?.canRerun).toBe(true);
    expect(formatWorkflowRunSnapshot(undefined, detail)).toContain('/workflow rerun run-generated');
  });

  it('requires run.json to declare both snapshot paths before offering rerun', () => {
    const runDir = join(dir, 'run-partial-snapshot');
    mkdirSync(runDir, { recursive: true });
    const scriptPath = join(runDir, 'script.js');
    const manifestPath = join(runDir, 'manifest.json');
    writeFileSync(scriptPath, 'export default {};\n', 'utf8');
    writeFileSync(manifestPath, '{"name":"wf"}\n', 'utf8');
    writeFileSync(join(runDir, 'run.json'), JSON.stringify({
      runId: 'run-partial-snapshot',
      workflow: 'wf',
      status: 'completed',
      totalSpawned: 1,
      eventCount: 0,
      startedAt: 1,
      endedAt: 2,
      artifacts: [],
      scriptSnapshotPath: scriptPath,
    }), 'utf8');

    const detail = readWorkflowRunDetail(dir, 'run-partial-snapshot');
    expect(detail?.canRerun).toBe(false);
    expect(formatWorkflowRunSnapshot(undefined, detail)).not.toContain('/workflow rerun run-partial-snapshot');
  });

  it('does not offer rerun for in-progress snapshots before run.json exists', () => {
    const runDir = join(dir, 'run-in-progress');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'script.js'), 'export default {};\n', 'utf8');
    writeFileSync(join(runDir, 'manifest.json'), '{"name":"wf"}\n', 'utf8');
    writeFileSync(join(runDir, 'events.jsonl'), [
      JSON.stringify({ seq: 0, type: 'phase_started', data: { name: 'audit' } }),
      '',
    ].join('\n'), 'utf8');

    const detail = readWorkflowRunDetail(dir, 'run-in-progress');
    expect(detail?.canRerun).toBe(false);
    expect(formatWorkflowRunSnapshot(undefined, detail)).not.toContain('/workflow rerun run-in-progress');
  });

  it('treats only running and paused managed runs as active', () => {
    const base = {
      runId: 'run-x',
      workflow: 'wf',
      runDir: '/tmp/run-x',
      totalSpawned: 1,
      eventCount: 1,
      startedAt: 1,
    };

    expect(isActiveManagedWorkflowRun({ ...base, status: 'running' })).toBe(true);
    expect(isActiveManagedWorkflowRun({ ...base, status: 'paused' })).toBe(true);
    expect(isActiveManagedWorkflowRun({ ...base, status: 'failed' })).toBe(false);
    expect(isActiveManagedWorkflowRun({ ...base, status: 'completed' })).toBe(false);
    expect(isActiveManagedWorkflowRun({ ...base, status: 'stopped' })).toBe(false);
    expect(isActiveManagedWorkflowRun({ ...base, status: 'denied' })).toBe(false);
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
    expect(text).toContain('--limit N');
    expect(text).toContain('/workflow show [runId]');
    expect(text).toContain('/workflow pause <runId>');
    expect(text).toContain('/workflow resume <runId>');
    expect(text).toContain('/workflow stop <runId>');
    expect(text).toContain('/workflow delete <runId>');
    expect(text).toContain('/workflow prune');
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

describe('startGeneratedWorkflowFromRequest launch policy', () => {
  it('auto-starts capability-generated workflows without confirmation when approval is silent', async () => {
    const confirm = vi.fn(async () => false);
    const generateWorkflow = vi.fn(async () => fakeGeneratedWorkflow());
    const builderStages: string[] = [];
    const runMessages: Array<{ readonly type: string; readonly text: string }> = [];
    type WorkflowHandlerCallbacks = Parameters<typeof workflowCommand.handler>[2];
    type WorkflowRunUpdate = Parameters<NonNullable<WorkflowHandlerCallbacks['onWorkflowRunUpdate']>>[0];
    const runUpdates: WorkflowRunUpdate[] = [];

    const outcome = await startGeneratedWorkflowFromRequest({
      request: 'Generate a parallel audit workflow',
      approval: 'silent',
      callbacks: {
        confirm,
        createKodaXOptions: () => ({}) as ReturnType<NonNullable<WorkflowHandlerCallbacks['createKodaXOptions']>>,
        onWorkflowRunMessage: (event) => runMessages.push(event),
        onWorkflowRunUpdate: (event) => runUpdates.push(event),
      },
      generateWorkflow,
      onBuilderEvent: (event) => builderStages.push(event.stage),
    });

    expect(outcome).toBe('started');
    expect(confirm).not.toHaveBeenCalled();
    expect(generateWorkflow).toHaveBeenCalledOnce();
    expect(builderStages).toEqual(['started', 'generating', 'validating', 'ready', 'launched']);
    await vi.waitFor(() => {
      expect(runMessages.some((event) => event.text.includes('Workflow completed'))).toBe(true);
    });
    expect(runUpdates.some((event) => event.status === 'running' && event.workflow === 'generated-fast-audit')).toBe(true);
    expect(runUpdates.at(-1)?.status).toBe('completed');
    expect(runMessages.some((event) => event.type === 'info' && event.text.includes('Generate a parallel audit workflow'))).toBe(true);
  });

  it('requires confirmation only when the caller asks for approval', async () => {
    const confirm = vi.fn(async () => false);
    type WorkflowHandlerCallbacks = Parameters<typeof workflowCommand.handler>[2];

    const outcome = await startGeneratedWorkflowFromRequest({
      request: 'Generate a parallel audit workflow',
      approval: 'required',
      callbacks: {
        confirm,
        createKodaXOptions: () => ({}) as ReturnType<NonNullable<WorkflowHandlerCallbacks['createKodaXOptions']>>,
      },
      generateWorkflow: async () => fakeGeneratedWorkflow(),
    });

    expect(outcome).toBe('cancelled');
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0]?.[0]).toContain('raw script:');
  });

  it('emits a builder failure event when workflow generation fails', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const builderEvents: Array<{ readonly stage: string; readonly message: string }> = [];
    type WorkflowHandlerCallbacks = Parameters<typeof workflowCommand.handler>[2];

    const outcome = await startGeneratedWorkflowFromRequest({
      request: 'Generate a parallel audit workflow',
      approval: 'silent',
      callbacks: {
        createKodaXOptions: () => ({}) as ReturnType<NonNullable<WorkflowHandlerCallbacks['createKodaXOptions']>>,
      },
      generateWorkflow: async () => {
        throw new Error('workflow generation failed (timeout after 120000ms): This operation was aborted');
      },
      onBuilderEvent: (event) => builderEvents.push({ stage: event.stage, message: event.message }),
    });

    const output = logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    logSpy.mockRestore();
    expect(outcome).toBe('failed');
    expect(builderEvents.at(-1)).toEqual({
      stage: 'failed',
      message: 'workflow generation failed (timeout after 120000ms): This operation was aborted',
    });
    expect(output).toContain('builder failed');
    expect(output).toContain('timeout after 120000ms');
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
