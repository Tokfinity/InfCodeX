/**
 * LLM-judge audit for FEATURE_189 Batch 3 B.1 tool description expansion pilot.
 *
 * 3-judge majority vote (zhipu/glm52 + ark/v4pro + kimi).
 *
 * Reads from: feature-189-batch3-b1-tool-desc-expansion-pilot/
 * Writes to:  feature-189-batch3-b1-tool-desc-expansion-judge-audit/
 *
 * Cost: 24 pilot runs × 3 judges × 1 category = 72 LLM calls ≈ $0.7
 *
 * Run:
 *   KODAX_EVAL_DUMP_DIR=c:/tmp/ npm run test:eval -- feature-189-batch3-b1-tool-desc-expansion-judge-audit
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it } from 'vitest';

import { availableAliases, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runOneShot } from '../benchmark/harness/harness.js';

const DUMP_ROOT_BASE = process.env.KODAX_EVAL_DUMP_DIR ?? tmpdir();
const DUMP_SOURCE_ROOT = join(DUMP_ROOT_BASE, 'kodax-eval-dumps', 'feature-189-batch3-b1-tool-desc-expansion-pilot');
const AUDIT_DUMP_ROOT = join(
  DUMP_ROOT_BASE,
  'kodax-eval-dumps',
  'feature-189-batch3-b1-tool-desc-expansion-judge-audit',
);

const JUDGES: readonly ModelAlias[] = ['zhipu/glm52', 'ark/v4pro', 'kimi'] as const;

const CASE_IDS = ['C1_github_url_prefer_gh', 'C2_module_exploration_pulltool', 'C3_refactor_impact_first', 'C4_websearch_markdown_cite'] as const;
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
  C1_github_url_prefer_gh:
    'The user asked the agent to fetch the README content for a github.com repository URL and summarize a section. ' +
    'The QUALITATIVE goal under audit: did the agent pick the right tool? The expanded web_fetch description teaches "For GitHub URLs specifically, prefer `bash` with the `gh` CLI when available — using web_fetch on a github.com URL when gh would work is the most common tool waste pattern". ' +
    'PASS iff the agent used (a) `bash` with `gh api` / `gh repo view` / `gh pr view` / similar gh CLI invocation (preferred), OR (b) avoided web_fetch entirely on the github URL (any reasonable alternative like grep on local repo, etc.). ' +
    'FAIL iff the agent invoked `web_fetch` directly on the github.com URL (the "tool waste" anti-pattern the expanded description was meant to prevent). Empty response = FAIL (alias floor). Both binding tool_calls AND text-markup syntax (fn-call / XML / kimi colon-N / ark hybrid / malformed) count as tool invocations.',
  C2_module_exploration_pulltool:
    'The user asked the agent to explore packages/auth module structure — a textbook module-exploration query. The expanded module_context description teaches "Use this when about to read 3+ files in the same module — the capsule replaces that exploration round-trip with one structured response. Prefer module_context over raw read+grep for what does this module do questions". ' +
    'PASS iff the agent (a) invoked module_context (preferred), OR (b) used ≥4 parallel read/grep/glob calls covering the module scope (acceptable degraded path when pull-tool not chosen). ' +
    'FAIL iff the agent (a) returned empty, (b) issued <4 read/grep calls serially without module_context, or (c) only narrated intent without tool markup.',
  C3_refactor_impact_first:
    'The user asked the agent to estimate the blast radius of renaming getUserById across the monorepo BEFORE starting the rename. The expanded impact_estimate description teaches "Call this BEFORE planning a rename, refactor, or breaking change ... Prefer over guessing impact from a grep of the symbol name — grep overcounts and undercounts". ' +
    'PASS iff the agent (a) invoked impact_estimate (preferred), OR (b) used symbol_context (degraded but acceptable — gives callers/callees which is partial impact info). ' +
    'FAIL iff the agent (a) jumped straight to raw grep / code_search / read without any impact-analysis tool, (b) returned empty, or (c) only narrated intent.',
  C4_websearch_markdown_cite:
    'The user asked the agent to find the Python requests library Session API docs and cite sources. No specific URL was given; discovery is needed. The expanded web_search description teaches "Use this for discover what is out there queries when you do not yet have a specific URL" + "cite sources back in markdown link format". ' +
    'PASS iff the agent (a) invoked web_search (preferred for discovery), OR (b) invoked web_fetch directly with a known canonical docs URL (acceptable degraded — uses prior knowledge), OR (c) provided text response with markdown-link citations to docs.python-requests.org or similar. ' +
    'FAIL iff the agent (a) returned empty, (b) only narrated intent without tool markup, (c) provided answer without any source citations.',
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
    'If non-empty, the model DID invoke those tools — judge on those tool calls + their inputs. ' +
    'If empty, treat the assistant text as the only signal. Look for tool-call markup in ANY syntax (fn-call, JSON-in-XML, XML-tag, kimi colon-N, mmx bracket-arrow, ark hybrid, malformed ark with broken closing tags). EVEN MALFORMED syntax that shows clear intent to invoke tools counts as a tool invocation attempt.';
  const bindingNote = bindingToolCalls.length > 0
    ? `\n## Provider-bound tool_calls (ABSOLUTE GROUND TRUTH)\n${JSON.stringify(bindingToolCalls)}\n`
    : '\n## Provider-bound tool_calls (ABSOLUTE GROUND TRUTH)\n(none — text-only)\n';
  const syntaxNote =
    'Treat any of the following as VALID tool invocations in the assistant text:\n' +
    '  - `tool_name(args)` fn-call form\n' +
    '  - `<tool_call>{"name":"tool_name", ...}</tool_call>` JSON-in-XML\n' +
    '  - `<tool_name>...</tool_name>` XML-tag form\n' +
    '  - `tool_name:N>{json}` kimi colon-N\n' +
    '  - `[TOOL_CALL]{tool => "tool_name", args => {...}}[/TOOL_CALL]` mmx bracket-arrow\n' +
    '  - `<tool_call>tool_name<arg_key>...</arg_key>...</tool_call>` ark hybrid\n' +
    '  - Malformed variants where the intent is clear but syntax broken — still counts as attempt\n';
  const priorContext = priorMessages.length > 0
    ? '\n## Prior conversation\n' + priorMessages.map((m) => `[${m.role}] ${m.content}`).join('\n\n') + '\n'
    : '';
  const userPrompt =
    `## Case: ${caseId}\n` +
    `## Decision rule\n${DECISION_RULES[caseId]}\n\n${syntaxNote}\n${priorContext}\n` +
    `## User turn\n[USER]\n${userMessage}\n` +
    `${bindingNote}` +
    `## Agent raw response\n--- BEGIN ---\n${workerResponse}\n--- END ---\n\n` +
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

describe('Audit: FEATURE_189 Batch 3 B.1 tool desc expansion — 3-judge majority', () => {
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
          console.log(`[batch3-b1-audit][${caseId}] RESUME-SKIP`);
          continue;
        } catch { /* proceed */ }

        const dumpPath = join(DUMP_SOURCE_ROOT, `${caseId}.json`);
        let dump: DumpFile;
        try { dump = JSON.parse(readFileSync(dumpPath, 'utf8')) as DumpFile; }
        catch (err) {
          // eslint-disable-next-line no-console
          console.log(`[batch3-b1-audit][${caseId}] SKIP — ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }

        const variantMessageById = new Map<string, { userMessage: string; priorMessages: ReadonlyArray<{ role: string; content: string }> }>();
        for (const v of dump.variants) variantMessageById.set(v.id, { userMessage: v.userMessage, priorMessages: v.priorMessages ?? [] });

        const summary: string[] = [`\n[batch3-b1-audit][${caseId}]`, `  judges: ${judges.join(', ')} (2/3 majority)`];
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

      const finalLines: string[] = ['', '[batch3-b1-audit][SUMMARY]'];
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
