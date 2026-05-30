/**
 * FEATURE_200 Phase B.3 (v0.7.45) — InkREPL managed-task live event drafts.
 *
 * Builds the per-round live transcript drafts from a managed-task status
 * event, extracted verbatim from `InkREPL.tsx`. No React, no component state.
 */
import type { KodaXManagedTaskStatusEvent } from '@kodax-ai/coding';

import type { HistoryItem } from './types.js';
import { localizeManagedCompletionSummary } from './InkREPL-managed-task-renderers.js';
import { formatManagedTaskBreadcrumb } from './utils/live-streaming.js';

// v0.7.38 (2026-05-11): suppress task-completed / fallback lifecycle markers by
// default (parity with Claude Code, which signals turn end via spinner halt).
// Set KODAX_TRANSCRIPT_HARNESS_MARKERS=1 to restore the legacy behaviour for
// debugging / replay analysis. Read once at module load — same semantics as
// the prior in-InkREPL const.
const TRANSCRIPT_HARNESS_MARKERS_ENABLED =
  process.env.KODAX_TRANSCRIPT_HARNESS_MARKERS === '1';

export type ManagedLiveItemDraft = {
  item: HistoryItem;
  persistToHistory: boolean;
};

export function buildManagedLiveEventDrafts(
  status: KodaXManagedTaskStatusEvent,
): ManagedLiveItemDraft[] {
  if (status.events && status.events.length > 0) {
    return status.events.reduce<ManagedLiveItemDraft[]>((acc, event) => {
      const compactText = event.summary.trim();
      const text = (event.detail ?? event.summary).trim();
      if (!compactText || !text) {
        return acc;
      }
      const itemId = `managed-live-${event.key}`;
      const timestamp = Date.now();
      const persistToHistory = event.persistToHistory ?? status.persistToHistory ?? false;
      if (event.presentation === 'thinking') {
        acc.push({
          item: {
            id: itemId,
            type: 'thinking',
            timestamp,
            text,
            ...(compactText !== text ? { compactText } : {}),
          },
          persistToHistory,
        });
        return acc;
      }
      if (event.presentation === 'assistant') {
        acc.push({
          item: {
            id: itemId,
            type: 'assistant',
            timestamp,
            text,
            ...(compactText !== text ? { compactText } : {}),
          },
          persistToHistory,
        });
        return acc;
      }
      const isCompleted = event.kind === 'completed';
      // Suppress the task-completed lifecycle marker by default (see the
      // TRANSCRIPT_HARNESS_MARKERS_ENABLED comment above).
      if (isCompleted && !TRANSCRIPT_HARNESS_MARKERS_ENABLED) {
        return acc;
      }
      const localizedLabel = isCompleted
        ? `[${localizeManagedCompletionSummary(compactText)}]`
        : undefined;
      const localizedCompact = localizedLabel ?? compactText;
      const localizedText = localizedLabel ?? text;
      acc.push({
        item: {
          id: itemId,
          type: 'event',
          timestamp,
          text: localizedText,
          icon: event.kind === 'warning' ? '!' : isCompleted ? '✓' : '>',
          ...(localizedCompact !== localizedText ? { compactText: localizedCompact } : {}),
        },
        persistToHistory,
      });
      return acc;
    }, []);
  }

  // Suppress the fallback "AMA H0 - Task completed" breadcrumb by default
  // (mirrors the events-array branch above).
  if (status.phase === 'completed' && !TRANSCRIPT_HARNESS_MARKERS_ENABLED) {
    return [];
  }
  const compactText = formatManagedTaskBreadcrumb(status);
  const text = formatManagedTaskBreadcrumb(status, { expanded: true }) ?? compactText;
  if (!compactText || !text) {
    return [];
  }
  return [
    {
      item: {
        id: `managed-live-fallback-${status.phase ?? 'worker'}-${compactText
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .slice(0, 48)}`,
        type: 'event',
        timestamp: Date.now(),
        text,
        icon: '>',
        ...(compactText !== text ? { compactText } : {}),
      },
      persistToHistory: status.persistToHistory ?? false,
    },
  ];
}
