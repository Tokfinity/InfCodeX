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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  parseWorkflowInvocation,
  parseWorkflowArgs,
  formatWorkflowList,
  renderApprovalPrompt,
  readWorkflowRuns,
  formatRunsList,
  savedWorkflowDirs,
  formatSavedList,
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
});

describe('saved workflow dirs + formatting', () => {
  it('derives project + personal dirs from cwd', () => {
    const dirs = savedWorkflowDirs('/repo');
    expect(dirs.project).toContain('.kodax');
    expect(dirs.project).toContain('workflows');
    expect(dirs.personal).toContain('workflows');
  });
  it('formats saved workflow refs with source + path', () => {
    const out = formatSavedList([{ name: 'audit', path: '/p/.kodax/workflows/audit.ts', source: 'project' }]);
    expect(out).toContain('audit');
    expect(out).toContain('project');
  });
  it('handles empty saved list', () => {
    expect(formatSavedList([])).toContain('no saved');
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
  });
});
