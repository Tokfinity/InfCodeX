import { join } from 'node:path';

import chalk from 'chalk';
import { getAgentConfigPath, type WorkflowProcessSource } from '@kodax-ai/agent';
import {
  buildApprovalSummary,
  generateWorkflowFromOptions,
  getDefaultWorkflowRunManager,
  type WorkflowRunProcessMetadata,
} from '@kodax-ai/coding';

import { deriveProjectKeyFromRoot } from '../interactive/project-key.js';
import type { CommandCallbacks } from './types.js';
import {
  detectWorkflowLocale,
  formatWorkflowLaunchAnswer,
  renderApprovalPrompt,
  resolveConfirm,
} from './workflow-command-helpers.js';
import {
  createWorkflowLiveUpdateEmitter,
  emitWorkflowRunMessage,
  observeManagedWorkflowDone,
  subscribeWorkflowLiveProcess,
  workflowEventSink,
  type GeneratedWorkflowStartOutcome,
  type StartGeneratedWorkflowFromRequestOptions,
  type WorkflowBuilderEvent,
} from './workflow-command-live.js';

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

export function buildWorkflowProcessMetadata(input: {
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

