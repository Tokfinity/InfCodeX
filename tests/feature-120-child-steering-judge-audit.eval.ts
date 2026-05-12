/**
 * LLM-judge audit driver for FEATURE_120 Phase 5b eval (v0.7.39).
 *
 * Enforces EVAL_GUIDELINES anti-pattern 7 §3 strict clause:
 *
 *   > 跑完后强制抽查：每个 cell 至少抽 1 条 regex-fail 用 LLM-judge
 *   > （干净 context）独立判一次，对比 regex；如果 disagreement >10%，
 *   > 整个 eval 数据作废重跑。
 *
 * AND the 2026-05-12 follow-on judge-model-selection clause:
 *
 *   > 禁止用 anthropic claude / openai gpt 等"外来 strong model"做内部
 *   > eval 的 LLM-judge … allowed: panel-internal multi-judge majority
 *   > vote (zhipu/glm51 + ds/v4pro + kimi-code, 2/3 majority = PASS).
 *
 * Input: the 50 raw outputs (5 alias × 5 run × 2 case) already dumped at
 * `os.tmpdir()/kodax-eval-dumps/feature-120-child-steering/{send_message_trigger,
 * task_stop_trigger}.json` from the original eval pass (commit `2a3de8b`).
 *
 * Process: for each of the 50 cells, ask each of the 3 judge aliases to
 * independently decide PASS/FAIL on a clean context — the judge sees the
 * worker prompt context + user trigger + the model's raw response, AND
 * is told what the expected tool + task_id are. The judge returns
 * structured `{ judgment: "PASS"|"FAIL", reason: string }`. Aggregation:
 * 2/3 majority decides; ties (1 PASS / 1 FAIL / 1 UNCLEAR-parse-error)
 * fall to UNCLEAR.
 *
 * Output: an audit dump at `os.tmpdir()/kodax-eval-dumps/
 * feature-120-child-steering-judge-audit/{case}.json` AND a console
 * summary table comparing enhanced-regex pass-rate vs LLM-judge
 * majority-vote pass-rate per (alias, case). Disagreement >10% =
 * eval-data invalid per anti-pattern 7.
 *
 * Run:    npm run test:eval -- feature-120-child-steering-judge-audit
 * Cost:   50 cells × 3 judges = 150 LLM calls × ~$0.005-0.01/call ≈ $1
 *
 * Skips when any of the 3 judge API keys are missing (FEATURE_104
 * standard pattern, no graceful degradation to 1/2 judges — majority
 * vote requires 3 votes).
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it } from 'vitest';

import { availableAliases, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runOneShot } from '../benchmark/harness/harness.js';

const DUMP_SOURCE_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'feature-120-child-steering');
const AUDIT_DUMP_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'feature-120-child-steering-judge-audit');

const JUDGES: readonly ModelAlias[] = ['zhipu/glm51', 'ds/v4pro', 'kimi'] as const;

type CaseId = 'send_message_trigger' | 'task_stop_trigger';

interface CaseSpec {
  readonly id: CaseId;
  readonly expectTool: 'send_message' | 'task_stop';
  readonly expectTaskId: string;
}

const CASES: readonly CaseSpec[] = [
  { id: 'send_message_trigger', expectTool: 'send_message', expectTaskId: 'task_001' },
  { id: 'task_stop_trigger', expectTool: 'task_stop', expectTaskId: 'task_002' },
];

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
  readonly aliases: readonly DumpAlias[];
}

function buildJudgePrompt(c: CaseSpec, raw: string): { systemPrompt: string; userMessage: string } {
  const systemPrompt =
    'You are an independent judge auditing a coding agent\'s tool-call behavior. ' +
    'Reply with a single JSON object on one line — no markdown, no preamble.';
  const userMessage =
    `An agent (the "Worker") was given a prompt teaching it two coordinator tools:\n` +
    `  - send_message(to=<task_id>, content=...) — push an instruction into a running child task's queue.\n` +
    `  - task_stop(task_id=<task_id>, reason=...) — request graceful exit of a running child task.\n\n` +
    `Scenario: the Worker had already dispatched a child task and received its id. A trigger then occurred ` +
    `that should make the Worker invoke \`${c.expectTool}\` targeting task id \`${c.expectTaskId}\`.\n\n` +
    `Here is the Worker's raw response. Your job: did the Worker actually INVOKE \`${c.expectTool}\` ` +
    `targeting \`${c.expectTaskId}\` in this response? Treat all of the following as VALID invocations ` +
    `(syntax varies across model families):\n` +
    `  - \`${c.expectTool}(args)\` function-call form\n` +
    `  - \`<tool_call>{"name":"${c.expectTool}", ...}</tool_call>\` JSON-in-XML\n` +
    `  - \`<${c.expectTool}>...</${c.expectTool}>\` XML-tag form\n` +
    `  - \`<${c.expectTool}>(args)\` half-XML half-fn\n` +
    `An invocation is ONLY valid if the target task id is the requested \`${c.expectTaskId}\` ` +
    `(not the original dispatch input id, e.g. "sec-audit-coding").\n\n` +
    `An "intent statement" without an actual invocation (e.g. plain text "I'll steer the child ` +
    `right away" with no tool_call block) is FAIL.\n\n` +
    `--- WORKER RAW RESPONSE BEGIN ---\n${raw}\n--- WORKER RAW RESPONSE END ---\n\n` +
    `Reply exactly one line of JSON in this shape:\n` +
    `  {"judgment":"PASS","reason":"<≤80 chars>"}\n` +
    `or\n` +
    `  {"judgment":"FAIL","reason":"<≤80 chars>"}`;
  return { systemPrompt, userMessage };
}

interface JudgeVerdict {
  readonly judgment: 'PASS' | 'FAIL' | 'UNCLEAR';
  readonly reason: string;
  readonly rawJudgeText: string;
}

function parseJudgeReply(raw: string): JudgeVerdict {
  // Try to extract a JSON object — model may wrap in code fences / leading text.
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

describe('Audit: FEATURE_120 Phase 5b LLM-judge majority-vote (anti-pattern 7 §3)', () => {
  const judges = availableAliases(...JUDGES);
  if (judges.length < JUDGES.length) {
    it(`skips: need all 3 judge keys (${JUDGES.join(', ')}); have ${judges.join(', ') || '(none)'}`, () => {
      // No-op test makes the skip visible.
    });
    return;
  }

  it(
    'audits all 50 raw outputs with 3-judge majority vote',
    { timeout: 60 * 60_000 }, // 60 min cap (150 LLM calls × worst-case 24s)
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
        const dump = JSON.parse(readFileSync(dumpPath, 'utf8')) as DumpFile;

        const summary: string[] = [];
        summary.push(`\n[judge-audit][${c.id}] expectTool=${c.expectTool} expectTaskId=${c.expectTaskId}`);
        summary.push(`  judges: ${judges.join(', ')} (2/3 majority vote)`);
        summary.push('');

        const auditByAlias: Array<{
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
          const rows: Array<{
            runIndex: number;
            regexPassed: boolean;
            verdicts: Record<string, JudgeVerdict>;
            majority: 'PASS' | 'FAIL' | 'UNCLEAR';
            agreesWithRegex: boolean;
          }> = [];

          for (const r of a.runs) {
            const { systemPrompt, userMessage } = buildJudgePrompt(c, r.text);
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
          auditByAlias.push({
            alias: a.alias,
            regexPassRate: regexPass / rows.length,
            judgePassRate: judgePass / rows.length,
            rows,
          });

          const disag = rows.filter((r) => !r.agreesWithRegex).length;
          summary.push(
            `  ${a.alias.padEnd(13)} regex=${regexPass}/5 (${regexPass * 20}%)  judge=${judgePass}/5 (${judgePass * 20}%)` +
              (disag > 0 ? `  disagree=${disag}` : ''),
          );
        }

        const dumpPathOut = join(AUDIT_DUMP_ROOT, `${c.id}.json`);
        writeFileSync(
          dumpPathOut,
          JSON.stringify(
            {
              case: c.id,
              expectTool: c.expectTool,
              expectTaskId: c.expectTaskId,
              judges,
              byAlias: auditByAlias,
            },
            null,
            2,
          ),
          'utf8',
        );
        summary.push(`  audit dump: ${dumpPathOut}`);
        // eslint-disable-next-line no-console
        console.log(summary.join('\n'));
      }

      const disagPct = overall.totalCells === 0 ? 0 : (overall.disagreeWithRegex / overall.totalCells) * 100;
      const verdict =
        overall.unclear > 0
          ? `WARN — ${overall.unclear}/${overall.totalCells} cells UNCLEAR (judge couldn't decide); manual review needed`
          : disagPct > 10
            ? `INVALID per anti-pattern 7 §3 — disagreement ${disagPct.toFixed(1)}% > 10% threshold; redo eval`
            : `VALID — disagreement ${disagPct.toFixed(1)}% ≤ 10% threshold; regex aggregate trustworthy`;

      // eslint-disable-next-line no-console
      console.log(
        `\n=== JUDGE AUDIT SUMMARY ===\n` +
          `  total cells:       ${overall.totalCells}\n` +
          `  agree with regex:  ${overall.agreeWithRegex}\n` +
          `  disagree:          ${overall.disagreeWithRegex}\n` +
          `  unclear:           ${overall.unclear}\n` +
          `  disagreement %:    ${disagPct.toFixed(1)}%\n` +
          `  verdict:           ${verdict}\n`,
      );
    },
  );
});
