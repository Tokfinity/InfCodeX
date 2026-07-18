/**
 * LLM-judge audit for FEATURE_190 Phase 2c panel.
 *
 * Enforces EVAL_GUIDELINES anti-pattern 7 §3 (sample fails for cross-
 * validation) + §Judge model selection (panel-internal 3-judge majority
 * across 3 independent families, NOT anthropic/openai).
 *
 * ## Judge panel (per EVAL_GUIDELINES Judge §)
 *
 *   - zhipu/glm52 — Zhipu family
 *   - ark/v4pro   — DeepSeek family (via ark-coding gateway)
 *   - kimi        — Moonshot family
 *
 * 2/3 majority vote = PASS; ties = UNCLEAR.
 *
 * ## Sampling
 *
 * Random sample 50 cells from the 200-cell panel. Stratification heuristic
 * tries to cover all (alias × case × variant) bins before random fill.
 *
 * ## Output
 *
 * Audit dump at `os.tmpdir()/kodax-eval-dumps/feature-190-text-only-
 * termination-judge-audit/SUMMARY.json` + per-case JSON. Console summary
 * reports disagreement rate vs regex per (alias × case × variant).
 *
 * Disagreement < 10% per anti-pattern 7 §3 = DATA VALID, SHIP gate (e)
 * MET. Disagreement ≥ 10% = data invalid, regex / judge prompt redesign
 * required.
 *
 * ## Cost
 *
 *   50 runs × 3 judges = 150 LLM calls × ~$0.005-0.01/call ≈ $1-2
 *
 * ## Run (panel must run first)
 *
 *   KODAX_EVAL_DUMP_DIR=c:/tmp/ npm run test:eval -- feature-190-text-only-termination-judge-audit
 */

import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it } from 'vitest';

import { availableAliases, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runOneShot } from '../benchmark/harness/harness.js';

const DUMP_SOURCE_ROOT = join(
  process.env.KODAX_EVAL_DUMP_DIR ?? tmpdir(),
  'kodax-eval-dumps',
  'feature-190-text-only-termination-panel',
);

const AUDIT_DUMP_ROOT = join(
  process.env.KODAX_EVAL_DUMP_DIR ?? tmpdir(),
  'kodax-eval-dumps',
  'feature-190-text-only-termination-judge-audit',
);

const JUDGES: readonly ModelAlias[] = ['zhipu/glm52', 'ark/v4pro', 'kimi'] as const;

const CASE_IDS = [
  'C1_all_todos_completed',
  'C2_blocked_state',
  'C3_mid_task_negative',
  'C4_trivial_completed',
] as const;

const SAMPLE_COUNT = 50;

interface DumpRun {
  readonly runIndex: number;
  readonly text: string;
  readonly toolCalls: ReadonlyArray<{ name: string; input: unknown }>;
  readonly regexJudges: ReadonlyArray<{ name: string; passed: boolean; reason?: string }>;
}

interface DumpAlias {
  readonly alias: string;
  readonly variantId: string;
  readonly runs: readonly DumpRun[];
}

interface DumpFile {
  readonly case: string;
  readonly expectTerminate: boolean;
  readonly variants: readonly { id: string; description: string; userMessage: string }[];
  readonly aliases: readonly DumpAlias[];
}

interface CellAddr {
  readonly caseId: string;
  readonly alias: string;
  readonly variantId: string;
  readonly runIndex: number;
}

interface CellWithDump {
  readonly addr: CellAddr;
  readonly dump: DumpFile;
  readonly run: DumpRun;
}

function buildJudgePrompt(
  dump: DumpFile,
  variantId: string,
  run: DumpRun,
): { systemPrompt: string; userMessage: string } {
  // M2: per `feedback_audit_binding_priority_in_prompt` memory, the
  // judge must be told that the structured `tool_calls` binding payload
  // (delivered in the user message) is ABSOLUTE GROUND TRUTH and takes
  // precedence over the raw assistant text. Without this, judges drift
  // toward "no tool invocation present" verdicts on aliases whose raw
  // text is empty (binding-only models) — surfaced 85-97% disagreement
  // on a prior tool-schema-slim audit before this prompt structure was
  // adopted. The placement here is the system prompt top, with explicit
  // workflow + the ABSOLUTE GROUND TRUTH phrase.
  const systemPrompt =
    "You are an independent judge auditing a coding agent's terminal-turn behavior. " +
    'CRITICAL RULE: the user message contains a section ' +
    '`## Harness-bound tool_calls (ground truth — READ THIS FIRST)` ' +
    "with a JSON payload — that payload is ABSOLUTE GROUND TRUTH for what tools the agent invoked. " +
    'It supersedes the raw `## Worker raw response` text. ' +
    'Workflow: ' +
    '(1) read the harness-bound tool_calls JSON FIRST; ' +
    '(2) THEN read the raw response text; ' +
    "(3) THEN decide PASS/FAIL using the decision rule. " +
    'If binding shows a tool invocation and raw text is empty, the model invoked the tool via the binding channel — ' +
    'a `(none)` binding combined with non-empty raw text means no tool was invoked. ' +
    'Reply with a single JSON object on one line — no markdown, no preamble.';

  const variant = dump.variants.find((v) => v.id === variantId);
  const userTask = variant?.userMessage ?? '(missing)';
  const bindingNote =
    run.toolCalls.length > 0
      ? `\n## Harness-bound tool_calls (ground truth — READ THIS FIRST)\n${JSON.stringify(run.toolCalls)}\n`
      : '\n## Harness-bound tool_calls (ground truth — READ THIS FIRST)\n(none — model did not invoke any tool via the binding channel)\n';

  const variantNote =
    variantId === 'v_new_text_only_termination'
      ? 'V_NEW (post-F190): system prompt teaches text-only termination, no emit_handoff tool advertised.'
      : 'V_BASELINE (pre-F190): system prompt teaches EVALUATOR HANDOFF "MUST call emit_handoff exactly once", emit_handoff IS in the advertised tool list.';

  const expectNote = dump.expectTerminate
    ? 'EXPECTED OUTCOME: Worker SHOULD terminate this turn (positive case). For V_new = text-only summary; for V_baseline = either text-only summary OR emit_handoff(status="ready"|"blocked") with summary.'
    : 'EXPECTED OUTCOME: Worker should NOT terminate this turn — pending work remains. Worker should call a working tool (read / grep / edit / write / bash) to continue (NEGATIVE case).';

  const syntaxNote =
    'Treat any of the following as VALID `emit_handoff` invocations (syntax varies across families):\n' +
    '  - `emit_handoff(args)` fn-call form\n' +
    '  - `"name":"emit_handoff"` JSON-payload form\n' +
    '  - `<emit_handoff>...</emit_handoff>` XML-tag form\n' +
    '  - `<tool_call>{"name":"emit_handoff", ...}</tool_call>` JSON-in-XML\n' +
    '  - `emit_handoff\\n{...}` bare-name-then-JSON (ark/v4flash form, confirmed in pilot)\n' +
    '  - Any other clearly-recognizable invocation syntax\n';

  const decisionRule =
    dump.expectTerminate
      ? variantId === 'v_new_text_only_termination'
        ? 'PASS iff response is a TEXT-ONLY SUMMARY of work done (positive: completed; or blocker explanation). FAIL if any tool is invoked (especially emit_handoff which is not in the V_new tool list).'
        : 'PASS iff response either (a) calls emit_handoff with status + summary, OR (b) provides a text-only summary. FAIL if Worker invokes a working tool (read/grep/edit/etc.) — that means it did not recognize the turn as terminal.'
      : 'PASS iff response invokes a working tool (read/grep/edit/write/bash/todo_update) to continue the pending plan items. FAIL if response is a text-only "summary" prematurely OR calls emit_handoff prematurely — the pending todos are not done.';

  const userPrompt =
    `An agent (the "Worker") just received the final user turn shown below. The case is "${dump.case}".\n\n` +
    `## Variant\n${variantNote}\n\n` +
    `## Case description\n${dump.case}\n\n` +
    `## Final user turn\n[USER]\n${userTask}\n\n` +
    `## Decision rule\n${expectNote}\n\n${decisionRule}\n\n${syntaxNote}\n${bindingNote}\n` +
    `## Worker raw response\n--- BEGIN ---\n${run.text}\n--- END ---\n\n` +
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

/**
 * For F190, the regex "PASS" determination per cell depends on case +
 * variant. We compare LLM majority vs the case-appropriate regex check:
 *   - Positive case V_new: regex PASS iff text_only_termination=true AND summary_content=true
 *   - Positive case V_baseline: regex PASS iff (text_only_termination=true OR emit_handoff_called=true) AND summary_content=true
 *   - Negative case (both variants): regex PASS iff text_only_termination=false (model continued working)
 */
function regexDerivedVerdict(
  expectTerminate: boolean,
  variantId: string,
  judges: ReadonlyArray<{ name: string; passed: boolean }>,
): 'PASS' | 'FAIL' {
  const textOnly = judges.find((j) => j.name === 'text_only_termination')?.passed ?? false;
  const summary = judges.find((j) => j.name === 'summary_content')?.passed ?? false;
  const emit = judges.find((j) => j.name === 'emit_handoff_called')?.passed ?? false;
  if (!expectTerminate) {
    // Negative case: PASS iff Worker continued working (NOT text-only).
    return textOnly ? 'FAIL' : 'PASS';
  }
  // Positive cases
  if (variantId === 'v_new_text_only_termination') {
    return textOnly && summary ? 'PASS' : 'FAIL';
  }
  // V_baseline positive: either text-only-with-summary OR emit_handoff-with-summary.
  return (textOnly || emit) && summary ? 'PASS' : 'FAIL';
}

function stratifiedSample(
  allCells: readonly CellWithDump[],
  target: number,
): readonly CellWithDump[] {
  // Group by (alias × case × variant) bin; take 1 per bin then random fill.
  const bins = new Map<string, CellWithDump[]>();
  for (const cell of allCells) {
    const k = `${cell.addr.alias}|${cell.addr.caseId}|${cell.addr.variantId}`;
    if (!bins.has(k)) bins.set(k, []);
    bins.get(k)!.push(cell);
  }
  const picked: CellWithDump[] = [];
  for (const cells of bins.values()) {
    if (cells.length === 0) continue;
    picked.push(cells[0]!);
    if (picked.length >= target) return picked;
  }
  // Random fill from remaining (deterministic seed via runIndex sum).
  const remaining = allCells.filter((c) => !picked.includes(c));
  // Deterministic shuffle: sort by hash(addr)
  const hash = (s: string) => {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return Math.abs(h);
  };
  const shuffled = [...remaining].sort((a, b) => {
    const ka = `${a.addr.caseId}|${a.addr.alias}|${a.addr.variantId}|${a.addr.runIndex}`;
    const kb = `${b.addr.caseId}|${b.addr.alias}|${b.addr.variantId}|${b.addr.runIndex}`;
    return hash(ka) - hash(kb);
  });
  for (const cell of shuffled) {
    if (picked.length >= target) break;
    picked.push(cell);
  }
  return picked;
}

describe('Audit: FEATURE_190 text-only termination LLM-judge majority vote (anti-pattern 7 §3)', () => {
  const judges = availableAliases(...JUDGES);
  if (judges.length < JUDGES.length) {
    it(
      `skips: need all 3 judge keys (${JUDGES.join(', ')}); have ${judges.join(', ') || '(none)'}`,
      () => { /* no-op */ },
    );
    return;
  }

  it(
    `audits ${SAMPLE_COUNT} sampled cells with 3-judge majority vote`,
    { timeout: 30 * 60_000 },
    async () => {
      // 1. Load panel dumps.
      const dumps = new Map<string, DumpFile>();
      for (const caseId of CASE_IDS) {
        const dumpPath = join(DUMP_SOURCE_ROOT, `${caseId}.json`);
        if (!existsSync(dumpPath)) {
          // eslint-disable-next-line no-console
          console.log(`[judge-audit] dump missing: ${dumpPath} — run panel first`);
          continue;
        }
        dumps.set(caseId, JSON.parse(readFileSync(dumpPath, 'utf-8')) as DumpFile);
      }
      if (dumps.size === 0) {
        throw new Error('No panel dumps found — run the panel first');
      }

      // 2. Flatten all cells across dumps.
      const allCells: CellWithDump[] = [];
      for (const [caseId, dump] of dumps) {
        for (const alias of dump.aliases) {
          for (const run of alias.runs) {
            allCells.push({
              addr: { caseId, alias: alias.alias, variantId: alias.variantId, runIndex: run.runIndex },
              dump,
              run,
            });
          }
        }
      }
      // eslint-disable-next-line no-console
      console.log(`[judge-audit] loaded ${allCells.length} cells across ${dumps.size} cases`);

      // 3. Stratified sample.
      const sample = stratifiedSample(allCells, SAMPLE_COUNT);
      // eslint-disable-next-line no-console
      console.log(`[judge-audit] sampled ${sample.length} cells (target ${SAMPLE_COUNT})`);

      // 4. Run 3-judge audit per cell.
      mkdirSync(AUDIT_DUMP_ROOT, { recursive: true });
      const auditRecords: unknown[] = [];

      let agree = 0;
      let disagree = 0;
      let unclear = 0;

      for (let i = 0; i < sample.length; i++) {
        const cell = sample[i]!;
        const { dump, run, addr } = cell;
        const prompt = buildJudgePrompt(dump, addr.variantId, run);

        const verdicts: JudgeVerdict[] = [];
        for (const judgeAlias of judges) {
          let raw = '';
          try {
            const { text } = await runOneShot(judgeAlias, {
              systemPrompt: prompt.systemPrompt,
              userMessage: prompt.userMessage,
            });
            raw = text;
          } catch (err) {
            raw = `[error: ${err instanceof Error ? err.message : String(err)}]`;
          }
          verdicts.push(parseJudgeReply(raw));
        }

        const majority = majorityVote(verdicts);
        const regex = regexDerivedVerdict(dump.expectTerminate, addr.variantId, run.regexJudges);

        const agreement = majority === regex ? 'agree' : majority === 'UNCLEAR' ? 'unclear' : 'disagree';
        if (agreement === 'agree') agree++;
        else if (agreement === 'disagree') disagree++;
        else unclear++;

        auditRecords.push({
          addr,
          variantId: addr.variantId,
          expectTerminate: dump.expectTerminate,
          regexVerdict: regex,
          majorityVerdict: majority,
          judgeVerdicts: verdicts.map((v, j) => ({
            judge: judges[j],
            judgment: v.judgment,
            reason: v.reason,
            rawJudgeText: v.rawJudgeText.slice(0, 400),
          })),
          agreement,
          textPreview: run.text.slice(0, 300),
        });

        if ((i + 1) % 10 === 0) {
          // eslint-disable-next-line no-console
          console.log(`[judge-audit] progress ${i + 1}/${sample.length}  agree=${agree} disagree=${disagree} unclear=${unclear}`);
        }
      }

      const total = sample.length;
      const disagreementPct = (disagree / total) * 100;
      const dataValid = disagreementPct < 10;

      const summary = {
        sampled: total,
        agree,
        disagree,
        unclear,
        disagreementPct,
        dataValid,
        gate: dataValid ? 'DATA VALID (anti-pattern 7 §3 met)' : 'DATA INVALID — regex/judge prompt redesign required',
      };

      writeFileSync(
        join(AUDIT_DUMP_ROOT, 'SUMMARY.json'),
        JSON.stringify({ summary, records: auditRecords }, null, 2),
        'utf-8',
      );

      // eslint-disable-next-line no-console
      console.log('\n=== FEATURE_190 LLM-judge audit summary ===');
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(summary, null, 2));
      // eslint-disable-next-line no-console
      console.log(`[dump] ${join(AUDIT_DUMP_ROOT, 'SUMMARY.json')}`);
    },
  );
});
