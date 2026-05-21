/**
 * Final-status / user-facing-text / managed-protocol payload derivation.
 *
 * The Runner-driven loop emits a single `KodaXResult` per managed-task
 * run; these helpers convert the recorder + RunnerResult tail into that
 * shape. Splits cleanly out of the orchestrator because the helpers
 * read only the immutable recorder/result shapes — no closures over
 * mid-run state.
 *
 * Extracted from `task-engine/runner-driven.ts` (lines 4060–4129 in
 * the pre-FEATURE_171 monolith) as part of FEATURE_171 (v0.7.41)
 * modular split. Zero behavior change — bodies are byte-identical to
 * the previous in-file declarations.
 */

import type {
  KodaXContentBlock,
  KodaXMessage,
  KodaXTextBlock,
} from '@kodax-ai/llm';
import type {
  KodaXManagedProtocolPayload,
  KodaXResult,
} from '../../../types.js';
import { sanitizeManagedUserFacingText } from './sanitize.js';
import type { VerdictRecorder } from './types.js';

export function extractUserFacingText(result: { messages: readonly KodaXMessage[]; output: string }): string {
  const raw = extractUserFacingRaw(result);
  // Strip internal managed control-plane markers and any
  // stray ```kodax-task-*``` fences (complete or truncated) that the LLM
  // might emit in assistant text despite using structured emit tools.
  // Legacy task-engine.ts applied this at 14 call sites; re-added at the
  // single Runner-driven extraction point.
  return sanitizeManagedUserFacingText(raw);
}

export function extractUserFacingRaw(result: { messages: readonly KodaXMessage[]; output: string }): string {
  if (result.output.trim().length > 0) return result.output;
  const last = result.messages[result.messages.length - 1];
  if (!last || last.role !== 'assistant') return '';
  if (typeof last.content === 'string') return last.content;
  return (last.content as KodaXContentBlock[])
    .filter((b): b is KodaXTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

/**
 * Derive the final signal + managedTask.verdict.status from the recorder.
 * Priority:
 *   1. Evaluator verdict if present (accept / revise / blocked)
 *   2. Scout H0 direct completion (maps to completed)
 *   3. Fallback: undefined (treated as converged by round-boundary for the
 *      SA fast-path pattern)
 */
export function deriveFinalStatus(recorder: VerdictRecorder): {
  signal: KodaXResult['signal'];
  verdictStatus?: 'accept' | 'revise' | 'blocked';
  reason?: string;
  userAnswer?: string;
} {
  const verdictPayload = recorder.verdict?.payload.verdict;
  if (verdictPayload) {
    if (verdictPayload.status === 'blocked') {
      return {
        signal: 'BLOCKED',
        verdictStatus: 'blocked',
        reason: verdictPayload.reason,
      };
    }
    return {
      signal: 'COMPLETE',
      verdictStatus: verdictPayload.status,
      reason: verdictPayload.reason,
      userAnswer: verdictPayload.userAnswer,
    };
  }
  // FEATURE_184 (v0.7.45) Phase C.1: in-chain Evaluator is gone, so
  // recorder.verdict is only set by the Sidecar Verifier (out-of-band).
  // Generator can still call emit_handoff(status:'blocked') to surface an
  // unrecoverable blocker directly — check the handoff payload when no
  // verdict has been set. Without this, a Generator-blocked handoff would
  // produce signal:'COMPLETE' and success:true, silently hiding the block.
  //
  // NOTE: We return signal:'BLOCKED' but NOT verdictStatus:'blocked' here.
  // managedTask.verdict.status is owned by the Evaluator / Sidecar Verifier
  // verdict slot; a Generator-level blocked handoff surfaces the block via
  // result.signal only, leaving verdict.status='running' (no verifier ran).
  const handoffPayload = recorder.handoff?.payload.handoff;
  if (handoffPayload?.status === 'blocked') {
    return {
      signal: 'BLOCKED',
      reason: handoffPayload.summary,
    };
  }
  return { signal: 'COMPLETE' };
}

/**
 * Build the minimal `managedProtocolPayload` slice the round-boundary
 * reshape expects. Shard 5b populates whatever the recorder captured;
 * missing slices stay undefined.
 */
export function buildManagedProtocolPayload(
  recorder: VerdictRecorder,
): KodaXManagedProtocolPayload | undefined {
  const slices: Partial<KodaXManagedProtocolPayload> = {};
  if (recorder.scout?.payload.scout) slices.scout = recorder.scout.payload.scout;
  if (recorder.contract?.payload.contract) slices.contract = recorder.contract.payload.contract;
  if (recorder.handoff?.payload.handoff) slices.handoff = recorder.handoff.payload.handoff;
  if (recorder.verdict?.payload.verdict) slices.verdict = recorder.verdict.payload.verdict;
  if (Object.keys(slices).length === 0) return undefined;
  return slices as KodaXManagedProtocolPayload;
}
