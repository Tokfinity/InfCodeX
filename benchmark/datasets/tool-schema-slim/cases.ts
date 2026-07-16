/**
 * Dataset — Tool-schema slim variants for `ask_user_question` + `todo_create`.
 *
 * v0.7.41 system-prompt audit (2026-05-17) showed Scout's tool schema JSON
 * jumped 19,818 → 38,149 bytes (+92.5%) between v0.7.39 and HEAD, driven
 * by FEATURE_168 exclude-based wiring (+17 silently-dropped tools) plus
 * FEATURE_170 C3 `todo_create` (+2,384 B). Two outliers dominate the
 * delta: `ask_user_question` (2,760 B / ~690 tok) and `todo_create`
 * (2,384 B / ~596 tok). Together they are ~1,286 tokens — 28% of the
 * +4,583-token regression.
 *
 * This eval asks: can we cut both schemas roughly in half WITHOUT
 * degrading the model's ability to:
 *
 *   (positive) Call the right tool when the user query warrants it
 *   (negative) Not over-trigger on cases that don't warrant calling
 *   (boundary) Use the right shape (`questions[]` array for multiple
 *              independent questions; `kind:'input'` for free-text;
 *              `activeForm` field always supplied on `todo_create`;
 *              not for initial plan seed)
 *
 * ## Three variants
 *
 *   v1_orig       — production schemas as of 2026-05-17 (control)
 *   v2_slim       — descriptions compressed, redundant properties slim'd.
 *                   Same input_schema shape; backward-compatible.
 *   v3_aggressive — additionally cuts the `question`+`options` flat path
 *                   from ask_user_question (forces `questions[]` array).
 *                   BREAKING for any caller using the legacy single-question
 *                   shape — measured for ceiling-data only, not for ship.
 *
 * ## Pre-registered SHIP gate (per EVAL_GUIDELINES anti-pattern 6)
 *
 * Slim variant SHIPs iff ALL conditions met:
 *
 *   (a) positive-case correct-call rate: v_slim ≥ v_orig − 10pp
 *       on every (alias × case)
 *   (b) negative-case over-trigger rate: v_slim ≤ v_orig + 10pp
 *       on every (alias × case)
 *   (c) boundary-shape correctness: v_slim ≥ v_orig − 15pp
 *       (looser because boundary behaviour is more delicate)
 *   (d) panel-internal 3-judge LLM-judge audit disagreement ≤ 10%
 *       (per EVAL_GUIDELINES Judge model selection §)
 *
 * Failing ANY condition → DEFER (keep v_orig).
 *
 * v3_aggressive treats (a)-(c) as "ceiling info" only; the breaking
 * change to `question` shorthand path means we don't ship even on PASS.
 *
 * ## Cases (11 total)
 *
 *   ask_user_question (6):
 *     AUQ_1 positive-single  user asks ambiguous deploy region → call AUQ with select+options
 *     AUQ_2 positive-multi   user wants new project scaffold (multiple unknowns) → call AUQ with questions[] (≥2 items)
 *     AUQ_3 positive-input   user task needs free-text answer → call AUQ with kind:'input'
 *     AUQ_4 negative-trivial trivial task with clear next step → NOT call AUQ
 *     AUQ_5 negative-explicit user explicitly says "just pick a default, don't ask" → NOT call
 *     AUQ_6 boundary-no-cram two independent questions → use questions[] not concatenated string
 *
 *   todo_create (5):
 *     TC_1  positive-mid-task   existing 3-item plan, user adds 1 more → call todo_create
 *     TC_2  positive-activeForm same as TC_1 → activeForm field non-empty
 *     TC_3  negative-initial    fresh task, no plan → use todo_update({op:"init"}) NOT per-item todo_create
 *     TC_4  negative-trivial    1-line bug fix → NOT create any todo
 *     TC_5  boundary-no-id      positive call → no `id` field in input (schema forbids)
 *
 * Note: TC_2 and TC_5 share the TC_1 trigger but apply different judges
 * to the same model output — counted as 5 distinct judge axes, not 5
 * distinct LLM calls. Saves cost vs 5 separate scenarios.
 *
 * ## Sample plan
 *
 *   3 variants × 4 alias × 6 unique LLM-call scenarios × 5 runs = 360 calls
 *   (AUQ_1/2/3/4/5/6 = 6 scenarios; TC_1+TC_2+TC_5 collapse to 1; TC_3/4 = 2;
 *    → 6 AUQ + 3 TC = 9 scenarios. 3 × 4 × 9 × 5 = 540 calls.)
 *
 *   Estimated cost: $0.02-0.04/call average → ~$11-$22.
 *
 * ## Raw dump
 *
 *   `os.tmpdir() / kodax-eval-dumps / tool-schema-slim / <case>.json`
 *
 * ## Eval drivers
 *
 *   tests/tool-schema-slim.eval.ts                  — main panel run
 *   tests/tool-schema-slim-judge-audit.eval.ts      — panel-internal majority audit
 */

import type { KodaXToolDefinition } from '@kodax-ai/llm';

import type { PromptVariant } from '../../harness/harness.js';
import type { PromptJudge } from '../../harness/judges.js';

// ===========================================================================
// Schema variants — orig / slim / aggressive
// ===========================================================================

const ASK_USER_QUESTION_V1_ORIG: KodaXToolDefinition = {
  name: 'ask_user_question',
  description:
    'Ask the user a question. Supports single-select (default), multi-select, or free-text input. When you have multiple independent questions, use the "questions" array — each question is presented separately with its own options. Do NOT combine multiple questions into a single question string.',
  input_schema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to ask the user. Use this for a single question. For multiple independent questions, use the "questions" array instead.' },
      questions: {
        type: 'array',
        description: 'Multiple independent questions (1-4). Each question is presented separately with its own options. Use this instead of combining multiple questions into a single "question" string. Takes precedence over "question"+"options" when provided.',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The question text' },
            header: { type: 'string', description: 'Short label (max 12 chars) shown in progress indicator, e.g. "环境" or "Deploy"' },
            options: {
              type: 'array',
              description: 'Available options for this question.',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: 'Display label for this option' },
                  description: { type: 'string', description: 'Optional description of this option' },
                  value: { type: 'string', description: 'Optional value to return (defaults to label)' },
                },
                required: ['label'],
              },
            },
            multi_select: {
              type: 'boolean',
              description: 'Allow multiple selections for this question.',
            },
          },
          required: ['question', 'options'],
        },
        minItems: 1,
        maxItems: 4,
      },
      kind: {
        type: 'string',
        enum: ['select', 'input'],
        description: 'Interaction kind. "select" (default) shows options for the user to pick from. "input" shows a free-text prompt for the user to type anything. Use "input" when the user needs to provide an open-ended answer (e.g. step combinations like "1,3,5", version numbers, custom text).',
      },
      options: {
        type: 'array',
        description: 'Available options for the user to choose from. Required for kind="select", ignored for kind="input".',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Display label for this option' },
            description: { type: 'string', description: 'Optional description of this option' },
            value: { type: 'string', description: 'Optional value to return (defaults to label)' },
          },
          required: ['label'],
        },
      },
      multi_select: {
        type: 'boolean',
        description: 'Allow the user to select multiple options (space to toggle, enter to confirm). Only applies to kind="select". Returns comma-separated values.',
      },
      default: { type: 'string', description: 'Optional default choice (for select) or default text (for input)' },
    },
    required: ['question'],
  },
} as const;

const ASK_USER_QUESTION_V2_SLIM: KodaXToolDefinition = {
  name: 'ask_user_question',
  description:
    'Ask the user. For multiple independent questions, use `questions` array (1-4 items) — do NOT concatenate into one string. For free-text answers, set `kind:"input"`; default `"select"` shows options.',
  input_schema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'Single question shorthand. For multiple questions, use `questions[]` instead.' },
      questions: {
        type: 'array',
        description: 'Multiple independent questions, each rendered separately. Takes precedence over `question`+`options`.',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string' },
            header: { type: 'string', description: 'Short label, max 12 chars.' },
            options: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  description: { type: 'string' },
                  value: { type: 'string' },
                },
                required: ['label'],
              },
            },
            multi_select: { type: 'boolean' },
          },
          required: ['question', 'options'],
        },
        minItems: 1,
        maxItems: 4,
      },
      kind: {
        type: 'string',
        enum: ['select', 'input'],
        description: '"select" (default) = pick from options. "input" = free-text (version numbers, custom strings, etc).',
      },
      options: {
        type: 'array',
        description: 'For kind="select" only.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            description: { type: 'string' },
            value: { type: 'string' },
          },
          required: ['label'],
        },
      },
      multi_select: { type: 'boolean', description: 'Allow multi-select; only for kind="select".' },
      default: { type: 'string', description: 'Default choice/text.' },
    },
    required: ['question'],
  },
} as const;

const ASK_USER_QUESTION_V3_AGGRESSIVE: KodaXToolDefinition = {
  name: 'ask_user_question',
  description:
    'Ask the user 1-4 independent questions. Each question gets its own options or free-text input. Returns the user\'s choice(s).',
  input_schema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        description: 'Questions to ask (1-4). Each is rendered separately.',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string' },
            header: { type: 'string', description: 'Short label, ≤12 chars.' },
            kind: { type: 'string', enum: ['select', 'input'], description: 'select (default) or input (free-text).' },
            options: {
              type: 'array',
              description: 'For kind=select.',
              items: {
                type: 'object',
                properties: { label: { type: 'string' }, description: { type: 'string' }, value: { type: 'string' } },
                required: ['label'],
              },
            },
            multi_select: { type: 'boolean' },
            default: { type: 'string' },
          },
          required: ['question'],
        },
        minItems: 1,
        maxItems: 4,
      },
    },
    required: ['questions'],
  },
} as const;

const TODO_CREATE_V1_ORIG: KodaXToolDefinition = {
  name: 'todo_create',
  description:
    'FEATURE_170 (v0.7.41) — insert ONE new pending item into the visible plan list. ' +
    'Use this MID-TASK when you realize the plan needs an additional step but the existing items must be preserved. ' +
    'Do NOT use this for the initial plan commitment — `todo_update({op:"init", items:[...]})` is the batch-seed path for fan-out plan-first or task entry. ' +
    'Rules: ' +
    '(1) The store auto-generates the id (monotonic `todo_N`). Do NOT pass an id — any caller-supplied id is rejected at the schema layer. ' +
    '(2) `content` is required (imperative description, e.g. "Add edge-case test for null input"). ' +
    '(3) Supply `activeForm` (present-continuous form, e.g. "Adding edge-case test for null input") so the spinner can show the user what you are working on when this item is later flipped to `in_progress` via todo_update. ' +
    '(4) Optional `evaluator: "build" | "test" | "lint"` hint runs the corresponding deterministic check when the item flips to "completed" (FEATURE_114) — use sparingly, only on milestone steps with a real ground-truth check. ' +
    '(5) Optional `metadata` opaque object is carried alongside the item for extension hooks / observability — the UI does NOT render it. ' +
    'Returns {ok: true, id: "todo_<n>"} on success. ' +
    'Returns {ok: false, reason: "..."} when the store is not wired, validation fails, or an extension hook blocks the create.',
  input_schema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: 'Imperative description of what needs to be done (e.g. "Run failing tests").',
      },
      activeForm: {
        type: 'string',
        description:
          'Optional present-continuous form (e.g. "Running failing tests"). Shown by the spinner when this item later flips to `in_progress`.',
      },
      evaluator: {
        type: 'string',
        enum: ['build', 'test', 'lint'],
        description:
          'Optional (FEATURE_114) per-step deterministic evaluator. When set and the item later flips to "completed" via todo_update, the runner runs `npm run build` / `npm test` / `npm run lint` accordingly; failure surfaces stderr in your next tool result. Use sparingly — only on milestone steps with a real ground-truth check.',
      },
      metadata: {
        type: 'object',
        description:
          'Optional opaque key-value bag carried alongside the item. Used by extension hooks / eval harnesses. The UI does NOT render metadata. Omit if you have nothing structured to attach.',
      },
    },
    required: ['content'],
  },
} as const;

const TODO_CREATE_V2_SLIM: KodaXToolDefinition = {
  name: 'todo_create',
  description:
    'Insert ONE new pending plan item mid-task. For the initial plan seed use `todo_update({op:"init", items:[...]})` instead. Always supply both `content` (imperative) and `activeForm` (present-continuous, shown in spinner). Do NOT pass `id` — auto-generated.',
  input_schema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: 'Imperative description, e.g. "Run failing tests".',
      },
      activeForm: {
        type: 'string',
        description: 'Present-continuous form, e.g. "Running failing tests". Shown in spinner.',
      },
      evaluator: {
        type: 'string',
        enum: ['build', 'test', 'lint'],
        description: 'Optional deterministic check on completion. Use sparingly.',
      },
      metadata: {
        type: 'object',
        description: 'Optional opaque bag for extensions.',
      },
    },
    required: ['content'],
  },
} as const;

const TODO_CREATE_V3_AGGRESSIVE: KodaXToolDefinition = {
  name: 'todo_create',
  description:
    'Add ONE new plan item mid-task. (Initial seed: use todo_update op:init.) Provide content + activeForm. No id field.',
  input_schema: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'Imperative description.' },
      activeForm: { type: 'string', description: 'Present-continuous, shown in spinner.' },
      evaluator: { type: 'string', enum: ['build', 'test', 'lint'] },
      metadata: { type: 'object' },
    },
    required: ['content'],
  },
} as const;

// ===========================================================================
// System prompt — fixed across variants. Mirrors the production Worker prompt
// surface where these two tools land (Scout / Generator / Worker all see them).
// ===========================================================================

const SYSTEM_PROMPT = [
  'You are KodaX, an AI coding assistant. Use the provided tools when appropriate to help the user.',
  '',
  'TOOL USAGE GUIDANCE:',
  '- For trivial requests with a clear next step (delete a file, fix a typo, run a single command), execute directly without asking.',
  '- For ambiguous requests where you genuinely need clarification, use `ask_user_question`. Prefer asking ONE question with multiple options over asking multiple times.',
  '- For complex multi-step tasks, commit a plan with `todo_update({op:"init", items:[...]})` BEFORE starting work, then use `todo_create` to add steps mid-task as you discover them.',
  '- Never ask the user a question that you can answer yourself by reading files or running a command.',
  '',
  'When you need to call a tool, call it directly — do not narrate "I will call X" without actually calling it.',
].join('\n');

// ===========================================================================
// Variant axis: schema-slim. Each variant id encodes (auq_variant, tc_variant).
// We test 3 paired variants: v1/v1, v2/v2, v3/v3. Mixing variants across
// the two tools would multiply the matrix without adding signal.
// ===========================================================================

export type SchemaVariantId = 'v1_orig' | 'v2_slim' | 'v3_aggressive';

function getAuqDef(v: SchemaVariantId): KodaXToolDefinition {
  switch (v) {
    case 'v1_orig': return ASK_USER_QUESTION_V1_ORIG;
    case 'v2_slim': return ASK_USER_QUESTION_V2_SLIM;
    case 'v3_aggressive': return ASK_USER_QUESTION_V3_AGGRESSIVE;
  }
}

function getTcDef(v: SchemaVariantId): KodaXToolDefinition {
  switch (v) {
    case 'v1_orig': return TODO_CREATE_V1_ORIG;
    case 'v2_slim': return TODO_CREATE_V2_SLIM;
    case 'v3_aggressive': return TODO_CREATE_V3_AGGRESSIVE;
  }
}

// Minimal sibling tools to make the schema realistic — the model must
// choose AMONG these tools, not in isolation. Mirrors the smallest
// realistic subset Scout/Worker actually sees.
const SIBLING_TOOLS: readonly KodaXToolDefinition[] = [
  {
    name: 'read',
    description: 'Read the contents of a file.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'bash',
    description: 'Execute a bash command.',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
  {
    name: 'edit',
    description: 'Edit a file by replacing old_string with new_string.',
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
    name: 'todo_update',
    description:
      'Update the plan list. `op:"init"` replaces the whole list with `items:[{content,activeForm}, ...]` (use for initial plan commitment). `op:"update"` flips a single item state via `{id, status}`. `op:"complete"` marks `{id}` completed.',
    input_schema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['init', 'update', 'complete'] },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              activeForm: { type: 'string' },
            },
            required: ['content'],
          },
        },
        id: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
      },
      required: ['op'],
    },
  },
];

export function buildToolsForVariant(v: SchemaVariantId): readonly KodaXToolDefinition[] {
  return [...SIBLING_TOOLS, getAuqDef(v), getTcDef(v)];
}

// ===========================================================================
// Cases
// ===========================================================================

export type CaseId =
  | 'AUQ_1_positive_single'
  | 'AUQ_2_positive_multi'
  | 'AUQ_3_positive_input'
  | 'AUQ_4_negative_trivial'
  | 'AUQ_5_negative_explicit'
  | 'AUQ_6_boundary_no_cram'
  | 'TC_1_positive_mid_task'       // judges: must_call_todo_create, has_activeForm, no_id_field
  | 'TC_3_negative_initial'
  | 'TC_4_negative_trivial';

export interface CaseSpec {
  readonly id: CaseId;
  readonly polarity: 'positive' | 'negative' | 'boundary';
  readonly priorMessages: readonly { role: 'user' | 'assistant'; content: string }[];
  readonly userMessage: string;
  readonly description: string;
}

export const CASES: readonly CaseSpec[] = [
  {
    id: 'AUQ_1_positive_single',
    polarity: 'positive',
    // **Pilot 2026-05-17 v2**: even with explicit "问我一下" wording on a
    // bare turn, ds/v4flash 0/3 — model prefers ls/cat first. The decision
    // axis is dominated by system-prompt "Never ask if you can answer by
    // reading files". To test schema-slim impact we need to force the
    // decision via priorMessages (filesystem already explored), so the
    // next step is the tool call. Tests SHAPE/AFFORDANCE, not decision.
    priorMessages: [
      { role: 'user', content: '看下当前项目然后部署到 Vercel。' },
      {
        role: 'assistant',
        content:
          '看了项目结构：Next.js 14 + TypeScript + npm，build OK。' +
          '现在准备 deploy 到 Vercel — 但 deploy region 取决于你的用户分布，没法从代码判断。',
      },
    ],
    userMessage:
      '用 ask_user_question 直接问我 region 选哪个 — 给我列几个常见选项（hkg / sin / sfo / fra），让我选。',
    description: 'forced call after filesystem-already-explored framing; should invoke ask_user_question (kind=select) with region options',
  },
  {
    id: 'AUQ_2_positive_multi',
    polarity: 'positive',
    priorMessages: [
      { role: 'user', content: '帮我起一个新 web 项目。' },
      {
        role: 'assistant',
        content:
          '我可以建项目骨架，但有几个设置选择我没法替你决定 — framework、包管理器、TypeScript strict 模式都是个人偏好。',
      },
    ],
    userMessage:
      '用 ask_user_question 一次性问我这三件事：(1) framework: vite 还是 next；(2) 包管理器: npm/pnpm/bun；(3) TypeScript strict 还是 loose。每个给选项让我选。',
    description: 'forced multi-Q call; should invoke AUQ with questions[] array (≥2 items)',
  },
  {
    id: 'AUQ_3_positive_input',
    polarity: 'positive',
    priorMessages: [
      { role: 'user', content: '帮我初始化一个新仓库。' },
      {
        role: 'assistant',
        content:
          '好的，我可以执行 git init + npm init。但需要先确认项目名 — 这不是从文件能读出来的。',
      },
    ],
    userMessage:
      '用 ask_user_question 问我项目名是什么 — 我要自己输入文字，不要给候选项，open-ended input。',
    description: 'forced free-text call; should invoke AUQ with kind:"input"',
  },
  {
    id: 'AUQ_4_negative_trivial',
    polarity: 'negative',
    priorMessages: [],
    userMessage:
      '把 src/foo.txt 删掉。',
    description: 'trivial single-file delete; should NOT call ask_user_question',
  },
  {
    id: 'AUQ_5_negative_explicit',
    polarity: 'negative',
    priorMessages: [],
    userMessage:
      '随便给我配一套合理的 ESLint 默认规则就好，别问我细节，自己定。',
    description: 'user explicitly opts out of being asked; should NOT call ask_user_question',
  },
  {
    id: 'AUQ_6_boundary_no_cram',
    polarity: 'boundary',
    priorMessages: [],
    userMessage:
      '帮我决定新 React 项目的两个设置：用 vite 还是 next、包管理器用 npm/pnpm/bun。问我一下吧，给选项。',
    description: 'two clearly independent questions; should use questions[] array, NOT cram into single string',
  },
  {
    id: 'TC_1_positive_mid_task',
    polarity: 'positive',
    priorMessages: [
      {
        role: 'user',
        content: '重构 packages/coding/src/tools/registry.ts，把 tool definitions 拆分到独立文件。',
      },
      {
        role: 'assistant',
        content:
          '好的，我先创建初始 plan：\n' +
          '<tool_call>todo_update({op:"init", items:[' +
          '{content:"Read registry.ts to understand current structure", activeForm:"Reading registry.ts"},' +
          '{content:"Design the new file layout (one tool per file)", activeForm:"Designing file layout"},' +
          '{content:"Move tool definitions to individual files", activeForm:"Moving tool definitions"}' +
          ']})</tool_call>\n' +
          '现在开始第一步。',
      },
    ],
    userMessage:
      '差点忘了 — 还要补一个 step，每个新文件都加 unit test。这个加到 plan 里。',
    description: 'mid-task plan addition; should call todo_create (NOT todo_update init) with content+activeForm, no id',
  },
  {
    id: 'TC_3_negative_initial',
    polarity: 'negative',
    priorMessages: [],
    userMessage:
      '帮我搞定这个：(1) 找到 packages/coding/src/types.ts 里所有 export 的 type、(2) 列一个表格、(3) 写到 docs/types-overview.md。',
    description: 'fresh task with 3 explicit steps; should commit via todo_update({op:"init"}), NOT 3 separate todo_create',
  },
  {
    id: 'TC_4_negative_trivial',
    polarity: 'negative',
    priorMessages: [],
    userMessage:
      '把 packages/coding/src/types.ts line 42 的 typo "recieve" 改成 "receive"。',
    description: 'one-line typo fix; should NOT create any todo',
  },
] as const;

// ===========================================================================
// Judges — multi-syntax tool-name detection (anti-pattern 7 §4)
// ===========================================================================

function buildToolNamePatterns(toolName: string): readonly RegExp[] {
  const esc = toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    new RegExp(`\\b${esc}\\s*\\(`, 'i'),                              // tool_name(
    new RegExp(`["'\`]name["'\`]\\s*:\\s*["'\`]${esc}["'\`]`, 'i'),    // "name":"tool_name"
    new RegExp(`<${esc}\\b`, 'i'),                                    // <tool_name>
    new RegExp(`\\bname\\s*[:=]\\s*${esc}\\b`, 'i'),                  // name: tool_name / name=tool_name
    // FEATURE_125 S7 + FEATURE_170 Layer 2 extensions (regex audit experience)
    new RegExp(`${esc}\\s*:\\s*\\d+\\s*>\\s*\\{`, 'i'),                // kimi style: tool_name:0>{...}
    new RegExp(`<tool_name>${esc}</tool_name>`, 'i'),                  // zhipu wrapper style
  ];
}

interface ToolCallBinding {
  readonly name: string;
  readonly input: unknown;
}

/**
 * Check whether the harness captured a structured tool_call with the
 * given name, OR the raw text mentions the tool via one of the 6
 * known emission syntaxes. Pass either path = present.
 */
function hasToolCall(
  toolName: string,
  text: string,
  toolCalls: readonly ToolCallBinding[],
): boolean {
  if (toolCalls.some((tc) => tc.name === toolName)) return true;
  return buildToolNamePatterns(toolName).some((p) => p.test(text));
}

function buildMustCallJudge(toolName: string): PromptJudge {
  return {
    name: `must_call_${toolName}`,
    category: 'correctness',
    judge: (out, ctx) => {
      const toolCalls = (ctx?.toolCalls ?? []) as readonly ToolCallBinding[];
      const matched = hasToolCall(toolName, out, toolCalls);
      return matched
        ? { passed: true }
        : { passed: false, reason: `model did not invoke ${toolName} (checked binding + 6 text syntaxes)` };
    },
  };
}

function buildMustNotCallJudge(toolName: string): PromptJudge {
  return {
    name: `must_not_call_${toolName}`,
    category: 'correctness',
    judge: (out, ctx) => {
      const toolCalls = (ctx?.toolCalls ?? []) as readonly ToolCallBinding[];
      const matched = hasToolCall(toolName, out, toolCalls);
      return matched
        ? { passed: false, reason: `model over-triggered ${toolName} on a negative case` }
        : { passed: true };
    },
  };
}

/**
 * AUQ_2 / AUQ_6 boundary: model must use the `questions` array shape, not
 * cram into a single `question` string. Detected via:
 *   1. Captured tool_call input has `.questions: Array.length >= 2`, OR
 *   2. Raw text shows `"questions"` JSON key followed by `[`
 */
function buildUsesQuestionsArrayJudge(): PromptJudge {
  return {
    name: 'uses_questions_array_for_multi',
    category: 'correctness',
    judge: (out, ctx) => {
      const toolCalls = (ctx?.toolCalls ?? []) as readonly ToolCallBinding[];
      for (const tc of toolCalls) {
        if (tc.name !== 'ask_user_question') continue;
        const input = tc.input as { questions?: unknown };
        if (Array.isArray(input.questions) && input.questions.length >= 2) {
          return { passed: true };
        }
      }
      // Fallback to text scan
      const textHas = /["'`]questions["'`]\s*:\s*\[/.test(out)
        && /["'`]question["'`]\s*:/.test(out);
      return textHas
        ? { passed: true }
        : { passed: false, reason: 'model crammed multiple questions into a single string instead of using `questions[]`' };
    },
  };
}

/**
 * AUQ_3 boundary: model must set kind:"input" for free-text answers
 * (project name, version, custom string). Detected via captured
 * input.kind === 'input' OR text contains `"kind":"input"`.
 */
function buildKindInputJudge(): PromptJudge {
  return {
    name: 'uses_kind_input_for_freetext',
    category: 'correctness',
    judge: (out, ctx) => {
      const toolCalls = (ctx?.toolCalls ?? []) as readonly ToolCallBinding[];
      for (const tc of toolCalls) {
        if (tc.name !== 'ask_user_question') continue;
        const input = tc.input as { kind?: unknown };
        if (input.kind === 'input') return { passed: true };
        // questions[] form with kind:'input' on items
        const questions = (tc.input as { questions?: unknown }).questions;
        if (Array.isArray(questions) && questions.some((q: unknown) => (q as { kind?: string }).kind === 'input')) {
          return { passed: true };
        }
      }
      const textHas = /["'`]kind["'`]\s*:\s*["'`]input["'`]/.test(out);
      return textHas
        ? { passed: true }
        : { passed: false, reason: 'model did not set kind:"input" for free-text answer' };
    },
  };
}

/**
 * TC_1 sub-judge: positive todo_create call must carry non-empty
 * activeForm.
 */
function buildHasActiveFormJudge(): PromptJudge {
  return {
    name: 'todo_create_has_activeForm',
    category: 'correctness',
    judge: (out, ctx) => {
      const toolCalls = (ctx?.toolCalls ?? []) as readonly ToolCallBinding[];
      for (const tc of toolCalls) {
        if (tc.name !== 'todo_create') continue;
        const input = tc.input as { activeForm?: unknown };
        if (typeof input.activeForm === 'string' && input.activeForm.trim().length > 0) {
          return { passed: true };
        }
      }
      const textHas = /["'`]activeForm["'`]\s*:\s*["'`][^"'`]+["'`]/.test(out);
      return textHas
        ? { passed: true }
        : { passed: false, reason: 'todo_create call missing non-empty activeForm field' };
    },
  };
}

/**
 * TC_1 sub-judge: model must NOT supply an `id` field (schema rejects).
 * Counts as PASS when no todo_create call OR todo_create called without id.
 */
function buildNoIdFieldJudge(): PromptJudge {
  return {
    name: 'todo_create_no_id_field',
    category: 'correctness',
    judge: (out, ctx) => {
      const toolCalls = (ctx?.toolCalls ?? []) as readonly ToolCallBinding[];
      for (const tc of toolCalls) {
        if (tc.name !== 'todo_create') continue;
        const input = tc.input as { id?: unknown };
        if (input.id !== undefined) {
          return { passed: false, reason: 'todo_create called with id field (schema forbids; auto-generated)' };
        }
      }
      // Text scan: if model textually emitted id in todo_create payload, flag.
      const textHas = /todo_create\s*\([^)]*["'`]id["'`]\s*:/.test(out);
      return textHas
        ? { passed: false, reason: 'todo_create call text contained id field' }
        : { passed: true };
    },
  };
}

/**
 * TC_3 negative-initial: prefer todo_update({op:"init"}) over per-item
 * todo_create. PASS = todo_update present AND (no todo_create OR ≤1).
 */
function buildPrefersTodoUpdateInitJudge(): PromptJudge {
  return {
    name: 'prefers_todo_update_init_for_initial_plan',
    category: 'correctness',
    judge: (out, ctx) => {
      const toolCalls = (ctx?.toolCalls ?? []) as readonly ToolCallBinding[];
      const todoUpdateCount = toolCalls.filter((tc) => tc.name === 'todo_update').length;
      const todoCreateCount = toolCalls.filter((tc) => tc.name === 'todo_create').length;
      const hasInitOp = toolCalls.some(
        (tc) => tc.name === 'todo_update' && (tc.input as { op?: unknown }).op === 'init',
      );
      // Also accept text-form
      const textHasInit = /todo_update\s*\([^)]*op\s*[:=]\s*["'`]init["'`]/.test(out)
        || /["'`]op["'`]\s*:\s*["'`]init["'`]/.test(out);
      // PASS criteria: either an init call exists, OR no per-item creates
      if (hasInitOp || textHasInit) return { passed: true };
      if (todoCreateCount >= 2) {
        return {
          passed: false,
          reason: `model used ${todoCreateCount}× todo_create for initial 3-step plan instead of todo_update({op:"init"})`,
        };
      }
      // No tool calls at all on a "fresh task with explicit steps" prompt
      // is also a fail — task expects a plan commitment.
      if (todoUpdateCount === 0 && todoCreateCount === 0) {
        return {
          passed: false,
          reason: 'no plan commitment for an explicit 3-step task (expected todo_update op:init)',
        };
      }
      return { passed: true };
    },
  };
}

export function buildJudges(caseId: CaseId): readonly PromptJudge[] {
  switch (caseId) {
    case 'AUQ_1_positive_single':
      return [buildMustCallJudge('ask_user_question')];
    case 'AUQ_2_positive_multi':
      return [buildMustCallJudge('ask_user_question'), buildUsesQuestionsArrayJudge()];
    case 'AUQ_3_positive_input':
      return [buildMustCallJudge('ask_user_question'), buildKindInputJudge()];
    case 'AUQ_4_negative_trivial':
      return [buildMustNotCallJudge('ask_user_question')];
    case 'AUQ_5_negative_explicit':
      return [buildMustNotCallJudge('ask_user_question')];
    case 'AUQ_6_boundary_no_cram':
      return [buildMustCallJudge('ask_user_question'), buildUsesQuestionsArrayJudge()];
    case 'TC_1_positive_mid_task':
      return [
        buildMustCallJudge('todo_create'),
        buildHasActiveFormJudge(),
        buildNoIdFieldJudge(),
      ];
    case 'TC_3_negative_initial':
      return [buildPrefersTodoUpdateInitJudge()];
    case 'TC_4_negative_trivial':
      return [
        buildMustNotCallJudge('todo_create'),
        buildMustNotCallJudge('todo_update'),
      ];
  }
}

// ===========================================================================
// Variant builder — one PromptVariant per (case, schema_variant) pair
// ===========================================================================

export function buildPromptVariants(caseId: CaseId): readonly PromptVariant[] {
  const cs = CASES.find((c) => c.id === caseId);
  if (!cs) throw new Error(`Unknown case id: ${caseId}`);
  const variants: PromptVariant[] = [];
  for (const schemaV of ['v1_orig', 'v2_slim', 'v3_aggressive'] as const) {
    variants.push({
      id: schemaV,
      description: `${cs.description} [schema=${schemaV}]`,
      systemPrompt: SYSTEM_PROMPT,
      priorMessages: cs.priorMessages,
      userMessage: cs.userMessage,
      tools: buildToolsForVariant(schemaV),
    });
  }
  return variants;
}
