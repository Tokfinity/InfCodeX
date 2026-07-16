/**
 * Eval: FEATURE_199 v0.7.44 — `task_id:<id>` evidence_refs prompt-signal probe.
 *
 * **Design** (per [`benchmark/EVAL_GUIDELINES.md`](../benchmark/EVAL_GUIDELINES.md)):
 *
 *   - Layer 2 single-turn probe (anti-pattern 5 rule out 36-cell grids).
 *   - 1 alias × 1 case × 3 runs = 3 probe calls (pilot is the full panel
 *     per anti-pattern 9 — this is a behavioral-neutral hygiene refactor
 *     adding a new vocabulary item; a 5-alias panel would re-prove the
 *     same null hypothesis at 5× cost).
 *   - 3-judge majority audit (zhipu/glm51 + ark/v4pro + kimi, all
 *     panel-internal — per the Judge model selection constraint
 *     "NEVER use anthropic/openai", and per anti-pattern 7 §3
 *     "Negative-case judges 不能只用 regex").
 *   - Audit prompt explicitly tells the judge to read the binding
 *     tool_calls as the ABSOLUTE GROUND TRUTH (per
 *     `feedback_audit_binding_priority_in_prompt` — binding-only providers
 *     emit `text=""` and judges that look only at text falsely fail them).
 *   - Raw dump lands at `os.tmpdir()/kodax-eval-dumps/feature-199-task-id-evidence-ref/`
 *     (per §Raw output preservation — runtime artefact, MUST NOT enter
 *     the repo working tree).
 *   - Per-write `mkdirSync` survives the Windows tmpdir cleanup race
 *     observed in `feedback_audit_dump_dir_vanishes`.
 *
 * **Pre-registered SHIP gate**:
 *
 *   - (a) Regex primary signal: ≥ 1/3 runs PASS (any one ark/v4flash run
 *     emits `dispatch_child_task` whose `evidence_refs` array contains a
 *     string starting with `task_id:`).
 *   - (b) 3-judge audit disagreement on the 3 cells ≤ 33% (i.e. at most
 *     1 cell where the regex verdict and the 2/3 judge majority diverge —
 *     anti-pattern 7 §3 threshold relaxed for n=3 cell pilot;
 *     `DATA VALID` floor is 10% on larger panels, but on n=3 the discrete
 *     resolution is 1/3 = 33%, so >33% means "majority of judges disagree
 *     with regex on the majority of cells", which is the actionable line).
 *   - SHIP when (a) AND (b). DROP/iterate when (a) fails. RE-PILOT after
 *     adding a one-sentence Worker prompt cue when (a) fails on schema-
 *     only-discovery — that is the gate the design doc pre-registered.
 *
 * **Mode** (env `KODAX_F199_MODE`):
 *
 *   - `pilot`  — run probe only (3 calls), no audit. Use to fast-fail
 *     when regex floor < 1/3.
 *   - `audit`  — run probe AND 3-judge audit. 3 probe + (3 × 3) = 12 calls
 *     total (~$0.5-1.5). Use when probe PASSes and ship gate (b) needs
 *     to confirm regex isn't a false positive.
 *   - default  — SKIP (no env, no spend).
 *
 * **Run**:
 *
 *   KODAX_F199_MODE=pilot npm run test:eval -- feature-199-task-id-evidence-ref
 *   KODAX_F199_MODE=audit npm run test:eval -- feature-199-task-id-evidence-ref
 *
 * Skips when API keys are absent. Not part of regular CI — manual.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';

import { availableAliases, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runOneShot } from '../benchmark/harness/harness.js';
import {
  DISPATCH_CHILD_TASK_TOOL,
  F199_CASES,
  F199_SYSTEM_PROMPT,
  GREP_TOOL,
  READ_TOOL,
  TASK_OUTPUT_TOOL,
  evidenceRefsContainsTaskIdPrefix,
  type F199Case,
} from '../benchmark/datasets/feature-199-task-id-evidence-ref/cases.js';

type Mode = 'pilot' | 'audit' | 'panel' | 'skip';
const MODE: Mode = (process.env.KODAX_F199_MODE ?? 'skip') as Mode;

/** Pilot probes a single floor model — ark/v4flash by canonical convention
 * (cheapest coding-plan alias). Used to fast-fail when the schema-description
 * signal isn't strong enough for ANY model to pick up. */
const PILOT_PROBE_ALIASES: readonly ModelAlias[] = ['ark/v4flash'] as const;

/** Canonical 5-alias panel per EVAL_GUIDELINES `Canonical alias panel` —
 * locked 2026-05-19 / upgraded 2026-05-21 to coding-plan-only. Used in
 * `panel` mode for generalisation verification across 4 provider families
 * (Zhipu / Moonshot / MiniMax / DeepSeek). */
const PANEL_PROBE_ALIASES: readonly ModelAlias[] = [
  'zhipu/glm51',
  'kimi',
  'mmx/m27',
  'ark/v4pro',
  'ark/v4flash',
] as const;

const RUNS_PER_CELL = 3;

/** 3-judge majority audit aliases (panel-internal per Judge model selection
 * constraint — NEVER anthropic/openai). Reused across pilot/audit/panel. */
const JUDGE_ALIASES: readonly ModelAlias[] = ['zhipu/glm51', 'ark/v4pro', 'kimi'] as const;

const DUMP_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'feature-199-task-id-evidence-ref');

/** Canned sibling task_id the user-message block advertises. Renamed
 * from "scout" (FEATURE_193 v0.7.43 retired V1 chain agents — the
 * legacy role name remains as a session-id compat constant but should
 * not be reused in casual prompt copy because the model could match it
 * from training-data muscle memory rather than from the canned block).
 * Picking a domain-descriptive id forces the model to actually read
 * the block instead of guessing a familiar word. */
const CANNED_SIBLING_TASK_ID = 'hooks-audit';

interface ProbeRow {
  readonly caseId: string;
  readonly alias: ModelAlias;
  readonly runIndex: number;
  readonly durationMs: number;
  readonly text: string;
  readonly toolCalls: ReadonlyArray<{ name: string; input: unknown }>;
  readonly regexPassed: boolean;
  readonly matchedRef: string | undefined;
  /** Stricter check: true when matchedRef literally equals
   * `task_id:${CANNED_SIBLING_TASK_ID}`. Splits "shape adoption" (the
   * model picked the prefix) from "id transfer" (the model read the
   * canned id correctly). A model that adopted the shape but invented
   * a different id (regexPassed=true, idTransferred=false) would also
   * count as a model failure for the F199 contract — the runtime
   * `not found` stub would catch it but the parent LLM wasted a turn. */
  readonly idTransferred: boolean;
}

interface JudgeVote {
  readonly judgeAlias: ModelAlias;
  readonly verdict: 'YES' | 'NO' | 'UNCLEAR';
  readonly reason: string;
  readonly durationMs: number;
  readonly rawText: string;
}

interface AuditRow {
  readonly probeRow: ProbeRow;
  readonly votes: readonly JudgeVote[];
  readonly majorityVerdict: 'YES' | 'NO' | 'UNCLEAR';
  readonly agreesWithRegex: boolean;
}

function buildAuditPrompt(row: ProbeRow, c: F199Case): { system: string; user: string } {
  const toolCallsBlock = row.toolCalls.length === 0
    ? '(no tool calls captured)'
    : row.toolCalls
        .map(
          (t, i) =>
            `binding[${i}].name = ${t.name}\nbinding[${i}].input = ${JSON.stringify(t.input, null, 2)}`,
        )
        .join('\n\n');

  const system = `CRITICAL RULE — READ THIS FIRST.

You are an independent evaluator auditing whether an agent emitted the expected tool call. Your input contains a HARNESS CONTEXT block that includes the BINDING-LEVEL tool_calls captured by the harness. The binding is the ABSOLUTE GROUND TRUTH about what the model invoked — it is parsed from the provider's structured tool_use payload, not from the assistant text. Some providers emit binding tool calls with an empty assistant text; do NOT use absence of text-level mentions to reject the call.

Workflow:
  1. Read the HARNESS CONTEXT section first. Find the binding[].name and binding[].input entries.
  2. Apply the QUESTION rule to the binding-level data, not the assistant text.
  3. Reply with exactly one line in this shape: VERDICT=<YES|NO|UNCLEAR> REASON=<short reason>

Do not chain-of-thought, do not echo the question, do not propose new tool calls.`;

  const user = `# HARNESS CONTEXT (binding tool calls — ABSOLUTE GROUND TRUTH)

The harness recorded the following tool calls from the agent's response:

${toolCallsBlock}

The agent's accompanying assistant text was:

\`\`\`
${row.text.slice(0, 4000) || '(no assistant text — common for binding-only providers)'}
\`\`\`

# CASE

${c.description}

# QUESTION

Did the agent emit a \`dispatch_child_task\` tool call whose \`evidence_refs\` array contains at least one string starting with the literal prefix \`task_id:\` (case-insensitive)?

Reply with exactly: VERDICT=<YES|NO|UNCLEAR> REASON=<≤120 chars>`;

  return { system, user };
}

function parseJudgeVerdict(text: string): { verdict: JudgeVote['verdict']; reason: string } {
  // Accept any reasonable shape: "VERDICT=YES REASON=..." or "VERDICT: YES" etc.
  const verdictMatch = text.match(/VERDICT\s*[:=]\s*(YES|NO|UNCLEAR)/i);
  const reasonMatch = text.match(/REASON\s*[:=]\s*(.+?)(?:\n|$)/i);
  const verdict = (verdictMatch?.[1]?.toUpperCase() ?? 'UNCLEAR') as JudgeVote['verdict'];
  const reason = (reasonMatch?.[1] ?? text.slice(0, 200)).trim();
  return { verdict, reason };
}

function majorityVerdict(votes: readonly JudgeVote[]): 'YES' | 'NO' | 'UNCLEAR' {
  let yes = 0;
  let no = 0;
  for (const v of votes) {
    if (v.verdict === 'YES') yes++;
    if (v.verdict === 'NO') no++;
  }
  if (yes >= 2) return 'YES';
  if (no >= 2) return 'NO';
  return 'UNCLEAR';
}

describe(`Eval: FEATURE_199 task_id evidence_refs prompt-signal (${MODE})`, () => {
  if (MODE === 'skip') {
    it('skips: KODAX_F199_MODE not set (set pilot|audit to run)', () => {
      // no-op
    });
    return;
  }

  const requestedProbeAliases: readonly ModelAlias[] =
    MODE === 'panel' ? PANEL_PROBE_ALIASES : PILOT_PROBE_ALIASES;
  const probeAliases = availableAliases(...requestedProbeAliases);
  if (probeAliases.length === 0) {
    it(`skips: no probe alias API keys for mode=${MODE} (requested: ${requestedProbeAliases.join(', ')})`, () => {
      // no-op
    });
    return;
  }

  const auditAliasesAvailable =
    MODE === 'audit' || MODE === 'panel' ? availableAliases(...JUDGE_ALIASES) : [];
  if ((MODE === 'audit' || MODE === 'panel') && auditAliasesAvailable.length < 2) {
    it('skips: audit/panel mode needs ≥ 2 judge alias API keys (got ' + auditAliasesAvailable.length + ')', () => {
      // no-op
    });
    return;
  }

  it(
    'runs probe (+ audit when KODAX_F199_MODE=audit) and dumps raw output',
    { timeout: 1_200_000 },
    async () => {
      mkdirSync(DUMP_ROOT, { recursive: true });

      const probeRows: ProbeRow[] = [];
      const auditRows: AuditRow[] = [];

      // -------------------- Probe --------------------

      for (const c of F199_CASES) {
        for (const alias of probeAliases) {
          for (let runIndex = 0; runIndex < RUNS_PER_CELL; runIndex++) {
            // eslint-disable-next-line no-console
            console.log(`[F199] probe case=${c.id} alias=${alias} run=${runIndex}`);
            let result;
            try {
              result = await runOneShot(alias, {
                systemPrompt: F199_SYSTEM_PROMPT,
                userMessage: c.userMessage,
                tools: [DISPATCH_CHILD_TASK_TOOL, READ_TOOL, GREP_TOOL, TASK_OUTPUT_TOOL],
              });
            } catch (err) {
              // eslint-disable-next-line no-console
              console.error(
                `[F199] probe error case=${c.id} alias=${alias} run=${runIndex}: ${(err as Error).message}`,
              );
              continue;
            }

            const { matched, matchedRef } = evidenceRefsContainsTaskIdPrefix(result.toolCalls);
            const idTransferred =
              typeof matchedRef === 'string' &&
              matchedRef.trim().toLowerCase().replace(/^task_id:\s*/, '') ===
                CANNED_SIBLING_TASK_ID.toLowerCase();
            const row: ProbeRow = {
              caseId: c.id,
              alias,
              runIndex,
              durationMs: result.durationMs,
              text: result.text,
              toolCalls: result.toolCalls,
              regexPassed: matched,
              matchedRef,
              idTransferred,
            };
            probeRows.push(row);

            // Flush probe rows after each run — survive Windows tmpdir cleanup
            // race per `feedback_audit_dump_dir_vanishes`.
            mkdirSync(DUMP_ROOT, { recursive: true });
            writeFileSync(
              join(DUMP_ROOT, `probe-incremental-${MODE}-${Date.now()}.json`),
              JSON.stringify(
                { mode: MODE, timestamp: new Date().toISOString(), probeRows },
                null,
                2,
              ),
              'utf-8',
            );
          }
        }
      }

      // -------------------- Audit (audit/panel mode) --------------------

      if (MODE === 'audit' || MODE === 'panel') {
        for (const row of probeRows) {
          const c = F199_CASES.find((cc) => cc.id === row.caseId);
          if (!c) continue;
          const { system, user } = buildAuditPrompt(row, c);
          const votes: JudgeVote[] = [];
          for (const judgeAlias of auditAliasesAvailable) {
            // eslint-disable-next-line no-console
            console.log(`[F199] audit row=${row.caseId}#${row.runIndex} judge=${judgeAlias}`);
            try {
              const judgeResult = await runOneShot(judgeAlias, {
                systemPrompt: system,
                userMessage: user,
              });
              const { verdict, reason } = parseJudgeVerdict(judgeResult.text);
              votes.push({
                judgeAlias,
                verdict,
                reason,
                durationMs: judgeResult.durationMs,
                rawText: judgeResult.text,
              });
            } catch (err) {
              // eslint-disable-next-line no-console
              console.error(`[F199] judge ${judgeAlias} error: ${(err as Error).message}`);
              votes.push({
                judgeAlias,
                verdict: 'UNCLEAR',
                reason: `judge call failed: ${(err as Error).message}`,
                durationMs: 0,
                rawText: '',
              });
            }
          }
          const maj = majorityVerdict(votes);
          const agrees =
            (maj === 'YES' && row.regexPassed) || (maj === 'NO' && !row.regexPassed);
          auditRows.push({
            probeRow: row,
            votes,
            majorityVerdict: maj,
            agreesWithRegex: agrees,
          });

          // Flush audit rows after each row.
          mkdirSync(DUMP_ROOT, { recursive: true });
          writeFileSync(
            join(DUMP_ROOT, `audit-incremental-${MODE}-${Date.now()}.json`),
            JSON.stringify(
              { mode: MODE, timestamp: new Date().toISOString(), auditRows },
              null,
              2,
            ),
            'utf-8',
          );
        }
      }

      // -------------------- Summary + final dump --------------------

      const probePassCount = probeRows.filter((r) => r.regexPassed).length;
      const auditDisagreeCount = auditRows.filter((a) => !a.agreesWithRegex).length;
      const auditUnclearCount = auditRows.filter((a) => a.majorityVerdict === 'UNCLEAR').length;

      // Per-alias breakdown for panel mode generalisation gate.
      const perAliasPass = new Map<ModelAlias, { passed: number; total: number }>();
      for (const r of probeRows) {
        const cur = perAliasPass.get(r.alias) ?? { passed: 0, total: 0 };
        cur.total++;
        if (r.regexPassed) cur.passed++;
        perAliasPass.set(r.alias, cur);
      }
      const aliasesMeetingGateA = [...perAliasPass.entries()]
        .filter(([, v]) => v.passed >= 1)
        .map(([k]) => k);

      mkdirSync(DUMP_ROOT, { recursive: true });
      const finalDumpPath = join(DUMP_ROOT, `final-${MODE}-${Date.now()}.json`);
      const auditEnabled = MODE === 'audit' || MODE === 'panel';
      writeFileSync(
        finalDumpPath,
        JSON.stringify(
          {
            mode: MODE,
            timestamp: new Date().toISOString(),
            probeAliases,
            judgeAliases: auditEnabled ? auditAliasesAvailable : [],
            cases: F199_CASES.map((c) => c.id),
            runs: RUNS_PER_CELL,
            probeRows,
            auditRows,
            summary: {
              probePassCount,
              probeTotal: probeRows.length,
              probePassRate: probeRows.length === 0 ? 0 : probePassCount / probeRows.length,
              perAliasPass: Object.fromEntries(perAliasPass),
              aliasesMeetingGateA,
              auditDisagreeCount,
              auditUnclearCount,
              auditTotal: auditRows.length,
              auditDisagreeRate:
                auditRows.length === 0 ? 0 : auditDisagreeCount / auditRows.length,
              // Gate (a) — aggregate ≥1/3 PASS (used by pilot mode).
              shipGateA_aggregate: probePassCount >= 1,
              // Gate (a') — panel generalisation ≥4/5 aliases ≥1/3 PASS each
              // (≥4 aliases for the canonical 5 — floor-model single-alias DEFER
              // tolerated per `feedback_model_structural_floor_not_prompt_tunable`).
              shipGateA_panel:
                MODE === 'panel' ? aliasesMeetingGateA.length >= 4 : true,
              shipGateB_met:
                !auditEnabled ||
                auditRows.length === 0 ||
                auditDisagreeCount / auditRows.length <= 1 / 3,
            },
          },
          null,
          2,
        ),
        'utf-8',
      );

      // eslint-disable-next-line no-console
      console.log(`\n=== FEATURE_199 (${MODE}) summary ===`);
      // eslint-disable-next-line no-console
      console.log(`Dump: ${finalDumpPath}`);
      // eslint-disable-next-line no-console
      console.log(`Probe: ${probePassCount}/${probeRows.length} runs PASS (regex aggregate)`);
      // eslint-disable-next-line no-console
      console.log(`Per-alias breakdown:`);
      for (const [alias, v] of perAliasPass) {
        const pct = ((v.passed / Math.max(1, v.total)) * 100).toFixed(0);
        // eslint-disable-next-line no-console
        console.log(`  ${alias}: ${v.passed}/${v.total} (${pct}%)`);
      }
      if (auditEnabled) {
        // eslint-disable-next-line no-console
        console.log(
          `Audit: ${auditDisagreeCount}/${auditRows.length} cells where 2/3 majority disagrees with regex (UNCLEAR=${auditUnclearCount})`,
        );
        // eslint-disable-next-line no-console
        console.log(`SHIP gate (a) aggregate ≥1/3 regex PASS: ${probePassCount >= 1 ? 'MET' : 'FAIL'}`);
        if (MODE === 'panel') {
          // eslint-disable-next-line no-console
          console.log(
            `SHIP gate (a') panel ≥4/5 aliases trigger: ${aliasesMeetingGateA.length}/${perAliasPass.size} (${aliasesMeetingGateA.length >= 4 ? 'MET' : 'FAIL'}) — aliases trigger: [${aliasesMeetingGateA.join(', ')}]`,
          );
        }
        // eslint-disable-next-line no-console
        console.log(
          `SHIP gate (b) audit disagreement ≤1/3: ${auditDisagreeCount / Math.max(1, auditRows.length) <= 1 / 3 ? 'MET' : 'FAIL'}`,
        );
      }

      // Per-row breakdown — useful when SHIP gate fails to spot the
      // floor-saturation / single-alias-only path before adding worker
      // prompt teaching.
      for (const r of probeRows) {
        const idTransferTag = r.regexPassed
          ? r.idTransferred
            ? ' id=correct'
            : ' id=DRIFTED'
          : '';
        // eslint-disable-next-line no-console
        console.log(
          `  ${r.caseId} ${r.alias}#${r.runIndex}: regex=${r.regexPassed ? 'PASS' : 'FAIL'}${idTransferTag}${r.matchedRef ? ` matchedRef="${r.matchedRef}"` : ''} duration_ms=${r.durationMs}`,
        );
      }

      // Aggregate id-transfer summary across all probe rows.
      const idTransferredCount = probeRows.filter((r) => r.idTransferred).length;
      const shapeOnlyCount = probeRows.filter((r) => r.regexPassed && !r.idTransferred).length;
      // eslint-disable-next-line no-console
      console.log(
        `\nID transfer: ${idTransferredCount}/${probeRows.length} runs adopted shape AND read the canned id "${CANNED_SIBLING_TASK_ID}" correctly (shape-only-no-id=${shapeOnlyCount})`,
      );
    },
  );
});
