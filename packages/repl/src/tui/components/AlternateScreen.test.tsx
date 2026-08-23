import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";

const mocks = vi.hoisted(() => {
  const writeRaw = vi.fn(() => true);
  const getRendererInstance = vi.fn();
  const setShellMode = vi.fn();
  const beginShellTransition = vi.fn();
  const setAltScreenActive = vi.fn();
  const clearTextSelection = vi.fn();
  const writeSync = vi.fn();
  const removeExitGuard = vi.fn();
  const removeRendererExitGuard = vi.fn();
  const registerTerminalExitGuard = vi.fn(
    (_listener: () => void) => removeRendererExitGuard,
  );
  const onExit = vi.fn((
    _listener: () => void,
    _options?: { readonly alwaysLast?: boolean },
  ) => removeExitGuard);
  const output = {
    fd: 1,
    isTTY: true,
    columns: 120,
    rows: 40,
    write: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as NodeJS.WriteStream;

  return {
    writeRaw,
    getRendererInstance,
    setShellMode,
    beginShellTransition,
    setAltScreenActive,
    clearTextSelection,
    writeSync,
    removeExitGuard,
    removeRendererExitGuard,
    registerTerminalExitGuard,
    onExit,
    output,
  };
});

vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  writeSync: mocks.writeSync,
}));

vi.mock("signal-exit", () => ({
  onExit: mocks.onExit,
}));

// FEATURE_093 (v0.7.24): AlternateScreen now imports from
// ../renderer-runtime.js directly (not the barrel) to break the tui cycle.
// Mock the concrete path so the stubs are picked up.
vi.mock("../renderer-runtime.js", () => ({
  Box: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useTerminalOutput: () => mocks.output,
  useTerminalSize: () => ({ rows: 40, columns: 120 }),
  useTerminalWrite: () => mocks.writeRaw,
}));

vi.mock("../core/root.js", () => ({
  getRendererInstance: (stdout: NodeJS.WriteStream) => {
    mocks.getRendererInstance(stdout);
    return {
      setShellMode: mocks.setShellMode,
      beginShellTransition: mocks.beginShellTransition,
      setAltScreenActive: mocks.setAltScreenActive,
      clearTextSelection: mocks.clearTextSelection,
      registerTerminalExitGuard: mocks.registerTerminalExitGuard,
    };
  },
}));

import {
  buildAlternateScreenEnterSequence,
  buildAlternateScreenExitSequence,
} from "../core/termio.js";
import { AlternateScreen } from "./AlternateScreen.js";

describe("AlternateScreen", () => {
  beforeEach(() => {
    mocks.writeRaw.mockClear();
    mocks.getRendererInstance.mockClear();
    mocks.setShellMode.mockClear();
    mocks.beginShellTransition.mockClear();
    mocks.setAltScreenActive.mockClear();
    mocks.clearTextSelection.mockClear();
    mocks.writeSync.mockClear();
    mocks.removeExitGuard.mockClear();
    mocks.removeRendererExitGuard.mockClear();
    mocks.registerTerminalExitGuard.mockClear();
    mocks.onExit.mockClear();
  });

  it("uses the renderer-local terminal streams instead of global process.stdout", () => {
    const instance = render(
      <AlternateScreen>
        <></>
      </AlternateScreen>,
    );

    expect(mocks.getRendererInstance).toHaveBeenCalledWith(mocks.output);
    expect(mocks.getRendererInstance).not.toHaveBeenCalledWith(
      process.stdout as unknown as NodeJS.WriteStream,
    );
    expect(mocks.setShellMode).toHaveBeenCalledWith("virtual", true);
    expect(mocks.writeRaw).toHaveBeenCalledWith(
      buildAlternateScreenEnterSequence({ mouseTracking: true, clearOnEnter: false }),
    );
    expect(mocks.setAltScreenActive).toHaveBeenCalledWith(true, true);
    expect(mocks.registerTerminalExitGuard).toHaveBeenCalledWith(expect.any(Function));

    instance.unmount();

    expect(mocks.beginShellTransition).toHaveBeenCalledWith("exit-alt-screen");
    expect(mocks.clearTextSelection).toHaveBeenCalledTimes(1);
    expect(mocks.writeSync).toHaveBeenLastCalledWith(
      1,
      buildAlternateScreenExitSequence({ mouseTracking: true }),
    );
    expect(mocks.removeRendererExitGuard).toHaveBeenCalledTimes(1);
  });

  it("restores the terminal after renderer-owned exit cleanup", () => {
    const instance = render(
      <AlternateScreen>
        <></>
      </AlternateScreen>,
    );
    const shutdownGuard = mocks.onExit.mock.calls[0]?.[0];
    mocks.writeRaw.mockClear();

    expect(mocks.onExit).toHaveBeenCalledWith(expect.any(Function), { alwaysLast: true });
    expect(shutdownGuard).toBeDefined();
    shutdownGuard?.();

    expect(mocks.writeSync).toHaveBeenCalledWith(
      1,
      buildAlternateScreenExitSequence({ mouseTracking: true }),
    );
    instance.unmount();
    expect(mocks.removeExitGuard).toHaveBeenCalledTimes(1);
    expect(mocks.removeRendererExitGuard).toHaveBeenCalledTimes(1);
    expect(mocks.writeSync).toHaveBeenCalledTimes(1);
  });

  it("keeps terminal cleanup armed when the enter write reports backpressure", () => {
    mocks.writeRaw.mockReturnValueOnce(false);
    const instance = render(
      <AlternateScreen>
        <></>
      </AlternateScreen>,
    );

    expect(mocks.setAltScreenActive).toHaveBeenCalledWith(true, true);
    expect(mocks.registerTerminalExitGuard).toHaveBeenCalledTimes(1);
    instance.unmount();
    expect(mocks.writeSync).toHaveBeenCalledWith(
      1,
      buildAlternateScreenExitSequence({ mouseTracking: true }),
    );
  });
});
