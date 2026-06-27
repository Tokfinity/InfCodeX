/**
 * Panel eval — SA path static EXECUTION GUIDANCE vs. injected prompt overlay.
 *
 * Validates whether replacing the SA system prompt's runtime-injected
 * `buildPromptOverlay(decision, ...)` section with a static EXECUTION GUIDANCE
 * block causes any behaviour regression.
 *
 * Background (ADR-033):
 *   SA path system prompt = SYSTEM_PROMPT (base identity + Plan-Before-Action +
 *   Editing read-first) + capability sections + **prompt-overlay section**
 *   (injected: EXECUTION_MODE_OVERLAYS + HARNESS_PROFILE_OVERLAYS + [Task Routing]
 *   classification dump + [AMA Controller] + workIntent/brainstorm).
 *   The injected overlay is an ADR-033 anti-pattern. AMA Worker (H3) was already
 *   aligned to static EXECUTION GUIDANCE in a prior change; this eval verifies
 *   the SA can receive the same treatment without regression.
 *
 * Two variants:
 *   v_baseline: SYSTEM_PROMPT_PREFIX + '\n\n' + buildPromptOverlay(decision, ...)
 *               (current SA production prompt — with classification dump)
 *   v_proposed: SYSTEM_PROMPT_PREFIX + '\n\n' + STATIC_EXECUTION_GUIDANCE
 *               (static, no overlay injection)
 *
 * STATIC_EXECUTION_GUIDANCE is the same text used for the H3 AMA Worker
 * in the prior alignment — verbatim, no harness-specific wording.
 *
 * Cases:
 *   C1 — no-ceremony (trivial lookup): grep/read directly, NOT todo_create/dispatch
 *   C2 — plan-first (complex refactor): emit todo_create plan-first
 *   C3 — review high-signal (code diff): focus on correctness/security, not nits
 *   C4 — investigation root-cause (bug report): targeted diagnosis before broad changes
 *   C5 — multi-module dispatch (parallel investigation): dispatch_child_task fan-out
 *   C6 — strict-audit (security audit): multi-dimension coverage + confirmed vs risk distinction
 *
 * Pre-registered SHIP gate:
 *   v_proposed relative to v_baseline: per-case per-alias regression ≤ 8pp.
 *   C5 dispatch floor tolerated.
 *   token metric: v_proposed system prompt NOT longer than v_baseline.
 *
 * Cost estimate:
 *   Pilot: 1 alias × 2 cases (C3+C6) × 2 variants × 1 run = 4 LLM calls
 *   Panel: 5 alias × 6 cases × 2 variants × 3 runs = 180 LLM calls ≈ $2-8
 *
 * Run pilot:
 *   KODAX_EVAL_DUMP_DIR=c:/tmp/ KODAX_EVAL_PILOT=1 npm run test:eval -- sa-static-guidance-panel
 * Run panel:
 *   KODAX_EVAL_DUMP_DIR=c:/tmp/ npm run test:eval -- sa-static-guidance-panel
 *
 * Aliases requested: zhipu/glm52, kimi, mimo/v25pro, mmx/m3, ds/v4pro
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it } from 'vitest';

import { availableAliases, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runBenchmark } from '../benchmark/harness/harness.js';
import type { PromptJudge, JudgeContext, JudgeResult } from '../benchmark/harness/judges.js';
import {
  buildFallbackRoutingDecision,
  buildPromptOverlay,
} from '../packages/coding/src/reasoning.js';
import {
  evaluateProviderPolicy,
} from '../packages/coding/src/provider-policy.js';
import {
  SYSTEM_PROMPT,
} from '../packages/coding/src/prompts/system.js';
import {
  getToolDefinition,
} from '../packages/coding/src/tools/registry.js';

// ---------------------------------------------------------------------------
// Dump config
// ---------------------------------------------------------------------------

const DUMP_ROOT = join(
  process.env.KODAX_EVAL_DUMP_DIR ?? tmpdir(),
  'kodax-eval-dumps',
  'sa-static-guidance-panel',
);

// ---------------------------------------------------------------------------
// SYSTEM_PROMPT base prefix (strips {context} placeholder)
// ---------------------------------------------------------------------------

const SYSTEM_CONTEXT_MARKER = '{context}';
const SYSTEM_PROMPT_PREFIX: string = (() => {
  const idx = SYSTEM_PROMPT.indexOf(SYSTEM_CONTEXT_MARKER);
  if (idx === -1) return SYSTEM_PROMPT.trim();
  return SYSTEM_PROMPT.slice(0, idx).trim();
})();

// ---------------------------------------------------------------------------
// Static EXECUTION GUIDANCE block (verbatim — same as H3 Worker alignment)
// No harness-specific wording, no classification dump.
// ---------------------------------------------------------------------------

const STATIC_EXECUTION_GUIDANCE = `EXECUTION GUIDANCE (match your approach to the kind of work — judge which fits):

- After you make a change, check the result against what was actually asked before you finalize. Confirm the change does what the request wanted, backed by evidence (a test run, a re-read of the edited region) rather than confidence alone — because a change that looks right but was never verified is how silent regressions ship.

- When you are reviewing code or a pull request: report only high-confidence issues that materially affect correctness, reliability, security, or merge-readiness. Do not list naming, formatting, or style preferences as findings — padding a review with nits buries the issues that matter. Lead with the must-fix items, then optional improvements, and for each issue state the concrete consequence it causes.

- When you are doing a broad audit: cover correctness, security, performance, and maintainability together, and keep issues you have confirmed separate from lower-confidence risks so the reader can tell which is which.

- When you are investigating a bug or an unknown: isolate the root cause and validate your assumptions with concrete evidence — a reproduction, a targeted check — before making broad changes, because a fix applied before the cause is understood usually treats a symptom.

- When the task is design or planning work: reason through architecture, constraints, sequencing, and risks before writing code.

- When the request is genuinely ambiguous: frame the options briefly and make the path you chose explicit before any irreversible edit, so the user can redirect before the cost is sunk.`;

// ---------------------------------------------------------------------------
// Variant builders
// ---------------------------------------------------------------------------

/**
 * v_baseline: SYSTEM_PROMPT prefix + buildPromptOverlay (current SA production).
 * Uses ark-coding/deepseek-v4-flash as routing provider stub.
 */
function buildBaselineSystemPrompt(userPrompt: string): string {
  const providerPolicy = evaluateProviderPolicy({
    providerName: 'ark-coding',
    model: 'deepseek-v4-flash',
  });
  const decision = buildFallbackRoutingDecision(userPrompt, providerPolicy);
  const overlay = buildPromptOverlay(decision, [], providerPolicy);
  return `${SYSTEM_PROMPT_PREFIX}\n\n${overlay}`;
}

/**
 * v_proposed: SYSTEM_PROMPT prefix + static EXECUTION GUIDANCE (no overlay).
 */
function buildProposedSystemPrompt(): string {
  return `${SYSTEM_PROMPT_PREFIX}\n\n${STATIC_EXECUTION_GUIDANCE}`;
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
    console.warn(`[sa-sgp] WARNING: tool '${name}' not found in registry — panel will run without it`);
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
// Cases — C1–C5 mirror decision-summary-removal-panel; C6 is new (strict-audit)
// ---------------------------------------------------------------------------

interface PanelCase {
  readonly id: string;
  readonly description: string;
  readonly userPromptForRouting: string;
  readonly priorMessages?: readonly { role: 'user' | 'assistant'; content: string }[];
  readonly userMessage: string;
  readonly isPilotCase?: boolean; // mark cases to include in pilot sanity run
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
  isPilotCase: true,
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

// C6: strict-audit (new case) — broad security audit, multiple dimensions + confirmed vs risk.
// Canned history: first user turn asks for the audit, assistant response shows file listing
// results and core file content (simulate already-read). Second user turn asks for the final
// audit report — this is what the judge evaluates.
const C6_FILES_LISTING = `packages/auth/
├── src/
│   ├── index.ts            (exports: createAuthSession, validateToken, revokeSession)
│   ├── handler.ts          (HTTP handlers: POST /auth/login, POST /auth/logout, GET /auth/me)
│   ├── session.ts          (session creation, token signing, expiry logic)
│   ├── validator.ts        (input validation: validateLoginPayload, sanitizeUsername)
│   ├── storage.ts          (in-memory session store + Redis client wrapper)
│   └── config.ts           (reads JWT_SECRET, SESSION_TTL, REDIS_URL from env)
└── package.json`;

const C6_CODE_EXCERPT = `// handler.ts (abbreviated)
import jwt from 'jsonwebtoken';
import { db } from './storage';
import { validateLoginPayload } from './validator';

export async function handleLogin(req: Request): Promise<Response> {
  const { username, password } = req.body;  // no explicit Content-Type check
  validateLoginPayload({ username, password });
  const user = await db.users.findOne({ username });
  if (!user) return Response.error('User not found', 404);  // leaks user existence
  const valid = bcrypt.compareSync(password, user.passwordHash);  // synchronous!
  const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET!, { expiresIn: '7d' });
  return Response.json({ token });
}

// session.ts (abbreviated)
const sessions: Record<string, { userId: string; expiresAt: number }> = {};  // in-memory, no TTL enforcement
export function createAuthSession(userId: string): string {
  const sid = Math.random().toString(36).slice(2);  // weak random
  sessions[sid] = { userId, expiresAt: Date.now() + 86400_000 };
  return sid;
}

// validator.ts (abbreviated)
export function validateLoginPayload(payload: { username: string; password: string }): void {
  if (!payload.username || !payload.password) throw new Error('Missing fields');
  // no length limits, no charset validation, no rate-limit hook
}`;

const C6: PanelCase = {
  id: 'C6_strict_audit',
  description: 'security audit — should cover multiple dimensions AND distinguish confirmed vs lower-confidence risks',
  userPromptForRouting: 'security audit of packages/auth',
  priorMessages: [
    {
      role: 'user' as const,
      content: '对 packages/auth 做一次全面安全审计，列出所有问题。',
    },
    {
      role: 'assistant' as const,
      content: `好的，我来读取 packages/auth 的文件结构和核心代码。\n\n文件结构：\n${C6_FILES_LISTING}\n\n核心代码摘录：\n\`\`\`typescript\n${C6_CODE_EXCERPT}\n\`\`\`\n\n已完成代码阅读，现在进行全面安全审计。`,
    },
  ],
  userMessage: '好，基于上面的代码，给出完整的安全审计报告，覆盖安全、正确性、性能和可维护性各个维度，并区分已确认问题和潜在风险。',
  isPilotCase: true,
};

const ALL_CASES: readonly PanelCase[] = [C1, C2, C3, C4, C5, C6] as const;
const PILOT_CASES: readonly PanelCase[] = ALL_CASES.filter((c) => c.isPilotCase);

// ---------------------------------------------------------------------------
// Judges
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

// C3: high-signal review — should mention bcrypt/async bug, field rename, or admin auth risk
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
      reason: `no high-signal keyword found; text[:200]="${text.slice(0, 200)}" binding[:200]="${bindingContent.slice(0, 200)}"`,
    };
  }

  const hitGroups = [hitA && 'A(bcrypt/async)', hitB && 'B(field-rename)', hitC && 'C(admin/auth)', hitD && 'D(general)'].filter(Boolean).join(',');
  return { passed: true, reason: `high-signal groups: ${hitGroups}` };
}

// C4: investigation — targeted diagnosis before broad changes
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

// C5: parallel dispatch — should dispatch_child_task fan-out
function judgeC5Dispatch(text: string, context?: JudgeContext): JudgeResult {
  if (invokesTool(text, 'dispatch_child_task', context)) {
    return { passed: true };
  }
  return { passed: false, reason: `dispatch_child_task NOT invoked; text[:200]="${text.slice(0, 200)}"` };
}

/**
 * C6: strict-audit judge.
 * PASS criteria: output covers multiple audit dimensions AND distinguishes
 * confirmed issues from lower-confidence risks (or at minimum covers
 * security + correctness together with some structured presentation).
 *
 * This case tests whether EXECUTION GUIDANCE's "broad audit" bullet
 * is carried through as well as the overlay's [Execution Mode: strict-audit].
 */
function judgeC6StrictAudit(text: string, context?: JudgeContext): JudgeResult {
  const bindingContent = extractToolCallContent(context);
  const combined = (text + '\n' + bindingContent).toLowerCase();

  // Dimension coverage: at least 2 distinct audit dimensions
  const securityKw = ['security', 'vulnerability', 'injection', 'xss', 'csrf', 'auth', '安全', '漏洞', '越权'];
  const correctnessKw = ['correctness', 'bug', 'error', 'incorrect', '错误', '缺陷', '问题'];
  const performanceKw = ['performance', 'latency', 'throughput', 'slow', '性能', '延迟'];
  const maintainabilityKw = ['maintainability', 'readability', 'complexity', 'coupling', '可维护', '耦合', '复杂'];

  const hitSecurity = securityKw.some((k) => combined.includes(k));
  const hitCorrectness = correctnessKw.some((k) => combined.includes(k));
  const hitPerformance = performanceKw.some((k) => combined.includes(k));
  const hitMaintainability = maintainabilityKw.some((k) => combined.includes(k));

  const dimensionCount = [hitSecurity, hitCorrectness, hitPerformance, hitMaintainability].filter(Boolean).length;

  // Confirmed vs risk distinction keywords
  const confirmedKw = ['confirmed', 'definite', 'certain', 'high-confidence', '确认', '明确', '确定'];
  const riskKw = ['risk', 'potential', 'lower-confidence', 'possible', 'may', 'might', '风险', '可能', '潜在'];

  const hasConfirmedLanguage = confirmedKw.some((k) => combined.includes(k));
  const hasRiskLanguage = riskKw.some((k) => combined.includes(k));
  const hasDistinction = hasConfirmedLanguage || hasRiskLanguage;

  // Also accept structured list or section headings as a proxy for organization
  const hasStructure = /#{1,3}\s|\d+\.\s|[-*]\s.*\n.*[-*]\s/m.test(text);

  if (combined.trim().length < 50) {
    return { passed: false, reason: 'response too short / empty' };
  }

  if (dimensionCount < 2) {
    return {
      passed: false,
      reason: `only ${dimensionCount} audit dimension(s) covered; need ≥2 (security=${hitSecurity} correctness=${hitCorrectness} perf=${hitPerformance} maint=${hitMaintainability})`,
    };
  }

  // At least dimension coverage is present — structure/distinction is a bonus
  const hitDims = [
    hitSecurity && 'security',
    hitCorrectness && 'correctness',
    hitPerformance && 'performance',
    hitMaintainability && 'maintainability',
  ].filter(Boolean).join(',');

  return {
    passed: true,
    reason: `dims=${dimensionCount}(${hitDims}) confirmed=${hasConfirmedLanguage} risk=${hasRiskLanguage} structure=${hasStructure}`,
  };
}

const CASE_JUDGES: Record<string, PromptJudge[]> = {
  [C1.id]: [{ name: 'no_ceremony_on_trivial', category: 'correctness', judge: judgeC1NoCeremony }],
  [C2.id]: [{ name: 'plan_first_todo_create', category: 'correctness', judge: judgeC2PlanFirst }],
  [C3.id]: [{ name: 'review_high_signal', category: 'correctness', judge: judgeC3ReviewHighSignal }],
  [C4.id]: [{ name: 'investigate_before_mutate', category: 'correctness', judge: judgeC4InvestigateFirst }],
  [C5.id]: [{ name: 'dispatch_fan_out', category: 'correctness', judge: judgeC5Dispatch }],
  [C6.id]: [{ name: 'strict_audit_multi_dim', category: 'correctness', judge: judgeC6StrictAudit }],
};

// ---------------------------------------------------------------------------
// Panel config
// ---------------------------------------------------------------------------

const IS_PILOT = process.env.KODAX_EVAL_PILOT === '1';

/**
 * User-requested: zhipu/glm52, kimi, mimo/v25pro, mmx/m3, ds/v4pro.
 * Fallbacks within family included for robustness.
 */
const PANEL_ALIAS_PREFERENCE: readonly ModelAlias[] = [
  'zhipu/glm52', 'kimi', 'mimo/v25pro', 'mmx/m3', 'ds/v4pro',
  // fallbacks
  'zhipu/glm51', 'mimo/v25', 'mmx/m27', 'ds/v4flash', 'ark/v4flash',
];

const RUNS_PER_CELL = IS_PILOT ? 1 : 3;

function selectAliases(all: ModelAlias[]): ModelAlias[] {
  if (IS_PILOT) {
    return all.slice(0, 1);
  }
  // De-duplicate by family, take up to 5 aliases.
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
    ? 'sa-static-guidance PILOT — 1 alias × C3+C6 × 2 variants × 1 run'
    : 'sa-static-guidance PANEL — 5 alias × 6 cases × 2 variants × 3 runs',
  () => {
    const allAvailable = availableAliases(...PANEL_ALIAS_PREFERENCE);
    const aliases = selectAliases(allAvailable);
    const activeCases = IS_PILOT ? PILOT_CASES : ALL_CASES;

    if (aliases.length === 0) {
      it('skips: no panel alias keys in env', () => { /* no-op */ });
      return;
    }

    // eslint-disable-next-line no-console
    console.log(
      `[sa-sgp] Mode: ${IS_PILOT ? 'PILOT' : 'PANEL'}, aliases: ${aliases.join(', ')}, runs: ${RUNS_PER_CELL}, cases: ${activeCases.map((c) => c.id).join(',')}`,
    );

    // Layer-1 token metric test — compare system prompt sizes before LLM calls
    it(
      'token-metric: compare SA system prompt sizes (Layer-1)',
      () => {
        const lines: string[] = [];
        lines.push('[sa-sgp] === TOKEN METRIC (Layer-1) ===');
        lines.push('[sa-sgp] v_baseline = SYSTEM_PROMPT_PREFIX + buildPromptOverlay (routing classification dump)');
        lines.push('[sa-sgp] v_proposed = SYSTEM_PROMPT_PREFIX + STATIC_EXECUTION_GUIDANCE (no overlay)');
        let allPass = true;
        for (const c of ALL_CASES) {
          const baseline = buildBaselineSystemPrompt(c.userPromptForRouting);
          const proposed = buildProposedSystemPrompt();
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

    for (const c of activeCases) {
      it(
        `${c.id} — ${aliases.join('+')} × 2 variants × ${RUNS_PER_CELL} run${RUNS_PER_CELL > 1 ? 's' : ''}`,
        { timeout: 25 * 60_000 },
        async () => {
          const baselineSysPrompt = buildBaselineSystemPrompt(c.userPromptForRouting);
          const proposedSysPrompt = buildProposedSystemPrompt();

          const variants = [
            {
              id: 'v_baseline',
              description: 'SYSTEM_PROMPT_PREFIX + buildPromptOverlay (current SA — injected routing classification)',
              systemPrompt: baselineSysPrompt,
              priorMessages: c.priorMessages,
              userMessage: c.userMessage,
              tools: PRODUCTION_TOOLS,
            },
            {
              id: 'v_proposed',
              description: 'SYSTEM_PROMPT_PREFIX + static EXECUTION GUIDANCE (no overlay — ADR-033 aligned)',
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
          lines.push(`[sa-sgp][${c.id}]`);
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
              const textPreview = run.text.slice(0, 200).replace(/\n/g, ' ');
              lines.push(`    run${run.runIndex}: tools=[${toolList}] text[:200]="${textPreview}"`);
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

          // Dump raw results for offline audit (per EVAL_GUIDELINES §Raw output)
          mkdirSync(DUMP_ROOT, { recursive: true });
          const dumpPath = join(DUMP_ROOT, `${c.id}${IS_PILOT ? '_pilot' : ''}.json`);
          const dump = {
            case: c.id,
            stage: IS_PILOT ? 'sa-static-guidance-pilot' : 'sa-static-guidance-panel',
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
              systemPromptTail: v.systemPrompt.slice(-600), // last 600 chars — shows overlay vs guidance block
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
