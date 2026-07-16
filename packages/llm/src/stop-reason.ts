export type KodaXStopClass =
  | 'truncated'
  | 'end'
  | 'tool'
  | 'paused'
  | 'refused'
  | 'unknown';

const STOP_REASON_CLASSES: Readonly<Record<string, KodaXStopClass>> = {
  max_tokens: 'truncated',
  length: 'truncated',
  model_context_window_exceeded: 'truncated',
  end_turn: 'end',
  stop: 'end',
  stop_sequence: 'end',
  tool_use: 'tool',
  tool_calls: 'tool',
  function_call: 'tool',
  pause_turn: 'paused',
  refusal: 'refused',
  content_filter: 'refused',
};

export function classifyStopReason(raw: string | undefined | null): KodaXStopClass {
  if (raw === undefined || raw === null) return 'unknown';
  return STOP_REASON_CLASSES[raw.trim().toLowerCase()] ?? 'unknown';
}

/**
 * A "clean" stop is one where the model finished a complete unit of work —
 * `end_turn`/`stop` (end), `tool_use`/`tool_calls` (tool), or `pause_turn`
 * (paused). It is NOT clean when the stream was truncated (`max_tokens`/
 * `length`) or when the stop reason is ambiguous (`unknown` — e.g. a custom
 * compat provider that omits or nulls the field) or a refusal.
 *
 * Used as one input to the salvaged-tool-input trust decision (see
 * `checkIncompleteToolCalls` / `isUntrustedSalvage`): a truncating OR ambiguous
 * stop marks the input `_truncated` (unsafe for ANY tool). A clean stop does
 * NOT by itself make a salvaged input safe — a clean-stop salvage on a MUTATING
 * tool (write/edit/bash) is still rejected, because malformed-but-"complete"
 * JSON can be silently cut mid-value; only read-only tools execute it.
 */
export function isCleanStop(raw: string | undefined | null): boolean {
  const c = classifyStopReason(raw);
  return c === 'end' || c === 'tool' || c === 'paused';
}
