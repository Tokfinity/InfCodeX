export { extractArtifactLedger, mergeArtifactLedger, type CompactionAnchor, type CompactionUpdate } from '@kodax-ai/agent';
import type { KodaXToolUseBlock } from '@kodax-ai/llm';
import { getRequiredToolParams } from './tools/index.js';

export function checkIncompleteToolCalls(toolBlocks: KodaXToolUseBlock[]): string[] {
  const incomplete: string[] = [];
  for (const tc of toolBlocks) {
    // Truncation guard: a tool block salvaged from a max_tokens/length-cut
    // stream is untrustworthy even when every required param looks present —
    // the trailing value may be silently cut mid-string (e.g. half a `write`
    // payload). Flag and skip the per-param scan so the agent loop retries
    // instead of executing corrupt input.
    if (tc._truncated) {
      incomplete.push(`${tc.name}: incomplete input (response truncated mid-call)`);
      continue;
    }
    const required = getRequiredToolParams(tc.name);
    const input = (tc.input ?? {}) as Record<string, unknown>;
    for (const param of required) {
      if (input[param] === undefined || input[param] === null || input[param] === '') {
        incomplete.push(`${tc.name}: missing '${param}'`);
      }
    }
  }
  return incomplete;
}
