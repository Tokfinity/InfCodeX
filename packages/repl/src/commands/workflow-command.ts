/**
 * FEATURE_217 (v0.7.49) Phase D.2 — `/workflow` slash command.
 *
 * Surfaces the Dynamic Workflow Harness in the REPL:
 *   /workflow [list]        — list built-in + saved workflows
 *   /workflow runs          — list this project's workflow runs
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

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import chalk from 'chalk';
import { getAgentConfigPath } from '@kodax-ai/agent';
import type {
  WorkflowApprovalSummary,
  WorkflowEvent,
  WorkflowMeta,
  WorkflowModule,
} from '@kodax-ai/agent';
import {
  buildApprovalSummary,
  createRunGraphWriter,
  getBuiltinWorkflow,
  listBuiltinWorkflows,
  listWorkflowPatternTemplates,
  discoverSavedWorkflows,
  generateWorkflowFromOptions,
  getDefaultWorkflowRunManager,
  loadSavedWorkflow,
  saveGeneratedWorkflowFromRun,
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
  | { readonly kind: 'runs' }
  | { readonly kind: 'show'; readonly runId: string }
  | { readonly kind: 'pause'; readonly runId: string }
  | { readonly kind: 'resume'; readonly runId: string }
  | { readonly kind: 'stop'; readonly runId: string }
  | { readonly kind: 'save'; readonly runId: string; readonly name: string }
  | { readonly kind: 'create'; readonly request: string }
  | { readonly kind: 'start'; readonly name: string; readonly rawArgs: string };

export function parseWorkflowInvocation(args: readonly string[]): WorkflowInvocation {
  const first = args[0]?.toLowerCase();
  if (first === 'help' || first === '--help' || first === '-h') return { kind: 'help' };
  if (!first || first === 'list') return { kind: 'list' };
  if (first === 'runs') return { kind: 'runs' };
  if (first === 'show') return { kind: 'show', runId: args[1] ?? '' };
  if (first === 'pause') return { kind: 'pause', runId: args[1] ?? '' };
  if (first === 'resume') return { kind: 'resume', runId: args[1] ?? '' };
  if (first === 'stop') return { kind: 'stop', runId: args[1] ?? '' };
  if (first === 'save') return { kind: 'save', runId: args[1] ?? '', name: args[2] ?? '' };
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

export function formatWorkflowList(metas: readonly WorkflowMeta[]): string {
  if (metas.length === 0) return '  (no built-in workflows)';
  return metas.map((m) => `  ${chalk.cyan(m.name)} — ${m.description}`).join('\n');
}

export interface WorkflowApprovalRenderContext {
  readonly source: string;
  readonly sandbox: string;
  readonly mayUseWorktree: boolean;
  readonly rawScriptPath?: string;
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
    `  max agents: ${cap(summary.maxAgents)} · max concurrency: ${cap(summary.maxConcurrency)} · token budget: ${cap(summary.tokenBudget)}`,
    `  writes files: ${summary.writesFiles ? chalk.yellow('yes') : 'no (read-only)'}`,
    ...(context
      ? [
          `  source: ${context.source}`,
          `  sandbox/trust: ${context.sandbox}`,
          `  worktree isolation: ${context.mayUseWorktree ? 'may request worktree' : 'shared cwd / per-child default'}`,
          ...(context.rawScriptPath ? [`  raw script: ${context.rawScriptPath}`] : []),
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

export function formatManagedRunsList(runs: readonly ManagedWorkflowSnapshot[]): string {
  if (runs.length === 0) return '  (no active workflow runs)';
  return runs
    .map(
      (r) =>
        `  ${statusIcon(r.status)} ${chalk.cyan(r.workflow)} ${chalk.dim(r.runId)} - ${r.status} (${r.totalSpawned} agents, ${r.eventCount} events)`,
    )
    .join('\n');
}

export function formatWorkflowRunSnapshot(run: ManagedWorkflowSnapshot | undefined): string {
  if (!run) return '  (unknown active workflow run)';
  return [
    `  ${chalk.cyan(run.workflow)} ${chalk.dim(run.runId)}`,
    `  status: ${run.status}`,
    `  agents: ${run.totalSpawned}`,
    `  events: ${run.eventCount}`,
    `  run dir: ${run.runDir}`,
    ...(run.error ? [`  error: ${run.error}`] : []),
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

export function renderWorkflowHelp(): string {
  return [
    `${chalk.bold('/workflow')} - dynamic multi-agent workflow harness`,
    '',
    `${chalk.bold('Subcommands:')}`,
    `  ${chalk.cyan('/workflow list')}                         List built-in, pattern, and saved workflows. Alias: /workflow`,
    `  ${chalk.cyan('/workflow create <request>')}             Generate a restricted workflow from a complex request.`,
    `  ${chalk.cyan('/workflow <name> [args]')}                Run a built-in or saved workflow. Args may be JSON or bare text.`,
    `  ${chalk.cyan('/workflow runs')}                         List active and persisted workflow runs for this project.`,
    `  ${chalk.cyan('/workflow show <runId>')}                 Show status for an active same-session workflow run.`,
    `  ${chalk.cyan('/workflow pause <runId>')}                Pause future child launches for an active run.`,
    `  ${chalk.cyan('/workflow resume <runId>')}               Resume a paused run.`,
    `  ${chalk.cyan('/workflow stop <runId>')}                 Stop an active run through abort propagation.`,
    `  ${chalk.cyan('/workflow save <runId> <name>')}          Save a generated run as .kodax/workflows/<name>.workflow.json.`,
    `  ${chalk.cyan('/workflow help')}                         Show this help. Also available as /help workflow.`,
    '',
    `${chalk.bold('Examples:')}`,
    `  ${chalk.dim('/workflow create Compare three flaky-test hypotheses and verify each one')}`,
    `  ${chalk.dim('/workflow parallel-investigation {"question":"Where is the race?","targets":["packages/agent"]}')}`,
    `  ${chalk.dim('/workflow save run-lx3 generated-audit')}`,
    '',
    `${chalk.bold('Safety:')}`,
    '  - Generated and .workflow.json workflows run in the capability WorkflowApi runner.',
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

export type GeneratedWorkflowApprovalMode = 'required' | 'silent';
export type GeneratedWorkflowStartOutcome = 'started' | 'declined' | 'cancelled' | 'failed';

export interface StartGeneratedWorkflowFromRequestOptions {
  readonly request: string;
  readonly callbacks: Pick<CommandCallbacks, 'createKodaXOptions' | 'confirm' | 'readline'>;
  readonly approval: GeneratedWorkflowApprovalMode;
  readonly sourceLabel?: string;
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
    generated = await generateWorkflowFromOptions({
      request: input.request,
      options,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(chalk.red(`\n[workflow] generation failed: ${message}\n`));
    return 'failed';
  }

  if (generated.kind === 'declined') {
    console.log(chalk.dim(`\nWorkflow not created: ${generated.reason}\n`));
    return 'declined';
  }

  console.log(chalk.dim(`\nGenerated workflow: ${generated.approvalSummary}\n`));
  const projectKey = deriveProjectKeyFromRoot(process.cwd()).key;
  const baseDir = getAgentConfigPath('workflow-runs', projectKey);
  const manager = getDefaultWorkflowRunManager();
  const runId = `run-${Date.now().toString(36)}`;
  const runDir = join(baseDir, runId);
  const scriptSnapshot = createRunGraphWriter(runDir).writeScriptSnapshot(generated.scriptSnapshot);

  if (confirm) {
    const approved = await confirm(
      renderApprovalPrompt(buildApprovalSummary(generated.module), {
        source: input.sourceLabel ?? 'generated',
        sandbox: 'capability-generated',
        mayUseWorktree: generated.manifest.mayUseWorktree === true,
        rawScriptPath: scriptSnapshot.scriptPath,
      }),
    );
    if (!approved) {
      console.log(chalk.dim('Workflow cancelled.\n'));
      return 'cancelled';
    }
  } else {
    console.log(chalk.dim('AMAW auto-start: capability-isolated generated workflow; normal permission gates still apply.\n'));
  }

  console.log(chalk.dim(`\nStarted workflow ${generated.module.meta.name} (${runId}). Use /workflow show ${runId} for status.\n`));

  const managed = manager.startFromOptions({
    module: generated.module,
    args: { request: input.request },
    options,
    runId,
    runDir,
    scriptSnapshot: generated.scriptSnapshot,
    onEvent: renderWorkflowEvent,
  });

  void managed.done.then((outcome) => {
    if (outcome.kind === 'failed') {
      console.log(chalk.red(`\nWorkflow failed: ${outcome.error.message}\n`));
      return;
    }
    if (outcome.kind === 'completed') {
      console.log(chalk.green(`\nWorkflow completed (${outcome.state.totalSpawned} agents, run ${runId}).`));
      renderResult(outcome.result);
    }
  });

  return 'started';
}

export const workflowCommand: Command = {
  name: 'workflow',
  description: 'Run a dynamic multi-agent workflow (FEATURE_217)',
  usage: '/workflow [help | list | runs | show | pause | resume | stop | save | create | <name> [args]]',
  argumentHint: 'help | list | runs | show <runId> | pause <runId> | resume <runId> | stop <runId> | save <runId> <name> | create <request> | <name> [args]',
  detailedHelp: printWorkflowHelp,
  handler: async (args, _context, callbacks) => {
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
      const active = manager.list();
      if (active.length > 0) {
        console.log(chalk.bold('\nActive workflow runs:'));
        console.log(formatManagedRunsList(active));
      }
      console.log(chalk.bold('\nWorkflow runs:'));
      console.log(formatRunsList(readWorkflowRuns(baseDir)));
      console.log();
      return;
    }

    if (invocation.kind === 'show') {
      console.log(chalk.bold('\nWorkflow run:'));
      console.log(formatWorkflowRunSnapshot(manager.get(invocation.runId)));
      console.log();
      return;
    }

    if (invocation.kind === 'pause') {
      const ok = manager.pause(invocation.runId);
      console.log(ok ? chalk.dim(`Paused workflow ${invocation.runId}.\n`) : chalk.yellow(`No running workflow ${invocation.runId}.\n`));
      return;
    }

    if (invocation.kind === 'resume') {
      const ok = manager.resume(invocation.runId);
      console.log(ok ? chalk.dim(`Resumed workflow ${invocation.runId}.\n`) : chalk.yellow(`No paused workflow ${invocation.runId}.\n`));
      return;
    }

    if (invocation.kind === 'stop') {
      const ok = manager.stop(invocation.runId, 'stopped by user');
      console.log(ok ? chalk.dim(`Stopped workflow ${invocation.runId}.\n`) : chalk.yellow(`No active workflow ${invocation.runId}.\n`));
      return;
    }

    if (invocation.kind === 'save') {
      if (!invocation.runId || !invocation.name) {
        console.log(chalk.yellow('\nUsage: /workflow save <runId> <name>\n'));
        return;
      }
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

    if (invocation.kind === 'create') {
      if (!invocation.request) {
        console.log(chalk.yellow('\nUsage: /workflow create <request>\n'));
        return;
      }
      await startGeneratedWorkflowFromRequest({
        request: invocation.request,
        callbacks,
        approval: 'required',
        sourceLabel: 'generated',
      });
      return;
    }

    const confirm = resolveConfirm(callbacks);
    let approvalContext: WorkflowApprovalRenderContext = {
      source: 'built-in',
      sandbox: 'trusted package',
      mayUseWorktree: false,
    };
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
      if (ref.execution === 'trusted-local' && !confirm) {
        console.log(
          chalk.red(
            '\n[workflow] refusing to run a saved workflow — no interactive confirmation ' +
              'channel to authorize executing local code.\n',
          ),
        );
        return;
      }
      if (ref.execution === 'trusted-local') {
        const trusted = await confirm!(
          `Run local workflow file? This EXECUTES local code:\n  ${ref.path}`,
        );
        if (!trusted) {
          console.log(chalk.dim('Workflow cancelled.\n'));
          return;
        }
      }
      try {
        module = await loadSavedWorkflow(ref.path);
        approvalContext = {
          source: `saved:${ref.source}`,
          sandbox: ref.execution,
          mayUseWorktree: false,
        };
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

    const approval = confirm
      ? (summary: WorkflowApprovalSummary) => confirm(renderApprovalPrompt(summary, approvalContext))
      : undefined;

    if (approval) {
      const approved = await approval(buildApprovalSummary(module));
      if (!approved) {
        console.log(chalk.dim('Workflow cancelled.\n'));
        return;
      }
    }

    const runId = `run-${Date.now().toString(36)}`;
    const runDir = join(baseDir, runId);
    console.log(chalk.dim(`\nStarted workflow ${module.meta.name} (${runId}). Use /workflow show ${runId} for status.\n`));

    const managed = manager.startFromOptions({
      module,
      args: parseWorkflowArgs(invocation.rawArgs),
      options: createOptions(),
      runId,
      runDir,
      onEvent: renderWorkflowEvent,
    });

    void managed.done.then((outcome) => {
      if (outcome.kind === 'failed') {
        console.log(chalk.red(`\nWorkflow failed: ${outcome.error.message}\n`));
        return;
      }
      if (outcome.kind === 'completed') {
        console.log(chalk.green(`\nWorkflow completed (${outcome.state.totalSpawned} agents, run ${runId}).`));
        renderResult(outcome.result);
      }
    });
  },
};
