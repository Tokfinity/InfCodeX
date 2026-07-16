/**
 * Role-name constants for the coding-AMA task-engine.
 *
 * FEATURE_193 v0.7.43: V1 chain (Scout/Planner/Generator) retired — the
 * placeholder Agent declarations are deleted, but the name constants
 * (`SCOUT_AGENT_NAME` / `PLANNER_AGENT_NAME` / `GENERATOR_AGENT_NAME`) survive
 * as string literals so:
 *   - verdict-recorder.ts routing logic that compares `handoffTarget` against
 *     these names still compiles
 *   - historical session id strings that reference these roles can still parse
 *
 * Worker is the only live placeholder Agent — the runtime Worker (with full
 * tool set, handoffs, mutation guards) is constructed in
 * `task-engine/runner-driven.ts::buildRunnerAgentChain`.
 */

import { createAgent, type Agent } from '@kodax-ai/agent';

export const SCOUT_AGENT_NAME = 'kodax/role/scout';
export const PLANNER_AGENT_NAME = 'kodax/role/planner';
export const GENERATOR_AGENT_NAME = 'kodax/role/generator';
export const WORKER_AGENT_NAME = 'kodax/role/worker';

/**
 * Worker role declaration — FEATURE_114 v0.7.36. The single primary agent
 * after FEATURE_193 V1 chain retirement. Plans (todo_update), executes
 * (read/write/edit/bash/dispatch), text-only terminates so Sidecar Verifier
 * (FEATURE_184 Phase D.2) runs verification.
 *
 * Placeholder for Layer A `Agent` data — the runtime Worker (with full
 * tool set, handoffs, mutation guards) is constructed in
 * `task-engine/runner-driven.ts::buildRunnerAgentChain`.
 */
export const workerAgent: Agent = createAgent({
  name: WORKER_AGENT_NAME,
  instructions:
    'KodaX single primary role: plan via todo_update, execute via tool calls, '
    + 'terminate text-only when done — Sidecar Verifier runs verification out-of-band.',
});

/** Worker role agent exposed for iteration in downstream features. */
export const TASK_ENGINE_ROLE_AGENTS = Object.freeze({
  worker: workerAgent,
} as const);
