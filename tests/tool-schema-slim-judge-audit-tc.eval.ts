/**
 * Continuation audit — only the cases that weren't completed by the
 * main audit driver before its 1-hour timeout:
 *   - AUQ_6_boundary_no_cram
 *   - TC_1_positive_mid_task
 *   - TC_3_negative_initial
 *   - TC_4_negative_trivial
 *
 * Same rules: panel-internal 3-judge majority, see binding tool_calls,
 * disagreement >10% → data invalid.
 */

import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it } from 'vitest';

import { availableAliases, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runOneShot } from '../benchmark/harness/harness.js';

const DUMP_SOURCE_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'tool-schema-slim');
const AUDIT_DUMP_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'tool-schema-slim-judge-audit');

const JUDGES: readonly ModelAlias[] = ['kimi', 'zhipu/glm51', 'ds/v4flash'] as const;

const REMAINING_CASES = [
  'AUQ_6_boundary_no_cram',
  'TC_1_positive_mid_task',
  'TC_3_negative_initial',
  'TC_4_negative_trivial',
] as const;

interface DumpRun {
  readonly runIndex: number;
  readonly text: string;
  readonly toolCalls: ReadonlyArray<{ name: string; input: unknown }>;
  readonly regexPassed: boolean;
  readonly regexJudges: ReadonlyArray<{ name: string; passed: boolean; reason?: string }>;
}

interface DumpAlias { readonly alias: string; readonly runs: readonly DumpRun[]; }
interface DumpVariant { readonly variantId: string; readonly aliases: readonly DumpAlias[]; }
interface DumpFile {
  readonly case: string;
  readonly polarity: 'positive' | 'negative' | 'boundary';
  readonly userMessage: string;
  readonly priorMessages?: ReadonlyArray<{ role: string; content: string }>;
  readonly variants: readonly DumpVariant[];
}

function describeAssertion(judgeName: string): string {
  if (judgeName === 'must_call_ask_user_question') return 'The model invoked the `ask_user_question` tool (any syntax).';
  if (judgeName === 'must_not_call_ask_user_question') return 'The model did NOT invoke `ask_user_question`.';
  if (judgeName === 'uses_questions_array_for_multi') return 'The model invoked `ask_user_question` AND used the `questions` array shape with ≥2 items.';
  if (judgeName === 'uses_kind_input_for_freetext') return 'The model invoked `ask_user_question` AND set `kind:"input"`.';
  if (judgeName === 'must_call_todo_create') return 'The model invoked the `todo_create` tool (any syntax).';
  if (judgeName === 'must_not_call_todo_create') return 'The model did NOT invoke `todo_create`.';
  if (judgeName === 'must_not_call_todo_update') return 'The model did NOT invoke `todo_update`.';
  if (judgeName === 'todo_create_has_activeForm') return 'The model invoked `todo_create` AND supplied a non-empty `activeForm` field.';
  if (judgeName === 'todo_create_no_id_field') return 'If `todo_create` was called, it was called WITHOUT an `id` field.';
  if (judgeName === 'prefers_todo_update_init_for_initial_plan') return 'The model committed the initial plan via `todo_update({op:"init"})` NOT per-item `todo_create`.';
  return `Unknown: ${judgeName}`;
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
  const systemPrompt = "You are an independent judge. Reply with exactly one JSON line.";
  const bindingNote = bindingToolCalls.length > 0
    ? `## HARNESS CONTEXT: provider-bound tool_calls (ground truth)\n${JSON.stringify(bindingToolCalls)}\n`
    : '## HARNESS CONTEXT: provider-bound tool_calls (ground truth)\n(none)\n';
  const priorNote = priorMessages && priorMessages.length > 0
    ? `## Prior conversation\n${priorMessages.map((m) => `[${m.role.toUpperCase()}]\n${m.content}`).join('\n\n')}\n\n`
    : '';
  const userPrompt =
    `## Case: ${caseId} (polarity=${polarity})\n${priorNote}` +
    `## Final user turn\n[USER]\n${userMessage}\n\n` +
    `## ASSERTION TO JUDGE\n${describeAssertion(judgeName)}\n\n` +
    `${bindingNote}\n` +
    `## Agent raw response\n--- BEGIN ---\n${workerText}\n--- END ---\n\n` +
    `Reply exactly one JSON line:\n  {"judgment":"PASS","reason":"..."}\nor\n  {"judgment":"FAIL","reason":"..."}`;
  return { systemPrompt, userMessage: userPrompt };
}

interface JudgeVerdict {
  readonly judgment: 'PASS' | 'FAIL' | 'UNCLEAR';
  readonly reason: string;
  readonly rawJudgeText: string;
}

function parseJudgeReply(raw: string): JudgeVerdict {
  const m = raw.match(/\{[\s\S]*?\}/);
  if (!m) return { judgment: 'UNCLEAR', reason: 'no JSON', rawJudgeText: raw };
  try {
    const obj = JSON.parse(m[0]) as { judgment?: string; reason?: string };
    const j = (obj.judgment ?? '').toUpperCase();
    if (j === 'PASS' || j === 'FAIL') return { judgment: j, reason: obj.reason ?? '', rawJudgeText: raw };
    return { judgment: 'UNCLEAR', reason: `unrec=${obj.judgment}`, rawJudgeText: raw };
  } catch { return { judgment: 'UNCLEAR', reason: 'parse error', rawJudgeText: raw }; }
}

function majorityVote(verdicts: readonly JudgeVerdict[]): 'PASS' | 'FAIL' | 'UNCLEAR' {
  let p = 0, f = 0;
  for (const v of verdicts) { if (v.judgment === 'PASS') p++; else if (v.judgment === 'FAIL') f++; }
  if (p >= 2) return 'PASS';
  if (f >= 2) return 'FAIL';
  return 'UNCLEAR';
}

describe('Audit (TC continuation): tool-schema-slim — AUQ_6 + TC_1 + TC_3 + TC_4', () => {
  const judges = availableAliases(...JUDGES);
  if (judges.length < JUDGES.length) {
    it(`skips: need 3 judge keys`, () => {});
    return;
  }

  for (const caseId of REMAINING_CASES) {
    it(`audit ${caseId}`, { timeout: 45 * 60_000 }, async () => {
      mkdirSync(AUDIT_DUMP_ROOT, { recursive: true });
      const dumpPath = join(DUMP_SOURCE_ROOT, `${caseId}.json`);
      if (!existsSync(dumpPath)) {
        // eslint-disable-next-line no-console
        console.log(`[judge-audit-tc][${caseId}] SKIP — no dump`);
        return;
      }
      const dump = JSON.parse(readFileSync(dumpPath, 'utf8')) as DumpFile;
      const summary: string[] = [];
      summary.push(`\n[judge-audit-tc][${caseId}] polarity=${dump.polarity}`);
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
                caseId, dump.polarity, jr.name, dump.userMessage, dump.priorMessages, r.text, r.toolCalls,
              );
              const verdicts: Record<string, JudgeVerdict> = {};
              for (const judge of judges) {
                try {
                  const result = await runOneShot(judge, { systemPrompt, userMessage });
                  verdicts[judge] = parseJudgeReply(result.text);
                } catch (err) {
                  verdicts[judge] = { judgment: 'UNCLEAR', reason: `${err}`, rawJudgeText: '' };
                }
              }
              const majority = majorityVote(Object.values(verdicts));
              const agreesWithRegex = (majority === 'PASS') === jr.passed;
              assertions[jr.name] = { regexPassed: jr.passed, verdicts, majority, agreesWithRegex };
            }
            aliasEntry.rows.push({ runIndex: r.runIndex, assertions });
          }
          va.aliases.push(aliasEntry);
        }
        auditVariants.push(va);
      }

      // Per-variant summary
      for (const v of auditVariants) {
        let total = 0, disagree = 0, unclear = 0;
        for (const a of v.aliases) for (const row of a.rows) for (const ax of Object.values(row.assertions)) {
          total++;
          if (ax.majority === 'UNCLEAR') unclear++;
          else if (!ax.agreesWithRegex) disagree++;
        }
        const rate = total === 0 ? 0 : (disagree / total) * 100;
        summary.push(`  variant=${v.variantId}: ${total} assertions, ${disagree} disagree (${rate.toFixed(1)}%), ${unclear} unclear`);
      }
      // eslint-disable-next-line no-console
      console.log(summary.join('\n'));

      writeFileSync(
        join(AUDIT_DUMP_ROOT, `${caseId}.json`),
        JSON.stringify({ case: caseId, polarity: dump.polarity, judges, variants: auditVariants }, null, 2),
        'utf8',
      );
    });
  }
});
