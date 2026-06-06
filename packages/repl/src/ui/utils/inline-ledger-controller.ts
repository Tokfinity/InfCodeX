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
