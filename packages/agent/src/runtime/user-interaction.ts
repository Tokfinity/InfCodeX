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
  default?: string;
}

/**
 * The host-provided user-interaction surface. Each method is optional — a
 * headless host omits them and callers degrade gracefully. This is the single
 * primitive shared by the coding `ask_user_*` tools and the agent's MCP
 * elicitation reverse capability.
 */
export interface UserInteraction {
  /** Ask one question (select mode by default). Resolves the chosen value. */
  askUser?: (options: AskUserQuestionOptions) => Promise<string>;
  /** Ask several independent questions sequentially. Resolves a value map, or
   *  undefined when the user cancels. */
  askUserMulti?: (options: AskUserMultiOptions) => Promise<Record<string, string> | undefined>;
  /** Ask for free-text input. Resolves the text, or undefined when cancelled. */
  askUserInput?: (options: { question: string; default?: string }) => Promise<string | undefined>;
}
