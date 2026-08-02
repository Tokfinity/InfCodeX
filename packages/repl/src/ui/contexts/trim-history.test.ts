import { describe, expect, it } from "vitest";

import { selectUncommittedLedgerUserItems, trimHistoryToRounds } from "./UIStateContext.js";
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

  it("enforces the item cap even when there are <=50 user rounds", () => {
    // A tool-heavy history can exceed the item cap without exceeding the
    // round cap. Align the hard 150-item suffix to the next user boundary.
    const history = Array.from({ length: 200 }, (_, i) => item(i, i % 4 === 0 ? "user" : "assistant"));
    const trimmed = trimHistoryToRounds(history);
    expect(trimmed).toHaveLength(148);
    expect(trimmed[0]!.type).toBe("user");
    expect(trimmed[0]!.id).toBe("52");
    expect(trimmed.at(-1)!.id).toBe("199");
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

// FEATURE_213 (v0.7.45) — the rescue helper that stops a mid-turn user message
// (a query queued while waiting for a sub-agent) from being silently dropped
// when the foreground ledger is cleared before its round-end commit. It returns
// the ledger's `user` items not yet committed (by id), so the caller commits
// them before wiping, and a clear following a real commit (ids already marked)
// is a no-op.
function userItem(id: string, text: string): HistoryItem {
  return { id, type: "user", text, timestamp: 0 } as HistoryItem;
}
function workerItem(id: string, type: HistoryItem["type"]): HistoryItem {
  return { id, type, text: "w", timestamp: 0 } as HistoryItem;
}

describe("selectUncommittedLedgerUserItems (FEATURE_213)", () => {
  it("returns user items not yet committed", () => {
    const ledger = [
      workerItem("a-1", "assistant"),
      userItem("u-1", "queued query"),
      workerItem("t-1", "tool_group"),
    ];
    const result = selectUncommittedLedgerUserItems(ledger, new Set());
    expect(result.map((i) => i.id)).toEqual(["u-1"]);
  });

  it("skips user items whose id is already committed (no double-add)", () => {
    const ledger = [userItem("u-1", "first"), userItem("u-2", "second")];
    const result = selectUncommittedLedgerUserItems(ledger, new Set(["u-1"]));
    expect(result.map((i) => i.id)).toEqual(["u-2"]);
  });

  it("returns nothing when all user items are already committed", () => {
    const ledger = [userItem("u-1", "first"), workerItem("a-1", "assistant")];
    expect(selectUncommittedLedgerUserItems(ledger, new Set(["u-1"]))).toEqual([]);
  });

  it("ignores non-user items and id-less items", () => {
    const ledger: HistoryItem[] = [
      workerItem("a-1", "assistant"),
      { type: "user", text: "no id" } as HistoryItem,
    ];
    expect(selectUncommittedLedgerUserItems(ledger, new Set())).toEqual([]);
  });
});
