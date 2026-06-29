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
 * Used as a fail-safe gate when deciding whether a salvaged tool input is safe
 * to execute: salvaged input is only trustworthy on a clean stop; on a
 * truncating OR ambiguous stop the input may be cut mid-value, so the caller
 * retains the `_truncated` mark and re-asks rather than executing.
 */
export function isCleanStop(raw: string | undefined | null): boolean {
  const c = classifyStopReason(raw);
  return c === 'end' || c === 'tool' || c === 'paused';
}
