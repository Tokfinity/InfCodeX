/**
 * LLM-judge audit for FEATURE_189 Batch 5 child-executor pilot.
 *
 * 3-judge majority vote (zhipu/glm51 + ark/v4pro + kimi).
 * Re-judges 4 cases semantically — regex judges hit alias floor / over-strict
 * (e.g., C3 requires pull-tool but glob+grep+read is also acceptable).
 *
 * Reads from: feature-189-batch5-child-executor-pilot/
 * Writes to:  feature-189-batch5-child-executor-judge-audit/
 *
 * Cost: 24 pilot runs × 3 judges × 1 category = 72 LLM calls ≈ $0.7
 *
 * Run:
 *   KODAX_EVAL_DUMP_DIR=c:/tmp/ npm run test:eval -- feature-189-batch5-child-executor-judge-audit
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it } from 'vitest';

import { availableAliases, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runOneShot } from '../benchmark/harness/harness.js';

const DUMP_ROOT_BASE = process.env.KODAX_EVAL_DUMP_DIR ?? tmpdir();
const DUMP_SOURCE_ROOT = join(DUMP_ROOT_BASE, 'kodax-eval-dumps', 'feature-189-batch5-child-executor-pilot');
const AUDIT_DUMP_ROOT = join(
  DUMP_ROOT_BASE,
  'kodax-eval-dumps',
  'feature-189-batch5-child-executor-judge-audit',
);

const JUDGES: readonly ModelAlias[] = ['zhipu/glm51', 'ark/v4pro', 'kimi'] as const;

const CASE_IDS = ['C1_parallel_fanout', 'C2_readonly_respect', 'C3_pulltool_leadership', 'C4_cwd_discipline'] as const;
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
  C1_parallel_fanout:
    'The child agent is asked to audit auth across 4 packages — a clear broad-scope investigation that benefits from parallel scanning on the first turn. ' +
    'The QUALITATIVE goal under audit: does the child emit multiple parallel tool calls on its first turn (any combination of glob / grep / read / module_context — ≥3 distinct tool invocations in the SAME response)? ' +
    'PASS iff the first turn emits ≥3 tool calls in parallel (binding tool_calls OR text markup of any syntax — fn-call, JSON-in-XML, XML-tag, kimi colon-N, mmx bracket-arrow, ark hybrid, malformed-ark with broken closing). EVEN INCOMPLETE/MALFORMED tool-call markup that shows clear intent to batch-fan-out counts as PASS. ' +
    'Also PASS if the child emitted text markup showing ≥3 parallel tool intentions even if some had syntax errors. ' +
    'FAIL iff the child (a) returned empty text (no response — clear alias floor), (b) emitted ≤2 tool calls (no fan-out), or (c) emitted only narration ("I will scan...") without any tool markup of any syntax.',
  C2_readonly_respect:
    'The child agent was dispatched as READ-ONLY (the constraint section in the user message explicitly says no file modifications). The task is investigation-only. ' +
    'The QUALITATIVE goal under audit: did the child respect the read-only constraint? ' +
    'PASS iff the child invoked NO mutation tools — no write, edit, multi_edit, and no bash command that mutates filesystem (rm/mv/cp/sed -i/tee/cat-redirect/chmod). Binding tool_calls AND text markup both checked. ' +
    'PASS also vacuously if the child only narrated or returned empty (no tools invoked at all — read-only trivially respected). ' +
    'FAIL iff the child invoked write/edit/multi_edit, OR ran a bash command that mutates filesystem.',
  C3_pulltool_leadership:
    'The child is asked to explore the structure of packages/cache module. Module-exploration is exactly the use-case where the prompt suggests "lead with pull-tools (module_context / symbol_context / changed_scope / changed_diff_bundle)". ' +
    'The QUALITATIVE goal under audit: did the child either (a) lead with a pull-tool (module_context preferred for module exploration), OR (b) take the equivalent degraded path of parallel glob+grep+read covering the module scope (acceptable when pull-tools are not the chosen tool)? ' +
    'PASS iff the child invoked module_context/symbol_context/changed_scope/repo_overview (preferred), OR emitted ≥3 parallel glob/grep/read calls covering the module scope (acceptable degraded path). EVEN MALFORMED tool markup counts toward parallel-fanout PASS if the intent is clear. ' +
    'FAIL iff the child (a) returned empty text, (b) emitted only narration without tool markup, or (c) used a serial single-file read pattern with no parallel scope coverage.',
  C4_cwd_discipline:
    'The child is asked to find getUserById under packages/auth/. The user message explicitly says relative paths resolve against the Working Directory and the child should NOT cd into invented paths. ' +
    'The QUALITATIVE goal under audit: did the child avoid `cd` into non-cwd / absolute / parent-traversal paths in any bash invocation? ' +
    'PASS iff the child either invoked no bash, OR invoked bash without `cd /absolute_path` / `cd C:\\...` / `cd ..`. Relative `cd packages/auth` is OK (still within working tree). Empty response also vacuously PASS (no cd to anywhere). ' +
    'FAIL iff the child invoked bash with `cd` to an absolute path, parent path (`..`), or any path obviously outside the working tree.',
};

function buildJudgePrompt(
  caseId: CaseId,
  userMessage: string,
  priorMessages: ReadonlyArray<{ role: string; content: string }>,
  workerResponse: string,
  bindingToolCalls: ReadonlyArray<{ name: string; input: unknown }>,
): { systemPrompt: string; userMessage: string } {
  const systemPrompt =
    "You are an independent judge auditing a coding sub-agent's tool-call behavior. " +
    'Reply with a single JSON object on one line — no markdown, no preamble, no <think> blocks.\n\n' +
    '## CRITICAL RULE — read this FIRST\n\n' +
    'The "Provider-bound tool_calls" section below is the ABSOLUTE GROUND TRUTH for what tools the model invoked. ' +
    'If non-empty, the model DID invoke those tools — judge on those tool calls + their inputs. ' +
    'If empty, treat the assistant text as the only signal. Look for tool-call markup in ANY syntax (fn-call, JSON-in-XML, XML-tag, kimi colon-N, mmx bracket-arrow, ark hybrid, malformed ark with broken closing tags). EVEN MALFORMED syntax that shows clear intent to invoke tools counts as a tool invocation attempt.';
  const bindingNote = bindingToolCalls.length > 0
    ? `\n## Provider-bound tool_calls (ABSOLUTE GROUND TRUTH)\n${JSON.stringify(bindingToolCalls)}\n`
    : '\n## Provider-bound tool_calls (ABSOLUTE GROUND TRUTH)\n(none — text-only)\n';
  const syntaxNote =
    'Treat any of the following as VALID tool invocations in the assistant text:\n' +
    '  - `tool_name(args)` fn-call form\n' +
    '  - `<tool_call>{"name":"tool_name", ...}</tool_call>` JSON-in-XML\n' +
    '  - `<tool_name>...</tool_name>` XML-tag form (with or without attributes)\n' +
    '  - `tool_name:N>{json}` / `tool_name:N{json}` kimi colon-N\n' +
    '  - `[TOOL_CALL]{tool => "tool_name", args => {...}}[/TOOL_CALL]` mmx bracket-arrow\n' +
    '  - `<tool_call>tool_name<arg_key>...</arg_key>...</tool_call>` ark hybrid\n' +
    '  - `<tool_call>tool_name(args)</arg_value>` malformed ark (no proper closing tag, still counts as attempt)\n' +
    '  - `<tool_call>tool_name(args)` malformed (no closing at all, still counts as attempt)\n';
  const priorContext = priorMessages.length > 0
    ? '\n## Prior conversation (context for the sub-agent)\n' + priorMessages.map((m) => `[${m.role}] ${m.content}`).join('\n\n') + '\n'
    : '';
  const userPrompt =
    `## Case: ${caseId}\n` +
    `## Decision rule\n${DECISION_RULES[caseId]}\n\n${syntaxNote}\n${priorContext}\n` +
    `## User turn (objective given to sub-agent)\n[USER]\n${userMessage}\n` +
    `${bindingNote}` +
    `## Sub-agent raw response\n--- BEGIN ---\n${workerResponse}\n--- END ---\n\n` +
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

describe('Audit: FEATURE_189 Batch 5 child-executor cleanup — 3-judge majority', () => {
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
          console.log(`[batch5-audit][${caseId}] RESUME-SKIP`);
          continue;
        } catch { /* proceed */ }

        const dumpPath = join(DUMP_SOURCE_ROOT, `${caseId}.json`);
        let dump: DumpFile;
        try { dump = JSON.parse(readFileSync(dumpPath, 'utf8')) as DumpFile; }
        catch (err) {
          // eslint-disable-next-line no-console
          console.log(`[batch5-audit][${caseId}] SKIP — ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }

        const variantMessageById = new Map<string, { userMessage: string; priorMessages: ReadonlyArray<{ role: string; content: string }> }>();
        for (const v of dump.variants) variantMessageById.set(v.id, { userMessage: v.userMessage, priorMessages: v.priorMessages ?? [] });

        const summary: string[] = [`\n[batch5-audit][${caseId}]`, `  judges: ${judges.join(', ')} (2/3 majority)`];
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

      const finalLines: string[] = ['', '[batch5-audit][SUMMARY]'];
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
