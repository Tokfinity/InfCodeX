export interface TranscriptInputActivityState {
  itemsLength: number;
  currentResponse: string;
  thinkingContent: string;
  activeToolCallsLength: number;
}

export function hasTranscriptInputActivity(
  state: TranscriptInputActivityState,
): boolean {
  return state.itemsLength > 0
    || state.currentResponse.length > 0
    || state.thinkingContent.length > 0
    || state.activeToolCallsLength > 0;
}

export interface TranscriptManagedMouseOptions {
  keyName: string | undefined;
  hasMouse: boolean;
  usesManagedMouseClicks: boolean;
  supportsMouseTracking: boolean;
  usesRendererMouseTracking: boolean;
}

export function shouldHandleManagedTranscriptMouse(
  options: TranscriptManagedMouseOptions,
): boolean {
  return options.keyName === "mouse"
    && options.hasMouse
    && options.usesManagedMouseClicks
    && options.supportsMouseTracking
    && options.usesRendererMouseTracking;
}

export interface TranscriptManagedWheelOptions {
  usesManagedMouseWheel: boolean;
  supportsWheelHistory: boolean;
  hasTranscript: boolean;
}

export function shouldHandleManagedTranscriptWheel(
  options: TranscriptManagedWheelOptions,
): boolean {
  return options.usesManagedMouseWheel
    && options.supportsWheelHistory
    && options.hasTranscript;
}

export type TranscriptPointerAction =
  | { kind: "none" }
  | { kind: "consume" }
  | { kind: "scroll-by"; delta: number }
  | { kind: "mouse-phase"; phase: "press" | "drag" | "release" };

export interface ResolveTranscriptPointerActionOptions {
  keyName: string | undefined;
  hasTranscript: boolean;
  historyScrollOffset: number;
  reviewPageSize: number;
  reviewWheelStep: number;
  hasMouse: boolean;
  mouseButton?: string;
  mouseAction?: string;
  usesManagedMouseClicks: boolean;
  supportsMouseTracking: boolean;
  usesRendererMouseTracking: boolean;
  usesManagedMouseWheel: boolean;
  supportsWheelHistory: boolean;
}

export function resolveTranscriptPointerAction(
  options: ResolveTranscriptPointerActionOptions,
): TranscriptPointerAction {
  if (shouldHandleManagedTranscriptMouse({
    keyName: options.keyName,
    hasMouse: options.hasMouse,
    usesManagedMouseClicks: options.usesManagedMouseClicks,
    supportsMouseTracking: options.supportsMouseTracking,
    usesRendererMouseTracking: options.usesRendererMouseTracking,
  })) {
    if (options.mouseButton !== "left") {
      return { kind: "none" };
    }

    if (
      options.mouseAction === "press"
      || options.mouseAction === "drag"
      || options.mouseAction === "release"
    ) {
      return {
        kind: "mouse-phase",
        phase: options.mouseAction,
      };
    }
  }

  if (options.keyName === "pageup") {
    return options.hasTranscript
      ? { kind: "scroll-by", delta: options.reviewPageSize }
      : { kind: "consume" };
  }

  if (options.keyName === "wheelup") {
    if (!shouldHandleManagedTranscriptWheel({
      usesManagedMouseWheel: options.usesManagedMouseWheel,
      supportsWheelHistory: options.supportsWheelHistory,
      hasTranscript: options.hasTranscript,
    })) {
      return { kind: "none" };
    }

    return { kind: "scroll-by", delta: options.reviewWheelStep };
  }

  if (options.keyName === "wheeldown") {
    if (!shouldHandleManagedTranscriptWheel({
      usesManagedMouseWheel: options.usesManagedMouseWheel,
      supportsWheelHistory: options.supportsWheelHistory,
      hasTranscript: options.hasTranscript,
    })) {
      return { kind: "none" };
    }

    return options.historyScrollOffset === 0
      ? { kind: "consume" }
      : { kind: "scroll-by", delta: -options.reviewWheelStep };
  }

  return { kind: "none" };
}

export interface TranscriptCopyKeyOptions {
  hasTextSelection: boolean;
  canCopySelectedItem: boolean;
}

export function resolveTranscriptCopyKeyAction(
  options: TranscriptCopyKeyOptions,
): "selection" | "item" | "none" {
  if (options.hasTextSelection) {
    return "selection";
  }
  if (options.canCopySelectedItem) {
    return "item";
  }
  return "none";
}

export interface TranscriptInterruptPriorityOptions {
  isTranscriptMode: boolean;
  hasTextSelection: boolean;
}

export function shouldDeferInterruptToTranscriptSelectionCopy(
  options: TranscriptInterruptPriorityOptions,
): boolean {
  return options.isTranscriptMode && options.hasTextSelection;
}

/**
 * FEATURE_111 absorbed soft-pause UX (v0.7.36 FEATURE_115 Phase 1D).
 *
 * The "single ESC during a run while the input is empty and no pending
 * input is queued" path returns `arm-double-escape`. This is the
 * absorbed FEATURE_111 soft-pause entry point — it is NOT a no-op:
 *
 *   1. The run continues in the background (the agent does not need
 *      runner-level pause; the substrate is a queue, not a lock).
 *   2. The user can type a follow-up; on Enter, `addPendingInput`
 *      enqueues into both the React `pendingInputs` array AND the
 *      `@kodax/agent` `MessageQueue` main-thread `user` slice
 *      (FEATURE_115 Phase 1B mirror in `StreamingContext`).
 *   3. At the next iteration boundary, `runner-driven.ts` consults
 *      both `events.hasPendingInputs?.()` and
 *      `getMessageQueue().has({ maxPriority: 'user' })`
 *      (FEATURE_115 Phase 1C) and yields the loop early so the outer
 *      REPL can fold the queued input into the next round.
 *   4. A second ESC within `doubleEscapeIntervalMs` upgrades to
 *      `interrupt` (full abort) — the existing double-ESC contract.
 *
 * This design intentionally keeps the runner unaware of a pause flag:
 * the queue + iteration-boundary yield is enough to deliver the FEATURE_111
 * UX without introducing a stateful pause/resume machinery in the agent
 * runner. A future explicit `sleep` / `await_child_task` (FEATURE_119)
 * tool extends this to background-priority drain via Sleep gating.
 */
export type StreamingInterruptAction =
  | { kind: "none" }
  | { kind: "interrupt" }
  | { kind: "pop-pending-input" }
  | { kind: "arm-double-escape" };

export interface ResolveStreamingInterruptActionOptions {
  keyName: string | undefined;
  ctrl: boolean;
  isTranscriptMode: boolean;
  isAwaitingUserInteraction: boolean;
  isInputEmpty: boolean;
  pendingInputCount: number;
  hasTranscriptTextSelection: boolean;
  timeSinceLastEscapeMs: number;
  doubleEscapeIntervalMs: number;
}

export function resolveStreamingInterruptAction(
  options: ResolveStreamingInterruptActionOptions,
): StreamingInterruptAction {
  if (options.ctrl && options.keyName === "c") {
    return shouldDeferInterruptToTranscriptSelectionCopy({
      isTranscriptMode: options.isTranscriptMode,
      hasTextSelection: options.hasTranscriptTextSelection,
    })
      ? { kind: "none" }
      : { kind: "interrupt" };
  }

  if (options.keyName !== "escape") {
    return { kind: "none" };
  }

  if (options.isTranscriptMode || options.isAwaitingUserInteraction) {
    return { kind: "none" };
  }

  if (options.isInputEmpty && options.pendingInputCount > 0) {
    return { kind: "pop-pending-input" };
  }

  if (!options.isInputEmpty) {
    return { kind: "none" };
  }

  return options.timeSinceLastEscapeMs < options.doubleEscapeIntervalMs
    ? { kind: "interrupt" }
    : { kind: "arm-double-escape" };
}
