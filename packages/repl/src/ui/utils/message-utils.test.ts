import { describe, expect, it } from "vitest";
import {
  extractLastAssistantText,
  resolveAssistantHistoryText,
} from "./message-utils.js";

describe("message-utils", () => {
  it("keeps thinking markup in extractTextContent for session restore", async () => {
    const { extractTextContent } = await import("./message-utils.js");

    const text = extractTextContent([
      { type: "thinking", thinking: "plan silently" },
      { type: "text", text: "final answer" },
    ]);

    expect(text).toBe("[Thinking]\nplan silently\n[/Thinking]\nfinal answer");
  });

  it("extracts the latest assistant text from structured content", () => {
    const text = extractLastAssistantText([
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "line 1" },
          { type: "tool_result", content: "ignored" },
          { type: "text", text: "line 2" },
        ],
      },
    ] as never);

    expect(text).toBe("line 1\nline 2");
  });

  it("extracts only assistant text blocks when thinking blocks are present", () => {
    const text = extractLastAssistantText([
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "plan silently" },
          { type: "text", text: "line 1" },
          { type: "text", text: "line 2" },
        ],
      },
    ] as never);

    expect(text).toBe("line 1\nline 2");
  });

  it("prefers persisted assistant content over streamed buffer text", () => {
    const resolved = resolveAssistantHistoryText(
      [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: "full response\n\nPlease tell me what you'd like to do next.",
        },
      ] as never,
      "full response"
    );

    expect(resolved).toBe("full response\n\nPlease tell me what you'd like to do next.");
  });

  it("falls back to streamed text when assistant message content is unavailable", () => {
    const resolved = resolveAssistantHistoryText(
      [{ role: "user", content: "hello" }] as never,
      "buffered response"
    );

    expect(resolved).toBe("buffered response");
  });
});
