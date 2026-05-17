/**
 * LLM-judge audit driver for FEATURE_170 (v0.7.41) Todo V2 Migration
 * prompt rewrite — panel-internal 3-judge majority vote (zhipu/glm51 +
 * ds/v4pro + kimi-code, 2/3 majority).
 *
 * Per EVAL_GUIDELINES anti-pattern 7 §3 strict clause + §Judge model
 * selection. Mirrors `tests/feature-125-team-mode-awareness-judge-
 * audit.eval.ts`.
 *
 * ## Input
 *
 * Reads the 250 raw outputs (5 alias × 5 run × 5 case × 2 variant)
 * dumped at `os.tmpdir()/kodax-eval-dumps/feature-170-todo-v2-migration/
 * <case>.json` by `tests/feature-170-todo-v2-migration.eval.ts`.
 *
 * Dump schema (FEATURE_170 has `variants` wrapper because each case has
 * v_baseline + v_proposed):
 *
 *   { case, polarity, behaviour, variants: [{ variantId, systemPrompt,
 *     userMessage, priorMessages, aliases: [{ alias, runs: [{ runIndex,
 *     text, toolCalls, regexPassed, regexJudges }] }] }] }
 *
 * ## Judge contract per case polarity
 *
 *   mid_task_insert_via_todo_create:
 *     PASS iff response invokes `todo_create` AND does NOT invoke
 *     `todo_update({op:"init", ...})`. Status-only `todo_update` is
 *     FAIL because it doesn't insert a new step.
 *
 *   mid_task_content_patch:
 *     PASS iff response invokes `todo_update` with `id` AND a `content`
 *     field set (patching the description). Status-only update is FAIL.
 *     `op:"init"` is FAIL (wipes other items' progress).
 *
 *   mid_task_delete_obsolete:
 *     PASS iff response invokes `todo_update` with `id` AND `status:
 *     "deleted"` (or `"cancelled"` as acceptable alternative). Silent
 *     skip / `op:"init"` are FAIL.
 *
 *   initial_plan_commitment:
 *     PASS iff response commits a multi-step plan via EITHER
 *     `todo_update({op:"init", items:[...]})` OR ≥2 `todo_create`
 *     calls. Single tool call (just exploring) is FAIL.
 *
 *   status_flip_backwards_compat:
 *     PASS iff response invokes `todo_update` with `id` AND `status:
 *     "completed"` (or equivalent terminal). `op:"init"` is FAIL.
 *
 * ## Cost
 *
 *   250 runs × 3 judges = 750 LLM calls × ~$0.005-0.01/call ≈ $4-7.50
 *
 * ## Run
 *
 *   npm run test:eval -- feature-170-todo-v2-migration-judge-audit
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it } from 'vitest';

import { availableAliases, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runOneShot } from '../benchmark/harness/harness.js';
import {
  CASES,
  type CaseId,
  type CaseSpec,
} from '../benchmark/datasets/feature-170-todo-v2-migration/cases.js';

const DUMP_SOURCE_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'feature-170-todo-v2-migration');
const AUDIT_DUMP_ROOT = join(
  tmpdir(),
  'kodax-eval-dumps',
  'feature-170-todo-v2-migration-judge-audit',
);

const JUDGES: readonly ModelAlias[] = ['zhipu/glm51', 'ds/v4pro', 'kimi'] as const;

interface DumpRun {
  readonly runIndex: number;
  readonly text: string;
  readonly toolCalls: ReadonlyArray<{ name: string; input: unknown }>;
  readonly regexPassed: boolean;
}

interface DumpAlias {
  readonly alias: string;
  readonly runs: readonly DumpRun[];
}

interface DumpVariant {
  readonly variantId: string;
  readonly userMessage: string;
  readonly aliases: readonly DumpAlias[];
}

interface DumpFile {
  readonly case: CaseId;
  readonly polarity: CaseSpec['polarity'];
  readonly variants: readonly DumpVariant[];
}

function caseDecisionRule(spec: CaseSpec): string {
  switch (spec.polarity) {
    case 'must_call_todo_create':
      return 'PASS iff the response actually invokes the `todo_create` tool to insert ONE new todo item AND does NOT invoke `todo_update({op:"init", ...})`. Status-only `todo_update` is FAIL because it does not insert a new item. An intent statement without an actual tool call is FAIL. `op:"init"` re-seed is FAIL because it wipes existing progress.';
    case 'must_patch_content':
      return 'PASS iff the response invokes `todo_update` with BOTH an `id` field AND a `content` field set (patching the description). Status-only `todo_update({id, status})` is FAIL (description stays wrong). `op:"init"` is FAIL (wipes other items). An intent statement without an actual tool call is FAIL.';
    case 'must_delete_status':
      return 'PASS iff the response invokes `todo_update` with an `id` AND `status:"deleted"` (or `"cancelled"` as acceptable alternative — both remove the step from the active plan). Silent skip without any tool call is FAIL. `op:"init"` re-seed is FAIL.';
    case 'must_commit_plan':
      return 'PASS iff the response commits a multi-step plan via EITHER `todo_update({op:"init", items:[...]})` (canonical batch seed, ≥2 items) OR ≥2 separate `todo_create` calls. A single tool call (just exploring the codebase, single todo_create, etc.) is FAIL — the user gave a 3-step task and must see a plan.';
    case 'must_flip_status':
      return 'PASS iff the response invokes `todo_update` with `id` AND `status` set to `completed` (or equivalent terminal status: `done` / `finished`). `op:"init"` is FAIL (wrong path for status flip).';
  }
}

function buildJudgePrompt(
  spec: CaseSpec,
  userMessage: string,
  workerResponse: string,
  bindingToolCalls: ReadonlyArray<{ name: string; input: unknown }>,
): { systemPrompt: string; userMessage: string } {
  const systemPrompt =
    "You are an independent judge auditing a coding agent's todo-list tool-call behavior. " +
    'Reply with a single JSON object on one line — no markdown, no preamble.';

  const bindingNote =
    bindingToolCalls.length > 0
      ? `\n## Provider-bound tool_calls (harness ground truth)\n${JSON.stringify(bindingToolCalls)}\n`
      : '\n## Provider-bound tool_calls (harness ground truth)\n(none — model emitted tools via text only)\n';

  const syntaxNote =
    'Treat any of the following as VALID tool invocations (syntax varies across families):\n' +
    '  - `tool_name(args)` fn-call form\n' +
    '  - `<tool_call>{"name":"tool_name", ...}</tool_call>` JSON-in-XML (OpenAI canonical)\n' +
    '  - `<tool_name>...</tool_name>` XML-tag form\n' +
    '  - `<tool_name>tool_name</tool_name>` zhipu nested XML\n' +
    '  - `tool_name:N>{json}` / `tool_name:N{json}` kimi colon-N form\n' +
    '  - `[TOOL_CALL]{tool => "tool_name", args => {...}}[/TOOL_CALL]` mmx bracket-arrow\n' +
    '  - `<tool_call>tool_name<arg_key>...</arg_key>...</tool_call>` ark hybrid\n' +
    '\n' +
    'Treat as INVALID (FAIL):\n' +
    '  - Text-only intent statement with NO tool-call markup\n' +
    '  - Severely malformed syntax that no production runtime could parse\n' +
    '  - A different tool than required by the decision rule\n';

  const userPrompt =
    'An agent (the "Worker") manages a todo plan list during a coding task. ' +
    'It has access to the `todo_update` tool (with shapes A: { op:"init", items:[...] } for batch seed, ' +
    'or B: { id, content?, status?, activeForm?, note?, evaluator?, metadata? } for per-item patch — ' +
    "status enum includes 'pending'|'in_progress'|'completed'|'failed'|'cancelled'|'deleted') and the " +
    '`todo_create` tool ({ content, activeForm? } — inserts one new item with auto-minted id).\n\n' +
    `## Case: ${spec.id} (${spec.polarity})\n${spec.description}\n\n` +
    `## User turn that triggered the response\n[USER]\n${userMessage}\n\n` +
    `## Decision rule\n${caseDecisionRule(spec)}\n\n${syntaxNote}\n${bindingNote}\n` +
    `## Worker raw response\n--- BEGIN ---\n${workerResponse}\n--- END ---\n\n` +
    `Reply exactly one line of JSON in this shape:\n` +
    `  {"judgment":"PASS","reason":"<≤80 chars>"}\n` +
    `or\n` +
    `  {"judgment":"FAIL","reason":"<≤80 chars>"}`;
  return { systemPrompt, userMessage: userPrompt };
}

interface JudgeVerdict {
  readonly judgment: 'PASS' | 'FAIL' | 'UNCLEAR';
  readonly reason: string;
  readonly rawJudgeText: string;
}

function parseJudgeReply(raw: string): JudgeVerdict {
  const jsonMatch = raw.match(/\{[\s\S]*?\}/);
  if (!jsonMatch) {
    return { judgment: 'UNCLEAR', reason: 'no JSON object in judge reply', rawJudgeText: raw };
  }
  try {
    const obj = JSON.parse(jsonMatch[0]) as { judgment?: string; reason?: string };
    const j = (obj.judgment ?? '').toUpperCase();
    if (j === 'PASS' || j === 'FAIL') {
      return { judgment: j, reason: obj.reason ?? '', rawJudgeText: raw };
    }
    return {
      judgment: 'UNCLEAR',
      reason: `unrecognized judgment="${obj.judgment}"`,
      rawJudgeText: raw,
    };
  } catch {
    return { judgment: 'UNCLEAR', reason: 'JSON parse error', rawJudgeText: raw };
  }
}

function majorityVote(verdicts: readonly JudgeVerdict[]): 'PASS' | 'FAIL' | 'UNCLEAR' {
  let pass = 0;
  let fail = 0;
  for (const v of verdicts) {
    if (v.judgment === 'PASS') pass++;
    else if (v.judgment === 'FAIL') fail++;
  }
  if (pass >= 2) return 'PASS';
  if (fail >= 2) return 'FAIL';
  return 'UNCLEAR';
}

describe('Audit: FEATURE_170 Todo V2 Migration LLM-judge majority-vote (anti-pattern 7 §3)', () => {
  const judges = availableAliases(...JUDGES);
  if (judges.length < JUDGES.length) {
    it(
      `skips: need all 3 judge keys (${JUDGES.join(', ')}); have ${judges.join(', ') || '(none)'}`,
      () => {
        // No-op test makes the skip visible.
      },
    );
    return;
  }

  it(
    'audits all 250 raw outputs with 3-judge majority vote (per case × variant × alias × run)',
    // 90-min cap: 750 LLM calls × ~7s = ~90 min worst case.
    { timeout: 90 * 60_000 },
    async () => {
      mkdirSync(AUDIT_DUMP_ROOT, { recursive: true });

      const overall: {
        totalCells: number;
        agreeWithRegex: number;
        disagreeWithRegex: number;
        unclear: number;
      } = { totalCells: 0, agreeWithRegex: 0, disagreeWithRegex: 0, unclear: 0 };

      for (const c of CASES) {
        const dumpPath = join(DUMP_SOURCE_ROOT, `${c.id}.json`);
        let dump: DumpFile;
        try {
          dump = JSON.parse(readFileSync(dumpPath, 'utf8')) as DumpFile;
        } catch (err) {
          // eslint-disable-next-line no-console
          console.log(
            `[judge-audit][${c.id}] SKIP — dump missing at ${dumpPath}: ${err instanceof Error ? err.message : String(err)}`,
          );
          continue;
        }

        const summary: string[] = [];
        summary.push(`\n[judge-audit][${c.id}] polarity=${c.polarity}`);
        summary.push(`  judges: ${judges.join(', ')} (2/3 majority vote)`);

        const auditByVariant: Array<{
          variantId: string;
          aliases: Array<{
            alias: string;
            regexPassRate: number;
            judgePassRate: number;
            rows: Array<{
              runIndex: number;
              regexPassed: boolean;
              verdicts: Record<string, JudgeVerdict>;
              majority: 'PASS' | 'FAIL' | 'UNCLEAR';
              agreesWithRegex: boolean;
            }>;
          }>;
        }> = [];

        for (const variant of dump.variants) {
          summary.push('');
          summary.push(`  --- variant: ${variant.variantId} ---`);
          const byAlias: typeof auditByVariant[number]['aliases'] = [];
          for (const a of variant.aliases) {
            const rows: typeof byAlias[number]['rows'] = [];
            for (const r of a.runs) {
              const { systemPrompt, userMessage } = buildJudgePrompt(
                c,
                variant.userMessage,
                r.text,
                r.toolCalls,
              );
              const verdicts: Record<string, JudgeVerdict> = {};
              for (const judge of judges) {
                try {
                  const result = await runOneShot(judge, { systemPrompt, userMessage });
                  verdicts[judge] = parseJudgeReply(result.text);
                } catch (err) {
                  verdicts[judge] = {
                    judgment: 'UNCLEAR',
                    reason: `judge call failed: ${err instanceof Error ? err.message : String(err)}`,
                    rawJudgeText: '',
                  };
                }
              }
              const majority = majorityVote(Object.values(verdicts));
              const majorityPasses = majority === 'PASS';
              const agreesWithRegex = majorityPasses === r.regexPassed;
              rows.push({
                runIndex: r.runIndex,
                regexPassed: r.regexPassed,
                verdicts,
                majority,
                agreesWithRegex,
              });
              overall.totalCells++;
              if (majority === 'UNCLEAR') overall.unclear++;
              else if (agreesWithRegex) overall.agreeWithRegex++;
              else overall.disagreeWithRegex++;
            }
            const regexPass = rows.filter((r) => r.regexPassed).length;
            const judgePass = rows.filter((r) => r.majority === 'PASS').length;
            byAlias.push({
              alias: a.alias,
              regexPassRate: rows.length === 0 ? 0 : regexPass / rows.length,
              judgePassRate: rows.length === 0 ? 0 : judgePass / rows.length,
              rows,
            });
            const disag = rows.filter((r) => !r.agreesWithRegex).length;
            const total = rows.length || 1;
            summary.push(
              `    ${a.alias.padEnd(13)} regex=${regexPass}/${rows.length} (${
                Math.round((regexPass / total) * 100)
              }%)  judge=${judgePass}/${rows.length} (${
                Math.round((judgePass / total) * 100)
              }%)` + (disag > 0 ? `  disagree=${disag}` : ''),
            );
          }
          auditByVariant.push({ variantId: variant.variantId, aliases: byAlias });
        }

        const auditPath = join(AUDIT_DUMP_ROOT, `${c.id}.json`);
        writeFileSync(
          auditPath,
          JSON.stringify(
            {
              case: c.id,
              polarity: c.polarity,
              judges,
              variants: auditByVariant,
            },
            null,
            2,
          ),
          'utf8',
        );
        summary.push(`  audit dump: ${auditPath}`);
        // eslint-disable-next-line no-console
        console.log(summary.join('\n'));
      }

      const evaluatedCells = overall.totalCells - overall.unclear;
      const disagreementRate =
        evaluatedCells === 0 ? 0 : (overall.disagreeWithRegex / evaluatedCells) * 100;
      const finalLines: string[] = [];
      finalLines.push('');
      finalLines.push('[judge-audit][SUMMARY]');
      finalLines.push(`  total cells:        ${overall.totalCells}`);
      finalLines.push(`  agree with regex:   ${overall.agreeWithRegex}`);
      finalLines.push(`  disagree:           ${overall.disagreeWithRegex}`);
      finalLines.push(`  unclear:            ${overall.unclear}`);
      finalLines.push(`  disagreement rate:  ${disagreementRate.toFixed(1)}% (of evaluated)`);
      finalLines.push(
        `  EVAL_GUIDELINES anti-pattern 7 §3 verdict: ${
          disagreementRate > 10
            ? 'DATA INVALID — disagreement > 10%, redesign regex/judge before applying SHIP/PARTIAL/REJECT'
            : 'DATA VALID — regex-vs-judge agreement within tolerance, proceed to decision matrix'
        }`,
      );
      // eslint-disable-next-line no-console
      console.log(finalLines.join('\n'));
    },
  );
});
