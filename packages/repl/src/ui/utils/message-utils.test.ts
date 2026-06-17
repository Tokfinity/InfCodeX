import { describe, expect, it } from "vitest";
import type { KodaXMessage } from "@kodax-ai/agent";
import { ToolCallStatus } from "../types.js";
import {
  type HistorySeedSourceMessage,
  extractHistorySeedsFromMessage,
  extractHistorySeedsFromMessages,
  extractLastAssistantText,
  extractTitle,
  extractTextContent,
  formatMessagePreview,
  isControlPlaneOnlyAssistantText,
  resolveAssistantHistoryText,
  resolveCompletedAssistantText,
  sanitizeUserFacingAssistantText,
  seedToHistoryItem,
} from "./message-utils.js";

describe("message-utils", () => {
  it("keeps extractTextContent focused on plain text blocks", () => {
    const text = extractTextContent([
      { type: "thinking", thinking: "plan silently" },
      { type: "text", text: "final answer" },
    ]);

    expect(text).toBe("final answer");
  });

  it("restores structured assistant thinking blocks as separate history items", () => {
    const message: HistorySeedSourceMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "plan silently" },
        { type: "text", text: "final answer" },
      ],
    };
    const items = extractHistorySeedsFromMessage(message);

    expect(items).toEqual([
      { type: "thinking", text: "plan silently" },
      { type: "assistant", text: "final answer" },
    ]);
  });

  it("restores legacy tagged thinking blocks as separate history items", () => {
    const message: HistorySeedSourceMessage = {
      role: "assistant",
      content: "[Thinking]\nplan silently\n[/Thinking]\nfinal answer",
    };
    const items = extractHistorySeedsFromMessage(message);

    expect(items).toEqual([
      { type: "thinking", text: "plan silently" },
      { type: "assistant", text: "final answer" },
    ]);
  });

  it("restores multiple tagged thinking blocks in order", () => {
    const message: HistorySeedSourceMessage = {
      role: "assistant",
      content: "preface\n[Thinking]\nfirst\n[/Thinking]\nmiddle\n[Thinking]\nsecond\n[/Thinking]\nanswer",
    };
    const items = extractHistorySeedsFromMessage(message);

    expect(items).toEqual([
      { type: "assistant", text: "preface" },
      { type: "thinking", text: "first" },
      { type: "assistant", text: "middle" },
      { type: "thinking", text: "second" },
      { type: "assistant", text: "answer" },
    ]);
  });

  it("does not treat inline thinking tags as legacy restore markers", () => {
    const message: HistorySeedSourceMessage = {
      role: "assistant",
      content: "Use [Thinking] and [/Thinking] literally in docs.",
    };

    expect(extractHistorySeedsFromMessage(message)).toEqual([
      { type: "assistant", text: "Use [Thinking] and [/Thinking] literally in docs." },
    ]);
  });

  it("ignores empty legacy thinking blocks", () => {
    const message: HistorySeedSourceMessage = {
      role: "assistant",
      content: "[Thinking]\n\n[/Thinking]\nfinal answer",
    };

    expect(extractHistorySeedsFromMessage(message)).toEqual([
      { type: "assistant", text: "final answer" },
    ]);
  });

  it("filters system messages from restored transcript (LLM-internal scaffolding)", () => {
    // System messages in KodaX are LLM-internal scaffolding (Scout/Generator/
    // Planner/Evaluator role-prompts, capability-sections, AMA controller
    // metadata, repo-intelligence snapshots) — never user-facing. Re-rendering
    // them as "System [HH:MM]" transcript bubbles on `-c` resume would leak
    // the entire prior task's role-prompt to the user.
    const scoutPrompt: HistorySeedSourceMessage = {
      role: "system",
      content: [
        "## Repository Intelligence",
        "Repository overview for some-prior-cwd",
        "",
        "You are Scout — the AMA entry role for a managed KodaX task.",
        "",
        "## Environment",
        "Working Directory: D:/some/prior/cwd",
        "",
        "Original user request:",
        "把当前文件夹做个git初始化",
      ].join("\n"),
    };
    expect(extractHistorySeedsFromMessage(scoutPrompt)).toEqual([]);
  });

  it("filters system messages even when content is short (defensive)", () => {
    const message: HistorySeedSourceMessage = {
      role: "system",
      content: "any system text",
    };
    expect(extractHistorySeedsFromMessage(message)).toEqual([]);
  });

  it("filters system messages with structured content blocks", () => {
    const message: HistorySeedSourceMessage = {
      role: "system",
      content: [{ type: "text", text: "internal scaffolding" }],
    };
    expect(extractHistorySeedsFromMessage(message)).toEqual([]);
  });

  it("restores paired tool_use and tool_result blocks as a tool group seed", () => {
    const messages: KodaXMessage[] = [
      { role: "user", content: "Inspect README" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Need to read the file first." },
          { type: "tool_use", id: "tool-1", name: "read", input: { path: "README.md" } },
          { type: "text", text: "I found the answer." },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool-1", content: "README contents" },
        ],
      },
    ];

    expect(extractHistorySeedsFromMessages(messages)).toEqual([
      { type: "user", text: "Inspect README" },
      { type: "thinking", text: "Need to read the file first." },
      {
        type: "tool_group",
        tools: [
          {
            id: "tool-1",
            name: "read",
            status: "success",
            input: { path: "README.md" },
            output: "README contents",
          },
        ],
      },
      { type: "assistant", text: "I found the answer." },
    ]);
  });

  it("caps restored tool result text when deriving replay seeds", () => {
    const messages: KodaXMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tool-1", name: "read", input: { path: "huge.log" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool-1", content: "x".repeat(2100) },
        ],
      },
    ];

    const seed = extractHistorySeedsFromMessages(messages).find((item) => item.type === "tool_group");
    if (seed?.type !== "tool_group") {
      throw new Error("expected a restored tool group");
    }

    const output = seed.tools[0]?.output;
    expect(output).toHaveLength(2000);
    expect(output?.endsWith("...")).toBe(true);
  });

  it("bounds and redacts restored tool input when deriving replay seeds", () => {
    const messages: KodaXMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "bash",
            input: {
              command: "x".repeat(2100),
              password: "plain-password",
              apiKey: "plain-api-key",
              cookie: "session-cookie",
              items: Array.from({ length: 60 }, (_, index) => index),
              nested: { a: { b: { c: { d: { e: { f: "too deep" } } } } } },
            },
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool-1", content: "ok" },
        ],
      },
    ];

    const seed = extractHistorySeedsFromMessages(messages).find((item) => item.type === "tool_group");
    if (seed?.type !== "tool_group") {
      throw new Error("expected a restored tool group");
    }

    const input = seed.tools[0]?.input;
    if (!input) {
      throw new Error("expected restored tool input");
    }
    expect(input["password"]).toBe("[redacted]");
    expect(input["apiKey"]).toBe("[redacted]");
    expect(input["cookie"]).toBe("[redacted]");
    expect(typeof input["command"]).toBe("string");
    expect(String(input["command"])).toHaveLength(2000);
    expect(String(input["command"]).endsWith("...")).toBe(true);
    expect(Array.isArray(input["items"])).toBe(true);
    if (!Array.isArray(input["items"])) {
      throw new Error("expected bounded input.items array");
    }
    expect(input["items"]).toHaveLength(50);
    const nestedJson = JSON.stringify(input["nested"]);
    expect(nestedJson).toContain("[truncated]");
    expect(nestedJson).not.toContain("too deep");
  });

  it("does not recurse forever on cyclic restored tool inputs", () => {
    const input: Record<string, unknown> = { command: "npm test" };
    input.self = input;

    const messages: KodaXMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "bash",
            input,
          },
        ],
      },
    ];

    const seed = extractHistorySeedsFromMessages(messages).find((item) => item.type === "tool_group");
    if (seed?.type !== "tool_group") {
      throw new Error("expected a restored tool group");
    }

    expect(seed.tools[0]?.input).toEqual({
      command: "npm test",
      self: "[truncated]",
    });
  });

  it("maps restored tool group seeds to creatable history items", () => {
    expect(seedToHistoryItem({
      type: "tool_group",
      tools: [
        {
          id: "tool-1",
          name: "grep",
          status: "error",
          input: { pattern: "TODO" },
          error: "grep failed",
        },
      ],
    })).toEqual({
      type: "tool_group",
      tools: [
        {
          id: "tool-1",
          name: "grep",
          status: ToolCallStatus.Error,
          input: { pattern: "TODO" },
          error: "grep failed",
          startTime: expect.any(Number),
        },
      ],
    });
  });

  it("extracts the latest assistant text from structured content", () => {
    const messages: KodaXMessage[] = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "line 1" },
          { type: "tool_result", tool_use_id: "tool-1", content: "ignored" },
          { type: "text", text: "line 2" },
        ],
      },
    ];
    const text = extractLastAssistantText(messages);

    expect(text).toBe("line 1\nline 2");
  });

  it("extracts only assistant text blocks when thinking blocks are present", () => {
    const messages: KodaXMessage[] = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "plan silently" },
          { type: "text", text: "line 1" },
          { type: "text", text: "line 2" },
        ],
      },
    ];
    const text = extractLastAssistantText(messages);

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
      ] satisfies KodaXMessage[],
      "full response"
    );

    expect(resolved).toBe("full response\n\nPlease tell me what you'd like to do next.");
  });

  it("falls back to streamed text when assistant message content is unavailable", () => {
    const resolved = resolveAssistantHistoryText(
      [{ role: "user", content: "hello" }] satisfies KodaXMessage[],
      "buffered response"
    );

    expect(resolved).toBe("buffered response");
  });

  it("prefers the persisted final assistant body over managed-task summaries", () => {
    const resolved = resolveCompletedAssistantText(
      [
        { role: "user", content: "hello" },
        { role: "assistant", content: "full final assistant body" },
      ] satisfies KodaXMessage[],
      "streamed preview",
      "managed summary",
      "lastText fallback"
    );

    expect(resolved).toBe("full final assistant body");
  });

  it("falls back to managed-task summaries only when no full assistant body exists", () => {
    const resolved = resolveCompletedAssistantText(
      [{ role: "user", content: "hello" }] satisfies KodaXMessage[],
      "",
      "managed summary",
      "lastText fallback"
    );

    expect(resolved).toBe("managed summary");
  });

  it("builds session titles from structured user text blocks", () => {
    const title = extractTitle([
      {
        role: "user",
        content: [
          { type: "thinking", thinking: "ignore me" },
          { type: "text", text: "Triage failing tests" },
          { type: "text", text: "before release" },
        ],
      },
    ] satisfies KodaXMessage[]);

    expect(title).toBe("Triage failing tests before release");
  });

  it("falls back to an untitled session label when the first user content is blank", () => {
    const title = extractTitle([
      {
        role: "user",
        content: [{ type: "thinking", thinking: "ignore me" }],
      },
    ] satisfies KodaXMessage[]);

    expect(title).toBe("Untitled Session");
  });

  it("formats previews with a shared truncation rule", () => {
    expect(formatMessagePreview("line 1\nline 2", 8)).toBe("line 1 l...");
  });

  it("strips managed-task prompt scaffolding from assistant text", () => {
    const text = [
      "You are the Evaluator role for a managed KodaX task.",
      "",
      "Primary task: review",
      "Work intent: new",
      "Harness: H1_EXECUTE_EVAL",
      "",
      "Tool policy:",
      "Allowed shell patterns:",
    ].join("\n");

    expect(sanitizeUserFacingAssistantText(text)).toBe("");
    expect(isControlPlaneOnlyAssistantText(text)).toBe(true);
  });

  it("keeps user-facing text before control-plane scaffolding", () => {
    const text = [
      "Here are the final findings.",
      "",
      "You are the Evaluator role for a managed KodaX task.",
      "Primary task: review",
    ].join("\n");

    expect(sanitizeUserFacingAssistantText(text)).toBe("Here are the final findings.");
  });
});
