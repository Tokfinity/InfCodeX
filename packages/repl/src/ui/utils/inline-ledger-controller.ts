/**
 * FEATURE_214 — inline scrollback ledger controller (pure decision layer for the
 * InkREPL wiring). Kept pure + separate so the flag/surface gating and the per-frame
 * plan/commit decision are unit-testable without mounting InkREPL. The caller (the
 * InkREPL effect) performs the side effects: render the sections to text, call the
 * engine's commitInlineScrollback, and advance ledger state ONLY after a successful
 * commit.
 */
import {
  EMPTY_INLINE_SCROLLBACK_STATE,
  planInlineScrollback,
  type InlineScrollbackLedgerState,
} from "../../tui/substrate/ink/inline-scrollback-ledger.js";
import { identifyTranscriptSection, type TranscriptSection } from "./transcript-layout.js";

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
  readonly prior: InlineScrollbackLedgerState;
  readonly finalizedSections: readonly TranscriptSection[];
  readonly bannerSection: TranscriptSection | undefined;
  readonly width: number;
}

export type InlineLedgerStep =
  | { readonly kind: "reset" } // not active → drop bookkeeping, no commit
  | { readonly kind: "skip" } // active but handle gone → fall back, do not advance
  | { readonly kind: "noop"; readonly nextState: InlineScrollbackLedgerState } // nothing new
  | {
      readonly kind: "commit";
      readonly mode: "append" | "rebuild";
      readonly sections: readonly TranscriptSection[];
      readonly nextState: InlineScrollbackLedgerState;
    };

/**
 * Decide what the ledger effect should do this frame from the RAW source sections.
 * Pure. A re-entry (`wasActive` false) forces a rebuild so a stale scrollback prefix is
 * never appended onto; a width change is already a rebuild via planInlineScrollback.
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
    identifyTranscriptSection,
    prior,
  );
  if (plan.kind === "none") {
    return { kind: "noop", nextState };
  }
  return {
    kind: "commit",
    mode: reentered ? "rebuild" : plan.kind,
    sections: plan.sections,
    nextState,
  };
}

/**
 * Resolve the next ledger state + `wasActive` from a step and whether a commit actually
 * SUCCEEDED. `wasActive` may become true ONLY in a known-consistent state — a no-op
 * (source already matches committed) or a successful commit. Every other outcome (not
 * active, handle gone, empty render text, or a thrown commit) drops the bookkeeping to
 * EMPTY with `wasActive` false, so the NEXT change forces a re-entry REBUILD rather than
 * appending onto a stale / unknown scrollback. This is the failure-path guarantee: a
 * commit that does not land never advances state and never leaves `wasActive` true.
 */
export function resolveInlineLedgerState(
  step: InlineLedgerStep,
  committed: boolean,
): { state: InlineScrollbackLedgerState; wasActive: boolean } {
  if (step.kind === "noop") {
    return { state: step.nextState, wasActive: true };
  }
  if (step.kind === "commit" && committed) {
    return { state: step.nextState, wasActive: true };
  }
  return { state: EMPTY_INLINE_SCROLLBACK_STATE, wasActive: false };
}
