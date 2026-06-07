/**
 * FEATURE_214 — inline scrollback ledger controller (pure decision layer for the
 * InkREPL wiring). Kept pure + separate so the flag/surface gating, the per-frame
 * plan/commit decision, and the failure / re-entry state machine are unit-testable
 * without mounting InkREPL. The caller (the InkREPL effect) performs the side effects:
 * render the sections to text, call the engine's commitInlineScrollback, and feed the
 * outcome back through resolveInlineLedgerState.
 */
import {
  EMPTY_INLINE_SCROLLBACK_STATE,
  planInlineScrollback,
  type InlineScrollbackLedgerState,
} from "../../tui/substrate/ink/inline-scrollback-ledger.js";
import {
  identifyTranscriptSection,
  type TranscriptRenderModel,
  type TranscriptSection,
} from "./transcript-layout.js";

export interface InlineLedgerActiveInput {
  /** KODAX_INLINE_LEDGER opt-in (default off). */
  readonly enabled: boolean;
  /** True on the windowed / fullscreen owned-viewport path. */
  readonly useRendererViewportShell: boolean;
  /** True in the Ctrl+O transcript surface. */
  readonly isTranscriptMode: boolean;
  /** Whether the live renderer handle actually exposes commitInlineScrollback. */
  readonly hasCommitHandle: boolean;
}

/**
 * The ledger owns inline finalized history ONLY on the inline main-screen path AND only
 * with a real commit handle. Any other surface (transcript / fullscreen / windowed), the
 * flag being off, or a missing handle → false, so the prompt keeps `<Static>` and history
 * is never dropped.
 */
export function isInlineLedgerActive(input: InlineLedgerActiveInput): boolean {
  return (
    input.enabled &&
    !input.useRendererViewportShell &&
    !input.isTranscriptMode &&
    input.hasCommitHandle
  );
}

export interface InlineLedgerStepInput {
  readonly active: boolean;
  readonly hasCommitHandle: boolean;
  readonly wasActive: boolean;
  /**
   * Whether the native scrollback is currently OWNED by the ledger (it committed content
   * earlier, or is in a dirty/unknown state after a failed commit). On a re-entry with an
   * EMPTY source this forces a rebuild-clear; on a true first activation with nothing owned
   * it stays false so we never pointlessly purge the user's terminal scrollback.
   */
  readonly forceRebuild: boolean;
  readonly prior: InlineScrollbackLedgerState;
  readonly finalizedSections: readonly TranscriptSection[];
  readonly bannerSection: TranscriptSection | undefined;
  readonly width: number;
  /**
   * Section identity for the plan diff. Defaults to `identifyTranscriptSection`. The
   * inline bounded path passes `identifyInlineCommitSection` (timestamp-insensitive) so a
   * streamed `Assistant` line and its finalized `Assistant [HH:MM]` render align (append,
   * never rebuild) despite the header-timestamp text difference.
   */
  readonly identify?: (section: TranscriptSection) => { key: string; fingerprint: string };
}

export type InlineLedgerStep =
  | { readonly kind: "reset" } // not active → drop bookkeeping, no commit
  | { readonly kind: "skip" } // active but handle gone → fall back, do not advance
  | { readonly kind: "noop"; readonly nextState: InlineScrollbackLedgerState } // nothing new
  | {
      readonly kind: "commit";
      readonly mode: "append" | "rebuild";
      // May be EMPTY for a rebuild (a legitimate clear: /clear, rollback-to-0, re-entry
      // onto an owned-but-now-empty scrollback). Never empty for an append.
      readonly sections: readonly TranscriptSection[];
      readonly nextState: InlineScrollbackLedgerState;
    };

/**
 * Decide what the ledger effect should do this frame from the RAW source sections. Pure.
 *
 * Entry (wasActive false — first activation OR re-entry) resets the prior to EMPTY so a
 * stale prefix is never appended onto. What it does then depends on ownership
 * (`forceRebuild` = the ledger owns / dirtied the native scrollback):
 *   - source non-empty, NOT owned (true first activation) → APPEND all. The finalized
 *     history was never painted (the gated live model dropped staticSections), so it is
 *     committed to scrollback ONCE. This must NOT rebuild — a 2J/3J clear on a fresh
 *     start wipes the user's terminal for nothing (the "startup clear" bug).
 *   - source non-empty, owned (real re-entry / resize / rollback) → REBUILD all at the
 *     current width: purge the stale owned scrollback, repaint every section fresh.
 *   - source empty, owned → REBUILD empty (a clear: /clear, rollback-to-0).
 *   - source empty, NOT owned → noop, so a first activation with no history never
 *     3J-clears the terminal.
 * Steady state delegates to planInlineScrollback (append / width-or-content rebuild /
 * none); a source that shrank to empty there is already a rebuild with empty sections.
 */
export function computeInlineLedgerStep(input: InlineLedgerStepInput): InlineLedgerStep {
  if (!input.active) {
    return { kind: "reset" };
  }
  if (!input.hasCommitHandle) {
    return { kind: "skip" };
  }
  const reentered = !input.wasActive;
  const prior = reentered ? EMPTY_INLINE_SCROLLBACK_STATE : input.prior;
  const { plan, nextState } = planInlineScrollback(
    {
      bannerSection: input.bannerSection ?? null,
      finalizedSections: input.finalizedSections,
      width: input.width,
    },
    input.identify ?? identifyTranscriptSection,
    prior,
  );

  if (reentered) {
    if (plan.kind === "none") {
      // Empty source on entry: clear only if the ledger owns/dirtied the scrollback.
      if (input.forceRebuild) {
        return { kind: "commit", mode: "rebuild", sections: input.finalizedSections, nextState };
      }
      return { kind: "noop", nextState };
    }
    // Non-empty source on entry. Owned scrollback (re-entry / resize / rollback) → REBUILD
    // (purge + repaint all). Pristine scrollback (true first activation) → APPEND all: the
    // history was never on screen, so commit it once WITHOUT a 2J/3J clear (startup-clear fix).
    return {
      kind: "commit",
      mode: input.forceRebuild ? "rebuild" : "append",
      sections: plan.sections,
      nextState,
    };
  }

  if (plan.kind === "none") {
    return { kind: "noop", nextState };
  }
  return { kind: "commit", mode: plan.kind, sections: plan.sections, nextState };
}

export interface InlineLedgerCommitOutcome {
  /** Whether commitInlineScrollback was actually invoked AND did not throw. */
  readonly committed: boolean;
  /** Whether the committed text was non-empty (content written vs a clear). */
  readonly hadContent: boolean;
}

export interface InlineLedgerResolution {
  readonly state: InlineScrollbackLedgerState;
  readonly wasActive: boolean;
  /** Updated scrollback-ownership / force-rebuild flag. */
  readonly owns: boolean;
}

/**
 * Resolve the next (state, wasActive, owns) from a step, the commit OUTCOME, and the prior
 * ownership flag. The failure-path guarantee: a commit that did not land never advances
 * state, never leaves wasActive true, and keeps `owns` true (dirty) so the next change
 * forces a rebuild rather than appending onto a stale / unknown scrollback.
 *
 *   - noop                → keep state, wasActive true, owns unchanged.
 *   - commit + landed     → advance state, wasActive true; owns = whether content was
 *                           written (a successful rebuild-EMPTY clears ownership).
 *   - commit + NOT landed → EMPTY state, wasActive false, owns true (dirty → rebuild next).
 *   - reset / skip        → EMPTY state, wasActive false, owns carried from prior.
 */
export function resolveInlineLedgerState(
  step: InlineLedgerStep,
  outcome: InlineLedgerCommitOutcome,
  priorOwns: boolean,
): InlineLedgerResolution {
  if (step.kind === "noop") {
    return { state: step.nextState, wasActive: true, owns: priorOwns };
  }
  if (step.kind === "commit") {
    if (outcome.committed) {
      return { state: step.nextState, wasActive: true, owns: outcome.hadContent };
    }
    // Commit did not land → scrollback is dirty/unknown; force a rebuild next time.
    return { state: EMPTY_INLINE_SCROLLBACK_STATE, wasActive: false, owns: true };
  }
  // reset / skip — carry the prior ownership so a later re-entry still rebuilds if owned.
  return { state: EMPTY_INLINE_SCROLLBACK_STATE, wasActive: false, owns: priorOwns };
}

/**
 * Gate the inline prompt render model for the ledger (FEATURE_214 step 4). When active the
 * ledger OWNS finalized history (committed to native scrollback), so the live model drops
 * `staticSections` and MessageList renders NO `<Static>` for finalized. When inactive the
 * model is returned UNCHANGED so `<Static>` stays the fallback. The ledger always reads the
 * RAW source (promptStaticPortion) in the effect — never this gated model.
 */
export function gateInlinePromptModel(
  model: TranscriptRenderModel,
  ledgerActive: boolean,
): TranscriptRenderModel {
  return ledgerActive ? { ...model, staticSections: [] } : model;
}
