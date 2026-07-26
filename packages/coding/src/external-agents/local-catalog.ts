import { createHash } from 'node:crypto';

import type {
  AgentDispatchContext,
  DispatchableAgentDescriptor,
} from '@kodax-ai/agent';

import type { KodaXToolExecutionContext } from '../types.js';
import {
  constructedAgentToolCeiling,
  listConstructedAgentsWithSource,
  type ConstructedAgentEntry,
  type KodaXAgentScope,
} from '../construction/agent-resolver.js';

const NATIVE_AGENT_ID = 'native:kodax-child';

export interface CodingDispatchableAgentRoute {
  readonly kind: 'native' | 'constructed';
  readonly descriptor: DispatchableAgentDescriptor;
  readonly subagentType?: string;
  readonly toolCeiling?: readonly string[];
}

export function codingDispatchContext(
  ctx: KodaXToolExecutionContext,
): AgentDispatchContext {
  if (ctx.agentExecutorPlane) return ctx.agentExecutorPlane.context;
  return {
    actorId: ctx.actorControl?.callerPath ?? (ctx.sessionId ? `session:${ctx.sessionId}` : 'kodax:local'),
    ...(ctx.agentScope ? { projectId: ctx.agentScope.id } : {}),
  };
}

function nativeDescriptor(): DispatchableAgentDescriptor {
  return {
    agentId: NATIVE_AGENT_ID,
    displayName: 'KodaX Child',
    description: 'Default KodaX child agent.',
    origin: 'native',
    protocol: 'native',
    configurationRevision: 'kodax-child:v1',
    skills: [],
    inputModalities: ['text', 'image', 'file'],
    outputModalities: ['text', 'artifact'],
    capabilities: {
      streaming: 'supported',
      durableTasks: 'conditional',
      inputRequired: 'supported',
      cancellation: 'supported',
      artifacts: 'supported',
    },
    effects: { remote: 'none', workspace: 'direct' },
  };
}

function constructedAgentId(
  entry: ConstructedAgentEntry,
  context: AgentDispatchContext,
  scope: KodaXAgentScope | undefined,
): string | undefined {
  if (scope) {
    return `constructed:project:${encodeURIComponent(scope.id)}:${encodeURIComponent(entry.agent.name)}`;
  }
  if (entry.source === 'markdown:project') {
    if (!context.projectId) return undefined;
    return `constructed:project:${encodeURIComponent(context.projectId)}:${encodeURIComponent(entry.agent.name)}`;
  }
  return `constructed:user:${encodeURIComponent(context.actorId)}:${encodeURIComponent(entry.agent.name)}`;
}

function constructedRevision(entry: ConstructedAgentEntry): string {
  const content = JSON.stringify({
    name: entry.agent.name,
    instructions: entry.agent.instructions,
    tools: entry.agent.tools?.map((tool) => tool.name) ?? [],
    provider: entry.agent.provider,
    model: entry.agent.model,
    effort: entry.agent.effort,
  });
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function constructedDescriptor(
  entry: ConstructedAgentEntry,
  agentId: string,
): DispatchableAgentDescriptor {
  return {
    agentId,
    displayName: entry.agent.name,
    ...(entry.agent.description ? { description: entry.agent.description } : {}),
    origin: 'constructed',
    protocol: 'native',
    configurationRevision: constructedRevision(entry),
    skills: [],
    inputModalities: ['text', 'image', 'file'],
    outputModalities: ['text', 'artifact'],
    capabilities: {
      streaming: 'supported',
      durableTasks: 'conditional',
      inputRequired: 'supported',
      cancellation: 'supported',
      artifacts: 'supported',
    },
    effects: { remote: 'none', workspace: 'direct' },
  };
}

export function listCodingDispatchableAgents(
  context: AgentDispatchContext,
  scope?: KodaXAgentScope,
): readonly DispatchableAgentDescriptor[] {
  const result: DispatchableAgentDescriptor[] = [nativeDescriptor()];
  for (const entry of listConstructedAgentsWithSource(scope)) {
    const agentId = constructedAgentId(entry, context, scope);
    if (agentId) result.push(constructedDescriptor(entry, agentId));
  }
  return result;
}

export function resolveCodingDispatchableAgent(
  agentId: string,
  context: AgentDispatchContext,
  scope?: KodaXAgentScope,
): CodingDispatchableAgentRoute | undefined {
  for (const descriptor of listCodingDispatchableAgents(context, scope)) {
    const matchesCanonicalId = descriptor.agentId === agentId;
    const matchesConstructedAlias = descriptor.origin === 'constructed'
      && descriptor.displayName === agentId;
    if (!matchesCanonicalId && !matchesConstructedAlias) continue;
    if (descriptor.origin === 'native') return { kind: 'native', descriptor };
    const entry = listConstructedAgentsWithSource(scope)
      .find((candidate) => constructedAgentId(candidate, context, scope) === descriptor.agentId);
    if (!entry) return undefined;
    const toolCeiling = constructedAgentToolCeiling(entry);
    return {
      kind: 'constructed',
      descriptor,
      subagentType: entry.agent.name,
      ...(toolCeiling !== undefined ? { toolCeiling } : {}),
    };
  }
  return undefined;
}
