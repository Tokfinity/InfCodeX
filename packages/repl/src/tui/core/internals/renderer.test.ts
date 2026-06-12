import { describe, it, expect } from "vitest";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- vendored .js file with no .d.ts
import renderer from "./renderer.js";

/**
 * Engine-side mirror of `substrate/ink/renderer.test.ts`. Both renderers
 * import the same `outputToScreen` from `substrate/ink/`; structural parity
 * is verified across both files. Phase 6 (v0.7.30): cell renderer is the
 * sole render path on both mirrors.
 */
function fakeYogaNode({
  width,
  height,
  left = 0,
  top = 0,
}: {
  width: number;
  height: number;
  left?: number;
  top?: number;
}): object {
  return {
    getComputedWidth: () => width,
    getComputedHeight: () => height,
    getDisplay: () => 0, // DISPLAY_FLEX
    getComputedLeft: () => left,
    getComputedTop: () => top,
    getComputedBorder: () => 0,
    getComputedPadding: () => 0,
  };
}

function fakeTextNode(value: string, top: number): object {
  return {
    yogaNode: fakeYogaNode({ width: 10, height: 1, top }),
    nodeName: "ink-text",
    childNodes: [{ nodeName: "#text", nodeValue: value }],
    style: {},
    internal_static: false,
    internal_accessibility: undefined,
    internal_transform: undefined,
    attributes: {},
  };
}

function fakeRootNode(width: number, height: number, childNodes: object[] = []): object {
  return {
    yogaNode: fakeYogaNode({ width, height }),
    nodeName: "ink-root",
    childNodes,
    style: { flexDirection: "column" },
    staticNode: undefined,
    internal_static: false,
    internal_accessibility: undefined,
    internal_transform: undefined,
    attributes: {},
  };
}

describe("core/internals/renderer (FEATURE_057 Track F, Phase 6: cell renderer is sole render path — engine-side mirror)", () => {
  describe("non-screen-reader path: frame populated unconditionally", () => {
    it("empty 5x1 root: frame has the right dimensions, cursor rests at content bottom (hidden: no input cursor anchor)", () => {
      const node = fakeRootNode(5, 1);
      const result = renderer(node, false);
      expect(result.frame).toBeDefined();
      const frame = result.frame!;
      expect(frame.screen.width).toBe(5);
      expect(frame.screen.height).toBe(1);
      // FEATURE_214: with no `internal_cursorAnchor` in the tree, the cursor parks
      // at content bottom and is hidden (visible:false). The engine only shows the
      // OS cursor when the input marks a cursor cell (frame.cursor.visible === true).
      expect(frame.cursor).toEqual({ x: 0, y: 1, visible: false });
    });

    it("viewport defaults to yoga-computed content size when terminalSize not supplied", () => {
      const node = fakeRootNode(10, 4);
      const result = renderer(node, false);
      expect(result.frame!.viewport).toEqual({ width: 10, height: 4 });
    });

    it("terminalSize override: frame.viewport tracks terminal dims, not content dims", () => {
      const node = fakeRootNode(3, 1);
      const result = renderer(node, false, { rows: 24, columns: 80 });
      expect(result.frame!.screen.width).toBe(3);
      expect(result.frame!.screen.height).toBe(1);
      expect(result.frame!.viewport).toEqual({ width: 80, height: 24 });
    });

    it("renders a node with no yogaNode → empty fallback shape (frame undefined regardless of context)", () => {
      const result = renderer({ yogaNode: undefined } as unknown as object, false);
      expect(result).toEqual({
        output: "",
        outputHeight: 0,
        staticOutput: "",
        frame: undefined,
      });
    });
  });

  describe("screen-reader path: returns frame undefined", () => {
    it("screen-reader path skips Frame production", () => {
      const node = fakeRootNode(3, 1);
      const result = renderer(node, true);
      expect(result.frame).toBeUndefined();
    });
  });

  describe("legacy fields populated regardless of cell renderer", () => {
    it("output / outputHeight / staticOutput populated alongside frame", () => {
      const node = fakeRootNode(3, 1);
      const result = renderer(node, false);
      expect(result.output).toBe("");
      expect(result.outputHeight).toBe(1);
      expect(result.staticOutput).toBe("");
    });
  });

  describe("scroll containers", () => {
    it("clips to the applied scroll window and carries the scroll hint", () => {
      const content = {
        yogaNode: fakeYogaNode({ width: 10, height: 2 }),
        nodeName: "ink-box",
        childNodes: [fakeTextNode("OLD", 0), fakeTextNode("NEW", 1)],
        style: { flexDirection: "column" },
        internal_static: false,
        internal_accessibility: undefined,
        internal_transform: undefined,
        attributes: {},
      };
      const scrollBox = {
        yogaNode: fakeYogaNode({ width: 10, height: 1 }),
        nodeName: "ink-box",
        childNodes: [content],
        style: {
          flexDirection: "column",
          overflowY: "scroll",
        },
        internal_static: false,
        internal_accessibility: undefined,
        internal_transform: undefined,
        attributes: {
          scrollTop: 1,
          scrollHeight: 2,
          virtualScrollWindowed: false,
        },
        appliedScrollTop: 0,
      };
      const node = fakeRootNode(10, 1, [scrollBox]);

      const result = renderer(node, false, { rows: 1, columns: 10 });

      expect(result.output).toBe("NEW");
      expect(result.output).not.toContain("OLD");
      expect(result.frame!.scrollHint).toEqual({ top: 0, bottom: 0, delta: 1 });
    });
  });
});
