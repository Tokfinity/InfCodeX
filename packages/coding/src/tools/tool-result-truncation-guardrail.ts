/**
 * Compatibility adapter for the former per-result truncation guardrail.
 * A per-result hook cannot see sibling results or the physical next-request
 * capacity, so calls without an explicit capacity remain lossless.
 *
 * FEATURE_085 (v0.7.26) exposed this adapter for compatibility. The Runner's
 * post-settlement batch transform now owns the only lossy capacity decision.
 */

import type {
  RunnerToolCall,
  RunnerToolResult,
  ToolGuardrail,
  GuardrailContext,
  GuardrailVerdict,
} from '@kodax-ai/agent';

import type { KodaXToolExecutionContext } from '../types.js';

export const TOOL_RESULT_TRUNCATION_GUARDRAIL_NAME = 'tool-result-truncation';

/**
 * Create a compatibility `ToolGuardrail` whose `afterTool` hook explicitly
 * allows every result. It does not touch the call going in (no `beforeTool`).
 *
 * @param ctx The coding-layer execution context retained for API compatibility.
 * @deprecated Use the Runner post-settlement tool-result batch transform.
 */
export function createToolResultTruncationGuardrail(
  _ctx: KodaXToolExecutionContext,
): ToolGuardrail {
  return {
    kind: 'tool',
    name: TOOL_RESULT_TRUNCATION_GUARDRAIL_NAME,
    afterTool: async (
      _call: RunnerToolCall,
      _result: RunnerToolResult,
      _guardrailCtx: GuardrailContext,
    ): Promise<GuardrailVerdict> => {
      // This compatibility hook has no batch siblings or physical request
      // budget. It must therefore remain strictly lossless; the Runner's
      // post-settlement batch transform owns capacity spill decisions.
      return { action: 'allow' };
    },
  };
}
