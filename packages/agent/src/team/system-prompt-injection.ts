/**
 * FEATURE_125 (v0.7.41) — Team Mode Layer 2b: system-prompt injection.
 *
 * Renders the `=== Other active KodaX sessions ===` block that the
 * coding-side system-prompt builder splices into the worker system
 * prompt when sibling instances are alive. Pure formatter — no fs,
 * no clock, no globals.
 *
 * Contract:
 *   - Input: a list of `DiscoveredInstance` (from S2) + `nowMs`.
 *   - Output: a string block (or empty string when input is empty).
 *   - When the list is empty, returns `''` so the caller can splice
 *     unconditionally without an `if (block)` branch.
 *   - When the list is non-empty, the rendered block is bookended by
 *     a single header line and a single coordination-guidance paragraph
 *     so the LLM has clear context for the data it just received.
 *
 * The block deliberately does NOT prescribe a specific action (no
 * "you MUST avoid editing X"); it surfaces context and lets the LLM
 * self-decide per the FEATURE_125 LLM-First philosophy. The prompt
 * eval at S7 verifies LLM behavior under this block.
 */

import type { DiscoveredInstance } from './instance-discovery.js';

export interface RenderOptions {
  /**
   * Defaults to `Date.now()`. Tests pass a controllable clock.
   * Affects only the "(started N min ago)" / "(M min ago)" relative
   * timestamps; absolute fields are passed through verbatim.
   */
  readonly nowMs?: number;
  /**
   * Maximum number of sibling instances to render. Defaults to 5 —
   * if a user has >5 sessions open we summarize the rest with a
   * "+N more" hint rather than blowing up the system prompt. Per
   * EVAL_GUIDELINES, prompt context budget is finite; cap before
   * the LLM-call site (not after).
   */
  readonly maxRendered?: number;
  /**
   * Cap on `recentlyModifiedFiles` per peer. Defaults to 3 — keeps
   * the block scannable when one peer has touched many files.
   */
  readonly maxRecentFilesPerPeer?: number;
}

/**
 * Build the system-prompt block describing currently-active sibling
 * KodaX sessions. Pure function — same inputs always produce the same
 * output.
 *
 * Returns `''` (empty string) when `instances.length === 0`. Callers
 * splice with template-literal concatenation; the empty-string default
 * means no conditional is needed.
 */
export function buildOtherInstancesPromptBlock(
  instances: readonly DiscoveredInstance[],
  options: RenderOptions = {},
): string {
  if (instances.length === 0) return '';

  const nowMs = options.nowMs ?? Date.now();
  const maxRendered = options.maxRendered ?? 5;
  const maxRecentFiles = options.maxRecentFilesPerPeer ?? 3;
  const headLines: string[] = [];
  const peerCount = instances.length;

  headLines.push('=== Other active KodaX sessions ===');
  headLines.push('');
  headLines.push(
    peerCount === 1
      ? 'You are not alone — the user has 1 other KodaX session running:'
      : `You are not alone — the user has ${peerCount} other KodaX sessions running:`,
  );
  headLines.push('');

  const rendered = instances.slice(0, maxRendered);
  for (const peer of rendered) {
    headLines.push(...renderPeer(peer, nowMs, maxRecentFiles));
    headLines.push('');
  }

  const truncated = instances.length - rendered.length;
  if (truncated > 0) {
    headLines.push(
      `(+${truncated} more session${truncated === 1 ? '' : 's'} omitted to keep the prompt scannable; freshest ${maxRendered} shown.)`,
    );
    headLines.push('');
  }

  headLines.push(
    'Coordination guidance:',
    '- If your task overlaps with their active_files, consider working on different files first, reading their active file before editing, or coordinating via the user. Use your judgment — concurrent work on disjoint files is fine.',
    '- Their recentlyModifiedFiles may have just changed; re-read before relying on memory of their content.',
    "- Don't fight them — let them finish what they started.",
  );

  return headLines.join('\n');
}

function renderPeer(
  peer: DiscoveredInstance,
  nowMs: number,
  maxRecentFiles: number,
): string[] {
  const lines: string[] = [];
  const { state } = peer;
  const startedAgo = formatRelativeAgo(nowMs - state.meta.startedAt);
  const branchSuffix = state.meta.gitBranch ? `, on branch ${state.meta.gitBranch}` : '';

  lines.push(`- pid ${peer.pid} @ ${state.meta.cwd} (started ${startedAgo}${branchSuffix})`);
  lines.push(`  Phase: ${state.agentPhase}`);

  if (state.currentIntent) {
    lines.push(`  Intent: "${state.currentIntent}"`);
  }

  if (state.activeFiles && state.activeFiles.length > 0) {
    const verb = state.activeFiles.length === 1 ? 'Currently editing' : 'Currently editing (multiple)';
    lines.push(`  ${verb}: ${state.activeFiles.join(', ')}`);
  }

  if (state.recentlyModifiedFiles && state.recentlyModifiedFiles.length > 0) {
    const shown = state.recentlyModifiedFiles.slice(0, maxRecentFiles);
    const recentText = shown
      .map((f) => `${f.path} (${formatRelativeAgo(nowMs - f.modifiedAt)})`)
      .join(', ');
    const more = state.recentlyModifiedFiles.length - shown.length;
    const tail = more > 0 ? `, +${more} more` : '';
    lines.push(`  Recently modified: ${recentText}${tail}`);
  }

  if (state.currentTodoSummary) {
    const { inProgress, pendingCount, completedCount } = state.currentTodoSummary;
    const pieces: string[] = [];
    if (inProgress) pieces.push(`in-progress: "${inProgress}"`);
    pieces.push(`${pendingCount} pending`);
    pieces.push(`${completedCount} completed`);
    lines.push(`  Todo: ${pieces.join(', ')}`);
  }

  return lines;
}

/**
 * Format an ms duration as a short relative string. Used for "(started
 * 5 min ago)" / "Recently modified: foo.ts (2 min ago)" callouts.
 *
 * Buckets at common human granularity boundaries — sub-second is
 * rendered as "just now" rather than fractional seconds.
 */
function formatRelativeAgo(deltaMs: number): string {
  if (deltaMs < 1000) return 'just now';
  const seconds = Math.round(deltaMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
