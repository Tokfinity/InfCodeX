/**
 * Protocol emitter tools.
 *
 * After FEATURE_193 (v0.7.43) V1 chain retirement, this module exposes a
 * single emitter: `emitVerdict` (the Sidecar Verifier verdict tool). The
 * supporting types and helpers (`ProtocolEmitterMetadata`,
 * `resolveHandoffTarget`, `buildEmitter`, `summarizeNormalized`) survive in
 * generic form because `verifier-recorder-bridge.ts` and the recorder
 * still observe the emitter metadata shape — but every Scout / Planner /
 * Generator branch is gone with the V1 roles.
 */

import type { RunnableTool, RunnerToolResult } from '@kodax-ai/agent';

import { coerceManagedProtocolToolPayload } from '../managed-protocol.js';
import type { KodaXManagedProtocolPayload } from '../types.js';

// FEATURE_190 (v0.7.43) Phase 3: `EMIT_HANDOFF_TOOL_NAME` / `emitHandoff`
// deleted. FEATURE_193 (v0.7.43): `EMIT_SCOUT_VERDICT_TOOL_NAME` /
// `emitScoutVerdict` + `EMIT_CONTRACT_TOOL_NAME` / `emitContract` deleted
// alongside the V1 chain Scout/Planner agents.
export const EMIT_VERDICT_TOOL_NAME = 'emit_verdict';

/**
 * Shared metadata shape on the tool result. The Runner-driven task engine
 * inspects `payload` to understand the Sidecar Verifier verdict.
 *
 * FEATURE_193 (v0.7.43): the role union narrowed from the V1 four-role
 * set (scout/planner/generator/evaluator) to `'evaluator'` only — Sidecar
 * Verifier is the sole emitter that survives V1 chain retirement.
 */
export interface ProtocolEmitterMetadata {
  /** The role that emitted this payload — always `'evaluator'` in V2. */
  readonly role: 'evaluator';
  /** Normalized payload slice (verdict). */
  readonly payload: Partial<KodaXManagedProtocolPayload>;
  /**
   * FEATURE_084 Shard 4 handoff signal. When set, the Runner looks up the
   * handoff in `currentAgent.handoffs` and transfers ownership. When
   * undefined, the current agent remains responsible (terminal / direct
   * case). See each emitter's body for the payload → target mapping.
   */
  readonly handoffTarget?: string;
  /**
   * True when the payload denotes a terminal outcome (H0 direct, accept,
   * blocked). The Runner uses this as a signal that no further LLM turn is
   * expected after the current one.
   */
  readonly isTerminal?: boolean;
}

/**
 * Map a normalized verdict payload → handoff target agent name. Pure
 * function so both the emitter and unit tests can verify the mapping
 * rules.
 *
 * Post-FEATURE_193: every verdict status is terminal — accept and blocked
 * close the round; revise no longer hands off to a Planner agent because
 * the V1 chain is gone (Sidecar replies via Worker re-run scheduling).
 * The `handoffTarget` field of the returned shape is preserved for
 * backwards-compatible recorder bookkeeping but is always omitted now.
 */
export function resolveHandoffTarget(
  _role: ProtocolEmitterMetadata['role'],
  _normalized: Partial<KodaXManagedProtocolPayload>,
): { handoffTarget?: string; isTerminal: boolean } {
  return { isTerminal: true };
}

interface EmitterSpec {
  readonly name: string;
  readonly role: ProtocolEmitterMetadata['role'];
  readonly description: string;
  readonly inputSchema: RunnableTool['input_schema'];
}

function buildEmitter(spec: EmitterSpec): RunnableTool {
  return {
    name: spec.name,
    description: spec.description,
    input_schema: spec.inputSchema,
    execute: async (input): Promise<RunnerToolResult> => {
      const normalized = coerceManagedProtocolToolPayload(spec.role, input);
      if (!normalized) {
        return {
          content:
            `[${spec.name}] payload could not be normalized for role ${spec.role}. ` +
            'Check that required fields are present and enum values match the schema.',
          isError: true,
        };
      }
      const { handoffTarget, isTerminal } = resolveHandoffTarget(spec.role, normalized);
      const metadata: ProtocolEmitterMetadata = {
        role: spec.role,
        payload: normalized,
        handoffTarget,
        isTerminal,
      };
      return {
        content: `${spec.role} payload recorded (${summarizeNormalized(spec.role, normalized)})`,
        metadata: metadata as unknown as Record<string, unknown>,
      };
    },
  };
}

function summarizeNormalized(
  _role: ProtocolEmitterMetadata['role'],
  normalized: Partial<KodaXManagedProtocolPayload>,
): string {
  if (normalized.verdict) {
    const next = normalized.verdict.nextHarness ? `, next=${normalized.verdict.nextHarness}` : '';
    return `status=${normalized.verdict.status}${next}`;
  }
  return 'ok';
}

// FEATURE_193 (v0.7.43): `emitScoutVerdict` + `emitContract` deleted with
// V1 chain retirement. Scout / Planner roles no longer exist.

/**
 * Sidecar Verifier verdict emitter (FEATURE_184). Decides the terminal
 * outcome of the round: accept, revise (Worker re-runs to fix), or
 * blocked. The Runner-driven engine reads `metadata.payload.verdict.status`
 * to decide next hop. Called by the Stop-hook Sidecar Verifier, never
 * by Worker/Generator directly.
 */
export const emitVerdict: RunnableTool = buildEmitter({
  name: EMIT_VERDICT_TOOL_NAME,
  role: 'evaluator',
  description:
    'Emit the Sidecar Verifier verdict — accept / revise / blocked. Call this exactly once after ' +
    'verification is complete. A `revise` verdict may include `next_harness` to escalate (H1 → H2). ' +
    'When the task is complete, set `user_answer` to the multi-line answer the user should see.',
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['accept', 'revise', 'blocked'],
        description: 'Verdict outcome.',
      },
      reason: { type: 'string', description: 'One-line reason for the verdict.' },
      user_answer: {
        type: 'string',
        description: 'Multi-line final answer for the user (required when status=accept for H0/H1/H2 final).',
      },
      next_harness: {
        type: 'string',
        enum: ['H1_EXECUTE_EVAL', 'H2_PLAN_EXECUTE_EVAL'],
        description: 'For revise: which harness tier to retry in.',
      },
      followup: {
        type: 'array',
        items: { type: 'string' },
        description: 'Required next steps (may be empty).',
      },
      budget_request: {
        type: 'string',
        description:
          'Optional one-line reason when the Evaluator needs more budget to complete verification ' +
          '(e.g. "need another e2e pass"). Surfaces a budget-extension dialog to the user regardless ' +
          'of the 90% auto-threshold. Leave unset when no extra budget is needed.',
      },
    },
    required: ['status'],
  },
});

/**
 * Emitter tools tuple. FEATURE_190 (v0.7.43) shrank from 4→3 with
 * `emitHandoff` deletion; FEATURE_193 (v0.7.43) shrank to 1 with
 * `emitScoutVerdict` + `emitContract` deletion — only the Sidecar Verifier
 * emitter survives.
 */
export const PROTOCOL_EMITTER_TOOLS: readonly RunnableTool[] = Object.freeze([
  emitVerdict,
]);
