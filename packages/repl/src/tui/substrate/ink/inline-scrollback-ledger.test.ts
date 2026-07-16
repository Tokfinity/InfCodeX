import { describe, it, expect } from "vitest";
import {
  EMPTY_INLINE_SCROLLBACK_STATE,
  planInlineScrollback,
  type InlineScrollbackInput,
  type LedgerEntry,
} from "./inline-scrollback-ledger.js";

/**
 * FEATURE_214 — inline source-backed scrollback ledger (Step 1, pure).
 *
 * Each test is a single frame: given (banner + finalized source, width) and the prior
 * ledger state, assert the plan (none / append / rebuild + reason) and the threaded
 * nextState. No UI, no terminal writes.
 */

interface S {
  key: string;
  content: string;
}
const id = (s: S): LedgerEntry => ({ key: s.key, fingerprint: s.content });
const sec = (key: string, content: string): S => ({ key, content });
const input = (
  bannerSection: S | null,
  finalizedSections: S[],
  width = 80,
): InlineScrollbackInput<S> => ({ bannerSection, finalizedSections, width });

const plan = (i: InlineScrollbackInput<S>, prior = EMPTY_INLINE_SCROLLBACK_STATE) =>
  planInlineScrollback(i, id, prior);

describe("inline-scrollback-ledger (FEATURE_214 Step 1)", () => {
  it("empty source → none, state stays empty", () => {
    const { plan: p, nextState } = plan(input(null, []));
    expect(p).toEqual({ kind: "none" });
    expect(nextState.committed).toEqual([]);
  });

  it("initial finalized (no banner) → append ALL", () => {
    const { plan: p, nextState } = plan(input(null, [sec("a", "1"), sec("b", "2")]));
    expect(p.kind).toBe("append");
    if (p.kind !== "append") throw new Error("expected append");
    expect(p.sections.map((s) => s.key)).toEqual(["a", "b"]);
    expect(nextState.committed.map((e) => e.key)).toEqual(["a", "b"]);
    expect(nextState.hasBanner).toBe(false);
  });

  it("initial banner + finalized → append [banner, ...finalized] (banner is written, folded first)", () => {
    const { plan: p, nextState } = plan(input(sec("banner", "KodaX"), [sec("a", "1")]));
    expect(p.kind).toBe("append");
    if (p.kind !== "append") throw new Error("expected append");
    expect(p.sections.map((s) => s.key)).toEqual(["banner", "a"]);
    expect(nextState.committed.map((e) => e.key)).toEqual(["banner", "a"]);
    expect(nextState.hasBanner).toBe(true);
  });

  it("re-render with identical source → none (no re-emit)", () => {
    const first = plan(input(sec("banner", "KodaX"), [sec("a", "1"), sec("b", "2")]));
    const again = plan(input(sec("banner", "KodaX"), [sec("a", "1"), sec("b", "2")]), first.nextState);
    expect(again.plan).toEqual({ kind: "none" });
    expect(again.nextState.committed.map((e) => e.key)).toEqual(["banner", "a", "b"]);
  });

  it("newly-finalized tail → append ONLY the new sections (not the banner, not committed)", () => {
    const first = plan(input(sec("banner", "KodaX"), [sec("a", "1")]));
    const next = plan(input(sec("banner", "KodaX"), [sec("a", "1"), sec("b", "2"), sec("c", "3")]), first.nextState);
    expect(next.plan.kind).toBe("append");
    if (next.plan.kind !== "append") throw new Error("expected append");
    expect(next.plan.sections.map((s) => s.key)).toEqual(["b", "c"]);
  });

  it("width change → rebuild(width-change) carrying ALL sections", () => {
    const first = plan(input(sec("banner", "KodaX"), [sec("a", "1")], 80));
    const wider = plan(input(sec("banner", "KodaX"), [sec("a", "1")], 120), first.nextState);
    expect(wider.plan.kind).toBe("rebuild");
    if (wider.plan.kind !== "rebuild") throw new Error("expected rebuild");
    expect(wider.plan.reason).toBe("width-change");
    expect(wider.plan.sections.map((s) => s.key)).toEqual(["banner", "a"]);
    expect(wider.nextState.width).toBe(120);
  });

  it("banner content change → rebuild(banner-change)", () => {
    const first = plan(input(sec("banner", "KodaX v1"), [sec("a", "1")]));
    const changed = plan(input(sec("banner", "KodaX v2"), [sec("a", "1")]), first.nextState);
    expect(changed.plan.kind).toBe("rebuild");
    if (changed.plan.kind !== "rebuild") throw new Error("expected rebuild");
    expect(changed.plan.reason).toBe("banner-change");
  });

  it("banner appears (was none) with committed content → rebuild(banner-change)", () => {
    const first = plan(input(null, [sec("a", "1")]));
    const withBanner = plan(input(sec("banner", "KodaX"), [sec("a", "1")]), first.nextState);
    expect(withBanner.plan.kind).toBe("rebuild");
    if (withBanner.plan.kind !== "rebuild") throw new Error("expected rebuild");
    expect(withBanner.plan.reason).toBe("banner-change");
    expect(withBanner.plan.sections.map((s) => s.key)).toEqual(["banner", "a"]);
  });

  it("banner disappears → rebuild(banner-change)", () => {
    const first = plan(input(sec("banner", "KodaX"), [sec("a", "1")]));
    const without = plan(input(null, [sec("a", "1")]), first.nextState);
    expect(without.plan.kind).toBe("rebuild");
    if (without.plan.kind !== "rebuild") throw new Error("expected rebuild");
    expect(without.plan.reason).toBe("banner-change");
  });

  it("finalized section reordered → rebuild(key-order-change)", () => {
    const first = plan(input(null, [sec("a", "1"), sec("b", "2")]));
    const reordered = plan(input(null, [sec("b", "2"), sec("a", "1")]), first.nextState);
    expect(reordered.plan.kind).toBe("rebuild");
    if (reordered.plan.kind !== "rebuild") throw new Error("expected rebuild");
    expect(reordered.plan.reason).toBe("key-order-change");
  });

  it("finalized section content edited in place (same key) → rebuild(fingerprint-change)", () => {
    const first = plan(input(null, [sec("a", "1"), sec("b", "2")]));
    const edited = plan(input(null, [sec("a", "1"), sec("b", "EDITED")]), first.nextState);
    expect(edited.plan.kind).toBe("rebuild");
    if (edited.plan.kind !== "rebuild") throw new Error("expected rebuild");
    expect(edited.plan.reason).toBe("fingerprint-change");
  });

  it("source shrinks below committed (rollback / clear / compact) → rebuild(source-rewrite)", () => {
    const first = plan(input(null, [sec("a", "1"), sec("b", "2"), sec("c", "3")]));
    const rolledBack = plan(input(null, [sec("a", "1")]), first.nextState);
    expect(rolledBack.plan.kind).toBe("rebuild");
    if (rolledBack.plan.kind !== "rebuild") throw new Error("expected rebuild");
    expect(rolledBack.plan.reason).toBe("source-rewrite");
    expect(rolledBack.plan.sections.map((s) => s.key)).toEqual(["a"]);
  });

  it("threads state across append → none → append over several frames", () => {
    let st = EMPTY_INLINE_SCROLLBACK_STATE;
    const f1 = plan(input(sec("banner", "K"), [sec("a", "1")]), st);
    expect(f1.plan.kind).toBe("append");
    st = f1.nextState;

    const f2 = plan(input(sec("banner", "K"), [sec("a", "1")]), st); // spinner tick, no change
    expect(f2.plan).toEqual({ kind: "none" });
    st = f2.nextState;

    const f3 = plan(input(sec("banner", "K"), [sec("a", "1"), sec("b", "2")]), st);
    expect(f3.plan.kind).toBe("append");
    if (f3.plan.kind !== "append") throw new Error("expected append");
    expect(f3.plan.sections.map((s) => s.key)).toEqual(["b"]);
  });

  it("after a rebuild, nextState commits the full current set (next frame is none)", () => {
    const first = plan(input(sec("banner", "K"), [sec("a", "1")], 80));
    const rebuilt = plan(input(sec("banner", "K"), [sec("a", "1")], 100), first.nextState);
    expect(rebuilt.plan.kind).toBe("rebuild");
    // The rebuild re-committed everything at the new width → a stable next frame is none.
    const stable = plan(input(sec("banner", "K"), [sec("a", "1")], 100), rebuilt.nextState);
    expect(stable.plan).toEqual({ kind: "none" });
  });
});
