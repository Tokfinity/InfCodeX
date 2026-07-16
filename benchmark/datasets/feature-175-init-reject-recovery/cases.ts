/**
 * Dataset — FEATURE_175 (v0.7.42) plan-list resilience —
 * op:'init' dirty-store reject recovery probe.
 *
 * Layer 2 probe per EVAL_GUIDELINES: measures whether canonical 5-alias
 * panel Workers correctly recover via surgical APIs (todo_create /
 * op:'update' / status:'deleted') after a dirty-store op:'init' attempt
 * is rejected by the tool layer.
 *
 * Smoking-gun motivating the tool-layer reject (production session
 * 20260519_~2100):
 *
 *   V2 Worker mid-task, plan has 2 completed + 2 pending. User
 *   injects new requirement. Worker silently emits
 *   `todo_update({op:"init", items:[...]})` to "refine" the plan
 *   → store.init() wipes prior completed status back to pending
 *   → plan UI flips from "2/4 completed" to "0/N completed"
 *   (visible to user as "the list invalidated itself") → user
 *   loses progress signal and trust.
 *
 *   Slice 1 ships the tool-layer reject + a structured error reason
 *   that names every surgical alternative. This probe measures
 *   whether the LLM actually picks up the recovery path or loops on
 *   another op:'init'.
 *
 * ## Cases (2)
 *
 *   **C1 `recovery_after_init_reject_simple`** — additive scope change.
 *     Worker is mid-task with 2/4 items completed; user just asked to
 *     add ONE more substep. Worker tries op:'init' with 5 items → tool
 *     rejects with the structured reason. Probe Worker's NEXT response.
 *     PASS iff first tool call is `todo_create` OR `todo_update`
 *     without `op:'init'`. FAIL if first call is another op:'init'
 *     (anti-loop) or no tool call at all (gave up).
 *
 *   **C2 `recovery_after_init_reject_full_pivot`** — destructive scope
 *     change. Same starting state (2/4 done), but user said
 *     "前面那些都不要了，重新做". The rejection reason itself documents
 *     the delete-then-init recovery path. Probe whether Worker follows
 *     it. PASS iff first tool call is `todo_update` with
 *     `status:"deleted"` (then re-init), OR `todo_create` (treating
 *     the new scope additively), OR `todo_update` without
 *     `op:'init'`. FAIL if first call is another op:'init' or
 *     no tool call.
 *
 * ## Variant
 *
 * Single `v_current` variant — no prompt comparison; this is a measurement
 * of the production Worker prompt + the tool-layer reject contract
 * shipped in Slice 1.
 *
 * ## Pre-registered SHIP gate (Slice 1 fix #3 — dirty-reject)
 *
 *   SHIP (keep dirty-reject in production) IFF all of:
 *     (a) ≥4 of 5 alias达 ≥60% recovery rate on C1
 *     (b) zhipu/glm51 NOT at exactly 0% on C1 (structural floor → revert)
 *     (c) ≥3 of 5 alias达 ≥40% recovery rate on C2 (the harder pivot path)
 *     (d) self-judge audit disagreement < 10% on regex-fail samples
 *
 *   REVERT (delete dirty-reject, keep store-layer preserve + B2 synth)
 *   IFF any of (a)-(d) fails.
 *
 *   Rationale for thresholds: a 60% recovery rate on the simpler C1
 *   path is the floor below which the surgical-API guidance in the
 *   reject reason is not landing on the model. Without the guidance
 *   landing, the dirty-reject creates a worse UX than the wipe (LLM
 *   loops, user sees nothing happening), making the store-layer
 *   preserve alone the safer net. (a)+(b) cover the dominant case;
 *   (c) is a softer floor because C2 is genuinely harder — fewer
 *   alias support is acceptable.
 *
 * ## Sample size escalation
 *
 *   5 runs/cell baseline. Per EVAL_GUIDELINES, cells landing in the
 *   65-85% statistical-uncertainty band should be re-run with N=10
 *   before applying the SHIP matrix. Operator-controlled, no auto-
 *   escalate.
 *
 * ## Audit
 *
 *   Per anti-pattern 7 §3: every regex-fail sample is cross-validated
 *   by the orchestrating Claude session (self-judge mode allowed for
 *   ≤50 cells per EVAL_GUIDELINES §"Judge 模型选择约束" rule 1). If
 *   disagreement >10%, escalate to panel-internal 3-judge majority
 *   (zhipu/glm51 + ds/v4pro + kimi) per rule 2.
 *
 * ## See also
 *
 *   - docs/features/v0.7.42.md §FEATURE_175 — design + Slice 1 code paths
 *   - benchmark/datasets/feature-167-evaluator-verdict-fallback/cases.ts
 *     — sibling pattern (5-alias panel, multi-syntax tool detection,
 *     scene-builder approach)
 *   - benchmark/EVAL_GUIDELINES.md §Layer 2 probe contract
 */

import type { PromptVariant } from '../../harness/harness.js';
import type { PromptJudge } from '../../harness/judges.js';

export type CaseId =
  | 'recovery_after_init_reject_simple'
  | 'recovery_after_init_reject_full_pivot';

export interface CaseSpec {
  readonly id: CaseId;
  readonly assertion:
    | 'first_tool_call_is_recovery_not_init'
    | 'first_tool_call_is_recovery_not_init_pivot';
  readonly description: string;
}

export const CASES: readonly CaseSpec[] = [
  {
    id: 'recovery_after_init_reject_simple',
    assertion: 'first_tool_call_is_recovery_not_init',
    description:
      'Worker mid-task (2/4 items completed) gets op:\'init\' rejected after '
      + 'trying to additively expand the plan. PASS iff first tool call is '
      + '`todo_create` or `todo_update` without op:"init". FAIL if it loops '
      + 'into another op:"init" or skips tool use entirely.',
  },
  {
    id: 'recovery_after_init_reject_full_pivot',
    assertion: 'first_tool_call_is_recovery_not_init_pivot',
    description:
      'Worker mid-task (2/4 items completed) gets op:\'init\' rejected after '
      + 'trying to wipe-and-replace for a user-driven pivot. PASS iff first '
      + 'tool call follows the rejection reason\'s documented recovery '
      + '(status:"deleted" then init, OR additive todo_create / op:"update"). '
      + 'FAIL if it loops into another op:"init" or skips tool use.',
  },
] as const;

// ---------------------------------------------------------------------------
// Pinned constant — DIRTY_INIT_REJECT_REASON_TEMPLATE
//
// The tool-result text the Worker sees when op:'init' is rejected on a
// dirty store. This MUST stay byte-equivalent to the production tool
// reason at `packages/coding/src/tools/todo-update.ts:executeInitOp`
// (the `nonPending.length > 0` branch). If the production text changes,
// re-run this probe BEFORE shipping the new text — the recovery rate
// is a function of how clearly the reject reason guides the LLM.
// ---------------------------------------------------------------------------

function buildDirtyInitRejectReason(
  nonPendingLabels: readonly string[],
): string {
  const labels = nonPendingLabels.join(', ');
  return (
    `op:'init' refused: plan already has ${nonPendingLabels.length} non-pending item(s) `
    + `[${labels}]. Calling op:'init' here would lose that state. `
    + `Use surgical APIs instead:\n`
    + `  - Insert ONE new step: todo_create({content:"...", activeForm:"..."})\n`
    + `  - Edit ONE step's text/evaluator/metadata: `
    + `todo_update({id:"<existing-id>", content:"...", activeForm:"...", evaluator:"..."})\n`
    + `  - Mark ONE step done/failed/skipped/cancelled: `
    + `todo_update({id:"<existing-id>", status:"completed"|"failed"|"skipped"|"cancelled", note:"..."})\n`
    + `  - Remove ONE step entirely: todo_update({id:"<existing-id>", status:"deleted"})\n`
    + `If the task truly pivoted such that none of the existing items apply, `
    + `mark each non-pending item status:"deleted" first, then call op:'init' on the now-pending plan.`
  );
}

// ---------------------------------------------------------------------------
// Worker system prompt — production-realistic minimal shape.
//
// Based on the v0.7.41 Worker role prompt's plan-first contract section
// (worker-role-prompt.ts:53-66). We include the warning text against
// mid-task op:'init' so the probe measures what models do given the
// production framing.
// ---------------------------------------------------------------------------

const WORKER_SYSTEM_PROMPT = [
  'You are Worker — the single-loop primary executor for a managed KodaX task.',
  '',
  'PLAN-FIRST CONTRACT:',
  '- Non-trivial tasks (≥2 distinct steps OR touching ≥2 files / areas) → your',
  '  FIRST tool call MUST be todo_update({op:"init", items:[...]}) with the',
  '  full plan.',
  '- Each item carries a status: pending / in_progress / completed / failed /',
  '  cancelled / deleted. Mark exactly ONE item in_progress at a time.',
  '- Replan iteratively as the picture firms up:',
  '    * INSERT ONE NEW STEP: todo_create({content:"...", activeForm:"..."}).',
  '    * EDIT ONE STEP: todo_update({id, content?, activeForm?, evaluator?}).',
  '    * REMOVE ONE STEP: todo_update({id, status:"deleted"}).',
  '    * STRIKETHROUGH ONE STEP: todo_update({id, status:"cancelled", note:"..."}).',
  '    * FULL REPLAN (rare): todo_update({op:"init", items:[...]}). NEVER use for',
  '      mid-task insertion — it wipes user-visible progress on completed items.',
  '',
  'Available tools:',
  '  todo_update({...}) / todo_create({content, activeForm?}) — plan management.',
  '  read({path}) / grep({pattern}) / glob({pattern}) — read-only inspection.',
  '  write({path, content}) / edit({path, ...}) — file mutation.',
  '  bash({command}) — shell.',
  '  emit_handoff({status, summary, evidence?}) — terminal handoff to Evaluator.',
].join('\n');

// ---------------------------------------------------------------------------
// Canned transcript builder.
//
// Two scenes share the prefix (4-item plan, 2/4 completed, mid-task) and
// diverge on the user's mid-task message (additive vs pivot).
// ---------------------------------------------------------------------------

interface SceneFragment {
  readonly priorMessages: PromptVariant['priorMessages'];
  readonly userMessage: string;
}

function buildScene(variant: 'additive' | 'pivot'): SceneFragment {
  // Common opening turn: user asks for a map feature, Worker plans 4 items.
  const openingMessages: PromptVariant['priorMessages'] = [
    {
      role: 'user',
      content:
        '请帮我做一个中国治安地图：'
        + '\n1) 用 ECharts 加载真实中国地图轮廓'
        + '\n2) 在 11 个城市叠加监控点'
        + '\n3) 修复缩放时标记位置漂移'
        + '\n4) 浏览器测试并提交',
    },
    {
      role: 'assistant',
      content:
        '我来规划一下。\n\n'
        + '<tool_call>todo_update({op:"init", items:[\n'
        + '  {id:"todo_1", content:"引入 ECharts CDN 加载真实中国地图", activeForm:"加载地图"},\n'
        + '  {id:"todo_2", content:"叠加 11 个城市监控点", activeForm:"叠加监控点"},\n'
        + '  {id:"todo_3", content:"修复缩放标记不跟随 + 增强交互", activeForm:"修复缩放交互"},\n'
        + '  {id:"todo_4", content:"浏览器验证并提交", activeForm:"验证提交"}\n'
        + ']})</tool_call>',
    },
    { role: 'user', content: '{"ok":true,"count":4}' },
    // Worker closes todo_1 + todo_2.
    {
      role: 'assistant',
      content:
        '<tool_call>todo_update({id:"todo_1", status:"in_progress"})</tool_call>\n'
        + '...\n'
        + '[wrote index.html with ECharts CDN + GeoJSON loader]\n'
        + '<tool_call>todo_update({id:"todo_1", status:"completed"})</tool_call>',
    },
    { role: 'user', content: '{"ok":true}' },
    {
      role: 'assistant',
      content:
        '<tool_call>todo_update({id:"todo_2", status:"in_progress"})</tool_call>\n'
        + '...\n'
        + '[added markers for 北京/上海/广州/武汉/西安/成都/太原/兰州/长沙/南京/西宁]\n'
        + '<tool_call>todo_update({id:"todo_2", status:"completed"})</tool_call>',
    },
    { role: 'user', content: '{"ok":true}' },
  ];

  // The mid-task user interjection diverges by variant.
  const interjectionMessage: PromptVariant['priorMessages'][number] =
    variant === 'additive'
      ? {
          role: 'user',
          content:
            '能不能再给地图加一个 hover tooltip 显示每个城市的详细数据？'
            + '其他的还是按原计划继续。',
        }
      : {
          role: 'user',
          content:
            '我想了想，前面那些都先不做了。'
            + '改成做一个简单的全国 GDP 排名柱状图就行，简单点。',
        };

  // Worker's failed op:'init' attempt (the protagonist of this probe).
  const itemsListAdditive =
    '  {id:"todo_1", content:"引入 ECharts CDN 加载真实中国地图", activeForm:"加载地图"},\n'
    + '  {id:"todo_2", content:"叠加 11 个城市监控点", activeForm:"叠加监控点"},\n'
    + '  {id:"todo_3", content:"修复缩放标记不跟随 + 增强交互", activeForm:"修复缩放交互"},\n'
    + '  {id:"todo_4", content:"浏览器验证并提交", activeForm:"验证提交"},\n'
    + '  {id:"todo_5", content:"加 hover tooltip 显示城市详情", activeForm:"加 tooltip"}\n';
  const itemsListPivot =
    '  {id:"todo_1", content:"加载 GDP 数据", activeForm:"加载数据"},\n'
    + '  {id:"todo_2", content:"渲染柱状图", activeForm:"渲染柱状图"},\n'
    + '  {id:"todo_3", content:"浏览器验证并提交", activeForm:"验证提交"}\n';
  const itemsListForCall = variant === 'additive' ? itemsListAdditive : itemsListPivot;

  const failedInitAttempt: PromptVariant['priorMessages'][number] = {
    role: 'assistant',
    content:
      '好的，我刷新一下计划：\n\n'
      + `<tool_call>todo_update({op:"init", items:[\n${itemsListForCall}]})</tool_call>`,
  };

  // The tool layer rejects with the structured reason. After Slice 1 #3
  // ships, the actual production reason carries these labels — todo_1
  // and todo_2 are `completed`, the others are `pending` and not listed.
  const rejectReason = buildDirtyInitRejectReason(['todo_1=completed', 'todo_2=completed']);
  const rejectToolResult: PromptVariant['priorMessages'][number] = {
    role: 'user',
    content: JSON.stringify({ ok: false, reason: rejectReason }),
  };

  const priorMessages: PromptVariant['priorMessages'] = [
    ...openingMessages,
    interjectionMessage,
    failedInitAttempt,
    rejectToolResult,
  ];

  // The probe's userMessage is the rejection tool result (already the
  // last user-role message in priorMessages). The harness convention is
  // that userMessage is what the assistant responds to NEXT; for tool
  // result follow-ups we keep the result in priorMessages and pass an
  // explicit nudge so the assistant treats the tool_result as the
  // pending observation it needs to act on.
  const userMessage =
    '上一次 todo_update 调用被工具层拒绝（见上方 tool result 的 reason 字段）。请根据其中的建议恢复计划管理。';

  return { priorMessages, userMessage };
}

function buildSceneForCase(caseId: CaseId): SceneFragment {
  switch (caseId) {
    case 'recovery_after_init_reject_simple':
      return buildScene('additive');
    case 'recovery_after_init_reject_full_pivot':
      return buildScene('pivot');
  }
}

export function buildPromptVariants(caseId: CaseId): readonly PromptVariant[] {
  const scene = buildSceneForCase(caseId);
  const description =
    caseId === 'recovery_after_init_reject_simple'
      ? 'Worker recovery after additive op:\'init\' reject (current production prompt)'
      : 'Worker recovery after pivot op:\'init\' reject (current production prompt)';
  return [
    {
      id: 'v_current',
      description,
      systemPrompt: WORKER_SYSTEM_PROMPT,
      priorMessages: scene.priorMessages,
      userMessage: scene.userMessage,
    },
  ];
}

// ---------------------------------------------------------------------------
// Judges — multi-syntax tool-name detection (anti-pattern 7 §4) + op:'init'
// payload detection (negative discriminator to catch retry-loops).
// ---------------------------------------------------------------------------

function buildToolNamePatterns(toolName: string): readonly RegExp[] {
  const esc = toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    new RegExp(`\\b${esc}\\s*\\(`, 'i'), // tool_name(
    new RegExp(`["'\`]name["'\`]\\s*:\\s*["'\`]${esc}["'\`]`, 'i'), // "name":"tool_name"
    new RegExp(`\\bname\\s*:\\s*["'\`]${esc}["'\`]`, 'i'), // name: "tool_name"
    new RegExp(`<${esc}\\b`, 'i'), // <tool_name>
    new RegExp(`\\bname\\s*[:=]\\s*${esc}\\b`, 'i'), // name: tool_name
  ];
}

function mentionsToolName(output: string, toolName: string): boolean {
  return buildToolNamePatterns(toolName).some((p) => p.test(output));
}

/**
 * Detect whether the FIRST tool invocation in the response payload
 * contains `op:"init"`. This is the negative discriminator — a `true`
 * return means the LLM looped into another op:'init' instead of
 * recovering via surgical APIs.
 *
 * We scan the first `todo_update(` (or alt-syntax) and look for an
 * `op` field with value `init` within a reasonable window. Conservative
 * window of ~300 chars covers multi-line items arrays without picking
 * up later body content.
 */
function firstToolCallIsOpInit(output: string): boolean {
  // Find the earliest occurrence of a todo_update invocation across
  // the 5 syntax forms.
  const patterns = buildToolNamePatterns('todo_update');
  let earliestIdx = -1;
  for (const p of patterns) {
    const m = p.exec(output);
    if (m && (earliestIdx < 0 || m.index < earliestIdx)) {
      earliestIdx = m.index;
    }
  }
  if (earliestIdx < 0) return false;
  // Scan the next ~600 chars for an `op` token bound to `init`.
  // Tolerate spacing variation: `op: "init"`, `"op":"init"`, `op="init"`.
  const window = output.slice(earliestIdx, earliestIdx + 600);
  return /\bop\s*[:=]\s*["'`]init["'`]/i.test(window);
}

/**
 * Builds the assertion: PASS iff
 *   (a) at least one of {todo_create, todo_update} is invoked in the
 *       response (some plan-management action was taken), AND
 *   (b) the FIRST todo_update call (if any) is NOT op:"init"
 *       (no retry-loop), AND
 *   (c) the response contains at least one of: todo_create,
 *       todo_update with status:"deleted", todo_update with
 *       op:"update" / no op (= default update), todo_update with a
 *       status transition (completed/failed/skipped/cancelled/deleted).
 */
function buildRecoveryJudge(caseId: CaseId): PromptJudge {
  return {
    name: `${caseId}_first_tool_is_recovery_not_init`,
    category: 'correctness',
    judge: (out) => {
      const hasTodoCreate = mentionsToolName(out, 'todo_create');
      const hasTodoUpdate = mentionsToolName(out, 'todo_update');
      const hasAnyPlanCall = hasTodoCreate || hasTodoUpdate;
      const firstTodoUpdateIsInit = hasTodoUpdate && firstToolCallIsOpInit(out);

      // FAIL fast: no plan-management call at all → gave up.
      if (!hasAnyPlanCall) {
        return {
          passed: false,
          reason:
            'No todo_create or todo_update invocation detected (5-syntax). '
            + 'Worker gave up instead of recovering via surgical APIs. '
            + 'MUST be cross-validated by self-judge audit per anti-pattern 7.',
        };
      }
      // FAIL: looped back into op:'init'.
      if (firstTodoUpdateIsInit) {
        return {
          passed: false,
          reason:
            'First todo_update invocation is op:"init" — Worker looped on the '
            + 'rejected operation instead of switching to surgical APIs. '
            + 'MUST be cross-validated by self-judge audit per anti-pattern 7.',
        };
      }
      // PASS: at least one plan-management call AND not a re-init.
      return { passed: true };
    },
  };
}

export function buildJudges(caseId: CaseId): readonly PromptJudge[] {
  const spec = CASES.find((c) => c.id === caseId);
  if (!spec) throw new Error(`unknown case id ${caseId}`);
  return [buildRecoveryJudge(caseId)];
}
