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
  CODING_AGENTS,
  generatorCodingAgent,
  plannerCodingAgent,
  scoutCodingAgent,
} from './coding-agents.js';
import {
  EMIT_CONTRACT_TOOL_NAME,
  EMIT_SCOUT_VERDICT_TOOL_NAME,
} from './protocol-emitters.js';

describe('coding-agents — identity', () => {
  it('binds each coding agent to its corresponding @kodax-ai/core name', () => {
    expect(scoutCodingAgent.name).toBe(SCOUT_AGENT_NAME);
    expect(plannerCodingAgent.name).toBe(PLANNER_AGENT_NAME);
    expect(generatorCodingAgent.name).toBe(GENERATOR_AGENT_NAME);
  });

  it('exposes all three agents in CODING_AGENTS record', () => {
    expect(CODING_AGENTS.scout).toBe(scoutCodingAgent);
    expect(CODING_AGENTS.planner).toBe(plannerCodingAgent);
    expect(CODING_AGENTS.generator).toBe(generatorCodingAgent);
  });

  it('freezes each agent to prevent runtime mutation', () => {
    expect(Object.isFrozen(scoutCodingAgent)).toBe(true);
    expect(Object.isFrozen(plannerCodingAgent)).toBe(true);
    expect(Object.isFrozen(generatorCodingAgent)).toBe(true);
  });
});

describe('coding-agents — tool wiring', () => {
  it('scout agent carries emit_scout_verdict', () => {
    const names = scoutCodingAgent.tools?.map((t) => t.name) ?? [];
    expect(names).toContain(EMIT_SCOUT_VERDICT_TOOL_NAME);
  });

  it('planner agent carries emit_contract', () => {
    const names = plannerCodingAgent.tools?.map((t) => t.name) ?? [];
    expect(names).toContain(EMIT_CONTRACT_TOOL_NAME);
  });

  it('generator agent carries no tools — terminal under F184 + F190', () => {
    // FEATURE_190 (v0.7.43) Phase 3: `emit_handoff` deleted. Generator
    // terminates text-only; Sidecar Verifier runs out-of-band.
    const names = generatorCodingAgent.tools?.map((t) => t.name) ?? [];
    expect(names).toEqual([]);
  });
});

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

describe('coding-agents — reasoning profile placeholders', () => {
  // FEATURE_103 (v0.7.29): Scout default raised from 'quick' to 'balanced'.
  // Rationale (see coding-agents.ts:scoutSpec): post-FEATURE_061 Scout is
  // a cascade-level decision role (judges H0/H1/H2, executes H0, emits
  // executionObligations + downstream_reasoning_hint). 'quick' was sized
  // for the v0.7.16 classifier era; 'balanced' is the right floor today.
  it('scout defaults to balanced reasoning with deep ceiling (FEATURE_103)', () => {
    expect(scoutCodingAgent.reasoning?.default).toBe('balanced');
    expect(scoutCodingAgent.reasoning?.max).toBe('deep');
    // Scout has no revise loop — it emits once and hands off, so
    // escalateOnRevise stays false.
    expect(scoutCodingAgent.reasoning?.escalateOnRevise).toBe(false);
  });

  it('generator defaults to balanced', () => {
    expect(generatorCodingAgent.reasoning?.default).toBe('balanced');
  });
});
