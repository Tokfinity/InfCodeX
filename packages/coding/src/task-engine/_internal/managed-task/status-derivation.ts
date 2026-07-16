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
  const sanitized = sanitizeManagedUserFacingText(raw);
  // A bare empty-content placeholder ('...' from legacy pre-fix sessions) is
  // not real user-facing text. New sessions use an empty text block (raw "").
  return sanitized.trim() === '...' ? '' : sanitized;
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
 *   1. Sidecar Verifier verdict if present (accept / revise / blocked) —
 *      F184 v0.7.45 retired the in-chain Evaluator; this slot is now
 *      populated exclusively by the Stop-hook Sidecar Verifier
 *      (`agent-runtime/middleware/sidecar-verifier/`)
 *   2. Fallback: `{signal: 'COMPLETE'}` — the canonical text-only
 *      termination outcome. Worker produces a final text message,
 *      Runner.run exits via the no-tool-calls branch, the verdict slot
 *      is not populated, and this function returns COMPLETE. This is
 *      the DEFAULT happy-path post-F184; no recorder mutation is
 *      required for a successful Worker termination.
 *
 * FEATURE_193 (v0.7.43): removed the legacy `emit_handoff(status:'blocked')`
 * fallback — F190 deleted that tool, F193 removed the `recorder.handoff`
 * slot entirely. Generator-level blockers no longer exist on V2.
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
  // FEATURE_193 (v0.7.43): scout / contract / handoff slices removed —
  // V1 chain retired, VerdictRecorder no longer carries those slots.
  // Only verdict survives (Sidecar Verifier bridge).
  if (!recorder.verdict?.payload.verdict) return undefined;
  return { verdict: recorder.verdict.payload.verdict } as KodaXManagedProtocolPayload;
}
