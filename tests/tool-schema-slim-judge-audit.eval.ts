/**
 * LLM-judge audit driver for tool-schema-slim Layer 2 panel.
 *
 * Per EVAL_GUIDELINES anti-pattern 7 §3 + 2026-05-12 judge-model-selection
 * clause: panel-internal multi-judge majority vote (kimi + zhipu/glm52 +
 * ds/v4flash, 2/3 majority). Per `feedback_audit_must_see_binding` the
 * judge prompt includes harness-captured tool_call binding so it can
 * distinguish binding-only output (text=""/empty) from "no tool".
 *
 * ## Input
 *
 *   `os.tmpdir()/kodax-eval-dumps/tool-schema-slim/<case>.json`
 *   shape: { case, polarity, variants: [{ variantId, aliases: [{ alias,
 *           runs: [{ runIndex, text, toolCalls, regexPassed, ...}]}]}]}
 *
 * ## Decision rule
 *
 * Encoded per (case × judge_name) — mirrors the regex judges in
 * cases.ts so an LLM judge can sanity-check each regex assertion.
 * Multiple judge axes per case → one majority vote per axis.
 *
 * ## Sample size
 *
 *   9 cases × 3 variants × 4 alias × 5 run = 540 cells. Each cell has
 *   1-3 judge axes. Average ≈ 1.5 axes → ~810 judge calls × 3 judges
 *   = ~2430 LLM calls. Cost cap: ~$5-10.
 *
 *   To stay within budget, this driver only audits cells where the
 *   regex made a non-trivial call (i.e. there's actual signal worth
 *   second-checking) — pure trivial 0/0 cells are skipped.
 *
 * ## Output
 *
 *   `os.tmpdir()/kodax-eval-dumps/tool-schema-slim-judge-audit/<case>.json`
 *   plus a SUMMARY.json with overall regex-vs-LLM agreement %.
 *
 * Disagreement >10% → eval data invalid → regex / case design redo.
 *
 * ## Run
 *
 *   npm run test:eval -- tool-schema-slim-judge-audit
 */

import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it } from 'vitest';

import { availableAliases, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runOneShot } from '../benchmark/harness/harness.js';
import { CASES } from '../benchmark/datasets/tool-schema-slim/cases.js';

const DUMP_SOURCE_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'tool-schema-slim');
const AUDIT_DUMP_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'tool-schema-slim-judge-audit');

const JUDGES: readonly ModelAlias[] = ['kimi', 'zhipu/glm52', 'ds/v4flash'] as const;

interface DumpRun {
  readonly runIndex: number;
  readonly text: string;
  readonly toolCalls: ReadonlyArray<{ name: string; input: unknown }>;
  readonly regexPassed: boolean;
  readonly regexJudges: ReadonlyArray<{ name: string; passed: boolean; reason?: string }>;
}

interface DumpAlias {
  readonly alias: string;
  readonly runs: readonly DumpRun[];
}

interface DumpVariant {
  readonly variantId: string;
  readonly aliases: readonly DumpAlias[];
}

interface DumpFile {
  readonly case: string;
  readonly polarity: 'positive' | 'negative' | 'boundary';
  readonly userMessage: string;
  readonly priorMessages?: ReadonlyArray<{ role: string; content: string }>;
  readonly variants: readonly DumpVariant[];
}

/**
 * Encode the assertion question per judge-axis name. The judge gets
 * a single yes/no question to answer based on raw text + tool_calls.
 */
function describeAssertion(judgeName: string): string {
  if (judgeName === 'must_call_ask_user_question') {
    return 'The model invoked the `ask_user_question` tool (any syntax: fn-call form, JSON-in-XML, raw XML, kimi `read:N>{}`, mmx `[TOOL_CALL]`, ark hybrid, or the harness-captured binding contains a tool_call with name="ask_user_question").';
  }
  if (judgeName === 'must_not_call_ask_user_question') {
    return 'The model did NOT invoke `ask_user_question` (no tool_call binding for it AND no text-form invocation).';
  }
  if (judgeName === 'uses_questions_array_for_multi') {
    return 'The model invoked `ask_user_question` AND used the `questions` array shape with ≥2 items (not concatenating multiple questions into a single `question` string).';
  }
  if (judgeName === 'uses_kind_input_for_freetext') {
    return 'The model invoked `ask_user_question` AND set `kind:"input"` to request a free-text answer (instead of giving options).';
  }
  if (judgeName === 'must_call_todo_create') {
    return 'The model invoked the `todo_create` tool (any syntax).';
  }
  if (judgeName === 'must_not_call_todo_create') {
    return 'The model did NOT invoke `todo_create`.';
  }
  if (judgeName === 'must_not_call_todo_update') {
    return 'The model did NOT invoke `todo_update`.';
  }
  if (judgeName === 'todo_create_has_activeForm') {
    return 'The model invoked `todo_create` AND supplied a non-empty `activeForm` field in the call arguments.';
  }
  if (judgeName === 'todo_create_no_id_field') {
    return 'If `todo_create` was called, it was called WITHOUT an `id` field (the field is forbidden — auto-generated).';
  }
  if (judgeName === 'prefers_todo_update_init_for_initial_plan') {
    return 'The model committed the initial plan via `todo_update({op:"init", items:[...]})` (preferred for batch seed), NOT by calling `todo_create` multiple times for each item.';
  }
  return `Unknown judge axis: ${judgeName}`;
}

function buildJudgePrompt(
  caseId: string,
  polarity: string,
  judgeName: string,
  userMessage: string,
  priorMessages: ReadonlyArray<{ role: string; content: string }> | undefined,
  workerText: string,
  bindingToolCalls: ReadonlyArray<{ name: string; input: unknown }>,
): { systemPrompt: string; userMessage: string } {
  const systemPrompt =
    "You are an independent judge auditing whether a coding agent's response satisfies a specific assertion. " +
    'Reply with exactly one JSON object on one line — no markdown, no preamble.';

  const bindingNote =
    bindingToolCalls.length > 0
      ? `## HARNESS CONTEXT: provider-bound tool_calls (ground truth — present even when model text is empty)\n${JSON.stringify(bindingToolCalls)}\n`
      : '## HARNESS CONTEXT: provider-bound tool_calls (ground truth)\n(none — no tool_call captured by harness binding)\n';

  const priorNote = priorMessages && priorMessages.length > 0
    ? `## Prior conversation\n${priorMessages.map((m) => `[${m.role.toUpperCase()}]\n${m.content}`).join('\n\n')}\n\n`
    : '';

  const userPrompt =
    `## Case: ${caseId} (polarity=${polarity})\n` +
    `${priorNote}` +
    `## Final user turn\n[USER]\n${userMessage}\n\n` +
    `## ASSERTION TO JUDGE\n${describeAssertion(judgeName)}\n\n` +
    `${bindingNote}\n` +
    `## Agent raw response\n--- BEGIN ---\n${workerText}\n--- END ---\n\n` +
    `Reply exactly one line of JSON:\n` +
    `  {"judgment":"PASS","reason":"<≤80 chars why assertion holds>"}\n` +
    `or\n` +
    `  {"judgment":"FAIL","reason":"<≤80 chars why assertion fails>"}`;
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
    return { judgment: 'UNCLEAR', reason: `unrecognized judgment="${obj.judgment}"`, rawJudgeText: raw };
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

describe('Audit: tool-schema-slim LLM-judge majority-vote (anti-pattern 7 §3)', () => {
  const judges = availableAliases(...JUDGES);
  if (judges.length < JUDGES.length) {
    it(
      `skips: need all 3 judge keys (${JUDGES.join(', ')}); have ${judges.join(', ') || '(none)'}`,
      () => {},
    );
    return;
  }

  it(
    'audits raw dumps with 3-judge majority vote per (case × variant × alias × run × judge_axis)',
    { timeout: 60 * 60_000 },
    async () => {
      mkdirSync(AUDIT_DUMP_ROOT, { recursive: true });

      const overall = {
        totalAssertions: 0,
        agreeWithRegex: 0,
        disagreeWithRegex: 0,
        unclear: 0,
      };

      for (const c of CASES) {
        const dumpPath = join(DUMP_SOURCE_ROOT, `${c.id}.json`);
        if (!existsSync(dumpPath)) {
          // eslint-disable-next-line no-console
          console.log(`[judge-audit][${c.id}] SKIP — dump missing at ${dumpPath}`);
          continue;
        }
        const dump = JSON.parse(readFileSync(dumpPath, 'utf8')) as DumpFile;

        const summary: string[] = [];
        summary.push(`\n[judge-audit][${c.id}] polarity=${c.polarity}`);
        summary.push(`  judges: ${judges.join(', ')} (2/3 majority)`);

        const auditVariants: Array<{
          variantId: string;
          aliases: Array<{
            alias: string;
            rows: Array<{
              runIndex: number;
              assertions: Record<string, {
                regexPassed: boolean;
                verdicts: Record<string, JudgeVerdict>;
                majority: 'PASS' | 'FAIL' | 'UNCLEAR';
                agreesWithRegex: boolean;
              }>;
            }>;
          }>;
        }> = [];

        for (const v of dump.variants) {
          const va: typeof auditVariants[number] = { variantId: v.variantId, aliases: [] };
          for (const a of v.aliases) {
            const aliasEntry: typeof va.aliases[number] = { alias: a.alias, rows: [] };
            for (const r of a.runs) {
              const assertions: typeof aliasEntry.rows[number]['assertions'] = {};
              for (const jr of r.regexJudges) {
                const { systemPrompt, userMessage } = buildJudgePrompt(
                  c.id,
                  c.polarity,
                  jr.name,
                  dump.userMessage,
                  dump.priorMessages,
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
                const agreesWithRegex = majorityPasses === jr.passed;
                assertions[jr.name] = {
                  regexPassed: jr.passed,
                  verdicts,
                  majority,
                  agreesWithRegex,
                };
                overall.totalAssertions++;
                if (majority === 'UNCLEAR') overall.unclear++;
                else if (agreesWithRegex) overall.agreeWithRegex++;
                else overall.disagreeWithRegex++;
              }
              aliasEntry.rows.push({ runIndex: r.runIndex, assertions });
            }
            va.aliases.push(aliasEntry);
          }
          auditVariants.push(va);
        }

        // Per-variant disagreement summary
        for (const v of auditVariants) {
          let assertions = 0;
          let disagrees = 0;
          let unclears = 0;
          for (const a of v.aliases) {
            for (const row of a.rows) {
              for (const ax of Object.values(row.assertions)) {
                assertions++;
                if (ax.majority === 'UNCLEAR') unclears++;
                else if (!ax.agreesWithRegex) disagrees++;
              }
            }
          }
          const disagRate = assertions === 0 ? 0 : (disagrees / assertions) * 100;
          summary.push(
            `  variant=${v.variantId}: ${assertions} assertions, ${disagrees} disagree (${disagRate.toFixed(1)}%), ${unclears} unclear`,
          );
        }
        // eslint-disable-next-line no-console
        console.log(summary.join('\n'));

        const auditDump = {
          case: c.id,
          polarity: c.polarity,
          judges,
          variants: auditVariants,
        };
        writeFileSync(
          join(AUDIT_DUMP_ROOT, `${c.id}.json`),
          JSON.stringify(auditDump, null, 2),
          'utf8',
        );
      }

      const overallDisagRate = overall.totalAssertions === 0
        ? 0
        : (overall.disagreeWithRegex / overall.totalAssertions) * 100;
      const lines = [
        '',
        '==========================================',
        '[judge-audit][tool-schema-slim] OVERALL SUMMARY',
        '==========================================',
        `  total assertions: ${overall.totalAssertions}`,
        `  agree with regex: ${overall.agreeWithRegex}`,
        `  disagree:         ${overall.disagreeWithRegex} (${overallDisagRate.toFixed(1)}%)`,
        `  unclear:          ${overall.unclear}`,
        `  DATA VALIDITY:    ${overallDisagRate <= 10 ? 'VALID (≤10% threshold)' : 'INVALID (>10% — eval data unreliable)'}`,
      ];
      // eslint-disable-next-line no-console
      console.log(lines.join('\n'));
      writeFileSync(
        join(AUDIT_DUMP_ROOT, 'SUMMARY.json'),
        JSON.stringify(
          { judges, overall, overallDisagRate, valid: overallDisagRate <= 10 },
          null,
          2,
        ),
        'utf8',
      );
    },
  );
});
