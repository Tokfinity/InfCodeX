/**
 * FEATURE_214 — inline source-backed scrollback ledger (pure planning core).
 *
 * The long-term inline architecture (docs/features/v0.7.46.md §4) commits finalized
 * history to native scrollback through an EXPLICIT, KodaX-owned ledger keyed by each
 * section's `key` + content `fingerprint` — NOT React `<Static>`'s internal
 * `items.length`/`index` (the Phase 2b transition mechanism). Given the current
 * source-backed sections (the banner prefix + the retained finalized history) and the
 * prior ledger state, it returns a PLAN the engine executes:
 *
 *   - `none`    — the source matches what is already committed; no scrollback write.
 *   - `append`  — the prior commit is an exact prefix of the source; write ONLY the new
 *                 sections to native scrollback, then repaint the bounded live frame.
 *   - `rebuild` — the source diverged from what was committed (terminal width, banner
 *                 prefix, section key order, content fingerprint, or a
 *                 truncation/rollback/clear/compact/source-rewrite); clear KodaX-owned
 *                 scrollback and re-render every retained section from source at the
 *                 current width, then repaint the live frame.
 *
 * The banner is folded in as the first committed section (it sits at the top of
 * scrollback above all finalized history), so the initial write, tail-append, and
 * banner-prefix change all reduce to one uniform key/fingerprint diff.
 *
 * Pure: no terminal writes, no mutation of `prior`. The engine (later steps) executes
 * the returned plan and threads `nextState` back in on the following frame.
 */

/** Identity of one committed section: its stable key + a content fingerprint. */
export interface LedgerEntry {
  readonly key: string;
  readonly fingerprint: string;
}

/** What the ledger has committed to native scrollback so far. Immutable. */
export interface InlineScrollbackLedgerState {
  /** Committed sections in order; `committed[0]` is the banner prefix when `hasBanner`. */
  readonly committed: readonly LedgerEntry[];
  /** Terminal width the committed sections were rendered at. */
  readonly width: number;
  /** Whether `committed[0]` is the banner prefix. */
  readonly hasBanner: boolean;
}

export const EMPTY_INLINE_SCROLLBACK_STATE: InlineScrollbackLedgerState = {
  committed: [],
  width: 0,
  hasBanner: false,
};

export type RebuildReason =
  | "width-change"
  | "banner-change"
  | "key-order-change"
  | "fingerprint-change"
  | "source-rewrite";

export type InlineScrollbackPlan<Section> =
  | { readonly kind: "none" }
  | { readonly kind: "append"; readonly sections: readonly Section[] }
  | {
      readonly kind: "rebuild";
      readonly sections: readonly Section[];
      readonly reason: RebuildReason;
    };

export interface InlineScrollbackInput<Section> {
  /** The banner prefix section, or null. Committed at the top of scrollback. */
  readonly bannerSection: Section | null;
  /** Source-backed retained finalized history sections, in order. */
  readonly finalizedSections: readonly Section[];
  /** Current terminal width. */
  readonly width: number;
}

export interface InlineScrollbackResult<Section> {
  readonly plan: InlineScrollbackPlan<Section>;
  readonly nextState: InlineScrollbackLedgerState;
}

/**
 * Decide the scrollback plan for this frame. `identify` derives each section's
 * `{ key, fingerprint }` from the source (so content edits, reorders and rollbacks are
 * all visible to the diff). Pure — see module docs.
 */
export function planInlineScrollback<Section>(
  input: InlineScrollbackInput<Section>,
  identify: (section: Section) => LedgerEntry,
  prior: InlineScrollbackLedgerState,
): InlineScrollbackResult<Section> {
  const hasBanner = input.bannerSection !== null;
  // Fold the banner in as the first source section (top of scrollback).
  const sources: Section[] =
    input.bannerSection !== null
      ? [input.bannerSection, ...input.finalizedSections]
      : [...input.finalizedSections];
  const current = sources.map(identify);
  const nextState: InlineScrollbackLedgerState = {
    committed: current,
    width: input.width,
    hasBanner,
  };
  const rebuild = (reason: RebuildReason): InlineScrollbackResult<Section> => ({
    plan: { kind: "rebuild", sections: sources, reason },
    nextState,
  });

  const hadCommitted = prior.committed.length > 0;

  // A width change re-wraps every committed row; a banner appearing/disappearing
  // shifts everything below it. Both invalidate the whole committed block.
  if (hadCommitted && prior.width !== input.width) {
    return rebuild("width-change");
  }
  if (hadCommitted && prior.hasBanner !== hasBanner) {
    return rebuild("banner-change");
  }

  // The prior commit must be an exact prefix of the current source for an append.
  const overlap = Math.min(prior.committed.length, current.length);
  for (let i = 0; i < overlap; i++) {
    const wasBanner = hasBanner && i === 0;
    if (prior.committed[i].key !== current[i].key) {
      return rebuild(wasBanner ? "banner-change" : "key-order-change");
    }
    if (prior.committed[i].fingerprint !== current[i].fingerprint) {
      return rebuild(wasBanner ? "banner-change" : "fingerprint-change");
    }
  }

  // Source shrank below what was committed (rollback / clear / compact / rewrite).
  if (current.length < prior.committed.length) {
    return rebuild("source-rewrite");
  }
  // Exact prefix: nothing new, or append the freshly-finalized tail. (On the first
  // frame the empty prior is a prefix of everything, so this appends the banner +
  // all finalized sections — the initial commit.)
  if (current.length === prior.committed.length) {
    return { plan: { kind: "none" }, nextState };
  }
  return {
    plan: { kind: "append", sections: sources.slice(prior.committed.length) },
    nextState,
  };
}
