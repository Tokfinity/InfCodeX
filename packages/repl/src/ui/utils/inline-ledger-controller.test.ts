import { describe, it, expect } from "vitest";
import {
  isInlineLedgerActive,
  computeInlineLedgerStep,
  resolveInlineLedgerState,
  gateInlinePromptModel,
} from "./inline-ledger-controller.js";
import {
  EMPTY_INLINE_SCROLLBACK_STATE,
  type InlineScrollbackLedgerState,
} from "../../tui/substrate/ink/inline-scrollback-ledger.js";
import type { TranscriptRenderModel, TranscriptSection } from "./transcript-layout.js";

const sec = (key: string, text: string): TranscriptSection => ({
  key,
  rows: [{ key: `${key}-r0`, text }],
});

const expectCommit = (s: ReturnType<typeof computeInlineLedgerStep>) => {
  if (s.kind !== "commit") throw new Error(`expected commit, got ${s.kind}`);
  return s;
};

describe("isInlineLedgerActive (FEATURE_214 wiring gate)", () => {
  const base = {
    enabled: true,
    useRendererViewportShell: false,
    isTranscriptMode: false,
    hasCommitHandle: true,
  };
  it("active only on inline main-screen, flag on, with a real handle", () => {
    expect(isInlineLedgerActive(base)).toBe(true);
  });
  it("flag off → inactive (default keeps <Static>)", () => {
    expect(isInlineLedgerActive({ ...base, enabled: false })).toBe(false);
  });
  it("fullscreen / windowed → inactive", () => {
    expect(isInlineLedgerActive({ ...base, useRendererViewportShell: true })).toBe(false);
  });
  it("transcript mode → inactive", () => {
    expect(isInlineLedgerActive({ ...base, isTranscriptMode: true })).toBe(false);
  });
  it("no commit handle → inactive (fall back to <Static>, never drop history)", () => {
    expect(isInlineLedgerActive({ ...base, hasCommitHandle: false })).toBe(false);
  });
});

describe("computeInlineLedgerStep (FEATURE_214 wiring decision)", () => {
  const stepBase = {
    active: true,
    hasCommitHandle: true,
    wasActive: true,
    forceRebuild: false,
    prior: EMPTY_INLINE_SCROLLBACK_STATE,
    finalizedSections: [] as TranscriptSection[],
    bannerSection: undefined,
    width: 80,
  };

  it("inactive → reset (no commit — flag off / transcript / fullscreen)", () => {
    expect(computeInlineLedgerStep({ ...stepBase, active: false }).kind).toBe("reset");
  });
  it("active but handle gone → skip (fall back, do NOT advance)", () => {
    expect(computeInlineLedgerStep({ ...stepBase, hasCommitHandle: false }).kind).toBe("skip");
  });

  it("first activation (NOT owned) + non-empty source → APPEND all (no rebuild/clear) — startup-clear fix", () => {
    // wasActive false + forceRebuild false = a true first activation onto a pristine
    // scrollback. The history was never painted (gated model dropped staticSections),
    // so it is committed ONCE via append — NEVER a 2J/3J rebuild that flashes-clears
    // the user's terminal on a fresh start.
    const s = expectCommit(
      computeInlineLedgerStep({
        ...stepBase,
        wasActive: false,
        forceRebuild: false,
        finalizedSections: [sec("a", "one"), sec("b", "two")],
      }),
    );
    expect(s.mode).toBe("append");
    expect(s.sections.map((x) => x.key)).toEqual(["a", "b"]);
  });

  it("re-entry with OWNED scrollback + non-empty source → rebuild ALL (purge stale + repaint)", () => {
    const s = expectCommit(
      computeInlineLedgerStep({
        ...stepBase,
        wasActive: false,
        forceRebuild: true,
        finalizedSections: [sec("a", "one")],
      }),
    );
    expect(s.mode).toBe("rebuild");
    expect(s.sections.map((x) => x.key)).toEqual(["a"]);
  });

  it("steady-state new finalized → append only the new sections", () => {
    const first = expectCommit(
      computeInlineLedgerStep({ ...stepBase, finalizedSections: [sec("a", "one")] }),
    );
    const next = expectCommit(
      computeInlineLedgerStep({
        ...stepBase,
        prior: first.nextState,
        finalizedSections: [sec("a", "one"), sec("b", "two")],
      }),
    );
    expect(next.mode).toBe("append");
    expect(next.sections.map((x) => x.key)).toEqual(["b"]);
  });

  it("width change → rebuild (req 6)", () => {
    const first = expectCommit(
      computeInlineLedgerStep({ ...stepBase, width: 80, finalizedSections: [sec("a", "one")] }),
    );
    const wider = expectCommit(
      computeInlineLedgerStep({
        ...stepBase,
        prior: first.nextState,
        width: 120,
        finalizedSections: [sec("a", "one")],
      }),
    );
    expect(wider.mode).toBe("rebuild");
  });

  it("no change → noop", () => {
    const first = expectCommit(
      computeInlineLedgerStep({ ...stepBase, finalizedSections: [sec("a", "one")] }),
    );
    expect(
      computeInlineLedgerStep({
        ...stepBase,
        prior: first.nextState,
        finalizedSections: [sec("a", "one")],
      }).kind,
    ).toBe("noop");
  });

  // FEATURE_214 step-3 scenarios for empty-rebuild + re-entry.
  it("steady: committed [a,b] then source [] → rebuild with EMPTY sections (rollback/clear)", () => {
    const first = expectCommit(
      computeInlineLedgerStep({ ...stepBase, finalizedSections: [sec("a", "1"), sec("b", "2")] }),
    );
    const cleared = expectCommit(
      computeInlineLedgerStep({ ...stepBase, prior: first.nextState, finalizedSections: [] }),
    );
    expect(cleared.mode).toBe("rebuild");
    expect(cleared.sections).toEqual([]);
  });

  it("first activation: source [] + NOT owned (forceRebuild false) → noop, never clear the terminal", () => {
    expect(
      computeInlineLedgerStep({
        ...stepBase,
        wasActive: false,
        forceRebuild: false,
        finalizedSections: [],
      }).kind,
    ).toBe("noop");
  });

  it("re-entry: source [] + owned scrollback (forceRebuild true) → rebuild EMPTY (clear)", () => {
    const s = expectCommit(
      computeInlineLedgerStep({
        ...stepBase,
        wasActive: false,
        forceRebuild: true,
        finalizedSections: [],
      }),
    );
    expect(s.mode).toBe("rebuild");
    expect(s.sections).toEqual([]);
  });
});

describe("resolveInlineLedgerState (FEATURE_214 failure / ownership state machine)", () => {
  const someState: InlineScrollbackLedgerState = {
    committed: [{ key: "a", fingerprint: "1" }],
    width: 80,
    hasBanner: false,
  };

  it("noop → keep state, wasActive true, owns unchanged", () => {
    expect(
      resolveInlineLedgerState({ kind: "noop", nextState: someState }, { committed: false, hadContent: false }, true),
    ).toEqual({ state: someState, wasActive: true, owns: true });
  });

  it("commit landed WITH content → advance, wasActive true, owns true", () => {
    expect(
      resolveInlineLedgerState(
        { kind: "commit", mode: "append", sections: [], nextState: someState },
        { committed: true, hadContent: true },
        false,
      ),
    ).toEqual({ state: someState, wasActive: true, owns: true });
  });

  it("rebuild-empty SUCCESS (no content) → advance, wasActive true, owns CLEARED", () => {
    expect(
      resolveInlineLedgerState(
        { kind: "commit", mode: "rebuild", sections: [], nextState: someState },
        { committed: true, hadContent: false },
        true,
      ),
    ).toEqual({ state: someState, wasActive: true, owns: false });
  });

  it("commit did NOT land → EMPTY, wasActive false, owns true (dirty → force rebuild next)", () => {
    expect(
      resolveInlineLedgerState(
        { kind: "commit", mode: "rebuild", sections: [], nextState: someState },
        { committed: false, hadContent: false },
        true,
      ),
    ).toEqual({ state: EMPTY_INLINE_SCROLLBACK_STATE, wasActive: false, owns: true });
  });

  it("reset → EMPTY, wasActive false, owns carried from prior", () => {
    expect(
      resolveInlineLedgerState({ kind: "reset" }, { committed: false, hadContent: false }, true),
    ).toEqual({ state: EMPTY_INLINE_SCROLLBACK_STATE, wasActive: false, owns: true });
  });

  it("skip → EMPTY, wasActive false, owns carried from prior", () => {
    expect(
      resolveInlineLedgerState({ kind: "skip" }, { committed: false, hadContent: false }, false),
    ).toEqual({ state: EMPTY_INLINE_SCROLLBACK_STATE, wasActive: false, owns: false });
  });

  it("rebuild-empty FAILURE → owns persists; the NEXT active entry still rebuilds empty", () => {
    const failed = resolveInlineLedgerState(
      { kind: "commit", mode: "rebuild", sections: [], nextState: someState },
      { committed: false, hadContent: false },
      true,
    );
    expect(failed).toEqual({ state: EMPTY_INLINE_SCROLLBACK_STATE, wasActive: false, owns: true });
    const next = expectCommit(
      computeInlineLedgerStep({
        active: true,
        hasCommitHandle: true,
        wasActive: failed.wasActive,
        forceRebuild: failed.owns,
        prior: failed.state,
        finalizedSections: [],
        bannerSection: undefined,
        width: 80,
      }),
    );
    expect(next.mode).toBe("rebuild");
  });

  it("commit content → leave (reset) → re-enter with empty source ⇒ rebuild EMPTY (clears owned scrollback)", () => {
    const committedStep = expectCommit(
      computeInlineLedgerStep({
        active: true,
        hasCommitHandle: true,
        wasActive: true,
        forceRebuild: false,
        prior: EMPTY_INLINE_SCROLLBACK_STATE,
        finalizedSections: [sec("a", "1")],
        bannerSection: undefined,
        width: 80,
      }),
    );
    const afterCommit = resolveInlineLedgerState(committedStep, { committed: true, hadContent: true }, false);
    expect(afterCommit.owns).toBe(true);
    const afterLeave = resolveInlineLedgerState({ kind: "reset" }, { committed: false, hadContent: false }, afterCommit.owns);
    expect(afterLeave.owns).toBe(true);
    const reentry = expectCommit(
      computeInlineLedgerStep({
        active: true,
        hasCommitHandle: true,
        wasActive: afterLeave.wasActive,
        forceRebuild: afterLeave.owns,
        prior: afterLeave.state,
        finalizedSections: [],
        bannerSection: undefined,
        width: 80,
      }),
    );
    expect(reentry.mode).toBe("rebuild");
    expect(reentry.sections).toEqual([]);
  });
});

describe("gateInlinePromptModel (FEATURE_214 step 4 — active path replaces <Static>)", () => {
  const model: TranscriptRenderModel = {
    staticSections: [sec("final", "history")],
    sections: [sec("live", "streaming")],
    rows: [{ key: "live-r0", text: "streaming" }],
    previewSections: [],
    previewRows: [],
  };

  it("ledger active → staticSections emptied so MessageList renders NO <Static> for finalized", () => {
    const gated = gateInlinePromptModel(model, true);
    expect(gated.staticSections).toEqual([]);
    // live / dynamic content is preserved (it stays in the cell-frame).
    expect(gated.rows).toEqual(model.rows);
    expect(gated.sections).toEqual(model.sections);
  });

  it("ledger inactive → model unchanged, <Static> stays the fallback (never drop history)", () => {
    const gated = gateInlinePromptModel(model, false);
    expect(gated).toBe(model); // same reference — untouched
    expect(gated.staticSections.length).toBeGreaterThan(0);
  });
});
