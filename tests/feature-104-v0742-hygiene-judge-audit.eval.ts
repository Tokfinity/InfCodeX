/**
 * LLM-judge audit driver for FEATURE_104 v0.7.42 plan-list hygiene
 * Layer 2 eval — panel-internal 3-judge majority vote.
 *
 * Per EVAL_GUIDELINES anti-pattern 7 §3 + §Judge model selection. The
 * 3 judges (zhipu/glm51 + ark/v4pro + kimi) cover 3 independent
 * provider families per the canonical alias panel.
 *
 * ## Input
 *
 * Reads the 150 raw outputs (5 alias × 5 run × 3 case × 2 variant)
 * dumped at `os.tmpdir()/kodax-eval-dumps/feature-104-v0742-hygiene/
 * <case>.json` by `tests/feature-104-v0742-hygiene.eval.ts`.
 *
 * ## Judge contract per case polarity
 *
 *   staleness_refresh_before_update (must_call_todo_get_or_list):
 *     PASS iff the response invokes `todo_get` OR `todo_list` BEFORE
 *     any `todo_update`. The order matters — staleness refresh AFTER
 *     mutation is too late. An intent statement "let me check" without
 *     an actual tool call is FAIL.
 *
 *   dedup_scan_before_create (must_not_duplicate_subject):
 *     PASS iff the response does NOT call `todo_create` with a subject
 *     that duplicates the existing `todo_2: Audit packages/auth`.
 *     Acceptable alternatives: text-only ack, `todo_update` on todo_2
 *     to expand its description, or `todo_list` scan first.
 *     FAIL iff a NEW `todo_create` is emitted with a subject containing
 *     both "packages/auth" AND "audit" (any order, case-insensitive).
 *
 *   verification_after_completion (must_invoke_verification):
 *     PASS iff the response invokes `bash` with a test/build/lint
 *     command (vitest, jest, npm test, tsc -b, etc.), OR reads a
 *     test/coverage file, OR text explicitly states verification was
 *     performed (with concrete evidence, not just intent). FAIL iff
 *     the response writes a "yes done" summary without verification.
 *
 * ## Cost
 *
 *   150 runs × 3 judges = 450 LLM calls × ~$0.005-0.01/call ≈ $2.5-4.5
 *
 * ## Run
 *
 *   npm run test:eval -- feature-104-v0742-hygiene-judge-audit
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
} from '../benchmark/datasets/feature-104-v0742-hygiene/cases.js';

const DUMP_SOURCE_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'feature-104-v0742-hygiene');
const AUDIT_DUMP_ROOT = join(
  tmpdir(),
  'kodax-eval-dumps',
  'feature-104-v0742-hygiene-judge-audit',
);

const JUDGES: readonly ModelAlias[] = ['zhipu/glm51', 'ark/v4pro', 'kimi'] as const;

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
    case 'must_call_todo_get_or_list':
      return 'PASS iff the response actually invokes `todo_get` or `todo_list` as a real tool call BEFORE any `todo_update`. An intent statement ("let me check the state first") without an actual tool call is FAIL. The order matters: if `todo_update` appears in the response BEFORE `todo_get`/`todo_list`, that is FAIL — the refresh comes too late.';
    case 'must_not_duplicate_subject':
      return 'PASS iff the response does NOT call `todo_create` with a subject that duplicates the existing `todo_2: Audit packages/auth`. A duplicate-subject `todo_create` (subject mentions both "packages/auth" AND "audit" in any order) is FAIL. Acceptable alternatives that PASS: (a) text-only acknowledgement that the audit is already in the plan, (b) `todo_update` on `todo_2` to expand its description with the SQL-injection focus, (c) `todo_list` call first to confirm the current plan before deciding.';
    case 'must_invoke_verification':
      return 'PASS iff the response invokes `bash` with a test/build/lint command (e.g. `npm test`, `vitest`, `jest`, `npm run lint`, `tsc -b`, `tsc --build`), OR reads a test/coverage artifact, OR the text explicitly states verification was performed (with concrete evidence — e.g. "I ran `npm test` and 47 tests pass"). FAIL iff the response writes a "done" summary without any verification action OR only narrates intent ("let me verify") without actually verifying.';
  }
}

const TOOL_DOCS_NOTE =
  'Worker has access to `todo_update`, `todo_create`, `todo_list`, `todo_get`, `bash`, `read`, `grep`, and other standard tools. ';

function buildJudgePrompt(
  spec: CaseSpec,
  userMessage: string,
  workerResponse: string,
  bindingToolCalls: ReadonlyArray<{ name: string; input: unknown }>,
): { systemPrompt: string; userMessage: string } {
  const systemPrompt =
    "CRITICAL RULE — READ FIRST:\n" +
    "The `Provider-bound tool_calls` section below is the ABSOLUTE GROUND TRUTH for what tool calls the Worker actually emitted. The harness captured them from the provider's structured response and is authoritative. The Worker's raw text may ALSO contain `<tool_call>...` markup that mirrors the binding, OR text-only intent statements that look like tool calls but were not actually invoked.\n\n" +
    "Judge workflow:\n" +
    "1. Read the Provider-bound tool_calls JSON FIRST.\n" +
    "2. If empty AND the Worker raw text contains <tool_call>/JSON tool-call markup, treat that markup as the Worker's intended invocation (text-emitted tool calls are valid per the syntax matrix below).\n" +
    "3. Apply the decision rule to the combination of binding + text-emitted tool calls.\n" +
    "4. Reply with a single line of JSON: {\"judgment\":\"PASS\"|\"FAIL\",\"reason\":\"<=80 chars>\"}.\n\n" +
    'No markdown, no preamble, no chain-of-thought.';

  const bindingNote =
    bindingToolCalls.length > 0
      ? `\n## Provider-bound tool_calls (harness ground truth — read this first)\n${JSON.stringify(bindingToolCalls)}\n`
      : '\n## Provider-bound tool_calls (harness ground truth — read this first)\n(none — model emitted any tools via text markup only; scan the raw text for <tool_call>/JSON shapes)\n';

  const syntaxNote =
    'Treat ANY of the following as VALID tool invocations (syntax varies across families):\n' +
    '  - `tool_name(args)` fn-call form\n' +
    '  - `<tool_call>{"name":"tool_name", ...}</tool_call>` JSON-in-XML (OpenAI canonical)\n' +
    '  - `<tool_name>...</tool_name>` XML-tag form\n' +
    '  - `<tool_name>tool_name</tool_name>` zhipu nested XML\n' +
    '  - `tool_name:N>{json}` / `tool_name:N{json}` kimi colon-N form\n' +
    '  - `[TOOL_CALL]{tool => "tool_name", args => {...}}[/TOOL_CALL]` mmx bracket-arrow\n' +
    '  - `<tool_call>tool_name<arg_key>...</arg_key>...</tool_call>` ark hybrid\n' +
    '\n' +
    'Treat as INVALID (does NOT count as a tool invocation):\n' +
    '  - Pure text intent ("I will call X next") with NO syntax markup\n' +
    '  - Severely malformed syntax that no production runtime could parse\n';

  const userPrompt =
    TOOL_DOCS_NOTE +
    'Below is one Worker response to a mid-task user message; judge it per the decision rule.\n\n' +
    `## Case: ${spec.id} (${spec.polarity})\n${spec.description}\n\n` +
    `## User turn that triggered the response\n[USER]\n${userMessage}\n\n` +
    `## Decision rule\n${caseDecisionRule(spec)}\n\n${syntaxNote}\n${bindingNote}\n` +
    `## Worker raw response\n--- BEGIN ---\n${workerResponse}\n--- END ---\n\n` +
    `Reply exactly one line of JSON in this shape:\n` +
    `  {"judgment":"PASS","reason":"<<=80 chars>"}\n` +
    `or\n` +
    `  {"judgment":"FAIL","reason":"<<=80 chars>"}`;
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

describe('Audit: FEATURE_104 v0.7.42 hygiene LLM-judge majority-vote (anti-pattern 7 §3)', () => {
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
    'audits all raw outputs with 3-judge majority vote (per case × variant × alias × run)',
    // 60-min cap: 450 LLM calls × ~6s = ~45 min worst case.
    { timeout: 60 * 60_000 },
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
