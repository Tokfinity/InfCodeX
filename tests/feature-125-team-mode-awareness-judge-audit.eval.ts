/**
 * LLM-judge audit driver for FEATURE_125 (v0.7.41) Team Mode awareness
 * Layer 2 panel.
 *
 * Enforces EVAL_GUIDELINES anti-pattern 7 §3 strict clause + the
 * 2026-05-12 judge-model-selection clause: panel-internal multi-judge
 * majority vote (zhipu/glm51 + ds/v4pro + kimi-code, 2/3 majority).
 *
 * ## Input
 *
 * Reads the 50 raw outputs (5 alias × 5 run × 2 case) dumped at
 * `os.tmpdir()/kodax-eval-dumps/feature-125-team-mode-awareness/<case>.json`
 * by `tests/feature-125-team-mode-awareness.eval.ts`.
 *
 * Schema (FEATURE_125 — flat `aliases[].runs[]`, no `variants` wrapper):
 *
 *   { case, expectReadTarget, siblingPid, systemPrompt, userMessage,
 *     priorMessages, aliases: [{ alias, runs: [{ runIndex, text,
 *     toolCalls, regexPassed, regexJudges }] }] }
 *
 * ## Judge contract
 *
 * For each run, ask each of the 3 judge aliases independently (CLEAN
 * context — judge sees only the user task + raw response, never the
 * regex outcome or self-judge verdict) to decide PASS/FAIL on the
 * PRIMARY assertion:
 *
 *   PASS iff:
 *     - The response invokes `read` (any syntax form — fn-call, JSON
 *       payload, XML tag, kimi `read:N>{}`, mmx `[TOOL_CALL]{tool=>read}`,
 *       ark `<tool_call>read<arg_key>` etc.) AND
 *     - The read target file matches `expectReadTarget`           AND
 *     - No `edit` / `write` / `multi_edit` invocation appears BEFORE
 *       the `read` in the response.
 *   FAIL otherwise — including narrate-without-tool (intent statement
 *   with no actual tool-call markup), wrong tool (e.g. `cat` shell
 *   command instead of `read` tool), or mutation before read.
 *
 * Aggregation: 2/3 majority decides; ties (1 PASS / 1 FAIL / 1 UNCLEAR-
 * parse-error) fall to UNCLEAR.
 *
 * ## Output
 *
 * Audit dump at `os.tmpdir()/kodax-eval-dumps/
 * feature-125-team-mode-awareness-judge-audit/<case>.json` AND a console
 * summary comparing broader-regex pass-rate vs LLM-judge majority-vote
 * pass-rate per (case, alias). Per anti-pattern 7 §3: disagreement
 * >10% → eval-data invalid → regex / judge design needs redesign.
 *
 * ## Cost
 *
 *   50 runs × 3 judges = 150 LLM calls × ~$0.005-0.01/call ≈ $1-2
 *
 * ## Run
 *
 *   npm run test:eval -- feature-125-team-mode-awareness-judge-audit
 *
 * Skips when any of the 3 judge API keys are missing (majority vote
 * requires all 3 votes).
 *
 * ## Judge panel rationale (per EVAL_GUIDELINES §Judge model selection)
 *
 *   - zhipu/glm51 — zhipu family (overlaps with judged panel, but
 *     majority vote across 3 independent families breaks same-family
 *     bias even when one judge happens to share family with one judged
 *     alias; audit dump records each judge's raw verdict for post-hoc
 *     bias analysis if pass-rates look suspicious)
 *   - ds/v4pro — deepseek family
 *   - kimi — moonshot family
 *
 * Forbidden per EVAL_GUIDELINES: anthropic/openai (judge bias against
 * panel distribution; orchestrating Claude in main session is allowed
 * as Layer A self-judge but not as Layer B panel judge).
 *
 * ## See also
 *
 *   - tests/feature-165-handoff-wait-gate-judge-audit.eval.ts (sibling
 *     pattern; FEATURE_165 audit used same 3-judge majority on 250
 *     cells, 0.8% disagreement → DATA VALID)
 *   - %LOCALAPPDATA%/Temp/kodax-eval-dumps/feature-125-team-mode-
 *     awareness-self-judge-audit/SUMMARY.json (Layer A self-judge by
 *     orchestrating Claude — 2.0% disagreement vs broader regex)
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
} from '../benchmark/datasets/feature-125-team-mode-awareness/cases.js';

const DUMP_SOURCE_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'feature-125-team-mode-awareness');
const AUDIT_DUMP_ROOT = join(
  tmpdir(),
  'kodax-eval-dumps',
  'feature-125-team-mode-awareness-judge-audit',
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

interface DumpFile {
  readonly case: CaseId;
  readonly expectReadTarget: string;
  readonly siblingPid: number;
  readonly userMessage: string;
  readonly aliases: readonly DumpAlias[];
}

function buildJudgePrompt(
  spec: CaseSpec,
  userMessage: string,
  workerResponse: string,
  bindingToolCalls: ReadonlyArray<{ name: string; input: unknown }>,
): { systemPrompt: string; userMessage: string } {
  const systemPrompt =
    "You are an independent judge auditing a coding agent's tool-call behavior. " +
    'Reply with a single JSON object on one line — no markdown, no preamble.';

  const bindingNote =
    bindingToolCalls.length > 0
      ? `\n## Provider-bound tool_calls (harness ground truth)\n${JSON.stringify(bindingToolCalls)}\n`
      : '\n## Provider-bound tool_calls (harness ground truth)\n(none — model emitted tools via text only)\n';

  const syntaxNote =
    'Treat any of the following as VALID `read` invocations (syntax varies across families):\n' +
    '  - `read(args)` / `read({path: "..."})` fn-call form\n' +
    '  - `<tool_call>{"name":"read", ...}</tool_call>` JSON-in-XML (OpenAI canonical)\n' +
    '  - `<read>...</read>` / `<read path="..." />` XML-tag form\n' +
    '  - `<tool_name>read</tool_name>` zhipu nested XML\n' +
    '  - `<tool>read</tool>` kimi XML alt\n' +
    '  - `read:N>{json}` / `read:N{json}` kimi colon-N form (N = serial digit)\n' +
    '  - `[TOOL_CALL]{tool => "read", args => {...}}[/TOOL_CALL]` mmx bracket-arrow\n' +
    '  - `<tool_call>read<arg_key>path</arg_key>...</tool_call>` ark hybrid\n' +
    '\n' +
    'Treat these as INVALID (FAIL):\n' +
    '  - Text-only intent statement with NO tool-call markup ("I will read the file...")\n' +
    '  - Severely malformed syntax that no production runtime could parse (broken JSON, no closing tag)\n' +
    '  - A different tool (e.g. `cat` shell command instead of `read` tool)\n';

  const userPrompt =
    `An agent (the "Worker") is in an AMA coding workflow with a system prompt containing a ` +
    `"=== Other active KodaX sessions ===" block describing sibling KodaX session pid ${spec.siblingPid} ` +
    `that is actively editing or recently modified \`${spec.expectReadTarget}\`. The block does NOT mandate ` +
    `a specific action — it tells the Worker to "use your judgment". The PRIMARY assertion of this eval ` +
    `is that the Worker should defensively re-read the sibling-flagged file FIRST before any edit.\n\n` +
    `## Case: ${spec.id}\n${spec.description}\n\n` +
    `## Final user turn\n[USER]\n${userMessage}\n\n` +
    `## Decision rule (PRIMARY assertion)\n` +
    `PASS iff the response invokes \`read\` on \`${spec.expectReadTarget}\` AND no mutation (edit / write / multi_edit) ` +
    `appears before the read. Narrate-without-tool (intent + no actual tool-call markup) is FAIL. ` +
    `Wrong tool (e.g. \`cat\` shell command) is FAIL.\n\n${syntaxNote}\n${bindingNote}\n` +
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

describe('Audit: FEATURE_125 Team Mode awareness LLM-judge majority-vote (anti-pattern 7 §3)', () => {
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
    'audits all 50 raw outputs with 3-judge majority vote (per case × alias × run)',
    // 30-min cap: 150 LLM calls × ~7s = ~17 min typical, 30 min worst case.
    { timeout: 30 * 60_000 },
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
        summary.push(`\n[judge-audit][${c.id}] expectReadTarget=${dump.expectReadTarget}`);
        summary.push(`  judges: ${judges.join(', ')} (2/3 majority vote)`);

        const auditAliases: Array<{
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
        }> = [];

        for (const a of dump.aliases) {
          const rows: typeof auditAliases[number]['rows'] = [];
          for (const r of a.runs) {
            const { systemPrompt, userMessage } = buildJudgePrompt(
              c,
              dump.userMessage,
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
          auditAliases.push({
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

        const auditPath = join(AUDIT_DUMP_ROOT, `${c.id}.json`);
        writeFileSync(
          auditPath,
          JSON.stringify(
            {
              case: c.id,
              expectReadTarget: dump.expectReadTarget,
              siblingPid: dump.siblingPid,
              judges,
              aliases: auditAliases,
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

      // Final overall disagreement-rate verdict per anti-pattern 7 §3.
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
