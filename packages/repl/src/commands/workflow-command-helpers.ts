import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import chalk from 'chalk';
import { getAgentConfigPath } from '@kodax-ai/agent';
import type {
  WorkflowApprovalSummary,
  WorkflowArtifactRef,
  WorkflowCapsule,
  WorkflowCapsuleProvenance,
  WorkflowEvent,
  WorkflowMeta,
  WorkflowModule,
  WorkflowScriptManifest,
} from '@kodax-ai/agent';
import {
  discoverSavedWorkflows,
  loadSavedWorkflowCapsule,
  loadSavedWorkflow,
  preflightWorkflowCapsule,
  resolveWorkflowIdentity,
  safeWorkflowArtifactName,
  type ManagedWorkflowSnapshot,
  type SavedWorkflowDirs,
  type SavedWorkflowRef,
} from '@kodax-ai/coding';

import { KODAX_VERSION } from '../common/utils.js';
import type { WorkflowPruneOptions } from './workflow-command-parse.js';

const TERMINAL_WORKFLOW_STATUSES = new Set(['completed', 'failed', 'stopped', 'denied']);
const MAX_WORKFLOW_AGENT_DIGEST_EXCERPTS = 4;
const MAX_WORKFLOW_AGENT_DIGEST_EXCERPT_CHARS = 180;

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

export function canRerunWorkflowRun(
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

export function formatWorkflowNextActions(runId: string, canRerun: boolean): string {
  return canRerun
    ? `/workflow show ${runId} | /workflow rerun ${runId}`
    : `/workflow show ${runId}`;
}

export function formatWorkflowFailureAction(runId: string, canRerun: boolean): string {
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

export async function nextRevisionWorkflowName(
  dirs: SavedWorkflowDirs,
  preferredName: string,
): Promise<string> {
  const existing = new Set((await discoverSavedWorkflows(dirs)).map((ref) => ref.name));
  if (!existing.has(preferredName)) return preferredName;
  return `${preferredName}-revision-${Date.now().toString(36)}`;
}

export function buildWorkflowRevisionProvenance(input: {
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

export function printWorkflowHelp(): void {
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

export function ensureSafeRunId(runId: string): boolean {
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

export function currentWorkflowPreflightEnv(): {
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

export function printPreflightFailure(result: ReturnType<typeof preflightWorkflowCapsule>): void {
  console.log(chalk.red('\n[workflow] capsule preflight failed:'));
  for (const issue of result.issues) {
    console.log(chalk.red(`  - ${issue.requirement}: ${issue.message}`));
  }
  console.log();
}

export function printPreflightWarnings(result: ReturnType<typeof preflightWorkflowCapsule>): void {
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

export async function prepareSavedWorkflow(
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

export function workflowEventStatus(event: WorkflowEvent): string | undefined {
  const status = event.data?.status;
  return typeof status === 'string' ? status : undefined;
}

export function formatWorkflowEvent(event: WorkflowEvent): string | undefined {
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

export function renderWorkflowEvent(event: WorkflowEvent): void {
  const text = formatWorkflowEvent(event);
  if (text) console.log(chalk.dim(text));
}

const MAX_WORKFLOW_RESULT_PREVIEW_CHARS = 6000;
const MAX_WORKFLOW_LAUNCH_SUMMARY_CHARS = 360;
const WORKFLOW_RESULT_TRUNCATED_MARKER = '[truncated]';

export type WorkflowRunPresentation = 'command' | 'agentic';
export type WorkflowRunLocale = 'en' | 'zh';

export interface WorkflowResultFormatOptions {
  readonly full?: boolean;
}

export function detectWorkflowLocale(text: string): WorkflowRunLocale {
  return /[\u3400-\u9fff]/u.test(text) ? 'zh' : 'en';
}

export function inferWorkflowLocaleFromParts(
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

export function isWorkflowResultPreviewTruncated(text: string): boolean {
  return text.includes(WORKFLOW_RESULT_TRUNCATED_MARKER);
}

function formatWorkflowResultTruncationHint(runId: string, locale: WorkflowRunLocale): string {
  return locale === 'zh'
    ? `[结果预览已截断。完整结果请用 /workflow show --full ${runId} 查看；artifact 文件也保存在本次 run 目录。]`
    : `[Result preview truncated. Use /workflow show --full ${runId} for the complete result; artifacts are also saved in the run directory.]`;
}

export function replaceWorkflowResultTruncationMarker(
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

export function formatArtifactResult(
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

export function formatWorkflowCompletionAnswer(input: {
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

export function formatWorkflowLaunchAnswer(input: {
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

