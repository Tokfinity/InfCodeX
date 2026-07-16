/**
 * Managed-task transcript builders.
 *
 * Builds the final managed-task transcript strings (per-role evidence and
 * completion label) from a `KodaXResult`. Includes the FEATURE_195
 * sidecar-accept filter. No React, no component state.
 */
import type { KodaXResult } from '@kodax-ai/coding';

import { t } from '../common/i18n.js';
import { sanitizeUserFacingAssistantText } from './utils/message-utils.js';

type ManagedTask = NonNullable<KodaXResult['managedTask']>;
type EvidenceEntry = ManagedTask['evidence']['entries'][number];

/**
 * FEATURE_195 (v0.7.43): hide Sidecar Verifier accept-verdict evidence entries
 * by default. Revise / blocked verdicts remain visible because they are
 * user-actionable. Debug visibility is opt-in via verifierLog.
 */
function shouldFilterSidecarAcceptEntry(
  entry: EvidenceEntry,
  verifierLog: boolean,
): boolean {
  if (verifierLog) return false;
  if (entry.role !== 'evaluator') return false;
  if (entry.signal !== 'COMPLETE') return false;
  return true;
}

/** Build the managed-task transcript string list shown after a run completes. */
export function buildManagedTaskTranscriptItems(
  result: KodaXResult,
  options?: { readonly verifierLog?: boolean },
): string[] {
  const task = result.managedTask;
  if (!task) {
    return [];
  }
  const verifierLog = options?.verifierLog ?? process.env.KODAX_VERIFIER_LOG === '1';

  const isInterruptedCancellation = (entry: EvidenceEntry): boolean => {
    if (!result.interrupted && !task.verdict.signalReason?.includes('Orchestration cancelled')) {
      return false;
    }
    const signalReason = entry.signalReason?.trim() ?? '';
    const summary = entry.summary?.trim() ?? '';
    const output = entry.output?.trim() ?? '';
    const cancelledSignal = signalReason.includes('Orchestration cancelled');
    const cancelledSummary = summary.includes('Orchestration cancelled');
    const emptyOrPlaceholderOutput = !output || summary === 'No textual output produced.';
    return (
      (entry.status !== 'completed' &&
        (cancelledSignal || cancelledSummary || emptyOrPlaceholderOutput)) ||
      ((cancelledSignal || cancelledSummary) && emptyOrPlaceholderOutput)
    );
  };

  const orderByAssignment = new Map(
    task.roleAssignments.map((assignment, index) => [assignment.id, index]),
  );
  const finalAssignmentId = task.verdict.decidedByAssignmentId;
  const finalRound = Math.max(
    0,
    ...task.evidence.entries
      .filter((entry) => entry.assignmentId === finalAssignmentId)
      .map((entry) => entry.round ?? 1),
  );

  const evidenceTranscripts = [...task.evidence.entries]
    .sort((left, right) => {
      const roundDelta = (left.round ?? 1) - (right.round ?? 1);
      if (roundDelta !== 0) {
        return roundDelta;
      }
      return (
        (orderByAssignment.get(left.assignmentId) ?? 0) -
        (orderByAssignment.get(right.assignmentId) ?? 0)
      );
    })
    .filter((entry) => !isInterruptedCancellation(entry))
    .filter((entry) => !shouldFilterSidecarAcceptEntry(entry, verifierLog))
    .filter(
      (entry) =>
        result.interrupted ||
        !(entry.assignmentId === finalAssignmentId && (entry.round ?? 1) === finalRound),
    )
    .map((entry) => {
      const rawOutput = entry.output?.trim() ?? '';
      const rawSummary = entry.summary?.trim() ?? '';
      const sanitizedOutput = rawOutput ? sanitizeUserFacingAssistantText(rawOutput) : '';
      const sanitizedSummary = rawSummary ? sanitizeUserFacingAssistantText(rawSummary) : '';
      const fallbackText =
        entry.role === 'scout'
          ? sanitizedSummary
            ? `Scout completed: ${sanitizedSummary}`
            : 'Scout completed.'
          : sanitizedSummary;
      return {
        entry,
        text: sanitizedSummary || sanitizedOutput || fallbackText,
      };
    })
    .filter(({ text }) => Boolean(text))
    .map(({ entry, text }) => {
      const labelSuffix =
        entry.role === 'scout'
          ? ' Preflight'
          : (entry.round ?? 1) > 1
            ? ` Round ${entry.round}`
            : '';
      // FEATURE_184 follow-up: the Sidecar Verifier's verdicts carry the legacy
      // 'evaluator' role name (verifier-recorder-bridge writes role:'evaluator'
      // for downstream-slot compat). Attribute the surfaced revise / blocked
      // feedback to the Sidecar identity instead of a phantom [Evaluator] agent
      // — the in-chain Evaluator was retired in v0.7.45, and the same verdict is
      // rendered live as a first-class sidecar item via onSidecarMessage.
      const label =
        entry.role === 'evaluator'
          ? `⚡ Sidecar Verifier${labelSuffix}`
          : `${entry.title ?? entry.assignmentId}${labelSuffix}`;
      return `[${label}]\n${text}`;
    });
  const completionLabel =
    task.verdict.disposition === 'complete'
      ? t('managed.completed')
      : task.verdict.disposition === 'needs_continuation'
        ? t('managed.completed.continuation')
        : task.verdict.disposition === 'blocked'
          ? t('managed.completed.blocked')
          : undefined;

  return [
    ...evidenceTranscripts,
    ...(completionLabel ? [`[${completionLabel}]`] : []),
  ];
}
