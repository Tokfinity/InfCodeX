import { describe, expect, it, vi } from "vitest";

import type { CreatableHistoryItem } from "../types.js";
import { createHistoryItem } from "./UIStateContext.js";

describe("createHistoryItem timestamps", () => {
  it("keeps an event timestamp instead of replacing it at batch commit time", () => {
    const first = createHistoryItem({
      type: "assistant",
      text: "first",
      timestamp: 1_000,
    } as CreatableHistoryItem);
    const second = createHistoryItem({
      type: "assistant",
      text: "second",
      timestamp: 2_000,
    } as CreatableHistoryItem);

    expect([first.timestamp, second.timestamp]).toEqual([1_000, 2_000]);
  });

  it("stamps newly created items when no event time is supplied", () => {
    vi.spyOn(Date, "now").mockReturnValue(3_000);
    expect(createHistoryItem({ type: "assistant", text: "new" }).timestamp).toBe(3_000);
    vi.restoreAllMocks();
  });
});
