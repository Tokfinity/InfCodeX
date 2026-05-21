/**
 * Placeholder Agent declarations for the coding-AMA H2 task-engine roles
 * (Scout / Planner / Generator / Worker).
 *
 * FEATURE_080 (v0.7.23): these declarations exist so the role identities
 * are represented as Layer A `Agent` data, which downstream features need:
 *
 *   - FEATURE_084 (v0.7.26): runtime rewrite of Scout/Planner/Generator
 *     on top of `Runner` consumes these declarations as the source of
 *     truth for role metadata.
 *   - FEATURE_078 (v0.7.29): reasoning profiles attach to the `reasoning`
 *     field on these declarations.
 *   - FEATURE_087+ self-construction: Agent-as-data means role specs can
 *     be serialized, versioned, and mutated.
 *
 * Runtime note: **no preset dispatcher is registered for these agents**.
 * They are declarative placeholders. `Runner.run(scoutAgent, ...)` without
 * an `opts.llm` callback will throw the generic "no dispatcher" error;
 * that's intentional — the current task-engine executes these roles via
 * its existing internal flow, not through `Runner`. FEATURE_084 wires the
 * Runner runtime to these declarations.
 *
 * `instructions` strings here are short identifier-level summaries — the
 * full role prompts live in
 * `packages/coding/src/task-engine/_internal/prompts/role-prompt.ts` (the
 * FEATURE_079 extraction) and are loaded by the existing code path.
 *
 * v0.7.35.1 FEATURE_142 (A-R1): moved from `@kodax-ai/agent/src/primitives/`
 * back to `@kodax-ai/coding/src/agents/`. These role declarations are
 * coding-AMA-specific (Scout / Planner / Generator are the H2 state-machine
 * roles, not generic Agent platform primitives). Per ADR-021, the universal
 * `@kodax-ai/agent` framework must not predeclare coding's H2 role
 * identities.
 */

import { createAgent, type Agent } from '@kodax-ai/agent';

export const SCOUT_AGENT_NAME = 'kodax/role/scout';
export const PLANNER_AGENT_NAME = 'kodax/role/planner';
export const GENERATOR_AGENT_NAME = 'kodax/role/generator';
// FEATURE_114 v0.7.36 — AMA Harness V2 single-loop primary agent.
// Collapses Scout/Planner/Generator into one Worker that drives plan +
// execute via the KODAX_HARNESS_V2 flag. Sidecar Verifier (FEATURE_184
// Phase D.2) replaces the former in-chain Evaluator role.
export const WORKER_AGENT_NAME = 'kodax/role/worker';

/**
 * Scout role declaration. Scout is the AMA entry point that both judges
 * task complexity and executes the H0 direct case; on H1/H2 it hands off
 * to Generator or Planner (see FEATURE_061).
 */
export const scoutAgent: Agent = createAgent({
  name: SCOUT_AGENT_NAME,
  instructions:
    'AMA entry role: judge task complexity, execute H0 direct tasks, '
    + 'hand off to Generator (H1) or Planner (H2) when complexity requires it.',
});

/**
 * Planner role declaration. Produces an execution plan consumed by
 * Generator in the H2 harness.
 */
export const plannerAgent: Agent = createAgent({
  name: PLANNER_AGENT_NAME,
  instructions:
    'H2 role: produce a structured execution plan from task context, '
    + 'constraints, and repo intelligence signals.',
});

/**
 * Generator role declaration. Performs the actual code changes /
 * investigations in both H1 harness; text-only terminates so Sidecar
 * Verifier (FEATURE_184 Phase D.2) takes over verification.
 */
export const generatorAgent: Agent = createAgent({
  name: GENERATOR_AGENT_NAME,
  instructions:
    'H1/H2 execution role: apply tool calls to satisfy the task contract, '
    + 'emit managed-protocol evidence, converge to a final answer.',
});

/**
 * Worker role declaration — FEATURE_114 v0.7.36. The AMA Harness V2
 * single-loop primary agent: plans (todo_update), executes
 * (read/write/edit/bash/dispatch), text-only terminates when done so
 * Sidecar Verifier (FEATURE_184 Phase D.2) runs verification. Only
 * active when `KODAX_HARNESS_V2=true`; the Scout/Planner/Generator
 * placeholders above stay live for the legacy V1 path.
 *
 * Like the other declarations in this file, this is a placeholder for
 * Layer A `Agent` data — the runtime Worker (with full tool set,
 * handoffs, mutation guards) is constructed in
 * `task-engine/runner-driven.ts::buildRunnerAgentChain`.
 */
export const workerAgent: Agent = createAgent({
  name: WORKER_AGENT_NAME,
  instructions:
    'AMA Harness V2 primary role: plan via todo_update, execute via '
    + 'tool calls, emit emit_handoff to signal completion.',
});

/** All three placeholder role agents, exposed for iteration in downstream features. */
export const TASK_ENGINE_ROLE_AGENTS = Object.freeze({
  scout: scoutAgent,
  planner: plannerAgent,
  generator: generatorAgent,
} as const);
