/**
 * LLM-judge audit driver for FEATURE_165 (v0.7.41) emit_handoff
 * HARD PRECONDITION prompt probe.
 *
 * Enforces EVAL_GUIDELINES anti-pattern 7 §3 strict clause:
 *
 *   > 跑完后强制抽查：每个 cell 至少抽 1 条 regex-fail 用 LLM-judge
 *   > （干净 context）独立判一次，对比 regex；如果 disagreement >10%，
 *   > 整个 eval 数据作废重跑。
 *
 * AND the 2026-05-12 judge-model-selection clause:
 *
 *   > 禁止用 anthropic claude / openai gpt 等"外来 strong model"做内部
 *   > eval 的 LLM-judge … allowed: panel-internal multi-judge majority
 *   > vote (zhipu/glm52 + ds/v4pro + kimi-code, 2/3 majority = PASS).
 *
 * ## Input
 *
 * Reads the 250 raw outputs (5 alias × 5 run × 5 case × 2 variant)
 * dumped at `os.tmpdir()/kodax-eval-dumps/feature-165-handoff-wait-gate/
 * <case>.json` by `tests/feature-165-handoff-wait-gate.eval.ts`.
 *
 * Dump schema (FEATURE_165 extends FEATURE_120's with a `variants`
 * wrapper because each case has v_baseline + v_proposed variants
 * sharing the same canned history; iterate variants[]/aliases[]/runs[]).
 *
 * ## Judge contract
 *
 * For each run, ask each of the 3 judge aliases independently (CLEAN
 * context — judge sees only the task prompt + raw response, never the
 * regex outcome) to decide PASS/FAIL on the SAME polarity assertion
 * the regex judges check:
 *
 *   - POSITIVE case (`must_call_emit_handoff`):
 *     PASS iff the response invokes `emit_handoff` (any of 5 syntax
 *     forms — fn-call / JSON / XML / hybrid / unquoted-key).
 *
 *   - NEGATIVE case (`must_not_call_emit_handoff`):
 *     PASS iff the response does NOT invoke `emit_handoff` AND
 *     (text-only continuation OR a different tool call like
 *     `dispatch_child_task` / `task_stop` / `todo_update`).
 *     Intent statements without invocation count as PASS for negative
 *     (the bug is the actual tool call, not the model's words).
 *
 * Aggregation: 2/3 majority decides; ties (1 PASS / 1 FAIL / 1
 * UNCLEAR-parse-error) fall to UNCLEAR.
 *
 * ## Output
 *
 * Audit dump at `os.tmpdir()/kodax-eval-dumps/
 * feature-165-handoff-wait-gate-judge-audit/<case>.json` AND a console
 * summary comparing enhanced-regex pass-rate vs LLM-judge majority-vote
 * pass-rate per (alias, variant, case). Per EVAL_GUIDELINES anti-
 * pattern 7 §3: disagreement >10% → eval-data invalid → regex / judge
 * design needs redesign before applying SHIP/PARTIAL/REJECT matrix.
 *
 * ## Cost
 *
 *   250 runs × 3 judges = 750 LLM calls × ~$0.005-0.01/call ≈ $4-7.50
 *
 * ## Run
 *
 *   npm run test:eval -- feature-165-handoff-wait-gate-judge-audit
 *
 * Skips when any of the 3 judge API keys are missing (FEATURE_104
 * standard pattern — majority vote requires all 3 votes).
 *
 * ## Judge self-bias note
 *
 * One judge alias (`zhipu/glm52`) overlaps with one alias in the
 * judged panel. EVAL_GUIDELINES §"Judge 模型选择约束" permits this —
 * majority vote across 3 independent families (zhipu / deepseek /
 * moonshot) breaks the same-family bias even when one judge happens
 * to share family with one judged alias. The audit dump records each
 * judge's raw verdict so post-hoc bias analysis is possible if the
 * pass-rates look suspicious.
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
} from '../benchmark/datasets/feature-165-handoff-wait-gate/cases.js';

const DUMP_SOURCE_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'feature-165-handoff-wait-gate');
const AUDIT_DUMP_ROOT = join(
  tmpdir(),
  'kodax-eval-dumps',
  'feature-165-handoff-wait-gate-judge-audit',
);

// Panel-internal majority vote — 3 independent families (zhipu /
// deepseek / moonshot). EVAL_GUIDELINES §"Judge 模型选择约束".
const JUDGES: readonly ModelAlias[] = ['zhipu/glm52', 'ds/v4pro', 'kimi'] as const;

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
  readonly priorMessages: ReadonlyArray<{ role: string; content: string }>;
  readonly aliases: readonly DumpAlias[];
}

interface DumpFile {
  readonly case: CaseId;
  readonly polarity: CaseSpec['polarity'];
  readonly variants: readonly DumpVariant[];
}

function buildJudgePrompt(
  spec: CaseSpec,
  userMessage: string,
  priorMessages: ReadonlyArray<{ role: string; content: string }>,
  workerResponse: string,
): { systemPrompt: string; userMessage: string } {
  const systemPrompt =
    "You are an independent judge auditing a coding agent's tool-call behavior. " +
    'Reply with a single JSON object on one line — no markdown, no preamble.';

  // Reconstruct the scene context for the judge so it sees what the
  // worker saw. Keep it short — the judge only needs the framing.
  const priorSummary = priorMessages
    .map((m) => `[${m.role.toUpperCase()}]\n${m.content.slice(0, 800)}`)
    .join('\n\n');

  const polarityInstruction =
    spec.polarity === 'must_call_emit_handoff'
      ? 'The Worker SHOULD invoke `emit_handoff` in its response. PASS iff the response actually invokes `emit_handoff` (any syntax form). An intent statement without an actual tool_call block (e.g. plain text "I will hand off now") is FAIL.'
      : 'The Worker should NOT invoke `emit_handoff` in its response because dispatched children have not yet returned `<task-completed>` banners. PASS iff the response does NOT actually invoke `emit_handoff`. A text-only response, OR a different tool call (dispatch_child_task / task_stop / todo_update / read / grep / etc.) is PASS. Only an actual `emit_handoff` tool_call invocation is FAIL. An intent statement without an actual emit_handoff invocation (e.g. plain text mentioning emit_handoff conceptually) is PASS.';

  const syntaxNote =
    'Treat all of the following as VALID `emit_handoff` invocations (syntax varies across model families):\n' +
    '  - `emit_handoff(args)` function-call form\n' +
    '  - `<tool_call>{"name":"emit_handoff", ...}</tool_call>` JSON-in-XML\n' +
    '  - `<emit_handoff>...</emit_handoff>` XML-tag form\n' +
    '  - `<emit_handoff>(args)` half-XML half-fn\n' +
    '  - `name:"emit_handoff"` unquoted-key + quoted-value YAML hybrid\n';

  const userPrompt =
    `An agent (the "Worker") is in an AMA coding workflow. After completing some work it can ` +
    `call \`emit_handoff\` to hand off to an Evaluator role. It can also dispatch parallel child ` +
    `tasks via \`dispatch_child_task\`; children return \`<task-completed task_id="...">\` ` +
    `banners later.\n\n` +
    `## Case: ${spec.id} (${spec.polarity})\n${spec.description}\n\n` +
    `## Scene (what the Worker saw before producing the response below)\n\n${priorSummary}\n\n` +
    `## Final user turn\n[USER]\n${userMessage}\n\n` +
    `## Decision rule\n${polarityInstruction}\n\n${syntaxNote}\n` +
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

describe('Audit: FEATURE_165 emit_handoff HARD PRECONDITION LLM-judge majority-vote (anti-pattern 7 §3)', () => {
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
    'audits all 250 raw outputs with 3-judge majority vote (per case × variant × alias)',
    // 90 min cap: worst case 750 LLM calls × ~7s = ~90 min (judges
    // are fast — short JSON output, no streaming).
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
                variant.priorMessages,
                r.text,
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
