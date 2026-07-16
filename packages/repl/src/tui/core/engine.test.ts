import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const renderTree = vi.fn();
  const stdoutWrite = vi.fn();
  const stderrWrite = vi.fn();
  const stdoutOn = vi.fn();
  const stdoutOff = vi.fn();
  const stdout = {
    isTTY: true,
    rows: 4,
    columns: 80,
    write: stdoutWrite,
    on: stdoutOn,
    off: stdoutOff,
  } as unknown as NodeJS.WriteStream;
  const stdin = {
    isTTY: true,
    isRaw: false,
    setRawMode: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  } as unknown as NodeJS.ReadStream;
  const stderr = {
    write: stderrWrite,
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as NodeJS.WriteStream;

  return {
    renderTree,
    stdout,
    stdin,
    stderr,
    stdoutWrite,
    stderrWrite,
    stdoutOn,
    stdoutOff,
  };
});

vi.mock("is-in-ci", () => ({
  default: false,
}));

vi.mock("signal-exit", () => ({
  onExit: vi.fn(() => vi.fn()),
}));

vi.mock("patch-console", () => ({
  default: vi.fn(() => vi.fn()),
}));

vi.mock("./utils.js", () => ({
  isDev: () => false,
}));

vi.mock("./internals/reconciler.js", () => ({
  default: {
    createContainer: vi.fn(() => ({})),
    updateContainer: vi.fn(),
    updateContainerSync: vi.fn(),
    flushSyncWork: vi.fn(),
    injectIntoDevTools: vi.fn(),
  },
}));

vi.mock("./internals/renderer.js", () => ({
  default: mocks.renderTree,
}));

vi.mock("./internals/dom.js", () => ({
  createNode: vi.fn(() => ({
    yogaNode: {
      setWidth: vi.fn(),
      calculateLayout: vi.fn(),
    },
  })),
}));

vi.mock("./write-synchronized.js", () => ({
  bsu: "<bsu>",
  esu: "<esu>",
  shouldSynchronize: vi.fn(() => false),
}));

vi.mock("./instances.js", () => ({
  default: {
    add: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("./components/App.js", () => ({
  default: vi.fn(() => null),
}));

vi.mock("./contexts/AccessibilityContext.js", () => ({
  accessibilityContext: {},
}));

vi.mock("./kitty-keyboard.js", () => ({
  resolveFlags: vi.fn(() => 0),
}));

vi.mock("terminal-size", () => ({
  default: vi.fn(() => ({ columns: 80, rows: 24 })),
}));

import Engine from "./engine.js";
import { createScreen } from "../substrate/ink/cell-screen.js";
import {
  TerminalModel,
  frameFromRows,
} from "../substrate/ink/terminal-emulator.js";
import ansiEscapes from "ansi-escapes";
import { shouldSynchronize } from "./write-synchronized.js";

/**
 * Build the renderer.js return shape with a fully-populated `frame` so the
 * cell-renderer dispatch path runs. Phase 6 (v0.7.30) made cell renderer
 * the sole render path — every onRender on a non-screen-reader, non-debug,
 * non-CI engine should produce a Frame and route through `applyCellFrame`.
 */
function fakeRenderResult(width: number, height: number, output: string) {
  return {
    output,
    outputHeight: height,
    staticOutput: "",
    frame: {
      screen: createScreen(width, height),
      viewport: { width: 80, height: 24 },
      cursor: { x: 0, y: height, visible: true },
    },
  };
}

describe("tui engine (Phase 6: cell renderer is sole render path)", () => {
  type ManagedExternalWriteEngine = {
    onRender: () => void;
    setAltScreenActive: (active: boolean) => void;
    writeToStdout: (data: string) => void;
    writeToStderr: (data: string) => void;
    prevFrame: { screen: { height: number } };
  };

  const makeManagedExternalWriteEngine = (): ManagedExternalWriteEngine =>
    new Engine({
      stdout: mocks.stdout,
      stdin: mocks.stdin,
      stderr: mocks.stderr,
      shellMode: "virtual",
      exitOnCtrlC: false,
      patchConsole: false,
      kittyKeyboard: { mode: "disabled" },
    } as ConstructorParameters<typeof Engine>[0]) as unknown as ManagedExternalWriteEngine;

  const seedManagedExternalFrame = (engine: ManagedExternalWriteEngine) => {
    mocks.renderTree.mockReturnValue(fakeRenderResult(80, 2, "status\ninput"));
    engine.setAltScreenActive(true);
    engine.onRender();
    expect(engine.prevFrame.screen.height).toBe(2);
    mocks.stdoutWrite.mockClear();
  };

  beforeEach(() => {
    (mocks.stdout as unknown as { write: typeof mocks.stdoutWrite }).write = mocks.stdoutWrite;
    (mocks.stderr as unknown as { write: typeof mocks.stderrWrite }).write = mocks.stderrWrite;
    mocks.renderTree.mockReset();
    mocks.stdoutWrite.mockClear();
    mocks.stderrWrite.mockClear();
    mocks.stdoutOn.mockClear();
    mocks.stdoutOff.mockClear();
  });

  it("main-screen: onRender writes through cell renderer (stdout receives bytes)", () => {
    mocks.renderTree.mockReturnValue(
      fakeRenderResult(80, 4, ["line 1", "line 2", "line 3", "line 4"].join("\n")),
    );

    const engine = new Engine({
      stdout: mocks.stdout,
      stdin: mocks.stdin,
      stderr: mocks.stderr,
      shellMode: "main-screen",
      exitOnCtrlC: false,
      patchConsole: false,
      kittyKeyboard: { mode: "disabled" },
    } as ConstructorParameters<typeof Engine>[0]) as unknown as {
      onRender: () => void;
    };

    engine.onRender();

    // Cell renderer wrote at least once to stdout via applyDiff.
    expect(mocks.stdoutWrite).toHaveBeenCalled();
  });

  it("does not replay the full UI after stdout writes while on the main screen", () => {
    const engine = new Engine({
      stdout: mocks.stdout,
      stdin: mocks.stdin,
      stderr: mocks.stderr,
      shellMode: "main-screen",
      exitOnCtrlC: false,
      patchConsole: false,
      kittyKeyboard: { mode: "disabled" },
    } as ConstructorParameters<typeof Engine>[0]) as unknown as {
      writeToStdout: (data: string) => void;
    };

    engine.writeToStdout("external log line\n");

    // Main-screen / non-virtual shell: the !shouldRestore branch writes
    // `data` only (no erase + replay). Asserted via the exact byte sequence
    // landing on stdout.
    expect(mocks.stdoutWrite).toHaveBeenCalledTimes(1);
    expect(mocks.stdoutWrite).toHaveBeenCalledWith("external log line\n");
  });

  it("does not replay the UI before virtual shell ownership is actually active", () => {
    const engine = new Engine({
      stdout: mocks.stdout,
      stdin: mocks.stdin,
      stderr: mocks.stderr,
      shellMode: "main-screen",
      exitOnCtrlC: false,
      patchConsole: false,
      kittyKeyboard: { mode: "disabled" },
    } as ConstructorParameters<typeof Engine>[0]) as unknown as {
      setShellMode: (mode: "virtual" | "main-screen") => void;
      writeToStdout: (data: string) => void;
    };

    engine.setShellMode("virtual");
    mocks.stdoutWrite.mockClear();
    engine.writeToStdout("external log line\n");

    // setShellMode("virtual") without altScreenActive: virtual ownership is
    // not yet active, so the !shouldRestore branch fires and only the data
    // hits stdout (no erase + replay).
    expect(mocks.stdoutWrite).toHaveBeenCalledTimes(1);
    expect(mocks.stdoutWrite).toHaveBeenCalledWith("external log line\n");
  });

  it("does not write to stdout just because shell mode flips to virtual before alt-screen ownership", () => {
    const engine = new Engine({
      stdout: mocks.stdout,
      stdin: mocks.stdin,
      stderr: mocks.stderr,
      shellMode: "main-screen",
      exitOnCtrlC: false,
      patchConsole: false,
      kittyKeyboard: { mode: "disabled" },
    } as ConstructorParameters<typeof Engine>[0]) as unknown as {
      setShellMode: (mode: "virtual" | "main-screen") => void;
    };

    engine.setShellMode("virtual");

    // No alt-screen → no virtual ownership → no resetOutputTracking → no
    // stdout side effect.
    expect(mocks.stdoutWrite).not.toHaveBeenCalled();
  });

  it("does not write to stdout just because an alt-screen transition starts", () => {
    const engine = new Engine({
      stdout: mocks.stdout,
      stdin: mocks.stdin,
      stderr: mocks.stderr,
      shellMode: "main-screen",
      exitOnCtrlC: false,
      patchConsole: false,
      kittyKeyboard: { mode: "disabled" },
    } as ConstructorParameters<typeof Engine>[0]) as unknown as {
      beginShellTransition: (phase: "enter-alt-screen" | "exit-alt-screen") => void;
    };

    engine.beginShellTransition("enter-alt-screen");

    // beginShellTransition only sets shellTransitionPhase; no terminal
    // output should fire.
    expect(mocks.stdoutWrite).not.toHaveBeenCalled();
  });

  it("pre-alt-screen virtual shells: onRender writes through cell renderer (stdout receives bytes)", () => {
    mocks.renderTree.mockReturnValue(
      fakeRenderResult(80, 4, ["line 1", "line 2", "line 3", "line 4"].join("\n")),
    );

    const engine = new Engine({
      stdout: mocks.stdout,
      stdin: mocks.stdin,
      stderr: mocks.stderr,
      shellMode: "virtual",
      exitOnCtrlC: false,
      patchConsole: false,
      kittyKeyboard: { mode: "disabled" },
    } as ConstructorParameters<typeof Engine>[0]) as unknown as {
      onRender: () => void;
    };

    engine.onRender();

    expect(mocks.stdoutWrite).toHaveBeenCalled();
  });

  it("managed stdout writes invalidate the replayed frame before the next render", () => {
    const engine = makeManagedExternalWriteEngine();
    seedManagedExternalFrame(engine);

    engine.writeToStdout("external log line\n");

    expect(engine.prevFrame.screen.height).toBe(0);
  });

  it("managed stderr writes invalidate the replayed frame before the next render", () => {
    const engine = makeManagedExternalWriteEngine();
    seedManagedExternalFrame(engine);

    engine.writeToStderr("external warning line\n");

    expect(engine.prevFrame.screen.height).toBe(0);
  });

  it("direct stdout writes through the guarded stream invalidate the next frame", () => {
    const engine = makeManagedExternalWriteEngine();
    seedManagedExternalFrame(engine);

    mocks.stdout.write("sdk stdout line\n");

    expect(mocks.stdoutWrite).toHaveBeenCalledWith("sdk stdout line\n");
    expect(engine.prevFrame.screen.height).toBe(0);
  });

  it("direct stderr writes through the guarded stream invalidate the next frame", () => {
    const engine = makeManagedExternalWriteEngine();
    seedManagedExternalFrame(engine);

    mocks.stderr.write("sdk stderr line\n");

    expect(mocks.stderrWrite).toHaveBeenCalledWith("sdk stderr line\n");
    expect(engine.prevFrame.screen.height).toBe(0);
  });

  it("hides the OS cursor (DECTCEM ?25l) once when no input cursor anchor (frame.cursor.visible false)", () => {
    // FEATURE_214: cursor visibility is driven by frame.cursor.visible — no input
    // cursor on screen → visible:false → engine hides once (cursorHidden latch).
    const r = fakeRenderResult(80, 1, "row");
    r.frame.cursor = { x: 0, y: 1, visible: false };
    mocks.renderTree.mockReturnValue(r);

    const engine = new Engine({
      stdout: mocks.stdout,
      stdin: mocks.stdin,
      stderr: mocks.stderr,
      shellMode: "main-screen",
      exitOnCtrlC: false,
      patchConsole: false,
      kittyKeyboard: { mode: "disabled" },
    } as ConstructorParameters<typeof Engine>[0]) as unknown as {
      onRender: () => void;
    };

    engine.onRender();
    engine.onRender();

    // DECTCEM hide (`\x1b[?25l`) prepended to the very first onRender once,
    // matching the legacy log-update.js's `cliCursor.hide(stream)` on first
    // render. Pair with `App.js`'s useEffect cleanup `cliCursor.show(stdout)`.
    const writes = mocks.stdoutWrite.mock.calls.map((call) => call[0] as string);
    const hideMatches = writes.filter((bytes) => bytes.includes("[?25l"));
    expect(hideMatches).toHaveLength(1);
  });

  it("main-screen: parks the cursor at the input anchor via a relative move (FEATURE_214 displayCursor suffix)", () => {
    // Production renderer: frame.cursor is the RESTING cursor (content-bottom,
    // visible:false); the input anchor travels separately as frame.inputCursor.
    // The engine emits a RELATIVE cursor move from the (visible-translated)
    // resting row up to the anchor so IME / typing lands in the input bar.
    const r = fakeRenderResult(80, 4, "a\nb\nc\nd");
    r.frame.cursor = { x: 0, y: 4, visible: false };
    (r.frame as { inputCursor?: { x: number; y: number } }).inputCursor = { x: 3, y: 2 };
    mocks.renderTree.mockReturnValue(r);

    const engine = new Engine({
      stdout: mocks.stdout,
      stdin: mocks.stdin,
      stderr: mocks.stderr,
      shellMode: "main-screen",
      exitOnCtrlC: false,
      patchConsole: false,
      kittyKeyboard: { mode: "disabled" },
    } as ConstructorParameters<typeof Engine>[0]) as unknown as {
      onRender: () => void;
    };

    engine.onRender();

    const out = mocks.stdoutWrite.mock.calls.map((call) => call[0] as string).join("");
    // FEATURE_214: the inline resting cursor now rests on the LAST content row
    // (screen.height - 1 = 3), not one past it — clampRestingCursor + toVisibleCursor
    // cap at min(viewport.height-1, screen.height-1). So resting visible row 3 →
    // anchor row 2 ⇒ cursorUp(1); column 0 → 3 ⇒ cursorForward(3). (The anchor's
    // FINAL position is unchanged; only the relative move shrank by the one row the
    // resting baseline moved up.)
    expect(out).toContain(ansiEscapes.cursorUp(1));
    expect(out).toContain(ansiEscapes.cursorForward(3));
  });

  it("main-screen: a second render with a parked input cursor runs returnCursorToRest without throwing (FEATURE_214 regression)", () => {
    // The preamble (returnCursorToRest) moves the physical cursor back from the
    // parked input anchor to the prev frame's resting row before the next diff.
    // This is the exact path the `restingCursor`→`toVisibleCursor` rename broke at
    // runtime while the suite stayed green — it was never exercised. Now it is.
    const r1 = fakeRenderResult(80, 4, "a\nb\nc\nd");
    r1.frame.cursor = { x: 0, y: 4, visible: false };
    (r1.frame as { inputCursor?: { x: number; y: number } }).inputCursor = { x: 3, y: 2 };

    const r2 = fakeRenderResult(80, 4, "a\nb\nc\nd");
    r2.frame.cursor = { x: 0, y: 4, visible: false };
    (r2.frame as { inputCursor?: { x: number; y: number } }).inputCursor = { x: 5, y: 1 };

    const engine = new Engine({
      stdout: mocks.stdout,
      stdin: mocks.stdin,
      stderr: mocks.stderr,
      shellMode: "main-screen",
      exitOnCtrlC: false,
      patchConsole: false,
      kittyKeyboard: { mode: "disabled" },
    } as ConstructorParameters<typeof Engine>[0]) as unknown as {
      onRender: () => void;
    };

    mocks.renderTree.mockReturnValueOnce(r1).mockReturnValueOnce(r2);
    engine.onRender(); // parks displayCursor at the {3,2} anchor
    mocks.stdoutWrite.mockClear();
    expect(() => engine.onRender()).not.toThrow(); // preamble must not ReferenceError

    const out = mocks.stdoutWrite.mock.calls.map((call) => call[0] as string).join("");
    // return-to-rest: from the parked row 2 down to the resting row 3 ⇒ cursorDown(1).
    // FEATURE_214 moved the inline resting row from one-past-last (4) to the last
    // content row (3), so the preamble's downward move is one shorter.
    expect(out).toContain(ansiEscapes.cursorDown(1));
  });

  // Build a renderer.js return with REAL cell content (frameFromRows) so an
  // incremental render produces an actual cell diff, plus a parked input anchor.
  const inlineFrameResult = (rows: string[], inputX: number) => {
    const frame = frameFromRows(rows, 80, 24);
    frame.cursor = { x: 0, y: rows.length, visible: false };
    (frame as { inputCursor?: { x: number; y: number } }).inputCursor = { x: inputX, y: 1 };
    return { output: rows.join("\n"), outputHeight: rows.length, staticOutput: "", frame };
  };

  it("inline same-height render with a parked input cursor flushes ONE atomic write — prefix + diff + suffix in one chunk (FEATURE_214 IME preedit)", () => {
    // The OLD pipeline emitted THREE writes for a spinner-style tick: return-to-rest
    // prefix, cell diff, suffix back to the input. Windows Terminal / ConPTY / IME
    // samples the cursor BETWEEN those writes, so the CJK preedit/candidate box
    // flickers between the input bar and the resting (status) row at the spinner
    // frame rate. The fix folds prefix + diff + suffix into a SINGLE write.
    const r1 = inlineFrameResult(["You", "answer", "> in", "status"], 2);
    const r2 = inlineFrameResult(["You", "answer", "> in", "statuX"], 4); // last cell ticks; anchor col moves

    const engine = new Engine({
      stdout: mocks.stdout,
      stdin: mocks.stdin,
      stderr: mocks.stderr,
      shellMode: "main-screen",
      exitOnCtrlC: false,
      patchConsole: false,
      kittyKeyboard: { mode: "disabled" },
    } as ConstructorParameters<typeof Engine>[0]) as unknown as {
      onRender: () => void;
    };

    mocks.renderTree.mockReturnValueOnce(r1).mockReturnValueOnce(r2);
    engine.onRender(); // parks displayCursor at the input anchor (+ one-time cursorHide)
    mocks.stdoutWrite.mockClear();
    engine.onRender(); // the spinner tick

    // ONE write carries the entire prefix → diff → suffix transaction.
    expect(mocks.stdoutWrite).toHaveBeenCalledTimes(1);
    const out = mocks.stdoutWrite.mock.calls[0][0] as string;
    // All three present in the SAME chunk → no intermediate resting-cursor state:
    expect(out).toContain(ansiEscapes.cursorDown(2)); // PREFIX: anchor row 1 → resting row 3
    expect(out).toContain("X"); //                        DIFF: the changed cell
    expect(out).toContain(ansiEscapes.cursorUp(2)); //    SUFFIX: resting row 3 → anchor row 1
  });

  it("inline + inputCursor wraps the whole prefix/diff/suffix transaction in BSU/ESU when synchronized (FEATURE_214)", () => {
    vi.mocked(shouldSynchronize).mockReturnValue(true);
    try {
      const r1 = inlineFrameResult(["You", "answer", "> in", "status"], 2);
      const r2 = inlineFrameResult(["You", "answer", "> in", "statuX"], 4);

      const engine = new Engine({
        stdout: mocks.stdout,
        stdin: mocks.stdin,
        stderr: mocks.stderr,
        shellMode: "main-screen",
        exitOnCtrlC: false,
        patchConsole: false,
        kittyKeyboard: { mode: "disabled" },
      } as ConstructorParameters<typeof Engine>[0]) as unknown as {
        onRender: () => void;
      };

      mocks.renderTree.mockReturnValueOnce(r1).mockReturnValueOnce(r2);
      engine.onRender();
      mocks.stdoutWrite.mockClear();
      engine.onRender();

      expect(mocks.stdoutWrite).toHaveBeenCalledTimes(1);
      const out = mocks.stdoutWrite.mock.calls[0][0] as string;
      // The whole transaction is bracketed by exactly ONE BSU/ESU pair (the mock's
      // sync markers) — not the per-branch / per-diff wrapping, and not nested.
      expect(out.startsWith("<bsu>")).toBe(true);
      expect(out.endsWith("<esu>")).toBe(true);
      expect(out.split("<bsu>").length - 1).toBe(1);
      expect(out.split("<esu>").length - 1).toBe(1);
      expect(out).toContain("X"); // the cell diff is inside the synchronized bracket
    } finally {
      vi.mocked(shouldSynchronize).mockReturnValue(false);
    }
  });

  it("inline render: a throw mid-frame still FLUSHES the return-to-rest prefix — cursor not stranded at the input anchor (FEATURE_214 exception parity)", () => {
    // computeReturnToRestSeq clears displayCursor immediately, but the prefix bytes are
    // buffered. If applyCellFrame throws before the flush, the OLD immediate-write path
    // had already moved the cursor to rest; the txn path must match that via try/finally
    // (flush in finally) — else the physical cursor is stranded at the input anchor while
    // displayCursor reads null, corrupting every later erase.
    const r1 = inlineFrameResult(["You", "answer", "> in", "status"], 3); // parks displayCursor
    const r2bad = inlineFrameResult(["You", "answer", "> in", "status"], 5);
    (r2bad.frame as { screen?: unknown }).screen = undefined; // forces the cell renderer to throw

    const engine = new Engine({
      stdout: mocks.stdout,
      stdin: mocks.stdin,
      stderr: mocks.stderr,
      shellMode: "main-screen",
      exitOnCtrlC: false,
      patchConsole: false,
      kittyKeyboard: { mode: "disabled" },
    } as ConstructorParameters<typeof Engine>[0]) as unknown as {
      onRender: () => void;
      displayCursor: { x: number; y: number } | null;
    };

    mocks.renderTree.mockReturnValueOnce(r1);
    engine.onRender(); // parks displayCursor at the input anchor
    mocks.renderTree.mockReturnValue(r2bad);
    mocks.stdoutWrite.mockClear();

    expect(() => engine.onRender()).toThrow(); // the malformed frame throws in the cell renderer
    // The finally flushed the buffered prefix despite the throw: the cursor left the
    // input anchor (return-to-rest emitted) and displayCursor is null — consistent.
    const out = mocks.stdoutWrite.mock.calls.map((c) => c[0] as string).join("");
    expect(out).toContain(ansiEscapes.cursorDown(2)); // PREFIX: anchor row 1 → resting row 3, flushed
    expect(engine.displayCursor).toBeNull(); // matches the now-at-rest physical cursor
  });

  it("main-screen: an inline footer HEIGHT CHANGE erases + repaints instead of incremental grow (FEATURE_214 live-block redraw)", () => {
    // codex diagnosis: a live-block height change must ERASE the old block and
    // repaint clean, not append new rows downward (which shoves input below the
    // status bar). A same-height render must NOT erase (cheap incremental diff).
    const engine = new Engine({
      stdout: mocks.stdout,
      stdin: mocks.stdin,
      stderr: mocks.stderr,
      shellMode: "main-screen",
      exitOnCtrlC: false,
      patchConsole: false,
      kittyKeyboard: { mode: "disabled" },
    } as ConstructorParameters<typeof Engine>[0]) as unknown as {
      onRender: () => void;
    };

    // Heights fit the 4-row mock terminal so the erase-repaint branch is allowed
    // (FEATURE_214 step 5 gates it OFF for taller-than-viewport frames).
    mocks.renderTree.mockReturnValue(fakeRenderResult(80, 2, "a\nb"));
    engine.onRender(); // establishes lastOutputHeight = 2

    // height 2 → 3: live block grew → erase the old 2-row block, then repaint.
    const grow = fakeRenderResult(80, 3, "a\nb\nc");
    grow.frame.cursor = { x: 0, y: 3, visible: false };
    (grow.frame as { inputCursor?: { x: number; y: number } }).inputCursor = { x: 2, y: 2 };
    mocks.renderTree.mockReturnValue(grow);
    mocks.stdoutWrite.mockClear();
    engine.onRender();
    const grownOut = mocks.stdoutWrite.mock.calls.map((call) => call[0] as string).join("");
    // FEATURE_214: eraseInlineLiveBlock erases lastOutputHeight (=2) rows. The
    // inline resting cursor now sits ON the last content row (clampRestingCursor +
    // suppressed last-row `\n`), so eraseLines(lastOutputHeight) already covers row
    // 0 (the live block's top — the `You` header); a `+1` would eat a committed
    // scrollback row above.
    expect(grownOut).toContain(ansiEscapes.eraseLines(2));

    // height stays 3: no height change → incremental diff, no full erase.
    mocks.renderTree.mockReturnValue(grow);
    mocks.stdoutWrite.mockClear();
    engine.onRender();
    const sameOut = mocks.stdoutWrite.mock.calls.map((call) => call[0] as string).join("");
    expect(sameOut).not.toContain(ansiEscapes.eraseLines(3));
  });

  it("clear forgets the erased live block before the next repaint", () => {
    const engine = new Engine({
      stdout: mocks.stdout,
      stdin: mocks.stdin,
      stderr: mocks.stderr,
      shellMode: "main-screen",
      exitOnCtrlC: false,
      patchConsole: false,
      kittyKeyboard: { mode: "disabled" },
    } as ConstructorParameters<typeof Engine>[0]) as unknown as {
      onRender: () => void;
      clear: () => void;
      lastOutputHeight: number;
      lastOutput: string;
      prevFrame: { screen: { height: number } };
    };

    mocks.renderTree.mockReturnValue(fakeRenderResult(80, 3, "a\nb\nc"));
    engine.onRender();
    expect(engine.lastOutputHeight).toBe(3);

    mocks.stdoutWrite.mockClear();
    engine.clear();

    expect(mocks.stdoutWrite.mock.calls.map((call) => call[0] as string).join(""))
      .toContain(ansiEscapes.eraseLines(3));
    expect(engine.lastOutputHeight).toBe(0);
    expect(engine.lastOutput).toBe("");
    expect(engine.prevFrame.screen.height).toBe(0);

    mocks.stdoutWrite.mockClear();
    engine.onRender();
    const repaintOut = mocks.stdoutWrite.mock.calls.map((call) => call[0] as string).join("");
    expect(repaintOut).not.toContain(ansiEscapes.eraseLines(3));
  });

  it("setCursorPosition clamps out-of-bounds coordinates so a future re-application can't hit setCellAt RangeError", () => {
    const engine = new Engine({
      stdout: mocks.stdout,
      stdin: mocks.stdin,
      stderr: mocks.stderr,
      shellMode: "main-screen",
      exitOnCtrlC: false,
      patchConsole: false,
      kittyKeyboard: { mode: "disabled" },
    } as ConstructorParameters<typeof Engine>[0]) as unknown as {
      setCursorPosition: (p: { x: number; y: number } | undefined) => void;
      cursorPosition: { x: number; y: number } | undefined;
    };

    // stdout fixture is 80×4 (mocks.stdout above). Out-of-bounds writes:
    //   - x = 200 → clamp to 79
    //   - y = 100 → clamp to 3
    //   - negative coordinates → clamp to 0
    engine.setCursorPosition({ x: 200, y: 100 });
    expect(engine.cursorPosition).toEqual({ x: 79, y: 3 });

    engine.setCursorPosition({ x: -5, y: -1 });
    expect(engine.cursorPosition).toEqual({ x: 0, y: 0 });

    // In-bounds is preserved verbatim.
    engine.setCursorPosition({ x: 10, y: 2 });
    expect(engine.cursorPosition).toEqual({ x: 10, y: 2 });

    // Undefined clears the stored position.
    engine.setCursorPosition(undefined);
    expect(engine.cursorPosition).toBeUndefined();
  });

  it("resetOutputTracking reseeds prevFrame so the next onRender repaints from scratch", () => {
    // First render establishes prevFrame = the rendered frame (height 2).
    mocks.renderTree.mockReturnValue(
      fakeRenderResult(80, 2, "a\nb"),
    );

    const engine = new Engine({
      stdout: mocks.stdout,
      stdin: mocks.stdin,
      stderr: mocks.stderr,
      shellMode: "virtual",
      exitOnCtrlC: false,
      patchConsole: false,
      kittyKeyboard: { mode: "disabled" },
    } as ConstructorParameters<typeof Engine>[0]) as unknown as {
      onRender: () => void;
      setAltScreenActive: (active: boolean) => void;
      prevFrame: { screen: { height: number } };
    };

    engine.onRender();
    expect(engine.prevFrame.screen.height).toBe(2);

    // Toggle alt-screen ownership — substrate cursor pipeline emits the
    // 1049 sequence outside the cell renderer; resetOutputTracking must
    // invalidate prevFrame so the next applyCellFrame doesn't compute a
    // diff against a screen state that no longer reflects reality.
    engine.setAltScreenActive(true);

    expect(engine.prevFrame.screen.height).toBe(0);
  });
});

describe("commitInlineScrollback (FEATURE_214 inline ledger primitive)", () => {
  function makeEngine() {
    return new Engine({
      stdout: mocks.stdout,
      stdin: mocks.stdin,
      stderr: mocks.stderr,
      shellMode: "main-screen",
      exitOnCtrlC: false,
      patchConsole: false,
      kittyKeyboard: { mode: "disabled" },
    } as ConstructorParameters<typeof Engine>[0]) as unknown as {
      commitInlineScrollback: (o: { mode: "append" | "rebuild"; text: string }) => void;
      setAltScreenActive: (active: boolean) => void;
      lastOutputHeight: number;
      prevFrame: { screen: { height: number } };
    };
  }

  const writes = () => mocks.stdoutWrite.mock.calls.map((c) => String(c[0])).join("");

  beforeEach(() => {
    mocks.renderTree.mockReturnValue(fakeRenderResult(80, 2, "live"));
  });

  it("rebuild does NOT read a stale lastOutputHeight (no eraseLines), clears scrollback instead", () => {
    const engine = makeEngine();
    engine.lastOutputHeight = 99; // stale; rebuild must ignore it
    mocks.stdoutWrite.mockClear();

    engine.commitInlineScrollback({ mode: "rebuild", text: "HISTORY\n" });

    const out = writes();
    expect(out).not.toContain(ansiEscapes.eraseLines(99));
    expect(out).toContain("[3J"); // scrollback purge
    expect(out).toContain("HISTORY\n");
  });

  it("rebuild = ESC[2J + ESC[3J + home (scrollback purge) + history + repaint", () => {
    const engine = makeEngine();
    mocks.stdoutWrite.mockClear();

    engine.commitInlineScrollback({ mode: "rebuild", text: "ALL\n" });

    const out = writes();
    expect(out).toContain("[2J[3J[H" + "ALL\n");
    // FEATURE_214: the whole commit (clear + history + live repaint) is ONE atomic
    // write — no separate writes for the IME to sample the cursor between.
    expect(mocks.stdoutWrite).toHaveBeenCalledTimes(1);
  });

  it("rebuild with EMPTY text is a legitimate clear — still purges scrollback + repaints (FEATURE_214 step 1)", () => {
    mocks.renderTree.mockReturnValue(fakeRenderResult(80, 2, "live"));
    const engine = makeEngine();
    mocks.stdoutWrite.mockClear();

    engine.commitInlineScrollback({ mode: "rebuild", text: "" });

    const out = writes();
    expect(out).toContain("[3J"); // scrollback purged even with empty history text
    expect(mocks.stdoutWrite).toHaveBeenCalledTimes(1); // FEATURE_214: one atomic commit write
  });

  it("append erases the old live block (eraseLines lastOutputHeight) + history + repaint", () => {
    const engine = makeEngine();
    engine.lastOutputHeight = 5;
    mocks.stdoutWrite.mockClear();

    engine.commitInlineScrollback({ mode: "append", text: "NEW\n" });

    const out = writes();
    // FEATURE_214: eraseInlineLiveBlock = eraseLines(lastOutputHeight). The resting
    // cursor sits ON the last content row, so eraseLines(5) clears the whole 5-row
    // block (row 0 included) without reaching a committed scrollback row above.
    expect(out).toContain(ansiEscapes.eraseLines(5) + "NEW\n");
    expect(out).not.toContain("[3J"); // append never purges scrollback
    expect(mocks.stdoutWrite).toHaveBeenCalledTimes(1); // FEATURE_214: one atomic commit write
  });

  it("reseeds prevFrame (next paint is a clean first-render, not a diff vs a stale frame)", () => {
    const engine = makeEngine();
    engine.prevFrame = { screen: { height: 99 } } as unknown as { screen: { height: number } };
    mocks.stdoutWrite.mockClear();

    engine.commitInlineScrollback({ mode: "append", text: "X\n" });

    expect(engine.prevFrame.screen.height).not.toBe(99);
  });

  it("alt-screen / transcript does NOT route through this path (no writes)", () => {
    const engine = makeEngine();
    engine.setAltScreenActive(true);
    mocks.stdoutWrite.mockClear();

    engine.commitInlineScrollback({ mode: "rebuild", text: "SHOULD NOT WRITE" });

    expect(mocks.stdoutWrite).not.toHaveBeenCalled();
  });

  it("folds prefix return-to-rest + history + repaint + input re-park into ONE write (FEATURE_214 IME safe during a ledger commit)", () => {
    // The IME case the spinner tick shares: a ledger append/rebuild that ALSO re-parks
    // the cursor. Park the cursor at an input anchor (a normal inline render) first,
    // then commit. The commit must return-to-rest, write history, repaint, AND re-park
    // — all in ONE write, or a CJK composition mid-commit samples the resting cursor.
    // stdout.rows matches the frame viewport (24) so the reseeded emptyFrame doesn't
    // diff against a different-viewport frame.
    const stdout24 = {
      isTTY: true, rows: 24, columns: 80,
      write: mocks.stdoutWrite, on: mocks.stdoutOn, off: mocks.stdoutOff,
    } as unknown as NodeJS.WriteStream;
    const mkFrame = (rows: string[], inputX: number) => {
      const frame = frameFromRows(rows, 80, 24);
      frame.cursor = { x: 0, y: rows.length, visible: false };
      (frame as { inputCursor?: { x: number; y: number } }).inputCursor = { x: inputX, y: 1 };
      return { output: rows.join("\n"), outputHeight: rows.length, staticOutput: "", frame };
    };
    const r1 = mkFrame(["You", "answer", "> in", "status"], 3); // onRender parks displayCursor
    const r2 = mkFrame(["You", "answer", "> in", "status"], 5); // the commit's internal render frame

    const engine = new Engine({
      stdout: stdout24,
      stdin: mocks.stdin,
      stderr: mocks.stderr,
      shellMode: "main-screen",
      exitOnCtrlC: false,
      patchConsole: false,
      kittyKeyboard: { mode: "disabled" },
    } as ConstructorParameters<typeof Engine>[0]) as unknown as {
      onRender: () => void;
      commitInlineScrollback: (o: { mode: "append" | "rebuild"; text: string }) => void;
    };

    mocks.renderTree.mockReturnValueOnce(r1);
    engine.onRender(); // parks displayCursor at the input anchor (+ one-time cursorHide)
    mocks.renderTree.mockReturnValue(r2); // the commit's internal render() returns this
    mocks.stdoutWrite.mockClear();
    engine.commitInlineScrollback({ mode: "append", text: "FINAL\n" });

    // ONE write for the entire commit — prefix + history + repaint + suffix.
    expect(mocks.stdoutWrite).toHaveBeenCalledTimes(1);
    const out = mocks.stdoutWrite.mock.calls[0][0] as string;
    expect(out).toContain("FINAL\n"); //                  committed history
    expect(out).toContain(ansiEscapes.cursorDown(2)); // PREFIX: anchor row 1 → resting row 3
    expect(out).toContain(ansiEscapes.cursorUp(2)); //   SUFFIX: resting row 3 → anchor row 1
  });
});

// FEATURE_214 baseline — the inline (main-screen, NON-alt-screen) live block must
// be a BOUNDED repaint: every grow / shrink / same-height update erases the OLD
// block COMPLETELY (row 0 included) and repaints clean, so the active round's
// `You [HH:MM]` header is never left behind to scroll into native scrollback. These
// reproduce the user-reported "You repeats once per streaming/thinking/tool update"
// bug by replaying the ENGINE's real emitted bytes onto the faithful TerminalModel
// — and they reproduce with the inline ledger OFF, proving it is a live-frame bug.
describe("inline live-block bounded repaint (FEATURE_214 baseline, ledger OFF)", () => {
  // Width MUST match the mocked terminal-size (80) and height MUST match the frame
  // viewport (VH) — otherwise the reseeded emptyFrame's viewport differs from the
  // frame's and the cell renderer fires a full-screen reset (ESC[2J) every render,
  // which would mask the very row-0 off-by-one these tests exist to catch.
  const W = 80;
  const VH = 24; // viewport ≫ content ⇒ nothing scrolls off; orphans stay visible

  // A stdout whose rows match the frame viewport, so the reseeded emptyFrame
  // (emptyFrame(stdout.rows, terminalWidth)) has the SAME viewport as the frames
  // and no spurious full reset intervenes.
  const inlineStdout = {
    isTTY: true,
    rows: VH,
    columns: W,
    write: mocks.stdoutWrite,
    on: mocks.stdoutOn,
    off: mocks.stdoutOff,
  } as unknown as NodeJS.WriteStream;

  function makeEngine() {
    return new Engine({
      stdout: inlineStdout,
      stdin: mocks.stdin,
      stderr: mocks.stderr,
      shellMode: "main-screen",
      exitOnCtrlC: false,
      patchConsole: false,
      kittyKeyboard: { mode: "disabled" },
    } as ConstructorParameters<typeof Engine>[0]) as unknown as {
      onRender: () => void;
      eraseInlineLiveBlock: () => string;
      lastOutputHeight: number;
    };
  }

  /**
   * Drive a sequence of inline frames through ONE engine, replaying EVERY emitted
   * byte onto a faithful terminal model (what the real terminal renders). Row 0 of
   * each frame is the active round's header; the body grows/shrinks beneath it with
   * the input pinned to the last row (inputCursor). A step may carry `staticOutput`
   * (a finalized round committed to scrollback) — that exercises the <Static> commit
   * branch, mirroring a round boundary / resubmit.
   */
  function driveInline(steps: Array<{ rows: string[]; staticOutput?: string }>): TerminalModel {
    const engine = makeEngine();
    const model = new TerminalModel(W, VH);
    mocks.stdoutWrite.mockClear();
    let applied = 0;
    for (const step of steps) {
      const frame = frameFromRows(step.rows, W, VH);
      (frame as { inputCursor?: { x: number; y: number } }).inputCursor = {
        x: 2,
        y: Math.max(0, step.rows.length - 1),
      };
      mocks.renderTree.mockReturnValue({
        output: step.rows.join("\n"),
        outputHeight: step.rows.length,
        staticOutput: step.staticOutput ?? "",
        frame,
      });
      engine.onRender();
      const calls = mocks.stdoutWrite.mock.calls;
      model.apply(calls.slice(applied).map((c) => String(c[0])).join(""));
      applied = calls.length;
    }
    return model;
  }

  const countRows = (model: TerminalModel, needle: string): number =>
    model.allRows().filter((r) => r.includes(needle)).length;

  const HDR = "You 02:24 PM";

  it("a growing active round commits the You header exactly once (no per-update leak)", () => {
    const model = driveInline([
      { rows: [HDR, "latest changes", "> "] },
      { rows: [HDR, "latest changes", "Thinking", "> "] },
      { rows: [HDR, "latest changes", "Thinking", "Tool changed_scope", "> "] },
      { rows: [HDR, "latest changes", "Thinking", "Tool changed_scope", "Assistant reply", "> "] },
      { rows: [HDR, "latest changes", "Thinking", "Tool changed_scope", "Assistant reply", "Tool bash", "> "] },
    ]);
    expect(countRows(model, HDR)).toBe(1);
  });

  it("a height SHRINK leaves no residual body rows below and no header leak", () => {
    const model = driveInline([
      { rows: [HDR, "q", "Thinking", "Tool A", "Assistant", "> "] }, // height 6
      { rows: [HDR, "q", "> "] }, // collapse to height 3
    ]);
    expect(countRows(model, HDR)).toBe(1);
    expect(countRows(model, "Thinking")).toBe(0);
    expect(countRows(model, "Assistant")).toBe(0);
  });

  it("a SAME-HEIGHT content tick overwrites in place — no header leak, no stale row", () => {
    const model = driveInline([
      { rows: [HDR, "q", "Worker 1s", "> "] },
      { rows: [HDR, "q", "Worker 2s", "> "] },
      { rows: [HDR, "q", "Worker 3s", "> "] },
    ]);
    expect(countRows(model, HDR)).toBe(1);
    expect(countRows(model, "Worker 1s")).toBe(0);
    expect(countRows(model, "Worker 3s")).toBe(1);
  });

  it("interrupt (collapse) then resubmit the SAME query (regrow) keeps the header to ONE copy", () => {
    // The user submits → it streams (grows) → Ctrl+C interrupts (collapses back
    // to the prompt) → they resubmit the SAME query → it streams again. Through
    // the whole grow → shrink → regrow cycle the active round's header must stay a
    // single copy in the bounded live frame; the bug leaked one copy per update.
    const model = driveInline([
      { rows: [HDR, "latest changes", "> "] },
      { rows: [HDR, "latest changes", "Thinking", "> "] },
      { rows: [HDR, "latest changes", "Thinking", "Tool A", "> "] },
      { rows: [HDR, "latest changes", "> "] }, // Ctrl+C → collapse
      { rows: [HDR, "latest changes", "Thinking", "> "] }, // resubmit, streams
      { rows: [HDR, "latest changes", "Thinking", "Tool A", "> "] },
    ]);
    expect(countRows(model, HDR)).toBe(1);
  });

  it("UNBOUNDED active round taller than the viewport must NOT leak UI rows or duplicate transcript into scrollback (FEATURE_214 RED)", () => {
    // Today's inline output puts the WHOLE active round + the input separator +
    // status into ONE frame; a long streaming answer makes it taller than the
    // terminal. The engine's erase-repaint cannot reach rows already in native
    // scrollback, so transcript duplicates and UI rows can be pushed up. This is
    // the real bug behind the garbled `LEDGER=1` screenshot + the scroll-up
    // re-render. The fix (bounded live + commit overflow via insert-history /
    // gate erase-repaint off for >viewport frames) makes scrollback transcript-only.
    const SEP = "--------------------------------";
    const mkFrame = (n: number): string[] => {
      const rows = ["You 05:19 PM"];
      for (let i = 1; i <= n; i++) rows.push(`Tool line ${i}`);
      rows.push(SEP, "> Queue a follow-up...", "InfCodeX - AMA status");
      return rows;
    };
    const model = driveInline([
      { rows: mkFrame(22) }, // ~26 rows > 24-row viewport
      { rows: mkFrame(28) },
      { rows: mkFrame(34) },
    ]);
    const sb = model.scrollback();
    // UI chrome must NEVER enter scrollback.
    expect(sb.some((r) => r.includes("Queue a follow-up"))).toBe(false);
    expect(sb.some((r) => r.includes("InfCodeX -"))).toBe(false);
    expect(sb.some((r) => r.includes(SEP))).toBe(false);
    // No transcript line duplicated in scrollback.
    const toolLines = sb.filter((r) => r.startsWith("Tool line "));
    expect(new Set(toolLines).size).toBe(toolLines.length);
  });

  /**
   * Drive ONE inline first-frame onto a terminal whose viewport is ALREADY FULL of
   * prior shell history, with the cursor resting on the last physical row — exactly
   * the "open KodaX when the scrollback is already at the bottom" state. The live
   * frame is therefore physically anchored to the terminal's last row, so the
   * resting-cursor row-final `\n` (which the renderer emits one past the last
   * content row) lands on the bottom of the screen and SCROLLS a blank line in
   * under the status bar unless suppressed.
   */
  function driveInlineAnchoredToBottom(rows: string[]): TerminalModel {
    const engine = makeEngine();
    const model = new TerminalModel(W, VH);
    // Fill the viewport with prior history; the trailing `\n` of the last line
    // scrolls once, leaving history in rows 0..VH-2 and the cursor on a fresh
    // blank bottom row (VH-1) — the realistic shell-handoff state.
    for (let i = 1; i <= VH; i++) model.apply(`history line ${i}\r\n`);
    mocks.stdoutWrite.mockClear();
    const frame = frameFromRows(rows, W, VH);
    (frame as { inputCursor?: { x: number; y: number } }).inputCursor = {
      x: 2,
      y: Math.max(0, rows.length - 1),
    };
    mocks.renderTree.mockReturnValue({
      output: rows.join("\n"),
      outputHeight: rows.length,
      staticOutput: "",
      frame,
    });
    engine.onRender();
    model.apply(mocks.stdoutWrite.mock.calls.map((c) => String(c[0])).join(""));
    return model;
  }

  it("inline first frame anchored to a FULL terminal: status is the LAST row, no blank line under it (FEATURE_214 bottom-anchored RED)", () => {
    // A small inline frame (5 rows ≪ 24-row viewport) so FEATURE_212's existing
    // viewport-FILLING clamp does not apply — the frame fits the viewport but is
    // physically pinned to the bottom by the history above. The resting-cursor
    // newline must NOT scroll a blank row in beneath the status bar.
    const SEP = "--------------------------------";
    const STATUS = "InfCodeX - AMA ready";
    const model = driveInlineAnchoredToBottom([
      "You 05:19 PM",
      "latest changes",
      SEP,
      "> Queue a follow-up...",
      STATUS,
    ]);
    const visible = model.allRows();
    // The bottom-most visible row is the status bar (no scrolled-in blank line).
    expect(visible[VH - 1]).toContain("InfCodeX");
    // And the status bar appears exactly once (it was not duplicated by a scroll).
    expect(visible.filter((r) => r.includes("InfCodeX")).length).toBe(1);
  });

  it("inline FULL RESET (viewport height shrink) parks the input anchor on the right row — no off-by-one (FEATURE_214)", () => {
    // A viewport HEIGHT shrink (24 → 20) between two inline renders trips
    // shouldFullReset Case 1 ('resize'), so render() emits fullResetSequence
    // (clearTerminal + repaint from the top) — NOT an incremental diff. That path
    // does not call restoreCursor, so its renderFrameSlice must honor the inline
    // flag: end the last row on `\r` (cursor on the last content row) to match the
    // clamped cursor the suffix is computed from. The pre-flag bug left the physical
    // cursor one past the last row, so the anchor suffix landed one row too low.
    const engine = makeEngine();
    const model = new TerminalModel(W, VH);
    const rows = ["You 05:19 PM", "answer", "----", "> in", "KodaX status"];
    const driveFrame = (vh: number): void => {
      const frame = frameFromRows(rows, W, vh);
      (frame as { inputCursor?: { x: number; y: number } }).inputCursor = {
        x: 2,
        y: rows.length - 1,
      };
      mocks.renderTree.mockReturnValue({
        output: rows.join("\n"),
        outputHeight: rows.length,
        staticOutput: "",
        frame,
      });
      const before = mocks.stdoutWrite.mock.calls.length;
      engine.onRender();
      model.apply(
        mocks.stdoutWrite.mock.calls.slice(before).map((c) => String(c[0])).join(""),
      );
    };
    mocks.stdoutWrite.mockClear();
    driveFrame(VH); // render 1 establishes prevFrame at viewport 24
    driveFrame(VH - 4); // render 2: viewport 20 < 24 → full reset
    // After clearTerminal the frame repaints from the top, so the input anchor
    // (frame row 4) is visible row 4; the suffix must park the cursor exactly there.
    expect(model.cursor()).toEqual({ x: 2, y: rows.length - 1 });
  });

  it("eraseInlineLiveBlock clears the WHOLE block incl row 0 from the last-content-row cursor", () => {
    const engine = makeEngine();
    engine.lastOutputHeight = 3; // a 3-row live block (rows 0..2)
    const erase = engine.eraseInlineLiveBlock();
    const esc = String.fromCharCode(27);
    const model = new TerminalModel(20, 10);
    model.apply(`${esc}[1;1HYou header`); // row 0 — the leak-prone top row
    model.apply(`${esc}[2;1Hbody one`); // row 1
    model.apply(`${esc}[3;1Hbody two`); // row 2 — the LAST content row
    // FEATURE_214: the inline resting cursor rests ON the last content row (row 2 /
    // CSI row 3), not one past it — clampRestingCursor + the suppressed last-row
    // `\n`. eraseInlineLiveBlock = eraseLines(lastOutputHeight=3) from here.
    model.apply(`${esc}[3;1H`);
    model.apply(erase);
    // All three content rows blank — row 0 included (a stray `+1` would instead
    // reach a row ABOVE the block; a missing row would leave "You header" on row 0).
    expect(model.rows(3).every((r) => r.trim() === "")).toBe(true);
  });
});
