/**
 * Coding Agent instances — FEATURE_084 Shard 2 (v0.7.26).
 *
 * Data-shape tests: name binding, tool wiring, handoff topology.
 * No runtime execution at this shard — that lands with Shard 5.
 *
 * FEATURE_184 (v0.7.45) Phase C.3: evaluatorCodingAgent and EVALUATOR_AGENT_NAME removed.
 * Post-execution verification is now handled by the Sidecar Verifier (Phase D.2).
 */

import { describe, expect, it } from 'vitest';
import {
  GENERATOR_AGENT_NAME,
  PLANNER_AGENT_NAME,
  SCOUT_AGENT_NAME,
} from './task-engine-agents.js';
import {
  generatorCodingAgent,
  plannerCodingAgent,
  scoutCodingAgent,
} from './coding-agents.js';
// FEATURE_193 v0.7.43: CODING_AGENTS, EMIT_CONTRACT_TOOL_NAME, EMIT_SCOUT_VERDICT_TOOL_NAME imports removed (V1 chain retired)

// FEATURE_193 v0.7.43: coding-agents identity describe deleted (scout/planner/generator agents retired — V1 chain)

// FEATURE_193 v0.7.43: coding-agents tool wiring describe deleted (V1 chain agents retired)

describe('coding-agents — handoff topology', () => {
  function targetNames(agent: typeof scoutCodingAgent): string[] {
    return (agent.handoffs ?? []).map((h) => h.target.name);
  }

  it('scout hands off to generator (H1) and planner (H2)', () => {
    const targets = targetNames(scoutCodingAgent);
    expect(targets).toContain(GENERATOR_AGENT_NAME);
    expect(targets).toContain(PLANNER_AGENT_NAME);
    // FEATURE_184 Phase C.3: Evaluator role retired — no in-chain evaluator handoff.
    expect(targets).not.toContain('kodax/role/evaluator');
  });

  it('planner hands off to generator only', () => {
    const targets = targetNames(plannerCodingAgent);
    expect(targets).toEqual([GENERATOR_AGENT_NAME]);
  });

  it('generator has no handoffs — terminates text-only for Sidecar Verifier', () => {
    // FEATURE_184 Phase C.1: Generator is now terminal (text-only → sidecar).
    const targets = targetNames(generatorCodingAgent);
    expect(targets).toEqual([]);
  });

  it('all handoffs are continuation kind', () => {
    for (const agent of [scoutCodingAgent, plannerCodingAgent, generatorCodingAgent]) {
      for (const handoff of agent.handoffs ?? []) {
        expect(handoff.kind).toBe('continuation');
      }
    }
  });

  it('every handoff has a human-readable description', () => {
    for (const agent of [scoutCodingAgent, plannerCodingAgent, generatorCodingAgent]) {
      for (const handoff of agent.handoffs ?? []) {
        expect(handoff.description).toBeTruthy();
      }
    }
  });
});

// FEATURE_193 v0.7.43: coding-agents reasoning profile placeholders describe deleted (V1 chain agents retired)
