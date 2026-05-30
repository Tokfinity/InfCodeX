/**
 * FEATURE_200 Phase B.4 (v0.7.45) — InkREPL managed-task transcript builders.
 *
 * Builds the final managed-task transcript strings (routing diagnostics +
 * per-role evidence + completion label) from a `KodaXResult`, extracted
 * verbatim from `InkREPL.tsx`. Includes the FEATURE_195 sidecar-accept filter
 * (its only caller is `buildManagedTaskTranscriptItems`, so it is co-located
 * rather than split into its own module). No React, no component state.
 */
import type { KodaXResult } from '@kodax-ai/coding';

import { t } from '../common/i18n.js';
import { sanitizeUserFacingAssistantText } from './utils/message-utils.js';

/**
 * FEATURE_195 (v0.7.43): hide Sidecar Verifier accept-verdict evidence entries
 * by default. F184 ships "silent accept" — an accept verdict should only land
 * in session.jsonl + artifacts, not the transcript UI. Opt in via
 * `KODAX_VERIFIER_LOG=1` / `verifierLog: true` config (passed as `verifierLog`).
 */
function shouldFilterSidecarAcceptEntry(
  entry: NonNullable<KodaXResult['managedTask']>['evidence']['entries'][number],
  verifierLog: boolean,
): boolean {
  if (verifierLog) return false;
  if (entry.role !== 'evaluator') return false;
  if (entry.signal !== 'COMPLETE') return false;
  return true;
}

/** Routing diagnostics block (skipped for simple H0_DIRECT direct responses). */
function buildManagedTaskRoutingTranscript(
  task: NonNullable<KodaXResult['managedTask']>,
): string | undefined {
  const raw = task.runtime?.rawRoutingDecision;
  const final = task.runtime?.finalRoutingDecision;
  if (!raw || !final) {
    return undefined;
  }
  // Skip routing diagnostics for simple direct responses — no useful signal.
  if (raw.harnessProfile === 'H0_DIRECT' && final.harnessProfile === 'H0_DIRECT') {
    return undefined;
  }

  const lines = [
    '[Routing]',
    `AMA routing: raw=${raw.harnessProfile}(${raw.routingSource ?? 'unknown'}) -> final=${final.harnessProfile}`,
    `Primary task: ${raw.primaryTask}`,
    `Review target: ${final.reviewTarget ?? 'general'}`,
    `Review scale: ${final.reviewScale ?? 'unknown'}`,
    `Solo boundary: ${raw.soloBoundaryConfidence?.toFixed(2) ?? 'n/a'}`,
    `Independent QA: ${raw.needsIndependentQA ? 'yes' : 'no'}`,
    task.runtime?.qualityAssuranceMode
      ? `Quality assurance: ${task.runtime.qualityAssuranceMode}`
      : undefined,
    task.runtime?.budget
      ? `Adaptive budget: rounds=${task.runtime.budget.plannedRounds} total=${task.runtime.budget.totalBudget} reserve=${task.runtime.budget.reserveBudget}`
      : undefined,
    task.runtime?.routingOverrideReason
      ? `Override reason: ${task.runtime.routingOverrideReason}`
      : undefined,
    final.upgradeCeiling ? `Upgrade ceiling: ${final.upgradeCeiling}` : undefined,
  ].filter((line): line is string => Boolean(line));

  return lines.join('\n');
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
  // FEATURE_195 (v0.7.43): default reads env var (already mirrored from
  // `~/.kodax/config.json` `verifierLog: true` at REPL boot). Test paths pass
  // the option explicitly to avoid env coupling.
  const verifierLog = options?.verifierLog ?? process.env.KODAX_VERIFIER_LOG === '1';

  const isInterruptedCancellation = (
    entry: NonNullable<KodaXResult['managedTask']>['evidence']['entries'][number],
  ): boolean => {
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

  const routingTranscript = buildManagedTaskRoutingTranscript(task);

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
    // FEATURE_195 (v0.7.43): hide Sidecar Verifier accept verdict entries by
    // default — see shouldFilterSidecarAcceptEntry above.
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
      return `[${entry.title ?? entry.assignmentId}${labelSuffix}]\n${text}`;
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
    ...(routingTranscript ? [routingTranscript] : []),
    ...evidenceTranscripts,
    ...(completionLabel ? [`[${completionLabel}]`] : []),
  ];
}
