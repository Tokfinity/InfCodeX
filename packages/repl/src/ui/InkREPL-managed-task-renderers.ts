/**
 * FEATURE_200 Phase B.2 (v0.7.45) — InkREPL managed-task live renderers.
 *
 * Label/equivalence/localization helpers for managed-task live activity,
 * extracted verbatim from `InkREPL.tsx`. No React, no component state.
 */
import { t } from '../common/i18n.js';
import type { HistoryItem, ToolCall } from './types.js';
import { formatToolCallInlineText } from './utils/tool-display.js';

/** Strip a redundant `[workerTitle]` segment from a live activity label. */
export function formatManagedLiveActivityLabel(
  label: string | undefined,
  workerTitle?: string,
): string | undefined {
  if (!label || !workerTitle) {
    return label;
  }
  const escapedWorkerTitle = workerTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return label
    .replace(new RegExp(`^\\[Tools\\]\\s+\\[${escapedWorkerTitle}\\]\\s+`, 'i'), '[Tools] ')
    .replace(new RegExp(`^\\[Thinking\\]\\s+\\[${escapedWorkerTitle}\\]\\s*`, 'i'), '[Thinking] ')
    .replace(new RegExp(`^\\[${escapedWorkerTitle}\\]\\s+thinking\\b`, 'i'), '[Thinking]')
    .trim();
}

/** Build a `[Tools] …` live label for a tool call, worker-title de-duplicated. */
export function formatManagedLiveToolLabel(tool: ToolCall, workerTitle?: string): string {
  return (
    formatManagedLiveActivityLabel(`[Tools] ${formatToolCallInlineText(tool)}`, workerTitle) ??
    `[Tools] ${formatToolCallInlineText(tool)}`
  );
}

/** Structural equivalence for two live history items (skip redundant re-renders). */
export function areManagedLiveItemsEquivalent(left: HistoryItem, right: HistoryItem): boolean {
  if (left.type !== right.type) {
    return false;
  }

  switch (left.type) {
    case 'assistant': {
      const next = right as typeof left;
      return left.text === next.text && left.compactText === next.compactText;
    }
    case 'thinking': {
      const next = right as typeof left;
      return left.text === next.text && left.compactText === next.compactText;
    }
    case 'event': {
      const next = right as typeof left;
      return (
        left.text === next.text &&
        left.compactText === next.compactText &&
        left.icon === next.icon
      );
    }
    case 'info': {
      const next = right as typeof left;
      return (
        left.text === next.text &&
        left.compactText === next.compactText &&
        left.icon === next.icon
      );
    }
    case 'error':
    case 'hint':
    case 'system':
    case 'user': {
      const next = right as typeof left;
      return left.text === next.text;
    }
    case 'tool_group': {
      const next = right as typeof left;
      return JSON.stringify(left.tools) === JSON.stringify(next.tools);
    }
    default:
      return false;
  }
}

/** Map an English managed-completion summary to its localized transcript label. */
export function localizeManagedCompletionSummary(summary: string): string {
  if (summary === 'Task completed') {
    return t('managed.completed');
  }
  if (summary === 'Task needs continuation') {
    return t('managed.completed.continuation');
  }
  if (summary === 'Task ended: blocked') {
    return t('managed.completed.blocked');
  }
  if (summary === 'Task ended: needs_continuation') {
    return t('managed.completed.continuation');
  }
  if (summary.startsWith('Task ended:')) {
    return t('managed.completed.blocked');
  }
  return summary;
}
