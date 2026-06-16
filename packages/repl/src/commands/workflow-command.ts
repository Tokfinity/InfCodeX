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
import {
  buildWorkflowRevisionProvenance,
  canRerunWorkflowRun,
  createWorkflowAgentDigestLimiter,
  currentWorkflowPreflightEnv,
  detectWorkflowLocale,
  ensureSafeRunId,
  formatArtifactResult,
  formatFinalEventSummary,
  formatManagedRunsList,
  formatResult,
  formatRunsList,
  formatSavedList,
  formatWorkflowCompletionAnswer,
  formatWorkflowEvent,
  formatWorkflowFailureAction,
  formatWorkflowLaunchAnswer,
  formatWorkflowList,
  formatWorkflowNextActions,
  formatWorkflowPruneCandidates,
  formatWorkflowRunSnapshot,
  inferWorkflowLocaleFromParts,
  isActiveManagedWorkflowRun,
  nextRevisionWorkflowName,
  prepareSavedWorkflow,
  printPreflightFailure,
  printPreflightWarnings,
  printWorkflowHelp,
  readWorkflowRunDetail,
  readWorkflowRuns,
  renderApprovalPrompt,
  renderWorkflowEvent,
  resolveConfirm,
  savedWorkflowDirs,
  selectDefaultActiveWorkflowRunId,
  selectDefaultWorkflowRunId,
  selectWorkflowPruneCandidates,
  workflowEventStatus,
  writeWorkflowRunDisplayName,
  type WorkflowApprovalRenderContext,
  type WorkflowRunLocale,
  type WorkflowRunPresentation,
} from './workflow-command-helpers.js';
export {
  createWorkflowAgentDigestLimiter,
  formatFinalEventSummary,
  formatManagedRunsList,
  formatResult,
  formatRunsList,
  formatSavedList,
  formatWorkflowAgentDigest,
  formatWorkflowList,
  formatWorkflowPruneCandidates,
  formatWorkflowRunSnapshot,
  isActiveManagedWorkflowRun,
  isSafeWorkflowRunId,
  isTerminalWorkflowStatus,
  readWorkflowRunDetail,
  readWorkflowRuns,
  renderApprovalPrompt,
  renderWorkflowHelp,
  resolveConfirm,
  savedWorkflowDirs,
  selectDefaultActiveWorkflowRunId,
  selectDefaultWorkflowRunId,
  selectWorkflowPruneCandidates,
  type WorkflowApprovalRenderContext,
  type WorkflowPruneCandidate,
  type WorkflowRunDetail,
  type WorkflowRunLocale,
  type WorkflowRunPresentation,
  type WorkflowRunSnapshotFormatOptions,
  type WorkflowRunSummary,
  type WorkflowRunsListFormatOptions,
} from './workflow-command-helpers.js';
import {
  buildWorkflowRevisionRequest,
  parseWorkflowArgs,
  parseWorkflowInvocation,
  parseWorkflowPruneOptions,
  parseWorkflowRunsOptions,
  type WorkflowPruneOptions,
} from './workflow-command-parse.js';
export {
  buildWorkflowRevisionRequest,
  DEFAULT_WORKFLOW_PRUNE_KEEP,
  DEFAULT_WORKFLOW_RUNS_LIMIT,
  parseWorkflowArgs,
  parseWorkflowInvocation,
  parseWorkflowPruneOptions,
  parseWorkflowRunsOptions,
  type WorkflowInvocation,
  type WorkflowPruneOptions,
  type WorkflowRunsOptions,
} from './workflow-command-parse.js';

/* ----------------------------- pure helpers ----------------------------- */

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
