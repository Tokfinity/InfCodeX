import { describe, expect, it } from "vitest";
import {
  calculateInputPromptRows,
  calculateViewportBudget,
} from "./viewport-budget.js";

describe("viewport-budget", () => {
  it("grows the input area for wrapped multiline input", () => {
    const singleLine = calculateInputPromptRows("hello", 80);
    const multiLine = calculateInputPromptRows("hello\nworld\nthis is a longer line that wraps across the viewport", 30);

    expect(multiLine).toBeGreaterThan(singleLine);
  });

  it("accounts for suggestions, help, status, and confirm dialog", () => {
    const budget = calculateViewportBudget({
      terminalRows: 24,
      terminalWidth: 80,
      inputText: "hello world",
      footerHeaderText: "native_vt | verbose | fullscreen",
      suggestionsReserved: true,
      showHelp: true,
      statusNoticeSummary: "Search: planner",
      statusBarText: "KodaX | PLAN | auto/B | session123 * Read | openai/gpt | 10.0k/200.0k #####----- 5%",
      confirmPrompt: "Apply changes?",
      confirmInstruction: "Press (y) yes, (n) no",
    });

    expect(budget.headerRows).toBeGreaterThanOrEqual(1);
    expect(budget.suggestionsRows).toBe(8);
    expect(budget.helpRows).toBeGreaterThanOrEqual(2);
    expect(budget.statusNoticeRows).toBeGreaterThanOrEqual(1);
    expect(budget.statusRows).toBeGreaterThanOrEqual(1);
    expect(budget.confirmRows).toBeGreaterThanOrEqual(5);
    expect(budget.footerRows).toBeGreaterThan(0);
    expect(budget.slots.find((slot) => slot.name === "footer")?.rows).toBe(budget.footerRows);
    expect(budget.messageRows).toBeGreaterThan(0);
  });

  it("accounts for queued inline input feedback", () => {
    const budget = calculateViewportBudget({
      terminalRows: 24,
      terminalWidth: 60,
      inputText: "",
      pendingInputSummary: "Queued 2 follow-ups. Latest: check tests too (Esc removes latest)",
      suggestionsReserved: false,
      showHelp: false,
      statusBarText: "status",
    });

    expect(budget.pendingInputRows).toBeGreaterThan(0);
    expect(budget.messageRows).toBeGreaterThan(0);
  });

  // v0.7.42 layout bugfix — when the caller passes a multi-line budget text
  // (as InkREPL does via `formatPendingInputsBudgetText`), the reserved row
  // count must scale with queue depth. Prior to the fix the caller passed a
  // single-summary line and `pendingInputRows` was 1 regardless of depth, so
  // queue depth ≥ 2 silently pushed composer + status bar off screen.
  it("scales pendingInputRows with queue depth so composer/status stay on screen", () => {
    const oneItem = calculateViewportBudget({
      terminalRows: 24,
      terminalWidth: 120,
      inputText: "",
      pendingInputSummary: ["⏳ [1/1] alpha", "  ↑ pull all into editor · Esc drops latest"].join("\n"),
      suggestionsReserved: false,
      showHelp: false,
      statusBarText: "status",
    });
    const threeItems = calculateViewportBudget({
      terminalRows: 24,
      terminalWidth: 120,
      inputText: "",
      pendingInputSummary: [
        "⏳ [1/3] alpha",
        "⏳ [2/3] beta",
        "⏳ [3/3] gamma",
        "  ↑ pull all into editor · Esc drops latest",
      ].join("\n"),
      suggestionsReserved: false,
      showHelp: false,
      statusBarText: "status",
    });

    expect(oneItem.pendingInputRows).toBe(2);
    expect(threeItems.pendingInputRows).toBe(4);
    expect(threeItems.messageRows).toBeLessThan(oneItem.messageRows);
  });

  it("reserves footer space for header and status notice surfaces", () => {
    const withoutSurfaces = calculateViewportBudget({
      terminalRows: 24,
      terminalWidth: 48,
      inputText: "",
      suggestionsReserved: false,
      showHelp: false,
      statusBarText: "status",
    });
    const withSurfaces = calculateViewportBudget({
      terminalRows: 24,
      terminalWidth: 48,
      inputText: "",
      footerHeaderText: "native_vt | compact | fullscreen",
      statusNoticeSummary: "Search: planner",
      suggestionsReserved: false,
      showHelp: false,
      statusBarText: "status",
    });

    expect(withSurfaces.headerRows).toBeGreaterThan(0);
    expect(withSurfaces.statusNoticeRows).toBeGreaterThan(0);
    expect(withSurfaces.footerRows).toBeGreaterThan(withoutSurfaces.footerRows);
    expect(withSurfaces.messageRows).toBeLessThan(withoutSurfaces.messageRows);
  });

  it("reserves footer space for a prompt activity row so status/footer do not overlap", () => {
    const withoutActivity = calculateViewportBudget({
      terminalRows: 24,
      terminalWidth: 48,
      inputText: "",
      suggestionsReserved: false,
      showHelp: false,
      statusBarText: "status",
    });
    const withActivity = calculateViewportBudget({
      terminalRows: 24,
      terminalWidth: 48,
      inputText: "",
      activitySummary: "Thinking (128 chars)",
      suggestionsReserved: false,
      showHelp: false,
      statusBarText: "status",
    });

    expect(withActivity.activityRows).toBeGreaterThan(0);
    expect(withActivity.footerRows).toBeGreaterThan(withoutActivity.footerRows);
    expect(withActivity.messageRows).toBeLessThan(withoutActivity.messageRows);
  });

  it("clamps select dialog options and keeps message rows positive", () => {
    const budget = calculateViewportBudget({
      terminalRows: 16,
      terminalWidth: 50,
      inputText: "",
      suggestionsReserved: false,
      showHelp: false,
      statusBarText: "status bar content that wraps on narrow terminals",
      uiRequest: {
        kind: "select",
        title: "Choose an option",
        options: Array.from({ length: 8 }, (_, index) => ({
          label: `Option ${index + 1}`,
          description: "description",
        })),
        buffer: "",
      },
    });

    expect(budget.visibleSelectOptions).toBe(5);
    expect(budget.uiRequestRows).toBeGreaterThan(0);
    expect(budget.messageRows).toBeGreaterThan(0);
  });

  it("can drop reserved suggestion space while still accounting for the transcript hint", () => {
    const budget = calculateViewportBudget({
      terminalRows: 24,
      terminalWidth: 80,
      inputText: "",
      suggestionsReserved: false,
      showHelp: false,
      statusBarText: "status",
      reviewHint: "Transcript Mode | PgUp/PgDn/j/k scroll | q/Esc/Ctrl+O back to live",
    });

    expect(budget.suggestionsRows).toBe(0);
    expect(budget.reviewHintRows).toBeGreaterThan(0);
    expect(budget.messageRows).toBeGreaterThan(0);
  });

  it("accounts for the AMA work strip without collapsing message rows", () => {
    const withoutStrip = calculateViewportBudget({
      terminalRows: 24,
      terminalWidth: 80,
      inputText: "",
      suggestionsReserved: false,
      showHelp: false,
      statusBarText: "status",
    });
    const withStrip = calculateViewportBudget({
      terminalRows: 24,
      terminalWidth: 80,
      inputText: "",
      workStripText: "Validating 3 findings",
      suggestionsReserved: false,
      showHelp: false,
      statusBarText: "status",
    });

    expect(withStrip.workStripRows).toBeGreaterThan(0);
    expect(withStrip.reservedBottomRows).toBeGreaterThan(withoutStrip.reservedBottomRows);
    expect(withStrip.messageRows).toBeLessThan(withoutStrip.messageRows);
    expect(withStrip.messageRows).toBeGreaterThan(0);
  });

  it("tracks overlay rows separately when suggestions and dialogs use overlay mode", () => {
    const budget = calculateViewportBudget({
      terminalRows: 24,
      terminalWidth: 80,
      inputText: "",
      suggestionsReserved: true,
      suggestionsMode: "overlay",
      dialogMode: "overlay",
      showHelp: false,
      statusBarText: "status",
      confirmPrompt: "Apply changes?",
      confirmInstruction: "Press y to confirm",
      historySearch: {
        query: "planner",
        selectedExcerpt: "Planner is active in this transcript entry",
        matchCount: 3,
      },
    });

    expect(budget.overlayRows).toBeGreaterThan(0);
    expect(budget.footerRows).toBe(budget.inputRows);
    expect(budget.historySearchRows).toBeGreaterThan(0);
    expect(budget.slots.find((slot) => slot.name === "overlay")?.rows).toBe(budget.overlayRows);
    expect(budget.reservedBottomRows).toBe(
      budget.footerRows + budget.workStripRows + budget.statusRows,
    );
  });

  it("keeps transcript and prompt message rows aligned with stable bottom-slot budgeting", () => {
    const inlineBudget = calculateViewportBudget({
      terminalRows: 24,
      terminalWidth: 80,
      inputText: "",
      suggestionsReserved: false,
      showHelp: false,
      statusBarText: "status",
    });
    const windowedBudget = calculateViewportBudget({
      terminalRows: 24,
      terminalWidth: 80,
      windowedTranscript: true,
      inputText: "",
      suggestionsReserved: false,
      showHelp: false,
      statusBarText: "status",
    });

    expect(windowedBudget.messageRows).toBe(inlineBudget.messageRows);
  });

  // FEATURE_114 v0.7.36 Slice 4 (UX bugfix v0.7.38) — pin the
  // composer + status-bar visibility regression that v0.7.38 user
  // testing surfaced. Prior to this fix the viewport budget did not
  // reserve rows for the TodoListSurface or the always-visible
  // activityBar slot, so the moment a plan list rendered the input
  // bar + status bar disappeared off-screen.
  it("reserves rows for TodoListSurface so composer + status-bar stay visible", () => {
    const withoutPlan = calculateViewportBudget({
      terminalRows: 24,
      terminalWidth: 80,
      inputText: "",
      suggestionsReserved: false,
      showHelp: false,
      statusBarText: "status",
    });
    const withPlanList = calculateViewportBudget({
      terminalRows: 24,
      terminalWidth: 80,
      inputText: "",
      suggestionsReserved: false,
      showHelp: false,
      statusBarText: "status",
      // 5 rows = Scout header + 4 items, the exact case the user hit.
      todoSurfaceRows: 5,
      activityBarVisible: true,
    });

    // 5 plan rows + 1 activityBar row = 6 reserved bottom rows.
    expect(withPlanList.todoSurfaceRows).toBe(5);
    expect(withPlanList.activityRows).toBeGreaterThanOrEqual(1);
    expect(withPlanList.messageRows).toBe(withoutPlan.messageRows - 6);
    // Footer must include the plan-list rows and an activityBar row,
    // otherwise composer + status get pushed off-screen.
    expect(withPlanList.footerRows).toBeGreaterThanOrEqual(
      withoutPlan.footerRows + 6,
    );
  });

  it("reserves rows for WorkflowRunSurface so composer + status-bar stay visible", () => {
    const withoutWorkflow = calculateViewportBudget({
      terminalRows: 24,
      terminalWidth: 80,
      inputText: "",
      suggestionsReserved: false,
      showHelp: false,
      statusBarText: "status",
    });
    const withWorkflow = calculateViewportBudget({
      terminalRows: 24,
      terminalWidth: 80,
      inputText: "",
      suggestionsReserved: false,
      showHelp: false,
      statusBarText: "status",
      workflowSurfaceRows: 6,
      activityBarVisible: true,
    });

    expect(withWorkflow.workflowSurfaceRows).toBe(6);
    expect(withWorkflow.activityRows).toBe(1);
    expect(withWorkflow.messageRows).toBe(withoutWorkflow.messageRows - 7);
    expect(withWorkflow.footerRows).toBeGreaterThanOrEqual(
      withoutWorkflow.footerRows + 7,
    );
  });

  it("reserves activityBar row when only the plan-list counter is visible (no spinner verb)", () => {
    // The plan-list counter ("X/N completed") shares the activityBar
    // slot with the spinner verb. When the verb is absent but the
    // counter is shown, the slot still occupies 1 row; the budget
    // must account for that even though `activitySummary` is empty.
    const counterOnly = calculateViewportBudget({
      terminalRows: 24,
      terminalWidth: 80,
      inputText: "",
      suggestionsReserved: false,
      showHelp: false,
      statusBarText: "status",
      activitySummary: undefined,
      activityBarVisible: true,
      todoSurfaceRows: 3,
    });
    expect(counterOnly.activityRows).toBe(1);
    expect(counterOnly.todoSurfaceRows).toBe(3);
  });

  it("does not reserve plan-list rows when shouldRender is false", () => {
    const noPlan = calculateViewportBudget({
      terminalRows: 24,
      terminalWidth: 80,
      inputText: "",
      suggestionsReserved: false,
      showHelp: false,
      statusBarText: "status",
      todoSurfaceRows: 0,
      activityBarVisible: false,
    });
    expect(noPlan.todoSurfaceRows).toBe(0);
    expect(noPlan.activityRows).toBe(0);
  });
});
