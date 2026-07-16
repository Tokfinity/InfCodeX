/**
 * Audit driver for Suite A (Child F1v2 + F2 first-tool pick).
 *
 * Enforces EVAL_GUIDELINES anti-pattern 7 §3 (sampling + multi-judge majority).
 *
 * Input: `os.tmpdir()/kodax-eval-dumps/repointel-tool-adoption-child-v2/{case}.json`.
 *
 * Sampling: per (case×alias×variant) cell, sample ≥1 regex-pass + ≥1 regex-fail
 * on the pull-tool axis (and the negative-correct axis for negative cases).
 *
 * Judges: zhipu/glm51 + ds/v4pro + kimi (panel-internal, 2/3 majority).
 *
 * Run:
 *   npm run test:eval -- repointel-tool-adoption-child-v2-judge-audit
 */

import { readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it } from 'vitest';

import { availableAliases, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runOneShot } from '../benchmark/harness/harness.js';

const DUMP_SOURCE_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'repointel-tool-adoption-child-v2');
const AUDIT_DUMP_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'repointel-tool-adoption-child-v2-judge-audit');
const JUDGES: readonly ModelAlias[] = ['zhipu/glm51', 'ds/v4pro', 'kimi'] as const;

const PULL_TOOL_NAMES = ['repo_overview','changed_scope','changed_diff','changed_diff_bundle','module_context','symbol_context','process_context','impact_estimate'];

interface DumpRun {
  runIndex: number;
  firstToolName: string | null;
  firstToolFromBinding: string | null;
  firstToolFromTextRegex: string | null;
  isPullTool: boolean;
  isExpectedNegativeTool: boolean;
  text: string;
  durationMs: number;
  error?: string;
}
interface DumpCell {
  alias: string;
  variant: string;
  runs: DumpRun[];
}
interface DumpFile {
  case: string;
  stage: string;
  userMessage: string;
  isNegative: boolean;
  preferredPullTools: string[];
  negativePreferred: string[];
  cells: DumpCell[];
}

interface JudgeVerdict {
  judgment: 'PASS' | 'FAIL' | 'UNCLEAR';
  reason: string;
  rawJudgeText: string;
}

function parseJudgeReply(raw: string): JudgeVerdict {
  const m = raw.match(/\{[\s\S]*?\}/);
  if (!m) return { judgment: 'UNCLEAR', reason: 'no JSON', rawJudgeText: raw };
  try {
    const obj = JSON.parse(m[0]) as { judgment?: string; reason?: string };
    const j = (obj.judgment ?? '').toUpperCase();
    if (j === 'PASS' || j === 'FAIL') return { judgment: j, reason: obj.reason ?? '', rawJudgeText: raw };
    return { judgment: 'UNCLEAR', reason: `unrecognized "${obj.judgment}"`, rawJudgeText: raw };
  } catch {
    return { judgment: 'UNCLEAR', reason: 'parse error', rawJudgeText: raw };
  }
}

function majorityVote(verdicts: readonly JudgeVerdict[]): 'PASS' | 'FAIL' | 'UNCLEAR' {
  let p = 0, f = 0;
  for (const v of verdicts) { if (v.judgment === 'PASS') p++; else if (v.judgment === 'FAIL') f++; }
  if (p >= 2) return 'PASS';
  if (f >= 2) return 'FAIL';
  return 'UNCLEAR';
}

function bindingHint(bindingName: string | null): string {
  if (!bindingName) return 'HARNESS CONTEXT: model used NO binding-level tool_use; if rawText shows no invocation either, this is genuinely "no tool invoked".\n\n';
  return `HARNESS CONTEXT: the streaming harness captured a real binding-level tool invocation with name = \`${bindingName}\`. This is an ACTUAL API tool_use (not verbal text). Treat this as a VALID first invocation regardless of whether the rawText is empty or only contains verbal description. The binding is the canonical source of truth — rawText may be empty when the model emits only tool_use blocks.\n\n`;
}

function buildPullJudgePrompt(rawText: string, bindingName: string | null): { systemPrompt: string; userMessage: string } {
  return {
    systemPrompt:
      'You are an independent judge auditing a coding agent\'s tool-call behavior. ' +
      'Reply exactly one line of JSON — no markdown.',
    userMessage:
      `An agent was given a user request and asked to take its FIRST action. We are auditing whether the ` +
      `agent's FIRST tool invocation is one of the repo-intelligence pull-tools: ${PULL_TOOL_NAMES.join(', ')}.\n\n` +
      bindingHint(bindingName) +
      `Treat all of the following as VALID invocation syntax (model families differ):\n` +
      `  - Binding-level tool_use (per HARNESS CONTEXT above)\n` +
      `  - \`tool_name(args)\` function-call form in rawText\n` +
      `  - \`<tool_call>{"name":"tool_name", ...}</tool_call>\` JSON-in-XML in rawText\n` +
      `  - \`<tool_name>...</tool_name>\` XML-tag form in rawText\n\n` +
      `Important: a verbal mention like "I should use module_context" without an actual invocation block ` +
      `(in either binding or rawText) is FAIL. The judgment is ONLY about whether the FIRST actual tool ` +
      `invocation is a pull-tool from the list above.\n\n` +
      `--- AGENT RAW RESPONSE BEGIN ---\n${rawText}\n--- AGENT RAW RESPONSE END ---\n\n` +
      `Reply:\n` +
      `  {"judgment":"PASS","reason":"<≤80 chars>"}  if the first invocation is a pull-tool\n` +
      `  {"judgment":"FAIL","reason":"<≤80 chars>"}  otherwise (read/grep/glob/bash/none/other)`,
  };
}

function buildNegativeJudgePrompt(rawText: string, expectedTools: readonly string[], bindingName: string | null): { systemPrompt: string; userMessage: string } {
  return {
    systemPrompt:
      'You are an independent judge auditing a coding agent\'s tool-call behavior. ' +
      'Reply exactly one line of JSON — no markdown.',
    userMessage:
      `An agent was given a user request that does NOT match the pull-tool family. The expected FIRST tool ` +
      `for this request is one of: ${expectedTools.join(', ')}.\n\n` +
      bindingHint(bindingName) +
      `Audit whether the agent\'s FIRST tool invocation matches one of the expected tools above. Use the ` +
      `same syntax-tolerant criteria (binding-level / function-call / JSON-in-XML / XML-tag).\n\n` +
      `--- AGENT RAW RESPONSE BEGIN ---\n${rawText}\n--- AGENT RAW RESPONSE END ---\n\n` +
      `Reply:\n` +
      `  {"judgment":"PASS","reason":"<≤80 chars>"}  if first invocation is one of [${expectedTools.join(', ')}]\n` +
      `  {"judgment":"FAIL","reason":"<≤80 chars>"}  otherwise`,
  };
}

interface AuditSample {
  caseId: string;
  alias: string;
  variant: string;
  runIndex: number;
  isNegative: boolean;
  text: string;
  bindingName: string | null;
  axis: 'pull' | 'negative_correct';
  regexVerdict: 'PASS' | 'FAIL';
  expectedNegativeTools?: readonly string[];
  judgeVerdicts?: Record<string, JudgeVerdict>;
  majority?: 'PASS' | 'FAIL' | 'UNCLEAR';
  agreesWithRegex?: boolean;
}

function pickSamplesFromCell(dumpFile: DumpFile, cell: DumpCell): AuditSample[] {
  const samples: AuditSample[] = [];
  // Pull-tool axis
  const pullPass = cell.runs.filter((r) => r.isPullTool);
  const pullFail = cell.runs.filter((r) => !r.isPullTool && !r.error);
  const push = (run: DumpRun, axis: 'pull' | 'negative_correct', verdict: 'PASS' | 'FAIL') => {
    samples.push({
      caseId: dumpFile.case, alias: cell.alias, variant: cell.variant,
      runIndex: run.runIndex, isNegative: dumpFile.isNegative,
      text: run.text, bindingName: run.firstToolFromBinding,
      axis, regexVerdict: verdict,
      expectedNegativeTools: dumpFile.isNegative ? dumpFile.negativePreferred : undefined,
    });
  };
  if (pullPass.length > 0) push(pullPass[0], 'pull', 'PASS');
  if (pullFail.length > 0) push(pullFail[0], 'pull', 'FAIL');
  // Negative-correct axis (only for negative cases)
  if (dumpFile.isNegative) {
    const negPass = cell.runs.filter((r) => r.isExpectedNegativeTool);
    const negFail = cell.runs.filter((r) => !r.isExpectedNegativeTool && !r.error);
    if (negPass.length > 0) push(negPass[0], 'negative_correct', 'PASS');
    if (negFail.length > 0) push(negFail[0], 'negative_correct', 'FAIL');
  }
  return samples;
}

describe('Audit: Suite A child F1v2+F2 LLM-judge (anti-pattern 7 §3)', () => {
  const judges = availableAliases(...JUDGES);
  if (judges.length < JUDGES.length) {
    it(`skips: need all 3 judges (${JUDGES.join(', ')}); have ${judges.join(', ') || '(none)'}`, () => {});
    return;
  }

  it('audits sampled first-tool picks across all cells', { timeout: 90 * 60_000 }, async () => {
    mkdirSync(AUDIT_DUMP_ROOT, { recursive: true });

    let dumpFiles: string[];
    try {
      dumpFiles = readdirSync(DUMP_SOURCE_ROOT).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
    } catch {
      // eslint-disable-next-line no-console
      console.log(`No dumps at ${DUMP_SOURCE_ROOT} — run the eval first.`);
      return;
    }

    const allSamples: AuditSample[] = [];
    for (const f of dumpFiles) {
      const dump = JSON.parse(readFileSync(join(DUMP_SOURCE_ROOT, f), 'utf8')) as DumpFile;
      for (const cell of dump.cells) {
        const picks = pickSamplesFromCell(dump, cell);
        allSamples.push(...picks);
      }
    }
    // eslint-disable-next-line no-console
    console.log(`Suite A audit: ${allSamples.length} samples × ${JUDGES.length} judges = ${allSamples.length * JUDGES.length} LLM calls`);

    for (const sample of allSamples) {
      const prompt = sample.axis === 'pull'
        ? buildPullJudgePrompt(sample.text, sample.bindingName)
        : buildNegativeJudgePrompt(sample.text, sample.expectedNegativeTools ?? [], sample.bindingName);
      const verdicts: Record<string, JudgeVerdict> = {};
      for (const judge of judges) {
        try {
          const out = await runOneShot(judge, prompt);
          verdicts[judge] = parseJudgeReply(out.text);
        } catch (err) {
          verdicts[judge] = {
            judgment: 'UNCLEAR',
            reason: err instanceof Error ? err.message : String(err),
            rawJudgeText: '',
          };
        }
      }
      const majority = majorityVote(Object.values(verdicts));
      sample.judgeVerdicts = verdicts;
      sample.majority = majority;
      sample.agreesWithRegex = majority === 'UNCLEAR' ? false : majority === sample.regexVerdict;
    }

    const agg = (axis: 'pull' | 'negative_correct') => {
      const sub = allSamples.filter((s) => s.axis === axis);
      const agree = sub.filter((s) => s.agreesWithRegex === true).length;
      const disagree = sub.filter((s) => s.majority && s.majority !== 'UNCLEAR' && !s.agreesWithRegex).length;
      const unclear = sub.filter((s) => s.majority === 'UNCLEAR').length;
      const total = sub.length;
      return { total, agree, disagree, unclear, disagPct: total === 0 ? 0 : (disagree / total) * 100 };
    };
    const pullAgg = agg('pull');
    const negAgg = agg('negative_correct');

    const dumpOut = join(AUDIT_DUMP_ROOT, '_audit-samples.json');
    writeFileSync(dumpOut, JSON.stringify({
      judges, totalSamples: allSamples.length,
      pullAxis: pullAgg, negativeCorrectAxis: negAgg,
      samples: allSamples,
    }, null, 2), 'utf8');

    const verdict = (a: typeof pullAgg) =>
      a.unclear > a.total * 0.10 ? `WARN unclear=${a.unclear}/${a.total}`
      : a.disagPct > 10 ? `INVALID disagreement=${a.disagPct.toFixed(1)}% > 10%`
      : `VALID disagreement=${a.disagPct.toFixed(1)}%`;
    // eslint-disable-next-line no-console
    console.log(`\n=== SUITE A AUDIT VERDICT ===`);
    // eslint-disable-next-line no-console
    console.log(`pull axis:             ${verdict(pullAgg)}  (agree=${pullAgg.agree} disagree=${pullAgg.disagree} unclear=${pullAgg.unclear} total=${pullAgg.total})`);
    // eslint-disable-next-line no-console
    console.log(`negative-correct axis: ${verdict(negAgg)}  (agree=${negAgg.agree} disagree=${negAgg.disagree} unclear=${negAgg.unclear} total=${negAgg.total})`);
    // eslint-disable-next-line no-console
    console.log(`audit dump: ${dumpOut}`);
  });
});
