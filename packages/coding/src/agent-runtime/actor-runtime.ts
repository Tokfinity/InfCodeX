import { createHash } from 'node:crypto';

import {
  AgentActorController,
  emitKodaXDiagnostic,
  getMessageQueue,
  type AgentActorClient,
  type AgentActorStore,
  type AgentEvent,
  type AgentExecutionInput,
  type AgentExecutionResult,
  type AgentMetadataValue,
  type AgentTaskSnapshot,
  type AgentTurnExecutor,
} from '@kodax-ai/agent';
import { normalizeReasoningEffortValue } from '@kodax-ai/llm';

import { executeChildAgents } from '../child-executor.js';
import type {
  KodaXChildContextBundle,
  KodaXChildModelHint,
  KodaXOptions,
  KodaXToolExecutionContext,
} from '../types.js';

const DEFAULT_MAX_CHILD_ITERATIONS = 200;

export interface CodingActorSessionOptions {
  readonly maxConcurrentThreadsPerSession?: number;
  readonly sessionId?: string;
  readonly store?: AgentActorStore;
}

interface CodingActorEnvironment {
  readonly parentCtx: KodaXToolExecutionContext;
  readonly options: KodaXOptions;
}

/** One Runtime-owned Actor tree for one KodaX session. */
export class CodingActorSession {
  private readonly controller: AgentActorController;
  private environment?: CodingActorEnvironment;

  constructor(private readonly sessionOptions: CodingActorSessionOptions = {}) {
    const executor: AgentTurnExecutor = {
      execute: (input) => {
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
      onEventCommitted: (event) => publishActorCompletion(
        this.controller,
        event,
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
    return this.controller.bind(callerPath);
  }

  rootControl(): AgentActorClient {
    return this.controller.bind('/root');
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

function publishActorCompletion(
  controller: AgentActorController,
  event: AgentEvent,
  sessionId: string | undefined,
): void {
  if (!event.turnId || !event.parentPath || !isTerminalEvent(event.kind)) return;
  const output = controller.output('/root', event.actorPath, event.turnId);
  const status = output.state === 'completed'
    ? 'completed'
    : output.state === 'failed'
      ? 'failed'
      : 'cancelled';
  const summary = output.output ?? output.error ?? status;
  getMessageQueue().enqueue({
    priority: 'background',
    mode: 'task-notification',
    agentId: actorQueueId(sessionId, event.parentPath),
    content: `<agent-completed path="${event.actorPath}" turn_id="${event.turnId}" state="${status}">\n${summary}\n</agent-completed>`,
    taskResult: {
      type: 'task_result',
      source: 'child_task',
      taskId: event.turnId,
      status,
      summary,
      title: event.actorPath,
      ...(output.artifacts.length > 0 ? { artifactRefs: [...output.artifacts] } : {}),
    },
  });
}

export function actorQueueId(sessionId: string | undefined, actorPath: string): string | undefined {
  if (sessionId) return `actor:${sessionId}:${actorPath}`;
  return actorPath === '/root' ? undefined : actorPath;
}

function isTerminalEvent(kind: AgentEvent['kind']): boolean {
  return kind === 'turn_completed' || kind === 'turn_failed' || kind === 'turn_interrupted';
}

async function executeCodingActorTurn(
  input: AgentExecutionInput,
  parentCtx: KodaXToolExecutionContext,
  options: KodaXOptions,
  actorControl: AgentActorClient,
): Promise<AgentExecutionResult> {
  if (input.actor.kind === 'external') {
    return executeExternalActorTurn(input, parentCtx);
  }
  const bundle = actorBundle(input);
  const parentConfig = parentCtx.parentAgentConfig;
  const result = await executeChildAgents([bundle], parentCtx, {
    maxParallel: 1,
    maxIterationsPerChild: DEFAULT_MAX_CHILD_ITERATIONS,
    abortSignal: input.signal,
    parentOptions: {
      provider: parentConfig?.provider ?? options.provider,
      model: parentConfig?.model ?? options.modelOverride ?? options.model,
      effort: parentConfig?.effort ?? options.effort,
      reasoningMode: parentConfig?.reasoningMode ?? options.reasoningMode,
      repoIntelligenceMode: parentConfig?.repoIntelligenceMode,
      repoIntelligenceTrace: parentConfig?.repoIntelligenceTrace,
      extensionRuntime: parentCtx.extensionRuntime,
      events: parentCtx.parentEvents,
    },
    parentRole: 'worker',
    parentHarness: 'tool-dispatch',
    planModeBlockCheck: parentCtx.planModeBlockCheck,
    guardrails: parentCtx.guardrails,
    actorControl,
    onProgress: (message) => parentCtx.reportToolProgress?.(
      `[agent ${input.actor.path}] ${message}`,
    ),
  });
  const child = result.results[0];
  if (!child || child.status !== 'completed') {
    throw new Error(child?.summary || `Agent turn ${input.turn.turnId} failed without output.`);
  }
  return {
    output: child.summary,
    ...(child.artifactPaths && child.artifactPaths.length > 0
      ? { artifacts: child.artifactPaths } : {}),
  };
}

async function executeExternalActorTurn(
  input: AgentExecutionInput,
  parentCtx: KodaXToolExecutionContext,
): Promise<AgentExecutionResult> {
  const binding = parentCtx.agentExecutorPlane;
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
    },
    readOnly: input.turn.metadata?.readOnly !== false,
  });
  if (task.state === 'failed' || task.state === 'rejected' || task.state === 'unknown') {
    throw new Error(task.error ?? `External Agent entered ${task.state}.`);
  }
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
      if (!isExternalTerminal(task.state)) task = await binding.plane.tasks.wait(taskId, 1_000);
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
      ? { artifacts: task.artifacts.map((artifact) => artifact.uri ?? artifact.name) }
      : {}),
  };
}

function isExternalTerminal(state: AgentTaskSnapshot['state']): boolean {
  return state === 'completed'
    || state === 'failed'
    || state === 'canceled'
    || state === 'rejected'
    || state === 'unknown';
}

function externalTaskId(actorId: string, turnId: string): string {
  const digest = createHash('sha256').update(`${actorId}\0${turnId}`).digest('hex').slice(0, 24);
  return `actor-${digest}`;
}

function actorBundle(input: AgentExecutionInput): KodaXChildContextBundle {
  const metadata = input.turn.metadata ?? {};
  return {
    id: input.actor.path,
    fanoutClass: 'evidence-scan',
    objective: input.turn.objective,
    scopeSummary: metadataString(metadata.scope),
    evidenceRefs: metadataStringArray(metadata.evidenceRefs),
    constraints: metadataStringArray(metadata.constraints),
    readOnly: metadata.readOnly !== false,
    modelHint: modelHint(metadata.modelHint),
    isolation: metadata.isolation === 'worktree' ? 'worktree' : undefined,
    specialistName: specialistName(metadata, input),
    provider: metadataString(metadata.provider),
    model: metadataString(metadata.model),
    effort: effort(metadata.effort),
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
