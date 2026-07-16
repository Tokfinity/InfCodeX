import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";

// Avoid real process-level side effects from the live engine in tests.
vi.mock("signal-exit", () => ({ onExit: vi.fn(() => vi.fn()) }));
vi.mock("patch-console", () => ({ default: vi.fn(() => vi.fn()) }));
vi.mock("is-in-ci", () => ({ default: false }));

import { render, getRendererInstance } from "./root.js";
import { Box, Text } from "../renderer-runtime.js";

/**
 * FEATURE_214 — prove the EXPOSURE CHAIN, not just the Engine. The engine method,
 * the renderer.ts handle forwarding (EngineInstance / RendererInstanceHandle /
 * KodaXRenderer), the root.tsx interface, and getRendererInstance(stdout) must ALL
 * line up so `getRendererInstance(stdout)?.commitInlineScrollback` actually reaches
 * the live engine and writes to the terminal.
 */
function fakeStdout() {
  const writes: string[] = [];
  const stdout = {
    isTTY: true,
    rows: 6,
    columns: 80,
    write: (chunk: string) => {
      writes.push(String(chunk));
      return true;
    },
    on: () => stdout,
    off: () => stdout,
  } as unknown as NodeJS.WriteStream;
  return { stdout, writes };
}

function fakeStdin() {
  return {
    isTTY: true,
    isRaw: false,
    setRawMode: () => {},
    on: () => {},
    off: () => {},
    pause: () => {},
    resume: () => {},
    ref: () => {},
    unref: () => {},
  } as unknown as NodeJS.ReadStream;
}

describe("commitInlineScrollback exposure chain (FEATURE_214)", () => {
  const mounted: Array<{ unmount: (e?: unknown) => void }> = [];
  afterEach(() => {
    while (mounted.length) {
      try {
        mounted.pop()?.unmount();
      } catch {
        // best effort
      }
    }
  });

  it("getRendererInstance(stdout).commitInlineScrollback is a function (not undefined)", () => {
    const { stdout } = fakeStdout();
    const instance = render(
      <Box>
        <Text>x</Text>
      </Box>,
      { stdout, stdin: fakeStdin(), shellMode: "main-screen", exitOnCtrlC: false, patchConsole: false } as never,
    );
    mounted.push(instance);

    const handle = getRendererInstance(stdout);
    expect(handle).toBeDefined();
    expect(typeof handle?.commitInlineScrollback).toBe("function");
  });

  it("calling it reaches the live engine and writes the history text to stdout", () => {
    const { stdout, writes } = fakeStdout();
    const instance = render(
      <Box>
        <Text>live</Text>
      </Box>,
      { stdout, stdin: fakeStdin(), shellMode: "main-screen", exitOnCtrlC: false, patchConsole: false } as never,
    );
    mounted.push(instance);

    writes.length = 0;
    getRendererInstance(stdout)?.commitInlineScrollback?.({
      mode: "append",
      text: "PROOF-OF-DEPTH\n",
    });

    // The engine's commitInlineScrollback ran end-to-end → the history text landed
    // on the terminal (proving the forwarding chain, not just the Engine method).
    expect(writes.join("")).toContain("PROOF-OF-DEPTH\n");
  });
});
