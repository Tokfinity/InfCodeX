/**
 * LLM-judge audit driver for FEATURE_189 B.5 version-header cleanup panel.
 *
 * 3-judge majority vote (zhipu/glm52 + ark/v4pro + kimi) per
 * `feedback_audit_must_see_binding` + `feedback_audit_binding_priority_in_prompt`.
 * Re-judges both `plan_first_compliance` and `dispatch_intent`
 * categories from the canonical panel dump.
 *
 * Reads dumps from `feature-189-b5-version-header-cleanup/` and writes audit
 * results under `feature-189-b5-version-header-judge-audit/`.
 *
 * ## Cost
 *
 *   100 panel runs × 3 judges × 2 categories = 600 LLM calls × ~$0.01/call ≈ $4
 *
 * ## Run
 *
 *   KODAX_EVAL_DUMP_DIR=c:/tmp/ npm run test:eval -- feature-189-b5-version-header-judge-audit
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it } from 'vitest';

import { availableAliases, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runOneShot } from '../benchmark/harness/harness.js';

const DUMP_ROOT_BASE = process.env.KODAX_EVAL_DUMP_DIR ?? tmpdir();
const DUMP_SOURCE_ROOT = join(DUMP_ROOT_BASE, 'kodax-eval-dumps', 'feature-189-b5-version-header-cleanup');
const AUDIT_DUMP_ROOT = join(
  DUMP_ROOT_BASE,
  'kodax-eval-dumps',
  'feature-189-b5-version-header-judge-audit',
);

const JUDGES: readonly ModelAlias[] = ['zhipu/glm52', 'ark/v4pro', 'kimi'] as const;

const CASE_IDS = ['audit_4_packages', 'edit_3_modules'] as const;
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
}

interface DumpFile {
  readonly case: CaseId;
  readonly stage: string;
  readonly startedAt: string;
  readonly variants: readonly DumpVariantMeta[];
  readonly aliases: readonly DumpAliasCell[];
}

const PLAN_FIRST_DECISION_RULE =
  'PASS iff the response shows the model intends to follow the PLAN-FIRST rule: ' +
  '(a) emits ≥1 `todo_create` invocation AND (b) the first `todo_create` appears before the first ' +
  '`dispatch_child_task` invocation. Treat narrative tool-call markup (any of the 7 syntax variants ' +
  'listed below) the same as a structured binding call — production runtime parses both. If the ' +
  'response contains NEITHER tool invocation (only narration of intent), that is FAIL — model did ' +
  'not commit. If the response contains `dispatch_child_task` without any `todo_create`, that is ' +
  'FAIL — plan-first violated. If the response contains `todo_create` but no follow-through ' +
  '`dispatch_child_task` (e.g. emit the plan list then end the turn), treat as PASS for THIS ' +
  'judge (plan-first IS satisfied; dispatch follow-through is judged separately by ' +
  'dispatch_intent).';

const DISPATCH_INTENT_DECISION_RULE =
  'PASS iff the response invokes `dispatch_child_task` at least once — binding tool call OR ' +
  'narrative tool-call markup of any of the 7 syntax variants below. Empty binding + text-only ' +
  'narration without ANY tool-call markup is FAIL ("Let me dispatch..." prose alone is FAIL).';

function buildJudgePrompt(
  judgeName: 'plan_first_compliance' | 'dispatch_intent',
  userMessage: string,
  workerResponse: string,
  bindingToolCalls: ReadonlyArray<{ name: string; input: unknown }>,
): { systemPrompt: string; userMessage: string } {
  const systemPrompt =
    "You are an independent judge auditing a coding agent's tool-call behavior. " +
    'Reply with a single JSON object on one line — no markdown, no preamble, no <think> blocks.\n\n' +
    '## CRITICAL RULE — read this FIRST before reading the response text\n\n' +
    'The "Provider-bound tool_calls" section below is the ABSOLUTE GROUND TRUTH for what tools the model invoked. ' +
    'If that section is non-empty, the model DID invoke those tools — judge on those tool calls + their inputs, ' +
    'regardless of what the assistant text says. ' +
    'If that section is empty, fall back to text-based detection (look for tool-call markup in the response). ' +
    'A binding-captured tool call with name=X is a fact; the assistant text saying "I will not invoke X" ' +
    'next to a binding entry for X means the binding is correct (text-only intent disclaimers do not unwind a real call).';

  const bindingNote =
    bindingToolCalls.length > 0
      ? `\n## Provider-bound tool_calls (ABSOLUTE GROUND TRUTH — read this first)\n${JSON.stringify(bindingToolCalls)}\n`
      : '\n## Provider-bound tool_calls (ABSOLUTE GROUND TRUTH — read this first)\n(none — model emitted tools via text only; use the response-text section below)\n';

  const syntaxNote =
    'Treat any of the following text-only patterns as VALID tool invocations (syntax varies across families):\n' +
    '  - `tool_name(args)` fn-call form\n' +
    '  - `<tool_call>{"name":"tool_name", ...}</tool_call>` JSON-in-XML (OpenAI canonical)\n' +
    '  - `<tool_name>...</tool_name>` XML-tag form\n' +
    '  - `<tool_name>tool_name</tool_name>` zhipu nested XML\n' +
    '  - `tool_name:N>{json}` / `tool_name:N{json}` kimi colon-N form\n' +
    '  - `[TOOL_CALL]{tool => "tool_name", args => {...}}[/TOOL_CALL]` mmx bracket-arrow\n' +
    '  - `<tool_call>tool_name<arg_key>...</arg_key>...</tool_call>` ark hybrid\n' +
    '\n' +
    'Treat as INVALID (FAIL):\n' +
    '  - Text-only intent statement with NO tool-call markup ("Let me commit a plan first..." without any of the syntax above)\n' +
    '  - Severely malformed syntax that no production runtime could parse\n';

  const decisionRule =
    judgeName === 'plan_first_compliance' ? PLAN_FIRST_DECISION_RULE : DISPATCH_INTENT_DECISION_RULE;

  const userPrompt =
    'An agent (the "Worker") plans whether to commit a todo plan list before dispatching child ' +
    'tasks for a multi-package fan-out. It has access to:\n' +
    '  - `dispatch_child_task({id, objective, readOnly?, model_hint?})` — launch a child; returns task_id banner\n' +
    '  - `todo_create({subject, activeForm})` — append a plan-list item\n' +
    '  - `read` / `grep` / `bash` / `write` / `edit` — standard tools\n\n' +
    `## Judge category: ${judgeName}\n` +
    `## User turn that triggered the response\n[USER]\n${userMessage}\n\n` +
    `## Decision rule\n${decisionRule}\n\n${syntaxNote}\n${bindingNote}\n` +
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

describe('Audit: FEATURE_189 B.5 version-header cleanup — LLM-judge majority-vote', () => {
  const judges = availableAliases(...JUDGES);
  if (judges.length < JUDGES.length) {
    it(
      `skips: need all 3 judge keys (${JUDGES.join(', ')}); have ${judges.join(', ') || '(none)'}`,
      () => { /* no-op */ },
    );
    return;
  }

  it(
    'audits both plan_first_compliance and dispatch_intent with 3-judge majority vote',
    { timeout: 90 * 60_000 },
    async () => {
      mkdirSync(AUDIT_DUMP_ROOT, { recursive: true });

      const overall = {
        plan_first: { total: 0, agree: 0, disagree: 0, unclear: 0 },
        dispatch_intent: { total: 0, agree: 0, disagree: 0, unclear: 0 },
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

        const variantMessageById = new Map<string, string>();
        for (const v of dump.variants) variantMessageById.set(v.id, v.userMessage);

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
            planFirst: { regex: number; judge: number; rows: Array<{ runIndex: number; regexPassed: boolean; verdicts: Record<string, JudgeVerdict>; majority: 'PASS'|'FAIL'|'UNCLEAR'; agreesWithRegex: boolean }> };
            dispatchIntent: { regex: number; judge: number; rows: Array<{ runIndex: number; regexPassed: boolean; verdicts: Record<string, JudgeVerdict>; majority: 'PASS'|'FAIL'|'UNCLEAR'; agreesWithRegex: boolean }> };
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
            const dispatchRows: typeof byAlias[number]['dispatchIntent']['rows'] = [];
            for (const r of cell.runs) {
              for (const judgeName of ['plan_first_compliance', 'dispatch_intent'] as const) {
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
                else dispatchRows.push(row);
                const ovK = judgeName === 'plan_first_compliance' ? 'plan_first' : 'dispatch_intent';
                overall[ovK].total++;
                if (majority === 'UNCLEAR') overall[ovK].unclear++;
                else if (agreesWithRegex) overall[ovK].agree++;
                else overall[ovK].disagree++;
              }
            }
            const planFirstRegexPass = planFirstRows.filter((r) => r.regexPassed).length;
            const planFirstJudgePass = planFirstRows.filter((r) => r.majority === 'PASS').length;
            const dispatchRegexPass = dispatchRows.filter((r) => r.regexPassed).length;
            const dispatchJudgePass = dispatchRows.filter((r) => r.majority === 'PASS').length;
            byAlias.push({
              alias: cell.alias,
              planFirst: { regex: planFirstRegexPass, judge: planFirstJudgePass, rows: planFirstRows },
              dispatchIntent: { regex: dispatchRegexPass, judge: dispatchJudgePass, rows: dispatchRows },
            });
            summary.push(
              `    ${cell.alias.padEnd(14)} plan-first regex=${planFirstRegexPass}/${planFirstRows.length} judge=${planFirstJudgePass}/${planFirstRows.length}  dispatch regex=${dispatchRegexPass}/${dispatchRows.length} judge=${dispatchJudgePass}/${dispatchRows.length}`,
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
          JSON.stringify({ case: caseId, judges, totalRows, variants: auditByVariant }, null, 2),
          'utf8',
        );
        // eslint-disable-next-line no-console
        console.log(summary.join('\n'));
      }

      const finalLines: string[] = ['', '[judge-audit][SUMMARY]'];
      for (const k of ['plan_first', 'dispatch_intent'] as const) {
        const o = overall[k];
        const evaluated = o.total - o.unclear;
        const rate = evaluated === 0 ? 0 : (o.disagree / evaluated) * 100;
        finalLines.push(
          `  ${k.padEnd(20)} total=${o.total} agree=${o.agree} disagree=${o.disagree} unclear=${o.unclear} disagreement-rate=${rate.toFixed(1)}%`,
        );
      }
      const planDisRate = overall.plan_first.total - overall.plan_first.unclear === 0 ? 0
        : (overall.plan_first.disagree / (overall.plan_first.total - overall.plan_first.unclear)) * 100;
      const dispDisRate = overall.dispatch_intent.total - overall.dispatch_intent.unclear === 0 ? 0
        : (overall.dispatch_intent.disagree / (overall.dispatch_intent.total - overall.dispatch_intent.unclear)) * 100;
      const verdict = (planDisRate > 10 || dispDisRate > 10)
        ? 'DATA INVALID (one category disagreement > 10%; check regex semantic align with LLM judge prompt before SHIP)'
        : 'DATA VALID (regex-vs-judge within tolerance, proceed to SHIP gate)';
      finalLines.push(`  EVAL_GUIDELINES §anti-pattern 7 verdict: ${verdict}`);
      // eslint-disable-next-line no-console
      console.log(finalLines.join('\n'));
    },
  );
});
