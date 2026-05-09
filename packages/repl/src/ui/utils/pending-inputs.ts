export const MAX_PENDING_INPUTS = 5;

const MAX_PENDING_INPUT_PREVIEW = 72;

function normalizePendingPreview(input: string): string {
  const normalized = input.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_PENDING_INPUT_PREVIEW) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_PENDING_INPUT_PREVIEW - 3)}...`;
}

export function formatPendingInputsSummary(pendingInputs: readonly string[]): string | undefined {
  if (pendingInputs.length === 0) {
    return undefined;
  }

  const latest = normalizePendingPreview(pendingInputs[pendingInputs.length - 1] ?? "");
  if (pendingInputs.length === 1) {
    return `Queued 1 follow-up: ${latest} (Esc removes it)`;
  }

  return `Queued ${pendingInputs.length} follow-ups. Latest: ${latest} (Esc removes latest)`;
}

/**
 * FEATURE_149 Phase 2.2 (v0.7.38) — render queued items individually instead
 * of a single summary line. Each entry gets `[i/N] preview` so the user can
 * see exact ordering before they hit ↑ to edit. Returns an empty array when
 * the queue is empty.
 */
export interface PendingInputLine {
  readonly index: number;
  readonly total: number;
  readonly preview: string;
}

export function formatPendingInputsLines(
  pendingInputs: readonly string[],
): readonly PendingInputLine[] {
  if (pendingInputs.length === 0) {
    return [];
  }

  const total = pendingInputs.length;
  return pendingInputs.map((input, idx) => ({
    index: idx + 1,
    total,
    preview: normalizePendingPreview(input),
  }));
}
