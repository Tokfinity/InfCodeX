import React, { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { Box, Text } from "../../ui/tui.js";
import { ScrollBox, type ScrollBoxHandle } from "./ScrollBox.js";

const ScrollBoxHarness = React.forwardRef<ScrollBoxHandle>((_, ref) => {
  const [scrollTop, setScrollTop] = useState(0);
  const [sticky, setSticky] = useState(true);

  return (
    <ScrollBox
      scrollRef={ref}
      scrollTop={scrollTop}
      scrollHeight={120}
      viewportHeight={20}
      stickyScroll={sticky}
      onScrollTopChange={setScrollTop}
      onStickyChange={setSticky}
    >
      <Text>Transcript</Text>
    </ScrollBox>
  );
});

ScrollBoxHarness.displayName = "ScrollBoxHarness";

describe("ScrollBox", () => {
  it("updates scroll offset through the imperative handle", () => {
    const ref = React.createRef<ScrollBoxHandle>();
    render(<ScrollBoxHarness ref={ref} />);

    ref.current?.scrollBy(8);
    expect(ref.current?.getScrollTop()).toBe(8);
    expect(ref.current?.isSticky()).toBe(false);

    ref.current?.scrollToBottom();
    expect(ref.current?.getScrollTop()).toBe(0);
    expect(ref.current?.isSticky()).toBe(true);
  });

  it("notifies subscribers when scroll state changes", () => {
    const ref = React.createRef<ScrollBoxHandle>();
    render(<ScrollBoxHarness ref={ref} />);
    const listener = vi.fn();
    const unsubscribe = ref.current?.subscribe(listener);

    ref.current?.scrollTo(12);
    ref.current?.scrollBy(2);

    expect(listener).toHaveBeenCalled();
    unsubscribe?.();
  });

  it("computes the visible window inside the renderer boundary", () => {
    const { lastFrame } = render(
      <ScrollBox
        scrollTop={10}
        scrollHeight={120}
        viewportHeight={20}
        renderWindow={(window) => (
          <Text>{`window:${window.start}-${window.end}`}</Text>
        )}
      >
        <Text>ignored</Text>
      </ScrollBox>,
    );

    expect(lastFrame()).toContain("window:90-110");
  });

  it("preserves the full logical scroll height for renderer-owned windows", async () => {
    const ref = React.createRef<ScrollBoxHandle>();
    render(
      <ScrollBox
        scrollRef={ref}
        scrollTop={10}
        scrollHeight={120}
        viewportHeight={20}
        renderWindow={() => <Text>Visible row only</Text>}
      >
        <Text>ignored</Text>
      </ScrollBox>,
    );

    await vi.waitFor(() => {
      expect(ref.current?.getScrollHeight()).toBe(120);
      expect(ref.current?.getViewportTop()).toBe(90);
    });
  });

  it("notifies sticky changes when the controlled sticky flag flips", async () => {
    const onStickyChange = vi.fn();

    const StickyHarness: React.FC = () => {
      const [sticky, setSticky] = useState(true);

      React.useEffect(() => {
        setSticky(false);
      }, []);

      return (
        <ScrollBox
          scrollTop={0}
          scrollHeight={120}
          viewportHeight={20}
          stickyScroll={sticky}
          onStickyChange={onStickyChange}
        >
          <Text>Transcript</Text>
        </ScrollBox>
      );
    };

    render(<StickyHarness />);

    await vi.waitFor(() => {
      expect(onStickyChange).toHaveBeenCalledWith(false);
    });
  });

  it("applies clamp bounds to the rendered window immediately", async () => {
    const ref = React.createRef<ScrollBoxHandle>();
    const { lastFrame } = render(
      <ScrollBox
        scrollRef={ref}
        scrollTop={10}
        scrollHeight={120}
        viewportHeight={20}
        renderWindow={(window) => (
          <Text>{`window:${window.start}-${window.end}`}</Text>
        )}
      >
        <Text>ignored</Text>
      </ScrollBox>,
    );

    expect(lastFrame()).toContain("window:90-110");

    ref.current?.setClampBounds(undefined, 5);
    await vi.waitFor(() => {
      expect(lastFrame()).toContain("window:95-115");
    });
  });

  it("keeps a footer sibling tight when the fullscreen host provides explicit growth", () => {
    const { lastFrame } = render(
      <Box flexDirection="column">
        <ScrollBox
          flexGrow={1}
          scrollTop={0}
          scrollHeight={2}
          viewportHeight={2}
          renderWindow={() => (
            <>
              <Text>Row 1</Text>
              <Text>Row 2</Text>
            </>
          )}
        >
          <Text>ignored</Text>
        </ScrollBox>
        <Text>FOOTER</Text>
      </Box>,
    );

    const frame = lastFrame() ?? "";
    const lines = frame.split("\n");
    const rowIndex = lines.findIndex((line) => line.includes("Row 2"));
    const footerIndex = lines.findIndex((line) => line.includes("FOOTER"));

    expect(rowIndex).toBeGreaterThanOrEqual(0);
    expect(footerIndex).toBeGreaterThanOrEqual(rowIndex + 1);
    expect(footerIndex).toBeLessThanOrEqual(rowIndex + 2);
  });

  // FEATURE_214 (v0.7.46) — scroll→window contract the React-bypass refactor
  // (Phase A.3/B: imperative scrollBy + SCROLL_QUANTUM-quantized React commit)
  // MUST preserve. The refactor changes HOW OFTEN renderWindow is called, never
  // the FINAL window for a given resting scroll position. These pin that
  // invariant: same logical scrollTop ⇒ same {start, end, scrollTop}, and a
  // coalesced multi-step scroll lands identically to one direct scroll.
  describe("FEATURE_214 scroll→window contract", () => {
    function renderWindowed() {
      const ref = React.createRef<ScrollBoxHandle>();
      const utils = render(
        <ScrollBox
          scrollRef={ref}
          scrollTop={0}
          scrollHeight={120}
          viewportHeight={20}
          renderWindow={(w) => <Text>{`w:${w.start}-${w.end}@${w.scrollTop}`}</Text>}
        >
          <Text>ignored</Text>
        </ScrollBox>,
      );
      return { ref, ...utils };
    }

    it("maps a scroll position to a deterministic window", async () => {
      const { ref, lastFrame } = renderWindowed();
      ref.current?.scrollTo(30);
      expect(ref.current?.getScrollTop()).toBe(30); // snapshot is synchronous
      await vi.waitFor(() => expect(lastFrame()).toContain("w:70-90@30"));
    });

    it("clamps at the oldest content (cannot over-scroll up)", async () => {
      const { ref, lastFrame } = renderWindowed();
      ref.current?.scrollTo(1000); // past max = scrollHeight - viewportHeight = 100
      expect(ref.current?.getScrollTop()).toBe(100);
      await vi.waitFor(() => expect(lastFrame()).toContain("w:0-20@100"));
    });

    it("scrollToBottom re-sticks to the latest window", async () => {
      const { ref, lastFrame } = renderWindowed();
      ref.current?.scrollTo(40);
      ref.current?.scrollToBottom();
      expect(ref.current?.getScrollTop()).toBe(0);
      expect(ref.current?.isSticky()).toBe(true);
      await vi.waitFor(() => expect(lastFrame()).toContain("w:100-120@0"));
    });

    it("coalescing-invariant: stepped scrollBy lands at the same window as one scrollTo", async () => {
      const stepped = renderWindowed();
      stepped.ref.current?.scrollBy(10);
      stepped.ref.current?.scrollBy(10);
      stepped.ref.current?.scrollBy(5);

      const direct = renderWindowed();
      direct.ref.current?.scrollTo(25);

      expect(stepped.ref.current?.getScrollTop()).toBe(direct.ref.current?.getScrollTop());
      await vi.waitFor(() => expect(stepped.lastFrame()).toContain("w:75-95@25"));
      await vi.waitFor(() => expect(direct.lastFrame()).toContain("w:75-95@25"));
    });
  });
});
