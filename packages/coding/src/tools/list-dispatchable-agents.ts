import type {
  AgentCapabilityRequirements,
  DispatchableAgentQuery,
} from '@kodax-ai/agent';

import { listCodingDispatchableAgents } from '../external-agents/local-catalog.js';
import type { KodaXToolExecutionContext } from '../types.js';

const TOOL_NAME = 'list_dispatchable_agents';

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

export async function toolListDispatchableAgents(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  const binding = ctx.agentExecutorPlane;
  if (!binding) {
    return `[Tool Error] ${TOOL_NAME}: No external agent executor plane is bound to this run.`;
  }
  const requiredSkills = stringArray(input.required_skills ?? input.requiredSkills);
  const requiredCapabilities = capabilityRequirements(
    input.required_capabilities ?? input.requiredCapabilities,
  );
  const query: DispatchableAgentQuery = {
    ...binding.context,
    ...(requiredSkills ? { requiredSkills } : {}),
    ...(requiredCapabilities ? { requiredCapabilities } : {}),
    ...((input.read_only ?? input.readOnly) === true ? { readOnly: true } : {}),
  };
  const local = listCodingDispatchableAgents(binding.context, ctx.agentScope);
  const listings = await binding.plane.listDispatchable(query, local);
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
