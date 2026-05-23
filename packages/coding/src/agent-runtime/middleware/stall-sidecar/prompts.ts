/**
 * FEATURE_178 (v0.7.42) — sidecar prompt assets pinned by the eval contract.
 *
 * `SIDECAR_SYSTEM_PROMPT`, `REPORT_TOOL`, `renderTranscript` and
 * `buildSidecarUserMessage` were originally authored inline in the
 * F178 eval `cases.ts` (`benchmark/datasets/feature-178-stall-sidecar/`)
 * and validated end-to-end at SHIP-SIDECAR-ALL (149/150 PASS, 0% audit
 * disagreement). When the production sidecar invoker landed, this file
 * became their canonical home so production code does not import from
 * the `benchmark/` test-fixture tree. The eval re-exports from here so
 * the eval contract is grounded in production strings — any future
 * drift breaks both at once.
 *
 * **Do not edit casually**. The SHIP-SIDECAR-ALL verdict is pinned to
 * this exact wording. Material changes invalidate the eval's evidence
 * for SHIP and would require re-running the canonical 5-alias panel.
 *
 * **FEATURE_190 (v0.7.43) exception**: the `suggestedTool` enum was
 * narrowed from 9 to 8 entries (removed `emit_handoff` — the tool is
 * being deleted in F190 Phase 3). The F178 eval's isStuck accuracy
 * does NOT depend on `emit_handoff` being a recommendable nudge target
 * (the eval probes the isStuck=true/false judgment, not the
 * `suggestedTool` field semantics), so SHIP-SIDECAR-ALL evidence
 * transfers. Future enum SHRINKS that follow the same rule (removing
 * a tool that no longer exists) do not require re-running the panel;
 * any other change (wording, isStuck criteria, transcript framing,
 * or ENUM EXPANSION introducing a new recommended tool) does.
 *
 * Pure data + pure-function — no side effects, no I/O.
 */

import type { KodaXMessage, KodaXToolDefinition } from '@kodax-ai/llm';

/**
 * Sidecar SYSTEM_PROMPT — pinned by the FEATURE_178 eval. Establishes
 * (a) role separation (sidecar is reading, not authoring), (b) the
 * decision criteria (isStuck=true / isStuck=false), and (c) the output
 * format (single forced tool call, no narration).
 */
export const SIDECAR_SYSTEM_PROMPT: string = [
  'You are a stall-detector for an autonomous coding agent. A DIFFERENT agent (the "main agent") has been running and has issued the same tool call multiple times in a row. A rule-based detector flagged this as a potential stall. Your job is to do a second-pass judgment by reading the main agent\'s recent transcript.',
  '',
  '# IMPORTANT — role separation',
  '',
  'The transcript shown to you contains the MAIN AGENT\'s past messages and tool calls. You are NOT the author of those messages. You are a third-party observer judging whether that agent is stuck. Do not say "I read the file" or "my behavior" — the actions in the transcript belong to the main agent, not you. Your only action is to call `report_stall_judgment` once.',
  '',
  '# Decision criteria',
  '',
  'Classify the repetition as **isStuck=true** ONLY when the main agent has made no real progress between the repeated calls:',
  '- Same tool + same input args repeatedly invoked',
  '- No new information gathered between calls (tool_results are identical or stub-served, OR no other tool was called between repeats)',
  '- No substantive textual reasoning that indicates a forward step',
  '- The cache may have already served a "[Read Cache] unchanged" stub — if the model continues calling read on that target after the stub, that is a strong stall signal',
  '',
  'Classify as **isStuck=false** when the repetition is part of a legitimate iterative workflow:',
  '- The model called other distinct tools between the repeats (progressing on other axes)',
  '- The repeated call follows a substantive textual reasoning step ("now verifying that the edit landed", "let me re-check after my batch of changes")',
  '- The model is updating todo items in batches — re-marking the same todo as completed alongside new ones is wasteful but not stuck',
  '- The model is performing legitimate verification (read same file after an edit it just made)',
  '',
  '# Output format',
  '',
  'Call the `report_stall_judgment` tool exactly once. Do not narrate. Do not call any other tool.',
  '',
  'If isStuck=true, populate `nudge` with a concrete, actionable next step the main agent could take — reference one specific tool name from the registry (read, edit, write, grep, bash, task_stop). Keep nudge ≤ 600 chars.',
  '',
  'If isStuck=false, leave nudge empty.',
].join('\n');

/**
 * `report_stall_judgment` tool definition — pinned by the FEATURE_178
 * eval. Forces a structured output: `isStuck` boolean + reason +
 * suggestedTool + nudge.
 */
export const REPORT_TOOL: KodaXToolDefinition = {
  name: 'report_stall_judgment',
  description:
    'Report your second-pass judgment of whether the main agent is in a real stall. Call this exactly once.',
  input_schema: {
    type: 'object',
    properties: {
      isStuck: {
        type: 'boolean',
        description:
          'true = main agent has lost progress and needs a nudge; false = repetition is part of a legitimate flow.',
      },
      reason: {
        type: 'string',
        description:
          'One-sentence rationale citing the specific evidence in the recent history (≤200 chars).',
      },
      suggestedTool: {
        type: 'string',
        description:
          'When isStuck=true, the specific tool name the main agent should call next. Must be one of: read, edit, write, multi_edit, grep, glob, bash, task_stop. Empty string when isStuck=false.',
      },
      nudge: {
        type: 'string',
        description:
          'When isStuck=true, a single concrete instruction the main agent will see as a synthetic user message. Reference suggestedTool by name. ≤600 chars. Empty string when isStuck=false.',
      },
    },
    required: ['isStuck', 'reason', 'suggestedTool', 'nudge'],
  },
};

/**
 * Render a main-agent transcript as third-person text. Embedding the
 * transcript in the user message (instead of as priorMessages) is
 * critical: if assistant-role messages are passed via priorMessages,
 * the sidecar interprets them as ITS OWN past actions ("I read the
 * file") and mis-attributes the stall behaviour. Rendering as text
 * makes the judge/judged separation unambiguous.
 *
 * Output starts with `=== MAIN AGENT TRANSCRIPT (...) ===` header and
 * ends with `=== END TRANSCRIPT ===` so the sidecar can spot the
 * delimiters. Assistant turns are 1-indexed so the sidecar can refer
 * to them by ordinal in `reason`.
 */
export function renderTranscript(
  messages: readonly KodaXMessage[],
): string {
  const lines: string[] = [
    '=== MAIN AGENT TRANSCRIPT (you are reading, not authoring) ===',
  ];
  let assistantTurnIdx = 0;
  for (const m of messages) {
    if (m.role === 'system') {
      const text = typeof m.content === 'string'
        ? m.content
        : m.content
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join('\n');
      lines.push('', `[SYSTEM]`, text);
      continue;
    }
    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        lines.push('', `[USER → MAIN AGENT]`, m.content);
      } else {
        const toolResults = m.content.filter((b) => b.type === 'tool_result');
        if (toolResults.length > 0) {
          for (const tr of toolResults) {
            const trBlock = tr as { tool_use_id: string; content: string };
            lines.push('', `[TOOL_RESULT for ${trBlock.tool_use_id}]`, trBlock.content);
          }
        } else {
          const text = m.content
            .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
            .map((b) => b.text)
            .join('\n');
          if (text) lines.push('', `[USER → MAIN AGENT]`, text);
        }
      }
      continue;
    }
    if (m.role === 'assistant') {
      assistantTurnIdx++;
      lines.push('', `[MAIN AGENT — assistant turn ${assistantTurnIdx}]`);
      if (typeof m.content === 'string') {
        lines.push(`text: ${m.content}`);
        continue;
      }
      for (const b of m.content) {
        if (b.type === 'text') {
          lines.push(`text: ${b.text}`);
        } else if (b.type === 'tool_use') {
          const useBlock = b as { id: string; name: string; input: unknown };
          lines.push(
            `tool_use: ${useBlock.name}(${JSON.stringify(useBlock.input)}) [id=${useBlock.id}]`,
          );
        }
      }
    }
  }
  lines.push('', '=== END TRANSCRIPT ===');
  return lines.join('\n');
}

/**
 * Build the final user-message body the sidecar invocation will see.
 * The body order is fixed (envelope → transcript → action prompt) so
 * the sidecar's attention pattern stays consistent with the eval.
 *
 * Production callers (and the eval driver) both go through this
 * helper. The eval's `buildSidecarUserMessage(StallCase)` wraps this
 * to keep its fixture-type ergonomics.
 */
export function buildSidecarUserMessage(params: {
  /** Pre-rendered L1 signal envelope (see stall-detector.ts). */
  readonly signalEnvelope: string;
  /** Recent main-agent messages to render as the transcript. */
  readonly recentMessages: readonly KodaXMessage[];
}): string {
  return [
    params.signalEnvelope,
    '',
    renderTranscript(params.recentMessages),
    '',
    'Judge whether the main agent in the transcript above is in a real stall. Call report_stall_judgment exactly once.',
  ].join('\n');
}
