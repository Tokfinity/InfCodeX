import { describe, expect, it } from "vitest";
import {
  formatManagedTaskBreadcrumb,
  formatSilentIterationToolsSummary,
  mergeLiveThinkingContent,
} from "./live-streaming.js";

describe("live-streaming", () => {
  it("prefers the authoritative final thinking when it extends the current buffer", () => {
    expect(mergeLiveThinkingContent("Need to inspect", "Need to inspect the file first."))
      .toBe("Need to inspect the file first.");
  });

  it("keeps the current thinking when the final event is shorter", () => {
    expect(mergeLiveThinkingContent("Need to inspect the file first.", "Need to inspect"))
      .toBe("Need to inspect the file first.");
  });

  it("formats managed-task preflight breadcrumbs", () => {
    expect(formatManagedTaskBreadcrumb({
      agentMode: "ama",
      harnessProfile: "H2_PLAN_EXECUTE_EVAL",
      activeWorkerTitle: "Admission",
      currentRound: 0,
      maxRounds: 4,
      phase: "preflight",
      note: "Admission preflight starting",
    })).toBe("AMA H2 - Admission preflight starting");
  });

  it("formats managed-task worker breadcrumbs", () => {
    expect(formatManagedTaskBreadcrumb({
      agentMode: "ama",
      harnessProfile: "H2_PLAN_EXECUTE_EVAL",
      activeWorkerTitle: "Planner",
      currentRound: 1,
      maxRounds: 4,
      phase: "worker",
    })).toBe("AMA H2 - Planner starting - Round 1/4");
  });

  it("formats managed-task routing breadcrumbs", () => {
    expect(formatManagedTaskBreadcrumb({
      agentMode: "ama",
      harnessProfile: "H2_PLAN_EXECUTE_EVAL",
      phase: "routing",
      note: "AMA routing: raw=H0_DIRECT(model) -> final=H2_PLAN_EXECUTE_EVAL reason=large current-diff review",
    })).toBe("AMA routing: raw=H0_DIRECT(model) -> final=H2_PLAN_EXECUTE_EVAL reason=large current-diff review");
  });

  it("formats silent tool-only iteration summaries", () => {
    expect(formatSilentIterationToolsSummary(3, ["changed_scope", "changed_diff"], {
      activeWorkerTitle: "Planner",
    })).toBe("[Planner] Iter 3 tools: changed_scope, changed_diff");
  });
});
