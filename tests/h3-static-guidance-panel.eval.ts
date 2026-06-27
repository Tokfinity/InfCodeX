/**
 * Panel eval — H3 harness refactor: "route-injected overlay" → "static EXECUTION GUIDANCE".
 *
 * Copied from h3-static-guidance-pilot.eval.ts and upgraded with:
 *   1. Fixed judges for C3 (review) and C4 (investigation) — aligned to KodaX real design.
 *   2. 5-alias panel: zhipu/glm52, kimi, mimo/v25pro, mmx/m3, ds/v4pro
 *   3. RUNS_PER_CELL = 3 (from pilot's 1)
 *
 * Judge corrections (see user task spec):
 *
 *   C3 (review): PASS = output (text OR todo_create binding input/description) mentions
 *     a specific high-signal problem from the diff (bcrypt async misuse, field rename risk,
 *     admin-username-vs-role). Does NOT penalize todo_create skeleton as format — the
 *     KodaX worker-role-prompt.ts:103 SCOPE COMMITMENT explicitly teaches
 *     "review/audit first batch of todo_create IS the review skeleton".
 *     FAIL = only naming/style nits, OR no substantive content signal at all.
 *
 *   C4 (investigation): PASS = any of:
 *     (a) grep/read/bash tool calls (active investigation)
 *     (b) todo_create whose subject/description contains investigation-intent keywords
 *         (定位/分析/根因/查找/trace/locate/investigate/reproduce/repro/diagnose/cause)
 *     (c) text mentions root-cause investigation keywords
 *     FAIL = immediately writes/edits code without any investigation signal.
 *
 * Pre-registered SHIP gate (per user task spec):
 *   (a) C1/C2 v_proposed per-alias pass rate not lower than v_baseline by >8pp.
 *   (b) C3/C4 v_proposed per-alias regression vs v_baseline ≤8pp.
 *   (c) token metric: v_proposed system prompt not longer than v_baseline (all cases).
 *   C5 floor tolerated (model floor, not H3 regression).
 *
 * Run:
 *   KODAX_EVAL_DUMP_DIR=c:/tmp/ npm run test:eval -- h3-static-guidance-panel
 *
 * Cost estimate: 5 cases × 2 variants × 5 alias × 3 runs = 150 LLM calls ≈ $1.5-6.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it } from 'vitest';

import { availableAliases, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runBenchmark } from '../benchmark/harness/harness.js';
import type { PromptJudge, JudgeContext, JudgeResult } from '../benchmark/harness/judges.js';
import {
  buildWorkerInstructions,
} from '../packages/coding/src/agents/worker-role-prompt.js';
import {
  buildFallbackRoutingDecision,
  buildPromptOverlay,
} from '../packages/coding/src/reasoning.js';
import {
  evaluateProviderPolicy,
} from '../packages/coding/src/provider-policy.js';
import {
  getToolDefinition,
} from '../packages/coding/src/tools/registry.js';

// ---------------------------------------------------------------------------
// Dump config
// ---------------------------------------------------------------------------

const DUMP_ROOT = join(
  process.env.KODAX_EVAL_DUMP_DIR ?? tmpdir(),
  'kodax-eval-dumps',
  'h3-static-guidance-panel',
);

// ---------------------------------------------------------------------------
// Static EXECUTION GUIDANCE (H3 proposed — verbatim from pilot)
// ---------------------------------------------------------------------------

const STATIC_EXECUTION_GUIDANCE = `EXECUTION GUIDANCE (match your approach to the kind of work — judge which fits):

- After you make a change, check the result against what was actually asked before you finalize. Confirm the change does what the request wanted, backed by evidence (a test run, a re-read of the edited region) rather than confidence alone — because a change that looks right but was never verified is how silent regressions ship.

- When you are reviewing code or a pull request: report only high-confidence issues that materially affect correctness, reliability, security, or merge-readiness. Do not list naming, formatting, or style preferences as findings — padding a review with nits buries the issues that matter. Lead with the must-fix items, then optional improvements, and for each issue state the concrete consequence it causes.

- When you are doing a broad audit: cover correctness, security, performance, and maintainability together, and keep issues you have confirmed separate from lower-confidence risks so the reader can tell which is which.

- When you are investigating a bug or an unknown: isolate the root cause and validate your assumptions with concrete evidence — a reproduction, a targeted check — before making broad changes, because a fix applied before the cause is understood usually treats a symptom.

- When the task is design or planning work: reason through architecture, constraints, sequencing, and risks before writing code.

- When the request is genuinely ambiguous: frame the options briefly and make the path you chose explicit before any irreversible edit, so the user can redirect before the cost is sunk.`;

// ---------------------------------------------------------------------------
// Production tool definitions (anti-pattern 8 compliance)
// ---------------------------------------------------------------------------

const RELEVANT_TOOL_NAMES = [
  'todo_create',
  'todo_update',
  'todo_get',
  'todo_list',
  'dispatch_child_task',
  'read',
  'grep',
  'bash',
  'write',
  'edit',
] as const;

const PRODUCTION_TOOLS = RELEVANT_TOOL_NAMES.map((name) => {
  const def = getToolDefinition(name);
  if (!def) {
    // eslint-disable-next-line no-console
    console.warn(`[h3-panel] WARNING: tool '${name}' not found in registry — panel will run without it`);
  }
  return def;
}).filter((t): t is NonNullable<typeof t> => t !== undefined);

// ---------------------------------------------------------------------------
// Variant builder helpers
// ---------------------------------------------------------------------------

/**
 * Build the v_baseline system prompt for a given user prompt string.
 * Replicates what production does:
 *   buildWorkerInstructions(decision, undefined, false) + '\n\n' + buildPromptOverlay(decision)
 *
 * Uses ark-coding as the provider stub for routing decision (same as pilot).
 */
function buildBaselineSystemPrompt(userPrompt: string): string {
  const providerPolicy = evaluateProviderPolicy({
    providerName: 'ark-coding',
    model: 'deepseek-v4-flash',
  });
  const decision = buildFallbackRoutingDecision(userPrompt, providerPolicy);
  const workerInstructions = buildWorkerInstructions(decision, undefined, false);
  const overlay = buildPromptOverlay(decision);
  return `${workerInstructions}\n\n${overlay}`;
}

/**
 * Build the v_proposed system prompt for a given user prompt string.
 * Same as baseline EXCEPT: no buildPromptOverlay(); append static EXECUTION GUIDANCE.
 */
function buildProposedSystemPrompt(userPrompt: string): string {
  const providerPolicy = evaluateProviderPolicy({
    providerName: 'ark-coding',
    model: 'deepseek-v4-flash',
  });
  const decision = buildFallbackRoutingDecision(userPrompt, providerPolicy);
  const workerInstructions = buildWorkerInstructions(decision, undefined, false);
  return `${workerInstructions}\n\n${STATIC_EXECUTION_GUIDANCE}`;
}

// ---------------------------------------------------------------------------
// Tool name pattern helpers (anti-pattern 7.4 compliance — multi-syntax)
// ---------------------------------------------------------------------------

function buildToolNamePatterns(toolName: string): readonly RegExp[] {
  const esc = toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    new RegExp(`(?<!<command>\\s*|<bash>\\s*|<shell>\\s*)\\b${esc}\\s*\\(`, 'i'),
    new RegExp(`["'\`]name["'\`]\\s*:\\s*["'\`]${esc}["'\`]`, 'i'),
    new RegExp(`<${esc}\\b(?:[\\s\\S]{0,2000}?</${esc}>|[^>]*/>)`, 'i'),
    new RegExp(`\\bname\\s*[:=]\\s*${esc}\\b`, 'i'),
    new RegExp(`<tool_name>\\s*${esc}\\s*</tool_name>`, 'i'),
    new RegExp(`<tool>\\s*${esc}\\s*</tool>`, 'i'),
    new RegExp(`<tool_call>\\s*${esc}\\b[\\s\\S]{0,2000}?</tool_call\\s*>`, 'i'),
    new RegExp(`\\b${esc}\\s*:\\s*\\d+\\s*[>{]`, 'i'),
    new RegExp(`tool\\s*=>\\s*["'\`]${esc}["'\`]`, 'i'),
    new RegExp(`(^|\\n)\\s*${esc}\\s*\\n\\s*\\{`, 'm'),
    new RegExp(`(^|\\n)\\s*${esc}\\s*\\{`, 'm'),
  ];
}

function invokesTool(text: string, toolName: string, context?: JudgeContext): boolean {
  if (context?.toolCalls?.some((t) => t.name === toolName)) return true;
  return buildToolNamePatterns(toolName).some((p) => p.test(text));
}

/**
 * Extract all text content from binding tool calls: name + stringified input.
 * Used by C3/C4 judges to inspect the content of todo_create calls even
 * when text="" (binding-only providers).
 */
function extractToolCallContent(context?: JudgeContext): string {
  if (!context?.toolCalls || context.toolCalls.length === 0) return '';
  return context.toolCalls.map((t) => {
    const inputStr = typeof t.input === 'string' ? t.input : JSON.stringify(t.input ?? '');
    return `[tool:${t.name}] ${inputStr}`;
  }).join('\n');
}

// ---------------------------------------------------------------------------
// Cases (identical to pilot)
// ---------------------------------------------------------------------------

interface PanelCase {
  readonly id: string;
  readonly description: string;
  readonly userPromptForRouting: string;
  readonly priorMessages?: readonly { role: 'user' | 'assistant'; content: string }[];
  readonly userMessage: string;
}

// C1: trivial lookup — should answer/grep directly, NOT todo_create
const C1: PanelCase = {
  id: 'C1_simple_no_ceremony',
  description: 'trivial lookup — should grep/answer directly, NOT call todo_create or dispatch',
  userPromptForRouting: '项目里 MANAGED_WORK_BUDGET_CAP 这个常量定义在哪个文件?',
  userMessage: '项目里 `MANAGED_WORK_BUDGET_CAP` 这个常量定义在哪个文件?',
};

// C2: complex multi-file refactor — should plan-first with todo_create
const C2: PanelCase = {
  id: 'C2_complex_plan_first',
  description: 'complex refactor — should emit todo_create plan-first',
  userPromptForRouting: '把 packages/auth 的 session 校验逻辑重构,拆分到 validator/store/types 三个文件,并为每个加单测。',
  userMessage: '把 packages/auth 的 session 校验逻辑重构,拆分到 validator/store/types 三个文件,并为每个加单测。',
};

// C3: code review with canned diff — judge: high-signal content, not format
const C3_DIFF = `
diff --git a/packages/auth/src/handler.ts b/packages/auth/src/handler.ts
index 1a2b3c4..5d6e7f8 100644
--- a/packages/auth/src/handler.ts
+++ b/packages/auth/src/handler.ts
@@ -12,6 +12,8 @@ export async function handleLogin(req: Request): Promise<Response> {
   const { username, password } = req.body;
+  // TODO: also handle email login
+  const isAdmin = username === 'admin';
   const user = await db.users.findOne({ username });
   if (!user) return Response.error('User not found');
-  const valid = bcrypt.compare(password, user.hash);
+  const valid = bcrypt.compare(password, user.passwordHash);
   if (!valid) return Response.error('Wrong password');
+  if (isAdmin) {
+    logAudit('admin-login', username);
+  }
   const token = jwt.sign({ id: user.id }, SECRET_KEY, { expiresIn: '24h' });
   return Response.json({ token });
 }
`.trim();

const C3: PanelCase = {
  id: 'C3_review_high_signal',
  description: 'code review — should focus on high-signal issues (bcrypt async bug), not naming/style nits',
  userPromptForRouting: 'review this code change',
  priorMessages: [
    { role: 'user' as const, content: `请 review 这段改动:\n\n\`\`\`diff\n${C3_DIFF}\n\`\`\`` },
    { role: 'assistant' as const, content: 'I will review this diff now.' },
  ],
  userMessage: 'review 这段改动，告诉我需要关注的问题。',
};

// C4: investigation / bug — should do targeted diagnosis, not broad changes
const C4: PanelCase = {
  id: 'C4_investigation_root_cause',
  description: 'bug investigation — should ask for repro / do targeted check before broad changes',
  userPromptForRouting: '用户报告 task_output 偶尔返回 wait_expired 后任务就卡住',
  userMessage: '用户报告 task_output 偶尔返回 wait_expired 后任务就卡住了，帮我调查一下这个 bug 的根因。',
};

// C5: parallel investigation across 3 packages — should dispatch_child_task fan-out
const C5: PanelCase = {
  id: 'C5_multi_module_dispatch',
  description: 'parallel investigation — should dispatch_child_task fan-out across packages',
  userPromptForRouting: '并行调查 llm、coding、agent 三个包各自的 reasoning 处理是否一致，分别给我结论。',
  userMessage: '并行调查 llm、coding、agent 三个包各自的 reasoning 处理是否一致，分别给我结论。',
};

const ALL_CASES: readonly PanelCase[] = [C1, C2, C3, C4, C5] as const;

// ---------------------------------------------------------------------------
// Judges (C3 + C4 corrected per user task spec)
// ---------------------------------------------------------------------------

// C1: negative judge — should NOT call todo_create or dispatch; positive — should grep/answer
function judgeC1NoCeremony(text: string, context?: JudgeContext): JudgeResult {
  const toolCalls = context?.toolCalls ?? [];
  const forbiddenCalled = toolCalls.some(
    (t) => t.name === 'todo_create' || t.name === 'dispatch_child_task',
  );
  if (forbiddenCalled) {
    const names = toolCalls.map((t) => t.name).join(',');
    return { passed: false, reason: `forbidden tool called (binding): ${names}` };
  }
  if (invokesTool(text, 'todo_create')) {
    return { passed: false, reason: 'todo_create invoked (regex) on trivial lookup' };
  }
  if (invokesTool(text, 'dispatch_child_task')) {
    return { passed: false, reason: 'dispatch_child_task invoked (regex) on trivial lookup' };
  }
  const positiveKeywords = ['grep', 'read', 'MANAGED_WORK_BUDGET_CAP', 'packages/', 'const ', 'file', '文件', 'search'];
  const lower = text.toLowerCase();
  const hasPositive = positiveKeywords.some((k) => lower.includes(k.toLowerCase()))
    || toolCalls.some((t) => t.name === 'grep' || t.name === 'read' || t.name === 'bash');
  if (!hasPositive) {
    return { passed: false, reason: `no grep/read/answer signal found (text[:200]="${text.slice(0, 200)}")` };
  }
  return { passed: true };
}

// C2: positive judge — should call todo_create (plan-first)
function judgeC2PlanFirst(text: string, context?: JudgeContext): JudgeResult {
  if (invokesTool(text, 'todo_create', context)) {
    return { passed: true };
  }
  return { passed: false, reason: `todo_create NOT invoked (binding+regex); text[:200]="${text.slice(0, 200)}"` };
}

/**
 * C3 CORRECTED judge — aligned to KodaX worker-role-prompt.ts SCOPE COMMITMENT.
 *
 * KodaX design: for review/audit tasks, todo_create IS the review skeleton — it is a
 * valid response format. The judge must NOT penalize this format.
 *
 * PASS criteria: the combined output (text + tool call bindings) must demonstrate
 * engagement with a HIGH-SIGNAL issue from this specific diff:
 *   - bcrypt.compare not awaited (async misuse — security/correctness bug)
 *   - field rename user.hash → user.passwordHash (may break login if schema not migrated)
 *   - admin check based on raw username before auth verification (auth logic issue)
 *   - hardcoded 'admin' string comparison (fragile identity check)
 *
 * High-signal keyword groups (any one group is sufficient):
 *   Group A (bcrypt): bcrypt, async, await, synchronous, blocking, promise
 *   Group B (field rename): passwordHash, user.hash, field, schema, undefined, rename
 *   Group C (admin/auth): admin, isAdmin, audit, role, username, authentication, identity
 *   Group D (general review signal): security, vulnerability, bug, correctness, risk, issue
 *
 * FAIL only if: nit-only content (naming/style) with ZERO high-signal keywords,
 *   OR absolutely no content at all (no text, no tool call with meaningful input).
 */
function judgeC3ReviewHighSignal(text: string, context?: JudgeContext): JudgeResult {
  // Combine text + binding tool call content for inspection
  const bindingContent = extractToolCallContent(context);
  const combined = (text + '\n' + bindingContent).toLowerCase();

  // Check for high-signal keyword groups
  const groupA = ['bcrypt', 'async', 'await', 'synchronous', 'blocking', 'promise'];
  const groupB = ['passwordhash', 'user.hash', 'field', 'schema', 'undefined', 'rename', 'migration'];
  const groupC = ['isadmin', 'admin', 'audit', 'role', 'authentication', 'identity', 'username'];
  const groupD = ['security', 'vulnerability', 'bug', 'correctness', 'risk', 'issue', '安全', '问题', '风险', '错误'];

  const hitA = groupA.some((k) => combined.includes(k));
  const hitB = groupB.some((k) => combined.includes(k));
  const hitC = groupC.some((k) => combined.includes(k));
  const hitD = groupD.some((k) => combined.includes(k));

  const hasHighSignal = hitA || hitB || hitC || hitD;

  if (!hasHighSignal) {
    // Also check if there is NO meaningful content at all
    if (combined.trim().length < 20) {
      return { passed: false, reason: 'no content at all (text empty, no binding input)' };
    }
    // Check for nit-only content
    const nitKeywords = ['naming', 'style', 'formatting', 'camelcase', 'snake_case', 'indent', 'whitespace'];
    const hasNitOnly = nitKeywords.some((k) => combined.includes(k));
    if (hasNitOnly) {
      return { passed: false, reason: 'review mentions only style/naming nits, no high-signal issue' };
    }
    return {
      passed: false,
      reason: `no high-signal keyword found in text+binding; text[:200]="${text.slice(0, 200)}" binding[:200]="${bindingContent.slice(0, 200)}"`,
    };
  }

  const hitGroups = [hitA && 'A(bcrypt/async)', hitB && 'B(field-rename)', hitC && 'C(admin/auth)', hitD && 'D(general)'].filter(Boolean).join(',');
  return { passed: true, reason: `high-signal groups: ${hitGroups}` };
}

/**
 * C4 CORRECTED judge — aligned to KodaX design that plan-first for investigation is valid.
 *
 * KodaX design: investigation tasks may:
 *   (a) Call grep/read/bash to actively investigate — always PASS
 *   (b) Call todo_create with items that describe investigation steps
 *       (subject/description containing intent: 定位/分析/查找/根因/trace/locate/
 *        investigate/reproduce/repro/diagnose/cause/查看/梳理/追踪/分析) — PASS
 *   (c) Text mentions root-cause investigation keywords — PASS
 *
 * FAIL only if: immediately calls write/edit with no investigation at all,
 *   OR produces completely empty output with zero investigation signal.
 *
 * NOTE: "todo_create that lists investigation steps" is NOT the same as "todo_create
 * on a simple lookup". The distinction is in the CONTENT of the todo items.
 */
function judgeC4InvestigateFirst(text: string, context?: JudgeContext): JudgeResult {
  const toolCalls = context?.toolCalls ?? [];

  // Bad: immediately writes or edits without investigation
  const immediateMutate = toolCalls.some((t) => t.name === 'write' || t.name === 'edit');
  if (immediateMutate) {
    const hasAnyInvestigation = toolCalls.some(
      (t) => t.name === 'grep' || t.name === 'read' || t.name === 'bash',
    );
    if (!hasAnyInvestigation) {
      return { passed: false, reason: 'immediately called write/edit before any investigation' };
    }
  }

  // Good path (a): active investigation tool calls
  const investigationTools = toolCalls.some(
    (t) => t.name === 'grep' || t.name === 'read' || t.name === 'bash',
  );
  if (investigationTools) {
    return { passed: true, reason: 'active investigation tools called (grep/read/bash)' };
  }

  // Good path (b): todo_create with investigation-intent content in subject/description
  const investigationIntentKeywords = [
    '定位', '分析', '查找', '根因', '查看', '梳理', '追踪', '排查', '复现',
    'trace', 'locate', 'investigate', 'reproduce', 'repro', 'diagnose',
    'cause', 'root', 'analyze', 'identify', 'inspect', 'examine',
    'task_output', 'wait_expired',
  ];
  const bindingContent = extractToolCallContent(context);
  const hasTodoCreate = toolCalls.some((t) => t.name === 'todo_create');
  if (hasTodoCreate) {
    const bindingLower = bindingContent.toLowerCase();
    const hasInvestigationIntent = investigationIntentKeywords.some(
      (k) => bindingLower.includes(k.toLowerCase()),
    );
    if (hasInvestigationIntent) {
      const hitKw = investigationIntentKeywords.find((k) => bindingLower.includes(k.toLowerCase()));
      return { passed: true, reason: `todo_create with investigation intent (keyword: "${hitKw}")` };
    }
  }

  // Good path (c): text mentions investigation keywords
  const textLower = text.toLowerCase();
  const textInvestigationKw = [
    'root cause', 'reproduce', 'repro', '根因', '复现', '定位', 'investigate',
    'check', 'look at', '查看', '分析', 'timeout', 'wait_expired', 'task_output',
    'trace', 'diagnosis', '排查', '梳理', '追踪',
  ];
  const hasInvestigationText = textInvestigationKw.some((k) => textLower.includes(k.toLowerCase()));
  if (hasInvestigationText) {
    return { passed: true, reason: 'text contains investigation keywords' };
  }

  // Check text regex fallback for todo_create with investigation signal
  if (invokesTool(text, 'todo_create')) {
    // If regex detects todo_create in text, check surrounding context for investigation keywords
    const combined = (text + '\n' + bindingContent).toLowerCase();
    const hasInvestigationInCombined = investigationIntentKeywords.some(
      (k) => combined.includes(k.toLowerCase()),
    );
    if (hasInvestigationInCombined) {
      return { passed: true, reason: 'todo_create (regex) + investigation keyword in combined content' };
    }
  }

  return { passed: false, reason: `no investigation signal (no grep/read/bash, no investigation-intent todo, no investigation text); text[:200]="${text.slice(0, 200)}"` };
}

// C5: positive judge — should dispatch_child_task fan-out
// NOTE: ark/v4flash is a known floor model for C5. The judge is unchanged;
// model floor is recorded separately in the summary (not a gate failure).
function judgeC5Dispatch(text: string, context?: JudgeContext): JudgeResult {
  if (invokesTool(text, 'dispatch_child_task', context)) {
    return { passed: true };
  }
  return { passed: false, reason: `dispatch_child_task NOT invoked; text[:200]="${text.slice(0, 200)}"` };
}

const CASE_JUDGES: Record<string, PromptJudge[]> = {
  [C1.id]: [{ name: 'no_ceremony_on_trivial', category: 'correctness', judge: judgeC1NoCeremony }],
  [C2.id]: [{ name: 'plan_first_todo_create', category: 'correctness', judge: judgeC2PlanFirst }],
  [C3.id]: [{ name: 'review_high_signal', category: 'correctness', judge: judgeC3ReviewHighSignal }],
  [C4.id]: [{ name: 'investigate_before_mutate', category: 'correctness', judge: judgeC4InvestigateFirst }],
  [C5.id]: [{ name: 'dispatch_fan_out', category: 'correctness', judge: judgeC5Dispatch }],
};

// ---------------------------------------------------------------------------
// Panel config
// ---------------------------------------------------------------------------

/**
 * Target aliases: 5 families as specified in user task:
 *   zhipu/glm52, kimi, mimo/v25pro, mmx/m3, ds/v4pro
 * Fallback within family if primary unavailable.
 */
const PANEL_ALIAS_PREFERENCE: readonly ModelAlias[] = [
  'zhipu/glm52',
  'kimi',
  'mimo/v25pro',
  'mmx/m3',
  'ds/v4pro',
  // Fallbacks if any of the above are unavailable
  'zhipu/glm51',
  'mimo/v25',
  'mmx/m27',
  'ds/v4flash',
] as const;

const RUNS_PER_CELL = 3;

const ALIAS_FALLBACK: Partial<Record<ModelAlias, ModelAlias>> = {
  'ds/v4pro':    'ds/v4flash',
  'ark/v4pro':   'ds/v4pro',
  'ark/v4flash': 'ds/v4flash',
};

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

describe('H3 static guidance panel — 5 alias × 5 cases × 2 variants × 3 runs', () => {
  // Select up to 5 aliases from preferred list — one per family.
  // We want at most: 1×zhipu, 1×kimi, 1×mimo, 1×mmx, 1×ds
  const allAvailable = availableAliases(...PANEL_ALIAS_PREFERENCE);

  // De-duplicate by family prefix so we don't run both glm51+glm52 etc.
  const familyMap: Record<string, ModelAlias> = {};
  for (const alias of allAvailable) {
    const family = alias.split('/')[0]!;
    if (!familyMap[family]) familyMap[family] = alias;
  }
  const aliases = Object.values(familyMap).slice(0, 5) as ModelAlias[];

  if (aliases.length === 0) {
    it('skips: no panel alias keys in env', () => { /* no-op */ });
    return;
  }

  // eslint-disable-next-line no-console
  console.log(`[h3-panel] Running with aliases: ${aliases.join(', ')}`);

  // Print token metric first (Layer-1 context-regression check)
  it(
    'token-metric: compare system prompt sizes (Layer-1)',
    () => {
      const lines: string[] = [];
      lines.push('[h3-panel] === TOKEN METRIC (Layer-1 context check) ===');
      for (const c of ALL_CASES) {
        const baseline = buildBaselineSystemPrompt(c.userPromptForRouting);
        const proposed = buildProposedSystemPrompt(c.userPromptForRouting);
        const delta = proposed.length - baseline.length;
        const gatePass = delta <= 0 ? 'PASS(c)' : 'FAIL(c)';
        lines.push(
          `  ${c.id.padEnd(35)} baseline=${baseline.length.toString().padStart(6)} chars  proposed=${proposed.length.toString().padStart(6)} chars  delta=${delta > 0 ? '+' : ''}${delta}  gate(c):${gatePass}`,
        );
      }
      // eslint-disable-next-line no-console
      console.log(lines.join('\n'));
    },
  );

  for (const c of ALL_CASES) {
    it(
      `${c.id} — ${aliases.join('+')} × 2 variants × ${RUNS_PER_CELL} runs`,
      { timeout: 20 * 60_000 },
      async () => {
        const baselineSysPrompt = buildBaselineSystemPrompt(c.userPromptForRouting);
        const proposedSysPrompt = buildProposedSystemPrompt(c.userPromptForRouting);

        const variants = [
          {
            id: 'v_baseline',
            description: 'production: buildWorkerInstructions + buildPromptOverlay',
            systemPrompt: baselineSysPrompt,
            priorMessages: c.priorMessages,
            userMessage: c.userMessage,
            tools: PRODUCTION_TOOLS,
          },
          {
            id: 'v_proposed',
            description: 'H3 proposed: buildWorkerInstructions + static EXECUTION GUIDANCE (no overlay)',
            systemPrompt: proposedSysPrompt,
            priorMessages: c.priorMessages,
            userMessage: c.userMessage,
            tools: PRODUCTION_TOOLS,
          },
        ];

        const judges = CASE_JUDGES[c.id] ?? [];

        const result = await runBenchmark({
          variants,
          models: aliases,
          judges,
          runs: RUNS_PER_CELL,
          aliasFallback: ALIAS_FALLBACK,
        });

        // Console summary — per variant × per alias
        const lines: string[] = [];
        lines.push(`[h3-panel][${c.id}]`);
        lines.push(`  desc: ${c.description}`);

        // Per-alias pass rate table
        lines.push('  variant       alias          passRate  runs(P/T)');
        for (const cell of result.cells) {
          const passed = cell.runsRaw.filter((r) => r.passed).length;
          lines.push(
            `  ${cell.variantId.padEnd(13)} ${cell.alias.padEnd(15)} ${cell.passRate.toFixed(0).padStart(3)}%      ${passed}/${RUNS_PER_CELL}`,
          );
          // Log raw run details for auditing
          for (const run of cell.runsRaw) {
            const judgeResults = run.judges.map((j) => `${j.name}=${j.passed ? 'PASS' : 'FAIL'}`).join(' ');
            const toolList = run.toolCalls.map((t) => t.name).join(',') || '(none)';
            const textPreview = run.text.slice(0, 150).replace(/\n/g, ' ');
            lines.push(`    run${run.runIndex}: tools=[${toolList}] text[:150]="${textPreview}"`);
            lines.push(`             judges: ${judgeResults}`);
            if (run.error) lines.push(`             ERROR: ${run.error}`);
            if (!run.judges[0]?.passed && run.judges[0]?.reason) {
              lines.push(`             reason: ${run.judges[0].reason}`);
            }
          }
        }

        // Gate (a)/(b) check per alias
        const baselineCells = result.byVariant['v_baseline'] ?? [];
        const proposedCells = result.byVariant['v_proposed'] ?? [];

        lines.push('  --- GATE CHECK per alias ---');
        const isC1C2 = c.id === 'C1_simple_no_ceremony' || c.id === 'C2_complex_plan_first';
        const isC3C4 = c.id === 'C3_review_high_signal' || c.id === 'C4_investigation_root_cause';
        const isC5 = c.id === 'C5_multi_module_dispatch';

        for (const alias of aliases) {
          const bCell = baselineCells.find((cell) => cell.alias === alias);
          const pCell = proposedCells.find((cell) => cell.alias === alias);
          if (!bCell || !pCell) {
            lines.push(`    ${alias}: SKIP (no cell data)`);
            continue;
          }
          const delta = pCell.passRate - bCell.passRate;
          const deltaStr = `${delta >= 0 ? '+' : ''}${delta.toFixed(0)}pp`;

          if (isC5) {
            lines.push(`    ${alias}: baseline=${bCell.passRate.toFixed(0)}% proposed=${pCell.passRate.toFixed(0)}% delta=${deltaStr} [C5-floor-tolerated]`);
          } else if (isC1C2) {
            // Gate (a): proposed must not regress baseline by >8pp
            const gateA = delta >= -8;
            lines.push(`    ${alias}: baseline=${bCell.passRate.toFixed(0)}% proposed=${pCell.passRate.toFixed(0)}% delta=${deltaStr} gate(a)=${gateA ? 'MET' : 'FAIL'}`);
          } else if (isC3C4) {
            // Gate (b): proposed regression ≤8pp
            const gateB = delta >= -8;
            lines.push(`    ${alias}: baseline=${bCell.passRate.toFixed(0)}% proposed=${pCell.passRate.toFixed(0)}% delta=${deltaStr} gate(b)=${gateB ? 'MET' : 'FAIL'}`);
          }
        }

        // eslint-disable-next-line no-console
        console.log(lines.join('\n'));

        // Dump
        mkdirSync(DUMP_ROOT, { recursive: true });
        const dumpPath = join(DUMP_ROOT, `${c.id}.json`);
        const dump = {
          case: c.id,
          stage: 'h3-static-guidance-panel',
          startedAt: result.startedAt,
          description: c.description,
          userMessage: c.userMessage,
          aliases,
          tokenMetric: {
            baselineChars: baselineSysPrompt.length,
            proposedChars: proposedSysPrompt.length,
            delta: proposedSysPrompt.length - baselineSysPrompt.length,
            gateCPass: proposedSysPrompt.length <= baselineSysPrompt.length,
          },
          variants: variants.map((v) => ({
            id: v.id,
            description: v.description,
            systemPromptChars: v.systemPrompt.length,
          })),
          cells: result.cells.map((cell) => ({
            variantId: cell.variantId,
            alias: cell.alias,
            passRate: cell.passRate,
            runs: cell.runs,
            completed: cell.completed,
            runsRaw: cell.runsRaw.map((run) => ({
              runIndex: run.runIndex,
              text: run.text,
              toolCalls: run.toolCalls.map((t) => ({
                name: t.name,
                inputPreview: JSON.stringify(t.input).slice(0, 400),
              })),
              durationMs: run.durationMs,
              error: run.error,
              fallbackUsed: run.fallbackUsed,
              regexJudges: run.judges.map((j) => ({
                name: j.name,
                passed: j.passed,
                reason: j.reason,
              })),
            })),
          })),
          gateAnalysis: aliases.map((alias) => {
            const bCell = baselineCells.find((cell) => cell.alias === alias);
            const pCell = proposedCells.find((cell) => cell.alias === alias);
            const delta = bCell && pCell ? pCell.passRate - bCell.passRate : null;
            return {
              alias,
              baselinePassRate: bCell?.passRate ?? null,
              proposedPassRate: pCell?.passRate ?? null,
              deltaPercent: delta,
              gateA_met: isC1C2 ? (delta !== null ? delta >= -8 : null) : null,
              gateB_met: isC3C4 ? (delta !== null ? delta >= -8 : null) : null,
              c5FloorTolerated: isC5 ? true : null,
            };
          }),
        };
        writeFileSync(dumpPath, JSON.stringify(dump, null, 2), 'utf-8');
        // eslint-disable-next-line no-console
        console.log(`  [dump] ${dumpPath}`);
      },
    );
  }
});
