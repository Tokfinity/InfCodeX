import { describe, expect, it } from "vitest";

import {
  isKodaXSessionUiHistory,
  isKodaXSessionUiHistoryItem,
} from "./json-guards.js";

describe("json-guards session uiHistory", () => {
  it("accepts text event items", () => {
    expect(isKodaXSessionUiHistoryItem({
      type: "event",
      text: "Tool completed",
      icon: "tool",
      compactText: "Tool completed",
      timestamp: 1_000,
    })).toBe(true);
  });

  it("accepts terminal tool_group items", () => {
    expect(isKodaXSessionUiHistoryItem({
      type: "tool_group",
      timestamp: 2_000,
      tools: [
        {
          id: "tool-1",
          name: "read",
          status: "success",
          input: { path: "README.md" },
          output: "contents",
          startTime: 10,
          endTime: 20,
        },
      ],
    })).toBe(true);
  });

  it("rejects invalid history timestamps", () => {
    expect(isKodaXSessionUiHistoryItem({
      type: "assistant",
      text: "done",
      timestamp: -1,
    })).toBe(false);
    expect(isKodaXSessionUiHistoryItem({
      type: "tool_group",
      timestamp: Number.NaN,
      tools: [{ id: "tool-1", name: "read", status: "success" }],
    })).toBe(false);
  });

  it("rejects malformed tool_group siblings item-by-item", () => {
    const values = [
      { type: "user", text: "hello" },
      {
        type: "tool_group",
        tools: [
          {
            id: "tool-1",
            name: "read",
            status: "executing",
          },
        ],
      },
      { type: "assistant", text: "done" },
    ];

    expect(values.filter(isKodaXSessionUiHistoryItem)).toEqual([
      { type: "user", text: "hello" },
      { type: "assistant", text: "done" },
    ]);
    expect(isKodaXSessionUiHistory(values)).toBe(false);
  });
});
