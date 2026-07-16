import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  resolveMemoryRoot,
  setAgentConfigHome,
} from "@kodax-ai/agent";

import { removeTempDirSync } from "../../test-utils/temp-dir.js";
import { ToolCallStatus, type ToolCall } from "../types.js";
import {
  collapseToolCalls,
  formatCollapsedToolInlineText,
  formatLiveToolLabel,
  formatToolCallInlineText,
  formatToolFailureExplanation,
  formatToolResultExplanation,
  formatToolSummary,
} from "./tool-display.js";

describe("tool-display", () => {
  it("formats changed_diff_bundle summaries with file counts and limits", () => {
    expect(formatToolSummary(
      "[Planner] changed_diff_bundle",
      { preview: "{\"paths\":[\"packages/a.ts\",\"packages/b.ts\"],\"limit_per_path\":120}" },
    )).toBe("[Planner] changed_diff_bundle - 2 files - packages/a.ts - limit=120");
  });

  it("formats changed_diff summaries with path, offset, and limit", () => {
    expect(formatToolSummary(
      "changed_diff",
      { preview: "{\"path\":\"packages/coding/src/task-engine.ts\",\"offset\":220,\"limit\":120}" },
    )).toBe("changed_diff - packages/coding/src/task-engine.ts - offset=220 - limit=120");
  });

  it("formats inline tool text with compact duration", () => {
    const tool: ToolCall = {
      id: "tool-1",
      name: "[Planner] changed_diff_bundle",
      status: ToolCallStatus.Success,
      startTime: 100,
      endTime: 218,
      input: {
        preview: "{\"paths\":[\"packages/coding/src/task-engine.ts\"],\"limit_per_path\":120}",
      },
    };

    expect(formatToolCallInlineText(tool))
      .toBe("[Planner] changed_diff_bundle - packages/coding/src/task-engine.ts - limit=120 (118ms)");
  });

  it("formats awaiting-approval tool text with explicit status detail", () => {
    const tool: ToolCall = {
      id: "tool-awaiting",
      name: "write_file",
      status: ToolCallStatus.AwaitingApproval,
      startTime: 100,
    };

    expect(formatToolCallInlineText(tool)).toBe("write_file (awaiting approval)");
  });

  it("formats completed diff tools from their output details", () => {
    const tool: ToolCall = {
      id: "tool-2",
      name: "[Lead] Lead:changed_diff",
      status: ToolCallStatus.Success,
      startTime: 100,
      endTime: 211,
      input: {
        preview: "{\"path\":\"packages/coding/src/task-engine.ts\",\"offset\":1171,\"limit\":150}",
      },
      output: [
        "Changed diff for packages/coding/src/task-engine.ts",
        "Context lines: 3",
        "Showing diff lines 1171-1320 of 3096",
      ].join("\n"),
    };

    expect(formatToolCallInlineText(tool))
      .toBe("[Lead] changed_diff - packages/coding/src/task-engine.ts - 1171-1320/3096 (111ms)");
  });

  it("formats live tool labels from streamed input previews", () => {
    expect(formatLiveToolLabel(
      "changed_diff_bundle",
      "{\"paths\":[\"packages/coding/src/task-engine.ts\"],\"limit_per_path\":120}",
      72,
    )).toBe("[Tools] changed_diff_bundle - packages/coding/src/task-engine.ts - limit=120");
  });

  it("formats bash summaries with the exact command", () => {
    expect(formatToolSummary(
      "bash",
      { command: "git status --short" },
    )).toBe("bash - cmd=git status --short");
  });

  it("keeps longer command targets visible in bash summaries", () => {
    const command = "node scripts/run-task.js --workspace packages/repl --file packages/repl/src/ui/InkREPL.tsx --pattern activeToolCalls";

    expect(formatToolSummary("bash", { command })).toContain("packages/repl/src/ui/InkREPL.tsx");
  });

  it("formats glob summaries with pattern and scope", () => {
    expect(formatToolSummary(
      "glob",
      { pattern: "**/*.ts", path: "packages/coding/src" },
    )).toBe("glob - pattern=**/*.ts - packages/coding/src");
  });

  it("formats grep summaries with pattern and scope", () => {
    expect(formatToolSummary(
      "grep",
      { pattern: "H2_PLAN_EXECUTE_EVAL", path: "packages/coding/src" },
    )).toBe("grep - pattern=H2_PLAN_EXECUTE_EVAL - packages/coding/src");
  });

  it("formats web_search summaries with query and provider", () => {
    expect(formatToolSummary(
      "web_search",
      { query: "kodax ama tactical fanout", provider_id: "web-cap" },
    )).toBe("web_search - query=kodax ama tactical fanout - provider=web-cap");
  });

  it("formats web_fetch summaries with url", () => {
    expect(formatToolSummary(
      "web_fetch",
      { url: "https://example.com/spec" },
    )).toBe("web_fetch - https://example.com/spec");
  });

  it("formats semantic_lookup summaries with query and target path", () => {
    expect(formatToolSummary(
      "semantic_lookup",
      { query: "NameService", target_path: "packages/app" },
    )).toBe("semantic_lookup - query=NameService - packages/app");
  });

  it("formats code_search summaries with provider", () => {
    expect(formatToolSummary(
      "code_search",
      { query: "NameService", provider_id: "provider-1" },
    )).toBe("code_search - query=NameService - provider=provider-1");
  });

  it("formats mcp_search summaries with server and kind", () => {
    expect(formatToolSummary(
      "mcp_search",
      { query: "filesystem", server: "local-fs", kind: "tool", limit: 4 },
    )).toBe("mcp_search - query=filesystem - server=local-fs - kind=tool - limit=4");
  });

  it("formats mcp_describe summaries with capability id", () => {
    expect(formatToolSummary(
      "mcp_describe",
      { id: "mcp:local-fs:tool:read_file" },
    )).toBe("mcp_describe - mcp:local-fs:tool:read_file");
  });

  it("formats mcp_call summaries with arg count", () => {
    expect(formatToolSummary(
      "mcp_call",
      { id: "mcp:local-fs:tool:read_file", args: { path: "README.md", mode: "text" } },
    )).toBe("mcp_call - mcp:local-fs:tool:read_file - args=2");
  });

  it("formats skill summaries with the resolved skill name (FEATURE_246 review)", () => {
    expect(formatToolSummary(
      "skill",
      { skill: "code-review", args: "--focus security" },
    )).toBe("skill - code-review");
  });

  it("collapses repeated tool calls into a single summary", () => {
    const groups = collapseToolCalls([
      {
        id: "tool-1",
        name: "changed_diff_bundle",
        status: ToolCallStatus.Executing,
        startTime: 100,
        input: {
          preview: "{\"paths\":[\"packages/coding/src/task-engine.ts\"],\"limit_per_path\":120}",
        },
      },
      {
        id: "tool-2",
        name: "changed_diff_bundle",
        status: ToolCallStatus.Success,
        startTime: 120,
        endTime: 238,
        input: {
          preview: "{\"paths\":[\"packages/coding/src/task-engine.ts\"],\"limit_per_path\":120}",
        },
      },
    ]);

    expect(groups).toHaveLength(1);
    expect(formatCollapsedToolInlineText(groups[0]!))
      .toBe("changed_diff_bundle - packages/coding/src/task-engine.ts - limit=120 (118ms) x2");
  });

  it("builds compact failure explanations from error and output", () => {
    const tool: ToolCall = {
      id: "tool-fail",
      name: "bash",
      status: ToolCallStatus.Error,
      startTime: 100,
      error: "permission denied",
      output: "fatal: permission denied\nsee more details in debug log",
    };

    expect(formatToolFailureExplanation(tool)).toEqual([
      "Error: permission denied",
      "Last output: fatal: permission denied",
    ]);
  });

  it("builds compact diff explanations for successful changed_diff tools", () => {
    const tool: ToolCall = {
      id: "tool-diff",
      name: "changed_diff",
      status: ToolCallStatus.Success,
      startTime: 100,
      endTime: 210,
      output: [
        "Changed diff for packages/coding/src/task-engine.ts",
        "Showing diff lines 1171-1320 of 3096",
        "+ const example = true;",
      ].join("\n"),
    };

    expect(formatToolResultExplanation(tool)).toEqual([
      "Diff range: 1171-1320 of 3096",
      "Preview: + const example = true;",
    ]);
  });

  it("builds compact bundle explanations for successful changed_diff_bundle tools", () => {
    const tool: ToolCall = {
      id: "tool-bundle",
      name: "[Planner] changed_diff_bundle",
      status: ToolCallStatus.Success,
      startTime: 100,
      endTime: 210,
      output: [
        "Changed diff bundle for 3 file(s)",
        "=== packages/a.ts ===",
        "+ const a = 1;",
      ].join("\n"),
    };

    expect(formatToolResultExplanation(tool)).toEqual([
      "Bundle: 3 files",
      "First file: packages/a.ts",
    ]);
  });

  it("builds progress explanations for long-running executing tools", () => {
    const tool: ToolCall = {
      id: "tool-progress",
      name: "bash",
      status: ToolCallStatus.Executing,
      startTime: 100,
      progress: 50,
    };

    expect(formatToolResultExplanation(tool)).toEqual([
      "Progress: 50% complete",
    ]);
  });

  it("builds waiting explanations for tools blocked on approval", () => {
    const tool: ToolCall = {
      id: "tool-awaiting",
      name: "write_file",
      status: ToolCallStatus.AwaitingApproval,
      startTime: 100,
    };

    expect(formatToolResultExplanation(tool)).toEqual([
      "Waiting: approval required before execution",
    ]);
  });
});

describe("FEATURE_124 Phase D.2 — memory badge in tool-display", () => {
  let tempHome: string;
  let memoryDir: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "kodax-tool-display-home-"));
    setAgentConfigHome(tempHome);
    // Resolve a real memory dir under the temp home so isAutoManagedMemoryFile
    // recognizes it. cwd is irrelevant — the predicate inspects the path,
    // not the filesystem, so we don't need to create the dir on disk.
    const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "kodax-tool-display-cwd-"));
    memoryDir = resolveMemoryRoot(tempCwd);
    removeTempDirSync(tempCwd);
  });

  afterEach(() => {
    setAgentConfigHome(undefined);
    removeTempDirSync(tempHome);
  });

  it("prefixes [memory:feedback] when Write target is a feedback_*.md file in memory dir", () => {
    const memoryPath = path.join(memoryDir, "feedback_no_mock_db.md");
    const summary = formatToolSummary("Write", { path: memoryPath });
    expect(summary).toContain("[memory:feedback]");
    // truncateValue caps path at 120 chars; the windows tempdir + sanitized
    // project key make the full path > 120 chars in this test, so the
    // basename is mid-cut. Assert the load-bearing structural signals:
    // the badge is present, ordered before the path payload, and the
    // path payload begins with the badge marker (Write - [memory:...] -).
    expect(summary).toMatch(/^Write - \[memory:feedback\] - /);
  });

  it("prefixes [memory:user] for user_*.md files", () => {
    const memoryPath = path.join(memoryDir, "user_role.md");
    expect(formatToolSummary("Read", { path: memoryPath })).toContain("[memory:user]");
  });

  it("prefixes [memory:project] for project_*.md and [memory:reference] for reference_*.md", () => {
    expect(
      formatToolSummary("Read", { path: path.join(memoryDir, "project_q2.md") }),
    ).toContain("[memory:project]");
    expect(
      formatToolSummary("Read", { path: path.join(memoryDir, "reference_grafana.md") }),
    ).toContain("[memory:reference]");
  });

  it("falls back to bare [memory] for memory-dir files that don't match the naming convention", () => {
    const memoryPath = path.join(memoryDir, "MEMORY.md");
    const summary = formatToolSummary("Read", { path: memoryPath });
    // MEMORY.md doesn't match user_/feedback_/project_/reference_ prefix
    // → parseMemoryTypeFromFilename returns undefined → fallback to [memory].
    expect(summary).toContain("[memory]");
    expect(summary).not.toContain("[memory:");
  });

  it("does NOT prefix any badge for paths OUTSIDE the memory directory (absolute path)", () => {
    // Absolute path outside agent home — pure sentinel for false-positives.
    // Using absolute path avoids cwd-dependent reasoning (relative path
    // would be `path.resolve`'d against process.cwd which may or may not
    // happen to be inside the agent home in some test environments).
    const outsidePath = path.join(os.tmpdir(), "kodax-project-foo", "src", "engine.ts");
    const summary = formatToolSummary("Read", { path: outsidePath });
    expect(summary).not.toMatch(/\[memory(:[a-z]+)?\]/);
  });

  it("badges non-.md files under memory dir with bare [memory] (Tier-2 directory match)", () => {
    // Tier 2 directory-level match: ANY file inside <projects>/<key>/
    // memory/ gets a bare `[memory]` badge, even if not .md. Rationale:
    // a Read/Write on a non-.md file under memory dir is still memory
    // subsystem engagement (e.g. a future session-state sidecar). The
    // Tier-1 type-aware badge (`[memory:feedback]`) only fires for .md
    // files with the naming convention — those are the LLM-managed
    // taxonomy entries.
    const memoryJsonPath = path.join(memoryDir, "session-state.json");
    const summary = formatToolSummary("Read", { path: memoryJsonPath });
    expect(summary).toContain("[memory]");
    expect(summary).not.toMatch(/\[memory:/); // no type suffix
  });

  it("badges glob scope when it points at the memory directory (inline render path)", () => {
    // Glob has its own inline summarizer that bypasses pushPathSummary —
    // verifies the badge injection in glob's case block (line ~358).
    // Use the bare memory directory as the scope (per the actual prompt-
    // taught usage: "Use Glob to scan the memory directory").
    const summary = formatToolSummary("Glob", { pattern: "*.md", path: memoryDir });
    expect(summary).toContain("[memory]"); // memoryDir itself has no
    // type-prefixed name; falls back to bare [memory]
  });

  it("badges grep scope when it points at a memory-dir file (inline render path)", () => {
    // Grep is the tool the GC section explicitly teaches for due-diligence
    // duplicate checks. Verifies the badge injection in grep's case block
    // (line ~376). Use a specific topic file as the scope (a possible
    // shape when the LLM greps inside a single memory file).
    const memoryPath = path.join(memoryDir, "feedback_no_mock_db.md");
    const summary = formatToolSummary("Grep", { pattern: "mock", path: memoryPath });
    expect(summary).toMatch(/\[memory:feedback\]/);
  });

  it("badges via the pushPathSummary preferPathsArray single-element branch (Write fallthrough)", () => {
    // pushPathSummary has 3 badge-injection branches: (i) preferPathsArray
    // + 1-item paths, (ii) explicitPath, (iii) paths-fallback + 1-item.
    // All 6 happy-path tests above exercise (ii). This test routes through
    // the default fallthrough in summarizeToolDetails (line ~478) which
    // calls pushPathSummary with preferPathsArray=true — exercising
    // branch (i). Use `Write` because it's not a recognized special-case
    // tool name, so it falls through to default.
    const memoryPath = path.join(memoryDir, "user_role.md");
    const summary = formatToolSummary("Write", { paths: [memoryPath] });
    expect(summary).toMatch(/\[memory:user\]/);
  });

  it("threads the badge through formatCollapsedToolInlineText too", () => {
    const memoryPath = path.join(memoryDir, "feedback_no_mock_db.md");
    const tool: ToolCall = {
      id: "tool-memwrite",
      name: "Write",
      status: ToolCallStatus.Success,
      startTime: 100,
      endTime: 250,
      input: { path: memoryPath },
    };
    const [group] = collapseToolCalls([tool]);
    expect(formatCollapsedToolInlineText(group!)).toContain("[memory:feedback]");
  });
});
