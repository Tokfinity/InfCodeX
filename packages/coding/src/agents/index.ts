/**
 * Barrel for `packages/coding/src/agents/*` — FEATURE_084 Shard 2 (v0.7.26).
 *
 * Protocol emitter tools + coding Agent instances with handoff topology.
 * Data-only at this shard; the Runner-driven task engine wires these up at
 * Shard 5.
 */

export {
  EMIT_CONTRACT_TOOL_NAME,
  EMIT_SCOUT_VERDICT_TOOL_NAME,
  EMIT_VERDICT_TOOL_NAME,
  PROTOCOL_EMITTER_TOOLS,
  emitContract,
  emitScoutVerdict,
  emitVerdict,
} from './protocol-emitters.js';
export type { ProtocolEmitterMetadata } from './protocol-emitters.js';

export {
  CODING_AGENT_MARKER,
} from './coding-agents.js';

// FEATURE_193 v0.7.43: V1 chain (Scout/Planner/Generator) Agent declarations
// retired. The string name constants are kept for verdict-recorder routing
// + historical session id compatibility; Worker is the only Agent declared.
export {
  SCOUT_AGENT_NAME,
  PLANNER_AGENT_NAME,
  GENERATOR_AGENT_NAME,
  WORKER_AGENT_NAME,
  TASK_ENGINE_ROLE_AGENTS,
  workerAgent,
} from './task-engine-agents.js';
