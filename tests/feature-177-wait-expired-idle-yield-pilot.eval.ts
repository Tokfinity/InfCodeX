/**
 * Pilot: FEATURE_177 wait_expired child-output semantics.
 *
 * Why Layer 1 is not enough:
 * Unit tests can prove `task_output` now returns `wait_expired` and that the
 * Worker prompt contains the pending-child gate. They cannot prove a model
 * that just saw a `wait_expired` tool result will choose idle-yield instead of
 * writing a final report from partial evidence.
 *
 * Layer 2 design:
 * One single-turn probe with production Worker instructions and production
 * tool descriptions. The canned history reproduces the old failure chain:
 * four review children were dispatched, a blocking read window expired for
 * still-running children, and no matching `<task-completed>` block has arrived
 * for those children yet.
 *
 * Expected mechanical assertions:
 * - no tool calls: the next action should be text-only idle-yield;
 * - no child-timeout claim: `wait_expired` must not be summarized as child
 *   timeout/failure;
 * - no final report: pending children cannot be treated as final evidence;
 * - waiting status: the text should indicate the Worker is still waiting.
 *
 * Pre-registered pilot gate:
 * `v_current` should pass at least 2/3 runs on `zhipu/glm51` (a capable
 * instruction-follower that can actually demonstrate the taught idle-yield).
 * Measured 2026-06-26: 3/3 after (a) renaming `timeout` → `wait_expired`,
 * (b) the Worker prompt pending-child gate, and (c) the anti-block-peek
 * rule ("waiting is idle-yield, not a blocking peek"). A 5-alias panel run
 * the same day confirmed the acute bug is gone across aliases — no model
 * claimed a child timed out, wrote a premature report, or re-issued the
 * turn-freezing `block:true`; the ark "flash" models downgrade to harmless
 * `block:false` peeks / read-only re-scans (a known weak-model floor on
 * tool-call abstinence). If this gate fails, inspect raw dumps first and
 * adjust the prompt/schema wording before rerunning.
 *
 * Cost:
 * 1 alias x 1 case x 1 variant x 3 runs ~= 3 calls. Dumps are written under
 * `os.tmpdir()/kodax-eval-dumps/feature-177-wait-expired-idle-yield-pilot`.
 *
 * Run:
 *   npm run test:eval -- feature-177-wait-expired-idle-yield-pilot
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { KodaXMessage, KodaXToolDefinition } from '@kodax-ai/llm';
import { describe, expect, it } from 'vitest';

import { availableAliases, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runBenchmark } from '../benchmark/harness/harness.js';
import type { JudgeContext, JudgeResult, PromptJudge } from '../benchmark/harness/judges.js';
import { buildWorkerInstructions } from '../packages/coding/src/agents/worker-role-prompt.js';
import { getToolDefinition } from '../packages/coding/src/tools/registry.js';
import type { KodaXTaskRoutingDecision } from '../packages/coding/src/types.js';

const DUMP_ROOT = join(
  process.env.KODAX_EVAL_DUMP_DIR ?? tmpdir(),
  'kodax-eval-dumps',
  'feature-177-wait-expired-idle-yield-pilot',
);

// Pilot alias is a capable instruction-follower (zhipu/glm51): it can
// demonstrate the taught idle-yield behavior so the gate is meaningful.
// Weak "flash" models (ark/v4flash, ark/v4pro) structurally resist ending
// a turn with no tool call — after this fix they downgrade to harmless
// `block:false` peeks / read-only re-scans instead of the original
// turn-freezing `block:true` + premature-report cascade, but they still
// fail a strict "no tool calls" gate (a known weak-model floor, see
// `feedback_model_structural_floor_not_prompt_tunable`). Validate them by
// dump inspection, not by this PASS gate.
const PILOT_PANEL: readonly ModelAlias[] = ['zhipu/glm51'] as const;
const ALIAS_FALLBACK: Partial<Record<ModelAlias, ModelAlias>> = {
  'zhipu/glm51': 'ark/v4pro',
};
const RUNS_PER_CELL = 3;

const DECISION: KodaXTaskRoutingDecision = {
  primaryTask: 'review',
  workIntent: 'new',
  complexity: 'complex',
  riskLevel: 'medium',
  harnessProfile: 'PLANNED',
  recommendedMode: 'deep',
  recommendedThinkingDepth: 'high',
  confidence: 0.85,
  reason: 'parallel review with in-flight children',
  requiresBrainstorm: false,
};

const TOOL_NAMES = [
  'dispatch_child_task',
  'task_output',
  'task_stop',
  'send_message',
  'read',
  'grep',
  'bash',
  'changed_scope',
  'changed_diff_bundle',
] as const;

function requireToolDefinition(name: string): KodaXToolDefinition {
  const definition = getToolDefinition(name);
  if (!definition) {
    throw new Error(`Missing production tool definition: ${name}`);
  }
  return definition;
}

const TOOLS = TOOL_NAMES.map(requireToolDefinition);

const PRIOR_MESSAGES: readonly KodaXMessage[] = [
  {
    role: 'user',
    content: 'Review all current commits and working-tree changes.',
  },
  {
    role: 'assistant',
    content:
      'I scoped the diff and dispatched four read-only children in parallel: ' +
      'review-agent, review-coding, review-repl, and review-src-scripts. ' +
      'I have finished the parent-side docs/config pass and have no useful ' +
      'parent-side work left until the remaining child reports arrive.',
  },
  {
    role: 'user',
    content:
      '<tool_result name="task_output">\n' +
      '<retrieval_status>success</retrieval_status>\n' +
      '<task_id>review-agent</task_id>\n' +
      '<status>completed</status>\n' +
      '<iterations>8/200</iterations>\n' +
      '<duration_ms>42100</duration_ms>\n' +
      '<output>packages/agent review complete: no blocking findings.</output>\n' +
      '</tool_result>\n\n' +
      '<tool_result name="task_output">\n' +
      '<retrieval_status>wait_expired</retrieval_status>\n' +
      '<task_id>review-coding</task_id>\n' +
      '<status>running</status>\n' +
      '<iterations>11/200</iterations>\n' +
      '<duration_ms>73300</duration_ms>\n' +
      '<note>The bounded read window expired. The child task has not timed out — read the `status` field above to decide whether it is still running.</note>\n' +
      '<recent_tool_calls>[iter 11] grep guardrail|repo-intelligence</recent_tool_calls>\n' +
      '</tool_result>\n\n' +
      '<tool_result name="task_output">\n' +
      '<retrieval_status>wait_expired</retrieval_status>\n' +
      '<task_id>review-repl</task_id>\n' +
      '<status>running</status>\n' +
      '<iterations>7/200</iterations>\n' +
      '<duration_ms>69050</duration_ms>\n' +
      '<note>The bounded read window expired. The child task has not timed out — read the `status` field above to decide whether it is still running.</note>\n' +
      '<recent_tool_calls>[iter 7] grep commands-status</recent_tool_calls>\n' +
      '</tool_result>\n\n' +
      '<tool_result name="task_output">\n' +
      '<retrieval_status>wait_expired</retrieval_status>\n' +
      '<task_id>review-src-scripts</task_id>\n' +
      '<status>running</status>\n' +
      '<iterations>6/200</iterations>\n' +
      '<duration_ms>66520</duration_ms>\n' +
      '<note>The bounded read window expired. The child task has not timed out — read the `status` field above to decide whether it is still running.</note>\n' +
      '<recent_tool_calls>[iter 6] grep cli_option_helpers|build-bundle</recent_tool_calls>\n' +
      '</tool_result>',
  },
];

const USER_MESSAGE =
  'Continue from these child status snapshots. Do not invent missing child reports.';

function buildToolNamePatterns(toolName: string): readonly RegExp[] {
  const escaped = toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    new RegExp(`\\b${escaped}\\s*\\(`, 'i'),
    new RegExp(`["'\`]name["'\`]\\s*:\\s*["'\`]${escaped}["'\`]`, 'i'),
    new RegExp(`<${escaped}\\b(?:[\\s\\S]{0,2000}?</${escaped}>|[^>]*/>)`, 'i'),
    new RegExp(`\\bname\\s*[:=]\\s*${escaped}\\b`, 'i'),
    new RegExp(`<tool_name>\\s*${escaped}\\s*</tool_name>`, 'i'),
    new RegExp(`<tool>\\s*${escaped}\\s*</tool>`, 'i'),
    new RegExp(`<tool_call>\\s*${escaped}\\b[\\s\\S]{0,2000}?</tool_call\\s*>`, 'i'),
    new RegExp(`\\b${escaped}\\s*:\\s*\\d+\\s*[>{]`, 'i'),
    new RegExp(`tool\\s*=>\\s*["'\`]${escaped}["'\`]`, 'i'),
  ];
}

function invokesTool(text: string, toolName: string): boolean {
  return buildToolNamePatterns(toolName).some((pattern) => pattern.test(text));
}

function isNegatedToolMention(line: string, toolName: string): boolean {
  if (!invokesTool(line, toolName)) return false;
  const escaped = toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const negationBeforeTool = new RegExp(
    `\\b(?:not|never|avoid|without|do\\s+not|don't|won't|shouldn't|must\\s+not|rather\\s+than|instead\\s+of|no\\s+(?:tool\\s+calls?|need\\s+to|reason\\s+to))\\b[^\\n]{0,120}${escaped}`,
    'i',
  );
  const chineseNegationBeforeTool = new RegExp(
    `(?:不要|不应|不會|不会|无需|無需|避免|而不是)[^\\n]{0,80}${escaped}`,
    'i',
  );
  return negationBeforeTool.test(line) || chineseNegationBeforeTool.test(line);
}

function invokesToolAffirmatively(text: string, toolName: string): boolean {
  return text
    .split(/\r?\n/)
    .some((line) => invokesTool(line, toolName) && !isNegatedToolMention(line, toolName));
}

function judgeNoToolCalls(output: string, context?: JudgeContext): JudgeResult {
  const toolCalls = context?.toolCalls ?? [];
  if (toolCalls.length > 0) {
    return { passed: false, reason: `tool calls present: ${toolCalls.map((call) => call.name).join(', ')}` };
  }
  for (const toolName of TOOL_NAMES) {
    if (invokesToolAffirmatively(output, toolName)) {
      return { passed: false, reason: `text contains tool-call syntax for ${toolName}` };
    }
  }
  return { passed: true };
}

function judgeNoChildTimeoutClaim(output: string): JudgeResult {
  const lower = output.toLowerCase();
  const explicitlyNegated =
    lower.includes('not timed out') ||
    lower.includes('has not timed out') ||
    lower.includes('not a child task timeout');
  const harmfulEnglish =
    /\b(child|task|agent|subagent)[\s\S]{0,60}\b(timed out|timeout|failed|dead)\b/i.test(output);
  const harmfulChinese =
    /(子任务|子\s*agent|subagent)[\s\S]{0,40}(已超时|超时了|失败|死了)/i.test(output);
  if ((harmfulEnglish && !explicitlyNegated) || harmfulChinese) {
    return { passed: false, reason: 'describes a still-running child as timed out or failed' };
  }
  return { passed: true };
}

function judgeNoFinalReport(output: string): JudgeResult {
  // Match the STRUCTURE of an overall verdict, not topic words. A correct
  // idle-yield message legitimately mentions the one completed child's
  // one-line result (e.g. "review-agent: no blocking findings") — the bare
  // token "findings" must NOT trip this judge, or it false-fails clean
  // waiting messages (observed: zhipu/glm51 "no blocking findings" + yield).
  const finalReportPattern =
    /(final report|final review|overall conclusion|overall assessment|总体评估|总体结论|最终报告|总体总结)/i;
  if (finalReportPattern.test(output)) {
    return { passed: false, reason: 'output looks like a final review/report while children are pending' };
  }
  return { passed: true };
}

function judgeWaitingStatus(output: string): JudgeResult {
  // Broad enough to catch natural waiting phrasings observed in real runs:
  // "I will wait …", "until their reports arrive", "to finish", "to
  // complete". A too-narrow pattern false-fails correct idle-yields (kimi:
  // "I will wait for the remaining three children to finish.").
  const waitingPattern =
    /(wait|in flight|still running|pending|resume|finish|complet|arrive|等待|仍在运行|还在运行|等.*完成|子任务完成)/i;
  if (waitingPattern.test(output)) {
    return { passed: true };
  }
  return { passed: false, reason: 'no waiting/in-flight status language found' };
}

const JUDGES: readonly PromptJudge[] = [
  { name: 'no_tool_calls_idle_yield', category: 'correctness', judge: judgeNoToolCalls },
  { name: 'no_child_timeout_claim', category: 'correctness', judge: judgeNoChildTimeoutClaim },
  { name: 'no_final_report', category: 'correctness', judge: judgeNoFinalReport },
  { name: 'waiting_status', category: 'correctness', judge: judgeWaitingStatus },
];

describe('FEATURE_177 wait_expired idle-yield judge helpers', () => {
  it('does not treat negated anti-block-peek text as a tool call', () => {
    const result = judgeNoToolCalls(
      'review-coding is still running; I will wait rather than call task_output(block:true).',
      { toolCalls: [] },
    );
    expect(result.passed).toBe(true);
  });

  it('still flags affirmative text tool-call syntax when bindings are absent', () => {
    const result = judgeNoToolCalls(
      'I will check now: task_output({ task_id: "review-coding" })',
      { toolCalls: [] },
    );
    expect(result.passed).toBe(false);
  });

  it('does not let a bare no before an affirmative call mask the call', () => {
    const result = judgeNoToolCalls(
      'No, I will check now: task_output({ task_id: "review-coding" })',
      { toolCalls: [] },
    );
    expect(result.passed).toBe(false);
  });
});

describe('FEATURE_177 wait_expired idle-yield pilot', () => {
  const aliases = availableAliases(...PILOT_PANEL);

  if (aliases.length === 0) {
    it('skips: no pilot alias key in env', () => { /* no-op */ });
    return;
  }

  it(
    `wait_expired_running_children -> idle-yield (${aliases.length} alias x ${RUNS_PER_CELL} runs)`,
    { timeout: 10 * 60_000 },
    async () => {
      const variants = [
        {
          id: 'v_current',
          description: 'current Worker prompt + wait_expired task_output schema',
          systemPrompt: buildWorkerInstructions(DECISION, undefined, false),
          priorMessages: PRIOR_MESSAGES,
          userMessage: USER_MESSAGE,
          tools: TOOLS,
        },
      ];

      const result = await runBenchmark({
        variants,
        models: aliases,
        judges: JUDGES,
        runs: RUNS_PER_CELL,
        aliasFallback: ALIAS_FALLBACK,
      });

      const lines: string[] = [];
      lines.push('[feature-177-wait-expired-idle-yield-pilot]');
      for (const cell of result.cells) {
        lines.push(`  ${cell.alias.padEnd(14)} pass=${cell.runsRaw.filter((run) => run.passed).length}/${cell.runsRaw.length}`);
        for (const run of cell.runsRaw) {
          const failed = run.judges.filter((judge) => !judge.passed);
          if (failed.length > 0) {
            lines.push(`    run ${run.runIndex}: ${failed.map((judge) => judge.reason ?? judge.name).join('; ')}`);
          }
        }
      }
      // eslint-disable-next-line no-console
      console.log(lines.join('\n'));

      mkdirSync(DUMP_ROOT, { recursive: true });
      const dumpPath = join(DUMP_ROOT, 'wait_expired_running_children.json');
      const dump = {
        case: 'wait_expired_running_children',
        stage: 'feature-177-wait-expired-idle-yield-pilot',
        startedAt: result.startedAt,
        variants: variants.map((variant) => ({
          id: variant.id,
          description: variant.description,
          systemPrompt: variant.systemPrompt,
          priorMessages: variant.priorMessages,
          userMessage: variant.userMessage,
          tools: variant.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.input_schema,
          })),
        })),
        aliases: result.cells.map((cell) => ({
          alias: cell.alias,
          variantId: cell.variantId,
          passRate: cell.passRate,
          runs: cell.runsRaw.map((run) => ({
            runIndex: run.runIndex,
            text: run.text,
            toolCalls: run.toolCalls,
            durationMs: run.durationMs,
            error: run.error,
            fallbackUsed: run.fallbackUsed,
            regexJudges: run.judges.map((judge) => ({
              name: judge.name,
              passed: judge.passed,
              reason: judge.reason,
            })),
          })),
        })),
      };
      writeFileSync(dumpPath, JSON.stringify(dump, null, 2), 'utf-8');
      // eslint-disable-next-line no-console
      console.log(`  [dump] ${dumpPath}`);
    },
  );
});
