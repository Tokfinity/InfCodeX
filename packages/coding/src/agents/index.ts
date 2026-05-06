/**
 * Barrel for `packages/coding/src/agents/*` — FEATURE_084 Shard 2 (v0.7.26).
 *
 * Protocol emitter tools + coding Agent instances with handoff topology.
 * Data-only at this shard; the Runner-driven task engine wires these up at
 * Shard 5.
 */

export {
  EMIT_CONTRACT_TOOL_NAME,
  EMIT_HANDOFF_TOOL_NAME,
  EMIT_SCOUT_VERDICT_TOOL_NAME,
  EMIT_VERDICT_TOOL_NAME,
  PROTOCOL_EMITTER_TOOLS,
  emitContract,
  emitHandoff,
  emitScoutVerdict,
  emitVerdict,
} from './protocol-emitters.js';
export type { ProtocolEmitterMetadata } from './protocol-emitters.js';

export {
  CODING_AGENT_MARKER,
  CODING_AGENTS,
  evaluatorCodingAgent,
  generatorCodingAgent,
  plannerCodingAgent,
  scoutCodingAgent,
} from './coding-agents.js';

// v0.7.35.1 FEATURE_142 (A-R1): coding-AMA H2 role declarations moved back
// from `@kodax/agent/src/primitives/` per ADR-021.
export {
  SCOUT_AGENT_NAME,
  PLANNER_AGENT_NAME,
  GENERATOR_AGENT_NAME,
  EVALUATOR_AGENT_NAME,
  TASK_ENGINE_ROLE_AGENTS,
  scoutAgent,
  plannerAgent,
  generatorAgent,
  evaluatorAgent,
} from './task-engine-agents.js';
