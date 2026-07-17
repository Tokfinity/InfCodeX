import type {
  AgentActor,
  AgentActorClient,
  AgentActorState,
  AgentCapabilities,
  AgentDataClassification,
  AgentForkTurns,
  AgentInterruptScope,
  AgentMetadataValue,
  AgentSpawnInput,
} from '@kodax-ai/agent';

import type { KodaXToolExecutionContext } from '../types.js';
import {
  listCodingDispatchableAgents,
  resolveCodingDispatchableAgent,
} from '../external-agents/local-catalog.js';

const MAX_BROADCAST_RECIPIENTS = 20;
const DEFAULT_LIST_PAGE_SIZE = 20;
const MAX_LIST_PAGE_SIZE = 50;
const DEFAULT_WAIT_EVENTS = 8;
const MAX_WAIT_EVENTS = 20;
const MAX_WAIT_MS = 120_000;
const ROOT_SENDS_PER_TURN = 20;
const CHILD_SENDS_PER_TURN = 5;

export async function toolSpawnAgent(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  const client = requireActorControl(ctx);
  const taskName = requiredString(input, 'task_name');
  const objective = requiredString(input, 'objective');
  const readOnly = input.read_only !== false;
  const provider = optionalString(input.provider);
  const agentId = optionalString(input.agent_id);
  const selector = await resolveAgentSelector(ctx, agentId, readOnly);
  const spawn: AgentSpawnInput = {
    taskName,
    objective,
    forkTurns: parseForkTurns(input.fork_turns),
    kind: selector.kind,
    capabilities: {
      filesystem: readOnly ? 'read' : 'write',
      ...(provider ? { providers: [provider] } : {}),
      canAskUser: false,
      ...(selector.control ? { control: selector.control } : {}),
    },
    metadata: spawnMetadata(input, readOnly, provider, agentId, selector.specialistName),
  };
  try {
    const turn = await client.spawn(spawn);
    return render({ ok: true, ...turn });
  } catch (error) {
    return renderActorError('spawn_agent', error);
  }
}

export async function toolSendAgentMessage(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  const client = requireActorControl(ctx);
  const target = requiredString(input, 'to');
  const content = requiredString(input, 'content');
  const classification = parseClassification(input.classification);
  const forwardedMessageId = optionalString(input.forwarded_message_id);
  try {
    if (target === '*') {
      const recipients = novelMessageRecipients(client, messageRecipients(client), forwardedMessageId);
      if (recipients.length > MAX_BROADCAST_RECIPIENTS) {
        return renderActorError('send_message', {
          code: 'broadcast_limit_reached',
          message: `broadcast has ${recipients.length} recipients; max is ${MAX_BROADCAST_RECIPIENTS}`,
        });
      }
      if (recipients.length === 0) {
        return renderActorError('send_message', {
          code: 'message_cycle_detected',
          message: 'broadcast has no recipient outside the forwarding chain',
        });
      }
      const chargeError = chargeSendCounter(ctx, recipients.length);
      if (chargeError) return renderActorError('send_message', chargeError);
      const messages = await Promise.all(recipients.map((actor) => (
        client.send(actor.path, content, classification, forwardedMessageId)
      )));
      return render({
        ok: true,
        delivery: 'broadcast',
        recipients: recipients.map((actor) => actor.path),
        messageIds: messages.map((message) => message.messageId),
      });
    }
    const actorPath = resolveTarget(client, target);
    const chargeError = chargeSendCounter(ctx, 1);
    if (chargeError) return renderActorError('send_message', chargeError);
    const message = await client.send(actorPath, content, classification, forwardedMessageId);
    return render({ ok: true, delivery: 'message', actorPath, messageId: message.messageId });
  } catch (error) {
    return renderActorError('send_message', error);
  }
}

export async function toolFollowupTask(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  const client = requireActorControl(ctx);
  try {
    const actorPath = resolveTarget(client, requiredString(input, 'target'));
    const result = await client.followup(actorPath, requiredString(input, 'objective'));
    return render({ ok: true, actorPath, ...result });
  } catch (error) {
    return renderActorError('followup_task', error);
  }
}

export async function toolWaitAgent(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  const client = requireActorControl(ctx);
  try {
    const afterSequence = nonNegativeInteger(input.after_sequence, 0, 'after_sequence');
    const timeoutMs = boundedInteger(input.timeout_ms, 30_000, 0, MAX_WAIT_MS, 'timeout_ms');
    const maxEvents = boundedInteger(
      input.max_events,
      DEFAULT_WAIT_EVENTS,
      1,
      MAX_WAIT_EVENTS,
      'max_events',
    );
    const first = await client.wait(afterSequence, timeoutMs, ctx.abortSignal);
    const interrupted = first === undefined && ctx.abortSignal?.aborted === true;
    const pending = first === undefined ? [] : client.eventSnapshot(afterSequence);
    const events = (pending.length === 0 && first ? [first] : pending).slice(0, maxEvents);
    const event = events[0];
    const nextSequence = events.at(-1)?.sequence;
    return render({
      ok: true,
      status: event ? 'event' : interrupted ? 'interrupted' : 'wait_expired',
      afterSequence,
      ...(event ? {
        event,
        events,
        updatedActors: [...new Set(events.map((item) => item.actorPath))],
        nextSequence,
        hasMore: pending.length > events.length,
      } : {}),
    });
  } catch (error) {
    return renderActorError('wait_agent', error);
  }
}

export async function toolInterruptAgent(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  const client = requireActorControl(ctx);
  try {
    const actorPath = resolveTarget(client, requiredString(input, 'target'));
    const scope = parseInterruptScope(input.scope);
    await client.interrupt(actorPath, optionalString(input.reason), scope);
    return render({ ok: true, actorPath, state: 'interrupted', scope });
  } catch (error) {
    return renderActorError('interrupt_agent', error);
  }
}

export async function toolListAgents(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  const client = requireActorControl(ctx);
  try {
    const snapshot = client.list();
    const pathPrefix = normalizeActorPath(client, optionalString(input.path_prefix));
    const state = parseActorState(input.state);
    const afterPath = normalizeActorPath(client, optionalString(input.after_path));
    const limit = boundedInteger(
      input.limit,
      DEFAULT_LIST_PAGE_SIZE,
      1,
      MAX_LIST_PAGE_SIZE,
      'limit',
    );
    const matched = snapshot.actors.filter((actor) => (
      (pathPrefix === undefined || actor.path.startsWith(pathPrefix))
      && (state === undefined || actor.state === state)
    ));
    const remaining = afterPath === undefined
      ? matched
      : matched.filter((actor) => actor.path.localeCompare(afterPath) > 0);
    const page = remaining.slice(0, limit);
    const hasMore = remaining.length > page.length;
    return render({
      ok: true,
      callerPath: client.callerPath,
      activeNonRootTurns: snapshot.activeNonRootTurns,
      maxConcurrentThreads: snapshot.maxConcurrentThreads,
      revision: snapshot.revision,
      query: {
        ...(pathPrefix === undefined ? {} : { pathPrefix }),
        ...(state === undefined ? {} : { state }),
        ...(afterPath === undefined ? {} : { afterPath }),
        limit,
      },
      matchedActorCount: matched.length,
      hasMore,
      ...(hasMore && page.at(-1) ? { nextAfterPath: page.at(-1)?.path } : {}),
      actors: page.map((actor) => ({
        path: actor.path,
        taskName: actor.taskName,
        parentPath: actor.parentPath,
        kind: actor.kind,
        state: actor.state,
        capabilities: actor.capabilities,
        currentTurnId: actor.currentTurnId,
        turnCount: actor.turnIds.length,
        latestTurn: actor.latestTurn,
        revision: actor.revision,
      })),
    });
  } catch (error) {
    return renderActorError('list_agents', error);
  }
}

export async function toolAgentOutput(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  const client = requireActorControl(ctx);
  try {
    const actorPath = resolveTarget(client, requiredString(input, 'target'));
    const output = client.output(actorPath, optionalString(input.turn_id));
    return render({ ok: true, ...output });
  } catch (error) {
    return renderActorError('agent_output', error);
  }
}

function requireActorControl(ctx: KodaXToolExecutionContext): AgentActorClient {
  if (!ctx.actorControl) throw new Error('Agent collaboration is unavailable on this turn.');
  return ctx.actorControl;
}

function resolveTarget(client: AgentActorClient, value: string): string {
  const actors = client.list().actors;
  if (value.startsWith('/root')) return value;
  if (value === 'parent' && client.callerPath !== '/root') {
    const parentPath = actors.find((actor) => actor.path === client.callerPath)?.parentPath;
    if (!parentPath) throw new Error('The root Agent has no parent.');
    return parentPath;
  }
  const directChild = `${client.callerPath}/${value}`;
  if (actors.some((actor) => actor.path === directChild)) return directChild;
  const parentPath = actors.find((actor) => actor.path === client.callerPath)?.parentPath;
  const peer = parentPath ? `${parentPath}/${value}` : `/root/${value}`;
  if (actors.some((actor) => actor.path === peer)) return peer;
  throw new Error(`Actor target is not visible: ${value}`);
}

function messageRecipients(client: AgentActorClient): AgentActor[] {
  const actors = client.list().actors;
  const self = actors.find((actor) => actor.path === client.callerPath);
  if (!self) return [];
  return actors.filter((actor) => (
    actor.path !== self.path
    && (
      self.path === '/root'
      || actor.path === self.parentPath
      || actor.parentPath === self.path
      || (self.parentPath !== undefined && actor.parentPath === self.parentPath)
    )
  ));
}

function novelMessageRecipients(
  client: AgentActorClient,
  recipients: readonly AgentActor[],
  forwardedMessageId: string | undefined,
): AgentActor[] {
  if (!forwardedMessageId) return [...recipients];
  const source = client.get(client.callerPath).mailbox.find((message) => (
    message.messageId === forwardedMessageId
  ));
  if (!source) return [...recipients];
  const seen = new Set([...(source.lineage ?? [source.senderPath]), client.callerPath]);
  return recipients.filter((actor) => !seen.has(actor.path));
}

function chargeSendCounter(
  ctx: KodaXToolExecutionContext,
  additional: number,
): Readonly<Record<string, unknown>> | undefined {
  const counter = ctx.sendMessageTurnCounter;
  if (!counter) return undefined;
  const isRoot = ctx.actorControl?.callerPath === '/root';
  const limit = isRoot ? ROOT_SENDS_PER_TURN : CHILD_SENDS_PER_TURN;
  if (counter.count + additional > limit) {
    return {
      code: 'message_rate_limited',
      message: `send_message limit reached for this Agent turn (${counter.count} sent, limit ${limit})`,
      limit,
      sent: counter.count,
    };
  }
  counter.count += additional;
  return undefined;
}

function spawnMetadata(
  input: Record<string, unknown>,
  readOnly: boolean,
  provider: string | undefined,
  agentId: string | undefined,
  specialistName: string | undefined,
): Readonly<Record<string, AgentMetadataValue>> {
  return {
    readOnly,
    evidenceRefs: stringArray(input.evidence_refs, 'evidence_refs'),
    constraints: stringArray(input.constraints, 'constraints'),
    ...(optionalString(input.scope) ? { scope: optionalString(input.scope) ?? '' } : {}),
    ...(optionalString(input.model) ? { model: optionalString(input.model) ?? '' } : {}),
    ...(optionalString(input.model_hint) ? { modelHint: optionalString(input.model_hint) ?? '' } : {}),
    ...(optionalString(input.effort) ? { effort: optionalString(input.effort) ?? '' } : {}),
    ...(optionalString(input.isolation) ? { isolation: optionalString(input.isolation) ?? '' } : {}),
    ...(provider ? { provider } : {}),
    ...(agentId ? { agentId } : {}),
    ...(specialistName ? { specialistName } : {}),
  };
}

async function resolveAgentSelector(
  ctx: KodaXToolExecutionContext,
  agentId: string | undefined,
  readOnly: boolean,
): Promise<{
  readonly kind: AgentSpawnInput['kind'];
  readonly specialistName?: string;
  readonly control?: AgentCapabilities['control'];
}> {
  if (!agentId) return { kind: 'native' };
  const binding = ctx.agentExecutorPlane;
  if (!binding) throw new Error('agent_id requires a Runtime-bound Agent executor catalog.');
  const local = resolveCodingDispatchableAgent(agentId, binding.context, ctx.agentScope);
  if (local?.kind === 'native') return { kind: 'native' };
  if (local?.kind === 'constructed') {
    return { kind: 'constructed', specialistName: local.subagentType };
  }
  const described = await binding.plane.describe(agentId, {
    ...binding.context,
    readOnly,
  }, listCodingDispatchableAgents(binding.context, ctx.agentScope));
  if (!described || described.descriptor.origin !== 'external') {
    throw new Error(`agent_id is not known in the dispatchable catalog: ${agentId}`);
  }
  const capabilities = described.descriptor.capabilities;
  return {
    kind: 'external',
    control: {
      followup: capabilities.inputRequired !== 'unsupported',
      interrupt: capabilities.cancellation !== 'unsupported',
      streaming: capabilities.streaming !== 'unsupported',
      artifacts: capabilities.artifacts !== 'unsupported',
    },
  };
}

function parseForkTurns(value: unknown): AgentForkTurns {
  if (value === undefined) return 'all';
  if (value === 'all' || value === 'none') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  throw new Error('fork_turns must be "all", "none", or a positive integer.');
}

function parseClassification(value: unknown): AgentDataClassification {
  if (value === undefined) return 'internal';
  if (value === 'public' || value === 'internal' || value === 'sensitive') return value;
  throw new Error('classification must be public, internal, or sensitive.');
}

function parseInterruptScope(value: unknown): AgentInterruptScope {
  if (value === undefined || value === 'turn') return 'turn';
  if (value === 'subtree') return value;
  throw new Error('scope must be turn or subtree.');
}

function parseActorState(value: unknown): AgentActorState | undefined {
  if (value === undefined) return undefined;
  if (value === 'running' || value === 'idle' || value === 'closed') return value;
  throw new Error('state must be running, idle, or closed.');
}

function normalizeActorPath(
  client: AgentActorClient,
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  if (value === '/root' || value.startsWith('/root/')) return value;
  return `${client.callerPath}/${value.replace(/^\/+/, '')}`;
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = optionalString(input[key]);
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function stringArray(value: unknown, name: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${name} must be an array of strings.`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function nonNegativeInteger(value: unknown, fallback: number, name: string): number {
  return boundedInteger(value, fallback, 0, Number.MAX_SAFE_INTEGER, name);
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function render(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function renderActorError(tool: string, error: unknown): string {
  const fact = errorFact(error);
  return render({ ok: false, tool, error: fact });
}

function errorFact(error: unknown): Readonly<Record<string, unknown>> {
  if (typeof error === 'object' && error !== null) {
    const record = error as Readonly<Record<string, unknown>>;
    return {
      code: typeof record.code === 'string' ? record.code : 'agent_control_failed',
      message: error instanceof Error ? error.message : String(record.message ?? 'Agent control failed.'),
      ...(typeof record.maxConcurrentThreads === 'number'
        ? { maxConcurrentThreads: record.maxConcurrentThreads } : {}),
      ...(typeof record.activeNonRootTurns === 'number'
        ? { activeNonRootTurns: record.activeNonRootTurns } : {}),
      ...(record.availableNonRootSlots === 0 ? { availableNonRootSlots: 0 } : {}),
      ...(typeof record.retryable === 'boolean' ? { retryable: record.retryable } : {}),
      ...(record.retryable === true ? { hint: 'Wait for an active Agent turn to finish, then replan.' } : {}),
      ...(typeof record.limit === 'number' ? { limit: record.limit } : {}),
      ...(typeof record.sent === 'number' ? { sent: record.sent } : {}),
    };
  }
  return { code: 'agent_control_failed', message: String(error) };
}
