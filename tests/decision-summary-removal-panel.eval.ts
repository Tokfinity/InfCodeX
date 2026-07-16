/**
 * Panel eval — decisionSummary removal from V2 Worker system prompt.
 *
 * Tests whether removing the 8-line classification block (decisionSummary)
 * from the Worker system prompt causes behaviour regression.
 *
 * Background:
 *   Production V2 Worker prompt = workspaceSection + ... + decisionSummary +
 *     ... + buildWorkerInstructions(). The decisionSummary (role-prompt.ts:93-102)
 *   is an 8-line classification table:
 *     Primary task / Assurance intent / Work intent / Complexity hint /
 *     Risk / Harness / Topology ceiling / Brainstorm required
 *   This is ADR-033 anti-pattern (feeds LLM a classification table).
 *   buildWorkerInstructions() already has roleAck with 5 of the 8 fields
 *   (Primary task / Work intent / Risk / Complexity / Brainstorm). Removing
 *   decisionSummary drops only: Harness / Topology ceiling / Assurance intent.
 *
 * Two variants:
 *   v_baseline: buildWorkerInstructions(decision,undefined,false) + '\n\n' + decisionSummary
 *   v_proposed: buildWorkerInstructions(decision,undefined,false)             (no decisionSummary)
 *
 * Cases: identical to h3-static-guidance-panel.eval.ts (C1-C5 + same judges).
 * Aliases: zhipu/glm52, kimi, mimo/v25pro, mmx/m3, ds/v4pro (+ fallbacks).
 *   User requested: availableAliases('zhipu/glm52','kimi','mimo/v25pro','mmx/m3','ds/v4pro')
 *
 * Pre-registered SHIP gate:
 *   v_proposed relative to v_baseline: per-case per-alias regression ≤ 8pp.
 *   C5 floor tolerated (dispatch model floor, not a decisionSummary regression).
 *   token metric: v_proposed system prompt NOT longer than v_baseline.
 *
 * Cost estimate: 5 alias × 5 case × 2 variant × 3 runs = 150 LLM calls ≈ $1.5-6.
 *   (Pilot: 1 alias × 5 case × 2 variant × 1 run = 10 calls)
 *
 * Run pilot:
 *   KODAX_EVAL_DUMP_DIR=c:/tmp/ KODAX_EVAL_PILOT=1 npm run test:eval -- decision-summary-removal-panel
 * Run panel:
 *   KODAX_EVAL_DUMP_DIR=c:/tmp/ npm run test:eval -- decision-summary-removal-panel
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
  'decision-summary-removal-panel',
);

// ---------------------------------------------------------------------------
// decisionSummary block builder (mirrors role-prompt.ts:92-102 exactly)
// ---------------------------------------------------------------------------

function buildDecisionSummaryBlock(decision: ReturnType<typeof buildFallbackRoutingDecision>): string {
  const ceilingValue = decision.topologyCeiling ?? decision.upgradeCeiling ?? 'none';
  return [
    `Primary task: ${decision.primaryTask}`,
    `Assurance intent: ${decision.assuranceIntent ?? 'default'}`,
    `Work intent: ${decision.workIntent}`,
    `Complexity hint: ${decision.complexity}`,
    `Risk: ${decision.riskLevel}`,
    `Harness: ${decision.harnessProfile}`,
    `Topology ceiling: ${ceilingValue}`,
    `Brainstorm required: ${decision.requiresBrainstorm ? 'yes' : 'no'}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Variant builders
// ---------------------------------------------------------------------------

/**
 * v_baseline: buildWorkerInstructions(decision, undefined, false) + decisionSummary
 * Mirrors production role-prompt.ts worker case (the two fragments that the eval tests).
 * Uses ark-coding/deepseek-v4-flash as routing provider stub (same as H3 driver).
 */
function buildBaselineSystemPrompt(userPrompt: string): string {
  const providerPolicy = evaluateProviderPolicy({
    providerName: 'ark-coding',
    model: 'deepseek-v4-flash',
  });
  const decision = buildFallbackRoutingDecision(userPrompt, providerPolicy);
  const workerInstructions = buildWorkerInstructions(decision, undefined, false);
  const decisionSummary = buildDecisionSummaryBlock(decision);
  return `${workerInstructions}\n\n${decisionSummary}`;
}

/**
 * v_proposed: buildWorkerInstructions(decision, undefined, false) only.
 * No decisionSummary appended.
 */
function buildProposedSystemPrompt(userPrompt: string): string {
  const providerPolicy = evaluateProviderPolicy({
    providerName: 'ark-coding',
    model: 'deepseek-v4-flash',
  });
  const decision = buildFallbackRoutingDecision(userPrompt, providerPolicy);
  const workerInstructions = buildWorkerInstructions(decision, undefined, false);
  return workerInstructions;
}

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
    console.warn(`[dsrm-panel] WARNING: tool '${name}' not found in registry — panel will run without it`);
  }
  return def;
}).filter((t): t is NonNullable<typeof t> => t !== undefined);

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

function extractToolCallContent(context?: JudgeContext): string {
  if (!context?.toolCalls || context.toolCalls.length === 0) return '';
  return context.toolCalls.map((t) => {
    const inputStr = typeof t.input === 'string' ? t.input : JSON.stringify(t.input ?? '');
    return `[tool:${t.name}] ${inputStr}`;
  }).join('\n');
}

// ---------------------------------------------------------------------------
// Cases — identical to h3-static-guidance-panel.eval.ts (C1-C5)
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
// Judges — identical to h3-static-guidance-panel.eval.ts
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
 * C3 judge — aligned to KodaX worker-role-prompt.ts SCOPE COMMITMENT.
 * PASS criteria: output (text + tool call bindings) demonstrates engagement
 * with a HIGH-SIGNAL issue from this specific diff.
 */
function judgeC3ReviewHighSignal(text: string, context?: JudgeContext): JudgeResult {
  const bindingContent = extractToolCallContent(context);
  const combined = (text + '\n' + bindingContent).toLowerCase();

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
    if (combined.trim().length < 20) {
      return { passed: false, reason: 'no content at all (text empty, no binding input)' };
    }
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
 * C4 judge — aligned to KodaX design: investigation tasks may:
 *   (a) Call grep/read/bash — always PASS
 *   (b) Call todo_create with investigation-intent content — PASS
 *   (c) Text mentions root-cause investigation keywords — PASS
 */
function judgeC4InvestigateFirst(text: string, context?: JudgeContext): JudgeResult {
  const toolCalls = context?.toolCalls ?? [];

  const immediateMutate = toolCalls.some((t) => t.name === 'write' || t.name === 'edit');
  if (immediateMutate) {
    const hasAnyInvestigation = toolCalls.some(
      (t) => t.name === 'grep' || t.name === 'read' || t.name === 'bash',
    );
    if (!hasAnyInvestigation) {
      return { passed: false, reason: 'immediately called write/edit before any investigation' };
    }
  }

  const investigationTools = toolCalls.some(
    (t) => t.name === 'grep' || t.name === 'read' || t.name === 'bash',
  );
  if (investigationTools) {
    return { passed: true, reason: 'active investigation tools called (grep/read/bash)' };
  }

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

  if (invokesTool(text, 'todo_create')) {
    const combined = (text + '\n' + bindingContent).toLowerCase();
    const hasInvestigationInCombined = investigationIntentKeywords.some(
      (k) => combined.includes(k.toLowerCase()),
    );
    if (hasInvestigationInCombined) {
      return { passed: true, reason: 'todo_create (regex) + investigation keyword in combined content' };
    }
  }

  return { passed: false, reason: `no investigation signal; text[:200]="${text.slice(0, 200)}"` };
}

// C5: positive judge — should dispatch_child_task fan-out
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

const IS_PILOT = process.env.KODAX_EVAL_PILOT === '1';

/**
 * User-requested aliases: zhipu/glm52, kimi, mimo/v25pro, mmx/m3, ds/v4pro
 * Fallbacks within family if primary unavailable.
 */
const PANEL_ALIAS_PREFERENCE: readonly ModelAlias[] = IS_PILOT
  ? ['zhipu/glm52', 'kimi', 'mimo/v25pro', 'mmx/m3', 'ds/v4pro', 'zhipu/glm51', 'mimo/v25', 'mmx/m27', 'ds/v4flash', 'ark/v4flash']
  : ['zhipu/glm52', 'kimi', 'mimo/v25pro', 'mmx/m3', 'ds/v4pro', 'zhipu/glm51', 'mimo/v25', 'mmx/m27', 'ds/v4flash', 'ark/v4flash'];

const RUNS_PER_CELL = IS_PILOT ? 1 : 3;

// For pilot: use just the first available alias.
// For panel: de-duplicate by family, take up to 5.
function selectAliases(all: ModelAlias[]): ModelAlias[] {
  if (IS_PILOT) {
    return all.slice(0, 1);
  }
  const familyMap: Record<string, ModelAlias> = {};
  for (const alias of all) {
    const family = alias.split('/')[0]!;
    if (!familyMap[family]) familyMap[family] = alias;
  }
  return Object.values(familyMap).slice(0, 5) as ModelAlias[];
}

const ALIAS_FALLBACK: Partial<Record<ModelAlias, ModelAlias>> = {
  'ds/v4pro':    'ds/v4flash',
  'ark/v4pro':   'ds/v4pro',
  'ark/v4flash': 'ds/v4flash',
};

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

describe(
  IS_PILOT
    ? 'decision-summary-removal PILOT — 1 alias × 5 cases × 2 variants × 1 run'
    : 'decision-summary-removal PANEL — 5 alias × 5 cases × 2 variants × 3 runs',
  () => {
    const allAvailable = availableAliases(...PANEL_ALIAS_PREFERENCE);
    const aliases = selectAliases(allAvailable);

    if (aliases.length === 0) {
      it('skips: no panel alias keys in env', () => { /* no-op */ });
      return;
    }

    // eslint-disable-next-line no-console
    console.log(`[dsrm-panel] Mode: ${IS_PILOT ? 'PILOT' : 'PANEL'}, aliases: ${aliases.join(', ')}, runs: ${RUNS_PER_CELL}`);

    // Layer-1 token metric test
    it(
      'token-metric: compare system prompt sizes (Layer-1)',
      () => {
        const lines: string[] = [];
        lines.push('[dsrm-panel] === TOKEN METRIC (Layer-1 context check) ===');
        lines.push('[dsrm-panel] v_baseline = buildWorkerInstructions + decisionSummary');
        lines.push('[dsrm-panel] v_proposed = buildWorkerInstructions only');
        let allPass = true;
        for (const c of ALL_CASES) {
          const baseline = buildBaselineSystemPrompt(c.userPromptForRouting);
          const proposed = buildProposedSystemPrompt(c.userPromptForRouting);
          const delta = proposed.length - baseline.length;
          const gatePass = delta <= 0;
          if (!gatePass) allPass = false;
          lines.push(
            `  ${c.id.padEnd(35)} baseline=${baseline.length.toString().padStart(6)} chars  proposed=${proposed.length.toString().padStart(6)} chars  delta=${delta > 0 ? '+' : ''}${delta}  token-gate:${gatePass ? 'PASS' : 'FAIL'}`,
          );
        }
        lines.push(`  Overall token gate: ${allPass ? 'ALL PASS' : 'SOME FAIL'}`);
        // eslint-disable-next-line no-console
        console.log(lines.join('\n'));
      },
    );

    for (const c of ALL_CASES) {
      it(
        `${c.id} — ${aliases.join('+')} × 2 variants × ${RUNS_PER_CELL} run${RUNS_PER_CELL > 1 ? 's' : ''}`,
        { timeout: 20 * 60_000 },
        async () => {
          const baselineSysPrompt = buildBaselineSystemPrompt(c.userPromptForRouting);
          const proposedSysPrompt = buildProposedSystemPrompt(c.userPromptForRouting);

          const variants = [
            {
              id: 'v_baseline',
              description: 'buildWorkerInstructions + decisionSummary (production, ADR-033 anti-pattern)',
              systemPrompt: baselineSysPrompt,
              priorMessages: c.priorMessages,
              userMessage: c.userMessage,
              tools: PRODUCTION_TOOLS,
            },
            {
              id: 'v_proposed',
              description: 'buildWorkerInstructions only (no decisionSummary — ADR-033 hygiene)',
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

          const lines: string[] = [];
          lines.push(`[dsrm-panel][${c.id}]`);
          lines.push(`  desc: ${c.description}`);
          lines.push('  variant       alias          passRate  runs(P/T)');

          for (const cell of result.cells) {
            const passed = cell.runsRaw.filter((r) => r.passed).length;
            lines.push(
              `  ${cell.variantId.padEnd(13)} ${cell.alias.padEnd(15)} ${cell.passRate.toFixed(0).padStart(3)}%      ${passed}/${RUNS_PER_CELL}`,
            );
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

          const baselineCells = result.byVariant['v_baseline'] ?? [];
          const proposedCells = result.byVariant['v_proposed'] ?? [];

          lines.push('  --- GATE CHECK per alias (≤8pp regression = MET) ---');
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
            } else {
              const gateMet = delta >= -8;
              lines.push(`    ${alias}: baseline=${bCell.passRate.toFixed(0)}% proposed=${pCell.passRate.toFixed(0)}% delta=${deltaStr} gate=${gateMet ? 'MET' : 'FAIL'}`);
            }
          }

          // eslint-disable-next-line no-console
          console.log(lines.join('\n'));

          // Dump
          mkdirSync(DUMP_ROOT, { recursive: true });
          const dumpPath = join(DUMP_ROOT, `${c.id}${IS_PILOT ? '_pilot' : ''}.json`);
          const dump = {
            case: c.id,
            stage: IS_PILOT ? 'decision-summary-removal-pilot' : 'decision-summary-removal-panel',
            startedAt: result.startedAt,
            description: c.description,
            userMessage: c.userMessage,
            aliases,
            isPilot: IS_PILOT,
            tokenMetric: {
              baselineChars: baselineSysPrompt.length,
              proposedChars: proposedSysPrompt.length,
              delta: proposedSysPrompt.length - baselineSysPrompt.length,
              tokenGatePass: proposedSysPrompt.length <= baselineSysPrompt.length,
            },
            variants: variants.map((v) => ({
              id: v.id,
              description: v.description,
              systemPromptChars: v.systemPrompt.length,
              systemPromptPreview: v.systemPrompt.slice(-500), // last 500 chars to see decisionSummary presence
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
              const isC5gate = c.id === 'C5_multi_module_dispatch';
              return {
                alias,
                baselinePassRate: bCell?.passRate ?? null,
                proposedPassRate: pCell?.passRate ?? null,
                deltaPercent: delta,
                gateMet: isC5gate ? null : (delta !== null ? delta >= -8 : null),
                c5FloorTolerated: isC5gate ? true : null,
              };
            }),
          };
          writeFileSync(dumpPath, JSON.stringify(dump, null, 2), 'utf-8');
          // eslint-disable-next-line no-console
          console.log(`  [dump] ${dumpPath}`);
        },
      );
    }
  },
);
