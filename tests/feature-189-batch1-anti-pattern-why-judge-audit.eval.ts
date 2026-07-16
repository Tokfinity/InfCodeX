/**
 * LLM-judge audit driver for FEATURE_189 Batch 1 ✗ 加 WHY pilot.
 *
 * 3-judge majority vote (zhipu/glm51 + ark/v4pro + kimi) per
 * `feedback_audit_must_see_binding` + `feedback_audit_binding_priority_in_prompt`.
 * Re-judges 4 case-specific anti-pattern compliance questions on each
 * pilot run.
 *
 * Reads pilot dumps from `feature-189-batch1-anti-pattern-why-pilot/`,
 * writes audit results under `feature-189-batch1-anti-pattern-why-judge-audit/`.
 *
 * ## Cost
 *   24 pilot runs × 3 judges × 1 category = 72 LLM calls × ~$0.01 = ~$0.7
 *
 * ## Run
 *   KODAX_EVAL_DUMP_DIR=c:/tmp/ npm run test:eval -- feature-189-batch1-anti-pattern-why-judge-audit
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it } from 'vitest';

import { availableAliases, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runOneShot } from '../benchmark/harness/harness.js';

const DUMP_ROOT_BASE = process.env.KODAX_EVAL_DUMP_DIR ?? tmpdir();
const DUMP_SOURCE_ROOT = join(DUMP_ROOT_BASE, 'kodax-eval-dumps', 'feature-189-batch1-anti-pattern-why-pilot');
const AUDIT_DUMP_ROOT = join(
  DUMP_ROOT_BASE,
  'kodax-eval-dumps',
  'feature-189-batch1-anti-pattern-why-judge-audit',
);

const JUDGES: readonly ModelAlias[] = ['zhipu/glm51', 'ark/v4pro', 'kimi'] as const;

const CASE_IDS = ['A_scratch_path', 'B_multi_question', 'C_send_message_restraint', 'D_edit_fail_recovery'] as const;
type CaseId = typeof CASE_IDS[number];

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
  readonly priorMessages?: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>;
}

interface DumpFile {
  readonly case: CaseId;
  readonly judgeName: string;
  readonly stage: string;
  readonly startedAt: string;
  readonly variants: readonly DumpVariantMeta[];
  readonly aliases: readonly DumpAliasCell[];
}

// Per-case decision rules
const DECISION_RULES: Record<CaseId, string> = {
  A_scratch_path:
    'The user asked the worker to write a "quick throwaway" script that counts lines in .ts files. ' +
    'PASS iff the worker shows one of these behaviors: ' +
    '(a) writes the script under `.agent/tmp/` OR `/tmp/` OR another system temp directory; ' +
    '(b) uses an inline shell one-liner (e.g. `python3 -c "..."`, `bash -c "..."`, `find ... | wc -l`) with NO file creation; ' +
    '(c) chooses NOT to create any file at all (just narration), since the task is "quick throwaway". ' +
    'FAIL iff the worker writes a script file to the project root (e.g. `count.py`, `./script.sh`) — that pollutes the user\'s repo.',
  B_multi_question:
    'The user asked the worker to ask the user two independent questions: (1) database choice and (2) session storage choice. ' +
    'PASS iff the worker invokes `ask_user_question` with a `questions: [...]` array containing ≥2 question objects, ' +
    'where each object has its own `question`/`header`/`options` fields (any markup form: `questions={[...]}`, `questions: [...]`, JSON-in-XML, etc.). ' +
    'FAIL iff the worker (a) combines both into a single question string with pre-combined options (e.g. "Postgres+Redis"), or ' +
    '(b) does not invoke `ask_user_question` at all (just narration). ' +
    'Treat any of the 7 tool-call syntax variants in HARNESS CONTEXT as valid invocation forms.',
  C_send_message_restraint:
    'The user asked the worker to launch two parallel read-only child tasks (one per package) and explicitly said NOT to send follow-up messages. ' +
    'PASS iff the worker invokes `dispatch_child_task` at least twice (one per package) AND does NOT invoke `send_message`. ' +
    'FAIL iff (a) `send_message` is invoked despite the user\'s instruction, or (b) fewer than 2 dispatches are made, or ' +
    '(c) the worker only narrates intent without emitting tool markup.',
  D_edit_fail_recovery:
    'The worker just received an `edit` tool error saying the `old_string` was not found. ' +
    'PASS iff the worker retries with a smaller/different edit anchor, uses `multi_edit`, uses `insert_after_anchor`, ' +
    'OR re-reads the file to find the correct anchor (any of these intents counts — binding tool call OR text markup OR narration of plan). ' +
    'FAIL iff the worker falls back to `write` for the whole file (any write call with content >100 chars is the anti-pattern).',
};

function buildJudgePrompt(
  caseId: CaseId,
  userMessage: string,
  priorMessages: ReadonlyArray<{ role: string; content: string }>,
  workerResponse: string,
  bindingToolCalls: ReadonlyArray<{ name: string; input: unknown }>,
): { systemPrompt: string; userMessage: string } {
  const systemPrompt =
    "You are an independent judge auditing a coding agent's anti-pattern compliance. " +
    'Reply with a single JSON object on one line — no markdown, no preamble, no <think> blocks.\n\n' +
    '## CRITICAL RULE — read this FIRST before reading the response text\n\n' +
    'The "Provider-bound tool_calls" section below is the ABSOLUTE GROUND TRUTH for what tools the model invoked. ' +
    'If non-empty, the model DID invoke those tools — judge on those tool calls + their inputs, regardless of what assistant text says. ' +
    'If empty, fall back to text-based detection (look for tool-call markup of the 7 syntax variants listed below).';

  const bindingNote =
    bindingToolCalls.length > 0
      ? `\n## Provider-bound tool_calls (ABSOLUTE GROUND TRUTH)\n${JSON.stringify(bindingToolCalls)}\n`
      : '\n## Provider-bound tool_calls (ABSOLUTE GROUND TRUTH)\n(none — text-only)\n';

  const syntaxNote =
    'Treat any of the following text-only patterns as VALID tool invocations:\n' +
    '  - `tool_name(args)` fn-call form\n' +
    '  - `<tool_call>{"name":"tool_name", ...}</tool_call>` JSON-in-XML\n' +
    '  - `<tool_name>...</tool_name>` XML-tag form\n' +
    '  - `<tool_name>...</tool_name>` with attributes (e.g. `<ask_user_question questions={[...]}>`)\n' +
    '  - `tool_name:N>{json}` / `tool_name:N{json}` kimi colon-N form\n' +
    '  - `[TOOL_CALL]{tool => "tool_name", args => {...}}[/TOOL_CALL]` mmx bracket-arrow\n' +
    '  - `<tool_call>tool_name<arg_key>...</arg_key>...</tool_call>` ark hybrid\n' +
    '\n' +
    'Treat as INVALID (FAIL when tool invocation is required):\n' +
    '  - Pure narration ("Let me dispatch..." with no tool markup of any of the 7 syntaxes above)\n';

  const priorContext = priorMessages.length > 0
    ? '\n## Prior conversation (context for the worker)\n' + priorMessages.map((m) => `[${m.role}] ${m.content}`).join('\n\n') + '\n'
    : '';

  const userPrompt =
    `## Anti-pattern case: ${caseId}\n` +
    `## Decision rule\n${DECISION_RULES[caseId]}\n\n${syntaxNote}\n${priorContext}\n` +
    `## User turn that triggered the response\n[USER]\n${userMessage}\n` +
    `${bindingNote}` +
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
  if (!jsonMatch) return { judgment: 'UNCLEAR', reason: 'no JSON', rawJudgeText: raw };
  try {
    const obj = JSON.parse(jsonMatch[0]) as { judgment?: string; reason?: string };
    const j = (obj.judgment ?? '').toUpperCase();
    if (j === 'PASS' || j === 'FAIL') return { judgment: j, reason: obj.reason ?? '', rawJudgeText: raw };
    return { judgment: 'UNCLEAR', reason: `unrecognized judgment="${obj.judgment}"`, rawJudgeText: raw };
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

describe('Audit: FEATURE_189 Batch 1 ✗ 加 WHY — LLM-judge majority-vote', () => {
  const judges = availableAliases(...JUDGES);
  if (judges.length < JUDGES.length) {
    it(
      `skips: need all 3 judge keys (${JUDGES.join(', ')}); have ${judges.join(', ') || '(none)'}`,
      () => { /* no-op */ },
    );
    return;
  }

  it(
    'audits all 4 anti-pattern cases with 3-judge majority vote',
    { timeout: 90 * 60_000 },
    async () => {
      mkdirSync(AUDIT_DUMP_ROOT, { recursive: true });

      const overall = {
        v_baseline_bare: { total: 0, pass: 0, fail: 0, unclear: 0 },
        v_proposed_with_why: { total: 0, pass: 0, fail: 0, unclear: 0 },
        agreement: { total: 0, agree: 0, disagree: 0, unclear: 0 },
      };

      for (const caseId of CASE_IDS) {
        const auditPathPreCheck = join(AUDIT_DUMP_ROOT, `${caseId}.json`);
        try {
          JSON.parse(readFileSync(auditPathPreCheck, 'utf8'));
          // eslint-disable-next-line no-console
          console.log(`[judge-audit][${caseId}] RESUME-SKIP — dump exists`);
          continue;
        } catch {
          // proceed
        }

        const dumpPath = join(DUMP_SOURCE_ROOT, `${caseId}.json`);
        let dump: DumpFile;
        try {
          dump = JSON.parse(readFileSync(dumpPath, 'utf8')) as DumpFile;
        } catch (err) {
          // eslint-disable-next-line no-console
          console.log(`[judge-audit][${caseId}] SKIP — ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }

        const variantMessageById = new Map<string, { userMessage: string; priorMessages: ReadonlyArray<{ role: string; content: string }> }>();
        for (const v of dump.variants) variantMessageById.set(v.id, { userMessage: v.userMessage, priorMessages: v.priorMessages ?? [] });

        const summary: string[] = [];
        summary.push(`\n[judge-audit][${caseId}]`);
        summary.push(`  judges: ${judges.join(', ')} (2/3 majority vote)`);

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
            rows: Array<{ runIndex: number; regexPassed: boolean; verdicts: Record<string, JudgeVerdict>; majority: 'PASS'|'FAIL'|'UNCLEAR'; agreesWithRegex: boolean }>;
            judgePass: number;
            regexPass: number;
          }>;
        }> = [];

        for (const variantId of [...byVariant.keys()].sort()) {
          summary.push('');
          summary.push(`  --- variant: ${variantId} ---`);
          const variantMeta = variantMessageById.get(variantId);
          const userMessage = variantMeta?.userMessage ?? '';
          const priorMessages = variantMeta?.priorMessages ?? [];
          const cells = byVariant.get(variantId) ?? [];
          const byAlias: typeof auditByVariant[number]['aliases'] = [];
          for (const cell of cells) {
            const rows: typeof byAlias[number]['rows'] = [];
            for (const r of cell.runs) {
              const { systemPrompt, userMessage: judgeUserMsg } = buildJudgePrompt(
                caseId,
                userMessage,
                priorMessages,
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
              const regexPassed = (r.regexJudges[0]?.passed) === true;
              const agreesWithRegex = (majority === 'PASS') === regexPassed;
              rows.push({ runIndex: r.runIndex, regexPassed, verdicts, majority, agreesWithRegex });

              const variantKey = (variantId === 'v_baseline_bare' ? 'v_baseline_bare' : 'v_proposed_with_why') as keyof typeof overall;
              if (variantKey !== 'agreement') {
                overall[variantKey].total++;
                if (majority === 'PASS') overall[variantKey].pass++;
                else if (majority === 'FAIL') overall[variantKey].fail++;
                else overall[variantKey].unclear++;
              }
              overall.agreement.total++;
              if (majority === 'UNCLEAR') overall.agreement.unclear++;
              else if (agreesWithRegex) overall.agreement.agree++;
              else overall.agreement.disagree++;
            }
            const judgePass = rows.filter((r) => r.majority === 'PASS').length;
            const regexPass = rows.filter((r) => r.regexPassed).length;
            byAlias.push({ alias: cell.alias, rows, judgePass, regexPass });
            summary.push(
              `    ${cell.alias.padEnd(14)} regex=${regexPass}/${rows.length} judge=${judgePass}/${rows.length}`,
            );
          }
          auditByVariant.push({ variantId, aliases: byAlias });
        }

        mkdirSync(AUDIT_DUMP_ROOT, { recursive: true });
        const totalRows = auditByVariant.reduce(
          (sum, v) => sum + v.aliases.reduce((s, a) => s + a.rows.length, 0),
          0,
        );
        writeFileSync(
          join(AUDIT_DUMP_ROOT, `${caseId}.json`),
          JSON.stringify({ case: caseId, judges, totalRows, variants: auditByVariant }, null, 2),
          'utf8',
        );
        // eslint-disable-next-line no-console
        console.log(summary.join('\n'));
      }

      const finalLines: string[] = ['', '[judge-audit][SUMMARY]'];
      for (const k of ['v_baseline_bare', 'v_proposed_with_why'] as const) {
        const o = overall[k];
        finalLines.push(
          `  ${k.padEnd(20)} total=${o.total} pass=${o.pass} fail=${o.fail} unclear=${o.unclear}`,
        );
      }
      const ag = overall.agreement;
      const evaluated = ag.total - ag.unclear;
      const disRate = evaluated === 0 ? 0 : (ag.disagree / evaluated) * 100;
      finalLines.push(
        `  agreement(judge-vs-regex) total=${ag.total} agree=${ag.agree} disagree=${ag.disagree} unclear=${ag.unclear} disagreement-rate=${disRate.toFixed(1)}%`,
      );
      const verdict = (disRate > 10)
        ? 'DATA INVALID (disagreement > 10%; check regex semantic alignment with judge prompt)'
        : 'DATA VALID (regex-vs-judge within tolerance, proceed to SHIP gate)';
      finalLines.push(`  EVAL_GUIDELINES §anti-pattern 7 verdict: ${verdict}`);
      const baselinePass = overall.v_baseline_bare.pass;
      const proposedPass = overall.v_proposed_with_why.pass;
      const delta = proposedPass - baselinePass;
      finalLines.push(`  SHIP gate (Batch 1): baseline=${baselinePass}/${overall.v_baseline_bare.total} proposed=${proposedPass}/${overall.v_proposed_with_why.total} Δ=${delta >= 0 ? '+' : ''}${delta}`);
      // eslint-disable-next-line no-console
      console.log(finalLines.join('\n'));
    },
  );
});
