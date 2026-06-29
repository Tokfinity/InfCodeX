/**
 * Shared parser for streamed tool_use input across all provider transports.
 *
 * Why this exists: when a provider hits `stop_reason: max_tokens`
 * (Anthropic) or `finish_reason: length` (OpenAI-compat) during a
 * tool_use turn, the accumulated `arguments` / `input_json_delta`
 * buffer is truncated mid-JSON. Two compat paths previously diverged:
 *
 *   - anthropic.ts: strict → partial-json salvage → {}
 *   - openai.ts:    strict → {} (lost the partial work)
 *
 * Centralising in one helper means the OpenAI path (deepseek-v4,
 * pay-as-you-go kimi/qwen/zhipu, plus any custom provider extending
 * KodaXOpenAICompatProvider) gets the same recovery as Anthropic-compat.
 *
 * Salvage strategy verified by deepseek-v4 bench (flash + pro, 6
 * truncation runs at 800-8000 max_tokens): all real-world truncations
 * land mid-string in the largest field with clean byte boundaries (no
 * mid-multibyte, no mid-`\uXXXX` escape, no lone backslash). partial-json
 * recovers a usable Record in 100% of observed cases.
 */

import { parse as parsePartialJson } from 'partial-json';

/**
 * Result of {@link parseToolInputWithSalvageTracked}.
 */
export interface ToolInputParseResult {
  /** Parsed input object (always a plain Record; `{}` on total failure). */
  readonly value: Record<string, unknown>;
  /**
   * True when strict `JSON.parse` threw and the value came from the
   * partial-json salvage path (or the `{}` last-resort fallback).
   *
   * Strict-parse SUCCESS — including the array/primitive coercion to
   * `{}` — is NOT salvage (`salvaged: false`), because the buffer was
   * well-formed JSON; only the shape was wrong.
   *
   * `salvaged: true` means the buffer was malformed at the byte level,
   * which for an accumulated streaming tool_use buffer almost always
   * means a `max_tokens` / `length` truncation cut the JSON mid-value.
   * Callers decide whether the recovered input is trustworthy enough to
   * execute by combining this with the stop reason AND the tool's side-effect
   * class (see `KodaXToolUseBlock._truncated` / `isUntrustedSalvage`): a
   * truncating/ambiguous stop is never trusted; a salvage on a clean stop is
   * trusted only for read-only tools — a MUTATING tool (write/edit/bash) is
   * rejected even on a clean stop, since malformed-but-"complete" JSON can be
   * silently cut mid-value.
   */
  readonly salvaged: boolean;
}

/**
 * Parse a tool_use input buffer with three-stage recovery, reporting
 * whether the value had to be salvaged.
 *
 * Stages:
 *   1. strict `JSON.parse` — fast path for the 99% complete case.
 *   2. `partial-json` salvage — closes open strings/brackets and
 *      returns whatever prefix was parseable. Lets the agent loop
 *      surface concrete partial work (e.g. half a `write` payload)
 *      to the model on the next turn instead of pretending the call
 *      had no input.
 *   3. empty `{}` — last-resort fallback for total garbage.
 *
 * Always returns a plain object so the caller can construct a valid
 * `KodaXToolUseBlock` without further type guards.
 */
export function parseToolInputWithSalvageTracked(
  raw: string | undefined | null,
): ToolInputParseResult {
  if (!raw) return { value: {}, salvaged: false };

  try {
    const v = JSON.parse(raw);
    return {
      value: v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {},
      salvaged: false,
    };
  } catch {
    // strict parse failed — the buffer is malformed (almost always a
    // max_tokens/length truncation mid-JSON). Fall through to salvage.
  }

  try {
    const v = parsePartialJson(raw);
    if (process.env.KODAX_DEBUG_TOOL_STREAM) {
      console.warn('[Tool Block Salvaged] partial JSON recovered, rawLength=', raw.length);
    }
    return {
      value: v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {},
      salvaged: true,
    };
  } catch {
    return { value: {}, salvaged: true };
  }
}

/**
 * Back-compat wrapper returning only the parsed object. Prefer
 * {@link parseToolInputWithSalvageTracked} inside provider transports so
 * the truncation signal is not lost.
 */
export function parseToolInputWithSalvage(raw: string | undefined | null): Record<string, unknown> {
  return parseToolInputWithSalvageTracked(raw).value;
}
