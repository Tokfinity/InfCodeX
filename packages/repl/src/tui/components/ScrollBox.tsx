import React, {
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useCallback,
  useState,
} from "react";
// FEATURE_093 (v0.7.24): import Box directly from renderer-runtime to
// avoid the `tui/index.ts ↔ components/ScrollBox.tsx` barrel cycle.
import { Box } from "../renderer-runtime.js";
import { computeOverscanWindow } from "../../ui/utils/overscan-window.js";

export interface ScrollBoxHandle {
  scrollTo: (y: number) => void;
  scrollBy: (dy: number) => void;
  scrollToElement: (y: number, offset?: number) => void;
  scrollToBottom: () => void;
  getScrollTop: () => number;
  getPendingDelta: () => number;
  getScrollHeight: () => number;
  getViewportHeight: () => number;
  getViewportTop: () => number;
  isSticky: () => boolean;
  subscribe: (listener: () => void) => () => void;
  setClampBounds: (min: number | undefined, max: number | undefined) => void;
}

export interface ScrollBoxWindow {
  start: number;
  end: number;
  scrollTop: number;
  scrollHeight: number;
  viewportHeight: number;
  viewportTop: number;
  pendingDelta: number;
  sticky: boolean;
  /**
   * FEATURE_214 (v0.7.46) — when overscan is active, [start, end) is the larger
   * OVERSCAN BLOCK and this is how far down within it the viewport sits (feeds
   * the renderer's `inWindowScrollTop` so the block translates without React).
   * 0 when overscan is off (the window == the viewport).
   */
  inWindowScrollTop: number;
}

export interface ScrollBoxProps {
  children: React.ReactNode;
  width?: number | string;
  flexGrow?: number;
  flexShrink?: number;
  paddingTop?: number;
  scrollTop?: number;
  scrollHeight?: number;
  viewportHeight?: number;
  stickyScroll?: boolean;
  scrollRef?: React.Ref<ScrollBoxHandle>;
  onScrollTopChange?: (nextScrollTop: number) => void;
  onStickyChange?: (sticky: boolean) => void;
  onWindowChange?: (window: ScrollBoxWindow) => void;
  renderWindow?: (window: ScrollBoxWindow) => React.ReactNode;
  /**
   * FEATURE_214 (v0.7.46) — rows of overscan margin to render above+below the
   * viewport. When > 0 (and `renderWindow` is provided) the box renders an
   * overscan block and exposes the in-block offset for React-bypass scrolling.
   * Undefined/0 = the pre-FEATURE_214 behaviour (window == viewport).
   */
  overscanRows?: number;
}

interface ScrollSnapshot {
  scrollTop: number;
  scrollHeight: number;
  viewportHeight: number;
  pendingDelta: number;
  clampMin?: number;
  clampMax?: number;
  sticky: boolean;
  /** FEATURE_214: rows of overscan margin (0/undefined = no overscan). */
  overscanRows?: number;
}

function normalizeScrollSnapshot(snapshot: ScrollSnapshot): ScrollSnapshot {
  const normalized: ScrollSnapshot = {
    ...snapshot,
    scrollHeight: Math.max(0, Math.floor(snapshot.scrollHeight)),
    viewportHeight: Math.max(0, Math.floor(snapshot.viewportHeight)),
    pendingDelta: Math.floor(snapshot.pendingDelta),
  };

  return {
    ...normalized,
    scrollTop: clampScrollTop(normalized, normalized.scrollTop),
  };
}

function areSnapshotsEqual(left: ScrollSnapshot, right: ScrollSnapshot): boolean {
  return left.scrollTop === right.scrollTop
    && left.scrollHeight === right.scrollHeight
    && left.viewportHeight === right.viewportHeight
    && left.pendingDelta === right.pendingDelta
    && left.clampMin === right.clampMin
    && left.clampMax === right.clampMax
    && left.sticky === right.sticky
    && left.overscanRows === right.overscanRows;
}

function areWindowsEqual(left: ScrollBoxWindow, right: ScrollBoxWindow): boolean {
  return left.start === right.start
    && left.end === right.end
    && left.scrollTop === right.scrollTop
    && left.scrollHeight === right.scrollHeight
    && left.viewportHeight === right.viewportHeight
    && left.viewportTop === right.viewportTop
    && left.pendingDelta === right.pendingDelta
    && left.sticky === right.sticky
    && left.inWindowScrollTop === right.inWindowScrollTop;
}

function clampScrollTop(snapshot: ScrollSnapshot, nextScrollTop: number): number {
  const viewportMax = Math.max(0, snapshot.scrollHeight - snapshot.viewportHeight);
  const clampMin = snapshot.clampMin ?? 0;
  const clampMax = snapshot.clampMax ?? viewportMax;
  return Math.max(clampMin, Math.min(Math.floor(nextScrollTop), Math.min(viewportMax, clampMax)));
}

function resolveScrollWindow(snapshot: ScrollSnapshot): ScrollBoxWindow {
  const viewportHeight = Math.max(0, snapshot.viewportHeight);
  const clampedOffset = clampScrollTop(snapshot, snapshot.scrollTop);
  const end = Math.max(0, snapshot.scrollHeight - clampedOffset);
  const start = Math.max(0, end - viewportHeight);

  const overscanRows = Math.max(0, Math.floor(snapshot.overscanRows ?? 0));
  if (overscanRows > 0 && viewportHeight > 0) {
    // FEATURE_214 (v0.7.46) — render an OVERSCAN BLOCK around the viewport and
    // translate within it (`inWindowScrollTop`) so a scroll within the block
    // can repaint via the renderer without a React re-window. `start..end` is
    // now the block; `viewportTop` stays the REAL viewport top (rows-from-top)
    // so hit-testing/selection are unaffected.
    const block = computeOverscanWindow({
      globalScrollTop: start,
      viewportHeight,
      contentHeight: snapshot.scrollHeight,
      overscan: overscanRows,
    });
    return {
      start: block.blockTop,
      end: block.blockTop + block.blockHeight,
      scrollTop: clampedOffset,
      scrollHeight: snapshot.scrollHeight,
      viewportHeight,
      viewportTop: start,
      pendingDelta: snapshot.pendingDelta,
      sticky: snapshot.sticky,
      inWindowScrollTop: block.inBlockOffset,
    };
  }

  return {
    start,
    end,
    scrollTop: clampedOffset,
    scrollHeight: snapshot.scrollHeight,
    viewportHeight,
    viewportTop: start,
    pendingDelta: snapshot.pendingDelta,
    sticky: snapshot.sticky,
    inWindowScrollTop: 0,
  };
}

function resolveNativeScrollTop(snapshot: ScrollSnapshot): number {
  const clampedOffset = clampScrollTop(snapshot, snapshot.scrollTop);
  return Math.max(0, snapshot.scrollHeight - snapshot.viewportHeight - clampedOffset);
}

export const ScrollBox: React.FC<ScrollBoxProps> = ({
  children,
  width,
  flexGrow = 0,
  flexShrink = 1,
  paddingTop = 0,
  scrollTop = 0,
  scrollHeight = 0,
  viewportHeight = 0,
  stickyScroll = true,
  scrollRef,
  onScrollTopChange,
  onStickyChange,
  onWindowChange,
  renderWindow,
  overscanRows,
}) => {
  const domRef = useRef<any>(null);
  const listenersRef = useRef(new Set<() => void>());
  const snapshotRef = useRef<ScrollSnapshot>(normalizeScrollSnapshot({
    scrollTop,
    scrollHeight,
    viewportHeight,
    pendingDelta: 0,
    sticky: stickyScroll,
    overscanRows,
  }));
  const [windowState, setWindowState] = useState<ScrollBoxWindow>(
    () => resolveScrollWindow(snapshotRef.current),
  );

  const notify = useCallback(() => {
    for (const listener of listenersRef.current) {
      listener();
    }
  }, []);

  const commitSnapshot = useCallback((
    nextSnapshot: ScrollSnapshot,
    notifyListeners = true,
  ) => {
    const previous = snapshotRef.current;
    const normalized = normalizeScrollSnapshot(nextSnapshot);
    const nextWindow = resolveScrollWindow(normalized);

    snapshotRef.current = normalized;
    setWindowState((previousWindow) => (
      areWindowsEqual(previousWindow, nextWindow)
        ? previousWindow
        : nextWindow
    ));

    if (notifyListeners && !areSnapshotsEqual(previous, normalized)) {
      notify();
    }

    return {
      previous,
      snapshot: normalized,
      window: nextWindow,
      changed: !areSnapshotsEqual(previous, normalized),
    };
  }, [notify]);

  useEffect(() => {
    const previous = snapshotRef.current;
    const next: ScrollSnapshot = {
      scrollTop,
      scrollHeight,
      viewportHeight,
      pendingDelta: 0,
      clampMin: previous.clampMin,
      clampMax: previous.clampMax,
      sticky: stickyScroll,
      overscanRows,
    };

    const result = commitSnapshot(next);
    if (result.previous.sticky !== stickyScroll) {
      onStickyChange?.(stickyScroll);
    }
    if (result.window.scrollTop !== scrollTop) {
      onScrollTopChange?.(result.window.scrollTop);
    }
  }, [
    commitSnapshot,
    onStickyChange,
    onScrollTopChange,
    overscanRows,
    scrollHeight,
    scrollTop,
    stickyScroll,
    viewportHeight,
  ]);

  const syncSnapshotFromDom = useCallback(() => {
    const host = domRef.current;
    if (!host) {
      return;
    }

    const nextScrollHeight = typeof host.scrollHeight === "number"
      ? Math.max(0, Math.floor(host.scrollHeight))
      : undefined;
    const nextViewportHeight = typeof host.scrollViewportHeight === "number"
      ? Math.max(0, Math.floor(host.scrollViewportHeight))
      : undefined;
    const nextViewportTop = typeof host.scrollViewportTop === "number"
      ? Math.max(0, Math.floor(host.scrollViewportTop))
      : undefined;

    if (
      nextScrollHeight === undefined
      || nextViewportHeight === undefined
      || nextViewportTop === undefined
    ) {
      return;
    }

    const derivedScrollTop = Math.max(
      0,
      nextScrollHeight - nextViewportHeight - nextViewportTop,
    );

    const result = commitSnapshot({
      ...snapshotRef.current,
      scrollTop: derivedScrollTop,
      scrollHeight: nextScrollHeight,
      viewportHeight: nextViewportHeight,
    });

    if (result.changed && result.window.scrollTop !== result.previous.scrollTop) {
      onScrollTopChange?.(result.window.scrollTop);
    }
  }, [commitSnapshot, onScrollTopChange]);

  useEffect(() => {
    syncSnapshotFromDom();
  }, [syncSnapshotFromDom]);

  const handle = useMemo<ScrollBoxHandle>(() => ({
    scrollTo(y: number) {
      const result = commitSnapshot({
        ...snapshotRef.current,
        scrollTop: y,
        pendingDelta: 0,
        sticky: false,
      });
      if (result.previous.sticky !== false) {
        onStickyChange?.(false);
      }
      onScrollTopChange?.(result.window.scrollTop);
    },
    scrollBy(dy: number) {
      const result = commitSnapshot({
        ...snapshotRef.current,
        scrollTop: snapshotRef.current.scrollTop + dy,
        pendingDelta: snapshotRef.current.pendingDelta + Math.floor(dy),
        sticky: false,
      });
      if (result.previous.sticky !== false) {
        onStickyChange?.(false);
      }
      onScrollTopChange?.(result.window.scrollTop);
    },
    scrollToElement(y: number, offset = 0) {
      const result = commitSnapshot({
        ...snapshotRef.current,
        scrollTop: y - offset,
        pendingDelta: 0,
        sticky: false,
      });
      if (result.previous.sticky !== false) {
        onStickyChange?.(false);
      }
      onScrollTopChange?.(result.window.scrollTop);
    },
    scrollToBottom() {
      const result = commitSnapshot({
        ...snapshotRef.current,
        scrollTop: 0,
        pendingDelta: 0,
        sticky: true,
      });
      onScrollTopChange?.(result.window.scrollTop);
      if (result.previous.sticky !== true) {
        onStickyChange?.(true);
      }
    },
    getScrollTop() {
      return snapshotRef.current.scrollTop;
    },
    getPendingDelta() {
      return snapshotRef.current.pendingDelta;
    },
    getScrollHeight() {
      return domRef.current?.scrollHeight ?? snapshotRef.current.scrollHeight;
    },
    getViewportHeight() {
      return domRef.current?.scrollViewportHeight ?? windowState.viewportHeight;
    },
    getViewportTop() {
      return domRef.current?.scrollViewportTop ?? windowState.viewportTop;
    },
    isSticky() {
      return snapshotRef.current.sticky;
    },
    subscribe(listener: () => void) {
      listenersRef.current.add(listener);
      return () => {
        listenersRef.current.delete(listener);
      };
    },
    setClampBounds(min: number | undefined, max: number | undefined) {
      const result = commitSnapshot({
        ...snapshotRef.current,
        clampMin: min,
        clampMax: max,
      });
      if (result.window.scrollTop !== result.previous.scrollTop) {
        onScrollTopChange?.(result.window.scrollTop);
      }
    },
  }), [commitSnapshot, onScrollTopChange, onStickyChange]);

  useImperativeHandle(scrollRef, () => handle, [handle]);

  useEffect(() => {
    onWindowChange?.(windowState);
  }, [onWindowChange, windowState]);

  const content = renderWindow ? renderWindow(windowState) : children;

  const totalViewportHeight = Math.max(0, viewportHeight + paddingTop);
  const nativeScrollTop = resolveNativeScrollTop(snapshotRef.current);
  return React.createElement(
    "ink-box",
    {
      ref: domRef,
      style: {
        flexWrap: "nowrap",
        flexDirection: "row",
        flexGrow,
        flexShrink,
        width,
        height: totalViewportHeight,
        paddingTop,
        overflowX: "visible",
        overflowY: "scroll",
      },
      scrollTop: nativeScrollTop,
      scrollHeight: snapshotRef.current.scrollHeight,
      scrollViewportHeight: snapshotRef.current.viewportHeight,
      scrollViewportTop: windowState.viewportTop,
      pendingScrollDelta: snapshotRef.current.pendingDelta,
      virtualScrollWindowed: Boolean(renderWindow),
      // FEATURE_214: only emit inWindowScrollTop in overscan mode. Setting it
      // (even 0) flips the renderer onto the overscan path, so gating on
      // `overscanRows` keeps the pre-FEATURE_214 windowed path (incl. the
      // FEATURE_212 streaming-shift DECSTBM) byte-identical when overscan is off.
      ...(snapshotRef.current.overscanRows ? { inWindowScrollTop: windowState.inWindowScrollTop } : {}),
      ...(snapshotRef.current.clampMin !== undefined ? { scrollClampMin: snapshotRef.current.clampMin } : {}),
      ...(snapshotRef.current.clampMax !== undefined ? { scrollClampMax: snapshotRef.current.clampMax } : {}),
      ...(stickyScroll ? { stickyScroll: true } : {}),
    },
    <Box
      flexDirection="column"
      flexGrow={1}
      flexShrink={0}
      width="100%"
    >
      {content}
    </Box>,
  );
};
