/**
 * FEATURE_196 (v0.7.43) — Sidecar Verifier content-aware fire gate.
 *
 * **Layer 2 scope** (per benchmark/EVAL_GUIDELINES.md §Layer 1 justification):
 *
 * The gate logic itself is **deterministic** — `composeGateDecision` is a
 * pure function over `(StopHookContext, env)`. Gate behavior is exhaustively
 * covered by `packages/coding/src/agent-runtime/middleware/sidecar-verifier/gate.test.ts`
 * (23 unit tests) and the runner-driven integration tests (3 tests).
 *
 * What Layer 1 unit tests cannot answer:
 *   - Do real Worker LLM outputs across 5 provider families produce
 *     `KodaXContentBlock[]` shapes my `lastAssistantHasToolUse` detector
 *     handles correctly? (Provider-adapter quirk question.)
 *   - Do real model families respond to canonical user-message inputs
 *     with the patterns my case categories assume? (Realism question
 *     about what Worker outputs the gate will actually see in
 *     production.)
 *
 * These are inherently empirical, multi-family questions. Layer 2 eval
 * answers them with a small panel of real LLM calls. The gate decision
 * for each cell is computed offline ($0) from the captured response —
 * Layer 2 only buys realistic tuples.
 *
 * **Case design** (4 categories × cases probe a specific gate guard):
 *
 *   C1_greeting        — short greeting (≤20 char + greeting prefix +
 *                        no imperative). Gate must SKIP. Tests Layer 2
 *                        conversational-intent detector against real
 *                        model reciprocation patterns.
 *   C2_imperative      — short imperative (≤20 char, imperative verb).
 *                        Gate must FIRE (Layer 2 imperative-verb guard).
 *                        Tests F184 zhipu intent-vs-action floor
 *                        coverage — Worker may text-only claim work
 *                        without invoking the tool.
 *   C3_long_message    — long user message (>20 char). Gate must FIRE
 *                        regardless of greeting/imperative shape (Layer 2
 *                        length cap blocks skip).
 *   C4_no_greeting     — short non-greeting (no greeting prefix).
 *                        Gate must FIRE (Layer 2 prefix guard).
 *
 * **Pre-registered SHIP gate**:
 *   (a) C1 gate.skip rate ≥ 95% per alias (greeting → conversational skip
 *       works on real model outputs)
 *   (b) C2 gate.fire rate ≥ 95% per alias (imperative blocks skip — F184
 *       contract preserved on real intent-vs-action floor)
 *   (c) C3 gate.fire rate = 100% per alias (length cap is purely
 *       deterministic; allowed only as sanity check)
 *   (d) C4 gate.fire rate = 100% per alias (prefix guard is purely
 *       deterministic; allowed only as sanity check)
 *   (e) 5/5 alias meet (a)+(b) → SHIP
 *       4/5 → evidence-driven override per
 *             [[feedback_pre_registered_gate_saturation]]
 *       ≤3/5 → DEFER, regex review needed
 *
 * Refs:
 *   - benchmark/EVAL_GUIDELINES.md §Layer 1 / §Layer 2
 *   - docs/features/v0.7.43.md#feature_196
 *   - memory: feedback_canonical_eval_alias_panel
 */

import type { KodaXToolDefinition } from '@kodax-ai/llm';

/**
 * Minimal Worker-shape system prompt — enough realism for the model
 * to produce greetings + imperative responses + tool calls when
 * appropriate, without dragging in the full Worker capability sections
 * (which would bloat token cost on a Layer 2 measurement run).
 *
 * Production Worker system prompt is much larger; that's fine for
 * F196's Layer 2 scope because we're testing the gate's regex
 * coverage of OUTPUT shapes, not the Worker's internal reasoning
 * fidelity to production prompts.
 */
export const WORKER_SYSTEM_PROMPT = `You are KodaX, a Chinese-and-English-speaking coding assistant. You have access to file-modification tools (write, edit, multi_edit), search tools (grep, glob, read), and a todo_create tool. When the user asks a conversational question or greets you, respond conversationally without invoking tools. When the user asks you to do work that requires tools (search, edit files, run something, plan), invoke the appropriate tool. Be concise.`;

/**
 * Worker-grade tool subset — advertised to the model so it CAN call
 * tools on imperative cases. The set covers mutation (write/edit),
 * search (grep), and planning (todo_create) — the 4 most common
 * Worker tools that exercise different gate paths.
 */
export const WORKER_TOOLS: readonly KodaXToolDefinition[] = [
  {
    name: 'write',
    description: 'Write content to a file path (creates or overwrites).',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path.' },
        content: { type: 'string', description: 'File content.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit',
    description: 'Edit a file by replacing exact string content.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'grep',
    description: 'Search for a regex pattern across files.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'todo_create',
    description: 'Create a list of plan items for the current task.',
    input_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              subject: { type: 'string' },
              description: { type: 'string' },
            },
          },
        },
      },
      required: ['items'],
    },
  },
];

export type CaseCategory =
  | 'C1_greeting'
  | 'C2_imperative'
  | 'C3_long_message'
  | 'C4_no_greeting';

export interface ContentGateCase {
  readonly id: string;
  readonly category: CaseCategory;
  /** The user message presented to the Worker. */
  readonly userMessage: string;
  /** Pre-registered gate decision the F196 gate MUST produce. */
  readonly expectedDecision: 'skip' | 'fire';
  /** Human-readable explanation of why this case probes the named gate guard. */
  readonly rationale: string;
}

/**
 * 12 cases (3 per category) — enough variation to surface family-
 * specific tuple-shape quirks without ballooning the panel.
 */
export const CASES: readonly ContentGateCase[] = [
  // ── C1 — short greeting → expect SKIP ──────────────────────────────
  {
    id: 'C1a_chinese_short',
    category: 'C1_greeting',
    userMessage: '你好',
    expectedDecision: 'skip',
    rationale: 'Layer 2 — Chinese greeting prefix match + length 2 + no imperative',
  },
  {
    id: 'C1b_english_short',
    category: 'C1_greeting',
    userMessage: 'hi',
    expectedDecision: 'skip',
    rationale: 'Layer 2 — English greeting prefix + length 2 + no imperative',
  },
  {
    id: 'C1c_thanks',
    category: 'C1_greeting',
    userMessage: '谢谢',
    expectedDecision: 'skip',
    rationale: 'Layer 2 — Chinese thanks prefix + length 2 + no imperative',
  },

  // ── C2 — short imperative → expect FIRE (zhipu floor coverage) ─────
  // These probe whether the model produces a text-only false-claim
  // (intent-vs-action floor) OR actually calls a tool. EITHER outcome
  // must trigger gate.fire (Layer 1 if tool, Layer 2 default fire if
  // no greeting prefix OR imperative verb match in user message).
  {
    id: 'C2a_chinese_search',
    category: 'C2_imperative',
    userMessage: '查一下 README',
    expectedDecision: 'fire',
    rationale: 'Layer 2 — Chinese imperative verb (查) blocks skip; gate must fire to catch potential floor',
  },
  {
    id: 'C2b_english_fix',
    category: 'C2_imperative',
    userMessage: 'fix the bug',
    expectedDecision: 'fire',
    rationale: 'Layer 2 — English imperative verb (fix) blocks skip',
  },
  {
    id: 'C2c_chinese_create',
    category: 'C2_imperative',
    userMessage: '写一个函数',
    expectedDecision: 'fire',
    rationale: 'Layer 2 — Chinese imperative verb (写) blocks skip',
  },

  // ── C3 — long message → expect FIRE (length cap guard) ─────────────
  {
    id: 'C3a_long_chinese_chat',
    category: 'C3_long_message',
    userMessage: '你好啊，我今天想问一下今天的天气怎么样还有 KodaX 的能力',
    expectedDecision: 'fire',
    rationale: 'Layer 2 — length >20 char blocks skip even with greeting prefix',
  },
  {
    id: 'C3b_long_english_chat',
    category: 'C3_long_message',
    userMessage:
      'hello there, how is the weather and can you tell me about the project structure please',
    expectedDecision: 'fire',
    rationale: 'Layer 2 — English message >20 char blocks skip',
  },
  {
    id: 'C3c_long_mixed',
    category: 'C3_long_message',
    userMessage:
      '嗨 KodaX，我想知道你能帮我做什么类型的代码任务，比如重构、找bug、写测试',
    expectedDecision: 'fire',
    rationale: 'Layer 2 — mixed CJK + length >20 char blocks skip',
  },

  // ── C4 — short non-greeting → expect FIRE (prefix guard) ───────────
  {
    id: 'C4a_pure_question',
    category: 'C4_no_greeting',
    userMessage: 'what is 2+2',
    expectedDecision: 'fire',
    rationale: 'Layer 2 — no greeting prefix blocks skip (starts with "what")',
  },
  {
    id: 'C4b_chinese_question',
    category: 'C4_no_greeting',
    userMessage: '解释下闭包',
    expectedDecision: 'fire',
    rationale: 'Layer 2 — no greeting prefix blocks skip (starts with imperative "解释")',
  },
  {
    id: 'C4c_random_text',
    category: 'C4_no_greeting',
    userMessage: 'KodaX 是什么',
    expectedDecision: 'fire',
    rationale: 'Layer 2 — starts with a name (not greeting) → no prefix match',
  },
];
