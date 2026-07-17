import type { KodaXAgentMode } from '@kodax-ai/coding';

const AGENT_MODE_CYCLE: readonly KodaXAgentMode[] = ['ama', 'sa'];

export function nextAgentMode(current: KodaXAgentMode): KodaXAgentMode {
  const index = AGENT_MODE_CYCLE.indexOf(current);
  return AGENT_MODE_CYCLE[(index + 1) % AGENT_MODE_CYCLE.length] ?? 'ama';
}
