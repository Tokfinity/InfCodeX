import { describe, it, expect } from "vitest";
import {
  isInlineLedgerActive,
  computeInlineLedgerStep,
} from "./inline-ledger-controller.js";
import { EMPTY_INLINE_SCROLLBACK_STATE } from "../../tui/substrate/ink/inline-scrollback-ledger.js";
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
