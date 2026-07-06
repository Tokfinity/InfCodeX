import { describe, expect, it } from "vitest";
import type { AskUserQuestionOptions } from "../../packages/coding/src/types.js";
import {
  appendCustomInputOption,
  getAskUserDialogTitle,
  resolveAskUserDefaultChoice,
  toSelectOptions,
} from "../../packages/repl/src/ui/utils/ask-user.js";

describe("ask-user helpers", () => {
  it("prefers an explicit cancel option when dismissing generic questions", () => {
    expect(
      resolveAskUserDefaultChoice({
        question: "Proceed?",
        options: [
          { label: "Apply", value: "apply" },
          { label: "Cancel", value: "cancel" },
        ],
      }),
    ).toBe("cancel");
  });

  it("returns an empty choice when dismissing generic questions without cancel", () => {
    expect(
      resolveAskUserDefaultChoice({
        question: "Proceed?",
        options: [
          { label: "Apply", value: "apply" },
          { label: "Manual edit", value: "manual" },
        ],
        default: "apply",
      }),
    ).toBe("");
  });

  it("uses the LLM-provided question text directly for dialog title", () => {
    const options: AskUserQuestionOptions = {
      question: "Plan is complete. Start editing?",
      options: [
        { label: "Yes", value: "yes" },
        { label: "No", value: "no" },
      ],
    };
    expect(getAskUserDialogTitle(options)).toBe("Plan is complete. Start editing?");
  });

  it("preserves labels and descriptions for Ink select dialogs", () => {
    const options: AskUserQuestionOptions = {
      question: "Choose",
      options: [
        {
          label: "Enter implementation",
          description: "Switch this session to accept-edits.",
          value: "accept-edits",
        },
        {
          label: "Stay in plan mode",
          description: "Keep the session read-only.",
          value: "stay-plan",
        },
      ],
    };
    expect(toSelectOptions(options.options)).toEqual([
      {
        label: "Enter implementation",
        description: "Switch this session to accept-edits.",
        value: "accept-edits",
      },
      {
        label: "Stay in plan mode",
        description: "Keep the session read-only.",
        value: "stay-plan",
      },
    ]);
  });

  it("appends a custom input option to choice dialogs by default", () => {
    const options: AskUserQuestionOptions = {
      question: "Choose",
      options: [{ label: "Docs", value: "docs" }],
    };

    expect(appendCustomInputOption(toSelectOptions(options.options), options)).toEqual([
      { label: "Docs", value: "docs", description: undefined },
      { label: "Other...", value: "__custom_input__" },
    ]);
  });

  it("does not append custom input when explicitly disabled", () => {
    const options: AskUserQuestionOptions = {
      question: "Approve?",
      allowCustomInput: false,
      options: [
        { label: "Approve", value: "approve" },
        { label: "Reject", value: "reject" },
      ],
    };

    expect(appendCustomInputOption(toSelectOptions(options.options), options)).toEqual([
      { label: "Approve", value: "approve", description: undefined },
      { label: "Reject", value: "reject", description: undefined },
    ]);
  });

  it("uses a custom input label when provided", () => {
    const options: AskUserQuestionOptions = {
      question: "Choose",
      customInputLabel: "Something else",
      options: [{ label: "Docs", value: "docs" }],
    };

    expect(appendCustomInputOption(toSelectOptions(options.options), options).at(-1)).toEqual({
      label: "Something else",
      value: "__custom_input__",
    });
  });
});
