/**
 * FEATURE_217 (v0.7.49) Phase D.2 — `/workflow` slash command.
 *
 * Surfaces the Dynamic Workflow Harness in the REPL:
 *   /workflow [list]        — list built-in workflows
 *   /workflow runs          — list this project's workflow runs
 *   /workflow <name> [args] — run a built-in workflow (with approval)
 *
 * First version only accepts built-in workflows (no arbitrary user
 * `.ts`). Execution routes through `runWorkflowFromOptions` in
 * `@kodax-ai/coding`, which builds the tool-execution context internally —
 * the command only supplies plain `KodaXOptions` (from
 * `createKodaXOptions`) + an approval gate (`callbacks.confirm`).
 *
 * Pure helpers (parse / list / runs / approval text) are exported for
 * unit testing; the handler is a thin wiring layer.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import chalk from 'chalk';
import { getAgentConfigPath } from '@kodax-ai/agent';
import type {
  WorkflowApprovalSummary,
  WorkflowEvent,
  WorkflowMeta,
  WorkflowModule,
} from '@kodax-ai/agent/workflow';
import {
  buildApprovalSummary,
  getBuiltinWorkflow,
  listBuiltinWorkflows,
  runWorkflowFromOptions,
  discoverSavedWorkflows,
  loadSavedWorkflow,
  type SavedWorkflowDirs,
  type SavedWorkflowRef,
} from '@kodax-ai/coding';

import { deriveProjectKeyFromRoot } from '../interactive/project-key.js';
import type { Command } from './types.js';

/* ----------------------------- pure helpers ----------------------------- */

export type WorkflowInvocation =
  | { readonly kind: 'list' }
  | { readonly kind: 'runs' }
  | { readonly kind: 'start'; readonly name: string; readonly rawArgs: string };

export function parseWorkflowInvocation(args: readonly string[]): WorkflowInvocation {
  const first = args[0]?.toLowerCase();
  if (!first || first === 'list') return { kind: 'list' };
  if (first === 'runs') return { kind: 'runs' };
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

export function formatWorkflowList(metas: readonly WorkflowMeta[]): string {
  if (metas.length === 0) return '  (no built-in workflows)';
  return metas.map((m) => `  ${chalk.cyan(m.name)} — ${m.description}`).join('\n');
}

export function renderApprovalPrompt(summary: WorkflowApprovalSummary): string {
  const cap = (n: number | null): string => (n === null ? '∞' : String(n));
  return [
    `Run workflow ${chalk.cyan(summary.name)}?`,
    `  ${summary.description}`,
    `  phases: ${summary.phases.length > 0 ? summary.phases.join(' → ') : '(dynamic)'}`,
    `  max agents: ${cap(summary.maxAgents)} · max concurrency: ${cap(summary.maxConcurrency)} · token budget: ${cap(summary.tokenBudget)}`,
    `  writes files: ${summary.writesFiles ? chalk.yellow('yes') : 'no (read-only)'}`,
  ].join('\n');
}

export interface WorkflowRunSummary {
  readonly runId: string;
  readonly workflow: string;
  readonly status: string;
  readonly totalSpawned: number;
  readonly endedAt: number;
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
        runId: typeof data.runId === 'string' ? data.runId : entry,
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

function statusIcon(status: string): string {
  if (status === 'completed') return chalk.green('✓');
  if (status === 'failed') return chalk.red('✗');
  return chalk.dim('•');
}

export function formatRunsList(runs: readonly WorkflowRunSummary[]): string {
  if (runs.length === 0) return '  (no workflow runs yet)';
  return runs
    .map(
      (r) =>
        `  ${statusIcon(r.status)} ${chalk.cyan(r.workflow)} ${chalk.dim(r.runId)} — ${r.status} (${r.totalSpawned} agents)`,
    )
    .join('\n');
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
  return refs.map((r) => `  ${chalk.cyan(r.name)} ${chalk.dim(`(${r.source}: ${r.path})`)}`).join('\n');
}

/* ------------------------------- command -------------------------------- */

function renderWorkflowEvent(event: WorkflowEvent): void {
  const label = event.data?.name ?? event.data?.taskId ?? '';
  switch (event.type) {
    case 'phase_started':
      console.log(chalk.dim(`  ▶ phase: ${event.data?.name ?? ''}`));
      break;
    case 'agent_spawned':
      console.log(chalk.dim(`    + ${label}`));
      break;
    case 'agent_completed':
      console.log(chalk.dim(`    ✓ ${label}`));
      break;
    case 'agent_stopped':
      console.log(chalk.dim(`    ⊘ ${label}`));
      break;
    case 'synthesis_completed':
      console.log(chalk.dim('  ◆ synthesis complete'));
      break;
    default:
      break;
  }
}

function renderResult(result: unknown): void {
  if (result && typeof result === 'object' && 'synthesis' in result) {
    const synthesis = (result as { synthesis?: unknown }).synthesis;
    if (typeof synthesis === 'string') {
      console.log(`\n${synthesis}\n`);
    }
  }
}

export const workflowCommand: Command = {
  name: 'workflow',
  description: 'Run a dynamic multi-agent workflow (FEATURE_217)',
  usage: '/workflow [list | runs | <name> [args]]',
  argumentHint: 'list | runs | <name> [args]',
  handler: async (args, _context, callbacks) => {
    const invocation = parseWorkflowInvocation(args);
    const projectKey = deriveProjectKeyFromRoot(process.cwd()).key;
    const baseDir = getAgentConfigPath('workflow-runs', projectKey);

    const dirs = savedWorkflowDirs(process.cwd());

    if (invocation.kind === 'list') {
      console.log(chalk.bold('\nBuilt-in workflows:'));
      console.log(formatWorkflowList(listBuiltinWorkflows()));
      const saved = await discoverSavedWorkflows(dirs);
      if (saved.length > 0) {
        console.log(chalk.bold('\nSaved workflows:'));
        console.log(formatSavedList(saved));
      }
      console.log(chalk.dim('\n  Run one with: /workflow <name> <question or JSON args>\n'));
      return;
    }

    if (invocation.kind === 'runs') {
      console.log(chalk.bold('\nWorkflow runs:'));
      console.log(formatRunsList(readWorkflowRuns(baseDir)));
      console.log();
      return;
    }

    const confirmGate = callbacks.confirm;
    let module: WorkflowModule | undefined = getBuiltinWorkflow(invocation.name);
    if (!module) {
      // Not a built-in — try a saved workflow. Loading executes local
      // code, so gate it behind a trusted-local confirmation.
      const ref = (await discoverSavedWorkflows(dirs)).find((r) => r.name === invocation.name);
      if (!ref) {
        console.log(chalk.yellow(`\nUnknown workflow: ${invocation.name}`));
        console.log(formatWorkflowList(listBuiltinWorkflows()));
        console.log();
        return;
      }
      if (confirmGate) {
        const trusted = await confirmGate(
          `Run local workflow file? This EXECUTES local code:\n  ${ref.path}`,
        );
        if (!trusted) {
          console.log(chalk.dim('Workflow cancelled.\n'));
          return;
        }
      }
      try {
        module = await loadSavedWorkflow(ref.path);
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

    const confirm = callbacks.confirm;
    const approval = confirm
      ? (summary: WorkflowApprovalSummary) => confirm(renderApprovalPrompt(summary))
      : undefined;

    const runId = `run-${Date.now().toString(36)}`;
    const runDir = join(baseDir, runId);
    console.log(chalk.dim(`\nStarting workflow ${module.meta.name} (${runId})…`));

    const outcome = await runWorkflowFromOptions({
      module,
      args: parseWorkflowArgs(invocation.rawArgs),
      options: createOptions(),
      runId,
      runDir,
      ...(approval ? { approval } : {}),
      onEvent: renderWorkflowEvent,
    });

    if (outcome.kind === 'denied') {
      console.log(chalk.dim('Workflow cancelled.\n'));
      return;
    }
    if (outcome.kind === 'failed') {
      console.log(chalk.red(`\n✗ Workflow failed: ${outcome.error.message}\n`));
      return;
    }
    console.log(chalk.green(`\n✓ Workflow completed (${outcome.state.totalSpawned} agents, run ${runId}).`));
    renderResult(outcome.result);
  },
};
