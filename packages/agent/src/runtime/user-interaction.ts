/**
 * FEATURE_222 — user-interaction primitive (agent layer).
 *
 * "Ask the user a question" is needed at BOTH layers: the coding `ask_user_*`
 * tools (LLM-initiated) AND the MCP elicitation reverse capability
 * (server-initiated). The capability historically lived only in
 * `@kodax-ai/coding`, but the MCP runtime lives one layer below in
 * `@kodax-ai/agent` and cannot reach up to it. So the primitive is owned here,
 * at the agent layer, and the host injects ONE implementation that both layers
 * share — coding re-exports these types for backward compatibility.
 *
 * The agent layer is UI-less by design: these are the contract the host
 * (REPL / ACP / SDK) fulfils with its real interaction surface. A headless host
 * leaves them undefined and consumers degrade gracefully (cancel / decline).
 */

/** A single question item used in multi-question mode. */
export interface AskUserQuestionItem {
  question: string;
  header?: string;
  options: Array<{
    label: string;
    description?: string;
    value: string;
  }>;
  multiSelect?: boolean;
  /**
   * FEATURE_222 — only meaningful when `multiSelect` is true. The host should
   * reject (re-prompt / show an error, do NOT resolve) a selection with fewer
   * than `minSelections` items. Absent ⇒ no lower bound.
   */
  minSelections?: number;
  /**
   * FEATURE_222 — only meaningful when `multiSelect` is true. The host should
   * reject a selection with more than `maxSelections` items. Absent ⇒ no upper
   * bound. Lets a host render + validate "pick at most N" structurally instead
   * of parsing it out of natural-language question text.
   */
  maxSelections?: number;
}

/** Options for multi-question mode — multiple independent questions in one call. */
export interface AskUserMultiOptions {
  questions: AskUserQuestionItem[];
}

/** Options for a single question (select or free-text input). */
export interface AskUserQuestionOptions {
  question: string;
  kind?: 'select' | 'input';
  /** Required for kind="select", ignored for kind="input". */
  options?: Array<{
    label: string;
    description?: string;
    value: string;
  }>;
  multiSelect?: boolean;
  /** FEATURE_222 — see {@link AskUserQuestionItem.minSelections}. */
  minSelections?: number;
  /** FEATURE_222 — see {@link AskUserQuestionItem.maxSelections}. */
  maxSelections?: number;
  default?: string;
}

/**
 * FEATURE_222 — reserved option value a host may append as a synthetic option
 * (e.g. a "← Back" entry) in `askUserMulti`'s per-question flow to mean "return
 * to the previous question" instead of answering the current one. Only
 * meaningful for `questions[]` index > 0 (there is no previous before the
 * first). The coding `ask_user_question` tool rejects this as a normal
 * `option.value` supplied by the model, so a host may safely reuse it for its
 * own back-navigation UI. A host that ignores this constant simply never offers
 * back-navigation — the default multi-question flow is unaffected either way.
 */
export const ASK_USER_BACK_SIGNAL = '__back__';

/**
 * FEATURE_222 — narrow an `askUser` result to a single string for the many
 * callers that only ever ask single-select questions (they never set
 * `multiSelect: true`, so the array branch is unreachable at runtime). Collapses
 * an unexpected array to its first element so a mis-configured host degrades
 * predictably instead of leaking `[object Array]` into a string comparison.
 */
export function asSingleSelection(answer: string | string[]): string {
  return Array.isArray(answer) ? answer[0] ?? '' : answer;
}

/**
 * The host-provided user-interaction surface. Each method is optional — a
 * headless host omits them and callers degrade gracefully. This is the single
 * primitive shared by the coding `ask_user_*` tools and the agent's MCP
 * elicitation reverse capability.
 */
export interface UserInteraction {
  /**
   * Ask one question (select mode by default). Single-select (multiSelect
   * falsy) resolves the chosen value as a string — unchanged. Multi-select
   * (multiSelect: true) resolves the selected values as a `string[]`. The union
   * is a backward-compatible superset: a host still returning a plain string
   * satisfies this contract, but a multi-select host SHOULD return `string[]`
   * so option values containing `, ` are not corrupted by a join.
   */
  askUser?: (options: AskUserQuestionOptions) => Promise<string | string[]>;
  /** Ask several independent questions sequentially. Resolves a per-question
   *  value map (each entry a string for single-select, `string[]` for
   *  multi-select), or undefined when the user cancels. */
  askUserMulti?: (options: AskUserMultiOptions) => Promise<Record<string, string | string[]> | undefined>;
  /** Ask for free-text input. Resolves the text, or undefined when cancelled. */
  askUserInput?: (options: { question: string; default?: string }) => Promise<string | undefined>;
}

/**
 * Process-wide "currently live" user-interaction surface. The MCP runtime is
 * constructed at startup, before any interactive loop exists, yet a server can
 * send an elicitation at any later point — so the host registers its live
 * interaction surface here once the interactive loop is running, and the MCP
 * elicitation handler resolves it at CALL time (not construction time). When
 * nothing is registered (headless / between turns) consumers degrade to
 * decline/cancel. Mirrors the existing active-extension-runtime pattern.
 */
let activeUserInteraction: UserInteraction | undefined;

/** Register the live user-interaction surface (host calls this when interactive). */
export function setActiveUserInteraction(interaction: UserInteraction | undefined): void {
  activeUserInteraction = interaction;
}

/** The live user-interaction surface, or undefined when none is active. */
export function getActiveUserInteraction(): UserInteraction | undefined {
  return activeUserInteraction;
}
