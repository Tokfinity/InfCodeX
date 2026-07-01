import { describe, expect, it } from "vitest";
import type { KodaXSessionUiHistoryItem } from "@kodax-ai/agent";
import {
  restoreHistoryItemsFromSession,
  trimPersistedUiHistorySnapshot,
} from "./restore-history.js";

// Minimal sidecar persisted items — icon slot carries encoded verdict/delivery.
function persistedSidecar(
  text: string,
  icon: string,
): Exclude<KodaXSessionUiHistoryItem, { type: "tool_group" }> {
  return { type: "sidecar", text, icon };
}

describe("restore-history / sidecar items", () => {
  it("restores a 'revise' sidecar item with verdict=revise", () => {
    const result = restoreHistoryItemsFromSession({
      messages: [],
      uiHistory: [persistedSidecar("Please add error handling.", "revise")],
    });
    expect(result).toHaveLength(1);
    const item = result[0];
    expect(item?.type).toBe("sidecar");
    if (item?.type !== "sidecar") throw new Error("expected sidecar");
    expect(item.verdict).toBe("revise");
    expect(item.text).toBe("Please add error handling.");
    expect(item.delivery).toBeUndefined();
  });

  it("restores a 'blocked' sidecar item with verdict=blocked", () => {
    const result = restoreHistoryItemsFromSession({
      messages: [],
      uiHistory: [persistedSidecar("Output was unsafe.", "blocked")],
    });
    expect(result).toHaveLength(1);
    const item = result[0];
    expect(item?.type).toBe("sidecar");
    if (item?.type !== "sidecar") throw new Error("expected sidecar");
    expect(item.verdict).toBe("blocked");
    expect(item.delivery).toBeUndefined();
  });

  it("restores a budget-exhausted sidecar item with delivery=budget-exhausted", () => {
    const result = restoreHistoryItemsFromSession({
      messages: [],
      uiHistory: [persistedSidecar("Verifier ran out of budget.", "budget-exhausted")],
    });
    expect(result).toHaveLength(1);
    const item = result[0];
    expect(item?.type).toBe("sidecar");
    if (item?.type !== "sidecar") throw new Error("expected sidecar");
    expect(item.delivery).toBe("budget-exhausted");
    expect(item.verdict).toBeUndefined();
  });

  it("treats unknown icon values as revise (safe default)", () => {
    // Unrecognized icon value → falls back to revise verdict.
    const result = restoreHistoryItemsFromSession({
      messages: [],
      uiHistory: [persistedSidecar("Some text.", "unknown-value")],
    });
    const item = result[0];
    expect(item?.type).toBe("sidecar");
    if (item?.type !== "sidecar") throw new Error("expected sidecar");
    expect(item.verdict).toBe("revise");
  });

  it("preserves sidecar items alongside other history item types after restore", () => {
    const uiHistory: KodaXSessionUiHistoryItem[] = [
      { type: "user", text: "hello" },
      { type: "assistant", text: "hi" },
      persistedSidecar("Please fix the output.", "revise"),
    ];
    const result = restoreHistoryItemsFromSession({ messages: [], uiHistory });
    const types = result.map((item) => item.type);
    expect(types).toContain("sidecar");
    expect(types).toContain("user");
    expect(types).toContain("assistant");
  });
});

describe("trimPersistedUiHistorySnapshot / sidecar items are retained in trim window", () => {
  it("retains sidecar items within the normal item count window", () => {
    const items: KodaXSessionUiHistoryItem[] = [
      { type: "user", text: "q" },
      persistedSidecar("feedback text", "revise"),
      { type: "assistant", text: "a" },
    ];
    const trimmed = trimPersistedUiHistorySnapshot(items);
    expect(trimmed.some((item) => item.type === "sidecar")).toBe(true);
  });
});
