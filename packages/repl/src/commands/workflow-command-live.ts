import chalk from 'chalk';
import type {
  WorkflowEvent,
  WorkflowMeta,
  WorkflowProcessEvent,
  WorkflowProcessSource,
} from '@kodax-ai/agent';
import type {
  generateWorkflowFromOptions,
  ManagedWorkflowRun,
  WorkflowRunManager,
} from '@kodax-ai/coding';

import { workflowLiveSnapshotFromProcess } from '../ui/view-models/workflow-live.js';
import type { CommandCallbacks } from './types.js';
import {
  createWorkflowAgentDigestLimiter,
  formatArtifactResult,
  formatFinalEventSummary,
  formatResult,
  formatWorkflowCompletionAnswer,
  formatWorkflowEvent,
  formatWorkflowFailureAction,
  renderWorkflowEvent,
  workflowEventStatus,
  type WorkflowRunLocale,
  type WorkflowRunPresentation,
} from './workflow-command-helpers.js';

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

export function emitWorkflowRunMessage(
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

export function workflowEventSink(
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

export interface WorkflowLiveUpdateEmitter {
  onEvent(event: WorkflowEvent): void;
  onProcessEvent(event: WorkflowProcessEvent): void;
  complete(status: 'completed' | 'failed' | 'stopped', message?: string): void;
  running(message?: string): void;
}

export function subscribeWorkflowLiveProcess(
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

