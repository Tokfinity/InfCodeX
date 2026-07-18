/**
 * LLM-judge audit driver for FEATURE_191 dispatch specialist panel.
 *
 * 3-judge majority vote (zhipu/glm52 + ark/v4pro + kimi) per
 * `feedback_audit_must_see_binding` + `feedback_audit_binding_priority_in_prompt`.
 * Re-judges the `specialist_dispatch` outcome on every panel run so we
 * can compute regex-vs-LLM disagreement for the EVAL_GUIDELINES
 * anti-pattern 7 DATA-VALID gate (≤10%).
 *
 * Reads dumps from `feature-191-dispatch-specialist-panel/` and writes
 * audit results under `feature-191-dispatch-specialist-judge-audit/`.
 *
 * ## Cost
 *
 *   100 panel runs × 3 judges = 300 LLM calls × ~$0.01/call ≈ $2.
 *
 * ## Why this judge stays panel-internal
 *
 * Per EVAL_GUIDELINES — KodaX uses panel-internal judges (zhipu/glm52 +
 * ark/v4pro + kimi); we do NOT call anthropic claude or openai gpt as
 * judges. The 3-judge majority compensates for any single-family bias.
 *
 * ## Run
 *
 *   KODAX_EVAL_DUMP_DIR=c:/tmp/ npm run test:eval -- feature-191-dispatch-specialist-judge-audit
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it } from 'vitest';

import { availableAliases, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runOneShot } from '../benchmark/harness/harness.js';

const DUMP_ROOT_BASE = process.env.KODAX_EVAL_DUMP_DIR ?? tmpdir();
const DUMP_SOURCE_ROOT = join(DUMP_ROOT_BASE, 'kodax-eval-dumps', 'feature-191-dispatch-specialist-panel');
const AUDIT_DUMP_ROOT = join(
  DUMP_ROOT_BASE,
  'kodax-eval-dumps',
  'feature-191-dispatch-specialist-judge-audit',
);

// Panel-internal judges only (NEVER anthropic/openai per EVAL_GUIDELINES).
const JUDGES: readonly ModelAlias[] = ['zhipu/glm52', 'ark/v4pro', 'kimi'] as const;

const CASE_IDS = ['C1_match', 'C2_no_match', 'C3_unknown', 'C4_multi'] as const;
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
  readonly expectedSubagentType: string | null;
  readonly forbiddenSubagentTypes: readonly string[];
  readonly multiCandidate?: boolean;
  readonly variants: readonly DumpVariantMeta[];
  readonly aliases: readonly DumpAliasCell[];
}

function buildDecisionRule(expected: string | null, forbidden: readonly string[]): string {
  const expectedClause = expected === null
    ? 'PASS iff the response does NOT invoke `dispatch_child_task` with any of the following subagent_type values (these would be fabrications or mis-routes): ['
      + forbidden.map((f) => `"${f}"`).join(', ') + ']. '
      + 'It IS OK for the response to dispatch without `subagent_type` (generic child is the correct choice when no specialist matches), '
      + 'or to skip dispatch entirely.'
    : `PASS iff the response invokes \`dispatch_child_task\` with \`subagent_type="${expected}"\` AT LEAST ONCE — binding tool call OR narrative tool-call markup. `
      + `Dispatching without \`subagent_type\`, with a different/fabricated \`subagent_type\`, or skipping dispatch entirely is FAIL.`;

  const forbiddenClause = forbidden.length > 0 && expected !== null
    ? ` Additionally, invoking dispatch with \`subagent_type\` set to any of [${forbidden.map((f) => `"${f}"`).join(', ')}] is FAIL regardless of whether the expected name also appears.`
    : '';

  return expectedClause + forbiddenClause;
}

function buildJudgePrompt(
  expected: string | null,
  forbidden: readonly string[],
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
    'If that section is empty, fall back to text-based detection (look for tool-call markup in the response).';

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
    'For the `subagent_type` argument, look for `subagent_type:"<name>"` or `"subagent_type":"<name>"` ' +
    'inside the dispatch_child_task call payload.\n';

  const decisionRule = buildDecisionRule(expected, forbidden);

  const userPrompt =
    'An agent (the "Worker") is presented with a registered specialist agent block and is expected to ' +
    'dispatch with `subagent_type=<name>` when the task matches a registered specialist. It has access to:\n' +
    '  - `dispatch_child_task({id, objective, readOnly?, model_hint?, subagent_type?})` — launch a child; ' +
    'with subagent_type, the child uses the specialist\'s instructions + tool whitelist\n' +
    '  - `read` / `grep` / `bash` / `write` / `edit` — standard tools\n\n' +
    `## Judge category: specialist_dispatch\n` +
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

describe('Audit: FEATURE_191 dispatch specialist routing — 3-judge majority', () => {
  const judges = availableAliases(...JUDGES);
  if (judges.length < JUDGES.length) {
    it(
      `skips: need all 3 judge keys (${JUDGES.join(', ')}); have ${judges.join(', ') || '(none)'}`,
      () => { /* no-op */ },
    );
    return;
  }

  it(
    'audits specialist_dispatch verdicts with 3-judge majority vote',
    { timeout: 90 * 60_000 },
    async () => {
      mkdirSync(AUDIT_DUMP_ROOT, { recursive: true });

      const overall = { total: 0, agree: 0, disagree: 0, unclear: 0 };

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
        summary.push(`\n[judge-audit][${caseId}] expected=${dump.expectedSubagentType ?? '(none)'}`);
        summary.push(`  judges: ${judges.join(', ')} (2/3 majority vote)`);

        const auditByVariant: Array<{
          variantId: string;
          aliases: Array<{
            alias: string;
            regex: number;
            judge: number;
            rows: Array<{
              runIndex: number;
              regexPassed: boolean;
              verdicts: Record<string, JudgeVerdict>;
              majority: 'PASS' | 'FAIL' | 'UNCLEAR';
              agreesWithRegex: boolean;
            }>;
          }>;
        }> = [];

        const byVariant = new Map<string, DumpAliasCell[]>();
        for (const cell of dump.aliases) {
          const arr = byVariant.get(cell.variantId) ?? [];
          arr.push(cell);
          byVariant.set(cell.variantId, arr);
        }

        for (const variantId of [...byVariant.keys()].sort()) {
          summary.push('');
          summary.push(`  --- variant: ${variantId} ---`);
          const userMessage = variantMessageById.get(variantId) ?? '';
          const cells = byVariant.get(variantId) ?? [];
          const byAlias: typeof auditByVariant[number]['aliases'] = [];
          for (const cell of cells) {
            const rows: typeof byAlias[number]['rows'] = [];
            for (const r of cell.runs) {
              const { systemPrompt, userMessage: judgeUserMsg } = buildJudgePrompt(
                dump.expectedSubagentType,
                dump.forbiddenSubagentTypes,
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
              const regexPassed = (r.regexJudges.find((j) => j.name === 'specialist_dispatch')?.passed) === true;
              const agreesWithRegex = (majority === 'PASS') === regexPassed;
              rows.push({ runIndex: r.runIndex, regexPassed, verdicts, majority, agreesWithRegex });
              overall.total++;
              if (majority === 'UNCLEAR') overall.unclear++;
              else if (agreesWithRegex) overall.agree++;
              else overall.disagree++;
            }
            const regexPass = rows.filter((r) => r.regexPassed).length;
            const judgePass = rows.filter((r) => r.majority === 'PASS').length;
            byAlias.push({ alias: cell.alias, regex: regexPass, judge: judgePass, rows });
            summary.push(
              `    ${cell.alias.padEnd(14)} specialist_dispatch regex=${regexPass}/${rows.length} judge=${judgePass}/${rows.length}`,
            );
          }
          auditByVariant.push({ variantId, aliases: byAlias });
        }

        // Double-mkdirSync per feedback_audit_dump_dir_vanishes — Windows
        // tmpdir cleanup can vanish the mkdir from describe-block setup.
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

      const evaluated = overall.total - overall.unclear;
      const rate = evaluated === 0 ? 0 : (overall.disagree / evaluated) * 100;
      const finalLines: string[] = ['', '[judge-audit][SUMMARY]'];
      finalLines.push(
        `  specialist_dispatch  total=${overall.total} agree=${overall.agree} disagree=${overall.disagree} unclear=${overall.unclear} disagreement-rate=${rate.toFixed(1)}%`,
      );
      const verdict = rate > 10
        ? 'DATA INVALID (disagreement > 10%; check regex semantic align with LLM judge prompt before SHIP)'
        : 'DATA VALID (regex-vs-judge within tolerance, proceed to SHIP gate)';
      finalLines.push(`  EVAL_GUIDELINES §anti-pattern 7 verdict: ${verdict}`);
      // eslint-disable-next-line no-console
      console.log(finalLines.join('\n'));
    },
  );
});
