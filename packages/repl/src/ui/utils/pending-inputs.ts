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

/**
 * v0.7.42 layout bugfix — produce a multi-line string that mirrors what
 * `QueuedCommandsSurface` actually renders (one row per queued item plus a
 * trailing hint row). The viewport budget feeds this to `wrapLineCount` so
 * `pendingInputRows` reflects the true footer height. Without this, queue
 * depth ≥ 2 under-reserves rows and pushes the composer + status bar off
 * screen instead of compressing the transcript above. Returns `undefined`
 * when the queue is empty so the caller can skip the reservation entirely.
 */
export function formatPendingInputsBudgetText(
  pendingInputs: readonly string[],
): string | undefined {
  const lines = formatPendingInputsLines(pendingInputs);
  if (lines.length === 0) {
    return undefined;
  }
  const itemLines = lines.map(
    (line) => `⏳ [${line.index}/${line.total}] ${line.preview}`,
  );
  const hintLine = "  ↑ pull all into editor · Esc drops latest";
  return [...itemLines, hintLine].join("\n");
}
