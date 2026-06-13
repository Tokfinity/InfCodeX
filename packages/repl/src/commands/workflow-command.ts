/**
 * FEATURE_217 (v0.7.49) Phase D.2 — `/workflow` slash command.
 *
 * Surfaces the Dynamic Workflow Harness in the REPL:
 *   /workflow [list]        — list built-in + saved workflows
 *   /workflow runs          — list this project's workflow runs
 *   /workflow rerun <runId> — rerun a generated workflow from run history
 *   /workflow <name> [args] — run a built-in OR saved workflow (with approval)
 *
 * Resolves a built-in workflow first; otherwise loads a saved
 * `.kodax/workflows` / `~/.kodax/workflows` file behind a trusted-local
 * execution confirmation (loading runs local code). Execution routes
 * through `runWorkflowFromOptions` in `@kodax-ai/coding`, which builds the
 * tool-execution context internally — the command only supplies plain
 * `KodaXOptions` (from `createKodaXOptions`) + an interactive confirm
 * (`callbacks.confirm`, falling back to a readline `(y/N)` prompt).
 *
 * Pure helpers (parse / list / runs / approval text) are exported for
 * unit testing; the handler is a thin wiring layer.
 */

import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

import chalk from 'chalk';
import { getAgentConfigPath } from '@kodax-ai/agent';
import type {
  WorkflowApprovalSummary,
  WorkflowEvent,
  WorkflowMeta,
  WorkflowModule,
  WorkflowScriptManifest,
} from '@kodax-ai/agent';
import {
  buildApprovalSummary,
  getBuiltinWorkflow,
  listBuiltinWorkflows,
  listWorkflowPatternTemplates,
  discoverSavedWorkflows,
  generateWorkflowFromOptions,
  getDefaultWorkflowRunManager,
  loadGeneratedWorkflowFromRun,
  loadSavedWorkflow,
  loadSavedWorkflowCapsule,
  preflightWorkflowCapsule,
  saveGeneratedWorkflowFromRun,
  type ManagedWorkflowRun,
  type ManagedWorkflowSnapshot,
  type SavedWorkflowDirs,
  type SavedWorkflowRef,
} from '@kodax-ai/coding';

import { deriveProjectKeyFromRoot } from '../interactive/project-key.js';
import type { Command, CommandCallbacks } from './types.js';

/* ----------------------------- pure helpers ----------------------------- */

export type WorkflowInvocation =
  | { readonly kind: 'help' }
  | { readonly kind: 'list' }
  | { readonly kind: 'runs'; readonly rawArgs: readonly string[] }
  | { readonly kind: 'show'; readonly runId: string }
  | { readonly kind: 'pause'; readonly runId: string }
  | { readonly kind: 'resume'; readonly runId: string }
  | { readonly kind: 'stop'; readonly runId: string }
  | { readonly kind: 'delete'; readonly runId: string }
  | { readonly kind: 'prune'; readonly rawArgs: readonly string[] }
  | { readonly kind: 'save'; readonly runId: string; readonly name: string }
  | { readonly kind: 'rerun'; readonly runId: string; readonly rawArgs: string }
  | { readonly kind: 'create'; readonly request: string }
  | { readonly kind: 'start'; readonly name: string; readonly rawArgs: string };

export const DEFAULT_WORKFLOW_RUNS_LIMIT = 20;
export const DEFAULT_WORKFLOW_PRUNE_KEEP = 50;
const MAX_WORKFLOW_RUNS_LIMIT = 200;
const TERMINAL_WORKFLOW_STATUSES = new Set(['completed', 'failed', 'stopped', 'denied']);

export function parseWorkflowInvocation(args: readonly string[]): WorkflowInvocation {
  const first = args[0]?.toLowerCase();
  if (first === 'help' || first === '--help' || first === '-h') return { kind: 'help' };
  if (!first || first === 'list') return { kind: 'list' };
  if (first === 'runs') return { kind: 'runs', rawArgs: args.slice(1) };
  if (first === 'show') return { kind: 'show', runId: args[1] ?? '' };
  if (first === 'pause') return { kind: 'pause', runId: args[1] ?? '' };
  if (first === 'resume') return { kind: 'resume', runId: args[1] ?? '' };
  if (first === 'stop') return { kind: 'stop', runId: args[1] ?? '' };
  if (first === 'delete') return { kind: 'delete', runId: args[1] ?? '' };
  if (first === 'prune') return { kind: 'prune', rawArgs: args.slice(1) };
  if (first === 'save') return { kind: 'save', runId: args[1] ?? '', name: args[2] ?? '' };
  if (first === 'rerun') {
    return { kind: 'rerun', runId: args[1] ?? '', rawArgs: args.slice(2).join(' ').trim() };
  }
  if (first === 'create') return { kind: 'create', request: args.slice(1).join(' ').trim() };
  return { kind: 'start', name: args[0]!, rawArgs: args.slice(1).join(' ').trim() };
}

/** Parse the trailing args: JSON object, or bare text → `{ question }`. */
export function parseWorkflowArgs(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return { question: trimmed };
    }
  }
  return { question: trimmed };
}

function parseNonNegativeInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export interface WorkflowRunsOptions {
  readonly all: boolean;
  readonly limit: number;
  readonly error?: string;
}

export function parseWorkflowRunsOptions(args: readonly string[]): WorkflowRunsOptions {
  let all = false;
  let limit = DEFAULT_WORKFLOW_RUNS_LIMIT;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--all') {
      all = true;
      continue;
    }
    if (arg === '--limit') {
      const parsed = parseNonNegativeInteger(args[index + 1]);
      if (parsed === undefined || parsed < 1) {
        return { all, limit, error: '--limit expects a positive integer' };
      }
      limit = Math.min(parsed, MAX_WORKFLOW_RUNS_LIMIT);
      index += 1;
      continue;
    }
    return { all, limit, error: `unknown option: ${arg ?? ''}` };
  }

  return { all, limit };
}

export interface WorkflowPruneOptions {
  readonly dryRun: boolean;
  readonly keep?: number;
  readonly olderThanMs?: number;
  readonly error?: string;
}

function parseOlderThanMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^(\d+)([dh]?)$/i.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isInteger(amount) || amount <= 0) return undefined;
  const unit = match[2]?.toLowerCase() || 'd';
  if (unit === 'h') return amount * 60 * 60 * 1000;
  return amount * 24 * 60 * 60 * 1000;
}

export function parseWorkflowPruneOptions(args: readonly string[]): WorkflowPruneOptions {
  let dryRun = false;
  let keep: number | undefined;
  let olderThanMs: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--keep') {
      const parsed = parseNonNegativeInteger(args[index + 1]);
      if (parsed === undefined) {
        return { dryRun, error: '--keep expects a non-negative integer' };
      }
      keep = parsed;
      index += 1;
      continue;
    }
    if (arg === '--older-than') {
      const parsed = parseOlderThanMs(args[index + 1]);
      if (parsed === undefined) {
        return { dryRun, error: '--older-than expects a value like 7d or 24h' };
      }
      olderThanMs = parsed;
      index += 1;
      continue;
    }
    return { dryRun, error: `unknown option: ${arg ?? ''}` };
  }

  if (dryRun && keep === undefined && olderThanMs === undefined) {
    return { dryRun, keep: DEFAULT_WORKFLOW_PRUNE_KEEP };
  }

  return {
    dryRun,
    ...(keep !== undefined ? { keep } : {}),
    ...(olderThanMs !== undefined ? { olderThanMs } : {}),
  };
}

export function formatWorkflowList(metas: readonly WorkflowMeta[]): string {
  if (metas.length === 0) return '  (no built-in workflows)';
  return metas.map((m) => `  ${chalk.cyan(m.name)} — ${m.description}`).join('\n');
}

export interface WorkflowApprovalRenderContext {
  readonly source: string;
  readonly sandbox: string;
  readonly mayUseWorktree: boolean;
  readonly rawScriptPath?: string;
  readonly rawScript?: string;
}

export function renderApprovalPrompt(
  summary: WorkflowApprovalSummary,
  context?: WorkflowApprovalRenderContext,
): string {
  const cap = (n: number | null): string => (n === null ? '∞' : String(n));
  return [
    `Run workflow ${chalk.cyan(summary.name)}?`,
    `  ${summary.description}`,
    `  phases: ${summary.phases.length > 0 ? summary.phases.join(' → ') : '(dynamic)'}`,
    `  agent total cap: ${cap(summary.maxAgents)} · max concurrency: ${cap(summary.maxConcurrency)} · token budget: ${cap(summary.tokenBudget)}`,
    `  writes files: ${summary.writesFiles ? chalk.yellow('yes') : 'no (read-only)'}`,
    ...(context
      ? [
          `  source: ${context.source}`,
          `  sandbox/trust: ${context.sandbox}`,
          `  worktree isolation: ${context.mayUseWorktree ? 'may request worktree' : 'shared cwd / per-child default'}`,
          ...(context.rawScriptPath ? [`  raw script: ${context.rawScriptPath}`] : []),
          ...(context.rawScript
            ? ['  raw script:', ...context.rawScript.split('\n').map((line) => `    ${line}`)]
            : []),
        ]
      : []),
  ].join('\n');
}

export interface WorkflowRunSummary {
  readonly runId: string;
  readonly workflow: string;
  readonly status: string;
  readonly totalSpawned: number;
  readonly endedAt: number;
}

export interface WorkflowRunDetail {
  readonly runId: string;
  readonly workflow: string;
  readonly status: string;
  readonly totalSpawned: number;
  readonly eventCount: number;
  readonly runDir: string;
  readonly canRerun: boolean;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly error?: string;
  readonly artifacts: readonly string[];
  readonly events: readonly WorkflowEvent[];
}

/** Read every `<runId>/run.json` under a project's workflow-runs dir. */
export function readWorkflowRuns(baseDir: string): WorkflowRunSummary[] {
  if (!existsSync(baseDir)) return [];
  const runs: WorkflowRunSummary[] = [];
  for (const entry of readdirSync(baseDir)) {
    const runJsonPath = join(baseDir, entry, 'run.json');
    if (!existsSync(runJsonPath)) continue;
    try {
      const data = JSON.parse(readFileSync(runJsonPath, 'utf8')) as Record<string, unknown>;
      runs.push({
        runId: entry,
        workflow: typeof data.workflow === 'string' ? data.workflow : '?',
        status: typeof data.status === 'string' ? data.status : '?',
        totalSpawned: typeof data.totalSpawned === 'number' ? data.totalSpawned : 0,
        endedAt: typeof data.endedAt === 'number' ? data.endedAt : 0,
      });
    } catch {
      // skip malformed run.json
    }
  }
  return runs.sort((a, b) => b.endedAt - a.endedAt);
}

function readWorkflowEvents(runDir: string): WorkflowEvent[] {
  const eventsPath = join(runDir, 'events.jsonl');
  if (!existsSync(eventsPath)) return [];
  const lines = readFileSync(eventsPath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  const events: WorkflowEvent[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (typeof parsed !== 'object' || parsed === null) continue;
      const record = parsed as Record<string, unknown>;
      if (typeof record.seq !== 'number' || typeof record.type !== 'string') continue;
      const data = record.data;
      events.push({
        seq: record.seq,
        type: record.type as WorkflowEvent['type'],
        ...(typeof data === 'object' && data !== null
          ? { data: data as Record<string, unknown> }
          : {}),
      });
    } catch {
      // A partially written event line should not make the whole run unreadable.
    }
  }
  return events;
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function hasGeneratedWorkflowSnapshot(
  runDir: string,
  data?: Record<string, unknown>,
): boolean {
  const scriptPath = data
    ? readNonEmptyString(data.scriptSnapshotPath)
    : join(runDir, 'script.js');
  const manifestPath = data
    ? readNonEmptyString(data.manifestSnapshotPath)
    : join(runDir, 'manifest.json');
  if (!scriptPath || !manifestPath) return false;
  return existsSync(scriptPath) && existsSync(manifestPath);
}

function hasRerunnableGeneratedWorkflowRun(
  runDir: string,
  data?: Record<string, unknown>,
): boolean {
  if (data) return hasGeneratedWorkflowSnapshot(runDir, data);
  const runJsonPath = join(runDir, 'run.json');
  if (!existsSync(runJsonPath)) return false;
  try {
    const parsed = JSON.parse(readFileSync(runJsonPath, 'utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null
      ? hasGeneratedWorkflowSnapshot(runDir, parsed as Record<string, unknown>)
      : false;
  } catch {
    return false;
  }
}

function readWorkflowFailure(events: readonly WorkflowEvent[]): string | undefined {
  for (const event of [...events].reverse()) {
    if (event.type !== 'workflow_failed') continue;
    const error = event.data?.error;
    if (typeof error === 'string' && error.trim().length > 0) return error;
  }
  return undefined;
}

export function readWorkflowRunDetail(baseDir: string, runId: string): WorkflowRunDetail | undefined {
  const runDir = join(baseDir, runId);
  const runJsonPath = join(runDir, 'run.json');
  const events = readWorkflowEvents(runDir);
  const failure = readWorkflowFailure(events);
  if (!existsSync(runJsonPath) && events.length === 0) return undefined;

  if (!existsSync(runJsonPath)) {
    return {
      runId,
      workflow: '?',
      status: failure ? 'failed' : 'running',
      totalSpawned: events.filter((event) => event.type === 'agent_spawned').length,
      eventCount: events.length,
      runDir,
      canRerun: false,
      artifacts: [],
      events,
      ...(failure ? { error: failure } : {}),
    };
  }

  try {
    const data = JSON.parse(readFileSync(runJsonPath, 'utf8')) as Record<string, unknown>;
    return {
      runId: typeof data.runId === 'string' ? data.runId : runId,
      workflow: typeof data.workflow === 'string' ? data.workflow : '?',
      status: typeof data.status === 'string' ? data.status : '?',
      totalSpawned: typeof data.totalSpawned === 'number' ? data.totalSpawned : 0,
      eventCount: typeof data.eventCount === 'number' ? data.eventCount : events.length,
      runDir,
      canRerun: hasRerunnableGeneratedWorkflowRun(runDir, data),
      ...(typeof data.startedAt === 'number' ? { startedAt: data.startedAt } : {}),
      ...(typeof data.endedAt === 'number' ? { endedAt: data.endedAt } : {}),
      ...(failure ? { error: failure } : {}),
      artifacts: readStringArray(data.artifacts),
      events,
    };
  } catch {
    return {
      runId,
      workflow: '?',
      status: failure ? 'failed' : 'unknown',
      totalSpawned: events.filter((event) => event.type === 'agent_spawned').length,
      eventCount: events.length,
      runDir,
      canRerun: false,
      artifacts: [],
      events,
      ...(failure ? { error: failure } : {}),
    };
  }
}

function statusIcon(status: string): string {
  if (status === 'completed') return chalk.green('ok');
  if (status === 'failed') return chalk.red('x');
  if (status === 'running') return chalk.cyan('run');
  if (status === 'paused') return chalk.yellow('pause');
  if (status === 'stopped') return chalk.dim('stop');
  if (status === 'denied') return chalk.dim('deny');
  return chalk.dim('-');
}

export function isTerminalWorkflowStatus(status: string): boolean {
  return TERMINAL_WORKFLOW_STATUSES.has(status);
}

export interface WorkflowRunsListFormatOptions {
  readonly limit?: number;
  readonly showLimitHint?: boolean;
}

export function formatRunsList(
  runs: readonly WorkflowRunSummary[],
  options: WorkflowRunsListFormatOptions = {},
): string {
  if (runs.length === 0) return '  (no workflow runs yet)';
  const limit = options.limit === undefined
    ? undefined
    : Math.max(1, Math.floor(options.limit));
  const visibleRuns = limit === undefined ? runs : runs.slice(0, limit);
  const lines = visibleRuns
    .map(
      (r) =>
        `  ${statusIcon(r.status)} ${chalk.cyan(r.workflow)} ${chalk.dim(r.runId)} — ${r.status} (${r.totalSpawned} agents)`,
    );
  if (options.showLimitHint === true && limit !== undefined && runs.length > visibleRuns.length) {
    lines.push(
      chalk.dim(`  Showing ${visibleRuns.length} of ${runs.length} persisted runs. Use /workflow runs --all to show all.`),
    );
  }
  return lines.join('\n');
}

export function formatManagedRunsList(runs: readonly ManagedWorkflowSnapshot[]): string {
  if (runs.length === 0) return '  (no active workflow runs)';
  return runs
    .map(
      (r) =>
        `  ${statusIcon(r.status)} ${chalk.cyan(r.workflow)} ${chalk.dim(r.runId)} - ${r.status} (${r.totalSpawned} agents, ${r.eventCount} events)`,
    )
    .join('\n');
}

export function isActiveManagedWorkflowRun(run: ManagedWorkflowSnapshot): boolean {
  return run.status === 'running' || run.status === 'paused';
}

export interface WorkflowPruneCandidate {
  readonly runId: string;
  readonly workflow: string;
  readonly status: string;
  readonly endedAt: number;
}

export function selectWorkflowPruneCandidates(
  runs: readonly WorkflowRunSummary[],
  options: WorkflowPruneOptions,
  now = Date.now(),
): readonly WorkflowPruneCandidate[] {
  const terminalRuns = runs
    .filter((run) => isTerminalWorkflowStatus(run.status))
    .sort((a, b) => b.endedAt - a.endedAt);
  const keepProtected = options.keep === undefined
    ? new Set<string>()
    : new Set(terminalRuns.slice(0, options.keep).map((run) => run.runId));
  const hasKeepRule = options.keep !== undefined;
  const hasAgeRule = options.olderThanMs !== undefined;
  const cutoff = options.olderThanMs === undefined ? undefined : now - options.olderThanMs;

  if (!hasKeepRule && !hasAgeRule) {
    return [];
  }

  return terminalRuns
    .filter((run) => {
      const keepMatches = hasKeepRule ? !keepProtected.has(run.runId) : true;
      const ageMatches = cutoff === undefined
        ? true
        : run.endedAt > 0 && run.endedAt < cutoff;
      return keepMatches && ageMatches;
    })
    .map((run) => ({
      runId: run.runId,
      workflow: run.workflow,
      status: run.status,
      endedAt: run.endedAt,
    }));
}

export function formatWorkflowPruneCandidates(
  candidates: readonly WorkflowPruneCandidate[],
): string {
  if (candidates.length === 0) return '  (no workflow runs match the cleanup rule)';
  return candidates
    .map((run) =>
      `  ${statusIcon(run.status)} ${chalk.cyan(run.workflow)} ${chalk.dim(run.runId)} - ${run.status}`,
    )
    .join('\n');
}

export function selectDefaultWorkflowRunId(
  managedRuns: readonly ManagedWorkflowSnapshot[],
  persistedRuns: readonly WorkflowRunSummary[],
): string | undefined {
  const active = managedRuns.filter(isActiveManagedWorkflowRun)[0];
  return active?.runId ?? managedRuns[0]?.runId ?? persistedRuns[0]?.runId;
}

function formatTime(value: number | undefined): string | undefined {
  return value === undefined ? undefined : new Date(value).toLocaleString();
}

function formatRecentWorkflowEvents(events: readonly WorkflowEvent[], limit = 10): readonly string[] {
  const rendered = events
    .map(formatWorkflowEvent)
    .filter((line): line is string => line !== undefined);
  return rendered.slice(Math.max(0, rendered.length - limit));
}

function canRerunWorkflowRun(
  run: ManagedWorkflowSnapshot | undefined,
  detail: WorkflowRunDetail | undefined,
): boolean {
  return detail?.canRerun ?? (run?.runDir ? hasRerunnableGeneratedWorkflowRun(run.runDir) : false);
}

function formatWorkflowNextActions(runId: string, canRerun: boolean): string {
  return canRerun
    ? `/workflow show ${runId} | /workflow rerun ${runId}`
    : `/workflow show ${runId}`;
}

function formatWorkflowFailureAction(runId: string, canRerun: boolean): string {
  return canRerun
    ? `Use /workflow show ${runId} for events, or /workflow rerun ${runId} after adjusting the request.`
    : `Use /workflow show ${runId} for events.`;
}

export function formatWorkflowRunSnapshot(
  run: ManagedWorkflowSnapshot | undefined,
  detail?: WorkflowRunDetail,
): string {
  if (!run && !detail) return '  (unknown workflow run)';
  const workflow = run?.workflow ?? detail?.workflow ?? '?';
  const runId = run?.runId ?? detail?.runId ?? '?';
  const status = run?.status ?? detail?.status ?? '?';
  const totalSpawned = run?.totalSpawned ?? detail?.totalSpawned ?? 0;
  const eventCount = run?.eventCount ?? detail?.eventCount ?? 0;
  const runDir = run?.runDir ?? detail?.runDir ?? '';
  const startedAt = formatTime(run?.startedAt ?? detail?.startedAt);
  const endedAt = formatTime(run?.endedAt ?? detail?.endedAt);
  const error = run?.error ?? detail?.error;
  const resultText = run?.resultText;
  const artifacts = detail?.artifacts ?? [];
  const recentEvents = detail ? formatRecentWorkflowEvents(detail.events) : [];
  const canRerun = canRerunWorkflowRun(run, detail);
  return [
    `  ${chalk.cyan(workflow)} ${chalk.dim(runId)}`,
    `  status: ${status}`,
    `  agents: ${totalSpawned}`,
    `  events: ${eventCount}`,
    ...(startedAt ? [`  started: ${startedAt}`] : []),
    ...(endedAt ? [`  ended: ${endedAt}`] : []),
    ...(runDir ? [`  run dir: ${runDir}`] : []),
    ...(artifacts.length > 0 ? [`  artifacts: ${artifacts.join(', ')}`] : []),
    ...(error ? [`  error: ${error}`] : []),
    ...(resultText ? ['', '  result:', ...resultText.split('\n').map((line) => `    ${line}`)] : []),
    ...(recentEvents.length > 0
      ? ['', '  recent events:', ...recentEvents.map((event) => `  ${event.trimEnd()}`)]
      : []),
    '',
    `  next: ${formatWorkflowNextActions(runId, canRerun)}`,
  ].join('\n');
}

/** Project + personal saved-workflow directories for the current cwd. */
export function savedWorkflowDirs(cwd: string): SavedWorkflowDirs {
  return {
    project: join(cwd, '.kodax', 'workflows'),
    personal: getAgentConfigPath('workflows'),
  };
}

export function formatSavedList(refs: readonly SavedWorkflowRef[]): string {
  if (refs.length === 0) return '  (no saved workflows)';
  return refs
    .map((r) => `  ${chalk.cyan(r.name)} ${chalk.dim(`(${r.source}, ${r.execution}: ${r.path})`)}`)
    .join('\n');
}

export function isSafeWorkflowRunId(runId: string): boolean {
  return (
    /^[a-zA-Z0-9._-]{1,120}$/.test(runId) &&
    !runId.startsWith('.') &&
    !runId.includes('..')
  );
}

export function renderWorkflowHelp(): string {
  return [
    `${chalk.bold('/workflow')} - dynamic multi-agent workflow harness`,
    '',
    `${chalk.bold('Subcommands:')}`,
    `  ${chalk.cyan('/workflow list')}                         List built-in, pattern, and saved workflows. Alias: /workflow`,
    `  ${chalk.cyan('/workflow create <request>')}             Generate a restricted workflow from a complex request.`,
    `  ${chalk.cyan('/workflow <name> [args]')}                Run a built-in or saved workflow. Args may be JSON or bare text.`,
    `  ${chalk.cyan('/workflow runs [--all|--limit N]')}       List active and recent workflow runs for this project.`,
    `  ${chalk.cyan('/workflow show [runId]')}                 Show the latest run, or a specific run with events and errors.`,
    `  ${chalk.cyan('/workflow pause <runId>')}                Pause future child launches for an active run.`,
    `  ${chalk.cyan('/workflow resume <runId>')}               Resume a paused run.`,
    `  ${chalk.cyan('/workflow stop <runId>')}                 Stop an active run through abort propagation.`,
    `  ${chalk.cyan('/workflow delete <runId>')}               Delete one persisted run record.`,
    `  ${chalk.cyan('/workflow prune --dry-run|--keep N|--older-than Nd')}`,
    `                                            Preview or delete old terminal run records.`,
    `  ${chalk.cyan('/workflow rerun <runId> [args]')}         Rerun a generated workflow from run history without saving it.`,
    `  ${chalk.cyan('/workflow save <runId> <name>')}          Save a generated run as a workflow capsule.`,
    `  ${chalk.cyan('/workflow help')}                         Show this help. Also available as /help workflow.`,
    '',
    `${chalk.bold('Examples:')}`,
    `  ${chalk.dim('/workflow create Compare three flaky-test hypotheses and verify each one')}`,
    `  ${chalk.dim('/workflow parallel-investigation {"question":"请检查这个竞态在哪里","targets":["packages/agent"]}')}`,
    `  ${chalk.dim('/workflow rerun run-lx3 {"request":"请用同样流程复查 packages/repl"}')}`,
    `  ${chalk.dim('/workflow prune --dry-run')}`,
    `  ${chalk.dim('/workflow save run-lx3 generated-audit')}`,
    '',
    `${chalk.bold('Safety:')}`,
    '  - Generated and workflow capsule (.workflow.json) workflows run in the capability WorkflowApi runner.',
    '  - Local .ts/.mjs/.js workflows are trusted-local and require explicit confirmation.',
    '  - File, shell, MCP, and web effects still go through child agents and existing permission gates.',
  ].join('\n');
}

function printWorkflowHelp(): void {
  console.log(`\n${renderWorkflowHelp()}\n`);
}

export type ConfirmFn = (message: string) => Promise<boolean>;

/**
 * Resolve an interactive confirmation function. Prefers `callbacks.confirm`;
 * falls back to a readline `(y/N)` prompt (the REPL always passes
 * `callbacks.readline`). Returns undefined only in a non-interactive
 * context — callers MUST fail safe (never execute local code) when so.
 */
export function resolveConfirm(callbacks: {
  readonly confirm?: ConfirmFn;
  readonly readline?: { question: (query: string, cb: (answer: string) => void) => void };
}): ConfirmFn | undefined {
  if (callbacks.confirm) return callbacks.confirm;
  const rl = callbacks.readline;
  if (rl) {
    return (message: string) =>
      new Promise<boolean>((resolve) => {
        rl.question(`${message} (y/N) `, (answer) => resolve(/^y(es)?$/i.test(answer.trim())));
      });
  }
  return undefined;
}

function printInvalidRunId(runId: string): void {
  console.log(chalk.red(`\n[workflow] invalid run id: ${runId || '<empty>'}\n`));
}

function ensureSafeRunId(runId: string): boolean {
  if (isSafeWorkflowRunId(runId)) return true;
  printInvalidRunId(runId);
  return false;
}

function currentWorkflowPreflightEnv(): {
  readonly isGitRepo: boolean;
  readonly worktreeCapable: boolean;
} {
  const gitMarker = hasGitMarker(process.cwd());
  return {
    isGitRepo: gitMarker,
    worktreeCapable: gitMarker,
  };
}

function hasGitMarker(startDir: string): boolean {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, '.git'))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

function printPreflightFailure(result: ReturnType<typeof preflightWorkflowCapsule>): void {
  console.log(chalk.red('\n[workflow] capsule preflight failed:'));
  for (const issue of result.issues) {
    console.log(chalk.red(`  - ${issue.requirement}: ${issue.message}`));
  }
  console.log();
}

function printPreflightWarnings(result: ReturnType<typeof preflightWorkflowCapsule>): void {
  const warnings = result.issues.filter((issue) => issue.severity === 'warning');
  if (warnings.length === 0) return;
  console.log(chalk.yellow('\n[workflow] capsule preflight warnings:'));
  for (const issue of warnings) {
    console.log(chalk.yellow(`  - ${issue.requirement}: ${issue.message}`));
  }
  console.log();
}

/* ------------------------------- command -------------------------------- */

function workflowEventStatus(event: WorkflowEvent): string | undefined {
  const status = event.data?.status;
  return typeof status === 'string' ? status : undefined;
}

function formatWorkflowEvent(event: WorkflowEvent): string | undefined {
  const label = event.data?.name ?? event.data?.taskId ?? '';
  const status = workflowEventStatus(event);
  switch (event.type) {
    case 'phase_started':
      return `  > phase: ${event.data?.name ?? ''}`;
    case 'phase_finished':
      return `    done phase: ${event.data?.name ?? ''}`;
    case 'agent_spawned':
      return `    + ${label}`;
    case 'agent_completed':
      return status === 'failed'
        ? `    failed ${label}`
        : `    done ${label}`;
    case 'agent_stopped':
      return `    stopped ${label}`;
    case 'artifact_written':
      return `    artifact ${event.data?.name ?? ''}`;
    case 'synthesis_completed':
      return '  synthesis complete';
    case 'workflow_completed':
      return '  workflow completed';
    case 'workflow_failed':
      return `  workflow failed: ${event.data?.error ?? 'unknown error'}`;
    default:
      return undefined;
  }
}

function renderWorkflowEvent(event: WorkflowEvent): void {
  const text = formatWorkflowEvent(event);
  if (text) console.log(chalk.dim(text));
}

function formatResult(result: unknown): string | undefined {
  if (typeof result === 'string' && result.trim().length > 0) {
    return result;
  }
  if (result && typeof result === 'object' && 'synthesis' in result) {
    const synthesis = (result as { synthesis?: unknown }).synthesis;
    if (typeof synthesis === 'string') return synthesis;
    if (synthesis && typeof synthesis === 'object' && 'text' in synthesis) {
      const text = (synthesis as { text?: unknown }).text;
      if (typeof text === 'string' && text.trim().length > 0) return text;
    }
  }
  if (result && typeof result === 'object') {
    for (const key of ['summary', 'report', 'text', 'result']) {
      const value = (result as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        return value;
      }
    }
  }
  return undefined;
}

type WorkflowRunMessageCallback = NonNullable<CommandCallbacks['onWorkflowRunMessage']>;
type WorkflowRunUpdateCallback = NonNullable<CommandCallbacks['onWorkflowRunUpdate']>;

function emitWorkflowRunMessage(
  callbacks: Pick<CommandCallbacks, 'onWorkflowRunMessage'>,
  event: Parameters<WorkflowRunMessageCallback>[0],
): void {
  if (callbacks.onWorkflowRunMessage) {
    callbacks.onWorkflowRunMessage(event);
    return;
  }
  if (event.type === 'error') {
    console.log(chalk.red(`\n${event.text}\n`));
    return;
  }
  if (event.type === 'success') {
    console.log(chalk.green(`\n${event.text}\n`));
    return;
  }
  if (event.type === 'event') {
    console.log(chalk.dim(event.text));
    return;
  }
  console.log(chalk.dim(`\n${event.text}\n`));
}

function workflowEventSink(
  callbacks: Pick<CommandCallbacks, 'onWorkflowRunMessage'>,
  live?: WorkflowLiveUpdateEmitter,
): (event: WorkflowEvent) => void {
  return (event) => {
    live?.onEvent(event);
    const text = formatWorkflowEvent(event);
    if (!text) return;
    if (callbacks.onWorkflowRunMessage) {
      emitWorkflowRunMessage(callbacks, { type: 'event', text });
      return;
    }
    renderWorkflowEvent(event);
  };
}

interface WorkflowLiveUpdateEmitter {
  onEvent(event: WorkflowEvent): void;
  complete(status: 'completed' | 'failed' | 'stopped', message?: string): void;
  running(message?: string): void;
}

function createWorkflowLiveUpdateEmitter(
  callbacks: Pick<CommandCallbacks, 'onWorkflowRunUpdate'>,
  runId: string,
  workflow: string,
): WorkflowLiveUpdateEmitter {
  const activeAgents = new Map<string, string>();
  let phase: string | undefined;
  let totalSpawned = 0;
  let completedAgents = 0;
  let failedAgents = 0;
  let stoppedAgents = 0;

  const emit = (
    status: Parameters<WorkflowRunUpdateCallback>[0]['status'],
    message?: string,
  ): void => {
    callbacks.onWorkflowRunUpdate?.({
      runId,
      workflow,
      status,
      ...(phase !== undefined ? { phase } : {}),
      activeAgents: [...activeAgents.values()],
      totalSpawned,
      completedAgents,
      failedAgents,
      stoppedAgents,
      ...(message !== undefined ? { message } : {}),
    });
  };

  return {
    running: (message) => emit('running', message),
    onEvent: (event) => {
      switch (event.type) {
        case 'phase_started': {
          const name = event.data?.name;
          phase = typeof name === 'string' ? name : phase;
          emit('running');
          break;
        }
        case 'agent_spawned': {
          const taskId = typeof event.data?.taskId === 'string'
            ? event.data.taskId
            : `task-${totalSpawned + 1}`;
          const name = typeof event.data?.name === 'string' ? event.data.name : taskId;
          activeAgents.set(taskId, name);
          totalSpawned += 1;
          emit('running');
          break;
        }
        case 'agent_completed': {
          const taskId = typeof event.data?.taskId === 'string' ? event.data.taskId : undefined;
          if (taskId) activeAgents.delete(taskId);
          const status = workflowEventStatus(event);
          if (status === 'failed') {
            failedAgents += 1;
          } else {
            completedAgents += 1;
          }
          emit('running');
          break;
        }
        case 'agent_stopped': {
          const taskId = typeof event.data?.taskId === 'string' ? event.data.taskId : undefined;
          if (taskId) activeAgents.delete(taskId);
          stoppedAgents += 1;
          emit('running');
          break;
        }
        case 'synthesis_completed': {
          emit('running', 'synthesis complete');
          break;
        }
        default:
          break;
      }
    },
    complete: (status, message) => emit(status, message),
  };
}

function observeManagedWorkflowDone(
  managed: ManagedWorkflowRun,
  callbacks: Pick<CommandCallbacks, 'onWorkflowRunMessage'>,
  runId: string,
  live?: WorkflowLiveUpdateEmitter,
  options: { readonly canRerun?: boolean } = {},
): void {
  void managed.done.then((outcome) => {
    if (outcome.kind === 'failed') {
      live?.complete('failed', outcome.error.message);
      emitWorkflowRunMessage(callbacks, {
        type: 'error',
        text: [
          `Workflow failed (${runId}): ${outcome.error.message}`,
          formatWorkflowFailureAction(runId, options.canRerun === true),
        ].join('\n'),
      });
      return;
    }
    if (outcome.kind === 'completed') {
      const resultText = formatResult(outcome.result);
      live?.complete('completed', resultText ? 'completed with result' : 'completed');
      emitWorkflowRunMessage(callbacks, {
        type: 'success',
        text: [
          `Workflow completed (${outcome.state.totalSpawned} agents, run ${runId}).`,
          `Use /workflow show ${runId} for the event timeline.`,
        ].join('\n'),
      });
      if (resultText) {
        emitWorkflowRunMessage(callbacks, {
          type: 'info',
          text: `Workflow result:\n${resultText}`,
        });
      }
    }
  });
}

export type GeneratedWorkflowApprovalMode = 'required' | 'silent';
export type GeneratedWorkflowStartOutcome = 'started' | 'declined' | 'cancelled' | 'failed';
export type WorkflowBuilderStage =
  | 'started'
  | 'generating'
  | 'validating'
  | 'ready'
  | 'declined'
  | 'cancelled'
  | 'failed'
  | 'launched';

export interface WorkflowBuilderEvent {
  readonly stage: WorkflowBuilderStage;
  readonly message: string;
}

type GenerateWorkflowForRequest = typeof generateWorkflowFromOptions;

export interface StartGeneratedWorkflowFromRequestOptions {
  readonly request: string;
  readonly callbacks: Pick<
    CommandCallbacks,
    | 'createKodaXOptions'
    | 'confirm'
    | 'readline'
    | 'onWorkflowRunMessage'
    | 'onWorkflowRunUpdate'
  >;
  readonly approval: GeneratedWorkflowApprovalMode;
  readonly sourceLabel?: string;
  readonly generateWorkflow?: GenerateWorkflowForRequest;
  readonly onBuilderEvent?: (event: WorkflowBuilderEvent) => void;
}

function emitWorkflowBuilderEvent(
  input: StartGeneratedWorkflowFromRequestOptions,
  event: WorkflowBuilderEvent,
): void {
  input.onBuilderEvent?.(event);
  if (event.stage === 'failed') {
    console.log(chalk.red(`\n[workflow] builder failed: ${event.message}\n`));
    return;
  }
  if (!input.onBuilderEvent && (
    event.stage === 'started'
    || event.stage === 'generating'
    || event.stage === 'validating'
    || event.stage === 'ready'
  )) {
    console.log(chalk.dim(`\n[workflow] ${event.message}\n`));
  }
}

export async function startGeneratedWorkflowFromRequest(
  input: StartGeneratedWorkflowFromRequestOptions,
): Promise<GeneratedWorkflowStartOutcome> {
  const confirm = input.approval === 'required' ? resolveConfirm(input.callbacks) : undefined;
  if (input.approval === 'required' && !confirm) {
    console.log(
      chalk.red('\n[workflow] refusing to generate a workflow without an interactive approval channel.\n'),
    );
    return 'failed';
  }

  const createOptions = input.callbacks.createKodaXOptions;
  if (!createOptions) {
    console.log(chalk.red('\n[workflow] cannot generate - REPL options unavailable in this context.\n'));
    return 'failed';
  }

  const options = createOptions();
  let generated: Awaited<ReturnType<typeof generateWorkflowFromOptions>>;
  try {
    emitWorkflowBuilderEvent(input, {
      stage: 'started',
      message: 'Workflow builder started',
    });
    emitWorkflowBuilderEvent(input, {
      stage: 'generating',
      message: 'Workflow - generating harness',
    });
    const generateWorkflow = input.generateWorkflow ?? generateWorkflowFromOptions;
    generated = await generateWorkflow({
      request: input.request,
      options,
    });
    emitWorkflowBuilderEvent(input, {
      stage: 'validating',
      message: 'Workflow - validating harness',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitWorkflowBuilderEvent(input, {
      stage: 'failed',
      message,
    });
    return 'failed';
  }

  if (generated.kind === 'declined') {
    emitWorkflowBuilderEvent(input, {
      stage: 'declined',
      message: generated.reason,
    });
    console.log(chalk.dim(`\nWorkflow not created: ${generated.reason}\n`));
    return 'declined';
  }

  emitWorkflowBuilderEvent(input, {
    stage: 'ready',
    message: 'Workflow - harness ready',
  });
  emitWorkflowRunMessage(input.callbacks, {
    type: 'info',
    text: `Generated workflow: ${generated.approvalSummary}`,
  });
  const projectKey = deriveProjectKeyFromRoot(process.cwd()).key;
  const baseDir = getAgentConfigPath('workflow-runs', projectKey);
  const manager = getDefaultWorkflowRunManager();
  const runId = `run-${Date.now().toString(36)}`;
  const runDir = join(baseDir, runId);

  if (confirm) {
    const approved = await confirm(
      renderApprovalPrompt(buildApprovalSummary(generated.module), {
        source: input.sourceLabel ?? 'generated',
        sandbox: 'capability-generated',
        mayUseWorktree: generated.manifest.mayUseWorktree === true,
        rawScript: generated.scriptSnapshot.source,
      }),
    );
    if (!approved) {
      emitWorkflowBuilderEvent(input, {
        stage: 'cancelled',
        message: 'Workflow cancelled',
      });
      emitWorkflowRunMessage(input.callbacks, { type: 'info', text: 'Workflow cancelled.' });
      return 'cancelled';
    }
  } else {
    emitWorkflowRunMessage(input.callbacks, {
      type: 'info',
      text: renderApprovalPrompt(buildApprovalSummary(generated.module), {
        source: input.sourceLabel ?? 'generated',
        sandbox: 'capability-generated',
        mayUseWorktree: generated.manifest.mayUseWorktree === true,
      }),
    });
    emitWorkflowRunMessage(input.callbacks, {
      type: 'info',
      text: 'AMAW auto-start: capability-isolated generated workflow; normal permission gates still apply.',
    });
  }

  emitWorkflowRunMessage(input.callbacks, {
    type: 'info',
    text: `Started workflow ${generated.module.meta.name} (${runId}). Use /workflow show ${runId} for status.`,
  });
  const live = createWorkflowLiveUpdateEmitter(input.callbacks, runId, generated.module.meta.name);
  live.running(`Use /workflow show ${runId} for status or /workflow stop ${runId} to stop.`);

  const managed = manager.startFromOptions({
    module: generated.module,
    args: { request: input.request },
    options,
    runId,
    runDir,
    scriptSnapshot: generated.scriptSnapshot,
    onEvent: workflowEventSink(input.callbacks, live),
  });
  emitWorkflowBuilderEvent(input, {
    stage: 'launched',
    message: `Workflow ${generated.module.meta.name} started`,
  });

  observeManagedWorkflowDone(managed, input.callbacks, runId, live, { canRerun: true });

  return 'started';
}

export const workflowCommand: Command = {
  name: 'workflow',
  description: 'Run a dynamic multi-agent workflow (FEATURE_217)',
  usage: '/workflow [help | list | runs | show | pause | resume | stop | delete | prune | rerun | save | create | <name> [args]]',
  argumentHint: 'help | list | runs [--all|--limit N] | show [runId] | pause <runId> | resume <runId> | stop <runId> | delete <runId> | prune --dry-run|--keep N|--older-than Nd | rerun <runId> [args] | save <runId> <name> | create <request> | <name> [args]',
  detailedHelp: printWorkflowHelp,
  handler: async (args, _context, callbacks, currentConfig) => {
    const invocation = parseWorkflowInvocation(args);
    const projectKey = deriveProjectKeyFromRoot(process.cwd()).key;
    const baseDir = getAgentConfigPath('workflow-runs', projectKey);
    const manager = getDefaultWorkflowRunManager();

    const dirs = savedWorkflowDirs(process.cwd());

    if (invocation.kind === 'help') {
      printWorkflowHelp();
      return;
    }

    if (invocation.kind === 'list') {
      console.log(chalk.bold('\nBuilt-in workflows:'));
      console.log(formatWorkflowList(listBuiltinWorkflows()));
      console.log(chalk.bold('\nPattern templates:'));
      for (const template of listWorkflowPatternTemplates()) {
        console.log(`  ${chalk.cyan(template.name)} ${chalk.dim(`(${template.pattern})`)} - ${template.description}`);
      }
      const saved = await discoverSavedWorkflows(dirs);
      if (saved.length > 0) {
        console.log(chalk.bold('\nSaved workflows:'));
        console.log(formatSavedList(saved));
      }
      console.log(chalk.dim('\n  Run one with: /workflow <name> <question or JSON args>'));
      console.log(chalk.dim('  Show usage with: /workflow help\n'));
      return;
    }

    if (invocation.kind === 'runs') {
      const options = parseWorkflowRunsOptions(invocation.rawArgs);
      if (options.error) {
        console.log(chalk.yellow(`\nUsage: /workflow runs [--all] [--limit N]\n${options.error}\n`));
        return;
      }
      const active = manager.list().filter(isActiveManagedWorkflowRun);
      if (active.length > 0) {
        console.log(chalk.bold('\nActive workflow runs:'));
        console.log(formatManagedRunsList(active));
      }
      console.log(chalk.bold('\nWorkflow runs:'));
      console.log(formatRunsList(readWorkflowRuns(baseDir), {
        limit: options.all ? undefined : options.limit,
        showLimitHint: !options.all,
      }));
      console.log();
      return;
    }

    if (invocation.kind === 'show') {
      const persistedRuns = readWorkflowRuns(baseDir);
      const runId = invocation.runId
        || selectDefaultWorkflowRunId(manager.list(), persistedRuns);
      if (!runId) {
        console.log(chalk.yellow('\nNo workflow runs yet. Start one with /workflow create <request>.\n'));
        return;
      }
      if (!ensureSafeRunId(runId)) return;
      const managed = manager.get(runId);
      const detail = readWorkflowRunDetail(baseDir, runId);
      console.log(chalk.bold('\nWorkflow run:'));
      console.log(formatWorkflowRunSnapshot(managed, detail));
      console.log();
      return;
    }

    if (invocation.kind === 'pause') {
      if (!ensureSafeRunId(invocation.runId)) return;
      const ok = manager.pause(invocation.runId);
      console.log(ok ? chalk.dim(`Paused workflow ${invocation.runId}.\n`) : chalk.yellow(`No running workflow ${invocation.runId}.\n`));
      return;
    }

    if (invocation.kind === 'resume') {
      if (!ensureSafeRunId(invocation.runId)) return;
      const ok = manager.resume(invocation.runId);
      console.log(ok ? chalk.dim(`Resumed workflow ${invocation.runId}.\n`) : chalk.yellow(`No paused workflow ${invocation.runId}.\n`));
      return;
    }

    if (invocation.kind === 'stop') {
      if (!ensureSafeRunId(invocation.runId)) return;
      const ok = manager.stop(invocation.runId, 'stopped by user');
      const snapshot = manager.get(invocation.runId);
      const detail = snapshot ? readWorkflowRunDetail(baseDir, invocation.runId) : undefined;
      const nextActions = formatWorkflowNextActions(
        invocation.runId,
        canRerunWorkflowRun(snapshot, detail),
      );
      console.log(ok
        ? chalk.dim(`Stopped workflow ${invocation.runId}.\n`)
        : snapshot && !isActiveManagedWorkflowRun(snapshot)
          ? chalk.yellow(`Workflow ${invocation.runId} is already ${snapshot.status}. Next: ${nextActions}.\n`)
          : chalk.yellow(`No active workflow ${invocation.runId}.\n`));
      return;
    }

    if (invocation.kind === 'delete') {
      if (!ensureSafeRunId(invocation.runId)) return;
      const snapshot = manager.get(invocation.runId);
      if (snapshot && isActiveManagedWorkflowRun(snapshot)) {
        console.log(chalk.yellow(`\nWorkflow ${invocation.runId} is ${snapshot.status}. Stop it before deleting the run record.\n`));
        return;
      }
      const runDir = join(baseDir, invocation.runId);
      if (!existsSync(runDir)) {
        console.log(chalk.yellow(`\nNo persisted workflow run ${invocation.runId}.\n`));
        return;
      }
      rmSync(runDir, { recursive: true, force: true });
      console.log(chalk.dim(`\nDeleted workflow run ${invocation.runId}.\n`));
      return;
    }

    if (invocation.kind === 'prune') {
      const options = parseWorkflowPruneOptions(invocation.rawArgs);
      if (options.error) {
        console.log(chalk.yellow(`\nUsage: /workflow prune --dry-run | --keep N | --older-than Nd\n${options.error}\n`));
        return;
      }
      if (!options.dryRun && options.keep === undefined && options.olderThanMs === undefined) {
        console.log(chalk.yellow('\nUsage: /workflow prune --dry-run | --keep N | --older-than Nd\nNo cleanup rule was provided.\n'));
        return;
      }
      const activeIds = new Set(manager.list().filter(isActiveManagedWorkflowRun).map((run) => run.runId));
      const candidates = selectWorkflowPruneCandidates(readWorkflowRuns(baseDir), options)
        .filter((run) => !activeIds.has(run.runId));
      console.log(chalk.bold(options.dryRun ? '\nWorkflow prune preview:' : '\nWorkflow prune:'));
      console.log(formatWorkflowPruneCandidates(candidates));
      if (!options.dryRun) {
        for (const run of candidates) {
          rmSync(join(baseDir, run.runId), { recursive: true, force: true });
        }
        console.log(chalk.dim(`\nDeleted ${candidates.length} workflow run${candidates.length === 1 ? '' : 's'}.\n`));
      } else {
        console.log(chalk.dim('\nDry run only. Add --keep N or --older-than Nd without --dry-run to delete.\n'));
      }
      return;
    }

    if (invocation.kind === 'save') {
      if (!invocation.runId || !invocation.name) {
        console.log(chalk.yellow('\nUsage: /workflow save <runId> <name>\n'));
        return;
      }
      if (!ensureSafeRunId(invocation.runId)) return;
      try {
        const ref = await saveGeneratedWorkflowFromRun({
          runDir: join(baseDir, invocation.runId),
          targetDir: dirs.project ?? join(process.cwd(), '.kodax', 'workflows'),
          name: invocation.name,
        });
        console.log(chalk.green(`\nSaved workflow ${ref.name} to ${ref.path}\n`));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(chalk.red(`\n[workflow] save failed: ${message}\n`));
      }
      return;
    }

    if (invocation.kind === 'rerun') {
      if (!invocation.runId) {
        console.log(chalk.yellow('\nUsage: /workflow rerun <runId> [args]\n'));
        return;
      }
      if (!ensureSafeRunId(invocation.runId)) return;
      const confirm = resolveConfirm(callbacks);
      if (!confirm) {
        console.log(
          chalk.red('\n[workflow] refusing to rerun a generated workflow without an interactive approval channel.\n'),
        );
        return;
      }
      const createOptions = callbacks.createKodaXOptions;
      if (!createOptions) {
        console.log(chalk.red('\n[workflow] cannot start — REPL options unavailable in this context.\n'));
        return;
      }
      let loaded: Awaited<ReturnType<typeof loadGeneratedWorkflowFromRun>>;
      try {
        loaded = await loadGeneratedWorkflowFromRun({
          runDir: join(baseDir, invocation.runId),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(chalk.red(`\n[workflow] rerun failed: ${message}\n`));
        return;
      }
      const preflight = preflightWorkflowCapsule(loaded.capsule, currentWorkflowPreflightEnv());
      if (!preflight.ok) {
        printPreflightFailure(preflight);
        return;
      }
      printPreflightWarnings(preflight);
      const approved = await confirm(
        renderApprovalPrompt(buildApprovalSummary(loaded.module), {
          source: `run:${invocation.runId}`,
          sandbox: 'capability-generated',
          mayUseWorktree: loaded.capsule.manifest.mayUseWorktree === true,
          rawScript: loaded.capsule.source,
        }),
      );
      if (!approved) {
        console.log(chalk.dim('Workflow cancelled.\n'));
        return;
      }
      const newRunId = `run-${Date.now().toString(36)}`;
      const newRunDir = join(baseDir, newRunId);
      console.log(chalk.dim(`\nStarted workflow ${loaded.module.meta.name} (${newRunId}). Use /workflow show ${newRunId} for status.\n`));
      const live = createWorkflowLiveUpdateEmitter(callbacks, newRunId, loaded.module.meta.name);
      live.running(`Use /workflow show ${newRunId} for status or /workflow stop ${newRunId} to stop.`);
      const managed = manager.startFromOptions({
        module: loaded.module,
        args: parseWorkflowArgs(invocation.rawArgs),
        options: createOptions(),
        runId: newRunId,
        runDir: newRunDir,
        scriptSnapshot: {
          manifest: loaded.capsule.manifest,
          source: loaded.capsule.source,
        },
        onEvent: workflowEventSink(callbacks, live),
      });
      observeManagedWorkflowDone(managed, callbacks, newRunId, live, { canRerun: true });
      return;
    }

    if (invocation.kind === 'create') {
      if (!invocation.request) {
        console.log(chalk.yellow('\nUsage: /workflow create <request>\n'));
        return;
      }
      await startGeneratedWorkflowFromRequest({
        request: invocation.request,
        callbacks,
        approval: currentConfig.permissionMode === 'plan' ? 'required' : 'silent',
        sourceLabel: 'generated',
        onBuilderEvent: callbacks.onWorkflowBuilderEvent,
      });
      return;
    }

    const confirm = resolveConfirm(callbacks);
    if (!confirm) {
      console.log(
        chalk.red('\n[workflow] refusing to start a workflow without an interactive approval channel.\n'),
      );
      return;
    }
    let approvalContext: WorkflowApprovalRenderContext = {
      source: 'built-in',
      sandbox: 'trusted package',
      mayUseWorktree: false,
    };
    let scriptSnapshot: { readonly manifest: WorkflowScriptManifest; readonly source: string } | undefined;
    let module: WorkflowModule | undefined = getBuiltinWorkflow(invocation.name);
    if (!module) {
      // Not a built-in — try a saved workflow. Loading EXECUTES local
      // code, so it is hard-gated behind a trusted-local confirmation:
      // with no interactive channel we refuse rather than run unconfirmed.
      const ref = (await discoverSavedWorkflows(dirs)).find((r) => r.name === invocation.name);
      if (!ref) {
        console.log(chalk.yellow(`\nUnknown workflow: ${invocation.name}`));
        console.log(formatWorkflowList(listBuiltinWorkflows()));
        console.log();
        return;
      }
      if (ref.execution === 'trusted-local') {
        const trusted = await confirm(
          `Run local workflow file? This EXECUTES local code:\n  ${ref.path}`,
        );
        if (!trusted) {
          console.log(chalk.dim('Workflow cancelled.\n'));
          return;
        }
      }
      try {
        if (ref.execution === 'capability-generated') {
          const capsule = await loadSavedWorkflowCapsule(ref.path);
          const preflight = preflightWorkflowCapsule(capsule, currentWorkflowPreflightEnv());
          if (!preflight.ok) {
            printPreflightFailure(preflight);
            return;
          }
          printPreflightWarnings(preflight);
          approvalContext = {
            source: `saved:${ref.source}`,
            sandbox: ref.execution,
            mayUseWorktree: capsule.manifest.mayUseWorktree === true,
            rawScript: capsule.source,
          };
          scriptSnapshot = {
            manifest: capsule.manifest,
            source: capsule.source,
          };
        }
        module = await loadSavedWorkflow(ref.path);
        if (ref.execution === 'trusted-local') {
          approvalContext = {
            source: `saved:${ref.source}`,
            sandbox: ref.execution,
            mayUseWorktree: false,
          };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(chalk.red(`\n[workflow] failed to load ${ref.path}: ${message}\n`));
        return;
      }
    }

    const createOptions = callbacks.createKodaXOptions;
    if (!createOptions) {
      console.log(chalk.red('\n[workflow] cannot start — REPL options unavailable in this context.\n'));
      return;
    }

    const approved = await confirm(renderApprovalPrompt(buildApprovalSummary(module), approvalContext));
    if (!approved) {
      console.log(chalk.dim('Workflow cancelled.\n'));
      return;
    }

    const runId = `run-${Date.now().toString(36)}`;
    const runDir = join(baseDir, runId);
    console.log(chalk.dim(`\nStarted workflow ${module.meta.name} (${runId}). Use /workflow show ${runId} for status.\n`));
    const live = createWorkflowLiveUpdateEmitter(callbacks, runId, module.meta.name);
    live.running(`Use /workflow show ${runId} for status or /workflow stop ${runId} to stop.`);

    const managed = manager.startFromOptions({
      module,
      args: parseWorkflowArgs(invocation.rawArgs),
      options: createOptions(),
      runId,
      runDir,
      ...(scriptSnapshot ? { scriptSnapshot } : {}),
      onEvent: workflowEventSink(callbacks, live),
    });

    observeManagedWorkflowDone(managed, callbacks, runId, live, { canRerun: scriptSnapshot !== undefined });
  },
};
