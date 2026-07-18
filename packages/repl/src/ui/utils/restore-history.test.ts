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

describe("restore-history / timestamps", () => {
  it("preserves timestamps already stored in uiHistory", () => {
    const result = restoreHistoryItemsFromSession({
      messages: [],
      uiHistory: [
        { type: "assistant", text: "first", timestamp: 1_000 },
        { type: "assistant", text: "second", timestamp: 2_000 },
      ],
    });

    expect(result.map((item) => item.timestamp)).toEqual([1_000, 2_000]);
  });

  it("recovers timestamps for legacy uiHistory from canonical messages", () => {
    const result = restoreHistoryItemsFromSession({
      messages: [
        { role: "user", content: "review", timestamp: "2026-07-18T03:00:13.337Z" },
        { role: "assistant", content: "first", timestamp: "2026-07-18T03:00:26.766Z" },
        { role: "assistant", content: "second", timestamp: "2026-07-18T03:00:47.838Z" },
      ],
      uiHistory: [
        { type: "user", text: "review" },
        { type: "assistant", text: "[Worker] first" },
        { type: "assistant", text: "[Worker] second" },
      ],
    });

    expect(result.map((item) => item.timestamp)).toEqual([
      Date.parse("2026-07-18T03:00:13.337Z"),
      Date.parse("2026-07-18T03:00:26.766Z"),
      Date.parse("2026-07-18T03:00:47.838Z"),
    ]);
  });

  it("does not recover a timestamp from an unrelated suffix match", () => {
    const result = restoreHistoryItemsFromSession({
      messages: [
        { role: "assistant", content: "foobar", timestamp: "2026-07-18T03:00:26.766Z" },
      ],
      uiHistory: [
        { type: "assistant", text: "bar" },
        { type: "assistant", text: "foobar" },
      ],
    });

    expect(result.map((item) => item.timestamp)).toEqual([
      undefined,
      Date.parse("2026-07-18T03:00:26.766Z"),
    ]);
  });
});

describe("restore-history / task-completed recovery (GOAL 1)", () => {
  const taskCompletedMsg = {
    role: "user" as const,
    _synthetic: true,
    _source: "task-completed",
    content: '<task-completed task_id="run-x">report body</task-completed>',
  };
  const hasReportBody = (i: { type: string; text?: string }): boolean =>
    i.type === "event" && typeof i.text === "string" && i.text.includes("report body");

  it("headless (no uiHistory): recovers the task-completed banner as one event item at its transcript position", () => {
    const result = restoreHistoryItemsFromSession({
      messages: [
        { role: "user", content: "please review" },
        { role: "assistant", content: "running workflow…" },
        taskCompletedMsg,
      ],
    });
    // Recovered exactly once, as an event (NOT a user bubble — that would corrupt
    // splitCreatableHistoryRounds round boundaries), at its transcript position.
    expect(result.map((i) => i.type)).toEqual(["user", "assistant", "event"]);
    expect(result.filter((i) => hasReportBody(i))).toHaveLength(1);
  });

  it("CLI (uiHistory present): does NOT double-render — enrichTextOnlyUiHistory drops the derived task-completed seed", () => {
    const result = restoreHistoryItemsFromSession({
      messages: [
        { role: "user", content: "please review" },
        taskCompletedMsg,
      ],
      uiHistory: [
        { type: "user", text: "please review" },
        { type: "assistant", text: "workflow result already shown via uiHistory" },
      ],
    });
    // uiHistory is authoritative; the derived task-completed seed is discarded
    // (only tool_group derived items are merged in). No duplicate render — the
    // CLI transcript is exactly the persisted uiHistory (zero TUI regression).
    expect(result.filter((i) => hasReportBody(i))).toHaveLength(0);
    expect(result.map((i) => i.type)).toEqual(["user", "assistant"]);
  });

  it("other synthetic messages stay dropped on the headless path (only _source:'task-completed' is recovered)", () => {
    const result = restoreHistoryItemsFromSession({
      messages: [
        { role: "user", content: "hi" },
        { role: "user", _synthetic: true, content: "please continue" },
      ],
    });
    expect(result.map((i) => i.type)).toEqual(["user"]);
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
