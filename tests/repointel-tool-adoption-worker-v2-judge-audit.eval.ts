/**
 * Audit driver for Suite B (Worker F2 + F3 first-tool pick).
 *
 * Enforces EVAL_GUIDELINES anti-pattern 7 §3.
 *
 * Three judging axes:
 *  - pull: first tool is a repo-intel pull-tool (positive cases)
 *  - bash_git_diff: first tool is bash with `git diff/show` command (the legacy
 *    fallback we are trying to suppress on positive cases)
 *  - negative_correct: first tool is bash (and the cmd is status/log/branch/etc)
 *    for negative cases
 *
 * Run:
 *   npm run test:eval -- repointel-tool-adoption-worker-v2-judge-audit
 */

import { readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it } from 'vitest';

import { availableAliases, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runOneShot } from '../benchmark/harness/harness.js';

const DUMP_SOURCE_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'repointel-tool-adoption-worker-v2');
const AUDIT_DUMP_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'repointel-tool-adoption-worker-v2-judge-audit');
const JUDGES: readonly ModelAlias[] = ['zhipu/glm51', 'ds/v4pro', 'kimi'] as const;

const PULL_TOOL_NAMES = ['repo_overview','changed_scope','changed_diff','changed_diff_bundle','module_context','symbol_context','process_context','impact_estimate'];

interface DumpRun {
  runIndex: number;
  firstToolName: string | null;
  firstToolFromBinding: string | null;
  firstToolFromTextRegex: string | null;
  firstToolClass: string;
  isPullTool: boolean;
  isBashGitDiff: boolean;
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
  preferredFirstTools: string[];
  negativeExpectedTools: string[];
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

function bindingHint(bindingName: string | null, firstToolClass: string | null): string {
  if (!bindingName) {
    if (firstToolClass === 'plan_only') return 'HARNESS CONTEXT: model emitted ONLY `todo_update` (plan step) with no follow-up exploration tool. Treat as "no exploration invocation".\n\n';
    return 'HARNESS CONTEXT: model used NO binding-level tool_use; if rawText shows no invocation either, this is genuinely "no tool invoked".\n\n';
  }
  let bashCmdHint = '';
  if (bindingName === 'bash') {
    if (firstToolClass === 'bash_git_diff') bashCmdHint = ' The bash command was a `git diff` or `git show` invocation (review-fallback pattern).';
    else if (firstToolClass === 'bash_git_other') bashCmdHint = ' The bash command was a legitimate non-review git op (one of: status / log / branch / tag / stash / fetch / remote / rev-parse / describe).';
    else if (firstToolClass === 'bash_non_git') bashCmdHint = ' The bash command was NOT a git op (some other shell command).';
    else if (firstToolClass === 'bash_unknown') bashCmdHint = ' The bash command was captured via text fallback — command details unknown.';
  }
  return `HARNESS CONTEXT: the streaming harness captured a real binding-level tool invocation with name = \`${bindingName}\` (excluding any leading \`todo_update\` plan step).${bashCmdHint} This is an ACTUAL API tool_use, not verbal text. Treat this as a VALID first exploration invocation regardless of whether the rawText is empty or only contains verbal description. The binding (and bash command class above, when applicable) is the canonical source of truth.\n\n`;
}

function buildPullJudgePrompt(rawText: string, bindingName: string | null, firstToolClass: string | null): { systemPrompt: string; userMessage: string } {
  return {
    systemPrompt:
      'You are an independent judge auditing a coding agent\'s tool-call behavior. ' +
      'Reply exactly one line of JSON — no markdown.',
    userMessage:
      `An agent (Worker) responded to a code-review request. Audit whether the agent\'s FIRST exploration ` +
      `tool invocation (after any leading \`todo_update\` plan step) is a repo-intelligence pull-tool: ` +
      `${PULL_TOOL_NAMES.join(', ')}.\n\n` +
      bindingHint(bindingName, firstToolClass) +
      `Treat all of the following as VALID invocation syntax:\n` +
      `  - Binding-level tool_use (per HARNESS CONTEXT above)\n` +
      `  - \`tool_name(args)\` / JSON-in-XML / \`<tool_name>...\` in rawText\n\n` +
      `Verbal mentions without actual invocation = FAIL.\n\n` +
      `--- AGENT RAW RESPONSE BEGIN ---\n${rawText}\n--- AGENT RAW RESPONSE END ---\n\n` +
      `Reply:\n` +
      `  {"judgment":"PASS","reason":"<≤80 chars>"}  if first non-plan invocation is a pull-tool\n` +
      `  {"judgment":"FAIL","reason":"<≤80 chars>"}  otherwise`,
  };
}

function buildBashGitDiffJudgePrompt(rawText: string, bindingName: string | null, firstToolClass: string | null): { systemPrompt: string; userMessage: string } {
  return {
    systemPrompt:
      'You are an independent judge auditing a coding agent\'s tool-call behavior. ' +
      'Reply exactly one line of JSON — no markdown.',
    userMessage:
      `An agent (Worker) responded to a code-review request. Audit whether the agent\'s FIRST exploration ` +
      `tool invocation is bash with a "git diff" or "git show" command (the legacy review-by-bash pattern).\n\n` +
      bindingHint(bindingName, firstToolClass) +
      `Notes:\n` +
      `  - PASS only if the first non-plan tool is \`bash\` AND its command is git diff/show.\n` +
      `  - "git log" alone does NOT count as bash_git_diff for THIS axis.\n` +
      `  - Pull-tools, read/grep/glob, dispatch_child_task = FAIL for this axis.\n\n` +
      `--- AGENT RAW RESPONSE BEGIN ---\n${rawText}\n--- AGENT RAW RESPONSE END ---\n\n` +
      `Reply:\n` +
      `  {"judgment":"PASS","reason":"<≤80 chars>"}  if first non-plan tool is bash with git diff/show\n` +
      `  {"judgment":"FAIL","reason":"<≤80 chars>"}  otherwise`,
  };
}

function buildNegativeCorrectJudgePrompt(rawText: string, bindingName: string | null, firstToolClass: string | null): { systemPrompt: string; userMessage: string } {
  // Decision rule for empty-rawText + binding-captured invocations: the
  // streaming harness records actual API tool_use blocks that may NOT appear
  // in rawText. When that happens, the HARNESS CONTEXT is the source of
  // truth, NOT the empty rawText. Judges that vote FAIL on empty rawText
  // while HARNESS CONTEXT shows a valid bash git op are misreading the
  // protocol — empty rawText with a binding tool_use is the normal "model
  // emitted only tool_use blocks, no commentary" case.
  const sys =
    'You are an independent judge auditing a coding agent\'s tool-call behavior. ' +
    'CRITICAL DECISION RULE: this protocol streams tool_use blocks separately from text. ' +
    'An empty rawText with a binding-level tool_use (per HARNESS CONTEXT) means the model ' +
    'invoked a tool and emitted no commentary — this is a VALID invocation, NOT a "no response" case. ' +
    'Trust HARNESS CONTEXT as canonical source of truth when it is provided. ' +
    'Reply exactly one line of JSON — no markdown.';
  return {
    systemPrompt: sys,
    userMessage:
      `${bindingHint(bindingName, firstToolClass)}` +
      `An agent (Worker) was asked a non-review question (e.g., "what files are uncommitted", "show recent commits"). ` +
      `Audit whether the agent\'s FIRST tool invocation is \`bash\` with an appropriate git command ` +
      `(status, log, branch, tag, stash, fetch, remote, rev-parse, describe — legitimate non-review git ops).\n\n` +
      `Decision rules:\n` +
      `  PASS if HARNESS CONTEXT shows bindingName=\`bash\` AND firstToolClass=\`bash_git_other\` (legitimate non-review git op).\n` +
      `  PASS if rawText shows bash invocation with git status/log/branch/tag.\n` +
      `  FAIL only if the agent used pull-tool/read/grep (over-suppressed bash) or invoked bash with git diff/show (wrong cmd type for these questions).\n` +
      `  Note: empty rawText with VALID HARNESS CONTEXT binding = PASS. The model emitted tool_use without commentary.\n\n` +
      `--- AGENT RAW RESPONSE BEGIN ---\n${rawText}\n--- AGENT RAW RESPONSE END ---\n\n` +
      `Reply:\n` +
      `  {"judgment":"PASS","reason":"<≤80 chars>"}\n` +
      `  {"judgment":"FAIL","reason":"<≤80 chars>"}`,
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
  firstToolClass: string | null;
  axis: 'pull' | 'bash_git_diff' | 'negative_correct';
  regexVerdict: 'PASS' | 'FAIL';
  judgeVerdicts?: Record<string, JudgeVerdict>;
  majority?: 'PASS' | 'FAIL' | 'UNCLEAR';
  agreesWithRegex?: boolean;
}

function pickSamplesFromCell(dump: DumpFile, cell: DumpCell): AuditSample[] {
  const samples: AuditSample[] = [];
  const push = (run: DumpRun, axis: AuditSample['axis'], verdict: 'PASS' | 'FAIL') => {
    samples.push({
      caseId: dump.case, alias: cell.alias, variant: cell.variant,
      runIndex: run.runIndex, isNegative: dump.isNegative,
      text: run.text, bindingName: run.firstToolFromBinding,
      firstToolClass: run.firstToolClass,
      axis, regexVerdict: verdict,
    });
  };
  if (!dump.isNegative) {
    // Positive: pull axis + bash_git_diff axis
    const pullPass = cell.runs.filter((r) => r.isPullTool);
    const pullFail = cell.runs.filter((r) => !r.isPullTool && !r.error);
    if (pullPass.length > 0) push(pullPass[0], 'pull', 'PASS');
    if (pullFail.length > 0) push(pullFail[0], 'pull', 'FAIL');
    const bashPass = cell.runs.filter((r) => r.isBashGitDiff);
    const bashFail = cell.runs.filter((r) => !r.isBashGitDiff && !r.error);
    if (bashPass.length > 0) push(bashPass[0], 'bash_git_diff', 'PASS');
    if (bashFail.length > 0) push(bashFail[0], 'bash_git_diff', 'FAIL');
  } else {
    // Negative: only negative_correct axis matters
    const negPass = cell.runs.filter((r) => r.isExpectedNegativeTool);
    const negFail = cell.runs.filter((r) => !r.isExpectedNegativeTool && !r.error);
    if (negPass.length > 0) push(negPass[0], 'negative_correct', 'PASS');
    if (negFail.length > 0) push(negFail[0], 'negative_correct', 'FAIL');
  }
  return samples;
}

describe('Audit: Suite B Worker F2+F3 LLM-judge (anti-pattern 7 §3)', () => {
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
    console.log(`Suite B audit: ${allSamples.length} samples × ${JUDGES.length} judges = ${allSamples.length * JUDGES.length} LLM calls`);

    for (const sample of allSamples) {
      const prompt =
        sample.axis === 'pull' ? buildPullJudgePrompt(sample.text, sample.bindingName, sample.firstToolClass)
        : sample.axis === 'bash_git_diff' ? buildBashGitDiffJudgePrompt(sample.text, sample.bindingName, sample.firstToolClass)
        : buildNegativeCorrectJudgePrompt(sample.text, sample.bindingName, sample.firstToolClass);
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

    const agg = (axis: AuditSample['axis']) => {
      const sub = allSamples.filter((s) => s.axis === axis);
      const agree = sub.filter((s) => s.agreesWithRegex === true).length;
      const disagree = sub.filter((s) => s.majority && s.majority !== 'UNCLEAR' && !s.agreesWithRegex).length;
      const unclear = sub.filter((s) => s.majority === 'UNCLEAR').length;
      const total = sub.length;
      return { total, agree, disagree, unclear, disagPct: total === 0 ? 0 : (disagree / total) * 100 };
    };
    const pullAgg = agg('pull');
    const bashAgg = agg('bash_git_diff');
    const negAgg = agg('negative_correct');

    const dumpOut = join(AUDIT_DUMP_ROOT, '_audit-samples.json');
    writeFileSync(dumpOut, JSON.stringify({
      judges, totalSamples: allSamples.length,
      pullAxis: pullAgg, bashGitDiffAxis: bashAgg, negativeCorrectAxis: negAgg,
      samples: allSamples,
    }, null, 2), 'utf8');

    const verdict = (a: typeof pullAgg) =>
      a.unclear > a.total * 0.10 ? `WARN unclear=${a.unclear}/${a.total}`
      : a.disagPct > 10 ? `INVALID disagreement=${a.disagPct.toFixed(1)}% > 10%`
      : `VALID disagreement=${a.disagPct.toFixed(1)}%`;
    // eslint-disable-next-line no-console
    console.log(`\n=== SUITE B AUDIT VERDICT ===`);
    // eslint-disable-next-line no-console
    console.log(`pull axis:             ${verdict(pullAgg)}  (agree=${pullAgg.agree} disagree=${pullAgg.disagree} unclear=${pullAgg.unclear} total=${pullAgg.total})`);
    // eslint-disable-next-line no-console
    console.log(`bash_git_diff axis:    ${verdict(bashAgg)}  (agree=${bashAgg.agree} disagree=${bashAgg.disagree} unclear=${bashAgg.unclear} total=${bashAgg.total})`);
    // eslint-disable-next-line no-console
    console.log(`negative-correct axis: ${verdict(negAgg)}  (agree=${negAgg.agree} disagree=${negAgg.disagree} unclear=${negAgg.unclear} total=${negAgg.total})`);
    // eslint-disable-next-line no-console
    console.log(`audit dump: ${dumpOut}`);
  });
});
