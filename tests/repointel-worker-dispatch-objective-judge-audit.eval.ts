/**
 * Audit driver for Suite 0 (Worker dispatch objective quality F0a/F0b).
 *
 * Enforces EVAL_GUIDELINES anti-pattern 7 §3:
 *   > 跑完后强制抽查：每个 cell 至少抽 1 条 regex-fail 用 LLM-judge
 *   > （干净 context）独立判一次。disagreement >10% → 整套数据作废。
 *
 * And the panel-internal judge-model rule:
 *   > 禁止 anthropic/openai 等"外来 strong model"做 LLM-judge … allowed:
 *   > panel-internal multi-judge majority vote.
 *
 * Input: dump files at `os.tmpdir()/kodax-eval-dumps/
 *   repointel-worker-dispatch-objective/{case}.json` from the eval pass.
 *
 * Sampling (≥1 pass + ≥1 fail per cell on each axis):
 *   - bash-directive axis: per (case×alias×variant) cell sample at least
 *     1 regex-classifies-as-bash + 1 regex-classifies-as-no-bash if both
 *     exist; else sample 1 of whichever exists.
 *   - pull-tool-correct axis: same pattern.
 *
 * Aggregation: 3-judge majority (zhipu/glm52 + ds/v4pro + kimi); ties or
 * unparseable replies = UNCLEAR. Disagreement = (judge majority ≠ regex
 * verdict). >10% across audited dump-runs → suite INVALID.
 *
 * Run:
 *   npm run test:eval -- repointel-worker-dispatch-objective-judge-audit
 *
 * Skips when any of the 3 judge keys is missing.
 */

import { readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it } from 'vitest';

import { availableAliases, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runOneShot } from '../benchmark/harness/harness.js';

const DUMP_SOURCE_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'repointel-worker-dispatch-objective');
const AUDIT_DUMP_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'repointel-worker-dispatch-objective-judge-audit');
const JUDGES: readonly ModelAlias[] = ['zhipu/glm52', 'ds/v4pro', 'kimi'] as const;

interface DumpRun {
  runIndex: number;
  dispatchObjectives: Array<{ source: string; objective: string }>;
  bashDirectiveCount: number;
  pullCorrectMentionCount: number;
  pullAnyMentionCount: number;
  didDispatch: boolean;
  durationMs: number;
  text: string;
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
  preferredPullToolsForChild: string[];
  cells: DumpCell[];
}

interface JudgeVerdict {
  judgment: 'PASS' | 'FAIL' | 'UNCLEAR';
  reason: string;
  rawJudgeText: string;
}

function parseJudgeReply(raw: string): JudgeVerdict {
  const jsonMatch = raw.match(/\{[\s\S]*?\}/);
  if (!jsonMatch) return { judgment: 'UNCLEAR', reason: 'no JSON', rawJudgeText: raw };
  try {
    const obj = JSON.parse(jsonMatch[0]) as { judgment?: string; reason?: string };
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

// Build judge prompt for the BASH DIRECTIVE axis (PASS = directive present).
function buildBashJudgePrompt(objective: string): { systemPrompt: string; userMessage: string } {
  return {
    systemPrompt:
      'You are an independent judge auditing a coding agent\'s dispatch objective text. ' +
      'Reply exactly one line of JSON — no markdown.',
    userMessage:
      `An agent (the "Worker") wrote a dispatch_child_task objective for a child agent. We are auditing ` +
      `whether the Worker hand-fed a specific bash command in the objective.\n\n` +
      `Definition of "bash directive": the objective explicitly instructs the child to RUN/USE a specific ` +
      `bash command (e.g., "use \`git diff X..Y\`", "通过 git diff 来对比", "执行 git log").\n\n` +
      `NOT a bash directive: stating a revision/scope as data (e.g., "scope: v0.7.39..HEAD"), referencing ` +
      `a path or version without commanding a shell command, or quoting "git" in a non-imperative way ` +
      `(e.g., "since git history shows...").\n\n` +
      `--- OBJECTIVE TEXT BEGIN ---\n${objective}\n--- OBJECTIVE TEXT END ---\n\n` +
      `Reply exactly:\n` +
      `  {"judgment":"PASS","reason":"<≤80 chars>"}  if a bash directive IS present\n` +
      `  {"judgment":"FAIL","reason":"<≤80 chars>"}  if NO bash directive`,
  };
}

// Build judge prompt for PULL-TOOL CORRECT mention axis (PASS = correct mention).
function buildPullJudgePrompt(
  objective: string,
  preferredPullTools: readonly string[],
): { systemPrompt: string; userMessage: string } {
  return {
    systemPrompt:
      'You are an independent judge auditing a coding agent\'s dispatch objective text. ' +
      'Reply exactly one line of JSON — no markdown.',
    userMessage:
      `An agent (the "Worker") wrote a dispatch_child_task objective for a child agent. The case-appropriate ` +
      `pull-tool family for this task is one of: ${preferredPullTools.join(', ')}.\n\n` +
      `Definition of "correct pull-tool mention": the objective EXPLICITLY names at least ONE of the ` +
      `case-appropriate pull-tools from the list above, in a way that recommends the child use it ` +
      `(e.g., "use changed_scope to scope first", "start with module_context").\n\n` +
      `NOT a correct mention: mentioning an UNRELATED pull-tool (e.g., listing impact_estimate for a ` +
      `comprehensive review case), or merely naming the tool without context (e.g., a tool list pasted ` +
      `verbatim with no recommendation), or no mention at all.\n\n` +
      `--- OBJECTIVE TEXT BEGIN ---\n${objective}\n--- OBJECTIVE TEXT END ---\n\n` +
      `Reply exactly:\n` +
      `  {"judgment":"PASS","reason":"<≤80 chars>"}  if correct pull-tool mention\n` +
      `  {"judgment":"FAIL","reason":"<≤80 chars>"}  if no correct pull-tool mention`,
  };
}

interface AuditSample {
  caseId: string;
  alias: string;
  variant: string;
  runIndex: number;
  objectiveIdx: number;
  objectiveText: string;
  axis: 'bash' | 'pull_correct';
  regexVerdict: 'PASS' | 'FAIL';
  judgeVerdicts?: Record<string, JudgeVerdict>;
  majority?: 'PASS' | 'FAIL' | 'UNCLEAR';
  agreesWithRegex?: boolean;
}

// For each cell, pick ≥1 regex-pass + ≥1 regex-fail dump-run (or 1 of whichever
// exists) on EACH axis. A "regex-pass on bash axis" = bashDirectiveCount > 0.
// A "regex-pass on pull_correct axis" = pullCorrectMentionCount > 0.
function pickSamplesFromCell(caseId: string, cell: DumpCell, preferred: readonly string[]): AuditSample[] {
  void preferred; // for type doc; passed to judge builder separately
  const samples: AuditSample[] = [];
  // Flatten run × objective rows
  type Row = {
    runIndex: number;
    objectiveIdx: number;
    objectiveText: string;
    bashPass: boolean;
    pullCorrectPass: boolean;
  };
  const rows: Row[] = [];
  for (const run of cell.runs) {
    for (let i = 0; i < run.dispatchObjectives.length; i++) {
      const objective = run.dispatchObjectives[i].objective;
      // Re-derive regex verdicts per-objective using same regex as eval file
      // (we trust eval's bashDirectiveCount/pullCorrectMentionCount as aggregate
      // truth for the cell, but here we want per-objective truth — use a
      // conservative re-derivation: treat objective as "pass" if it contains
      // any git command-like phrase; ditto for pull-tool name).
      const objLow = objective.toLowerCase();
      const bashPass = /\b(?:使用|use|run|execute|执行|跑|invoke|call|通过|输入|command|命令|指令)[^a-z0-9]*[`"']?git\s+(?:diff|log|show|status|tag|branch)\b/i.test(objective)
        || /[`'"]git\s+(?:diff|log|show)\b/i.test(objective);
      const pullCorrectPass = preferred.some((tn) =>
        // Match tool name preceded by a word boundary, opening punctuation, or whitespace.
        // Use a non-capturing alternation outside the char class — `\b` inside a char
        // class is a literal backspace (U+0008), not a word boundary.
        new RegExp(`(?:^|[<\`(\\s'"])${tn.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`).test(objLow))
        // also require the name appears as a recommendation/instruction (rough heuristic)
        && /(?:use|call|invoke|start with|scope via|首先|先|通过|using|via)/i.test(objective);
      rows.push({ runIndex: run.runIndex, objectiveIdx: i, objectiveText: objective, bashPass, pullCorrectPass });
    }
  }
  if (rows.length === 0) return samples;
  // Bash axis: 1 pass + 1 fail (if both exist), else 1 of whichever exists
  const bashPass = rows.filter((r) => r.bashPass);
  const bashFail = rows.filter((r) => !r.bashPass);
  const pushBash = (r: Row, verdict: 'PASS' | 'FAIL') => {
    samples.push({
      caseId, alias: cell.alias, variant: cell.variant,
      runIndex: r.runIndex, objectiveIdx: r.objectiveIdx, objectiveText: r.objectiveText,
      axis: 'bash', regexVerdict: verdict,
    });
  };
  if (bashPass.length > 0) pushBash(bashPass[0], 'PASS');
  if (bashFail.length > 0) pushBash(bashFail[0], 'FAIL');
  // Pull-correct axis: same pattern
  const pullPass = rows.filter((r) => r.pullCorrectPass);
  const pullFail = rows.filter((r) => !r.pullCorrectPass);
  const pushPull = (r: Row, verdict: 'PASS' | 'FAIL') => {
    samples.push({
      caseId, alias: cell.alias, variant: cell.variant,
      runIndex: r.runIndex, objectiveIdx: r.objectiveIdx, objectiveText: r.objectiveText,
      axis: 'pull_correct', regexVerdict: verdict,
    });
  };
  if (pullPass.length > 0) pushPull(pullPass[0], 'PASS');
  if (pullFail.length > 0) pushPull(pullFail[0], 'FAIL');
  return samples;
}

describe('Audit: Suite 0 Worker dispatch objective LLM-judge (anti-pattern 7 §3)', () => {
  const judges = availableAliases(...JUDGES);
  if (judges.length < JUDGES.length) {
    it(`skips: need all 3 judges (${JUDGES.join(', ')}); have ${judges.join(', ') || '(none)'}`, () => {});
    return;
  }

  it('audits sampled dispatch objectives across all cells', { timeout: 90 * 60_000 }, async () => {
    mkdirSync(AUDIT_DUMP_ROOT, { recursive: true });

    // Read all dump files
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
        const picks = pickSamplesFromCell(dump.case, cell, dump.preferredPullToolsForChild);
        allSamples.push(...picks);
      }
    }

    // eslint-disable-next-line no-console
    console.log(`Suite 0 audit: ${allSamples.length} samples × ${JUDGES.length} judges = ${allSamples.length * JUDGES.length} LLM calls`);

    // Judge each sample
    for (const sample of allSamples) {
      const { systemPrompt, userMessage } =
        sample.axis === 'bash'
          ? buildBashJudgePrompt(sample.objectiveText)
          : buildPullJudgePrompt(sample.objectiveText, []); // preferred list embedded later — fix below
      // Re-pull preferred for the pull-tool prompt
      let actualPrompt = { systemPrompt, userMessage };
      if (sample.axis === 'pull_correct') {
        // Find the case file for preferred list
        const caseFile = dumpFiles.find((f) => f.startsWith(`${sample.caseId}.`));
        if (caseFile) {
          const dump = JSON.parse(readFileSync(join(DUMP_SOURCE_ROOT, caseFile), 'utf8')) as DumpFile;
          actualPrompt = buildPullJudgePrompt(sample.objectiveText, dump.preferredPullToolsForChild);
        }
      }
      const verdicts: Record<string, JudgeVerdict> = {};
      for (const judge of judges) {
        try {
          const out = await runOneShot(judge, actualPrompt);
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

    // Aggregate by axis
    const aggregate = (axis: 'bash' | 'pull_correct') => {
      const subset = allSamples.filter((s) => s.axis === axis);
      const agree = subset.filter((s) => s.agreesWithRegex === true).length;
      const disagree = subset.filter((s) => s.majority && s.majority !== 'UNCLEAR' && !s.agreesWithRegex).length;
      const unclear = subset.filter((s) => s.majority === 'UNCLEAR').length;
      const total = subset.length;
      const disagPct = total === 0 ? 0 : (disagree / total) * 100;
      return { total, agree, disagree, unclear, disagPct };
    };
    const bashAgg = aggregate('bash');
    const pullAgg = aggregate('pull_correct');

    const dumpOut = join(AUDIT_DUMP_ROOT, '_audit-samples.json');
    writeFileSync(dumpOut, JSON.stringify({
      judges, totalSamples: allSamples.length,
      bashAxis: bashAgg, pullCorrectAxis: pullAgg,
      samples: allSamples,
    }, null, 2), 'utf8');

    const verdict = (agg: typeof bashAgg) =>
      agg.unclear > agg.total * 0.10 ? `WARN unclear=${agg.unclear}/${agg.total}`
      : agg.disagPct > 10 ? `INVALID disagreement=${agg.disagPct.toFixed(1)}% > 10%`
      : `VALID disagreement=${agg.disagPct.toFixed(1)}%`;
    // eslint-disable-next-line no-console
    console.log(`\n=== SUITE 0 AUDIT VERDICT ===`);
    // eslint-disable-next-line no-console
    console.log(`bash axis:         ${verdict(bashAgg)}  (agree=${bashAgg.agree} disagree=${bashAgg.disagree} unclear=${bashAgg.unclear} total=${bashAgg.total})`);
    // eslint-disable-next-line no-console
    console.log(`pull-correct axis: ${verdict(pullAgg)}  (agree=${pullAgg.agree} disagree=${pullAgg.disagree} unclear=${pullAgg.unclear} total=${pullAgg.total})`);
    // eslint-disable-next-line no-console
    console.log(`audit dump: ${dumpOut}`);
  });
});
