/**
 * Dataset — FEATURE_178 stall sidecar viability probe (2026-05-20)
 *
 * **Status**: Pilot stage. Validates whether the KodaX main model can
 * serve as its own stall-detection sidecar.
 *
 * **Background**: Stage 1 of the kimi-loop investigation (FEATURE_177)
 * shipped a read-file-state cache that suppresses re-reads of unchanged
 * files. Stage 2 adds a runtime stall detector that catches the case
 * where a model keeps issuing the same tool call despite the cache
 * telling it the content is unchanged. The detector's design has two
 * layers:
 *
 *   - L1 (rule, opencode-equivalent): same toolName + JSON.stringify(input)
 *     three times in the current assistant message OR twice after a cache
 *     hit across compaction. Catches the structural pattern.
 *   - L2 (sidecar LLM, this eval): second-pass classification — given the
 *     L1 signal + last few messages, the sidecar judges whether the
 *     repetition is a real stall (model has lost progress) or a legitimate
 *     redundancy (model is making progress despite the repeat).
 *
 * The sidecar's value is **precision on legitimate repeats**: a pure-rule
 * detector that fires on every L1 hit would nudge the model out of
 * legitimate iterative patterns (grep refinement, todo re-mark after a
 * batch). The sidecar should agree with the rule on real stalls and
 * override it on legitimate repeats.
 *
 * **Why sidecar uses the main model**: zero extra config. Each user's
 * provider preferences automatically apply. Per-alias data-driven
 * fallback: if the canonical 5-alias panel shows a given alias has
 * sidecar precision <50%, that alias falls back to hardcoded nudge.
 *
 * **EVAL_GUIDELINES Layer**: Layer 2 single-turn probe.
 *
 * **Layer 1 check first**: can this be answered by code reading or unit
 * test? **NO** — the question is whether an LLM, given a stuck-looking
 * history envelope, will reach a correct verdict. That is purely a
 * behavioural distribution question; no static analysis answers it.
 *
 * **Mechanical assertion**: the sidecar must call exactly one tool,
 * `report_stall_judgment`, with an `isStuck` boolean in its input. The
 * driver extracts `result.toolCalls[0].input.isStuck` and compares it to
 * the case's `expectedIsStuck`. Tool-call assertion (not regex) — anti-
 * pattern 7 does not apply.
 *
 * **Panel**: canonical 5-alias panel per EVAL_GUIDELINES — pilot uses
 * `ds/v4flash` floor only.
 *
 * **Pilot topology**: 1 alias × 2 cases × 1 run = 2 probes (~$0.01).
 * **Scale topology** (post-pilot): 5 alias × 6 cases × 5 runs = 150
 * probes (~$10).
 *
 * **Pre-registered decision matrix** (frozen BEFORE any scale run):
 *
 *   Define per-alias:
 *     pos_recall(α)  = correct isStuck=true rate across positive cases
 *     neg_precision(α) = correct isStuck=false rate across negative cases
 *     tool_hallucinate(α) = rate of suggestedTool not in known registry
 *
 *   Decision (apply in order; first match wins):
 *
 *     1. SHIP-SIDECAR-ALL if pos_recall ≥ 80% AND neg_precision ≥ 80%
 *        AND tool_hallucinate ≤ 5% on ≥4/5 alias.
 *        → ship LLM sidecar; per-alias fallback only for the 0-1 alias
 *          that misses the bar.
 *
 *     2. SHIP-SIDECAR-PARTIAL if ≥3 alias satisfy (1) but 1-2 alias
 *        have neg_precision ≥ 80% but pos_recall < 80%.
 *        → ship LLM sidecar on the passing alias; on the failing alias
 *          run sidecar AND hardcoded in parallel (sidecar's veto only
 *          when it says isStuck=false — preserves recall while keeping
 *          precision gain).
 *
 *     3. DROP-SIDECAR if ≥3 alias have neg_precision < 80%.
 *        → sidecar self-judgment is too unreliable. Ship hardcoded
 *          nudge for all alias; sidecar disabled.
 *
 *     4. DEFER if outcomes don't fall cleanly into 1-3 (e.g. cross-alias
 *        variance too high to read).
 *        → enlarge eval (more runs / more cases) and re-decide.
 *
 * **Pilot pre-registered gate** (lighter, just enough to validate design):
 *   - P1 (synthetic clear stall) MUST yield isStuck=true on ds/v4flash
 *   - N1 (real session legitimate repeat) MUST yield isStuck=false
 *   - Both MUST emit exactly one report_stall_judgment tool call
 *   - Tool call MUST have schema-valid isStuck boolean
 *
 *   If pilot fails any check: revise sidecar SYSTEM_PROMPT or report
 *   tool description; rerun pilot. Do NOT proceed to scale until pilot
 *   passes — anti-pattern 4 (探索期就开多 alias).
 */

import type { KodaXMessage, KodaXToolDefinition } from '@kodax-ai/llm';

// ─── Sidecar SYSTEM_PROMPT ─────────────────────────────────────────────

export const SIDECAR_SYSTEM_PROMPT = [
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
  'If isStuck=true, populate `nudge` with a concrete, actionable next step the main agent could take — reference one specific tool name from the registry (read, edit, write, grep, bash, task_stop, emit_handoff). Keep nudge ≤ 600 chars.',
  '',
  'If isStuck=false, leave nudge empty.',
].join('\n');

// ─── Report tool — forces structured output ────────────────────────────

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
          'When isStuck=true, the specific tool name the main agent should call next. Must be one of: read, edit, write, multi_edit, grep, glob, bash, task_stop, emit_handoff. Empty string when isStuck=false.',
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

export const TOOLS = [REPORT_TOOL];

// ─── Cases ─────────────────────────────────────────────────────────────

export interface StallCase {
  /** Stable id used in dump filenames. */
  readonly id: string;
  /** Short description for logs. */
  readonly description: string;
  /** Expected sidecar judgment. */
  readonly expectedIsStuck: boolean;
  /** Main agent's recent history — rendered into a third-person transcript inside the user message. */
  readonly recentMessages: readonly KodaXMessage[];
  /** Stall detector signal envelope; rendered first in the user message body. */
  readonly signalEnvelope: string;
}

/**
 * Render the main agent transcript as third-person text. Embedding the
 * transcript in the user message (instead of as priorMessages) is critical:
 * if assistant-role messages are passed via priorMessages, the sidecar
 * model interprets them as ITS OWN past actions ("I read the file") and
 * mis-attributes the stall behaviour. Rendering as text makes the
 * judge/judged separation unambiguous.
 */
export function renderTranscript(messages: readonly KodaXMessage[]): string {
  const lines: string[] = ['=== MAIN AGENT TRANSCRIPT (you are reading, not authoring) ==='];
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
 * Build the final user message a sidecar invocation will see. Driver code
 * calls this — keeps the case data minimal and the rendering centralised.
 */
export function buildSidecarUserMessage(c: StallCase): string {
  return [
    c.signalEnvelope,
    '',
    renderTranscript(c.recentMessages),
    '',
    'Judge whether the main agent in the transcript above is in a real stall. Call report_stall_judgment exactly once.',
  ].join('\n');
}

/**
 * P1 — synthetic clear stall, same turn.
 *
 * Main agent reads index.html three times with identical args, with no
 * intervening tool calls and only filler text between. Cache served the
 * unchanged stub on the second and third reads. This is the textbook
 * doom-loop the user originally reported.
 */
const P1_CASE: StallCase = {
  id: 'P1-clear-stall-cache-hit',
  description:
    'Three identical read calls in close succession; cache served unchanged-stub twice; no other tools called between.',
  expectedIsStuck: true,
  signalEnvelope:
    '[Stall detector signal]\n'
    + 'tool=read input={"path":"C:/proj/index.html","offset":1,"limit":2000} '
    + 'occurrence_count=3 cache_hit_count=2 turns=[12,13,14]',
  recentMessages: [
    {
      role: 'user',
      content: 'Please analyze the structure of C:/proj/index.html and tell me what frameworks it uses.',
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: "I'll read the file to inspect it.",
        },
        {
          type: 'tool_use',
          id: 'tu_p1_1',
          name: 'read',
          input: { path: 'C:/proj/index.html', offset: 1, limit: 2000 },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_p1_1',
          content:
            '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<title>Risk Agent</title>\n<link rel="stylesheet" href="style.css">\n<script src="vendor/react.production.min.js"></script>\n<script src="vendor/react-dom.production.min.js"></script>\n</head>\n<body>\n<div id="root"></div>\n<script src="app.js"></script>\n</body>\n</html>',
        },
      ],
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'Let me re-read to be sure.',
        },
        {
          type: 'tool_use',
          id: 'tu_p1_2',
          name: 'read',
          input: { path: 'C:/proj/index.html', offset: 1, limit: 2000 },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_p1_2',
          content:
            '[Read Cache] C:/proj/index.html is unchanged since you read it earlier in this task (offset=1, limit=2000). The content from the earlier read tool_result in this conversation is still current — refer to that instead of re-reading. To see other regions of the file, call read with a different offset/limit. mtime-based auto-invalidation is active.',
        },
      ],
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'I need to read it once more to confirm.',
        },
        {
          type: 'tool_use',
          id: 'tu_p1_3',
          name: 'read',
          input: { path: 'C:/proj/index.html', offset: 1, limit: 2000 },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_p1_3',
          content:
            '[Read Cache] C:/proj/index.html is unchanged since you read it earlier in this task (offset=1, limit=2000). The content from the earlier read tool_result in this conversation is still current — refer to that instead of re-reading. To see other regions of the file, call read with a different offset/limit. mtime-based auto-invalidation is active.',
        },
      ],
    },
  ],
};

/**
 * N1 — real session legitimate repeat (kimi todo_update batch pattern).
 *
 * Extracted from `runner-1778736171470.jsonl` around the first occurrence
 * of `todo_update {id: todo_2, status: completed}`. The model is actively
 * working — dispatching child tasks, running bash commands, advancing
 * other todos — and re-marks todo_2 completed alongside other todos in a
 * batch update. Wasteful but not stuck.
 *
 * Sanitized: shell commands truncated; child task objectives elided to
 * keep envelope under ~2KB while preserving the progress signal.
 */
const N1_CASE: StallCase = {
  id: 'N1-real-todo-update-batch',
  description:
    'Real kimi session: model re-marks todo_2 completed in a batch alongside new todos after dispatching child tasks. Active progress between repeats.',
  expectedIsStuck: false,
  signalEnvelope:
    '[Stall detector signal]\n'
    + 'tool=todo_update input={"id":"todo_2","status":"completed"} '
    + 'occurrence_count=3 cache_hit_count=0 turns=[33,42,57]',
  recentMessages: [
    {
      role: 'user',
      content: 'Review the changes since v0.7.41 and write a summary report.',
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'I will inspect the last 10 commits and dispatch child tasks to deep-dive the major changes.',
        },
        {
          type: 'tool_use',
          id: 'tu_n1_1',
          name: 'dispatch_child_task',
          input: {
            id: 'child_round_boundary',
            model_hint: 'deep',
            objective: 'Analyze the round-boundary refactor in packages/coding',
          },
        },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu_n1_1', content: '<task-dispatched id="child_round_boundary"/>' },
      ],
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'Now marking the boundary-investigation todo as completed.',
        },
        {
          type: 'tool_use',
          id: 'tu_n1_2',
          name: 'todo_update',
          input: { id: 'todo_2', status: 'completed' },
        },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu_n1_2', content: 'todo_2 marked completed' },
      ],
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'Three child tasks dispatched. Reading source files in parallel to verify some details.',
        },
        {
          type: 'tool_use',
          id: 'tu_n1_3',
          name: 'read',
          input: { path: 'packages/coding/src/agent.ts', offset: 1, limit: 80 },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_n1_3',
          content: "import { runKodaX } from './runner.js';\nimport { createCodingTools } from './tools/index.js';\n// ... (50 lines elided)",
        },
      ],
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'Child results are arriving. Now batch-updating todos: completing todo_2 again as a recap, plus todo_3 and todo_4 which finished.',
        },
        {
          type: 'tool_use',
          id: 'tu_n1_4',
          name: 'todo_update',
          input: { id: 'todo_2', status: 'completed' },
        },
        {
          type: 'tool_use',
          id: 'tu_n1_5',
          name: 'todo_update',
          input: { id: 'todo_3', status: 'completed' },
        },
        {
          type: 'tool_use',
          id: 'tu_n1_6',
          name: 'todo_update',
          input: { id: 'todo_4', status: 'in_progress' },
        },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu_n1_4', content: 'todo_2 already completed (no-op)' },
        { type: 'tool_result', tool_use_id: 'tu_n1_5', content: 'todo_3 marked completed' },
        { type: 'tool_result', tool_use_id: 'tu_n1_6', content: 'todo_4 marked in_progress' },
      ],
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'Now verifying the vitest config differences flagged by the boundary child task.',
        },
        {
          type: 'tool_use',
          id: 'tu_n1_7',
          name: 'grep',
          input: { pattern: 'pool:', glob: 'vitest.config.ts', output_mode: 'content' },
        },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu_n1_7', content: 'packages/coding/vitest.config.ts:7:    pool: "threads"\npackages/agent/vitest.config.ts:5:    pool: "forks"' },
      ],
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'Confirmed. Marking summary todo as completed too — it overlaps with todo_2.',
        },
        {
          type: 'tool_use',
          id: 'tu_n1_8',
          name: 'todo_update',
          input: { id: 'todo_2', status: 'completed' },
        },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu_n1_8', content: 'todo_2 already completed (no-op)' },
      ],
    },
  ],
};

/**
 * P2 — stall across a compaction boundary; cache served stubs after re-read.
 *
 * Model reads a file, history is compacted (summary message appears),
 * model re-reads the same file twice — cache responds with unchanged-stub
 * both times. No interleaved progress. Mimics the original kimi
 * RiskAgentPlatform/index.html loop the user reported.
 */
const P2_CASE: StallCase = {
  id: 'P2-cross-compaction-cache-hit',
  description:
    'Read after compaction summary; cache returns unchanged-stub twice; no progress between repeats.',
  expectedIsStuck: true,
  signalEnvelope:
    '[Stall detector signal]\n'
    + 'tool=read input={"path":"src/auth.ts","offset":1,"limit":2000} '
    + 'occurrence_count=3 cache_hit_count=2 turns=[8,22,23]',
  recentMessages: [
    {
      role: 'system',
      content:
        '[对话历史摘要] Earlier in the session the agent read src/auth.ts (offset=1, limit=2000) and the full file content was captured in that read tool_result. No edits or other tools were called against auth.ts.',
    },
    {
      role: 'system',
      content: '[Post-compact: recent operations]\nRead: src/auth.ts',
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'I should re-read auth.ts to ground my session-handling review.',
        },
        {
          type: 'tool_use',
          id: 'tu_p2_1',
          name: 'read',
          input: { path: 'src/auth.ts', offset: 1, limit: 2000 },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_p2_1',
          content:
            '[Read Cache] src/auth.ts is unchanged since you read it earlier in this task (offset=1, limit=2000). '
            + 'The content from the earlier read tool_result in this conversation is still current — refer to that instead of re-reading.',
        },
      ],
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'Let me try once more.',
        },
        {
          type: 'tool_use',
          id: 'tu_p2_2',
          name: 'read',
          input: { path: 'src/auth.ts', offset: 1, limit: 2000 },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_p2_2',
          content:
            '[Read Cache] src/auth.ts is unchanged since you read it earlier in this task (offset=1, limit=2000). '
            + 'The content from the earlier read tool_result in this conversation is still current — refer to that instead of re-reading.',
        },
      ],
    },
  ],
};

/**
 * P3 — narrate-without-progress floor (kimi-style).
 *
 * Model emits ample text describing what it "should" do, but keeps
 * issuing the same tool call without actually using the prior result.
 * No new tool, no new info, just textual stalling. This mirrors the
 * documented kimi narrate-without-tool structural floor.
 */
const P3_CASE: StallCase = {
  id: 'P3-narrate-without-progress',
  description:
    'Model produces lots of "let me check / analyze" text between identical tool calls but takes no actual new action.',
  expectedIsStuck: true,
  signalEnvelope:
    '[Stall detector signal]\n'
    + 'tool=grep input={"pattern":"useAuth","path":"src/"} '
    + 'occurrence_count=4 cache_hit_count=0 turns=[5,6,7,8]',
  recentMessages: [
    {
      role: 'user',
      content: 'Find where useAuth is used in src/ and summarize the usage patterns.',
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'I will grep for useAuth.',
        },
        {
          type: 'tool_use',
          id: 'tu_p3_1',
          name: 'grep',
          input: { pattern: 'useAuth', path: 'src/' },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_p3_1',
          content:
            'src/components/Header.tsx:3:import { useAuth } from "../hooks/useAuth";\nsrc/components/Header.tsx:12:  const { user, logout } = useAuth();\nsrc/pages/Profile.tsx:5:import { useAuth } from "../hooks/useAuth";\nsrc/pages/Profile.tsx:10:  const { user } = useAuth();',
        },
      ],
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'Let me re-check to ensure I capture every usage. I want to be thorough about this.',
        },
        {
          type: 'tool_use',
          id: 'tu_p3_2',
          name: 'grep',
          input: { pattern: 'useAuth', path: 'src/' },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_p3_2',
          content:
            'src/components/Header.tsx:3:import { useAuth } from "../hooks/useAuth";\nsrc/components/Header.tsx:12:  const { user, logout } = useAuth();\nsrc/pages/Profile.tsx:5:import { useAuth } from "../hooks/useAuth";\nsrc/pages/Profile.tsx:10:  const { user } = useAuth();',
        },
      ],
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'I should run the same grep again to verify the count is consistent — let me think carefully about the pattern.',
        },
        {
          type: 'tool_use',
          id: 'tu_p3_3',
          name: 'grep',
          input: { pattern: 'useAuth', path: 'src/' },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_p3_3',
          content:
            'src/components/Header.tsx:3:import { useAuth } from "../hooks/useAuth";\nsrc/components/Header.tsx:12:  const { user, logout } = useAuth();\nsrc/pages/Profile.tsx:5:import { useAuth } from "../hooks/useAuth";\nsrc/pages/Profile.tsx:10:  const { user } = useAuth();',
        },
      ],
    },
  ],
};

/**
 * N2 — verification grep across legitimate file edits.
 *
 * User asks to delete two slides from presentation.html. Model uses the
 * same count-grep to verify the slide count after each edit. Three
 * identical grep calls (same fingerprint) but separated by real edit
 * operations that change file state. Each repeat is a legitimate
 * post-edit verification step, not a re-count loop.
 */
const N2_CASE: StallCase = {
  id: 'N2-verify-grep-between-edits',
  description:
    'Three identical count-greps interleaved with edits that change the file. Each grep verifies the prior edit landed; not a stall.',
  expectedIsStuck: false,
  signalEnvelope:
    '[Stall detector signal]\n'
    + 'tool=grep input={"pattern":"<section class=\\"slide","path":"presentation.html","output_mode":"count"} '
    + 'occurrence_count=3 cache_hit_count=0 turns=[2,5,8]',
  recentMessages: [
    {
      role: 'user',
      content:
        'presentation.html currently has 22 slides. Please delete the two "transition" slides (slide-transition class). After each delete, verify the count went down.',
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'I will first capture the baseline count, then delete one transition slide and verify, then delete the second.',
        },
        {
          type: 'tool_use',
          id: 'tu_n2_1',
          name: 'grep',
          input: {
            pattern: '<section class="slide',
            path: 'presentation.html',
            output_mode: 'count',
          },
        },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu_n2_1', content: 'presentation.html:22' },
      ],
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'Baseline 22. Deleting the first transition slide.',
        },
        {
          type: 'tool_use',
          id: 'tu_n2_2',
          name: 'edit',
          input: {
            path: 'presentation.html',
            old_string: '<section class="slide-transition">\n<h2>Section break</h2>\n</section>\n',
            new_string: '',
          },
        },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu_n2_2', content: 'Edit applied: 1 replacement' },
      ],
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'Verifying the count dropped to 21.',
        },
        {
          type: 'tool_use',
          id: 'tu_n2_3',
          name: 'grep',
          input: {
            pattern: '<section class="slide',
            path: 'presentation.html',
            output_mode: 'count',
          },
        },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu_n2_3', content: 'presentation.html:21' },
      ],
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'Count dropped from 22 to 21 as expected. Now deleting the second transition slide.',
        },
        {
          type: 'tool_use',
          id: 'tu_n2_4',
          name: 'edit',
          input: {
            path: 'presentation.html',
            old_string: '<section class="slide-transition">\n<h2>Interlude</h2>\n</section>\n',
            new_string: '',
          },
        },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu_n2_4', content: 'Edit applied: 1 replacement' },
      ],
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'Final verification — count should be 20.',
        },
        {
          type: 'tool_use',
          id: 'tu_n2_5',
          name: 'grep',
          input: {
            pattern: '<section class="slide',
            path: 'presentation.html',
            output_mode: 'count',
          },
        },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu_n2_5', content: 'presentation.html:20' },
      ],
    },
  ],
};

/**
 * N3 — revisit after edit (legitimate cache invalidation).
 *
 * Model edits a file then reads the same path/offset/limit to verify the
 * edit. Edit invalidated the read cache (per FEATURE_177 design — edit/
 * write/multi_edit call `ctx.readFileStateCache.forget(filePath)`), so
 * the post-edit read returns fresh content (not a stub). Detector might
 * fire on the path-args match, but sidecar should recognize the edit
 * between the reads as legitimate progress.
 */
const N3_CASE: StallCase = {
  id: 'N3-revisit-after-edit',
  description:
    'Model reads a file, edits it, reads it again to verify. Same path/offset/limit; edit invalidated the cache. Legitimate verification flow.',
  expectedIsStuck: false,
  signalEnvelope:
    '[Stall detector signal]\n'
    + 'tool=read input={"path":"src/util.ts","offset":1,"limit":200} '
    + 'occurrence_count=2 cache_hit_count=0 turns=[3,6]',
  recentMessages: [
    {
      role: 'user',
      content: 'Rename the helper function `getCwd` to `getCurrentWorkingDirectory` in src/util.ts.',
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'I will read util.ts first to locate the function.',
        },
        {
          type: 'tool_use',
          id: 'tu_n3_1',
          name: 'read',
          input: { path: 'src/util.ts', offset: 1, limit: 200 },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_n3_1',
          content:
            "export function getCwd(): string {\n  return process.cwd();\n}\n\nexport function joinPath(...parts: string[]) {\n  return parts.join('/');\n}\n",
        },
      ],
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'Now renaming.',
        },
        {
          type: 'tool_use',
          id: 'tu_n3_2',
          name: 'edit',
          input: {
            path: 'src/util.ts',
            old_string: 'export function getCwd(): string {\n  return process.cwd();\n}',
            new_string: 'export function getCurrentWorkingDirectory(): string {\n  return process.cwd();\n}',
          },
        },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu_n3_2', content: 'Edit applied: 1 replacement in src/util.ts' },
      ],
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'Verifying the rename landed correctly.',
        },
        {
          type: 'tool_use',
          id: 'tu_n3_3',
          name: 'read',
          input: { path: 'src/util.ts', offset: 1, limit: 200 },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_n3_3',
          content:
            "export function getCurrentWorkingDirectory(): string {\n  return process.cwd();\n}\n\nexport function joinPath(...parts: string[]) {\n  return parts.join('/');\n}\n",
        },
      ],
    },
  ],
};

export const CASES: readonly StallCase[] = [P1_CASE, P2_CASE, P3_CASE, N1_CASE, N2_CASE, N3_CASE];

// ─── Mechanical classification ─────────────────────────────────────────

const KNOWN_TOOLS = new Set([
  'read',
  'edit',
  'write',
  'multi_edit',
  'grep',
  'glob',
  'bash',
  'task_stop',
  'emit_handoff',
]);

export interface JudgmentClassification {
  /** Did the model invoke `report_stall_judgment` exactly once? */
  readonly emittedReport: boolean;
  /** Was the isStuck field a real boolean? */
  readonly schemaValid: boolean;
  /** The model's verdict (only meaningful when schemaValid=true). */
  readonly isStuck: boolean | null;
  /** Did the suggestedTool reference a known tool? */
  readonly suggestedToolValid: boolean;
  /** Raw input echoed for the dump. */
  readonly rawInput: unknown;
}

export function classifyJudgment(
  toolCalls: ReadonlyArray<{ name: string; input: unknown }>,
): JudgmentClassification {
  const reports = toolCalls.filter((c) => c.name === 'report_stall_judgment');
  const emittedReport = reports.length === 1;
  if (!emittedReport) {
    return {
      emittedReport: false,
      schemaValid: false,
      isStuck: null,
      suggestedToolValid: false,
      rawInput: reports[0]?.input ?? null,
    };
  }
  const input = reports[0]!.input as Record<string, unknown> | null;
  const isStuckRaw = input?.isStuck;
  const schemaValid = typeof isStuckRaw === 'boolean';
  const isStuck = schemaValid ? (isStuckRaw as boolean) : null;
  const suggestedTool = typeof input?.suggestedTool === 'string' ? input.suggestedTool : '';
  // suggestedTool is required to be valid only when isStuck === true
  const suggestedToolValid = isStuck === true
    ? KNOWN_TOOLS.has(suggestedTool)
    : true;
  return {
    emittedReport,
    schemaValid,
    isStuck,
    suggestedToolValid,
    rawInput: input,
  };
}
