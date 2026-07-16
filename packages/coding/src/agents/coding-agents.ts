/**
 * Coding Agent declarations — FEATURE_193 v0.7.43.
 *
 * The V1 chain (Scout / Planner / Generator) was retired in FEATURE_193.
 * The Worker single-loop is now the only entry path; the runtime Worker
 * agent (with full tool set, handoffs, mutation guards) is constructed
 * fresh by `task-engine/runner-driven.ts::buildRunnerAgentChain` on every
 * run. This file retains only the declarative marker for the
 * `Constructed` admission contract since downstream consumers
 * (coding-preset / extension API) test against it.
 */

/**
 * Sentinel guardrail name used by the coding-AMA admission contract to
 * identify Constructed agents (FEATURE_087+). Kept here as the canonical
 * marker string after the V1 chain agent declarations were retired.
 */
export const CODING_AGENT_MARKER = 'kodax/coding-agent';
