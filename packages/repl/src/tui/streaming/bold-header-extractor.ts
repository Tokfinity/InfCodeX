/**
 * FEATURE_202 (v0.7.45) — extract the first **bold** header from a reasoning
 * stream buffer, to surface "Thinking: <topic>" as a live status line.
 *
 * Pure function (typed in/out) for easy unit testing. Rules:
 * - first CLOSED `**...**` pair within the early scan window → header = inner text
 * - only an unclosed `**` so far → undefined (wait for the next delta)
 * - no `**` in the early window → undefined (give up; don't scan a growing buffer)
 */
const SCAN_WINDOW = 400;
const MAX_HEADER_LEN = 80;

export function extractBoldHeader(reasoningBuffer: string): { header?: string } {
  const window = reasoningBuffer.slice(0, SCAN_WINDOW);
  // Non-greedy, single-line, bounded length — matches the first closed pair.
  const match = window.match(new RegExp(`\\*\\*([^*\\n]{1,${MAX_HEADER_LEN}}?)\\*\\*`));
  const inner = match?.[1]?.trim();
  return inner ? { header: inner } : {};
}
