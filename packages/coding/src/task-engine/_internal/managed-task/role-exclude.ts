/**
 * AMA-role tool exclude sets — exclude-based wiring contract.
 *
 * Each AMA role exposes "all registered tools minus its effective
 * exclude set". This module centralises the per-role exclude sets and
 * the two query helpers (`getAmaRoleEffectiveExclude`,
 * `getAmaRoleExpectedToolNames`) consumed by the agent-chain builder
 * (R3) and the FEATURE_168 contract tests.
 *
 * Extracted from `task-engine/runner-driven.ts` (lines 2095–2204 in
 * the pre-FEATURE_171 monolith) as part of FEATURE_171 (v0.7.41)
 * modular split. Zero behavior change — sets and helper bodies are
 * byte-identical to the previous in-file declarations.
 *
 * Why exclude-based: prior include-based wiring (each role's tools array
 * manually push'd) silently dropped 17 registered tools across multiple
 * features — FEATURE_120 (send_message / task_stop), FEATURE_161 (4 of
 * 8 repo-intel pull tools the Worker prompt teaches), and the four web
 * tools (web_search / web_fetch / code_search / semantic_lookup). The
 * AMA path is shielded from SA-path defaults so wiring drift went
 * undetected by every test layer (handler unit tests pass, prompt
 * teaches the tool, registry registers it, CHILD_EXCLUDE excludes the
 * non-existent child copy — no test asserted "agent.tools actually
 * contains a schema with this name"). Defaulting to "all registered
 * tools available unless excluded" makes that drift architecturally
 * impossible: new tools land in every AMA role automatically, and
 * security-sensitive omissions become explicit (one new EXCLUDE entry
 * rather than five missing push lines).
 */

import { listToolDefinitions } from '../../../tools/registry.js';
import type { AmaRole } from './types.js';

/** Tools every AMA role excludes — specialized paths (SA-root, construction). */
const AMA_BASELINE_EXCLUDE: ReadonlySet<string> = new Set([
  // SA-path root entry only; AMA roles dispatch via role-specific emitters
  // (emit_scout_verdict / emit_contract / emit_handoff / emit_verdict).
  'emit_managed_protocol',
  // Construction / agent-construction / self-modify — activated only when
  // `toolConstructionMode=true` (see `agent-runtime/tool-resolution.ts:81`).
  // AMA roles never run in construction mode.
  'scaffold_tool',
  'validate_tool',
  'stage_construction',
  'test_tool',
  'activate_tool',
  'scaffold_agent',
  'validate_agent',
  'stage_agent_construction',
  'test_agent',
  'activate_agent',
  'stage_self_modify',
]);

/** Scout: H0 executor + dispatcher. Full surface, no extra excludes. */
const SCOUT_EXTRA_EXCLUDE: ReadonlySet<string> = new Set<string>();

/**
 * Planner: drafts the contract for Generator to execute. Read-only inspection
 * surface only — never mutate, dispatch, exec shell, or interact with user.
 */
const PLANNER_EXTRA_EXCLUDE: ReadonlySet<string> = new Set([
  'bash',
  'write',
  'edit',
  'multi_edit',
  'insert_after_anchor',
  'undo',
  'dispatch_child_task',
  'send_message',
  'task_stop',
  // FEATURE_177 v0.7.45 — Planner drafts contracts; it never dispatches
  // children itself, so peeking at child progress would surface a tool
  // it cannot use. Worker / Scout / Generator inherit `task_output` via
  // their empty extra-exclude sets (parent agents that DO dispatch).
  'task_output',
  'worktree_create',
  'worktree_remove',
  'exit_plan_mode',
  'ask_user_question',
]);

/** Generator: full execution surface (V1 path). No extra excludes. */
const GENERATOR_EXTRA_EXCLUDE: ReadonlySet<string> = new Set<string>();

/** Worker (V2 single-loop primary agent): collapses Scout+Generator, full surface. */
const WORKER_EXTRA_EXCLUDE: ReadonlySet<string> = new Set<string>();

// FEATURE_184 (v0.7.45) Phase C.1: EVALUATOR_EXTRA_EXCLUDE deleted —
// the in-chain Evaluator role is removed. Sidecar Verifier (Phase D.2)
// enforces its own architectural boundary.
const ROLE_EXTRA_EXCLUDE: Record<AmaRole, ReadonlySet<string>> = {
  scout: SCOUT_EXTRA_EXCLUDE,
  planner: PLANNER_EXTRA_EXCLUDE,
  generator: GENERATOR_EXTRA_EXCLUDE,
  worker: WORKER_EXTRA_EXCLUDE,
};

/**
 * The effective exclude set for an AMA role — baseline ∪ role-specific.
 * Exported for contract tests in `runner-driven-tool-wiring.test.ts`.
 */
export function getAmaRoleEffectiveExclude(role: AmaRole): ReadonlySet<string> {
  return new Set([...AMA_BASELINE_EXCLUDE, ...ROLE_EXTRA_EXCLUDE[role]]);
}

/**
 * The names of all registry-borne tools an AMA role can see, computed by
 * subtracting the role's effective exclude set from `listToolDefinitions()`.
 * Excludes emit tools (which are NOT registry-borne — Runner-driven path
 * builds them via `protocol-emitters.ts` and splices them in separately).
 *
 * Exported for the FEATURE_168 contract test that pins each role's
 * expected tool surface.
 */
export function getAmaRoleExpectedToolNames(role: AmaRole): readonly string[] {
  const exclude = getAmaRoleEffectiveExclude(role);
  return listToolDefinitions()
    .map((def) => def.name)
    .filter((name) => !exclude.has(name))
    .sort();
}
