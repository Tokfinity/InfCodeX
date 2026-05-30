/**
 * FEATURE_200 Phase B.1 (v0.7.45) — InkREPL misc string/predicate helpers.
 *
 * Leaf utilities extracted verbatim from `InkREPL.tsx` to shrink the main
 * component file. Pure functions (plus the i18n-aware completion-item check);
 * no React, no component state.
 */
import { t } from '../common/i18n.js';

/** Trim + ellipsize a tool input preview (default cap 240 chars). */
export function truncateToolPreview(value: string, maxLength = 240): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 3)}...` : trimmed;
}

/** Trim + ellipsize a tool output preview (default cap 800 chars). */
export function truncateToolOutputPreview(value: string, maxLength = 800): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 3)}...` : trimmed;
}

/** Strip a leading `[role]` / `name:` prefix from a tool label. */
export function stripToolRolePrefix(toolName: string): string {
  return toolName
    .replace(/^\[[^\]]+\]\s+/, '')
    .replace(/^[A-Za-z][A-Za-z0-9_-]*:\s*/, '')
    .trim();
}

/** Lowercased, prefix-stripped tool name for matching. */
export function normalizeToolNameForMatch(toolName: string): string {
  return stripToolRolePrefix(toolName).toLowerCase();
}

/** Whether a transcript line is one of the managed-task completion markers. */
export function isCompletionTranscriptItem(text: string): boolean {
  return (
    text === `[${t('managed.completed')}]` ||
    text === `[${t('managed.completed.blocked')}]` ||
    text === `[${t('managed.completed.continuation')}]`
  );
}
