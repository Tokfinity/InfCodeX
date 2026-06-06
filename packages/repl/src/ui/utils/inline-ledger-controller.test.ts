import { describe, it, expect } from "vitest";
import {
  isInlineLedgerActive,
  computeInlineLedgerStep,
  resolveInlineLedgerState,
} from "./inline-ledger-controller.js";
import {
  EMPTY_INLINE_SCROLLBACK_STATE,
  type InlineScrollbackLedgerState,
} from "../../tui/substrate/ink/inline-scrollback-ledger.js";
import type { TranscriptSection } from "./transcript-layout.js";

const sec = (key: string, text: string): TranscriptSection => ({
  key,
  rows: [{ key: `${key}-r0`, text }],
});

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
  it("fullscreen / windowed (useRendererViewportShell) → inactive", () => {
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
    prior: EMPTY_INLINE_SCROLLBACK_STATE,
    finalizedSections: [] as TranscriptSection[],
    bannerSection: undefined,
    width: 80,
  };

  it("inactive → reset (no commit — flag off / transcript / fullscreen path)", () => {
    expect(computeInlineLedgerStep({ ...stepBase, active: false }).kind).toBe("reset");
  });

  it("active but handle gone → skip (fall back, do NOT advance state)", () => {
    expect(computeInlineLedgerStep({ ...stepBase, hasCommitHandle: false }).kind).toBe("skip");
  });

  it("re-entry (wasActive false) forces rebuild — never append onto a stale prefix", () => {
    const step = computeInlineLedgerStep({
      ...stepBase,
      wasActive: false,
      finalizedSections: [sec("a", "one")],
    });
    expect(step.kind).toBe("commit");
    if (step.kind !== "commit") throw new Error("expected commit");
    expect(step.mode).toBe("rebuild");
  });

  it("steady-state new finalized → commit append (only the new sections)", () => {
    const first = computeInlineLedgerStep({ ...stepBase, finalizedSections: [sec("a", "one")] });
    expect(first.kind).toBe("commit");
    if (first.kind !== "commit") throw new Error("expected commit");
    const next = computeInlineLedgerStep({
      ...stepBase,
      prior: first.nextState,
      finalizedSections: [sec("a", "one"), sec("b", "two")],
    });
    expect(next.kind).toBe("commit");
    if (next.kind !== "commit") throw new Error("expected commit");
    expect(next.mode).toBe("append");
    expect(next.sections.map((s) => s.key)).toEqual(["b"]);
  });

  it("width change → commit rebuild (req 6)", () => {
    const first = computeInlineLedgerStep({
      ...stepBase,
      width: 80,
      finalizedSections: [sec("a", "one")],
    });
    if (first.kind !== "commit") throw new Error("expected commit");
    const wider = computeInlineLedgerStep({
      ...stepBase,
      prior: first.nextState,
      width: 120,
      finalizedSections: [sec("a", "one")],
    });
    expect(wider.kind).toBe("commit");
    if (wider.kind !== "commit") throw new Error("expected commit");
    expect(wider.mode).toBe("rebuild");
  });

  it("no change → noop (advance only, nothing to commit)", () => {
    const first = computeInlineLedgerStep({ ...stepBase, finalizedSections: [sec("a", "one")] });
    if (first.kind !== "commit") throw new Error("expected commit");
    const same = computeInlineLedgerStep({
      ...stepBase,
      prior: first.nextState,
      finalizedSections: [sec("a", "one")],
    });
    expect(same.kind).toBe("noop");
  });
});

describe("resolveInlineLedgerState (FEATURE_214 failure-path guarantee)", () => {
  const someState: InlineScrollbackLedgerState = {
    committed: [{ key: "a", fingerprint: "1" }],
    width: 80,
    hasBanner: false,
  };

  it("noop → advance to nextState, wasActive true (state consistent)", () => {
    expect(resolveInlineLedgerState({ kind: "noop", nextState: someState }, false)).toEqual({
      state: someState,
      wasActive: true,
    });
  });

  it("successful commit → advance, wasActive true", () => {
    expect(
      resolveInlineLedgerState(
        { kind: "commit", mode: "append", sections: [], nextState: someState },
        true,
      ),
    ).toEqual({ state: someState, wasActive: true });
  });

  it("commit that did NOT land (empty text / throw) → state EMPTY, wasActive false", () => {
    const r = resolveInlineLedgerState(
      { kind: "commit", mode: "append", sections: [sec("a", "x")], nextState: someState },
      false,
    );
    expect(r.state).toBe(EMPTY_INLINE_SCROLLBACK_STATE);
    expect(r.wasActive).toBe(false);
  });

  it("reset → state EMPTY, wasActive false", () => {
    expect(resolveInlineLedgerState({ kind: "reset" }, false)).toEqual({
      state: EMPTY_INLINE_SCROLLBACK_STATE,
      wasActive: false,
    });
  });

  it("skip (handle gone) → state EMPTY, wasActive false", () => {
    expect(resolveInlineLedgerState({ kind: "skip" }, false)).toEqual({
      state: EMPTY_INLINE_SCROLLBACK_STATE,
      wasActive: false,
    });
  });

  it("after a commit that did NOT land, the NEXT change forces a re-entry rebuild (never append)", () => {
    const firstStep = computeInlineLedgerStep({
      active: true,
      hasCommitHandle: true,
      wasActive: true,
      prior: EMPTY_INLINE_SCROLLBACK_STATE,
      finalizedSections: [sec("a", "one")],
      bannerSection: undefined,
      width: 80,
    });
    if (firstStep.kind !== "commit") throw new Error("expected commit");
    // Commit failed to land → state EMPTY, wasActive false (the failure-path guarantee).
    const afterFailure = resolveInlineLedgerState(firstStep, false);
    expect(afterFailure.wasActive).toBe(false);
    expect(afterFailure.state).toBe(EMPTY_INLINE_SCROLLBACK_STATE);

    // Next change: wasActive=false → forced re-entry rebuild, NOT an append onto a stale
    // / unknown scrollback.
    const nextStep = computeInlineLedgerStep({
      active: true,
      hasCommitHandle: true,
      wasActive: afterFailure.wasActive,
      prior: afterFailure.state,
      finalizedSections: [sec("a", "one"), sec("b", "two")],
      bannerSection: undefined,
      width: 80,
    });
    expect(nextStep.kind).toBe("commit");
    if (nextStep.kind !== "commit") throw new Error("expected commit");
    expect(nextStep.mode).toBe("rebuild");
  });
});
