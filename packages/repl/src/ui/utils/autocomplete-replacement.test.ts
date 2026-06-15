import { describe, expect, it } from "vitest";
import { buildAutocompleteReplacement } from "./autocomplete-replacement.js";

describe("buildAutocompleteReplacement", () => {
  it("preserves trailing text for slash commands", () => {
    expect(
      buildAutocompleteReplacement("please /he world", 10, {
        text: "/help",
        type: "command",
      })
    ).toEqual({
      start: 7,
      end: 10,
      replacement: "/help",
    });
  });

  it("preserves trailing text for file mentions", () => {
    expect(
      buildAutocompleteReplacement("look @sr today", 8, {
        text: "@src/",
        type: "file",
      })
    ).toEqual({
      start: 5,
      end: 8,
      replacement: "@src/",
    });
  });

  it("replaces only the active argument token", () => {
    expect(
      buildAutocompleteReplacement("/model anth rest", 11, {
        text: "anthropic/claude",
        type: "argument",
      })
    ).toEqual({
      start: 7,
      end: 11,
      replacement: "anthropic/claude",
    });
  });

  it("inserts an argument without replacing the command when the argument is empty", () => {
    expect(
      buildAutocompleteReplacement("/workflow ", 10, {
        text: "runs",
        type: "argument",
      })
    ).toEqual({
      start: 10,
      end: 10,
      replacement: "runs",
    });
  });

  it("keeps a bare command when inserting its first argument", () => {
    expect(
      buildAutocompleteReplacement("/workflow", 9, {
        text: "runs",
        type: "argument",
      })
    ).toEqual({
      start: 9,
      end: 9,
      replacement: " runs",
    });
  });
});
