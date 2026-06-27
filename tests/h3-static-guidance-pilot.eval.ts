/**
 * Pilot eval — H3 harness refactor: "route-injected overlay" → "static EXECUTION GUIDANCE".
 *
 * Layer 1 justification for needing Layer 2:
 *   The behavioral question is whether removing buildPromptOverlay() from the
 *   Worker system prompt and replacing it with a static EXECUTION GUIDANCE block
 *   causes the LLM to regress on key dispatch / plan-first / review-focus
 *   behaviors. This is an LLM-reasoning question, not a static-code question —
 *   cannot be answered by reading source alone.
 *
 * Design: Layer 2 single-turn probe. 1 alias (ark/v4flash) × 5 cases × 1 run.
 *
 * Pre-registered pilot gate (EVAL_GUIDELINES anti-pattern 6):
 *   SHIP if: v_proposed shows no clear regression vs v_baseline across C1-C5.
 *   Definition of "clear regression": proposed FAILS on a case where baseline PASSES.
 *   Floor tolerated: both fail → saturation floor per EVAL_GUIDELINES anti-pattern 11.
 *
 * Layer-1 token metric: Compare system prompt character counts for the two variants
 * (printed to console). v_proposed should be shorter (overlay removed).
 *
 * Run:
 *   KODAX_EVAL_DUMP_DIR=c:/tmp/ npm run test:eval -- h3-static-guidance-pilot
 *
 * Cost estimate: 5 cases × 2 variants × 1 run × 1 alias = 10 LLM calls ≈ $0.05-0.20.
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
  'h3-static-guidance-pilot',
);

// ---------------------------------------------------------------------------
// Static EXECUTION GUIDANCE (H3 proposed — verbatim from spec)
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
//
// We use the harness `tools` parameter to pass production KodaXToolDefinition
// bytes for the tools relevant to H3 behavioral dimensions.
// The tools below are the ones judged in the cases; we include a reasonable
// set to cover the full behavioral surface without inflating token cost.
//
// Note: getToolDefinition() accesses the static BUILTIN_TOOL_DEFINITIONS
// map. It does NOT require a running server — safe to call at module level.
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

// Collect available production tool definitions; log any missing ones.
const PRODUCTION_TOOLS = RELEVANT_TOOL_NAMES.map((name) => {
  const def = getToolDefinition(name);
  if (!def) {
    // eslint-disable-next-line no-console
    console.warn(`[h3-pilot] WARNING: tool '${name}' not found in registry — pilot will run without it`);
  }
  return def;
}).filter((t): t is NonNullable<typeof t> => t !== undefined);

// ---------------------------------------------------------------------------
// Variant builder helpers
// ---------------------------------------------------------------------------

/**
 * Build the v_baseline system prompt for a given user prompt string.
 * This replicates what production does:
 *   buildWorkerInstructions(decision, undefined, false) + '\n\n' + buildPromptOverlay(decision)
 *
 * The decision is derived from the user prompt via the same heuristic path
 * that production uses (buildFallbackRoutingDecision with a minimal
 * providerPolicy stub).
 */
function buildBaselineSystemPrompt(userPrompt: string): string {
  // Minimal provider policy stub: use ark-coding profile (our pilot alias).
  // This matches what production does when it calls evaluateProviderPolicy
  // with an ark-coding provider. We pass just providerName to avoid needing
  // a live provider instance — evaluateProviderPolicy accepts optional fields.
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
 * Same as baseline EXCEPT: no buildPromptOverlay() appended.
 * Instead, append the static EXECUTION GUIDANCE block.
 *
 * roleAck is kept inside buildWorkerInstructions (not removed in pilot —
 * per spec note: "pilot phase — as 'add static block + remove overlay' main contrast").
 */
function buildProposedSystemPrompt(userPrompt: string): string {
  const providerPolicy = evaluateProviderPolicy({
    providerName: 'ark-coding',
    model: 'deepseek-v4-flash',
  });
  const decision = buildFallbackRoutingDecision(userPrompt, providerPolicy);
  const workerInstructions = buildWorkerInstructions(decision, undefined, false);
  // No overlay — replace with static EXECUTION GUIDANCE
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
  // Check harness-captured tool calls first (most reliable)
  if (context?.toolCalls.some((t) => t.name === toolName)) return true;
  // Fall back to regex multi-syntax
  return buildToolNamePatterns(toolName).some((p) => p.test(text));
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

interface PilotCase {
  readonly id: string;
  readonly description: string;
  readonly userPromptForRouting: string;  // used to build the routing decision
  readonly priorMessages?: readonly { role: 'user' | 'assistant'; content: string }[];
  readonly userMessage: string;
}

// C1: trivial lookup — should answer/grep directly, NOT todo_create
const C1: PilotCase = {
  id: 'C1_simple_no_ceremony',
  description: 'trivial lookup — should grep/answer directly, NOT call todo_create or dispatch',
  userPromptForRouting: '项目里 MANAGED_WORK_BUDGET_CAP 这个常量定义在哪个文件?',
  userMessage: '项目里 `MANAGED_WORK_BUDGET_CAP` 这个常量定义在哪个文件?',
};

// C2: complex multi-file refactor — should plan-first with todo_create
const C2: PilotCase = {
  id: 'C2_complex_plan_first',
  description: 'complex refactor — should emit todo_create plan-first',
  userPromptForRouting: '把 packages/auth 的 session 校验逻辑重构,拆分到 validator/store/types 三个文件,并为每个加单测。',
  userMessage: '把 packages/auth 的 session 校验逻辑重构,拆分到 validator/store/types 三个文件,并为每个加单测。',
};

// C3: code review with canned diff — should report high-signal issues only, not nits
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

const C3: PilotCase = {
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
const C4: PilotCase = {
  id: 'C4_investigation_root_cause',
  description: 'bug investigation — should ask for repro / do targeted check before broad changes',
  userPromptForRouting: '用户报告 task_output 偶尔返回 wait_expired 后任务就卡住',
  userMessage: '用户报告 task_output 偶尔返回 wait_expired 后任务就卡住了，帮我调查一下这个 bug 的根因。',
};

// C5: parallel investigation across 3 packages — should dispatch_child_task fan-out
const C5: PilotCase = {
  id: 'C5_multi_module_dispatch',
  description: 'parallel investigation — should dispatch_child_task fan-out across packages',
  userPromptForRouting: '并行调查 llm、coding、agent 三个包各自的 reasoning 处理是否一致，分别给我结论。',
  userMessage: '并行调查 llm、coding、agent 三个包各自的 reasoning 处理是否一致，分别给我结论。',
};

const ALL_CASES: readonly PilotCase[] = [C1, C2, C3, C4, C5] as const;

// ---------------------------------------------------------------------------
// Judges
// ---------------------------------------------------------------------------

// C1: negative judge — should NOT call todo_create or dispatch; positive — should grep/answer
function judgeC1NoCeremony(text: string, context?: JudgeContext): JudgeResult {
  // Binding check is more reliable than regex for negative
  const toolCalls = context?.toolCalls ?? [];
  const forbiddenCalled = toolCalls.some(
    (t) => t.name === 'todo_create' || t.name === 'dispatch_child_task',
  );
  if (forbiddenCalled) {
    const names = toolCalls.map((t) => t.name).join(',');
    return { passed: false, reason: `forbidden tool called (binding): ${names}` };
  }
  // Regex fallback for forbidden tools
  if (invokesTool(text, 'todo_create')) {
    return { passed: false, reason: 'todo_create invoked (regex) on trivial lookup' };
  }
  if (invokesTool(text, 'dispatch_child_task')) {
    return { passed: false, reason: 'dispatch_child_task invoked (regex) on trivial lookup' };
  }
  // Positive signal: grep/read or direct answer with file reference
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

// C3: negative judge — should NOT lead with naming/style nits as must-fix
// Positive: reports a substantive issue (bcrypt async bug, security concern, etc.)
function judgeC3ReviewHighSignal(text: string): JudgeResult {
  const lower = text.toLowerCase();
  // Detect if the response leads with nit-level concerns as primary issues
  const nitKeywords = ['naming', 'style', 'formatting', 'camelCase', 'snake_case', 'indent', 'whitespace'];
  // A review that mentions bcrypt/async/security is high signal
  const highSignalKeywords = ['bcrypt', 'async', 'await', 'security', 'vulnerability', 'bug', 'unsafe', 'synchronous', 'blocking', 'compareSync'];
  const hasHighSignal = highSignalKeywords.some((k) => lower.includes(k));
  // NOTE: negative (nit-first) detection — per anti-pattern 7, we avoid pure regex
  // negation. Instead we check: if ONLY nit keywords appear and zero high-signal → flag.
  const hasNitOnly = nitKeywords.some((k) => lower.includes(k)) && !hasHighSignal;
  if (hasNitOnly) {
    return { passed: false, reason: 'review mentions only style/naming nits, no substantive issues' };
  }
  if (!hasHighSignal) {
    // No clear high-signal keyword — may still be reasonable; leave raw text for manual inspection
    return {
      passed: false,
      reason: `no high-signal keyword found (bcrypt/async/security); raw text first 300 chars: "${text.slice(0, 300)}"`,
    };
  }
  return { passed: true };
}

// C4: positive judge — should grep/read/investigate, not immediately write/edit
function judgeC4InvestigateFirst(text: string, context?: JudgeContext): JudgeResult {
  const toolCalls = context?.toolCalls ?? [];
  // Bad: immediately writes or edits without investigation
  const immediateMutate = toolCalls.some((t) => t.name === 'write' || t.name === 'edit');
  if (immediateMutate) {
    return { passed: false, reason: 'immediately called write/edit before investigation' };
  }
  // Good: grep/read/bash investigation OR asks for repro / mentions root cause
  const investigationTools = toolCalls.some(
    (t) => t.name === 'grep' || t.name === 'read' || t.name === 'bash',
  );
  const investigationKeywords = ['root cause', 'reproduce', 'repro', '根因', '复现', '定位', 'investigate', 'check', 'look at', '查看', '分析', 'timeout', 'wait_expired', 'task_output'];
  const lower = text.toLowerCase();
  const hasInvestigationText = investigationKeywords.some((k) => lower.includes(k.toLowerCase()));
  if (investigationTools || hasInvestigationText) {
    return { passed: true };
  }
  return { passed: false, reason: `no investigation signal (tools or text); text[:200]="${text.slice(0, 200)}"` };
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
// Pilot config
// ---------------------------------------------------------------------------

const PILOT_ALIAS_PREFERENCE: readonly ModelAlias[] = [
  'ark/v4flash',   // floor alias per EVAL_GUIDELINES canonical panel
  'ds/v4flash',    // fallback if ark not available
  'mimo/v25',      // secondary fallback
] as const;

const RUNS_PER_CELL = 1; // pilot = 1 run

const ALIAS_FALLBACK: Partial<Record<ModelAlias, ModelAlias>> = {
  'ark/v4pro': 'ds/v4pro',
  'ark/v4flash': 'ds/v4flash',
};

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

describe('H3 static guidance pilot — 1 alias × 5 cases × 2 variants × 1 run', () => {
  const aliases = availableAliases(...PILOT_ALIAS_PREFERENCE).slice(0, 1);

  if (aliases.length === 0) {
    it('skips: no pilot alias key in env', () => { /* no-op */ });
    return;
  }

  const chosenAlias = aliases[0]!;

  // Print token metric first (Layer-1 context-regression check)
  it(
    'token-metric: compare system prompt sizes (Layer-1)',
    () => {
      const lines: string[] = [];
      lines.push('[h3-pilot] === TOKEN METRIC (Layer-1 context check) ===');
      for (const c of ALL_CASES) {
        const baseline = buildBaselineSystemPrompt(c.userPromptForRouting);
        const proposed = buildProposedSystemPrompt(c.userPromptForRouting);
        const delta = proposed.length - baseline.length;
        lines.push(
          `  ${c.id.padEnd(35)} baseline=${baseline.length.toString().padStart(6)} chars  proposed=${proposed.length.toString().padStart(6)} chars  delta=${delta > 0 ? '+' : ''}${delta}`,
        );
      }
      // eslint-disable-next-line no-console
      console.log(lines.join('\n'));
    },
  );

  for (const c of ALL_CASES) {
    it(
      `${c.id} — ${chosenAlias} × 2 variants × 1 run`,
      { timeout: 10 * 60_000 },
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

        // Console summary
        const lines: string[] = [];
        lines.push(`[h3-pilot][${c.id}] alias=${chosenAlias}`);
        lines.push(`  desc: ${c.description}`);
        for (const v of variants) {
          const cells = result.byVariant[v.id] ?? [];
          for (const cell of cells) {
            const run = cell.runsRaw[0];
            if (!run) continue;
            const judgeResults = run.judges.map((j) => `${j.name}=${j.passed ? 'PASS' : 'FAIL'}`).join(' ');
            const textPreview = run.text.slice(0, 200).replace(/\n/g, ' ');
            const toolList = run.toolCalls.map((t) => t.name).join(',') || '(none)';
            lines.push(`  --- ${v.id} ---`);
            lines.push(`    tools: ${toolList}`);
            lines.push(`    text[:200]: ${textPreview}`);
            lines.push(`    judges: ${judgeResults}`);
            if (run.error) lines.push(`    ERROR: ${run.error}`);
          }
        }
        // eslint-disable-next-line no-console
        console.log(lines.join('\n'));

        // Dump
        mkdirSync(DUMP_ROOT, { recursive: true });
        const dumpPath = join(DUMP_ROOT, `${c.id}.json`);
        const dump = {
          case: c.id,
          stage: 'h3-static-guidance-pilot',
          startedAt: result.startedAt,
          description: c.description,
          userMessage: c.userMessage,
          tokenMetric: {
            baselineChars: baselineSysPrompt.length,
            proposedChars: proposedSysPrompt.length,
            delta: proposedSysPrompt.length - baselineSysPrompt.length,
          },
          variants: variants.map((v) => ({
            id: v.id,
            description: v.description,
            systemPromptChars: v.systemPrompt.length,
            systemPromptPreview: v.systemPrompt.slice(0, 500),
          })),
          aliases: result.cells.map((cell) => ({
            alias: cell.alias,
            variantId: cell.variantId,
            passRate: cell.passRate,
            runs: cell.runsRaw.map((run) => ({
              runIndex: run.runIndex,
              text: run.text,
              toolCalls: run.toolCalls.map((t) => ({ name: t.name, inputPreview: JSON.stringify(t.input).slice(0, 200) })),
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
        };
        writeFileSync(dumpPath, JSON.stringify(dump, null, 2), 'utf-8');
        // eslint-disable-next-line no-console
        console.log(`  [dump] ${dumpPath}`);
      },
    );
  }
});
