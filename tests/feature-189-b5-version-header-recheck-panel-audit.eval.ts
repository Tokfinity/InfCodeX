/**
 * LLM-judge audit for FEATURE_189 B.5 RECHECK panel (2026-05-24).
 *
 * 3-judge majority vote (zhipu/glm52 + ark/v4pro + kimi) on the 100-cell
 * recheck panel. Handles TWO judge categories per case:
 *   - audit_4_packages      → plan_first_compliance + dispatch_intent
 *   - review_recent_changes → plan_first_compliance + pull_tool_first
 *
 * Reads dumps from `feature-189-b5-version-header-recheck-panel/` and
 * writes audit results under `feature-189-b5-version-header-recheck-panel-audit/`.
 *
 * ## Cost
 *   100 cells × 3 judges × 2 categories = 600 LLM calls × ~$0.01 ≈ $6.
 *
 * ## Run
 *   KODAX_EVAL_DUMP_DIR=c:/tmp/ npm run test:eval -- feature-189-b5-version-header-recheck-panel-audit
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it } from 'vitest';

import { availableAliases, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runOneShot } from '../benchmark/harness/harness.js';

const DUMP_ROOT_BASE = process.env.KODAX_EVAL_DUMP_DIR ?? tmpdir();
const DUMP_SOURCE_ROOT = join(
  DUMP_ROOT_BASE,
  'kodax-eval-dumps',
  'feature-189-b5-version-header-recheck-panel',
);
const AUDIT_DUMP_ROOT = join(
  DUMP_ROOT_BASE,
  'kodax-eval-dumps',
  'feature-189-b5-version-header-recheck-panel-audit',
);

const JUDGES: readonly ModelAlias[] = ['zhipu/glm52', 'ark/v4pro', 'kimi'] as const;

const CASE_IDS = ['audit_4_packages', 'review_recent_changes'] as const;
type CaseId = typeof CASE_IDS[number];
type JudgeKind = 'dispatch_fan_out' | 'change_review';

const CASE_KIND: Record<CaseId, JudgeKind> = {
  audit_4_packages: 'dispatch_fan_out',
  review_recent_changes: 'change_review',
};

interface DumpRun {
  readonly runIndex: number;
  readonly text: string;
  readonly toolCalls: ReadonlyArray<{ name: string; input: unknown }>;
  readonly fallbackUsed?: ModelAlias;
  readonly regexJudges: ReadonlyArray<{ name: string; passed: boolean; reason?: string }>;
}

interface DumpAliasCell {
  readonly alias: string;
  readonly variantId: string;
  readonly passRate: number;
  readonly runs: readonly DumpRun[];
}

interface DumpVariantMeta {
  readonly id: string;
  readonly description: string;
  readonly systemPrompt: string;
  readonly userMessage: string;
}

interface DumpFile {
  readonly case: CaseId;
  readonly stage: string;
  readonly judgeKind: JudgeKind;
  readonly startedAt: string;
  readonly variants: readonly DumpVariantMeta[];
  readonly aliases: readonly DumpAliasCell[];
}

const PLAN_FIRST_DECISION_RULE =
  'PASS iff the response shows the model intends to follow the PLAN-FIRST rule: ' +
  '(a) emits ≥1 `todo_create` invocation AND (b) the first `todo_create` appears before the first ' +
  'action tool (dispatch_child_task OR changed_scope OR bash). Treat narrative tool-call markup as ' +
  'valid invocation. If neither is invoked, FAIL.';

const DISPATCH_INTENT_DECISION_RULE =
  'PASS iff the response invokes `dispatch_child_task` at least once. Text-only narration without ' +
  'tool markup is FAIL.';

const PULL_TOOL_FIRST_DECISION_RULE =
  'PASS iff the first non-todo tool invocation is a pull-tool: `changed_scope` OR ' +
  '`changed_diff_bundle` OR `module_context`. FAIL if first non-todo action is `bash git diff …` ' +
  'or any `read`/`grep` on individual files (review tasks should use pull-tools per CHANGE-REVIEW ' +
  'POSITIVE REFRAME). If there is no non-todo action and no pull-tool, FAIL.';

function buildJudgePrompt(
  judgeName: 'plan_first_compliance' | 'dispatch_intent' | 'pull_tool_first',
  userMessage: string,
  workerResponse: string,
  bindingToolCalls: ReadonlyArray<{ name: string; input: unknown }>,
): { systemPrompt: string; userMessage: string } {
  const systemPrompt =
    "You are an independent judge auditing a coding agent's tool-call behavior. " +
    'Reply with a single JSON object on one line — no markdown, no preamble.\n\n' +
    '## CRITICAL RULE — read this FIRST\n\n' +
    'The "Provider-bound tool_calls" section below is the ABSOLUTE GROUND TRUTH for what tools the ' +
    'model invoked. Judge on those calls + their `input` payload. If empty, fall back to text.';

  const bindingNote =
    bindingToolCalls.length > 0
      ? `\n## Provider-bound tool_calls (ABSOLUTE GROUND TRUTH — read this first)\n${JSON.stringify(bindingToolCalls)}\n`
      : '\n## Provider-bound tool_calls (ABSOLUTE GROUND TRUTH — read this first)\n(none — fall back to text)\n';

  const syntaxNote =
    'Treat any of the following text-only patterns as VALID tool invocations:\n' +
    '  - `tool_name(args)` fn-call form\n' +
    '  - `<tool_call>{"name":"tool_name", ...}</tool_call>`\n' +
    '  - `<tool_name>...</tool_name>`\n' +
    '  - `<tool_name>tool_name</tool_name>` zhipu\n' +
    '  - `tool_name:N>{json}` kimi\n' +
    '  - `[TOOL_CALL]{tool => "tool_name", args => {...}}[/TOOL_CALL]` mmx\n' +
    '  - `<tool_call>tool_name<arg_key>...</arg_key>...</tool_call>` ark\n' +
    '\nINVALID: text-only narration with no tool markup; severely malformed markup.\n';

  let decisionRule: string;
  if (judgeName === 'plan_first_compliance') decisionRule = PLAN_FIRST_DECISION_RULE;
  else if (judgeName === 'dispatch_intent') decisionRule = DISPATCH_INTENT_DECISION_RULE;
  else decisionRule = PULL_TOOL_FIRST_DECISION_RULE;

  const userPrompt =
    'An agent (the "Worker") has these tools: `dispatch_child_task`, `todo_create`, ' +
    '`changed_scope`, `changed_diff_bundle`, `module_context`, `read`, `grep`, `bash`, `write`, ' +
    '`edit`.\n\n' +
    `## Judge category: ${judgeName}\n` +
    `## User turn\n[USER]\n${userMessage}\n\n` +
    `## Decision rule\n${decisionRule}\n\n${syntaxNote}\n${bindingNote}\n` +
    `## Worker raw response\n--- BEGIN ---\n${workerResponse}\n--- END ---\n\n` +
    `Reply: {"judgment":"PASS","reason":"..."} or {"judgment":"FAIL","reason":"..."}`;
  return { systemPrompt, userMessage: userPrompt };
}

interface JudgeVerdict {
  readonly judgment: 'PASS' | 'FAIL' | 'UNCLEAR';
  readonly reason: string;
  readonly rawJudgeText: string;
}

function parseJudgeReply(raw: string): JudgeVerdict {
  const jsonMatch = raw.match(/\{[\s\S]*?\}/);
  if (!jsonMatch) return { judgment: 'UNCLEAR', reason: 'no JSON', rawJudgeText: raw };
  try {
    const obj = JSON.parse(jsonMatch[0]) as { judgment?: string; reason?: string };
    const j = (obj.judgment ?? '').toUpperCase();
    if (j === 'PASS' || j === 'FAIL') return { judgment: j, reason: obj.reason ?? '', rawJudgeText: raw };
    return { judgment: 'UNCLEAR', reason: `unrecognized="${obj.judgment}"`, rawJudgeText: raw };
  } catch {
    return { judgment: 'UNCLEAR', reason: 'JSON parse error', rawJudgeText: raw };
  }
}

function majorityVote(verdicts: readonly JudgeVerdict[]): 'PASS' | 'FAIL' | 'UNCLEAR' {
  let pass = 0, fail = 0;
  for (const v of verdicts) {
    if (v.judgment === 'PASS') pass++;
    else if (v.judgment === 'FAIL') fail++;
  }
  if (pass >= 2) return 'PASS';
  if (fail >= 2) return 'FAIL';
  return 'UNCLEAR';
}

describe('Audit: FEATURE_189 B.5 RECHECK panel — 3-judge majority', () => {
  const judges = availableAliases(...JUDGES);
  if (judges.length < JUDGES.length) {
    it(`skips: need all 3 judge keys; have ${judges.join(', ') || '(none)'}`, () => { /* no-op */ });
    return;
  }

  it(
    'audits per-case categories',
    { timeout: 90 * 60_000 },
    async () => {
      mkdirSync(AUDIT_DUMP_ROOT, { recursive: true });

      const overall = {
        plan_first_compliance: { total: 0, agree: 0, disagree: 0, unclear: 0 },
        dispatch_intent: { total: 0, agree: 0, disagree: 0, unclear: 0 },
        pull_tool_first: { total: 0, agree: 0, disagree: 0, unclear: 0 },
      };

      for (const caseId of CASE_IDS) {
        const auditPathPreCheck = join(AUDIT_DUMP_ROOT, `${caseId}.json`);
        try {
          JSON.parse(readFileSync(auditPathPreCheck, 'utf8'));
          // eslint-disable-next-line no-console
          console.log(`[panel-audit-b5][${caseId}] RESUME-SKIP`);
          continue;
        } catch {
          /* proceed */
        }

        const dumpPath = join(DUMP_SOURCE_ROOT, `${caseId}.json`);
        let dump: DumpFile;
        try {
          dump = JSON.parse(readFileSync(dumpPath, 'utf8')) as DumpFile;
        } catch (err) {
          // eslint-disable-next-line no-console
          console.log(
            `[panel-audit-b5][${caseId}] SKIP — ${err instanceof Error ? err.message : String(err)}`,
          );
          continue;
        }

        const variantMessageById = new Map<string, string>();
        for (const v of dump.variants) variantMessageById.set(v.id, v.userMessage);

        const kind = CASE_KIND[caseId];
        const secondJudgeName: 'dispatch_intent' | 'pull_tool_first' =
          kind === 'change_review' ? 'pull_tool_first' : 'dispatch_intent';

        const summary: string[] = [];
        summary.push(`\n[panel-audit-b5][${caseId}] (kind=${kind})`);
        summary.push(`  judges: ${judges.join(', ')} (2/3 majority)`);

        const byVariant = new Map<string, DumpAliasCell[]>();
        for (const cell of dump.aliases) {
          const arr = byVariant.get(cell.variantId) ?? [];
          arr.push(cell);
          byVariant.set(cell.variantId, arr);
        }

        const auditByVariant: Array<{
          variantId: string;
          aliases: Array<{
            alias: string;
            planFirst: { regex: number; judge: number; rows: Array<{ runIndex: number; regexPassed: boolean; verdicts: Record<string, JudgeVerdict>; majority: 'PASS' | 'FAIL' | 'UNCLEAR'; agreesWithRegex: boolean }> };
            second: { name: string; regex: number; judge: number; rows: Array<{ runIndex: number; regexPassed: boolean; verdicts: Record<string, JudgeVerdict>; majority: 'PASS' | 'FAIL' | 'UNCLEAR'; agreesWithRegex: boolean }> };
          }>;
        }> = [];

        for (const variantId of [...byVariant.keys()].sort()) {
          summary.push('');
          summary.push(`  --- variant: ${variantId} ---`);
          const userMessage = variantMessageById.get(variantId) ?? '';
          const cells = byVariant.get(variantId) ?? [];
          const byAlias: typeof auditByVariant[number]['aliases'] = [];
          for (const cell of cells) {
            const planFirstRows: typeof byAlias[number]['planFirst']['rows'] = [];
            const secondRows: typeof byAlias[number]['second']['rows'] = [];
            for (const r of cell.runs) {
              for (const judgeName of ['plan_first_compliance', secondJudgeName] as const) {
                const { systemPrompt, userMessage: judgeUserMsg } = buildJudgePrompt(
                  judgeName,
                  userMessage,
                  r.text,
                  r.toolCalls,
                );
                const verdicts: Record<string, JudgeVerdict> = {};
                for (const judge of judges) {
                  try {
                    const res = await runOneShot(judge, { systemPrompt, userMessage: judgeUserMsg });
                    verdicts[judge] = parseJudgeReply(res.text);
                  } catch (err) {
                    verdicts[judge] = {
                      judgment: 'UNCLEAR',
                      reason: `judge call failed: ${err instanceof Error ? err.message : String(err)}`,
                      rawJudgeText: '',
                    };
                  }
                }
                const majority = majorityVote(Object.values(verdicts));
                const regexPassed = (r.regexJudges.find((j) => j.name === judgeName)?.passed) === true;
                const agreesWithRegex = (majority === 'PASS') === regexPassed;
                const row = { runIndex: r.runIndex, regexPassed, verdicts, majority, agreesWithRegex };
                if (judgeName === 'plan_first_compliance') planFirstRows.push(row);
                else secondRows.push(row);
                overall[judgeName].total++;
                if (majority === 'UNCLEAR') overall[judgeName].unclear++;
                else if (agreesWithRegex) overall[judgeName].agree++;
                else overall[judgeName].disagree++;
              }
            }
            byAlias.push({
              alias: cell.alias,
              planFirst: {
                regex: planFirstRows.filter((r) => r.regexPassed).length,
                judge: planFirstRows.filter((r) => r.majority === 'PASS').length,
                rows: planFirstRows,
              },
              second: {
                name: secondJudgeName,
                regex: secondRows.filter((r) => r.regexPassed).length,
                judge: secondRows.filter((r) => r.majority === 'PASS').length,
                rows: secondRows,
              },
            });
            const a = byAlias[byAlias.length - 1];
            summary.push(
              `    ${cell.alias.padEnd(14)} plan-first r=${a.planFirst.regex}/${planFirstRows.length} j=${a.planFirst.judge}/${planFirstRows.length}  ${secondJudgeName} r=${a.second.regex}/${secondRows.length} j=${a.second.judge}/${secondRows.length}`,
            );
          }
          auditByVariant.push({ variantId, aliases: byAlias });
        }

        mkdirSync(AUDIT_DUMP_ROOT, { recursive: true });
        const totalRows = auditByVariant.reduce(
          (sum, v) => sum + v.aliases.reduce((s, a) => s + a.planFirst.rows.length, 0),
          0,
        );
        writeFileSync(
          join(AUDIT_DUMP_ROOT, `${caseId}.json`),
          JSON.stringify({ case: caseId, kind, judges, totalRows, variants: auditByVariant }, null, 2),
          'utf8',
        );
        // eslint-disable-next-line no-console
        console.log(summary.join('\n'));
      }

      const finalLines: string[] = ['', '[panel-audit-b5][SUMMARY]'];
      const calcRate = (k: keyof typeof overall) => {
        const o = overall[k];
        const evaluated = o.total - o.unclear;
        return evaluated === 0 ? 0 : (o.disagree / evaluated) * 100;
      };
      for (const k of ['plan_first_compliance', 'dispatch_intent', 'pull_tool_first'] as const) {
        const o = overall[k];
        finalLines.push(
          `  ${k.padEnd(22)} total=${o.total} agree=${o.agree} disagree=${o.disagree} unclear=${o.unclear} disagreement=${calcRate(k).toFixed(1)}%`,
        );
      }
      const verdict =
        Math.max(calcRate('plan_first_compliance'), calcRate('dispatch_intent'), calcRate('pull_tool_first')) > 10
          ? 'DATA INVALID (any category > 10%)'
          : 'DATA VALID';
      finalLines.push(`  EVAL_GUIDELINES §anti-pattern 7 verdict: ${verdict}`);
      // eslint-disable-next-line no-console
      console.log(finalLines.join('\n'));
    },
  );
});
