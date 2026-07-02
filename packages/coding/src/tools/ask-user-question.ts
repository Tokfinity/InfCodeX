/**
 * KodaX AskUserQuestion Tool
 *
 * 交互式提问工具 - 允许 LLM 在需要时主动向用户提问
 * Supports: single-select, multi-select, free-text input, and multi-question modes.
 */

import type { KodaXToolExecutionContext } from '../types.js';
import { ASK_USER_BACK_SIGNAL } from '@kodax-ai/agent';
import { CANCELLED_TOOL_RESULT_PREFIX, CANCELLED_TOOL_RESULT_MESSAGE } from '../constants.js';

/**
 * Reserved sentinel value used by the REPL for back-navigation in multi-question
 * mode. Single source of truth lives at the agent layer (FEATURE_222) so hosts
 * and this tool agree on the exact string.
 */
const BACK_SENTINEL = ASK_USER_BACK_SIGNAL;

export interface AskUserQuestionOption {
  label: string;
  description?: string;
  value?: string;
}

/** A single question within a multi-question batch. */
export interface AskUserQuestionItemInput {
  question: string;
  header?: string;
  options: AskUserQuestionOption[];
  multi_select?: boolean;
  /** Only meaningful when multi_select is true — see tool schema. */
  min_selections?: number;
  max_selections?: number;
}

export interface AskUserQuestionInput {
  question: string;
  kind?: "select" | "input";
  options?: AskUserQuestionOption[];
  multi_select?: boolean;
  /** Only meaningful when multi_select is true — see tool schema. */
  min_selections?: number;
  max_selections?: number;
  default?: string;
  /** Multiple independent questions — takes precedence over question+options when provided. */
  questions?: AskUserQuestionItemInput[];
}

/**
 * Coerce a model-supplied selection bound into a non-negative integer, or
 * undefined when absent/invalid. The bound is a soft UI hint for the host, so
 * we drop garbage silently rather than erroring the whole call.
 */
function toSelectionBound(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

/**
 * Ask user a question with multiple interaction modes.
 *
 * This tool requires context.askUser (select) or context.askUserInput (input)
 * callback to be provided by the REPL layer.
 */
export async function toolAskUserQuestion(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext
): Promise<string> {
  // === Multi-question mode: takes precedence when questions array is provided ===
  if (Array.isArray(input.questions) && input.questions.length > 0) {
    if (!ctx.askUserMulti) {
      return '[Tool Error] ask_user_question: Multi-question mode not available (askUserMulti callback not provided)';
    }

    // Validate each question item
    for (const item of input.questions as AskUserQuestionItemInput[]) {
      if (!item.question || typeof item.question !== 'string') {
        return '[Tool Error] ask_user_question: Each item in "questions" must have a "question" string';
      }
      if (!Array.isArray(item.options) || item.options.length === 0) {
        return `[Tool Error] ask_user_question: Question "${item.question}" must have a non-empty "options" array`;
      }
      // Reject reserved sentinel values to prevent back-navigation collision
      for (const opt of item.options) {
        const resolvedValue = opt.value || opt.label || String(opt);
        if (resolvedValue === BACK_SENTINEL) {
          return `[Tool Error] ask_user_question: Option value "${BACK_SENTINEL}" is reserved and cannot be used`;
        }
      }
    }

    try {
      const answers = await ctx.askUserMulti({
        questions: (input.questions as AskUserQuestionItemInput[]).map((q) => ({
          question: q.question,
          header: q.header,
          options: q.options.map((opt) => ({
            label: opt.label || String(opt),
            description: opt.description,
            value: opt.value || opt.label || String(opt),
          })),
          multiSelect: q.multi_select === true,
          minSelections: toSelectionBound(q.min_selections),
          maxSelections: toSelectionBound(q.max_selections),
        })),
      });

      if (answers === undefined) {
        return CANCELLED_TOOL_RESULT_MESSAGE;
      }

      return JSON.stringify({
        success: true,
        answers,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return `[Tool Error] ask_user_question: ${errorMsg}`;
    }
  }

  // Validate input for single-question mode
  if (!input.question || typeof input.question !== 'string') {
    return '[Tool Error] ask_user_question: Missing or invalid required parameter: question';
  }

  const kind = (input.kind as string) ?? 'select';

  // === Input mode: free-text ===
  if (kind === 'input') {
    if (!ctx.askUserInput) {
      return '[Tool Error] ask_user_question: Interactive input mode not available (askUserInput callback not provided)';
    }

    try {
      const userText = await ctx.askUserInput({
        question: input.question,
        default: input.default as string | undefined,
      });

      // Issue 114: User pressed ESC (undefined) → signal cancellation.
      if (userText === undefined) {
        return CANCELLED_TOOL_RESULT_MESSAGE;
      }

      return JSON.stringify({
        success: true,
        choice: userText,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return `[Tool Error] ask_user_question: ${errorMsg}`;
    }
  }

  // === Select mode (single or multi) ===
  if (!Array.isArray(input.options) || input.options.length === 0) {
    return '[Tool Error] ask_user_question: Missing required parameter: options (must be a non-empty array for select mode)';
  }

  // Check if askUser callback is available
  if (!ctx.askUser) {
    return '[Tool Error] ask_user_question: Interactive mode not available (askUser callback not provided)';
  }

  try {
    // Call the interactive callback
    const userChoice = await ctx.askUser({
      question: input.question,
      kind: 'select',
      options: (input.options as AskUserQuestionOption[]).map((opt) => ({
        label: opt.label || String(opt),
        description: opt.description,
        value: opt.value || opt.label || String(opt),
      })),
      multiSelect: input.multi_select === true,
      minSelections: toSelectionBound(input.min_selections),
      maxSelections: toSelectionBound(input.max_selections),
      default: input.default as string | undefined,
    });

    // Multi-select (FEATURE_222) resolves the selected values as an array — an
    // array is never a cancellation signal (cancellation is always the string
    // sentinel), so guard the array case FIRST before any string method call.
    if (Array.isArray(userChoice)) {
      return JSON.stringify({
        success: true,
        choices: userChoice,
      });
    }

    // Issue 114: askUser returns '[Cancelled]' prefix when user presses ESC.
    // Pass through directly so the agent loop detects cancellation.
    if (userChoice.startsWith(CANCELLED_TOOL_RESULT_PREFIX)) {
      return userChoice;
    }

    return JSON.stringify({
      success: true,
      choice: userChoice,
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return `[Tool Error] ask_user_question: ${errorMsg}`;
  }
}
