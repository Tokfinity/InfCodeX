/**
 * FEATURE_172 v0.7.41 — REPL render data-layer golden snapshots (Layer 0 G1).
 *
 * Locks the exact `TranscriptRenderModel` output for representative
 * `HistoryItem` fixtures. Forms the byte-equal baseline gate for Phases 1,
 * 2, 3, 5 — all of which preserve `buildTranscriptRenderModel` semantics.
 *
 * Phase 4 (TranscriptScreenBuffer / selection migration) intentionally
 * deletes `buildTranscriptRenderModel`; these snapshots will be retired
 * then. By that point Phase 3 has landed the claudecode `nodeCache` +
 * `Screen.cells` raw-read path, which is gated by the manual regression
 * guide + e2e mouse-select tests instead.
 *
 * Why data-level not cell-level: ink-testing-library uses upstream Ink
 * while MessageList renders against the KodaX vendored fork
 * (`packages/repl/src/tui/`). Mounting MessageList in ink-testing-library
 * either (a) requires mocking every vendored hook (defeating "capture
 * real output" purpose) or (b) produces output from upstream Ink not
 * the vendored renderer. Data-layer snapshots sidestep both — they
 * capture the layout-engine intent precisely and are deterministic
 * across platforms.
 *
 * Update protocol: if a Phase 1-3/5 commit produces a snapshot diff,
 * STOP and root-cause. Snapshot updates require explicit user review.
 * Phase 4 commit may legitimately retire this file entirely.
 */
import { describe, expect, it } from "vitest";
import {
  buildTranscriptRenderModel,
  flattenTranscriptSections,
  type TranscriptRow,
  type TranscriptSection,
} from "./transcript-layout.js";
import { ToolCallStatus, type HistoryItem } from "../types.js";

// === Deterministic fixtures ===
//
// Timestamps are fixed (1_000_000 base) so snapshots stay stable across
// CI runs. No `Date.now()` in fixtures.

const TS = 1_000_000;

function userItem(id: string, text: string): HistoryItem {
  return { id, type: "user", text, timestamp: TS };
}

function assistantItem(id: string, text: string): HistoryItem {
  return { id, type: "assistant", text, timestamp: TS };
}

function thinkingItem(id: string, text: string): HistoryItem {
  return { id, type: "thinking", text, timestamp: TS };
}

function toolGroupItem(id: string, toolName: string, input: unknown): HistoryItem {
  return {
    id,
    type: "tool_group",
    tools: [
      {
        id: `${id}-call`,
        name: toolName,
        status: ToolCallStatus.Success,
        startTime: TS,
        endTime: TS + 50,
        input: input as Record<string, unknown>,
        output: "OK",
      },
    ],
    timestamp: TS,
  };
}

// === Helpers ===

/**
 * Stable text for snapshot — strips locale/timezone-dependent timestamp
 * substrings from row body text. `formatTimestamp()` inside transcript-layout
 * calls `toLocaleTimeString()` which renders differently on every TZ/locale
 * combination; without this scrub, snapshots fail on CI vs author machines.
 * Pattern matches both 12-hour ("08:16 AM") and 24-hour ("08:16") forms.
 */
function scrubTimestamps(text: string): string {
  return text.replace(/\[\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?\]/g, "[<ts>]");
}

function serializeRow(row: TranscriptRow): string {
  const parts: string[] = [];
  parts.push(`key=${row.key}`);
  if (row.itemId !== undefined) parts.push(`itemId=${row.itemId}`);
  if (row.color !== undefined) parts.push(`color=${row.color}`);
  if (row.indent !== undefined && row.indent !== 0) parts.push(`indent=${row.indent}`);
  if (row.bold) parts.push("bold");
  if (row.italic) parts.push("italic");
  if (row.spinner) parts.push("spinner");
  return `[${parts.join(" ")}] ${JSON.stringify(scrubTimestamps(row.text))}`;
}

function serializeSection(section: TranscriptSection): string {
  return [
    `# section: ${section.key}`,
    ...section.rows.map((r) => "  " + serializeRow(r)),
  ].join("\n");
}

function serializeModel(model: {
  staticSections: TranscriptSection[];
  sections: TranscriptSection[];
  previewSections: TranscriptSection[];
  rows: TranscriptRow[];
  previewRows: TranscriptRow[];
}): string {
  const out: string[] = [];
  out.push(`=== STATIC SECTIONS (${model.staticSections.length}) ===`);
  for (const s of model.staticSections) out.push(serializeSection(s));
  out.push(`\n=== ACTIVE SECTIONS (${model.sections.length}) ===`);
  for (const s of model.sections) out.push(serializeSection(s));
  out.push(`\n=== PREVIEW SECTIONS (${model.previewSections.length}) ===`);
  for (const s of model.previewSections) out.push(serializeSection(s));
  out.push(`\n=== FLATTENED ROW COUNT ===`);
  out.push(`active rows: ${model.rows.length}`);
  out.push(`preview rows: ${model.previewRows.length}`);
  out.push(`flattened total: ${
    flattenTranscriptSections([...model.staticSections, ...model.sections, ...model.previewSections]).length
  }`);
  return out.join("\n");
}

// === Scenarios ===

describe("transcript render data-layer golden — FEATURE_172 Layer 0 G1", () => {
  it("empty state — no items, no streaming", () => {
    const model = buildTranscriptRenderModel({
      items: [],
      viewportWidth: 120,
      isLoading: false,
    });
    expect(serializeModel(model)).toMatchSnapshot();
  });

  it("single-turn — user prompt + short assistant response", () => {
    const model = buildTranscriptRenderModel({
      items: [
        userItem("u-1", "What's the capital of France?"),
        assistantItem("a-1", "The capital of France is Paris."),
      ],
      viewportWidth: 120,
      isLoading: false,
    });
    expect(serializeModel(model)).toMatchSnapshot();
  });

  it("multi-turn with tool_group — typical coding session", () => {
    const model = buildTranscriptRenderModel({
      items: [
        userItem("u-1", "Read packages/repl/src/index.ts"),
        toolGroupItem("t-1", "Read", { file_path: "packages/repl/src/index.ts" }),
        assistantItem("a-1", "The file exports the InkREPL entry point."),
        userItem("u-2", "Now read packages/agent/src/index.ts"),
        toolGroupItem("t-2", "Read", { file_path: "packages/agent/src/index.ts" }),
        assistantItem("a-2", "This is the agent framework public API."),
      ],
      viewportWidth: 120,
      isLoading: false,
    });
    expect(serializeModel(model)).toMatchSnapshot();
  });

  it("streaming state — active assistant response in progress", () => {
    const model = buildTranscriptRenderModel({
      items: [
        userItem("u-1", "Explain dependency injection in TypeScript"),
      ],
      viewportWidth: 120,
      isLoading: true,
      isThinking: false,
      streamingResponse: "Dependency injection (DI) is a design pattern\nwhere components",
      showLiveProgressRows: true,
    });
    expect(serializeModel(model)).toMatchSnapshot();
  });

  it("thinking state — model is reasoning, no streamed response yet", () => {
    const model = buildTranscriptRenderModel({
      items: [
        userItem("u-1", "Plan a refactor of the auth module"),
      ],
      viewportWidth: 120,
      isLoading: true,
      isThinking: true,
      thinkingContent: "Let me consider the existing structure first.\nThe auth module has 3 layers.",
      thinkingCharCount: 80,
      showLiveProgressRows: true,
    });
    expect(serializeModel(model)).toMatchSnapshot();
  });

  it("post-thinking — committed thinking item + streaming response", () => {
    const model = buildTranscriptRenderModel({
      items: [
        userItem("u-1", "Refactor the auth module"),
        thinkingItem("th-1", "I'll start by examining the existing structure."),
      ],
      viewportWidth: 120,
      isLoading: true,
      streamingResponse: "First, let's look at the current organization.\nThere are 3 files",
      showLiveProgressRows: true,
    });
    expect(serializeModel(model)).toMatchSnapshot();
  });

  it("narrow viewport — wrap behavior with 60-column width", () => {
    const model = buildTranscriptRenderModel({
      items: [
        userItem(
          "u-1",
          "This is a longer user prompt that will definitely wrap at narrow widths to test the text-wrap behavior",
        ),
        assistantItem(
          "a-1",
          "And here is an assistant response that is also long enough to wrap multiple times across the viewport so we can verify that wrap math stays deterministic",
        ),
      ],
      viewportWidth: 60,
      isLoading: false,
    });
    expect(serializeModel(model)).toMatchSnapshot();
  });

  it("CJK + emoji — wide-char wrap deterministic", () => {
    const model = buildTranscriptRenderModel({
      items: [
        userItem("u-1", "你好,这是一个测试 with mixed 中英文 and 🎉 emoji"),
        assistantItem("a-1", "中文回复:测试通过 ✓ — wide chars render correctly"),
      ],
      viewportWidth: 80,
      isLoading: false,
    });
    expect(serializeModel(model)).toMatchSnapshot();
  });
});
