import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const renderTree = vi.fn();
  const stdoutWrite = vi.fn();
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
    write: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as NodeJS.WriteStream;

  return {
    renderTree,
    stdout,
    stdin,
    stderr,
    stdoutWrite,
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
import ansiEscapes from "ansi-escapes";

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
  beforeEach(() => {
    mocks.renderTree.mockReset();
    mocks.stdoutWrite.mockClear();
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
    // viewport 24 ≫ content 4 → no scrollback: resting visible row 4 → anchor row 2
    // ⇒ cursorUp(2); column 0 → 3 ⇒ cursorForward(3).
    expect(out).toContain(ansiEscapes.cursorUp(2));
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
    // return-to-rest: from the parked row 2 down to the resting row 4 ⇒ cursorDown(2).
    expect(out).toContain(ansiEscapes.cursorDown(2));
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

    mocks.renderTree.mockReturnValue(fakeRenderResult(80, 4, "a\nb\nc\nd"));
    engine.onRender(); // establishes lastOutputHeight = 4

    // height 4 → 6: live block grew → erase the old 4-row block, then repaint.
    const grow = fakeRenderResult(80, 6, "a\nb\nc\nd\ne\nf");
    grow.frame.cursor = { x: 0, y: 6, visible: false };
    (grow.frame as { inputCursor?: { x: number; y: number } }).inputCursor = { x: 2, y: 3 };
    mocks.renderTree.mockReturnValue(grow);
    mocks.stdoutWrite.mockClear();
    engine.onRender();
    const grownOut = mocks.stdoutWrite.mock.calls.map((call) => call[0] as string).join("");
    expect(grownOut).toContain(ansiEscapes.eraseLines(4));

    // height stays 6: no height change → incremental diff, no full erase.
    mocks.renderTree.mockReturnValue(grow);
    mocks.stdoutWrite.mockClear();
    engine.onRender();
    const sameOut = mocks.stdoutWrite.mock.calls.map((call) => call[0] as string).join("");
    expect(sameOut).not.toContain(ansiEscapes.eraseLines(6));
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
    // repaint happened after the history (cell renderer wrote the live frame too)
    expect(mocks.stdoutWrite.mock.calls.length).toBeGreaterThan(1);
  });

  it("append erases the old live block (eraseLines lastOutputHeight) + history + repaint", () => {
    const engine = makeEngine();
    engine.lastOutputHeight = 5;
    mocks.stdoutWrite.mockClear();

    engine.commitInlineScrollback({ mode: "append", text: "NEW\n" });

    const out = writes();
    expect(out).toContain(ansiEscapes.eraseLines(5) + "NEW\n");
    expect(out).not.toContain("[3J"); // append never purges scrollback
    expect(mocks.stdoutWrite.mock.calls.length).toBeGreaterThan(1);
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
});
