import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { killChildProcessTreeMock } = vi.hoisted(() => ({
  killChildProcessTreeMock: vi.fn(),
}));

vi.mock("@kodax-ai/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@kodax-ai/agent")>()),
  killChildProcessTree: killChildProcessTreeMock,
}));

const {
  createRuntimeDaemonStartupProcess,
  RuntimeDaemonProcessCleanupIncompleteError,
} = await import("./process.js");

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    pid: 4_242,
    exitCode: 0,
    signalCode: null,
    unref: vi.fn(),
  });
  return child;
}

describe("Runtime daemon startup process cleanup", () => {
  beforeEach(() => {
    killChildProcessTreeMock.mockReset();
  });

  it("accepts an unknown tree result after the root has already exited", async () => {
    killChildProcessTreeMock.mockResolvedValue({ status: "unknown" });
    const processHandle = createRuntimeDaemonStartupProcess(
      fakeChild(),
      Promise.resolve({ code: 0, signal: null }),
    );

    await expect(processHandle.terminate()).resolves.toBeUndefined();
  });

  it("accepts a verified tree result after the root has exited", async () => {
    killChildProcessTreeMock.mockResolvedValue({ status: "terminated" });
    const processHandle = createRuntimeDaemonStartupProcess(
      fakeChild(),
      Promise.resolve({ code: 0, signal: null }),
    );

    await expect(processHandle.terminate()).resolves.toBeUndefined();
  });

  it("accepts an already-exited tree only after the exit promise is settled", async () => {
    killChildProcessTreeMock.mockResolvedValue({ status: "already-exited" });
    const processHandle = createRuntimeDaemonStartupProcess(
      fakeChild(),
      Promise.resolve({ code: 0, signal: null }),
    );

    await expect(processHandle.terminate()).resolves.toBeUndefined();
  });
});
