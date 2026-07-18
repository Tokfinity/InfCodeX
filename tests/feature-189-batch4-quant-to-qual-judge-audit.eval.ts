/**
 * LLM-judge audit for FEATURE_189 Batch 4 quantitative → qualitative rewrite pilot.
 *
 * 3-judge majority vote (zhipu/glm52 + ark/v4pro + kimi).
 * Re-judges 4 case-specific semantic questions that the regex judge couldn't
 * fully capture (especially C2 plan structure — model often emits markdown
 * plan content without binding exit_plan_mode tool, which the regex judge
 * fails but the qualitative goal is satisfied).
 *
 * Reads from: feature-189-batch4-quant-to-qual-pilot/
 * Writes to:  feature-189-batch4-quant-to-qual-judge-audit/
 *
 * Cost: 24 pilot runs × 3 judges × 1 category = 72 LLM calls ≈ $0.7
 *
 * Run:
 *   KODAX_EVAL_DUMP_DIR=c:/tmp/ npm run test:eval -- feature-189-batch4-quant-to-qual-judge-audit
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it } from 'vitest';

import { availableAliases, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runOneShot } from '../benchmark/harness/harness.js';

const DUMP_ROOT_BASE = process.env.KODAX_EVAL_DUMP_DIR ?? tmpdir();
const DUMP_SOURCE_ROOT = join(DUMP_ROOT_BASE, 'kodax-eval-dumps', 'feature-189-batch4-quant-to-qual-pilot');
const AUDIT_DUMP_ROOT = join(
  DUMP_ROOT_BASE,
  'kodax-eval-dumps',
  'feature-189-batch4-quant-to-qual-judge-audit',
);

const JUDGES: readonly ModelAlias[] = ['zhipu/glm52', 'ark/v4pro', 'kimi'] as const;

const CASE_IDS = ['C1_subject_brevity', 'C2_plan_structure', 'C3_large_file_decision', 'C4_multi_file_lookup'] as const;
type CaseId = typeof CASE_IDS[number];

interface DumpRun {
  readonly runIndex: number;
  readonly text: string;
  readonly toolCalls: ReadonlyArray<{ name: string; input: unknown }>;
  readonly fallbackUsed?: ModelAlias;
  readonly regexJudges: ReadonlyArray<{ name: string; passed: boolean; reason?: string }>;
}

interface DumpAliasCell { readonly alias: string; readonly variantId: string; readonly passRate: number; readonly runs: readonly DumpRun[]; }
interface DumpVariantMeta { readonly id: string; readonly description: string; readonly systemPrompt: string; readonly userMessage: string; readonly priorMessages?: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>; }
interface DumpFile { readonly case: CaseId; readonly judgeName: string; readonly stage: string; readonly startedAt: string; readonly variants: readonly DumpVariantMeta[]; readonly aliases: readonly DumpAliasCell[]; }

const DECISION_RULES: Record<CaseId, string> = {
  C1_subject_brevity:
    'The user asked the worker to audit auth across 4 packages and commit todo_create one call per package. ' +
    'The QUALITATIVE goal under audit: dropped "Keep ≤80 chars" — does the model still emit BRIEF imperative subjects? ' +
    'PASS iff every visible todo_create subject (binding tool_calls OR text markup of any of the 7 syntax variants — fn-call, JSON-in-XML, XML-tag, kimi colon-N, mmx bracket-arrow, ark hybrid) is reasonably brief (≤140 chars per subject, where 140 is 75% margin above the original 80-char anchor). Also PASS if the model only narrated intent without emitting any todo_create — subject brevity vacuously holds. ' +
    'FAIL iff ANY emitted subject exceeds ~180 chars (clear verbosity regression — sentence-level descriptions instead of brief imperative titles).',
  C2_plan_structure:
    'The user asked the worker (in plan mode) to present a 4-phase cache refactor plan via exit_plan_mode. ' +
    'The QUALITATIVE goal under audit: dropped "at most 40 lines / 3 bullet-depth levels / one sentence per bullet" — does the model still produce a CONCISE + HIERARCHICAL plan? ' +
    'Accept the plan content from EITHER (a) binding exit_plan_mode tool_call.input.plan field, OR (b) narrative markdown plan with phase/bullet structure in the worker text response. ' +
    'PASS iff the plan content has clear bullet/hierarchy structure (≥2 distinct phases/sections, bulleted sub-items under each) AND items are reasonably brief (most bullets ≤2 short sentences, total plan ≤4500 chars). ' +
    'FAIL iff the plan is (a) wall-of-text without bullet/hierarchy structure, (b) verbose multi-paragraph bullets that resemble a design doc rather than an approval checklist, OR (c) significantly exceeds ~4500 chars (clear verbosity regression vs the original 40-line budget).',
  C3_large_file_decision:
    'The user told the worker that a log file at /tmp/integration-run-2026-05-22.log is "too large to include inline" and asked to find the first 3 test failures. ' +
    'The QUALITATIVE goal under audit: dropped "~50KB" threshold — does the model still pick an appropriate tool (grep / Read-with-offset/limit) instead of full inline Read? ' +
    'PASS iff the model invokes grep (preferred), bash with grep/awk/head, OR Read with offset and/or limit parameters set. Any of these correctly handles the "too large to include inline" hint. ' +
    'FAIL iff the model calls Read on the file WITHOUT any offset/limit (treats it as inline-OK, defeating the "too large" hint).',
  C4_multi_file_lookup:
    'The user explicitly named a single file (packages/auth/src/user-repo.ts) and asked the worker to read that exact file. ' +
    'The QUALITATIVE goal under audit: dropped "≤2 files" + dropped quantitative pull-tool rationale ("2-3KB vs 20-200KB") — does the model still pick targeted Read for a clearly single-file lookup instead of overusing repo-intel pull tools (module_context / symbol_context)? ' +
    'PASS iff the model invokes Read (or bash cat) on user-repo.ts. Narrative-only response that announces "I\'ll read user-repo.ts" without emitting tool markup also counts as PASS (intent is correct, tool-call syntax is an alias-floor issue). ' +
    'FAIL iff the model invokes module_context or symbol_context for this clearly single-file lookup (wasteful — pull tools are for multi-file exploration, not for a named single-file Read).',
};

function buildJudgePrompt(
  caseId: CaseId,
  userMessage: string,
  priorMessages: ReadonlyArray<{ role: string; content: string }>,
  workerResponse: string,
  bindingToolCalls: ReadonlyArray<{ name: string; input: unknown }>,
): { systemPrompt: string; userMessage: string } {
  const systemPrompt =
    "You are an independent judge auditing a coding agent's tool-call behavior. " +
    'Reply with a single JSON object on one line — no markdown, no preamble, no <think> blocks.\n\n' +
    '## CRITICAL RULE — read this FIRST\n\n' +
    'The "Provider-bound tool_calls" section below is the ABSOLUTE GROUND TRUTH for what tools the model invoked. ' +
    'If non-empty, the model DID invoke those tools — judge on those tool calls + their inputs, regardless of what the assistant text says. ' +
    'If empty, treat the worker\'s text as the only signal: model EITHER tried to emit a tool call in non-standard text markup, OR only narrated intent without invoking any tool.';
  const bindingNote = bindingToolCalls.length > 0
    ? `\n## Provider-bound tool_calls (ABSOLUTE GROUND TRUTH)\n${JSON.stringify(bindingToolCalls)}\n`
    : '\n## Provider-bound tool_calls (ABSOLUTE GROUND TRUTH)\n(none — text-only)\n';
  const syntaxNote =
    'Treat any of the following as VALID tool invocations in the worker text:\n' +
    '  - `tool_name(args)` fn-call form\n' +
    '  - `<tool_call>{"name":"tool_name", ...}</tool_call>` JSON-in-XML\n' +
    '  - `<tool_name>...</tool_name>` XML-tag form (with or without attributes)\n' +
    '  - `tool_name:N>{json}` / `tool_name:N{json}` kimi colon-N\n' +
    '  - `[TOOL_CALL]{tool => "tool_name", args => {...}}[/TOOL_CALL]` mmx bracket-arrow\n' +
    '  - `<tool_call>tool_name<arg_key>...</arg_key>...</tool_call>` ark hybrid\n' +
    '  - `<tool_call>tool_name}{key=value}{...}` malformed ark hybrid (no closing tag, still counts as attempt)\n';
  const priorContext = priorMessages.length > 0
    ? '\n## Prior conversation (context for the worker)\n' + priorMessages.map((m) => `[${m.role}] ${m.content}`).join('\n\n') + '\n'
    : '';
  const userPrompt =
    `## Case: ${caseId}\n` +
    `## Decision rule\n${DECISION_RULES[caseId]}\n\n${syntaxNote}\n${priorContext}\n` +
    `## User turn\n[USER]\n${userMessage}\n` +
    `${bindingNote}` +
    `## Worker raw response\n--- BEGIN ---\n${workerResponse}\n--- END ---\n\n` +
    `Reply exactly one line of JSON:\n  {"judgment":"PASS","reason":"<≤80 chars>"} OR {"judgment":"FAIL","reason":"<≤80 chars>"}`;
  return { systemPrompt, userMessage: userPrompt };
}

interface JudgeVerdict { readonly judgment: 'PASS' | 'FAIL' | 'UNCLEAR'; readonly reason: string; readonly rawJudgeText: string; }

function parseJudgeReply(raw: string): JudgeVerdict {
  const jsonMatch = raw.match(/\{[\s\S]*?\}/);
  if (!jsonMatch) return { judgment: 'UNCLEAR', reason: 'no JSON', rawJudgeText: raw };
  try {
    const obj = JSON.parse(jsonMatch[0]) as { judgment?: string; reason?: string };
    const j = (obj.judgment ?? '').toUpperCase();
    if (j === 'PASS' || j === 'FAIL') return { judgment: j, reason: obj.reason ?? '', rawJudgeText: raw };
    return { judgment: 'UNCLEAR', reason: `unrecognized="${obj.judgment}"`, rawJudgeText: raw };
  } catch {
    return { judgment: 'UNCLEAR', reason: 'JSON parse error', rawJudgeText: raw };
  }
}

function majorityVote(verdicts: readonly JudgeVerdict[]): 'PASS' | 'FAIL' | 'UNCLEAR' {
  let pass = 0, fail = 0;
  for (const v of verdicts) { if (v.judgment === 'PASS') pass++; else if (v.judgment === 'FAIL') fail++; }
  if (pass >= 2) return 'PASS';
  if (fail >= 2) return 'FAIL';
  return 'UNCLEAR';
}

describe('Audit: FEATURE_189 Batch 4 quantitative → qualitative — 3-judge majority', () => {
  const judges = availableAliases(...JUDGES);
  if (judges.length < JUDGES.length) {
    it(`skips: need all 3 judges; have ${judges.join(', ') || '(none)'}`, () => { /* no-op */ });
    return;
  }

  it(
    'audits all 4 cases with 3-judge majority vote',
    { timeout: 90 * 60_000 },
    async () => {
      mkdirSync(AUDIT_DUMP_ROOT, { recursive: true });
      const overall = {
        v_baseline: { total: 0, pass: 0, fail: 0, unclear: 0 },
        v_proposed: { total: 0, pass: 0, fail: 0, unclear: 0 },
        agreement: { total: 0, agree: 0, disagree: 0, unclear: 0 },
      };

      for (const caseId of CASE_IDS) {
        const auditPathPreCheck = join(AUDIT_DUMP_ROOT, `${caseId}.json`);
        try {
          JSON.parse(readFileSync(auditPathPreCheck, 'utf8'));
          // eslint-disable-next-line no-console
          console.log(`[batch4-audit][${caseId}] RESUME-SKIP`);
          continue;
        } catch { /* proceed */ }

        const dumpPath = join(DUMP_SOURCE_ROOT, `${caseId}.json`);
        let dump: DumpFile;
        try { dump = JSON.parse(readFileSync(dumpPath, 'utf8')) as DumpFile; }
        catch (err) {
          // eslint-disable-next-line no-console
          console.log(`[batch4-audit][${caseId}] SKIP — ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }

        const variantMessageById = new Map<string, { userMessage: string; priorMessages: ReadonlyArray<{ role: string; content: string }> }>();
        for (const v of dump.variants) variantMessageById.set(v.id, { userMessage: v.userMessage, priorMessages: v.priorMessages ?? [] });

        const summary: string[] = [`\n[batch4-audit][${caseId}]`, `  judges: ${judges.join(', ')} (2/3 majority)`];
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
            rows: Array<{ runIndex: number; regexPassed: boolean; verdicts: Record<string, JudgeVerdict>; majority: 'PASS'|'FAIL'|'UNCLEAR'; agreesWithRegex: boolean }>;
            judgePass: number;
            regexPass: number;
          }>;
        }> = [];

        for (const variantId of [...byVariant.keys()].sort()) {
          summary.push('', `  --- variant: ${variantId} ---`);
          const variantMeta = variantMessageById.get(variantId);
          const userMessage = variantMeta?.userMessage ?? '';
          const priorMessages = variantMeta?.priorMessages ?? [];
          const cells = byVariant.get(variantId) ?? [];
          const byAlias: typeof auditByVariant[number]['aliases'] = [];
          for (const cell of cells) {
            const rows: typeof byAlias[number]['rows'] = [];
            for (const r of cell.runs) {
              const { systemPrompt, userMessage: judgeUserMsg } = buildJudgePrompt(caseId, userMessage, priorMessages, r.text, r.toolCalls);
              const verdicts: Record<string, JudgeVerdict> = {};
              for (const judge of judges) {
                try {
                  const res = await runOneShot(judge, { systemPrompt, userMessage: judgeUserMsg });
                  verdicts[judge] = parseJudgeReply(res.text);
                } catch (err) {
                  verdicts[judge] = { judgment: 'UNCLEAR', reason: `judge call failed: ${err instanceof Error ? err.message : String(err)}`, rawJudgeText: '' };
                }
              }
              const majority = majorityVote(Object.values(verdicts));
              const regexPassed = (r.regexJudges[0]?.passed) === true;
              const agreesWithRegex = (majority === 'PASS') === regexPassed;
              rows.push({ runIndex: r.runIndex, regexPassed, verdicts, majority, agreesWithRegex });
              const variantKey = variantId.startsWith('v_baseline') ? 'v_baseline' : 'v_proposed';
              const bin = overall[variantKey];
              bin.total++;
              if (majority === 'PASS') bin.pass++;
              else if (majority === 'FAIL') bin.fail++;
              else bin.unclear++;
              overall.agreement.total++;
              if (majority === 'UNCLEAR') overall.agreement.unclear++;
              else if (agreesWithRegex) overall.agreement.agree++;
              else overall.agreement.disagree++;
            }
            const judgePass = rows.filter((r) => r.majority === 'PASS').length;
            const regexPass = rows.filter((r) => r.regexPassed).length;
            byAlias.push({ alias: cell.alias, rows, judgePass, regexPass });
            summary.push(`    ${cell.alias.padEnd(14)} regex=${regexPass}/${rows.length} judge=${judgePass}/${rows.length}`);
          }
          auditByVariant.push({ variantId, aliases: byAlias });
        }
        mkdirSync(AUDIT_DUMP_ROOT, { recursive: true });
        writeFileSync(
          join(AUDIT_DUMP_ROOT, `${caseId}.json`),
          JSON.stringify({ case: caseId, judges, variants: auditByVariant }, null, 2),
          'utf8',
        );
        // eslint-disable-next-line no-console
        console.log(summary.join('\n'));
      }

      const finalLines: string[] = ['', '[batch4-audit][SUMMARY]'];
      for (const k of ['v_baseline', 'v_proposed'] as const) {
        const o = overall[k];
        finalLines.push(`  ${k.padEnd(15)} total=${o.total} pass=${o.pass} fail=${o.fail} unclear=${o.unclear}`);
      }
      const ag = overall.agreement;
      const ev = ag.total - ag.unclear;
      const disRate = ev === 0 ? 0 : (ag.disagree / ev) * 100;
      finalLines.push(`  agreement total=${ag.total} agree=${ag.agree} disagree=${ag.disagree} disagreement-rate=${disRate.toFixed(1)}%`);
      const verdict = disRate > 10
        ? 'DATA INVALID (disagreement > 10%)'
        : 'DATA VALID';
      finalLines.push(`  EVAL_GUIDELINES verdict: ${verdict}`);
      finalLines.push(`  SHIP gate: baseline=${overall.v_baseline.pass}/${overall.v_baseline.total} proposed=${overall.v_proposed.pass}/${overall.v_proposed.total} Δ=${overall.v_proposed.pass - overall.v_baseline.pass >= 0 ? '+' : ''}${overall.v_proposed.pass - overall.v_baseline.pass}`);
      // eslint-disable-next-line no-console
      console.log(finalLines.join('\n'));
    },
  );
});
