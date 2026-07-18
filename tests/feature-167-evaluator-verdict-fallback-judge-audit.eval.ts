/**
 * LLM-judge audit driver for FEATURE_167 (v0.7.41) Evaluator
 * terminal-verdict fallback probe.
 *
 * Enforces EVAL_GUIDELINES anti-pattern 7 §3:
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
 * Reads the 75 raw outputs (3 cases × 5 alias × 5 run × 1 variant)
 * dumped at `os.tmpdir()/kodax-eval-dumps/
 * feature-167-evaluator-verdict-fallback/<case>.json` by
 * `tests/feature-167-evaluator-verdict-fallback.eval.ts`.
 *
 * ## Judge contract
 *
 * For each run, ask each of 3 judge aliases (clean context) to decide
 * PASS/FAIL on the case's specific assertion shape:
 *
 *   - `first_tool_call_includes_emit_verdict` / `turn_2_includes_emit_verdict`
 *     (C1 / C2): PASS iff the response actually invokes `emit_verdict`
 *     (any of 5 syntactic forms). Intent statements without an actual
 *     tool_call (e.g. "I will now call emit_verdict") are FAIL.
 *
 *   - `response_contains_parseable_fenced_verdict_block` (C3): PASS iff
 *     the response contains a ```kodax-task-verdict``` triple-backtick
 *     fenced block whose body is parseable JSON with a valid `status`
 *     field (accept | revise | blocked). Mentioning the fence
 *     conceptually without producing one is FAIL.
 *
 * Aggregation: 2/3 majority decides; ties (1 PASS / 1 FAIL / 1 UNCLEAR)
 * fall to UNCLEAR. Total: 75 runs × 3 judges = 225 LLM calls (~$2-4).
 *
 * ## Output
 *
 * Audit dump at `os.tmpdir()/kodax-eval-dumps/
 * feature-167-evaluator-verdict-fallback-judge-audit/<case>.json`
 * plus a console summary comparing regex pass-rate vs LLM-judge
 * majority pass-rate per (alias, case). Per EVAL_GUIDELINES
 * anti-pattern 7 §3: disagreement > 10% → eval-data invalid →
 * regex / judge design needs redesign before applying the SHIP matrix.
 *
 * ## Judge self-bias note
 *
 * One judge alias (`zhipu/glm52`) overlaps with one probed alias.
 * Permitted per EVAL_GUIDELINES §"Judge 模型选择约束" — majority vote
 * across 3 independent families (zhipu / deepseek / moonshot) breaks
 * same-family bias even when one judge shares family with one probed
 * alias. The audit dump records each judge's raw verdict so post-hoc
 * bias analysis is possible if pass-rates look suspicious.
 *
 * ## Run
 *
 *   npm run test:eval -- feature-167-evaluator-verdict-fallback-judge-audit
 *
 * Skips when any of the 3 judge API keys are missing.
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
} from '../benchmark/datasets/feature-167-evaluator-verdict-fallback/cases.js';

const DUMP_SOURCE_ROOT = join(
  tmpdir(),
  'kodax-eval-dumps',
  'feature-167-evaluator-verdict-fallback',
);
const AUDIT_DUMP_ROOT = join(
  tmpdir(),
  'kodax-eval-dumps',
  'feature-167-evaluator-verdict-fallback-judge-audit',
);

// Panel-internal majority vote — 3 independent families.
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
  readonly assertion: CaseSpec['assertion'];
  readonly variants: readonly DumpVariant[];
}

function buildJudgePrompt(
  spec: CaseSpec,
  userMessage: string,
  priorMessages: ReadonlyArray<{ role: string; content: string }>,
  evaluatorResponse: string,
): { systemPrompt: string; userMessage: string } {
  const systemPrompt =
    "You are an independent judge auditing an LLM agent's tool-call behavior. " +
    'Reply with a single JSON object on one line — no markdown, no preamble.';

  // Reconstruct the scene the agent saw. Cap each message at 800 chars
  // — judges only need framing, not full canned transcripts. The agent's
  // raw response is the part we need verbatim.
  const priorSummary = priorMessages
    .map((m) => `[${m.role.toUpperCase()}]\n${m.content.slice(0, 800)}`)
    .join('\n\n');

  let decisionRule: string;
  let syntaxNote: string;

  if (
    spec.assertion === 'first_tool_call_includes_emit_verdict'
    || spec.assertion === 'turn_2_includes_emit_verdict'
  ) {
    decisionRule =
      'The Evaluator SHOULD invoke `emit_verdict` in this response. PASS iff ' +
      'the response actually invokes `emit_verdict` (any syntax form). An ' +
      'intent statement without an actual tool_call block (e.g. plain text ' +
      '"I will now call emit_verdict") is FAIL. A text-only review summary ' +
      'with NO tool call at all is FAIL.';
    syntaxNote =
      'Treat all of the following as VALID `emit_verdict` invocations:\n' +
      '  - `emit_verdict(args)` function-call form\n' +
      '  - `<tool_call>{"name":"emit_verdict", ...}</tool_call>` JSON-in-XML\n' +
      '  - `<emit_verdict>...</emit_verdict>` XML-tag form\n' +
      '  - `<emit_verdict>(args)` half-XML half-fn\n' +
      '  - `name:"emit_verdict"` unquoted-key + quoted-value YAML hybrid\n';
  } else {
    // C3 — fenced-block emission rate.
    decisionRule =
      'The Evaluator SHOULD emit a ```kodax-task-verdict``` triple-backtick ' +
      'fenced block whose body is parseable JSON with a `status` field set to ' +
      '"accept", "revise", or "blocked". PASS iff such a block is present AND ' +
      'its body is valid JSON with a recognized status value. A mention of ' +
      'the fence concept without producing one (e.g. plain text "I could use ' +
      'kodax-task-verdict") is FAIL. A response that only invokes the ' +
      '`emit_verdict` tool without ALSO emitting the fenced block is FAIL — ' +
      'C3 measures fence emission specifically, not tool-call success.';
    syntaxNote =
      'A valid C3 PASS looks like:\n' +
      '  ```kodax-task-verdict\n' +
      '  {"status":"accept","reason":"...","user_answer":"..."}\n' +
      '  ```\n' +
      'The fence MUST be triple-backtick; status MUST be one of the three ' +
      'allowed values.\n' +
      '\n' +
      'Counter-examples — these are FAIL for C3 specifically:\n' +
      '  - A response that calls `emit_verdict(...)` as a tool call but has ' +
      'NO ```kodax-task-verdict``` fenced block in the text → FAIL.\n' +
      '  - A response that mentions "kodax-task-verdict" in prose without ' +
      'actually emitting a triple-backtick fenced block → FAIL.\n' +
      '  - A fenced block with a different name (e.g. ```json```, ' +
      '```kodax-handoff```) → FAIL.\n';
  }

  const userPrompt =
    `An agent (the "Evaluator") is auditing a Worker's completed work in a ` +
    `KodaX multi-agent flow. After Worker calls \`emit_handoff\`, the runner ` +
    `swaps control to the Evaluator, whose job is to emit a terminal verdict ` +
    `via the \`emit_verdict\` tool.\n\n` +
    `## Case: ${spec.id} (${spec.assertion})\n${spec.description}\n\n` +
    `## Scene (what the Evaluator saw before producing the response below)\n\n${priorSummary}\n\n` +
    `## Final user turn\n[USER]\n${userMessage}\n\n` +
    `## Decision rule\n${decisionRule}\n\n${syntaxNote}\n` +
    `## Evaluator raw response\n--- BEGIN ---\n${evaluatorResponse}\n--- END ---\n\n` +
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

describe('Audit: FEATURE_167 evaluator-verdict-fallback LLM-judge majority-vote (anti-pattern 7 §3)', () => {
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
    'audits all 75 raw outputs with 3-judge majority vote (per case × alias)',
    // 60-min cap: worst case 225 LLM calls × ~7s = ~26 min; double for
    // headroom on slower judges (kimi can be slow on long context).
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
        summary.push(`\n[judge-audit][${c.id}] assertion=${c.assertion}`);
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
              assertion: c.assertion,
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

      // Final disagreement-rate verdict per anti-pattern 7 §3.
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
            ? 'DATA INVALID — disagreement > 10%, redesign regex/judge before applying SHIP matrix'
            : 'DATA VALID — regex-vs-judge agreement within tolerance, proceed to SHIP matrix'
        }`,
      );
      // eslint-disable-next-line no-console
      console.log(finalLines.join('\n'));
    },
  );
});
