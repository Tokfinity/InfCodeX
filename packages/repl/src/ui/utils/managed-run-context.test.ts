import { describe, expect, it } from "vitest";
import { buildManagedRunContext } from "./managed-run-context.js";

describe("managed-run-context", () => {
  it("injects gitRoot and executionCwd from the interactive context when missing", () => {
    const snapshot = {
      currentTokens: 1234,
      baselineEstimatedTokens: 1200,
      source: "estimate" as const,
    };

    const result = buildManagedRunContext(
      undefined,
      "C:/Works/GitWorks/KodaX",
      snapshot,
      "skills",
    );

    expect(result.gitRoot).toBe("C:/Works/GitWorks/KodaX");
    expect(result.executionCwd).toBe("C:/Works/GitWorks/KodaX");
    expect(result.taskSurface).toBe("repl");
    expect(result.skillsPrompt).toBe("skills");
    expect(result.contextTokenSnapshot).toEqual(snapshot);
  });

  it("preserves an explicit executionCwd from the base context", () => {
    const result = buildManagedRunContext(
      {
        gitRoot: "C:/repo",
        executionCwd: "C:/repo/packages/repl",
      },
      "C:/repo",
      undefined,
      "skills",
    );

    expect(result.gitRoot).toBe("C:/repo");
    expect(result.executionCwd).toBe("C:/repo/packages/repl");
  });

  it("uses runtime execution cwd when the interactive session has no git root", () => {
    const result = buildManagedRunContext(
      undefined,
      undefined,
      undefined,
      "skills",
      "/mnt/c/Users/surui/tmp",
    );

    expect(result.gitRoot).toBeUndefined();
    expect(result.executionCwd).toBe("/mnt/c/Users/surui/tmp");
  });
});
