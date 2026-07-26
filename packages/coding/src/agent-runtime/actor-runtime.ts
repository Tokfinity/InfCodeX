import { createHash } from 'node:crypto';

import {
  AgentActorController,
  emitKodaXDiagnostic,
  getMessageQueue,
  type AgentActorClient,
  type AgentBudgetPort,
  type AgentExecutorPlaneBinding,
  type AgentActorStore,
  type AgentExecutionInput,
  type AgentExecutionResult,
  type AgentMailboxMessage,
  type AgentMetadataValue,
  type AgentTaskSnapshot,
  type AgentTurn,
  type AgentTurnExecutor,
} from '@kodax-ai/agent';
import { normalizeReasoningEffortValue, type KodaXTaskResultMetadata } from '@kodax-ai/llm';

import { executeChildAgents } from '../child-executor.js';
import type {
  KodaXChildContextBundle,
  KodaXChildModelHint,
  KodaXManagedWorkBudget,
  KodaXMessage,
  KodaXOptions,
  KodaXToolExecutionContext,
} from '../types.js';
import {
  PATTERN_DISPOSITION_ENVELOPE_SCHEMA,
  parsePatternDispositionEnvelope,
  toAgentMetadataValue,
  type PatternDispositionEnvelope,
} from '../orchestration/pattern-result.js';
import {
  assertPatternEvidenceRefVisible,
  readStoredActorStrategy,
  type StoredActorStrategyMetadata,
} from '../orchestration/pattern-strategy.js';
import { actorQueueId } from './actor-queue.js';

export { actorQueueId } from './actor-queue.js';

const DEFAULT_MAX_CHILD_ITERATIONS = 200;

export interface CodingActorSessionOptions {
  readonly maxConcurrentThreadsPerSession?: number;
  readonly sessionId?: string;
  readonly store?: AgentActorStore;
  readonly executor?: AgentTurnExecutor;
  readonly budget?: AgentBudgetPort;
}

interface CodingActorEnvironment {
  readonly parentCtx: KodaXToolExecutionContext;
  readonly options: KodaXOptions;
}

/** One Runtime-owned Actor tree for one KodaX session. */
export class CodingActorSession {
  private readonly controller: AgentActorController;
  private readonly turnExecutors = new Map<string, AgentTurnExecutor>();
  private environment?: CodingActorEnvironment;
  private activeBudget?: AgentBudgetPort;

  constructor(private readonly sessionOptions: CodingActorSessionOptions = {}) {
    this.activeBudget = sessionOptions.budget;
    const executor: AgentTurnExecutor = {
      execute: (input) => {
        const executionKey = metadataString(input.turn.metadata?.executionKey);
        const registered = executionKey ? this.turnExecutors.get(executionKey) : undefined;
        if (registered) return registered.execute(input);
        if (input.actor.kind === 'external' && sessionOptions.executor) {
          return sessionOptions.executor.execute(input);
        }
        const environment = this.environment;
        if (!environment) throw new Error('Actor session is not attached to an active KodaX run.');
        return executeCodingActorTurn(
          input,
          environment.parentCtx,
          environment.options,
          this.controller.bind(input.actor.path),
        );
      },
    };
    this.controller = new AgentActorController({
      maxConcurrentThreadsPerSession: sessionOptions.maxConcurrentThreadsPerSession,
      store: sessionOptions.store,
      executor,
      budget: {
        admit: (input) => this.activeBudget?.admit(input) ?? Promise.resolve({ admitted: true }),
        refund: (turnId) => this.activeBudget?.refund?.(turnId) ?? Promise.resolve(),
        snapshot: () => this.activeBudget?.snapshot?.(),
      },
      warn: (message) => emitKodaXDiagnostic({
        source: 'coding:actors',
        level: 'warn',
        message,
      }),
      onBackgroundError: (error) => emitKodaXDiagnostic({
        source: 'coding:actors',
        level: 'error',
        message: error instanceof Error ? error.message : String(error),
      }),
      onMessageCommitted: (message) => publishRootMailboxMessage(
        this.controller,
        message,
        sessionOptions.sessionId,
      ),
    });
  }

  async initialize(): Promise<void> {
    await this.controller.initialize();
  }

  attach(
    parentCtx: KodaXToolExecutionContext,
    options: KodaXOptions,
    callerPath = '/root',
  ): AgentActorClient {
    this.environment = { parentCtx, options };
    this.activeBudget = options.context?.managedWorkBudget
      ? managedWorkBudgetPort(options.context.managedWorkBudget)
      : this.sessionOptions.budget;
    return this.controller.bind(callerPath);
  }

  rootControl(): AgentActorClient {
    return this.controller.bind('/root');
  }

  createWorkflowOwner(parentPath: string, runId: string): Promise<AgentActorClient> {
    return this.controller.createProtocolOwner(parentPath, runId);
  }

  workflowOwnerSignal(ownerPath: string): AbortSignal {
    return this.controller.protocolOwnerSignal(ownerPath);
  }

  settleWorkflowOwner(
    ownerPath: string,
    state: 'completed' | 'failed' | 'interrupted',
    result: AgentExecutionResult & { readonly error?: string },
  ): Promise<void> {
    return this.controller.settleProtocolOwner(ownerPath, state, result);
  }

  bindActor(actorPath: string): AgentActorClient {
    return this.controller.bind(actorPath);
  }

  closeActor(targetPath: string, reason?: string): Promise<void> {
    return this.controller.close('/root', targetPath, reason);
  }

  registerTurnExecutor(key: string, executor: AgentTurnExecutor): () => void {
    if (this.turnExecutors.has(key)) throw new Error(`Actor turn executor is already registered: ${key}`);
    this.turnExecutors.set(key, executor);
    return () => {
      if (this.turnExecutors.get(key) === executor) this.turnExecutors.delete(key);
    };
  }

  async waitForAgentCapacity(signal?: AbortSignal): Promise<boolean> {
    const root = this.controller.bind('/root');
    let cursor = root.eventSnapshot().at(-1)?.sequence ?? 0;
    for (;;) {
      if (signal?.aborted) return false;
      const tree = root.list();
      if (tree.maxConcurrentThreads <= 1) return false;
      if (tree.activeNonRootTurns < tree.maxConcurrentThreads - 1) return true;
      const event = await root.wait(cursor, 250);
      if (event) cursor = event.sequence;
    }
  }

  async close(reason = 'runtime closed'): Promise<void> {
    await this.controller.shutdown(reason);
    this.turnExecutors.clear();
  }
}

export function createLocalCodingActorControl(
  parentCtx: KodaXToolExecutionContext,
  options: KodaXOptions,
): AgentActorClient {
  const session = new CodingActorSession({
    maxConcurrentThreadsPerSession: options.maxConcurrentThreadsPerSession,
    sessionId: parentCtx.sessionId,
  });
  return session.attach(parentCtx, options);
}

/** Runtime adapter for detached external Actor turns. The executor plane stays internal. */
export function createExternalActorTurnExecutor(
  binding: AgentExecutorPlaneBinding,
): AgentTurnExecutor {
  return {
    execute(input) {
      if (input.actor.kind !== 'external') {
        throw new Error('Detached Runtime Actor execution only supports external actors.');
      }
      return executeExternalActorTurn(input, binding);
    },
  };
}

function publishRootMailboxMessage(
  controller: AgentActorController,
  message: AgentMailboxMessage,
  sessionId: string | undefined,
): void {
  if (message.recipientPath !== '/root') return;
  if (message.kind !== 'completion' || !message.turnId) {
    getMessageQueue().enqueue({
      priority: message.kind === 'followup' ? 'user' : 'background',
      mode: 'agent-message',
      agentId: actorQueueId(sessionId, '/root'),
      content: renderMailboxMessage(message),
    });
    return;
  }
  const output = controller.output('/root', message.senderPath, message.turnId);
  const queue = getMessageQueue();
  const queueAgentId = actorQueueId(sessionId, '/root');
  if (queue.has({
    agentId: queueAgentId,
    maxPriority: 'background',
    mode: 'task-notification',
    predicate: (queued) => queued.taskResult?.source === 'child_task'
      && queued.taskResult.taskId === message.turnId,
  })) return;
  const status = output.state === 'completed'
    ? 'completed'
    : output.state === 'failed'
      ? 'failed'
      : 'cancelled';
  const summary = output.output ?? output.error ?? status;
  queue.enqueue({
    priority: 'background',
    mode: 'task-notification',
    agentId: queueAgentId,
    content: `<agent-completed id="${escapeXml(message.messageId)}" path="${escapeXml(message.senderPath)}" turn_id="${escapeXml(message.turnId)}" state="${status}">\n${escapeXml(summary)}\n</agent-completed>`,
    taskResult: {
      type: 'task_result',
      source: 'child_task',
      taskId: message.turnId,
      status,
      summary,
      title: message.senderPath,
      ...(output.artifacts.length > 0 ? { artifactRefs: [...output.artifacts] } : {}),
    },
  });
}

async function executeCodingActorTurn(
  input: AgentExecutionInput,
  parentCtx: KodaXToolExecutionContext,
  options: KodaXOptions,
  actorControl: AgentActorClient,
): Promise<AgentExecutionResult> {
  if (input.actor.kind === 'external') {
    const toolId = `external-actor:${input.turn.turnId}`;
    const activityMeta = {
      childAgentId: input.actor.path,
      childAgentName: input.actor.taskName,
      toolId,
      liveOnly: true,
    } as const;
    try {
      return await executeExternalActorTurn(input, parentCtx.agentExecutorPlane, (summary) => {
        parentCtx.reportToolProgress?.(`[agent ${input.actor.path}] ${summary}`);
        parentCtx.parentEvents?.onToolProgress?.({ id: toolId, message: summary }, activityMeta);
      });
    } finally {
      parentCtx.parentEvents?.onChildActivityEnd?.(activityMeta);
    }
  }
  const bundle = actorBundle(input);
  const parentConfig = parentCtx.parentAgentConfig;
  assertProviderAuthority(
    input,
    bundle.provider ?? parentConfig?.provider ?? options.provider,
  );
  const mailbox = await input.drainMailbox();
  const initialMessages = [
    ...actorHistoryMessages(input.priorTurns, input.turn.forkTurns),
    ...mailbox.map((message) => mailboxMessageAsPrompt(
      message,
      completionTaskResult(actorControl, message),
    )),
  ];
  const pumpStop = new AbortController();
  const mailboxPump = pumpMailbox(input, parentCtx.sessionId, actorControl, pumpStop.signal);
  let result: Awaited<ReturnType<typeof executeChildAgents>>;
  try {
    result = await executeChildAgents([bundle], parentCtx, {
      maxParallel: 1,
      maxIterationsPerChild: DEFAULT_MAX_CHILD_ITERATIONS,
      abortSignal: input.signal,
      ...(options.session?.storage !== undefined
        ? { historyStorage: options.session.storage }
        : {}),
      parentOptions: {
        provider: parentConfig?.provider ?? options.provider,
        model: parentConfig?.model ?? options.modelOverride ?? options.model,
        effort: parentConfig?.effort ?? options.effort,
        reasoningMode: parentConfig?.reasoningMode ?? options.reasoningMode,
        repoIntelligenceMode: parentConfig?.repoIntelligenceMode,
        repoIntelligenceTrace: parentConfig?.repoIntelligenceTrace,
        compaction: parentConfig?.compaction ?? options.compaction,
        extensionRuntime: parentCtx.extensionRuntime,
        events: parentCtx.parentEvents,
      },
      parentRole: 'worker',
      parentHarness: 'tool-dispatch',
      planModeBlockCheck: parentCtx.planModeBlockCheck,
      guardrails: parentCtx.guardrails,
      actorControl,
      actorHost: parentCtx.actorHost,
      actorTurnId: input.turn.turnId,
      initialMessages,
      actorCapabilities: input.actor.capabilities,
      onProgress: (message) => {
        void input.reportProgress({ kind: 'status', summary: message }).catch((error: unknown) => {
          emitKodaXDiagnostic({
            source: 'coding:actors',
            level: 'warn',
            message: `Actor progress projection failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        });
        parentCtx.reportToolProgress?.(`[agent ${input.actor.path}] ${message}`);
      },
    });
  } finally {
    pumpStop.abort();
    await mailboxPump;
  }
  const child = result.results[0];
  if (!child || child.status !== 'completed') {
    throw new Error(child?.summary || `Agent turn ${input.turn.turnId} failed without output.`);
  }
  const strategy = readStoredActorStrategy(input.turn.metadata?.qualityStrategy);
  const validated = strategy === undefined
    ? { structured: toAgentMetadataValue(child.structured), degradedReasons: [] }
    : await validatePatternDispositionResult(
        child.structured,
        strategy,
        parentCtx,
        actorControl,
      );
  if (strategy !== undefined) {
    emitKodaXDiagnostic({
      source: 'coding:actors',
      level: 'debug',
      message: [
        `strategy stage=${strategy.stageId}`,
        `pattern=${strategy.pattern}`,
        `role=${strategy.role}`,
        `turn=${input.turn.turnId}`,
        `status=${validated.degradedReasons.length === 0 ? 'completed' : 'degraded'}`,
      ].join(' '),
    });
  }
  const turnMetadata: Record<string, AgentMetadataValue> = {
    ...(child.provider === undefined ? {} : { effectiveProvider: child.provider }),
    ...(child.model === undefined ? {} : { effectiveModel: child.model }),
    ...(validated.degradedReasons.length === 0
      ? {}
      : { qualityStrategyDegradedReasons: validated.degradedReasons }),
  };
  return {
    output: child.summary,
    ...(child.artifactPaths && child.artifactPaths.length > 0
      ? { artifacts: child.artifactPaths } : {}),
    ...(validated.structured === undefined ? {} : { structured: validated.structured }),
    ...(Object.keys(turnMetadata).length === 0 ? {} : { turnMetadata }),
  };
}

async function validatePatternDispositionResult(
  value: unknown,
  strategy: StoredActorStrategyMetadata,
  targetCtx: KodaXToolExecutionContext,
  supportActorControl: AgentActorClient,
): Promise<{
  readonly structured?: AgentMetadataValue;
  readonly degradedReasons: readonly string[];
}> {
  const envelope = parsePatternDispositionEnvelope(value);
  if (envelope === undefined) {
    return { structured: toAgentMetadataValue(value), degradedReasons: [] };
  }
  const declaredTargets = new Set(strategy.targetEvidenceRefs ?? []);
  const degradedReasons = new Set<string>();
  const outcomes: PatternDispositionEnvelope['outcomes'][number][] = [];
  const supportCtx = {
    ...targetCtx,
    actorControl: supportActorControl,
  };
  for (const outcome of envelope.outcomes) {
    const targetRef = 'evidenceRef' in outcome.target
      ? outcome.target.evidenceRef
      : `agent-turn:${outcome.target.actorPath}#turn=${outcome.target.turnId}`;
    if (!declaredTargets.has(targetRef)) {
      degradedReasons.add('undeclared_disposition_target');
      continue;
    }
    try {
      await assertPatternEvidenceRefVisible(targetRef, targetCtx);
      for (const evidenceRef of outcome.evidenceRefs) {
        await assertPatternEvidenceRefVisible(evidenceRef, supportCtx);
      }
      outcomes.push(outcome);
    } catch {
      degradedReasons.add('invalid_disposition_evidence');
    }
  }
  const sanitized: PatternDispositionEnvelope = {
    schemaVersion: 1,
    outcomes,
    assertedCoverage: degradedReasons.size === 0 ? envelope.assertedCoverage : [],
  };
  return {
    structured: toAgentMetadataValue(sanitized),
    degradedReasons: [...degradedReasons].sort(),
  };
}

async function executeExternalActorTurn(
  input: AgentExecutionInput,
  binding: AgentExecutorPlaneBinding | undefined,
  onProgress?: (summary: string) => void,
): Promise<AgentExecutionResult> {
  const agentId = metadataString(input.turn.metadata?.agentId);
  if (!binding || !agentId) throw new Error('External Agent execution is not bound to this Runtime.');
  const taskId = externalTaskId(binding.context.actorId, input.turn.turnId);
  let task = await binding.plane.tasks.start({
    taskId,
    agentId,
    objective: input.turn.objective,
    context: {
      ...binding.context,
      parentTaskId: input.actor.parentPath ?? binding.context.parentTaskId,
      ...(metadataString(input.turn.metadata?.workflowRunId)
        ? { workflowId: metadataString(input.turn.metadata?.workflowRunId) }
        : {}),
    },
    readOnly: input.turn.metadata?.readOnly !== false,
    ...(metadataString(input.turn.metadata?.expectedConfigurationRevision)
      ? { expectedConfigurationRevision: metadataString(input.turn.metadata?.expectedConfigurationRevision) }
      : {}),
  });
  if (task.state === 'failed' || task.state === 'rejected') {
    throw new Error(task.error ?? `External Agent entered ${task.state}.`);
  }
  let lastProgress = reportExternalProgress(input, task.progress, undefined, onProgress);
  const cancel = (): void => {
    void binding.plane.tasks.cancel(taskId, String(input.signal.reason ?? 'interrupted'))
      .catch((error: unknown) => emitKodaXDiagnostic({
        source: 'coding:actors',
        level: 'warn',
        message: `External Agent cancellation failed: ${error instanceof Error ? error.message : String(error)}`,
      }));
  };
  input.signal.addEventListener('abort', cancel, { once: true });
  try {
    while (!isExternalTerminal(task.state)) {
      for (const message of await input.drainMailbox()) {
        if (message.kind !== 'completion') {
          task = await binding.plane.tasks.sendInput(taskId, { content: message.content });
        }
      }
      if (!isExternalTerminal(task.state)) {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
        task = await binding.plane.tasks.get(taskId);
        lastProgress = reportExternalProgress(input, task.progress, lastProgress, onProgress);
      }
    }
  } finally {
    input.signal.removeEventListener('abort', cancel);
  }
  if (task.state !== 'completed') {
    throw new Error(task.error ?? task.cancellationError ?? `External Agent ended in ${task.state}.`);
  }
  return {
    output: task.output ?? '',
    ...(task.artifacts && task.artifacts.length > 0
      ? {
          artifacts: task.artifacts.map((artifact) => artifact.uri ?? artifact.name),
          artifactDetails: task.artifacts.map((artifact) => ({ ...artifact })),
        }
      : {}),
  };
}

function isExternalTerminal(state: AgentTaskSnapshot['state']): boolean {
  return state === 'completed'
    || state === 'failed'
    || state === 'canceled'
    || state === 'rejected';
}

function reportExternalProgress(
  input: AgentExecutionInput,
  progress: AgentTaskSnapshot['progress'],
  previous: string | undefined,
  onProgress?: (summary: string) => void,
): string | undefined {
  const summary = progress?.message?.trim()
    || (progress?.percent === undefined ? undefined : `${progress.percent}% complete`);
  if (!summary || summary === previous) return previous;
  void input.reportProgress({ kind: 'status', summary }).catch((error: unknown) => {
    emitKodaXDiagnostic({
      source: 'coding:actors',
      level: 'warn',
      message: `External Actor progress projection failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  });
  onProgress?.(summary);
  return summary;
}

function externalTaskId(actorId: string, turnId: string): string {
  const digest = createHash('sha256').update(`${actorId}\0${turnId}`).digest('hex').slice(0, 24);
  return `actor-${digest}`;
}

function actorBundle(input: AgentExecutionInput): KodaXChildContextBundle {
  const metadata = input.turn.metadata ?? {};
  const qualityStrategy = readStoredActorStrategy(metadata.qualityStrategy);
  const needsDispositionEnvelope = qualityStrategy?.role === 'filter'
    || qualityStrategy?.role === 'judge'
    || qualityStrategy?.role === 'challenger';
  return {
    id: input.actor.path,
    fanoutClass: 'evidence-scan',
    objective: input.turn.objective,
    scopeSummary: metadataString(metadata.scope),
    evidenceRefs: [...new Set([
      ...metadataStringArray(metadata.evidenceRefs),
      ...(qualityStrategy?.targetEvidenceRefs ?? []),
    ])],
    constraints: metadataStringArray(metadata.constraints),
    readOnly: input.actor.capabilities.filesystem !== 'write',
    modelHint: modelHint(metadata.modelHint),
    isolation: metadata.isolation === 'worktree' ? 'worktree' : undefined,
    specialistName: specialistName(metadata, input),
    provider: metadataString(metadata.provider),
    model: metadataString(metadata.model),
    effort: effort(metadata.effort),
    ...(needsDispositionEnvelope
      ? {
          outputSchema: PATTERN_DISPOSITION_ENVELOPE_SCHEMA,
          structuredOutputContract: 'pattern-disposition-parse-only' as const,
        }
      : {}),
  };
}

function actorHistoryMessages(
  priorTurns: readonly AgentTurn[],
  forkTurns: AgentTurn['forkTurns'],
): KodaXMessage[] {
  const selected = forkTurns === 'none'
    ? []
    : forkTurns === 'all'
      ? priorTurns
      : priorTurns.slice(-forkTurns);
  return selected.flatMap((turn): KodaXMessage[] => {
    const outcome = turn.output ?? turn.error ?? turn.state;
    return [
      {
        role: 'user',
        content: `<actor-prior-turn id="${escapeXml(turn.turnId)}">\n${escapeXml(turn.objective)}\n</actor-prior-turn>`,
      },
      {
        role: 'assistant',
        content: `<actor-prior-result state="${turn.state}">\n${escapeXml(outcome)}\n</actor-prior-result>`,
      },
    ];
  });
}

function mailboxMessageAsPrompt(
  message: AgentMailboxMessage,
  taskResult?: KodaXTaskResultMetadata,
): KodaXMessage {
  return { role: 'user', content: renderMailboxMessage(message, taskResult) };
}

async function pumpMailbox(
  input: AgentExecutionInput,
  sessionId: string | undefined,
  actorControl: AgentActorClient,
  stopSignal: AbortSignal,
): Promise<void> {
  while (!stopSignal.aborted && !input.signal.aborted) {
    await waitForMailboxPoll(stopSignal);
    if (stopSignal.aborted || input.signal.aborted) return;
    for (const message of await input.drainMailbox()) {
      const taskResult = completionTaskResult(actorControl, message);
      getMessageQueue().enqueue({
        priority: message.kind === 'followup' ? 'user' : 'background',
        mode: message.kind === 'completion' ? 'task-notification' : 'agent-message',
        agentId: actorQueueId(sessionId, input.actor.path),
        content: renderMailboxMessage(message, taskResult),
        ...(taskResult ? { taskResult } : {}),
      });
    }
  }
}

function completionTaskResult(
  actorControl: AgentActorClient,
  message: AgentMailboxMessage,
): KodaXTaskResultMetadata | undefined {
  if (message.kind !== 'completion' || !message.turnId) return undefined;
  const output = actorControl.output(message.senderPath, message.turnId);
  const status = output.state === 'completed'
    ? 'completed'
    : output.state === 'failed'
      ? 'failed'
      : 'cancelled';
  return {
    type: 'task_result',
    source: 'child_task',
    taskId: message.turnId,
    status,
    title: message.senderPath,
    summary: output.output ?? output.error ?? message.content,
    ...(output.artifacts.length > 0 ? { artifactRefs: [...output.artifacts] } : {}),
  };
}

async function waitForMailboxPoll(stopSignal: AbortSignal): Promise<void> {
  if (stopSignal.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      stopSignal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, 25);
    stopSignal.addEventListener('abort', finish, { once: true });
  });
}

function renderMailboxMessage(
  message: AgentMailboxMessage,
  taskResult?: KodaXTaskResultMetadata,
): string {
  if (message.kind === 'completion') {
    const turnId = message.turnId ? ` turn_id="${escapeXml(message.turnId)}"` : '';
    const terminalState = taskResult?.status === 'cancelled' ? 'interrupted' : taskResult?.status;
    const state = terminalState ? ` state="${terminalState}"` : '';
    return `<agent-completed id="${escapeXml(message.messageId)}" path="${escapeXml(message.senderPath)}"${turnId}${state} classification="${message.classification}">\n${escapeXml(message.content)}\n</agent-completed>`;
  }
  return `<agent-message id="${escapeXml(message.messageId)}" from="${escapeXml(message.senderPath)}" classification="${message.classification}">\n${escapeXml(message.content)}\n</agent-message>`;
}

function assertProviderAuthority(input: AgentExecutionInput, provider: string | undefined): void {
  if (!provider || input.actor.capabilities.providers.includes('*')) return;
  if (!input.actor.capabilities.providers.includes(provider)) {
    throw new Error(`Actor ${input.actor.path} is not authorized to use provider ${provider}.`);
  }
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function managedWorkBudgetPort(
  budget: KodaXManagedWorkBudget,
): AgentBudgetPort {
  return {
    async admit(input) {
      if (budget.spentBudget + input.units > budget.totalBudget) {
        return {
          admitted: false,
          fact: {
            code: 'agent_budget_exhausted',
            retryable: false,
            reason: `shared root work budget exhausted (${budget.spentBudget}/${budget.totalBudget})`,
          },
        };
      }
      budget.spentBudget += input.units;
      return { admitted: true };
    },
    async refund() {
      budget.spentBudget = Math.max(0, budget.spentBudget - 1);
    },
    snapshot: () => ({ ...budget }),
  };
}

function specialistName(
  metadata: Readonly<Record<string, AgentMetadataValue>>,
  input: AgentExecutionInput,
): string | undefined {
  const explicit = metadataString(metadata.specialistName);
  if (explicit) return explicit;
  const agentId = metadataString(metadata.agentId);
  if (!agentId || input.actor.kind === 'native') return undefined;
  throw new Error(`Agent selector ${agentId} was not resolved before execution.`);
}

function modelHint(value: AgentMetadataValue | undefined): KodaXChildModelHint | undefined {
  return value === 'fast' || value === 'balanced' || value === 'deep' ? value : undefined;
}

function effort(value: AgentMetadataValue | undefined): KodaXChildContextBundle['effort'] {
  const text = metadataString(value);
  if (!text) return undefined;
  const normalized = normalizeReasoningEffortValue(text);
  return normalized === 'auto' ? undefined : normalized;
}

function metadataString(value: AgentMetadataValue | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function metadataStringArray(value: AgentMetadataValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}
