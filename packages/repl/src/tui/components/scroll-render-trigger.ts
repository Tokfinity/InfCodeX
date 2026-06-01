/**
 * React-bypass render trigger (FEATURE_214, v0.7.46).
 *
 * The transcript-scroll fast path mutates a scroll node's fields directly (e.g.
 * `inWindowScrollTop`) and needs the renderer to repaint the EXISTING node tree
 * WITHOUT going through React's reconciler — that reconcile is the ~60ms/frame
 * cost FEATURE_214 removes. Walking from the mutated node to the root and
 * calling the root's `onRender` (the engine's throttled render entry, set in
 * `engine.js`) repaints via `render-node-to-output` reading the mutated node,
 * with zero React commit. Mirrors claudecode's `dom.ts:scheduleRenderFrom`.
 *
 * Pure of any KodaX state; operates only on the ink DOM node chain. Returns
 * `true` when a root render entry was found and invoked, `false` otherwise (so
 * callers can fall back to a React-driven update).
 */

/** Minimal shape of an ink DOM node this primitive walks. */
export interface RenderableNode {
  readonly parentNode?: RenderableNode;
  /** Set on the ROOT node by the engine — the throttled render entry. */
  onRender?: () => void;
}

/**
 * Repaint the existing node tree from `node` by invoking the root's `onRender`,
 * bypassing React. No-op + `false` when `node` is missing or no root render
 * entry exists (e.g. during teardown or in a non-engine host).
 */
export function scheduleRenderFromNode(node: RenderableNode | null | undefined): boolean {
  let cursor: RenderableNode | undefined = node ?? undefined;
  // Walk to the topmost node (the root the engine attached `onRender` to).
  while (cursor?.parentNode) {
    cursor = cursor.parentNode;
  }
  if (cursor && typeof cursor.onRender === "function") {
    cursor.onRender();
    return true;
  }
  return false;
}
