import { describe, expect, it, vi } from "vitest";

import { scheduleRenderFromNode, type RenderableNode } from "./scroll-render-trigger.js";

// FEATURE_214 (v0.7.46) — the React-bypass render trigger. Faithfully unit-
// testable (unlike the full scroll paint, which ink-testing-library can't
// reproduce): build a node→root chain and assert the root's onRender fires.

function chain(depth: number, rootOnRender?: () => void): RenderableNode {
  const root: RenderableNode = { onRender: rootOnRender };
  let node = root;
  for (let i = 0; i < depth; i++) {
    node = { parentNode: node };
  }
  return node; // the leaf
}

describe("scheduleRenderFromNode (FEATURE_214)", () => {
  it("walks to the root and invokes its onRender", () => {
    const onRender = vi.fn();
    const leaf = chain(3, onRender);
    expect(scheduleRenderFromNode(leaf)).toBe(true);
    expect(onRender).toHaveBeenCalledTimes(1);
  });

  it("invokes the ROOT's onRender, not an intermediate node's", () => {
    const rootRender = vi.fn();
    const midRender = vi.fn();
    const root: RenderableNode = { onRender: rootRender };
    const mid: RenderableNode = { parentNode: root, onRender: midRender };
    const leaf: RenderableNode = { parentNode: mid };
    scheduleRenderFromNode(leaf);
    expect(rootRender).toHaveBeenCalledTimes(1);
    expect(midRender).not.toHaveBeenCalled();
  });

  it("returns false (no-op) when the root has no onRender (teardown / non-engine host)", () => {
    const leaf = chain(2, undefined);
    expect(scheduleRenderFromNode(leaf)).toBe(false);
  });

  it("returns false for a null/undefined node", () => {
    expect(scheduleRenderFromNode(null)).toBe(false);
    expect(scheduleRenderFromNode(undefined)).toBe(false);
  });

  it("handles a node that is itself the root", () => {
    const onRender = vi.fn();
    expect(scheduleRenderFromNode({ onRender })).toBe(true);
    expect(onRender).toHaveBeenCalledTimes(1);
  });
});
