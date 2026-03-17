import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { StatusBar, getStatusBarText } from "./StatusBar.js";

describe("StatusBar", () => {
  it("includes thinking char counts in budget text", () => {
    const text = getStatusBarText({
      sessionId: "session-1",
      permissionMode: "accept-edits",
      provider: "anthropic",
      model: "sonnet",
      thinking: true,
      reasoningMode: "auto",
      thinkingCharCount: 42,
    });

    expect(text).toContain("Thinking (42 chars)");
  });

  it("includes tool char counts in budget text", () => {
    const text = getStatusBarText({
      sessionId: "session-1",
      permissionMode: "accept-edits",
      provider: "anthropic",
      model: "sonnet",
      currentTool: "shell_command",
      toolInputCharCount: 12,
    });

    expect(text).toContain("Bash (12 chars)");
  });

  it("renders the visible busy status", () => {
    const { lastFrame } = render(
      <StatusBar
        sessionId="session-1"
        permissionMode="accept-edits"
        provider="anthropic"
        model="sonnet"
        currentTool="shell_command"
        toolInputCharCount={12}
      />
    );

    expect(lastFrame()).toContain("Bash (12 chars)");
  });
});
