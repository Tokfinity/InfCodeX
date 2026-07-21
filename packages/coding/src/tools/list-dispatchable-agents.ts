import type {
  AgentCapabilityRequirements,
  DispatchableAgentDescriptor,
  DispatchableAgentQuery,
} from '@kodax-ai/agent';

import {
  codingDispatchContext,
  listCodingDispatchableAgents,
} from '../external-agents/local-catalog.js';
import type { KodaXToolExecutionContext } from '../types.js';

function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

function capabilityRequirements(value: unknown): AgentCapabilityRequirements | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const result: Record<string, boolean> = {};
  for (const key of ['streaming', 'durableTasks', 'inputRequired', 'cancellation', 'artifacts']) {
    if (record[key] === true) result[key] = true;
  }
  return Object.keys(result).length > 0 ? result as AgentCapabilityRequirements : undefined;
}

function localMatchesQuery(
  descriptor: DispatchableAgentDescriptor,
  query: DispatchableAgentQuery,
): boolean {
  for (const skill of query.requiredSkills ?? []) {
    if (!descriptor.skills.includes(skill)) return false;
  }
  const required = query.requiredCapabilities;
  if (required) {
    for (const key of ['streaming', 'durableTasks', 'inputRequired', 'cancellation', 'artifacts'] as const) {
      if (required[key] === true && descriptor.capabilities[key] !== 'supported') return false;
    }
  }
  return query.readOnly !== true
    || (descriptor.effects.remote !== 'write' && descriptor.effects.remote !== 'unknown');
}

export async function toolListDispatchableAgents(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  const binding = ctx.agentExecutorPlane;
  const requiredSkills = stringArray(input.required_skills ?? input.requiredSkills);
  const requiredCapabilities = capabilityRequirements(
    input.required_capabilities ?? input.requiredCapabilities,
  );
  const dispatchContext = codingDispatchContext(ctx);
  const query: DispatchableAgentQuery = {
    ...dispatchContext,
    ...(requiredSkills ? { requiredSkills } : {}),
    ...(requiredCapabilities ? { requiredCapabilities } : {}),
    ...((input.read_only ?? input.readOnly) === true ? { readOnly: true } : {}),
  };
  const local = listCodingDispatchableAgents(dispatchContext, ctx.agentScope);
  const listings = binding
    ? await binding.plane.listDispatchable(query, local)
    : local.filter((descriptor) => localMatchesQuery(descriptor, query)).map((descriptor) => ({
        descriptor,
        dispatchability: {
          status: 'dispatchable' as const,
          checkedAt: new Date().toISOString(),
          reasons: [],
        },
      }));
  return JSON.stringify({
    agents: listings.map(({ descriptor, dispatchability }) => ({
      agent_id: descriptor.agentId,
      display_name: descriptor.displayName,
      ...(descriptor.description ? { description: descriptor.description } : {}),
      origin: descriptor.origin,
      protocol: descriptor.protocol,
      skills: descriptor.skills,
      input_modalities: descriptor.inputModalities,
      output_modalities: descriptor.outputModalities,
      capabilities: descriptor.capabilities,
      effects: descriptor.effects,
      availability: dispatchability.status,
      configuration_revision: descriptor.configurationRevision,
    })),
  }, null, 2);
}
