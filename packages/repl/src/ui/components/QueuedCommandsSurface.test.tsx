import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { QueuedCommandsSurface } from "./QueuedCommandsSurface.js";

describe("QueuedCommandsSurface", () => {
  it("renders one line per queued input with [i/N] prefix and edit hint", () => {
    // FEATURE_149 Phase 2.2 (v0.7.38) — multi-line render replaces the prior
    // single summary line. Each entry is shown individually so the user can
    // see the order they will execute in.
    const { lastFrame } = render(
      <QueuedCommandsSurface pendingInputs={["check tests too", "verify docs"]} />,
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("[1/2] check tests too");
    expect(frame).toContain("[2/2] verify docs");
    expect(frame).toContain("↑ pull all into editor");
    expect(frame).toContain("Esc drops latest");
  });

  it("renders nothing when there are no queued prompts", () => {
    const { lastFrame } = render(
      <QueuedCommandsSurface pendingInputs={[]} />,
    );

    expect(lastFrame()).toBe("");
  });
});
