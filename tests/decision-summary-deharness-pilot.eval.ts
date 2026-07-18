/**
 * Pilot eval — deharness-only variant of decisionSummary.
 *
 * Background:
 *   The previous whole-block removal eval (decision-summary-removal-panel.eval.ts)
 *   showed ds/v4pro regressed on C3 (review) because Assurance intent / Risk
 *   fields help floor models target review focus. This pilot tests a
 *   smaller surgical removal: only `Harness:` (always H0_DIRECT constant,
 *   ADR-033 taxonomy vestige) and `Topology ceiling:` (V1 vestige, no longer
 *   meaningful in V2 Worker). The remaining 6 lines are preserved.
 *
 * Two variants:
 *   v_baseline: buildWorkerInstructions(decision, undefined, false) + 8-line decisionSummary
 *   v_proposed: buildWorkerInstructions(decision, undefined, false) + 6-line decisionSummary
 *               (Harness: + Topology ceiling: lines removed)
 *
 * Pre-registered SHIP gate (behavioral-neutral hygiene per anti-pattern 9):
 *   v_proposed regression vs v_baseline ≤ 8pp per cell.
 *   Especially ds/v4pro C3 must not regress (was the signal case in prior eval).
 *   token gate: v_proposed system prompt length ≤ v_baseline.
 *
 * Pilot spec (anti-pattern 9 — behavioral-neutral hygiene, 2-alias pilot):
 *   aliases: availableAliases('ds/v4pro', 'mimo/v25pro', 'zhipu/glm52') → first 2 with key.
 *   cases: C2 (plan-first) + C3 (review) — the two cases most influenced by decisionSummary.
 *   RUNS=3 per cell.
 *   Total: 2 alias × 2 case × 2 variant × 3 runs = 24 LLM calls ≈ $0.5-2.
 *
 * Run:
 *   npm run build:packages
 *   KODAX_EVAL_DUMP_DIR=c:/tmp/ npm run test:eval -- decision-summary-deharness-pilot
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
  'decision-summary-deharness-pilot',
);

// ---------------------------------------------------------------------------
// decisionSummary block builders
// ---------------------------------------------------------------------------

type Decision = ReturnType<typeof buildFallbackRoutingDecision>;

/** Full 8-line decisionSummary (mirrors role-prompt.ts:92-102 format) */
function buildFullDecisionSummaryBlock(decision: Decision): string {
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

/** 6-line decisionSummary (Harness: + Topology ceiling: removed) */
function buildDeharnessedDecisionSummaryBlock(decision: Decision): string {
  return [
    `Primary task: ${decision.primaryTask}`,
    `Assurance intent: ${decision.assuranceIntent ?? 'default'}`,
    `Work intent: ${decision.workIntent}`,
    `Complexity hint: ${decision.complexity}`,
    `Risk: ${decision.riskLevel}`,
    `Brainstorm required: ${decision.requiresBrainstorm ? 'yes' : 'no'}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Variant builders
// ---------------------------------------------------------------------------

function getDecision(userPrompt: string): Decision {
  const providerPolicy = evaluateProviderPolicy({
    providerName: 'ark-coding',
    model: 'deepseek-v4-flash',
  });
  return buildFallbackRoutingDecision(userPrompt, providerPolicy);
}

function buildBaselineSystemPrompt(userPrompt: string): string {
  const decision = getDecision(userPrompt);
  const workerInstructions = buildWorkerInstructions(decision, undefined, false);
  const decisionSummary = buildFullDecisionSummaryBlock(decision);
  return `${workerInstructions}\n\n${decisionSummary}`;
}

function buildProposedSystemPrompt(userPrompt: string): string {
  const decision = getDecision(userPrompt);
  const workerInstructions = buildWorkerInstructions(decision, undefined, false);
  const decisionSummary = buildDeharnessedDecisionSummaryBlock(decision);
  return `${workerInstructions}\n\n${decisionSummary}`;
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
    console.warn(`[deharness-pilot] WARNING: tool '${name}' not found in registry — running without it`);
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
// Cases — C2 (plan-first) + C3 (review), same definitions as removal-panel
// ---------------------------------------------------------------------------

interface PilotCase {
  readonly id: string;
  readonly description: string;
  readonly userPromptForRouting: string;
  readonly priorMessages?: readonly { role: 'user' | 'assistant'; content: string }[];
  readonly userMessage: string;
}

// C2: complex multi-file refactor — should plan-first with todo_create
const C2: PilotCase = {
  id: 'C2_complex_plan_first',
  description: 'complex refactor — should emit todo_create plan-first',
  userPromptForRouting: '把 packages/auth 的 session 校验逻辑重构,拆分到 validator/store/types 三个文件,并为每个加单测。',
  userMessage: '把 packages/auth 的 session 校验逻辑重构,拆分到 validator/store/types 三个文件,并为每个加单测。',
};

// C3: code review with canned diff
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

const PILOT_CASES: readonly PilotCase[] = [C2, C3];

// ---------------------------------------------------------------------------
// Judges (same as removal-panel for C2 + C3)
// ---------------------------------------------------------------------------

function judgeC2PlanFirst(text: string, context?: JudgeContext): JudgeResult {
  if (invokesTool(text, 'todo_create', context)) {
    return { passed: true };
  }
  return { passed: false, reason: `todo_create NOT invoked (binding+regex); text[:200]="${text.slice(0, 200)}"` };
}

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

const CASE_JUDGES: Record<string, PromptJudge[]> = {
  [C2.id]: [{ name: 'plan_first_todo_create', category: 'correctness', judge: judgeC2PlanFirst }],
  [C3.id]: [{ name: 'review_high_signal', category: 'correctness', judge: judgeC3ReviewHighSignal }],
};

// ---------------------------------------------------------------------------
// Alias selection (first 2 of ds/v4pro, mimo/v25pro, zhipu/glm52 that have keys)
// ---------------------------------------------------------------------------

const ALIAS_PREFERENCE: readonly ModelAlias[] = [
  'ds/v4pro',
  'mimo/v25pro',
  'zhipu/glm52',
  // fallbacks if primary unavailable
  'ark/v4pro',
  'mimo/v25',
  'zhipu/glm52',
  'ark/v4flash',
];

const ALIAS_FALLBACK: Partial<Record<ModelAlias, ModelAlias>> = {
  'ds/v4pro':    'ark/v4pro',
  'ark/v4pro':   'ds/v4flash',
  'ark/v4flash': 'ds/v4flash',
};

const RUNS_PER_CELL = 3;

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

describe('decision-summary-deharness-pilot — 2 alias × C2+C3 × 2 variants × 3 runs', () => {
  const allAvailable = availableAliases(...ALIAS_PREFERENCE);
  // Take first 2 available (ds/v4pro must be first if present)
  const aliases = allAvailable.slice(0, 2);

  if (aliases.length === 0) {
    it('skips: no pilot alias keys in env', () => { /* no-op */ });
    return;
  }

  // eslint-disable-next-line no-console
  console.log(`[deharness-pilot] aliases selected: ${aliases.join(', ')}, runs: ${RUNS_PER_CELL}`);

  // Layer-1 token metric (static, no LLM call)
  it('token-metric: baseline vs proposed system prompt sizes (Layer-1)', () => {
    const lines: string[] = ['[deharness-pilot] === TOKEN METRIC ==='];
    lines.push('  v_baseline = buildWorkerInstructions + 8-line decisionSummary');
    lines.push('  v_proposed = buildWorkerInstructions + 6-line decisionSummary (no Harness: / Topology ceiling:)');
    let allPass = true;
    for (const c of PILOT_CASES) {
      const baseline = buildBaselineSystemPrompt(c.userPromptForRouting);
      const proposed = buildProposedSystemPrompt(c.userPromptForRouting);
      const delta = proposed.length - baseline.length;
      const gatePass = delta <= 0;
      if (!gatePass) allPass = false;
      lines.push(
        `  ${c.id.padEnd(30)} baseline=${baseline.length} proposed=${proposed.length} delta=${delta >= 0 ? '+' : ''}${delta} token-gate:${gatePass ? 'PASS' : 'FAIL'}`,
      );
      // Also verify the diff is only the two removed lines
      const baselineTail = baseline.slice(-300);
      const proposedTail = proposed.slice(-300);
      lines.push(`    baseline tail: ${baselineTail.replace(/\n/g, '\\n')}`);
      lines.push(`    proposed tail: ${proposedTail.replace(/\n/g, '\\n')}`);
    }
    lines.push(`  Overall token gate: ${allPass ? 'ALL PASS' : 'SOME FAIL'}`);
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
  });

  for (const c of PILOT_CASES) {
    it(
      `${c.id} — ${aliases.join('+')} × v_baseline vs v_proposed × ${RUNS_PER_CELL} runs`,
      { timeout: 20 * 60_000 },
      async () => {
        const baselineSysPrompt = buildBaselineSystemPrompt(c.userPromptForRouting);
        const proposedSysPrompt = buildProposedSystemPrompt(c.userPromptForRouting);

        const variants = [
          {
            id: 'v_baseline',
            description: 'buildWorkerInstructions + 8-line decisionSummary (production)',
            systemPrompt: baselineSysPrompt,
            priorMessages: c.priorMessages,
            userMessage: c.userMessage,
            tools: PRODUCTION_TOOLS,
          },
          {
            id: 'v_proposed',
            description: 'buildWorkerInstructions + 6-line decisionSummary (no Harness: / Topology ceiling:)',
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
        lines.push(`[deharness-pilot][${c.id}]`);
        lines.push(`  desc: ${c.description}`);
        lines.push('  variant       alias          passRate  runs(P/T)');

        for (const cell of result.cells) {
          const passed = cell.runsRaw.filter((r) => r.passed).length;
          lines.push(
            `  ${cell.variantId.padEnd(13)} ${cell.alias.padEnd(15)} ${cell.passRate.toFixed(0).padStart(3)}%      ${passed}/${RUNS_PER_CELL}`,
          );
          for (const run of cell.runsRaw) {
            const toolList = run.toolCalls.map((t) => t.name).join(',') || '(none)';
            const textPreview = run.text.slice(0, 200).replace(/\n/g, ' ');
            lines.push(`    run${run.runIndex}: tools=[${toolList}] text[:200]="${textPreview}"`);
            const judgeStr = run.judges.map((j) => `${j.name}=${j.passed ? 'PASS' : 'FAIL'}`).join(' ');
            lines.push(`             judges: ${judgeStr}`);
            if (run.error) lines.push(`             ERROR: ${run.error}`);
            if (run.fallbackUsed) lines.push(`             fallback: ${run.fallbackUsed}`);
            if (!run.judges[0]?.passed && run.judges[0]?.reason) {
              lines.push(`             reason: ${run.judges[0].reason}`);
            }
          }
        }

        const baselineCells = result.byVariant['v_baseline'] ?? [];
        const proposedCells = result.byVariant['v_proposed'] ?? [];

        lines.push('  --- GATE CHECK per alias (≤8pp regression = MET) ---');
        for (const alias of aliases) {
          const bCell = baselineCells.find((cell) => cell.alias === alias);
          const pCell = proposedCells.find((cell) => cell.alias === alias);
          if (!bCell || !pCell) {
            lines.push(`    ${alias}: SKIP (no cell data)`);
            continue;
          }
          const delta = pCell.passRate - bCell.passRate;
          const deltaStr = `${delta >= 0 ? '+' : ''}${delta.toFixed(0)}pp`;
          const gateMet = delta >= -8;
          lines.push(
            `    ${alias}: baseline=${bCell.passRate.toFixed(0)}% proposed=${pCell.passRate.toFixed(0)}% delta=${deltaStr} gate=${gateMet ? 'MET' : 'FAIL'}`,
          );
        }

        // eslint-disable-next-line no-console
        console.log(lines.join('\n'));

        // Dump
        mkdirSync(DUMP_ROOT, { recursive: true });
        const dumpPath = join(DUMP_ROOT, `${c.id}_pilot.json`);
        const dump = {
          case: c.id,
          stage: 'decision-summary-deharness-pilot',
          startedAt: result.startedAt,
          description: c.description,
          userMessage: c.userMessage,
          aliases,
          runs: RUNS_PER_CELL,
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
            // Show last 400 chars to verify decisionSummary presence/absence
            systemPromptTail: v.systemPrompt.slice(-400),
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
              gateMet: delta !== null ? delta >= -8 : null,
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
