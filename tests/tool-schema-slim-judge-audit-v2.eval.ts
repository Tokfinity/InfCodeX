/**
 * Audit v2 — re-audit AUQ_6 + TC_1 with binding-as-ground-truth prompt fix.
 *
 * The v1 audit driver had high disagreement (AUQ_6: 85-97.5%, TC_1: 18-30%)
 * because the judge prompt put binding in a "HARNESS CONTEXT" section
 * without strong emphasis that binding OVERRIDES text. Judges defaulted
 * to text-priority and returned FAIL whenever raw text was empty, even
 * when binding clearly showed the tool_call.
 *
 * Per `feedback_audit_must_see_binding` (MEMORY 2026-05-16, same root
 * cause): "audit prompt 必须包含 HARNESS CONTEXT 段告诉 judge binding
 * 捕获了哪个 tool. 看 disagreement reason 若全是 'no tool invocation'
 * + binding 字段非空，是 audit bug 不是 eval 废数据".
 *
 * v2 fix: rewrite the assertion description + system prompt to make
 * binding ABSOLUTE ground truth, and include explicit instruction
 * that empty text + non-empty binding = tool WAS invoked.
 *
 * Scope: only AUQ_6 + TC_1 (the 2 cases with prompt-bug-induced
 * disagreement). AUQ_1-5 already passed with 0% disagreement, TC_3 is
 * known case-design broken, TC_4 already 0% disagreement.
 */

import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it } from 'vitest';

import { availableAliases, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runOneShot } from '../benchmark/harness/harness.js';

const DUMP_SOURCE_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'tool-schema-slim');
const AUDIT_DUMP_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'tool-schema-slim-judge-audit-v2');

const JUDGES: readonly ModelAlias[] = ['kimi', 'zhipu/glm52', 'ds/v4flash'] as const;

const CASES_TO_AUDIT = ['AUQ_6_boundary_no_cram', 'TC_1_positive_mid_task'] as const;

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
  if (judgeName === 'must_call_ask_user_question') return 'The model invoked the `ask_user_question` tool.';
  if (judgeName === 'must_not_call_ask_user_question') return 'The model did NOT invoke `ask_user_question`.';
  if (judgeName === 'uses_questions_array_for_multi') return 'The model invoked `ask_user_question` AND used the `questions` array shape with ≥2 items.';
  if (judgeName === 'uses_kind_input_for_freetext') return 'The model invoked `ask_user_question` AND set `kind:"input"`.';
  if (judgeName === 'must_call_todo_create') return 'The model invoked the `todo_create` tool.';
  if (judgeName === 'must_not_call_todo_create') return 'The model did NOT invoke `todo_create`.';
  if (judgeName === 'must_not_call_todo_update') return 'The model did NOT invoke `todo_update`.';
  if (judgeName === 'todo_create_has_activeForm') return 'The model invoked `todo_create` AND supplied a non-empty `activeForm` field.';
  if (judgeName === 'todo_create_no_id_field') return 'If `todo_create` was called, it was called WITHOUT an `id` field.';
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
  // STRONG binding-priority system prompt — fixes v1 audit bug where
  // judges defaulted to text-priority.
  const systemPrompt =
    "You are an independent judge auditing whether a coding agent's response satisfies a specific assertion.\n" +
    "\n" +
    "CRITICAL RULE — TOOL INVOCATION GROUND TRUTH:\n" +
    "  The provider-bound `toolCalls` array is ABSOLUTE ground truth for whether a tool was invoked.\n" +
    "  - If `toolCalls` contains an entry with `name=\"X\"`, then tool X WAS INVOKED. Period. No exceptions.\n" +
    "  - This is true EVEN IF the agent's raw text response is empty, contains no tool-call markup, or is in natural language only.\n" +
    "  - Some providers (zhipu, mmx, kimi in binding mode) emit tool_calls via the provider's native channel without echoing them in text.\n" +
    "  - The harness captures these via the provider SDK. The captured binding IS the invocation.\n" +
    "\n" +
    "Workflow for each assertion:\n" +
    "  1. Read the `toolCalls` array (provided below as `## TOOL_CALLS_BINDING`). This is ground truth.\n" +
    "  2. If the assertion is about WHETHER a tool was called → answer based on `toolCalls` alone. Empty text DOES NOT mean no tool.\n" +
    "  3. If the assertion is about the TOOL CALL'S ARGUMENTS (e.g. `kind:\"input\"`, `activeForm` field, `questions` array) → inspect the `input` object inside the corresponding `toolCalls` entry.\n" +
    "  4. The raw text is supplementary context only — useful for negative-case judgments (\"did NOT call\") to confirm no text-form invocation was attempted instead. But when binding is non-empty, binding decides.\n" +
    "\n" +
    "Reply with exactly one JSON line: `{\"judgment\":\"PASS\",\"reason\":\"...\"}` or `{\"judgment\":\"FAIL\",\"reason\":\"...\"}`. No markdown, no preamble.";

  const bindingNote = `## TOOL_CALLS_BINDING (ABSOLUTE GROUND TRUTH — read this first)\n${JSON.stringify(bindingToolCalls, null, 2)}\n`;

  const priorNote = priorMessages && priorMessages.length > 0
    ? `## Prior conversation\n${priorMessages.map((m) => `[${m.role.toUpperCase()}]\n${m.content}`).join('\n\n')}\n\n`
    : '';

  const userPrompt =
    `## Case: ${caseId} (polarity=${polarity})\n${priorNote}` +
    `## Final user turn\n[USER]\n${userMessage}\n\n` +
    `## ASSERTION TO JUDGE\n${describeAssertion(judgeName)}\n\n` +
    `${bindingNote}\n` +
    `## Agent raw text (SUPPLEMENTARY — empty text does NOT mean no tool; binding above is ground truth)\n--- BEGIN ---\n${workerText}\n--- END ---\n\n` +
    `Apply the CRITICAL RULE: binding is ground truth.\n` +
    `Reply exactly one JSON line.`;
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

describe('Audit v2 (binding-priority prompt fix): tool-schema-slim — AUQ_6 + TC_1', () => {
  const judges = availableAliases(...JUDGES);
  if (judges.length < JUDGES.length) {
    it(`skips: need 3 judge keys`, () => {});
    return;
  }

  for (const caseId of CASES_TO_AUDIT) {
    it(`audit-v2 ${caseId}`, { timeout: 60 * 60_000 }, async () => {
      mkdirSync(AUDIT_DUMP_ROOT, { recursive: true });
      const dumpPath = join(DUMP_SOURCE_ROOT, `${caseId}.json`);
      if (!existsSync(dumpPath)) {
        // eslint-disable-next-line no-console
        console.log(`[audit-v2][${caseId}] SKIP — no dump`);
        return;
      }
      const dump = JSON.parse(readFileSync(dumpPath, 'utf8')) as DumpFile;
      const summary: string[] = [];
      summary.push(`\n[audit-v2][${caseId}] polarity=${dump.polarity} (binding-priority prompt)`);
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
