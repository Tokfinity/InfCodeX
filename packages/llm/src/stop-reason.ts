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
