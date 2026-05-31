import { describe, expect, it } from "vitest";

import { trimHistoryToRounds } from "./UIStateContext.js";
import type { HistoryItem } from "../types.js";

// FEATURE_212 (v0.7.45) — the trim helper is shared by the single-add and
// bulk-add (resume) reducer paths, so they trim identically. These guard the
// extraction: under the cap it is a no-op; over the cap it cuts at a "user"
// round boundary keeping the most recent ~50 rounds.

function item(i: number, type: HistoryItem["type"]): HistoryItem {
  return { id: String(i), type, text: "x", timestamp: 0 } as HistoryItem;
}

describe("trimHistoryToRounds (FEATURE_212)", () => {
  it("returns the same array (no-op) when under the 150-item cap", () => {
    const history = Array.from({ length: 100 }, (_, i) => item(i, i % 2 === 0 ? "user" : "assistant"));
    expect(trimHistoryToRounds(history)).toBe(history);
  });

  it("does NOT trim over-cap history with <=50 user rounds (existing behavior)", () => {
    // 200 items, a user every 4 → only 50 users → cutIndex stays 0 → untrimmed.
    const history = Array.from({ length: 200 }, (_, i) => item(i, i % 4 === 0 ? "user" : "assistant"));
    expect(trimHistoryToRounds(history)).toBe(history);
  });

  it("cuts at a user boundary keeping the most recent ~50 rounds when over cap", () => {
    // 220 items, user every 2 → 110 users. The 51st user from the end is at
    // index 118, so the result is history.slice(118): 102 items starting "user".
    const history = Array.from({ length: 220 }, (_, i) => item(i, i % 2 === 0 ? "user" : "assistant"));
    const trimmed = trimHistoryToRounds(history);
    expect(trimmed.length).toBe(102);
    expect(trimmed[0]!.type).toBe("user");
    expect(trimmed[0]!.id).toBe("118");
    expect(trimmed[trimmed.length - 1]!.id).toBe("219");
  });
});
