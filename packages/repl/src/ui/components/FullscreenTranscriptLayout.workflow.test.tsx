import { EventEmitter } from "node:events";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("signal-exit", () => ({ onExit: vi.fn(() => vi.fn()) }));
vi.mock("patch-console", () => ({ default: vi.fn(() => vi.fn()) }));
vi.mock("is-in-ci", () => ({ default: false }));

import { Box, render, Text } from "../tui.js";
import { getRendererInstance } from "../../tui/core/root.js";
import { TerminalModel } from "../../tui/substrate/ink/terminal-emulator.js";
import { calculateViewportBudget } from "../utils/viewport-budget.js";
import { buildWorkflowLiveViewModel } from "../view-models/workflow-live.js";
import {
  measureWorkflowRunSurfaceRows,
  WorkflowRunSurface,
} from "./WorkflowRunSurface.js";
import { FullscreenTranscriptLayout } from "./FullscreenTranscriptLayout.js";
import { PromptFooter } from "./PromptFooter.js";
import { TextInput } from "./TextInput.js";

class MockInput extends EventEmitter {
  isTTY = true;
  isRaw = false;

  setRawMode(enabled: boolean): void {
    this.isRaw = enabled;
  }

  pause(): void {}
  resume(): void {}
}

class MockOutput extends EventEmitter {
  isTTY = true;
  writes: string[] = [];

  constructor(
    public columns: number,
    public rows: number,
  ) {
    super();
  }

  write = (chunk: string | Uint8Array): boolean => {
    this.writes.push(String(chunk));
    return true;
  };
}

const STATUS = "KodaX workflow footer pinned status";

function workflowViewModel() {
  return buildWorkflowLiveViewModel({
    runId: "run-mqc7av6y",
    workflow: "feature-217-workflow-footer-layout-regression-audit",
    status: "running",
    phase: "collecting-renderer-budget-and-completion-state-evidence",
    phaseIndex: 2,
    phaseTotal: 5,
    activeAgents: [
      "layout-auditor-with-long-running-workflow-name",
      "footer-budget-cross-checker",
    ],
    totalSpawned: 6,
    plannedAgents: 6,
    completedAgents: 3,
    failedAgents: 0,
    stoppedAgents: 0,
    message: "show: /workflow show run-mqc7av6y | stop: /workflow stop run-mqc7av6y",
  });
}

function transcriptRows(count: number): readonly string[] {
  return Array.from(
    { length: count },
    (_, index) => `transcript row ${String(index + 1).padStart(2, "0")}`,
  );
}

function TestApp({
  columns,
  rows,
  running,
}: {
  columns: number;
  rows: number;
  running: boolean;
}) {
  const workflow = workflowViewModel();
  const activityText = `Workflow ${workflow.workflow} - ${workflow.phase}`;
  const workflowRows = running
    ? measureWorkflowRunSurfaceRows(workflow)
    : 0;
  const budget = calculateViewportBudget({
    terminalRows: rows,
    terminalWidth: columns,
    windowedTranscript: true,
    inputText: "",
    suggestionsReserved: false,
    showHelp: false,
    statusBarText: STATUS,
    activitySummary: running ? activityText : undefined,
    activityBarVisible: running,
    workflowSurfaceRows: workflowRows,
  });
  const rowsToRender = transcriptRows(80);

  const footer = (
    <PromptFooter
      activityBar={running ? (
        <Box paddingX={1} flexDirection="row">
          <Box flexGrow={1}>
            <Text wrap="truncate">{activityText}</Text>
          </Box>
          <Text dimColor wrap="truncate">{workflow.counterText}</Text>
        </Box>
      ) : undefined}
      todoSurface={running ? (
        <Box paddingX={1}>
          <WorkflowRunSurface viewModel={workflow} />
        </Box>
      ) : undefined}
      composer={(
        <TextInput
          lines={[""]}
          cursorRow={0}
          cursorCol={0}
          prompt=">"
          placeholder="Type a message..."
          focus
          terminalFocused
          width={columns}
        />
      )}
      statusLine={<Box><Text>{STATUS}</Text></Box>}
    />
  );

  return (
    <Box
      flexDirection="column"
      height={rows}
      width={columns}
      flexGrow={1}
      flexShrink={0}
    >
      <FullscreenTranscriptLayout
        width={columns}
        scrollTop={0}
        scrollHeight={rowsToRender.length}
        viewportHeight={budget.messageRows}
        stickyScroll
        footer={footer}
        renderTranscriptWindow={(window) => (
          <Box flexDirection="column">
            {rowsToRender.slice(window.start, window.end).map((line) => (
              <Text key={line}>{line}</Text>
            ))}
          </Box>
        )}
      />
    </Box>
  );
}

describe("FullscreenTranscriptLayout workflow footer completion", () => {
  const mounted: Array<{ unmount: () => void; cleanup: () => void }> = [];

  afterEach(() => {
    while (mounted.length > 0) {
      const instance = mounted.pop();
      instance?.unmount();
      instance?.cleanup();
    }
  });

  it("keeps the status row pinned after workflow footer collapses across resize widths", () => {
    const stdout = new MockOutput(120, 32);
    const stderr = new MockOutput(120, 32);
    const stdin = new MockInput();
    const model = new TerminalModel(stdout.columns, stdout.rows);
    let appliedWrites = 0;
    const drain = () => {
      const next = stdout.writes.slice(appliedWrites).join("");
      appliedWrites = stdout.writes.length;
      model.apply(next);
    };

    const instance = render(
      <TestApp columns={120} rows={32} running />,
      {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: stderr as unknown as NodeJS.WriteStream,
        stdin: stdin as unknown as NodeJS.ReadStream,
        shellMode: "virtual",
        exitOnCtrlC: false,
        patchConsole: false,
        maxFps: 0,
      },
    );
    mounted.push(instance);
    drain();
    getRendererInstance(stdout as unknown as NodeJS.WriteStream)?.setAltScreenActive?.(true, false);
    instance.rerender(<TestApp columns={120} rows={32} running />);
    drain();

    instance.rerender(<TestApp columns={120} rows={32} running={false} />);
    drain();
    expect(model.allRows()[31]).toContain(STATUS);

    stdout.columns = 82;
    stderr.columns = 82;
    stdout.emit("resize");
    instance.rerender(<TestApp columns={82} rows={32} running={false} />);
    drain();
    expect(model.allRows()[31]).toContain(STATUS);

    stdout.columns = 120;
    stderr.columns = 120;
    stdout.emit("resize");
    instance.rerender(<TestApp columns={120} rows={32} running={false} />);
    drain();
    expect(model.allRows()[31]).toContain(STATUS);
  });
});
