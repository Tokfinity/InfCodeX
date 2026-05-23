/**
 * Role-prompt resolution for the runner-driven AMA path.
 *
 * Hosts the `WORKER_INSTRUCTIONS_FALLBACK` constant used when
 * `buildRunnerAgentChain` is invoked without a full prompt context
 * (topology-only tests; V1 scout/planner/generator fallbacks deleted
 * by FEATURE_193 v0.7.43), plus the runtime resolver
 * `resolveRoleInstructions` that bridges `RunnerChainPromptContext`
 * through `createRolePrompt` for the v0.7.22-parity surface, with the
 * Scout-skillMap + runtime-verification + completion-contract helper
 * blocks layered on top.
 *
 * Extracted from `task-engine/runner-driven.ts` (lines 345–681 in the
 * pre-FEATURE_171 monolith) as part of FEATURE_171 (v0.7.41) modular
 * split. Zero behavior change — bodies are byte-identical to the
 * previous in-file declarations.
 */

import type {
  KodaXTaskRole,
  KodaXTaskVerificationContract,
} from '../../../types.js';
import { createRolePrompt } from './role-prompt.js';
import type { RunnerChainPromptContext, VerdictRecorder } from './types.js';

// FEATURE_193 (v0.7.43): SCOUT_INSTRUCTIONS_FALLBACK, PLANNER_INSTRUCTIONS_FALLBACK,
// GENERATOR_INSTRUCTIONS_FALLBACK deleted — V1 chain roles retired.
// Only WORKER_INSTRUCTIONS_FALLBACK remains for the topology-only test path.

// FEATURE_114 v0.7.36 — minimal Worker instructions for the
// topology-only test path (no `promptContext`). Real Worker prompts
// are produced by `createRolePrompt('worker', ...)` via
// `worker-role-prompt.ts`. Mirrors the other *_FALLBACK constants
// above; the production path never reaches this string.
export const WORKER_INSTRUCTIONS_FALLBACK = [
  'You are Worker (AMA Harness V2 single-loop primary agent). Plan via ',
  '`todo_update`, execute via tool calls, then end your turn with a brief ',
  'text-only summary when done — no tool call is needed to terminate. An ',
  'independent Sidecar Verifier reads your work and decides accept / revise ',
  '/ blocked. You may call: read, grep, glob, bash, write, edit, multi_edit, ',
  'todo_update, todo_list, dispatch_child_task, exit_plan_mode.',
].join('\n');

// FEATURE_193 (v0.7.43): `renderScoutSkillMapBlock` removed — fed
// Scout's skillMap into Generator/Evaluator prompts. V1 Scout retired,
// `recorder.scout` is never populated on V2, so the helper produced
// `undefined` on every call. All call sites were removed in commits
// 1–5; this commit drops the dangling exporter.

/**
 * Resolve the system prompt for a role. When the full `promptContext`
 * (prompt + decision) is present, delegate to `createRolePrompt` for the
 * v0.7.22-parity prompt (decision summary, contract, metadata,
 * verification, tool-policy, evidence strategies, dispatch_child_task
 * guidance, H0/H1/H2 framework, handoff/verdict/contract block specs).
 * Otherwise fall back to the minimal static constants — keeps test
 * fixtures that call `buildRunnerAgentChain(ctx, {})` working.
 */
export function resolveRoleInstructions(
  role: KodaXTaskRole,
  agentName: string,
  fallback: string,
  recorder: VerdictRecorder,
  promptContext: RunnerChainPromptContext | undefined,
  verification: KodaXTaskVerificationContract | undefined,
): string {
  if (!promptContext) {
    // Legacy minimal-instructions path for tests / topology-only calls.
    // FEATURE_193 (v0.7.43): removed role === 'generator' skillMap append —
    // generator role deleted along with V1 chain.
    return fallback;
  }
  const ctx = promptContext.contextFactory
    ? promptContext.contextFactory(role, recorder)
    : { originalTask: promptContext.prompt };
  // P1 parity — resolve per-role tool policy at invocation time so the
  // Generator branch can see Scout's mutation intent. Falls back to the
  // static `toolPolicy` for tests / topology-only paths.
  const toolPolicy = promptContext.toolPolicyFactory
    ? promptContext.toolPolicyFactory(role, recorder)
    : promptContext.toolPolicy;
  // M4 parity — resolve routing decision lazily. When the caller supplies
  // a thunk, the Generator / Evaluator see the post-Scout decision
  // (`applyScoutDecisionToPlan` output) rather than the pre-Scout
  // snapshot. Tests pass a static decision for topology checks.
  const decision = typeof promptContext.decision === 'function'
    ? promptContext.decision()
    : promptContext.decision;
  const basePrompt = createRolePrompt(
    role,
    promptContext.prompt,
    decision,
    verification,
    toolPolicy,
    agentName,
    promptContext.metadata,
    ctx,
    undefined, // workerId — unused by createRolePrompt body
    false, // isTerminalAuthority — Generator is terminal via Sidecar Verifier (FEATURE_184)
  );
  // FEATURE_086: prepend the pre-computed repo-intelligence context
  // block so every role sees repo overview /
  // changed scope / active module / impact metadata from turn 1. Legacy
  // `runKodaX` injected this via `buildAutoRepoIntelligenceContext` inside
  // `buildReasoningExecutionState`; the Runner-driven path (FEATURE_084
  // Shard 6d-L) routed around `runKodaX` and lost the injection.
  const repoBlock = promptContext.repoIntelligenceContext?.trim();
  return repoBlock
    ? `${repoBlock}\n\n${basePrompt}`
    : basePrompt;
}

/**
 * Shard 6d-S: render `verification.runtime` into an Evaluator-facing
 * block listing the startup command, ready signal, base URL, declared
 * UI flows, API checks, DB checks, and fixtures. Legacy
 * `buildRuntimeExecutionGuide` wrote an equivalent markdown file to
 * `runtime-execution.md`; the Runner path also needs to surface the
 * same obligations inline so the Evaluator actively probes the runtime
 * instead of writing a verdict from static file reads. Without this
 * block, `taskVerification.runtime` is persisted to
 * `runtime-contract.json` but never reaches the model making the
 * accept/revise/blocked call.
 */
export function renderRuntimeVerificationBlock(
  verification: KodaXTaskVerificationContract | undefined,
): string | undefined {
  const runtime = verification?.runtime;
  if (!runtime) return undefined;
  const hasAny = Boolean(
    runtime.startupCommand
      || runtime.readySignal
      || runtime.baseUrl
      || (runtime.uiFlows?.length ?? 0) > 0
      || (runtime.apiChecks?.length ?? 0) > 0
      || (runtime.dbChecks?.length ?? 0) > 0
      || (runtime.fixtures?.length ?? 0) > 0,
  );
  if (!hasAny) return undefined;
  const lines = ['', '=== Runtime Verification Contract ==='];
  if (runtime.cwd) lines.push(`- cwd: ${runtime.cwd}`);
  if (runtime.startupCommand) lines.push(`- startup_command: ${runtime.startupCommand}`);
  if (runtime.readySignal) lines.push(`- ready_signal: ${runtime.readySignal}`);
  if (runtime.baseUrl) lines.push(`- base_url: ${runtime.baseUrl}`);
  if (runtime.env && Object.keys(runtime.env).length > 0) {
    lines.push(`- env_keys: ${Object.keys(runtime.env).join(', ')}`);
  }
  if (runtime.uiFlows?.length) {
    lines.push('ui_flows (execute with bash via the app\'s own test harness; capture evidence):');
    runtime.uiFlows.forEach((flow, idx) => lines.push(`  ${idx + 1}. ${flow}`));
  }
  if (runtime.apiChecks?.length) {
    lines.push('api_checks (curl / wget / app-specific CLI):');
    runtime.apiChecks.forEach((check, idx) => lines.push(`  ${idx + 1}. ${check}`));
  }
  if (runtime.dbChecks?.length) {
    lines.push('db_checks (psql / sqlite / equivalent):');
    runtime.dbChecks.forEach((check, idx) => lines.push(`  ${idx + 1}. ${check}`));
  }
  if (runtime.fixtures?.length) {
    lines.push('fixtures:');
    runtime.fixtures.forEach((fixture, idx) => lines.push(`  ${idx + 1}. ${fixture}`));
  }
  lines.push(
    'Before accepting, start the runtime (if declared), wait for the ready signal, and ',
    'exercise every declared flow/check. Reject (status=revise or blocked) if any check ',
    'cannot be executed or fails.',
  );
  return lines.join('\n');
}

/**
 * Shard 6d-S: derive `completionContractStatus` from the final verdict.
 * Keys are criterion ids (from `verification.criteria`) plus synthetic
 * `ui_flow:<n>` / `api_check:<n>` / `db_check:<n>` keys for the runtime
 * contract entries. Status maps 1:1 from verdict status:
 *   - 'accept'   → 'ready'
 *   - 'revise'   → 'incomplete'
 *   - 'blocked'  → 'blocked'
 *   - no verdict → 'missing' (every declared check is unverified)
 * Returns undefined when no verification contract is declared — matches
 * legacy's absent-field semantics so downstream consumers stay opt-in.
 */
export function buildCompletionContractStatus(
  verification: KodaXTaskVerificationContract | undefined,
  verdictStatus: 'accept' | 'revise' | 'blocked' | undefined,
): Record<string, 'ready' | 'incomplete' | 'blocked' | 'missing'> | undefined {
  if (!verification) return undefined;
  const criteria = verification.criteria ?? [];
  const runtime = verification.runtime;
  const uiFlows = runtime?.uiFlows ?? [];
  const apiChecks = runtime?.apiChecks ?? [];
  const dbChecks = runtime?.dbChecks ?? [];
  if (criteria.length === 0 && uiFlows.length === 0 && apiChecks.length === 0 && dbChecks.length === 0) {
    return undefined;
  }
  const status: 'ready' | 'incomplete' | 'blocked' | 'missing' =
    verdictStatus === 'accept'
      ? 'ready'
      : verdictStatus === 'blocked'
        ? 'blocked'
        : verdictStatus === 'revise'
          ? 'incomplete'
          : 'missing';
  const out: Record<string, 'ready' | 'incomplete' | 'blocked' | 'missing'> = {};
  for (const criterion of criteria) out[criterion.id] = status;
  uiFlows.forEach((_flow, idx) => {
    out[`ui_flow:${idx + 1}`] = status;
  });
  apiChecks.forEach((_check, idx) => {
    out[`api_check:${idx + 1}`] = status;
  });
  dbChecks.forEach((_check, idx) => {
    out[`db_check:${idx + 1}`] = status;
  });
  return out;
}
