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

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import chalk from 'chalk';
import { getAgentConfigPath } from '@kodax-ai/agent';
import type {
  WorkflowApprovalSummary,
  WorkflowArtifactRef,
  WorkflowEvent,
  WorkflowMeta,
  WorkflowModule,
  WorkflowProcessEvent,
  WorkflowProcessSource,
  WorkflowCapsule,
  WorkflowCapsuleProvenance,
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
  renameSavedWorkflow,
  replaceSavedWorkflow,
  resolveWorkflowIdentity,
  safeWorkflowArtifactName,
  saveGeneratedWorkflow,
  saveGeneratedWorkflowFromRun,
  type ManagedWorkflowRun,
  type ManagedWorkflowSnapshot,
  type SavedWorkflowDirs,
  type SavedWorkflowRef,
  type WorkflowRunProcessMetadata,
  type WorkflowRunManager,
} from '@kodax-ai/coding';

import { KODAX_VERSION } from '../common/utils.js';
import { deriveProjectKeyFromRoot } from '../interactive/project-key.js';
import { workflowLiveSnapshotFromProcess } from '../ui/view-models/workflow-live.js';
import type { Command, CommandCallbacks } from './types.js';

/* ----------------------------- pure helpers ----------------------------- */

export type WorkflowInvocation =
  | { readonly kind: 'help' }
  | { readonly kind: 'list' }
  | { readonly kind: 'runs'; readonly rawArgs: readonly string[] }
  | { readonly kind: 'show'; readonly runId: string; readonly full?: boolean }
  | { readonly kind: 'pause'; readonly runId: string }
  | { readonly kind: 'resume'; readonly runId: string }
  | { readonly kind: 'stop'; readonly runId: string }
  | { readonly kind: 'delete'; readonly runId: string }
  | { readonly kind: 'prune'; readonly rawArgs: readonly string[] }
  | { readonly kind: 'save'; readonly runId: string; readonly name: string }
  | { readonly kind: 'rename'; readonly target: string; readonly newName: string }
  | { readonly kind: 'revise'; readonly target: string; readonly request: string; readonly replace?: boolean }
  | { readonly kind: 'rerun'; readonly runId: string; readonly rawArgs: string }
  | { readonly kind: 'create'; readonly request: string }
  | { readonly kind: 'start'; readonly name: string; readonly rawArgs: string };

export const DEFAULT_WORKFLOW_RUNS_LIMIT = 20;
export const DEFAULT_WORKFLOW_PRUNE_KEEP = 50;
const MAX_WORKFLOW_RUNS_LIMIT = 200;
const TERMINAL_WORKFLOW_STATUSES = new Set(['completed', 'failed', 'stopped', 'denied']);
const MAX_WORKFLOW_AGENT_DIGEST_EXCERPTS = 4;
const MAX_WORKFLOW_AGENT_DIGEST_EXCERPT_CHARS = 180;

export function parseWorkflowInvocation(args: readonly string[]): WorkflowInvocation {
  const first = args[0]?.toLowerCase();
  if (first === 'help' || first === '--help' || first === '-h') return { kind: 'help' };
  if (!first || first === 'list') return { kind: 'list' };
  if (first === 'runs') return { kind: 'runs', rawArgs: args.slice(1) };
  if (first === 'show') {
    const rest = args.slice(1);
    const full = rest.includes('--full');
    const runId = rest.find((arg) => arg !== '--full') ?? '';
    return full ? { kind: 'show', runId, full: true } : { kind: 'show', runId };
  }
  if (first === 'pause') return { kind: 'pause', runId: args[1] ?? '' };
  if (first === 'resume') return { kind: 'resume', runId: args[1] ?? '' };
  if (first === 'stop') return { kind: 'stop', runId: args[1] ?? '' };
  if (first === 'delete') return { kind: 'delete', runId: args[1] ?? '' };
  if (first === 'prune') return { kind: 'prune', rawArgs: args.slice(1) };
  if (first === 'save') return { kind: 'save', runId: args[1] ?? '', name: args[2] ?? '' };
  if (first === 'rename') {
    return { kind: 'rename', target: args[1] ?? '', newName: args.slice(2).join(' ').trim() };
  }
  if (first === 'revise') {
    const raw = args.slice(1);
    const replace = raw.includes('--replace');
    const cleaned = raw.filter((arg) => arg !== '--replace');
    return {
      kind: 'revise',
      target: cleaned[0] ?? '',
      request: cleaned.slice(1).join(' ').trim(),
      ...(replace ? { replace: true } : {}),
    };
  }
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

export function buildWorkflowRevisionRequest(input: {
  readonly target: string;
  readonly capsule: WorkflowCapsule;
  readonly changeRequest: string;
}): string {
  return [
    'Revise this existing KodaX dynamic workflow capsule.',
    'Return a complete revised workflow, not a patch.',
    'Preserve the reusable workflow intent, safety requirements, and compatible args shape unless the requested change explicitly requires otherwise.',
    '',
    `Target: ${input.target}`,
    '',
    'Original manifest:',
    JSON.stringify(input.capsule.manifest, null, 2),
    '',
    'Original source:',
    '```js',
    input.capsule.source,
    '```',
    '',
    `Change request: ${input.changeRequest}`,
  ].join('\n');
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

const APPROVAL_SCRIPT_PREVIEW_LINES = 6;
const APPROVAL_SCRIPT_PREVIEW_CHARS = 900;

function renderApprovalScriptPreview(source: string): readonly string[] {
  const lines = source.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const preview: string[] = [];
  let usedChars = 0;
  let truncatedByChars = false;

  for (const line of lines) {
    if (preview.length >= APPROVAL_SCRIPT_PREVIEW_LINES) break;
    const indented = `    ${line}`;
    const remainingChars = APPROVAL_SCRIPT_PREVIEW_CHARS - usedChars;
    if (remainingChars <= 0) {
      truncatedByChars = true;
      break;
    }
    if (indented.length > remainingChars) {
      if (remainingChars > 16) {
        preview.push(`${indented.slice(0, remainingChars - 4)} ...`);
      }
      truncatedByChars = true;
      break;
    }
    preview.push(indented);
    usedChars += indented.length + 1;
  }

  const omittedLines = Math.max(0, lines.length - preview.length);
  if (omittedLines > 0 || truncatedByChars) {
    const omitted = omittedLines > 0
      ? `${omittedLines} more line(s)`
      : 'source truncated';
    preview.push(`    ... (${omitted}; full source omitted from prompt)`);
  }
  return preview;
}

export function renderApprovalPrompt(
  summary: WorkflowApprovalSummary,
  context?: WorkflowApprovalRenderContext,
): string {
  const cap = (n: number | null): string => (n === null ? '∞' : String(n));
  const planned = summary.plannedAgents === undefined ? undefined : String(summary.plannedAgents);
  const agentScale = planned === undefined
    ? `agent total cap: ${cap(summary.maxAgents)}`
    : `planned agents: ${planned} · agent safety cap: ${cap(summary.maxAgents)}`;
  return [
    `Run workflow ${chalk.cyan(summary.name)}?`,
    `  ${summary.description}`,
    `  phases: ${summary.phases.length > 0 ? summary.phases.join(' → ') : '(dynamic)'}`,
    `  ${agentScale} · max concurrency: ${cap(summary.maxConcurrency)} · token budget: ${cap(summary.tokenBudget)}`,
    `  writes files: ${summary.writesFiles ? chalk.yellow('yes') : 'no (read-only)'}`,
    ...(context
      ? [
          `  source: ${context.source}`,
          `  sandbox/trust: ${context.sandbox}`,
          `  worktree isolation: ${context.mayUseWorktree ? 'may request worktree' : 'shared cwd / per-child default'}`,
          ...(context.rawScriptPath
            ? [`  raw script: ${context.rawScriptPath}`]
            : context.rawScript
              ? ['  raw script: preview below']
              : []),
          ...(context.rawScript && !context.rawScriptPath
            ? ['  raw script preview:', ...renderApprovalScriptPreview(context.rawScript)]
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
  readonly scriptSnapshotPath?: string;
  readonly manifestSnapshotPath?: string;
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
    const scriptSnapshotPath = readNonEmptyString(data.scriptSnapshotPath);
    const manifestSnapshotPath = readNonEmptyString(data.manifestSnapshotPath);
    return {
      runId,
      workflow: typeof data.workflow === 'string' ? data.workflow : '?',
      status: typeof data.status === 'string' ? data.status : '?',
      totalSpawned: typeof data.totalSpawned === 'number' ? data.totalSpawned : 0,
      eventCount: events.length,
      runDir,
      canRerun: hasRerunnableGeneratedWorkflowRun(runDir, data),
      ...(scriptSnapshotPath ? { scriptSnapshotPath } : {}),
      ...(manifestSnapshotPath ? { manifestSnapshotPath } : {}),
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

export function selectDefaultActiveWorkflowRunId(
  managedRuns: readonly ManagedWorkflowSnapshot[],
): string | undefined {
  return managedRuns.find(isActiveManagedWorkflowRun)?.runId;
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

function workflowArtifactRefs(detail: WorkflowRunDetail | undefined): readonly WorkflowArtifactRef[] {
  if (!detail) return [];
  return detail.artifacts.map((name) => ({
    name,
    path: join(detail.runDir, 'artifacts', `${safeWorkflowArtifactName(name)}.json`),
  }));
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

export interface WorkflowRunSnapshotFormatOptions {
  readonly full?: boolean;
}

export function formatWorkflowRunSnapshot(
  run: ManagedWorkflowSnapshot | undefined,
  detail?: WorkflowRunDetail,
  options: WorkflowRunSnapshotFormatOptions = {},
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
  const artifacts = detail?.artifacts ?? [];
  const artifactRefs = workflowArtifactRefs(detail);
  const managedResultText = run?.resultText;
  const artifactResult = options.full === true || managedResultText === undefined
    ? formatArtifactResult(artifactRefs, detectWorkflowLocale(workflow), { full: options.full === true })
    : undefined;
  const rawResultText = options.full === true
    ? artifactResult ?? managedResultText
    : managedResultText !== undefined
      ? formatResult(managedResultText)
      : artifactResult;
  const resultText = rawResultText
    ? replaceWorkflowResultTruncationMarker(rawResultText, runId, detectWorkflowLocale(rawResultText))
    : undefined;
  const resultLabel = options.full === true || !rawResultText || !isWorkflowResultPreviewTruncated(rawResultText)
    ? 'result:'
    : 'result preview:';
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
    ...(resultText ? ['', `  ${resultLabel}`, ...resultText.split('\n').map((line) => `    ${line}`)] : []),
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

async function nextRevisionWorkflowName(
  dirs: SavedWorkflowDirs,
  preferredName: string,
): Promise<string> {
  const existing = new Set((await discoverSavedWorkflows(dirs)).map((ref) => ref.name));
  if (!existing.has(preferredName)) return preferredName;
  return `${preferredName}-revision-${Date.now().toString(36)}`;
}

function buildWorkflowRevisionProvenance(input: {
  readonly capsule: WorkflowCapsule;
  readonly resolution: Awaited<ReturnType<typeof resolveWorkflowIdentity>>;
  readonly replacesWorkflowName?: string;
}): WorkflowCapsuleProvenance {
  const fromRunId = input.resolution.kind === 'run'
    ? input.resolution.runId
    : input.capsule.provenance?.fromRunId;
  const fromWorkflowName = input.resolution.kind === 'saved'
    ? input.resolution.savedWorkflow.name
    : input.capsule.provenance?.fromWorkflowName;
  const revisionOf = input.resolution.kind === 'run'
    ? input.resolution.runId
    : input.resolution.kind === 'saved'
      ? input.resolution.savedWorkflow.name
      : undefined;

  return {
    ...(fromRunId !== undefined ? { fromRunId } : {}),
    ...(fromWorkflowName !== undefined ? { fromWorkflowName } : {}),
    ...(revisionOf !== undefined ? { revisionOf } : {}),
    ...(input.replacesWorkflowName !== undefined ? { replacesWorkflowName: input.replacesWorkflowName } : {}),
    createdAt: new Date().toISOString(),
    kodaxVersion: KODAX_VERSION,
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
    `  ${chalk.cyan('/workflow show [--full] [runId]')}        Show the latest run; use --full for complete result artifacts.`,
    `  ${chalk.cyan('/workflow pause <runId>')}                Pause future child launches for an active run.`,
    `  ${chalk.cyan('/workflow resume <runId>')}               Resume a paused run.`,
    `  ${chalk.cyan('/workflow stop [runId]')}                 Stop an active run through abort propagation. Defaults to the active run.`,
    `  ${chalk.cyan('/workflow delete <runId>')}               Delete one persisted run record.`,
    `  ${chalk.cyan('/workflow prune --dry-run|--keep N|--older-than Nd')}`,
    `                                            Preview or delete old terminal run records.`,
    `  ${chalk.cyan('/workflow rerun <runId|savedName> [args]')} Rerun a historical generated run, or run the current saved workflow by name.`,
    `  ${chalk.cyan('/workflow save <runId> <name>')}          Save a generated run as a workflow capsule.`,
    `  ${chalk.cyan('/workflow rename <runId|savedName> <newName>')} Rename a run display name or generated saved capsule.`,
    `  ${chalk.cyan('/workflow revise [--replace] <runId|savedName> <change>')} Generate and save a capsule revision.`,
    `  ${chalk.cyan('/workflow help')}                         Show this help. Also available as /help workflow.`,
    '',
    `${chalk.bold('Examples:')}`,
    `  ${chalk.dim('/workflow create Compare three flaky-test hypotheses and verify each one')}`,
    `  ${chalk.dim('/workflow parallel-investigation {"question":"请检查这个竞态在哪里","targets":["packages/agent"]}')}`,
    `  ${chalk.dim('/workflow rerun run-lx3 {"request":"请用同样流程复查 packages/repl"}')}`,
    `  ${chalk.dim('/workflow rerun generated-audit {"request":"reuse the saved workflow for packages/repl"}')}`,
    `  ${chalk.dim('/workflow prune --dry-run')}`,
    `  ${chalk.dim('/workflow save run-lx3 generated-audit')}`,
    '',
    `${chalk.bold('Safety:')}`,
    '  - Generated and workflow capsule (.workflow.json) workflows run in the capability WorkflowApi runner.',
    '  - For rerun, a run id reruns its saved snapshot; a saved name runs the current saved capsule version.',
    '  - For revise --replace, only a saved generated capsule name can move; the previous capsule is archived.',
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

export function writeWorkflowRunDisplayName(
  baseDir: string,
  runId: string,
  displayName: string,
): boolean {
  const trimmed = displayName.trim();
  if (!trimmed || !isSafeWorkflowRunId(runId)) return false;
  const detail = readWorkflowRunDetail(baseDir, runId);
  if (!detail) return false;
  writeFileSync(
    join(baseDir, runId, 'workflow-metadata.json'),
    `${JSON.stringify({ displayName: trimmed }, null, 2)}\n`,
    'utf8',
  );
  return true;
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

type WorkflowScriptSnapshot = {
  readonly manifest: WorkflowScriptManifest;
  readonly source: string;
};

interface PreparedSavedWorkflow {
  readonly module: WorkflowModule;
  readonly approvalContext: WorkflowApprovalRenderContext;
  readonly scriptSnapshot?: WorkflowScriptSnapshot;
}

async function prepareSavedWorkflow(
  ref: SavedWorkflowRef,
  confirm: ConfirmFn,
): Promise<PreparedSavedWorkflow | undefined> {
  if (ref.execution === 'trusted-local') {
    const trusted = await confirm(
      `Run local workflow file? This EXECUTES local code:\n  ${ref.path}`,
    );
    if (!trusted) {
      console.log(chalk.dim('Workflow cancelled.\n'));
      return undefined;
    }
  }

  try {
    let approvalContext: WorkflowApprovalRenderContext = {
      source: `saved:${ref.source}`,
      sandbox: ref.execution,
      mayUseWorktree: false,
    };
    let scriptSnapshot: WorkflowScriptSnapshot | undefined;

    if (ref.execution === 'capability-generated') {
      const capsule = await loadSavedWorkflowCapsule(ref.path);
      const preflight = preflightWorkflowCapsule(capsule, currentWorkflowPreflightEnv());
      if (!preflight.ok) {
        printPreflightFailure(preflight);
        return undefined;
      }
      printPreflightWarnings(preflight);
      approvalContext = {
        source: `saved:${ref.source}`,
        sandbox: ref.execution,
        mayUseWorktree: capsule.manifest.mayUseWorktree === true,
        rawScriptPath: ref.path,
        rawScript: capsule.source,
      };
      scriptSnapshot = {
        manifest: capsule.manifest,
        source: capsule.source,
      };
    }

    const module = await loadSavedWorkflow(ref.path);
    return scriptSnapshot
      ? { module, approvalContext, scriptSnapshot }
      : { module, approvalContext };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(chalk.red(`\n[workflow] failed to load ${ref.path}: ${message}\n`));
    return undefined;
  }
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
    case 'workflow_log':
      return `    log ${event.data?.message ?? ''}`;
    case 'artifact_written':
      return `    artifact ${event.data?.name ?? ''}`;
    case 'synthesis_completed':
      return '  synthesis complete';
    case 'workflow_completed':
      return '  workflow completed';
    case 'workflow_stopped':
      return '  workflow stopped';
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

const MAX_WORKFLOW_RESULT_PREVIEW_CHARS = 6000;
const MAX_WORKFLOW_LAUNCH_SUMMARY_CHARS = 360;
const WORKFLOW_RESULT_TRUNCATED_MARKER = '[truncated]';

export type WorkflowRunPresentation = 'command' | 'agentic';
export type WorkflowRunLocale = 'en' | 'zh';

interface WorkflowResultFormatOptions {
  readonly full?: boolean;
}

function detectWorkflowLocale(text: string): WorkflowRunLocale {
  return /[\u3400-\u9fff]/u.test(text) ? 'zh' : 'en';
}

function inferWorkflowLocaleFromParts(
  ...parts: readonly (string | undefined)[]
): WorkflowRunLocale {
  return detectWorkflowLocale(parts.filter((part): part is string => typeof part === 'string').join('\n'));
}

function trimResultPreview(text: string, options: WorkflowResultFormatOptions = {}): string {
  const trimmed = text.trim();
  if (options.full === true) return trimmed;
  if (trimmed.length <= MAX_WORKFLOW_RESULT_PREVIEW_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_WORKFLOW_RESULT_PREVIEW_CHARS).trimEnd()}\n\n${WORKFLOW_RESULT_TRUNCATED_MARKER}`;
}

function isWorkflowResultPreviewTruncated(text: string): boolean {
  return text.includes(WORKFLOW_RESULT_TRUNCATED_MARKER);
}

function formatWorkflowResultTruncationHint(runId: string, locale: WorkflowRunLocale): string {
  return locale === 'zh'
    ? `[结果预览已截断。完整结果请用 /workflow show --full ${runId} 查看；artifact 文件也保存在本次 run 目录。]`
    : `[Result preview truncated. Use /workflow show --full ${runId} for the complete result; artifacts are also saved in the run directory.]`;
}

function replaceWorkflowResultTruncationMarker(
  text: string,
  runId: string,
  locale: WorkflowRunLocale,
): string {
  const index = text.lastIndexOf(WORKFLOW_RESULT_TRUNCATED_MARKER);
  if (index < 0) return text;
  return `${text.slice(0, index).trimEnd()}\n\n${formatWorkflowResultTruncationHint(runId, locale)}`;
}

function trimWorkflowLaunchSummary(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= MAX_WORKFLOW_LAUNCH_SUMMARY_CHARS) return compact;
  return `${compact.slice(0, MAX_WORKFLOW_LAUNCH_SUMMARY_CHARS).trimEnd()}...`;
}

export function formatResult(
  result: unknown,
  options: WorkflowResultFormatOptions = {},
): string | undefined {
  if (typeof result === 'string' && result.trim().length > 0) {
    return trimResultPreview(result, options);
  }
  if (result && typeof result === 'object' && 'synthesis' in result) {
    const synthesis = (result as { synthesis?: unknown }).synthesis;
    if (typeof synthesis === 'string' && synthesis.trim().length > 0) {
      return trimResultPreview(synthesis, options);
    }
    if (synthesis && typeof synthesis === 'object' && 'text' in synthesis) {
      const text = (synthesis as { text?: unknown }).text;
      if (typeof text === 'string' && text.trim().length > 0) return trimResultPreview(text, options);
    }
  }
  if (result && typeof result === 'object') {
    for (const key of ['summary', 'report', 'text', 'result']) {
      const value = (result as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        return trimResultPreview(value, options);
      }
    }
  }
  // FEATURE_217 — fallback: render any other non-empty value (plain object /
  // array / number / boolean) as readable JSON so a workflow that returns an
  // unrecognized-but-non-empty shape still produces a VISIBLE final answer
  // instead of a content-free "completed" with no body. This keeps the
  // build-time source lint and this runtime formatter in agreement: a
  // non-trivial run() return is displayable. Empty `{}` / `[]` and
  // null/undefined still fall through to the no-result contract path.
  if (result !== undefined && result !== null) {
    try {
      const json = JSON.stringify(result, null, 2);
      if (typeof json === 'string') {
        const trimmed = json.trim();
        if (trimmed.length > 0 && trimmed !== '{}' && trimmed !== '[]' && trimmed !== '""') {
          return trimResultPreview(json, options);
        }
      }
    } catch {
      // Non-serializable (e.g. circular) — fall through to the no-result path.
    }
  }
  return undefined;
}

export function formatFinalEventSummary(
  events: readonly WorkflowEvent[],
  options: WorkflowResultFormatOptions = {},
): string | undefined {
  const completed = [...events]
    .reverse()
    .filter((event) => event.type === 'agent_completed' && readEventString(event, 'status') === 'completed');
  const synthesis = completed.find((event) => readEventString(event, 'name') === 'synthesize');
  const event = synthesis ?? completed[0];
  const summary = event ? readEventString(event, 'summary') : undefined;
  return summary ? trimResultPreview(summary, options) : undefined;
}

function formatArtifactPreview(
  artifact: WorkflowArtifactRef,
  options: WorkflowResultFormatOptions = {},
): string | undefined {
  if (!artifact.path || !existsSync(artifact.path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(artifact.path, 'utf8'));
    const text = formatResult(parsed, options);
    if (text) return text;
    const json = JSON.stringify(parsed, null, 2);
    return typeof json === 'string' && json.trim().length > 0
      ? trimResultPreview(json, options)
      : undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `artifact preview unavailable: ${message}`;
  }
}

function formatArtifactResult(
  artifacts: readonly WorkflowArtifactRef[],
  locale: WorkflowRunLocale,
  options: WorkflowResultFormatOptions = {},
): string | undefined {
  for (let index = artifacts.length - 1; index >= 0; index -= 1) {
    const artifact = artifacts[index];
    if (!artifact) continue;
    const preview = formatArtifactPreview(artifact, options);
    if (preview) {
      return locale === 'zh'
        ? `产物 ${artifact.name}:\n${preview}`
        : `Artifact ${artifact.name}:\n${preview}`;
    }
  }
  if (artifacts.length === 0) return undefined;
  const names = artifacts.map((artifact) => artifact.name).join(', ');
  return locale === 'zh'
    ? `已生成产物: ${names}`
    : `Artifacts created: ${names}`;
}

function formatWorkflowCompletionAnswer(input: {
  readonly runId: string;
  readonly totalSpawned: number;
  readonly resultText?: string;
  readonly locale: WorkflowRunLocale;
  readonly isFallbackPreview?: boolean;
}): string {
  const displayResultText = input.resultText
    ? replaceWorkflowResultTruncationMarker(input.resultText, input.runId, input.locale)
    : undefined;
  if (input.locale === 'zh') {
    const header = input.resultText && input.isFallbackPreview !== true
      ? `Workflow 已完成（${input.totalSpawned} 个智能体，run ${input.runId}）。`
      : `Workflow 运行结束，但结果契约失败（${input.totalSpawned} 个智能体，run ${input.runId}）。`;
    if (displayResultText) {
      const label = input.isFallbackPreview === true
        ? '结果契约异常：workflow 运行结束，但没有返回完整最终结果。以下是最后综合输出：'
        : '最终结果：';
      return `${header}\n\n${label}\n\n${displayResultText}`;
    }
    return [
      header,
      '',
      '这次 workflow 运行结束，但生成脚本违反结果契约：没有返回可直接展示的最终结果或可预览产物。这不是正常完成状态，需要修复生成脚本后重新运行。',
    ].join('\n');
  }

  const header = input.resultText && input.isFallbackPreview !== true
    ? `Workflow completed (${input.totalSpawned} agents, run ${input.runId}).`
    : `Workflow ended with a result contract failure (${input.totalSpawned} agents, run ${input.runId}).`;
  if (displayResultText) {
    const label = input.isFallbackPreview === true
      ? 'Result contract violation: the workflow ended without returning a complete final result. Last synthesis output:'
      : 'Final result:';
    return `${header}\n\n${label}\n\n${displayResultText}`;
  }
  return [
    header,
    '',
    'The workflow ended, but the generated script violated the result contract: it did not return displayable final text or a previewable artifact. This is not a normal completion state; fix the generated script and rerun it.',
  ].join('\n');
}

function formatWorkflowLaunchAnswer(input: {
  readonly runId: string;
  readonly summary: WorkflowApprovalSummary;
  readonly approvalSummary: string;
  readonly locale: WorkflowRunLocale;
}): string {
  const phases = input.summary.phases.length > 0
    ? input.summary.phases.join(' -> ')
    : 'dynamic';
  const maxAgents = input.summary.maxAgents === null ? 'unbounded' : String(input.summary.maxAgents);
  const agentScale = input.summary.plannedAgents === undefined
    ? input.locale === 'zh'
      ? `最多 ${maxAgents} 个智能体`
      : `up to ${maxAgents} agents`
    : input.locale === 'zh'
      ? `计划约 ${input.summary.plannedAgents} 个智能体，安全上限 ${maxAgents}`
      : `about ${input.summary.plannedAgents} planned agents, safety cap ${maxAgents}`;
  const maxConcurrency = input.summary.maxConcurrency === null
    ? 'unbounded'
    : String(input.summary.maxConcurrency);
  const plan = trimWorkflowLaunchSummary(input.approvalSummary);
  if (input.locale === 'zh') {
    const writePolicy = input.summary.writesFiles
      ? '如需写文件，仍会经过正常权限确认。'
      : '这是只读探查，不会主动修改文件。';
    return [
      `我会用 workflow 做这次任务，已启动 ${input.summary.name}（${input.runId}）。`,
      `计划：${plan}`,
      `阶段：${phases}；规模：${agentScale}，并发 ${maxConcurrency}。${writePolicy}`,
      '运行过程会在下方动态更新，完成后我会直接汇总结论。',
    ].join('\n');
  }
  const writePolicy = input.summary.writesFiles
    ? 'File-writing work still goes through normal permission gates.'
    : 'This is read-only and will not modify files.';
  return [
    `I will use a workflow for this task: ${input.summary.name} (${input.runId}).`,
    `Plan: ${plan}`,
    `Phases: ${phases}; scale: ${agentScale}, ${maxConcurrency} concurrent. ${writePolicy}`,
    'Progress will update below, and I will summarize the result when it finishes.',
  ].join('\n');
}

function readEventString(event: WorkflowEvent, key: string): string | undefined {
  const value = event.data?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function formatWorkflowAgentDigest(
  event: WorkflowEvent,
  locale: WorkflowRunLocale = 'en',
  runId?: string,
): string | undefined {
  if (event.type !== 'agent_completed') return undefined;
  if (readEventString(event, 'status') !== 'completed') return undefined;
  const rawSummary = readEventString(event, 'summary');
  if (!rawSummary) return undefined;
  const rawKind = readEventString(event, 'summaryKind');
  const summaryKind: WorkflowAgentSummaryKind =
    rawKind === 'digest' ? 'digest' : rawKind === 'digest-failed' ? 'digest-failed' : 'excerpt';
  const name = readEventString(event, 'name') ?? readEventString(event, 'taskId') ?? 'agent';
  return formatWorkflowAgentLongDigest(
    name,
    rawSummary,
    locale,
    runId,
    summaryKind,
  );
}

type WorkflowAgentSummaryKind = 'digest' | 'excerpt' | 'digest-failed';

function trimWorkflowAgentDigestExcerpt(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= MAX_WORKFLOW_AGENT_DIGEST_EXCERPT_CHARS) return compact;
  return `${compact.slice(0, MAX_WORKFLOW_AGENT_DIGEST_EXCERPT_CHARS).trimEnd()}...`;
}

function isHighSignalWorkflowAgentDigestLine(line: string): boolean {
  if (/^(?:conclusion|finding|confirmed issue|issue|evidence|risk|next|unresolved|decision|result|summary|结论|发现|问题|证据|风险|下一步|未决|判断|决定|结果|摘要)[:：]/i.test(line)) {
    return true;
  }
  if (/^(?:[A-Z]{1,3}-?\d+|[HMSLP]\d+)[.)：:\s-]/i.test(line)) return true;
  return /(?:critical|high|medium|low)\s+severity|(?:严重|高危|中危|低危)/i.test(line);
}

function isLowInformationWorkflowAgentDigestLine(line: string): boolean {
  const lower = line.toLowerCase();
  if (/\[\/?workflow handoff\]/i.test(line)) return true;
  if (/^\|.*\|$/.test(line)) return true;
  if (/^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/.test(line)) return true;
  if (/^(?:i now have|i have|i now understand|here is|let me|i will|this report|the report)\b/.test(lower)) {
    return true;
  }
  if (/^(?:scope|review scope|范围|审查范围)[:：]/i.test(line)) return true;
  if (/^feature[_\s-]*\d+.*(?:report|review|audit|map|审查|报告|地图|变更地图)/i.test(line)) return true;
  if (/^feature[_\s-]*\d+.*改动分布.*feature/i.test(line)) return true;
  if (/(?:review report|audit|审查报告|综合报告|分析报告|变更地图)$/i.test(line) && line.length < 140) return true;
  return false;
}

interface WorkflowAgentDigestExtractionOptions {
  readonly truncateLines?: boolean;
}

function compactWorkflowAgentDigestLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function normalizeWorkflowAgentDigestLine(
  line: string,
  options: WorkflowAgentDigestExtractionOptions = {},
): string | undefined {
  const stripped = line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/^`{3,}.*$/, '')
    .replace(/^[`"'“”‘’)\]}，,、。；;：:.\s]+/, '')
    .trim();
  const compact = compactWorkflowAgentDigestLine(stripped);
  if (compact.length < 12) return undefined;
  if (/^[-*_`#\s]+$/.test(compact)) return undefined;
  if (isLowInformationWorkflowAgentDigestLine(compact)) return undefined;
  return options.truncateLines === false ? compact : trimWorkflowAgentDigestExcerpt(compact);
}

function extractWorkflowAgentDigestExcerpts(
  summary: string,
  options: WorkflowAgentDigestExtractionOptions = {},
): readonly string[] {
  const highSignal: string[] = [];
  const excerpts: string[] = [];
  for (const rawLine of summary.split(/\r?\n+/)) {
    const line = normalizeWorkflowAgentDigestLine(rawLine, options);
    if (!line) continue;
    const target = isHighSignalWorkflowAgentDigestLine(line) ? highSignal : excerpts;
    if (highSignal.includes(line) || excerpts.includes(line)) continue;
    target.push(line);
  }
  if (highSignal.length > 0) return highSignal.slice(0, MAX_WORKFLOW_AGENT_DIGEST_EXCERPTS);
  if (excerpts.length > 0) return excerpts.slice(0, MAX_WORKFLOW_AGENT_DIGEST_EXCERPTS);
  return [];
}

function formatWorkflowAgentLongDigest(
  name: string,
  summary: string,
  locale: WorkflowRunLocale,
  runId: string | undefined,
  summaryKind: WorkflowAgentSummaryKind = 'excerpt',
): string {
  const isModelDigest = summaryKind === 'digest';
  const excerpts = extractWorkflowAgentDigestExcerpts(summary, {
    truncateLines: !isModelDigest,
  });
  const excerptLines = excerpts.map((line) => `- ${line}`);
  const detailHint = runId
    ? locale === 'zh'
      ? `这是子 Agent 的有界摘要；/workflow show ${runId} 可查看运行事件时间线。`
      : `This is a child-agent digest; use /workflow show ${runId} for the event timeline.`
    : locale === 'zh'
      ? '这是子 Agent 的有界摘要；/workflow show 可查看运行事件时间线。'
      : 'This is a child-agent digest; use /workflow show for the event timeline.';
  // `digest-failed` tells the user the LLM self-distill was attempted but
  // unavailable (error/timeout), so the lines below are a deterministic
  // local excerpt — not the intended smart summary.
  const heading = locale === 'zh'
    ? isModelDigest
      ? `子 Agent ${name} 已完成。摘要：`
      : summaryKind === 'digest-failed'
        ? `子 Agent ${name} 已完成（智能摘要不可用，以下为本地摘录）：`
        : `子 Agent ${name} 已完成。摘录摘要：`
    : isModelDigest
      ? `Agent ${name} completed. Summary:`
      : summaryKind === 'digest-failed'
        ? `Agent ${name} completed (smart summary unavailable; local excerpt):`
        : `Agent ${name} completed. Extracted summary:`;
  if (excerptLines.length === 0) {
    const emptyHeading = locale === 'zh'
      ? `子 Agent ${name} 已完成，但未能提取到有效摘要。`
      : `Agent ${name} completed. No useful summary could be extracted.`;
    return [
      emptyHeading,
      detailHint,
    ].join('\n');
  }
  return [
    heading,
    ...excerptLines,
    detailHint,
  ].join('\n');
}

export function createWorkflowAgentDigestLimiter(
  runId: string,
): (event: WorkflowEvent, locale?: WorkflowRunLocale) => string | undefined {
  return (event, locale = 'en') => {
    return formatWorkflowAgentDigest(event, locale, runId);
  };
}

type WorkflowRunMessageCallback = NonNullable<CommandCallbacks['onWorkflowRunMessage']>;
type WorkflowRunUpdateCallback = NonNullable<CommandCallbacks['onWorkflowRunUpdate']>;

function readWorkflowEventUsageTokens(data: Record<string, unknown> | undefined): number {
  const usage = data?.usage;
  if (typeof usage !== 'object' || usage === null) return 0;
  const record = usage as Record<string, unknown>;
  const totalTokens = record.totalTokens;
  if (typeof totalTokens === 'number' && Number.isFinite(totalTokens) && totalTokens > 0) {
    return totalTokens;
  }
  const inputTokens = record.inputTokens;
  const outputTokens = record.outputTokens;
  const input = typeof inputTokens === 'number' && Number.isFinite(inputTokens) && inputTokens > 0
    ? inputTokens
    : 0;
  const output = typeof outputTokens === 'number' && Number.isFinite(outputTokens) && outputTokens > 0
    ? outputTokens
    : 0;
  return input + output;
}

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
  if (event.type === 'assistant') {
    console.log(`\n${event.text}\n`);
    return;
  }
  console.log(chalk.dim(`\n${event.text}\n`));
}

function workflowEventSink(
  callbacks: Pick<CommandCallbacks, 'onWorkflowRunMessage'>,
  live?: WorkflowLiveUpdateEmitter,
  options: {
    readonly presentation?: WorkflowRunPresentation;
    readonly locale?: WorkflowRunLocale;
    readonly runId?: string;
  } = {},
): (event: WorkflowEvent) => void {
  const digest = options.presentation === 'agentic'
    ? createWorkflowAgentDigestLimiter(options.runId ?? 'current')
    : undefined;
  return (event) => {
    live?.onEvent(event);
    const text = formatWorkflowEvent(event);
    if (!text) return;
    if (callbacks.onWorkflowRunMessage) {
      emitWorkflowRunMessage(callbacks, { type: 'event', text });
      if (digest) {
        const summary = digest(event, options.locale ?? 'en');
        if (summary) {
          emitWorkflowRunMessage(callbacks, {
            type: 'assistant',
            text: summary,
            final: false,
          });
        }
      }
      return;
    }
    renderWorkflowEvent(event);
  };
}

interface WorkflowLiveUpdateEmitter {
  onEvent(event: WorkflowEvent): void;
  onProcessEvent(event: WorkflowProcessEvent): void;
  complete(status: 'completed' | 'failed' | 'stopped', message?: string): void;
  running(message?: string): void;
}

function subscribeWorkflowLiveProcess(
  manager: WorkflowRunManager,
  live: WorkflowLiveUpdateEmitter,
  runId: string,
): () => void {
  return manager.subscribeWorkflowProcess((event) => {
    if (event.snapshot.runId !== runId) return;
    live.onProcessEvent(event);
  });
}

export function createWorkflowLiveUpdateEmitter(
  callbacks: Pick<CommandCallbacks, 'onWorkflowRunUpdate'>,
  runId: string,
  meta: WorkflowMeta,
  locale: WorkflowRunLocale = 'en',
): WorkflowLiveUpdateEmitter {
  const startedAt = Date.now();
  const activeAgents = new Map<string, string>();
  let phase: string | undefined;
  let totalSpawned = 0;
  let completedAgents = 0;
  let failedAgents = 0;
  let stoppedAgents = 0;
  let tokenBudgetSpent = 0;
  let terminal = false;
  const phases = meta.phases ?? [];
  const tokenBudgetTotal = meta.tokenBudget !== undefined && Number.isFinite(meta.tokenBudget)
    ? meta.tokenBudget
    : undefined;

  const emit = (
    status: Parameters<WorkflowRunUpdateCallback>[0]['status'],
    message?: string,
  ): void => {
    const phaseOffset = phase === undefined ? -1 : phases.indexOf(phase);
    const phaseIndex = phaseOffset >= 0 ? phaseOffset + 1 : undefined;
    const phaseTotal = phases.length > 0 ? phases.length : undefined;
    callbacks.onWorkflowRunUpdate?.({
      runId,
      workflow: meta.name,
      status,
      ...(phase !== undefined ? { phase } : {}),
      ...(phaseIndex !== undefined ? { phaseIndex } : {}),
      ...(phaseTotal !== undefined ? { phaseTotal } : {}),
      startedAt,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      activeAgents: [...activeAgents.values()],
      totalSpawned,
      ...(meta.plannedAgents !== undefined ? { plannedAgents: meta.plannedAgents } : {}),
      ...(meta.maxAgents !== undefined ? { agentCap: meta.maxAgents } : {}),
      tokenBudgetSpent,
      ...(tokenBudgetTotal !== undefined ? { tokenBudgetTotal } : {}),
      completedAgents,
      failedAgents,
      stoppedAgents,
      ...(message !== undefined ? { message } : {}),
      locale,
    });
  };

  return {
    running: (message) => {
      if (!terminal) emit('running', message);
    },
    onProcessEvent: (event) => {
      if (terminal && event.type !== 'workflow_finished') return;
      const status = event.snapshot.status;
      if (
        event.type === 'workflow_finished'
        || status === 'completed'
        || status === 'failed'
        || status === 'cancelled'
      ) {
        terminal = true;
      }
      const message = event.type === 'workflow_updated' ? event.message : undefined;
      callbacks.onWorkflowRunUpdate?.(workflowLiveSnapshotFromProcess(
        event.snapshot,
        message === undefined ? { locale } : { locale, message },
      ));
    },
    onEvent: (event) => {
      if (terminal) return;
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
          tokenBudgetSpent += readWorkflowEventUsageTokens(event.data);
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
          tokenBudgetSpent += readWorkflowEventUsageTokens(event.data);
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
    complete: (status, message) => {
      if (terminal) return;
      terminal = true;
      emit(status, message);
    },
  };
}

export function observeManagedWorkflowDone(
  managed: ManagedWorkflowRun,
  callbacks: Pick<CommandCallbacks, 'onWorkflowRunMessage'>,
  runId: string,
  live?: WorkflowLiveUpdateEmitter,
  options: {
    readonly canRerun?: boolean;
    readonly presentation?: WorkflowRunPresentation;
    readonly locale?: WorkflowRunLocale;
  } = {},
): void {
  void managed.done.then((outcome) => {
    if (outcome.kind === 'failed') {
      if (managed.getSnapshot?.()?.status === 'stopped') {
        live?.complete('stopped', 'Workflow stopped by user.');
        return;
      }
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
      const locale = options.locale ?? 'en';
      const resultOptions = { full: options.presentation === 'agentic' };
      const directResultText = formatResult(outcome.result, resultOptions)
        ?? formatArtifactResult(outcome.state.artifacts, locale, resultOptions);
      const fallbackResultText = directResultText === undefined
        ? formatFinalEventSummary(outcome.state.events, resultOptions)
        : undefined;
      const resultText = directResultText ?? fallbackResultText;
      live?.complete('completed', resultText ? 'completed with result' : 'completed');
      if (options.presentation === 'agentic') {
        emitWorkflowRunMessage(callbacks, {
          type: 'assistant',
          text: formatWorkflowCompletionAnswer({
            runId,
            totalSpawned: outcome.state.totalSpawned,
            ...(resultText !== undefined ? { resultText } : {}),
            ...(directResultText === undefined && fallbackResultText !== undefined
              ? { isFallbackPreview: true }
              : {}),
            locale,
          }),
          final: true,
        });
        return;
      }
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
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (managed.getSnapshot?.()?.status === 'stopped') {
      live?.complete('stopped', 'Workflow stopped by user.');
      return;
    }
    live?.complete('failed', message);
    emitWorkflowRunMessage(callbacks, {
      type: 'error',
      text: [
        `Workflow failed (${runId}): ${message}`,
        formatWorkflowFailureAction(runId, options.canRerun === true),
      ].join('\n'),
    });
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
  readonly presentation?: WorkflowRunPresentation;
  readonly sourceLabel?: string;
  readonly processSource?: WorkflowProcessSource;
  readonly generateWorkflow?: GenerateWorkflowForRequest;
  readonly runBaseDir?: string;
  readonly runManager?: WorkflowRunManager;
  readonly onBuilderEvent?: (event: WorkflowBuilderEvent) => void;
}

function emitWorkflowBuilderEvent(
  input: StartGeneratedWorkflowFromRequestOptions,
  event: WorkflowBuilderEvent,
): void {
  input.onBuilderEvent?.(event);
  if (event.stage === 'failed') {
    emitWorkflowRunMessage(input.callbacks, {
      type: 'error',
      text: `Workflow builder failed: ${event.message}`,
    });
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

function buildWorkflowProcessMetadata(input: {
  readonly source: WorkflowProcessSource;
  readonly displayName: string;
  readonly goal?: string;
  readonly savedWorkflowName?: string;
  readonly sourceRunId?: string;
  readonly sourceWorkflowName?: string;
  readonly revisionOf?: string;
}): WorkflowRunProcessMetadata {
  return {
    source: input.source,
    displayName: input.displayName,
    ...(input.goal !== undefined ? { goal: input.goal } : {}),
    ...(input.savedWorkflowName !== undefined ? { savedWorkflowName: input.savedWorkflowName } : {}),
    ...(input.sourceRunId !== undefined ? { sourceRunId: input.sourceRunId } : {}),
    ...(input.sourceWorkflowName !== undefined ? { sourceWorkflowName: input.sourceWorkflowName } : {}),
    ...(input.revisionOf !== undefined ? { revisionOf: input.revisionOf } : {}),
  };
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

  const locale = detectWorkflowLocale(input.request);
  let options: ReturnType<NonNullable<CommandCallbacks['createKodaXOptions']>>;
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
    options = createOptions();
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
  const presentation = input.presentation ?? 'command';
  const approvalSummary = buildApprovalSummary(generated.module);
  if (presentation !== 'agentic') {
    emitWorkflowRunMessage(input.callbacks, {
      type: 'info',
      text: `Generated workflow: ${generated.approvalSummary}`,
    });
  }
  const projectKey = deriveProjectKeyFromRoot(process.cwd()).key;
  const baseDir = input.runBaseDir ?? getAgentConfigPath('workflow-runs', projectKey);
  const manager = input.runManager ?? getDefaultWorkflowRunManager();
  const runId = `run-${Date.now().toString(36)}`;
  const runDir = join(baseDir, runId);

  if (confirm) {
    const approved = await confirm(
      renderApprovalPrompt(approvalSummary, {
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
    if (presentation !== 'agentic') {
      emitWorkflowRunMessage(input.callbacks, {
        type: 'info',
        text: renderApprovalPrompt(approvalSummary, {
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
  }

  if (presentation === 'agentic') {
    emitWorkflowRunMessage(input.callbacks, {
      type: 'assistant',
      text: formatWorkflowLaunchAnswer({
        runId,
        summary: approvalSummary,
        approvalSummary: generated.approvalSummary,
        locale,
      }),
      final: false,
    });
  } else {
    emitWorkflowRunMessage(input.callbacks, {
      type: 'info',
      text: `Started workflow ${generated.module.meta.name} (${runId}). Use /workflow show ${runId} for status.`,
    });
  }
  const live = createWorkflowLiveUpdateEmitter(input.callbacks, runId, generated.module.meta, locale);
  live.running(`Use /workflow show ${runId} for status or /workflow stop ${runId} to stop.`);
  const unsubscribeProcess = subscribeWorkflowLiveProcess(manager, live, runId);

  const managed = manager.startFromOptions({
    module: generated.module,
    args: { request: input.request },
    options,
    runId,
    runDir,
    scriptSnapshot: generated.scriptSnapshot,
    processMetadata: buildWorkflowProcessMetadata({
      source: input.processSource ?? 'command',
      displayName: generated.module.meta.name,
      goal: input.request,
    }),
    onEvent: workflowEventSink(input.callbacks, undefined, {
      presentation: input.presentation ?? 'command',
      locale,
      runId,
    }),
  });
  void managed.done.finally(unsubscribeProcess);
  emitWorkflowBuilderEvent(input, {
    stage: 'launched',
    message: `Workflow ${generated.module.meta.name} started`,
  });

  observeManagedWorkflowDone(managed, input.callbacks, runId, live, {
    canRerun: true,
    presentation,
    locale,
  });

  return 'started';
}

export const workflowCommand: Command = {
  name: 'workflow',
  description: 'Run a dynamic multi-agent workflow (FEATURE_217)',
  usage: '/workflow [help | list | runs | show | pause | resume | stop | delete | prune | rerun | save | rename | revise | create | <name> [args]]',
  argumentHint: 'help | list | runs [--all|--limit N] | show [runId] | pause <runId> | resume <runId> | stop [runId] | delete <runId> | prune --dry-run|--keep N|--older-than Nd | rerun <runId|savedName> [args] | save <runId> <name> | rename <runId|savedName> <newName> | revise [--replace] <runId|savedName> <change> | create <request> | <name> [args]',
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
      console.log(formatWorkflowRunSnapshot(managed, detail, { full: invocation.full === true }));
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
      const runId = invocation.runId || selectDefaultActiveWorkflowRunId(manager.list());
      if (!runId) {
        console.log(chalk.yellow('\nNo active workflow to stop.\n'));
        return;
      }
      if (!ensureSafeRunId(runId)) return;
      const ok = manager.stop(runId, 'stopped by user');
      const snapshot = manager.get(runId);
      const detail = snapshot ? readWorkflowRunDetail(baseDir, runId) : undefined;
      const nextActions = formatWorkflowNextActions(
        runId,
        canRerunWorkflowRun(snapshot, detail),
      );
      console.log(ok
        ? chalk.dim(`Stopped workflow ${runId}.\n`)
        : snapshot && !isActiveManagedWorkflowRun(snapshot)
          ? chalk.yellow(`Workflow ${runId} is already ${snapshot.status}. Next: ${nextActions}.\n`)
          : chalk.yellow(`No active workflow ${runId}.\n`));
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

    if (invocation.kind === 'rename') {
      if (!invocation.target || !invocation.newName) {
        console.log(chalk.yellow('\nUsage: /workflow rename <runId|savedName> <newName>\n'));
        return;
      }
      const resolution = await resolveWorkflowIdentity({
        target: invocation.target,
        runBaseDir: baseDir,
        savedWorkflowDirs: dirs,
      });
      if (resolution.kind === 'ambiguous') {
        console.log(
          chalk.red(
            `\n[workflow] ambiguous rename target: ${invocation.target} matches both a workflow run id and a saved workflow name.\n`,
          ),
        );
        return;
      }
      if (resolution.kind === 'missing') {
        console.log(chalk.red(`\n[workflow] rename target not found: ${invocation.target}\n`));
        return;
      }
      if (resolution.kind === 'run') {
        if (!writeWorkflowRunDisplayName(baseDir, resolution.runId, invocation.newName)) {
          console.log(chalk.red(`\n[workflow] rename failed: ${resolution.runId}\n`));
          return;
        }
        console.log(chalk.green(`\nRenamed workflow run ${resolution.runId} to ${invocation.newName.trim()}.\n`));
        return;
      }
      try {
        const renamed = await renameSavedWorkflow({
          dirs,
          name: resolution.savedWorkflow.name,
          newName: invocation.newName,
          source: resolution.savedWorkflow.source,
        });
        console.log(chalk.green(`\nRenamed saved workflow ${invocation.target} to ${renamed.name}.\n`));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(chalk.red(`\n[workflow] rename failed: ${message}\n`));
      }
      return;
    }

    if (invocation.kind === 'revise') {
      if (!invocation.target || !invocation.request) {
        console.log(chalk.yellow('\nUsage: /workflow revise [--replace] <runId|savedName> <change request>\n'));
        return;
      }
      const confirm = resolveConfirm(callbacks);
      if (!confirm) {
        console.log(
          chalk.red('\n[workflow] refusing to revise a workflow without an interactive approval channel.\n'),
        );
        return;
      }
      const createOptions = callbacks.createKodaXOptions;
      if (!createOptions) {
        console.log(chalk.red('\n[workflow] cannot revise - REPL options unavailable in this context.\n'));
        return;
      }
      const resolution = await resolveWorkflowIdentity({
        target: invocation.target,
        runBaseDir: baseDir,
        savedWorkflowDirs: dirs,
      });
      if (resolution.kind === 'ambiguous') {
        console.log(
          chalk.red(
            `\n[workflow] ambiguous revise target: ${invocation.target} matches both a workflow run id and a saved workflow name.\n`,
          ),
        );
        return;
      }
      if (resolution.kind === 'missing') {
        console.log(chalk.red(`\n[workflow] revise target not found: ${invocation.target}\n`));
        return;
      }
      if (invocation.replace === true && resolution.kind !== 'saved') {
        console.log(chalk.red('\n[workflow] revise --replace requires a saved workflow name target.\n'));
        return;
      }
      let capsule: WorkflowCapsule;
      try {
        if (resolution.kind === 'run') {
          capsule = (await loadGeneratedWorkflowFromRun({ runDir: resolution.runDir })).capsule;
        } else {
          if (resolution.savedWorkflow.execution !== 'capability-generated') {
            console.log(chalk.red('\n[workflow] only generated workflow capsules can be revised.\n'));
            return;
          }
          capsule = await loadSavedWorkflowCapsule(resolution.savedWorkflow.path);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(chalk.red(`\n[workflow] revise failed: ${message}\n`));
        return;
      }

      const revisionRequest = buildWorkflowRevisionRequest({
        target: invocation.target,
        capsule,
        changeRequest: invocation.request,
      });
      let generated: Awaited<ReturnType<typeof generateWorkflowFromOptions>>;
      try {
        generated = await generateWorkflowFromOptions({
          request: revisionRequest,
          options: createOptions(),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(chalk.red(`\n[workflow] revise generation failed: ${message}\n`));
        return;
      }
      if (generated.kind === 'declined') {
        console.log(chalk.dim(`\nWorkflow revision not created: ${generated.reason}\n`));
        return;
      }
      const replaceSavedResolution = invocation.replace === true && resolution.kind === 'saved'
        ? resolution
        : undefined;
      const replaceWorkflowName = replaceSavedResolution?.savedWorkflow.name;
      const savedName = replaceWorkflowName
        ?? await nextRevisionWorkflowName(dirs, generated.manifest.name);
      const manifest = savedName === generated.manifest.name
        ? generated.manifest
        : { ...generated.manifest, name: savedName };
      const approved = await confirm(
        renderApprovalPrompt(buildApprovalSummary({ meta: manifest, run: generated.module.run }), {
          source: replaceWorkflowName
            ? `revision-replace:${replaceWorkflowName}`
            : `revision:${invocation.target}`,
          sandbox: 'capability-generated',
          mayUseWorktree: manifest.mayUseWorktree === true,
          rawScript: generated.source,
        }),
      );
      if (!approved) {
        console.log(chalk.dim('Workflow revision cancelled.\n'));
        return;
      }
      const revisionInput = {
        name: savedName,
        manifest,
        source: generated.source,
        intent: {
          taskClass: manifest.patterns[0] ?? manifest.name,
          originalRequest: invocation.request,
          reusableFor: [manifest.description],
        },
        ...(capsule.inputs !== undefined ? { inputs: capsule.inputs } : {}),
        ...(capsule.requires !== undefined ? { requires: capsule.requires } : {}),
        provenance: buildWorkflowRevisionProvenance({
          capsule,
          resolution,
          ...(replaceWorkflowName !== undefined ? { replacesWorkflowName: replaceWorkflowName } : {}),
        }),
      };
      if (replaceSavedResolution) {
        const ref = await replaceSavedWorkflow({
          ...revisionInput,
          dirs,
          savedSource: replaceSavedResolution.savedWorkflow.source,
        });
        console.log(
          chalk.green(
            `\nReplaced saved workflow ${ref.name} with revised capsule at ${ref.path}\n`,
          ),
        );
        console.log(chalk.dim(`Previous capsule archived at ${ref.previousPath}\n`));
        return;
      }

      const ref = await saveGeneratedWorkflow({
        ...revisionInput,
        dir: dirs.project ?? join(process.cwd(), '.kodax', 'workflows'),
      });
      console.log(chalk.green(`\nSaved workflow revision ${ref.name} to ${ref.path}\n`));
      return;
    }

    if (invocation.kind === 'rerun') {
      if (!invocation.runId) {
        console.log(chalk.yellow('\nUsage: /workflow rerun <runId|savedName> [args]\n'));
        return;
      }
      if (!ensureSafeRunId(invocation.runId)) return;
      const confirm = resolveConfirm(callbacks);
      if (!confirm) {
        console.log(
          chalk.red('\n[workflow] refusing to rerun a workflow without an interactive approval channel.\n'),
        );
        return;
      }
      const createOptions = callbacks.createKodaXOptions;
      if (!createOptions) {
        console.log(chalk.red('\n[workflow] cannot start — REPL options unavailable in this context.\n'));
        return;
      }
      const savedRef = (await discoverSavedWorkflows(dirs)).find((r) => r.name === invocation.runId);
      const targetMatchesRun = manager.list().some((run) => run.runId === invocation.runId) ||
        existsSync(join(baseDir, invocation.runId, 'run.json'));
      if (savedRef && targetMatchesRun) {
        console.log(
          chalk.red(
            `\n[workflow] ambiguous rerun target: ${invocation.runId} matches both a workflow run id and a saved workflow name.\n`,
          ),
        );
        console.log(
          chalk.yellow(
            `Use /workflow ${invocation.runId} to run the saved workflow, or rerun a unique run id/name.\n`,
          ),
        );
        return;
      }
      if (savedRef && !targetMatchesRun) {
        const prepared = await prepareSavedWorkflow(savedRef, confirm);
        if (!prepared) return;
        const locale = inferWorkflowLocaleFromParts(
          invocation.rawArgs,
          prepared.module.meta.name,
          prepared.module.meta.description,
          prepared.scriptSnapshot?.source,
        );
        const presentation: WorkflowRunPresentation = 'agentic';
        const approved = await confirm(
          renderApprovalPrompt(buildApprovalSummary(prepared.module), prepared.approvalContext),
        );
        if (!approved) {
          console.log(chalk.dim('Workflow cancelled.\n'));
          return;
        }
        const newRunId = `run-${Date.now().toString(36)}`;
        const newRunDir = join(baseDir, newRunId);
        console.log(chalk.dim(`\nStarted workflow ${prepared.module.meta.name} (${newRunId}). Use /workflow show ${newRunId} for status.\n`));
        const live = createWorkflowLiveUpdateEmitter(callbacks, newRunId, prepared.module.meta, locale);
        live.running(`Use /workflow show ${newRunId} for status or /workflow stop ${newRunId} to stop.`);
        const unsubscribeProcess = subscribeWorkflowLiveProcess(manager, live, newRunId);
        const managed = manager.startFromOptions({
          module: prepared.module,
          args: parseWorkflowArgs(invocation.rawArgs),
          options: createOptions(),
          runId: newRunId,
          runDir: newRunDir,
          ...(prepared.scriptSnapshot ? { scriptSnapshot: prepared.scriptSnapshot } : {}),
          processMetadata: buildWorkflowProcessMetadata({
            source: 'capsule',
            displayName: prepared.module.meta.name,
            savedWorkflowName: savedRef.name,
            sourceWorkflowName: savedRef.name,
          }),
          onEvent: workflowEventSink(callbacks, undefined, { presentation, locale, runId: newRunId }),
        });
        void managed.done.finally(unsubscribeProcess);
        observeManagedWorkflowDone(managed, callbacks, newRunId, live, {
          canRerun: prepared.scriptSnapshot !== undefined,
          presentation,
          locale,
        });
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
      const runDetail = readWorkflowRunDetail(baseDir, invocation.runId);
      const rawScriptPath = runDetail?.scriptSnapshotPath ?? join(baseDir, invocation.runId, 'script.js');
      const locale = inferWorkflowLocaleFromParts(
        invocation.rawArgs,
        loaded.capsule.manifest.name,
        loaded.capsule.manifest.description,
        loaded.capsule.source,
      );
      const presentation: WorkflowRunPresentation = 'agentic';
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
          rawScriptPath,
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
      const live = createWorkflowLiveUpdateEmitter(callbacks, newRunId, loaded.module.meta, locale);
      live.running(`Use /workflow show ${newRunId} for status or /workflow stop ${newRunId} to stop.`);
      const unsubscribeProcess = subscribeWorkflowLiveProcess(manager, live, newRunId);
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
        processMetadata: buildWorkflowProcessMetadata({
          source: 'command',
          displayName: loaded.module.meta.name,
          sourceRunId: invocation.runId,
        }),
        onEvent: workflowEventSink(callbacks, undefined, { presentation, locale, runId: newRunId }),
      });
      void managed.done.finally(unsubscribeProcess);
      observeManagedWorkflowDone(managed, callbacks, newRunId, live, {
        canRerun: true,
        presentation,
        locale,
      });
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
        presentation: 'agentic',
        sourceLabel: 'generated',
        processSource: 'command',
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
    let savedWorkflowRef: SavedWorkflowRef | undefined;
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
      savedWorkflowRef = ref;
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
            rawScriptPath: ref.path,
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
    const locale = inferWorkflowLocaleFromParts(
      invocation.rawArgs,
      module.meta.name,
      module.meta.description,
      scriptSnapshot?.source,
    );
    const live = createWorkflowLiveUpdateEmitter(callbacks, runId, module.meta, locale);
    live.running(`Use /workflow show ${runId} for status or /workflow stop ${runId} to stop.`);
    const presentation: WorkflowRunPresentation = 'agentic';
    const unsubscribeProcess = subscribeWorkflowLiveProcess(manager, live, runId);

    const managed = manager.startFromOptions({
      module,
      args: parseWorkflowArgs(invocation.rawArgs),
      options: createOptions(),
      runId,
      runDir,
      ...(scriptSnapshot ? { scriptSnapshot } : {}),
      processMetadata: savedWorkflowRef
        ? buildWorkflowProcessMetadata({
            source: 'capsule',
            displayName: module.meta.name,
            savedWorkflowName: savedWorkflowRef.name,
            sourceWorkflowName: savedWorkflowRef.name,
          })
        : buildWorkflowProcessMetadata({
            source: 'command',
            displayName: module.meta.name,
          }),
      onEvent: workflowEventSink(callbacks, undefined, { presentation, locale, runId }),
    });
    void managed.done.finally(unsubscribeProcess);

    observeManagedWorkflowDone(managed, callbacks, runId, live, {
      canRerun: scriptSnapshot !== undefined,
      presentation,
      locale,
    });
  },
};
