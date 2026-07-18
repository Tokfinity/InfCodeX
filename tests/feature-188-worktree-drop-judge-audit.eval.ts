/**
 * LLM-judge audit driver for FEATURE_188 (v0.7.42, ADR-034)
 * `dispatch_child_task` worktree drop + qualitative dispatchRules
 * Layer 2 panel.
 *
 * 3-judge majority vote across `zhipu/glm52` + `ark/v4pro` + `kimi`
 * (per `feedback_canonical_eval_alias_panel` 2026-05-21 update +
 * `feedback_audit_binding_priority_in_prompt`).
 *
 * Reads dumps from `feature-188-worktree-drop` panel and writes audit
 * results under `feature-188-worktree-drop-judge-audit/`.
 *
 * ## Cost
 *
 *   100 panel runs × 3 judges = 300 LLM calls × ~$0.005-0.01/call ≈ $1.5-3
 *
 * ## Run
 *
 *   KODAX_EVAL_DUMP_DIR=c:/tmp/ npm run test:eval -- feature-188-worktree-drop-judge-audit
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
} from '../benchmark/datasets/feature-177-task-output/cases.js';

const DUMP_ROOT_BASE = process.env.KODAX_EVAL_DUMP_DIR ?? tmpdir();
const DUMP_SOURCE_ROOT = join(DUMP_ROOT_BASE, 'kodax-eval-dumps', 'feature-188-worktree-drop');
const AUDIT_DUMP_ROOT = join(
  DUMP_ROOT_BASE,
  'kodax-eval-dumps',
  'feature-188-worktree-drop-judge-audit',
);

const JUDGES: readonly ModelAlias[] = ['zhipu/glm52', 'ark/v4pro', 'kimi'] as const;

// The panel covers exactly 2 cases (C4 + C5) — both share the FEATURE_177
// CASES list. Filter so the audit only re-judges those two cases (not
// the full 5-case F177 set, which would error on missing dumps).
const F188_CASE_IDS: readonly CaseId[] = [
  'read_only_fanout_not_polling',
  'write_fanout_not_polling',
];

interface DumpRun {
  readonly runIndex: number;
  readonly text: string;
  readonly toolCalls: ReadonlyArray<{ name: string; input: unknown }>;
  readonly regexPassed: boolean;
  readonly error?: string;
  readonly fallbackUsed?: ModelAlias;
}

interface DumpAliasCell {
  readonly alias: string;
  readonly variantId: string;
  readonly passRate: number;
  readonly runs: readonly DumpRun[];
}

interface DumpVariantMeta {
  readonly id: string;
  readonly description: string;
  readonly systemPrompt: string;
  readonly userMessage: string;
}

interface DumpFile {
  readonly case: CaseId;
  readonly stage: string;
  readonly polarity: CaseSpec['polarity'];
  readonly behaviour: string;
  readonly startedAt: string;
  readonly variants: readonly DumpVariantMeta[];
  readonly aliases: readonly DumpAliasCell[];
}

function caseDecisionRule(spec: CaseSpec): string {
  switch (spec.polarity) {
    case 'must_dispatch_readonly_fanout':
      return 'PASS iff the response invokes `dispatch_child_task` (one or more, RULE A — ideally ≥3 dispatches for an audit spanning 4 packages, but ≥1 dispatch counts since the panel measures the first tool_use). Either readOnly:true OR omitted readOnly counts (audit-task default is read-only). FAIL conditions: (a) `task_output` invoked (no in-flight task exists — anti-pattern); (b) `dispatch_child_task` invoked with explicit `readOnly:false` on a pure-audit task (RULE A is read-only); (c) parent does the 4 audits serially via `read` / `grep` / `bash` without dispatching.';
    case 'must_dispatch_write_fanout':
      return 'PASS iff the response invokes `dispatch_child_task` (one or more, RULE C — ≥3 dispatches expected for the 3-file edit task, but ≥1 counts since panel measures first tool_use). The dispatch SHOULD have `readOnly:false` OR an objective string with a write verb (add/edit/write/insert/create/update/patch) — both signal RULE C. FAIL conditions: (a) `task_output` invoked (no in-flight task — anti-pattern); (b) `dispatch_child_task` invoked with explicit `readOnly:true` on a clear-write task; (c) parent does the 3 edits serially via `write` / `edit` / `multi_edit` without dispatching.';
    case 'must_call_task_output':
    case 'must_idle_yield_text_only':
      // These polarities are not used in FEATURE_188 panel (C4+C5 only)
      // — but the CaseSpec union forces us to handle them. Fall through
      // to a generic "not in F188 scope" rule that effectively makes the
      // case a no-op if it ever ends up routed here.
      return 'OUT-OF-SCOPE for FEATURE_188 audit (case polarity not part of dispatch_child worktree-drop signal). Mark UNCLEAR.';
  }
}

function buildJudgePrompt(
  spec: CaseSpec,
  userMessage: string,
  workerResponse: string,
  bindingToolCalls: ReadonlyArray<{ name: string; input: unknown }>,
): { systemPrompt: string; userMessage: string } {
  // Mirrors FEATURE_177 audit prompt (per feedback_audit_binding_priority_in_prompt):
  // CRITICAL RULE at top, binding flagged as ABSOLUTE GROUND TRUTH, read FIRST.
  const systemPrompt =
    "You are an independent judge auditing a coding agent's tool-call behavior. " +
    'Reply with a single JSON object on one line — no markdown, no preamble, no <think> blocks.\n\n' +
    '## CRITICAL RULE — read this FIRST before reading the response text\n\n' +
    'The "Provider-bound tool_calls" section below is the ABSOLUTE GROUND TRUTH for what tools the model invoked. ' +
    'If that section is non-empty, the model DID invoke those tools — judge on those tool calls + their inputs, ' +
    'regardless of what the assistant text says. ' +
    'If that section is empty, fall back to text-based detection (look for tool-call markup in the response). ' +
    'A binding-captured tool call with name=X is a fact; the assistant text saying "I will not invoke X" ' +
    'next to a binding entry for X means the binding is correct (text-only intent disclaimers do not unwind a real call).';

  const bindingNote =
    bindingToolCalls.length > 0
      ? `\n## Provider-bound tool_calls (ABSOLUTE GROUND TRUTH — read this first)\n${JSON.stringify(bindingToolCalls)}\n`
      : '\n## Provider-bound tool_calls (ABSOLUTE GROUND TRUTH — read this first)\n(none — model emitted tools via text only; use the response-text section below)\n';

  const syntaxNote =
    'Treat any of the following text-only patterns as VALID tool invocations (syntax varies across families):\n' +
    '  - `tool_name(args)` fn-call form\n' +
    '  - `<tool_call>{"name":"tool_name", ...}</tool_call>` JSON-in-XML (OpenAI canonical)\n' +
    '  - `<tool_name>...</tool_name>` XML-tag form\n' +
    '  - `<tool_name>tool_name</tool_name>` zhipu nested XML\n' +
    '  - `tool_name:N>{json}` / `tool_name:N{json}` kimi colon-N form\n' +
    '  - `[TOOL_CALL]{tool => "tool_name", args => {...}}[/TOOL_CALL]` mmx bracket-arrow\n' +
    '  - `<tool_call>tool_name<arg_key>...</arg_key>...</tool_call>` ark hybrid\n' +
    '\n' +
    'Treat as INVALID (FAIL):\n' +
    '  - Text-only intent statement with NO tool-call markup ("Let me dispatch a child for X" without any of the syntax above)\n' +
    '  - Severely malformed syntax that no production runtime could parse\n' +
    '  - A different tool than required by the decision rule\n';

  const userPrompt =
    'An agent (the "Worker") plans whether to dispatch child tasks during a coding run. It has access to:\n' +
    '  - `dispatch_child_task({id, objective, readOnly?, model_hint?})` — launch a child; returns task_id banner\n' +
    '  - `task_output({task_id, block?:boolean, timeout_ms?})` — peek snapshot of an in-flight child\n' +
    '  - `task_stop({task_id, reason?})` — graceful abort of a specific child\n' +
    '  - `read` / `grep` / `bash` / `write` / `edit` — standard tools\n\n' +
    `## Case: ${spec.id} (${spec.polarity})\n${spec.description}\n\n` +
    `## User turn that triggered the response\n[USER]\n${userMessage}\n\n` +
    `## Decision rule\n${caseDecisionRule(spec)}\n\n${syntaxNote}\n${bindingNote}\n` +
    `## Worker raw response\n--- BEGIN ---\n${workerResponse}\n--- END ---\n\n` +
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

describe('Audit: FEATURE_188 dispatch_child worktree drop — LLM-judge majority-vote', () => {
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
    'audits all raw outputs with 3-judge majority vote (per case × variant × alias × run)',
    // 60-min cap: 300 LLM calls × ~7s = ~35 min worst case + buffer.
    { timeout: 60 * 60_000 },
    async () => {
      mkdirSync(AUDIT_DUMP_ROOT, { recursive: true });

      const overall = {
        totalCells: 0,
        agreeWithRegex: 0,
        disagreeWithRegex: 0,
        unclear: 0,
      };

      const f188Cases = CASES.filter((c) => F188_CASE_IDS.includes(c.id));

      for (const c of f188Cases) {
        // Resume support — skip cases whose audit dump already exists.
        const auditPathPreCheck = join(AUDIT_DUMP_ROOT, `${c.id}.json`);
        try {
          const existing = JSON.parse(readFileSync(auditPathPreCheck, 'utf8')) as {
            totalRows?: number;
          };
          // eslint-disable-next-line no-console
          console.log(
            `[judge-audit][${c.id}] RESUME-SKIP — audit dump already present at ${auditPathPreCheck} (totalRows=${
              existing.totalRows ?? '?'
            })`,
          );
          continue;
        } catch {
          // File missing — proceed.
        }

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

        const variantMessageById = new Map<string, string>();
        for (const v of dump.variants) {
          variantMessageById.set(v.id, v.userMessage);
        }

        const summary: string[] = [];
        summary.push(`\n[judge-audit][${c.id}] polarity=${c.polarity}`);
        summary.push(`  judges: ${judges.join(', ')} (2/3 majority vote)`);

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

        for (const variantId of [...byVariant.keys()].sort()) {
          summary.push('');
          summary.push(`  --- variant: ${variantId} ---`);
          const userMessage = variantMessageById.get(variantId) ?? '';
          const cells = byVariant.get(variantId) ?? [];
          const byAlias: typeof auditByVariant[number]['aliases'] = [];
          for (const cell of cells) {
            const rows: typeof byAlias[number]['rows'] = [];
            for (const r of cell.runs) {
              if (r.error) continue;
              const { systemPrompt, userMessage: judgeUserMsg } = buildJudgePrompt(
                c,
                userMessage,
                r.text,
                r.toolCalls,
              );
              const verdicts: Record<string, JudgeVerdict> = {};
              for (const judge of judges) {
                try {
                  const result = await runOneShot(judge, {
                    systemPrompt,
                    userMessage: judgeUserMsg,
                  });
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
              alias: cell.alias,
              regexPassRate: rows.length === 0 ? 0 : regexPass / rows.length,
              judgePassRate: rows.length === 0 ? 0 : judgePass / rows.length,
              rows,
            });
            const disag = rows.filter((r) => !r.agreesWithRegex).length;
            const total = rows.length || 1;
            summary.push(
              `    ${cell.alias.padEnd(13)} regex=${regexPass}/${rows.length} (${
                Math.round((regexPass / total) * 100)
              }%)  judge=${judgePass}/${rows.length} (${
                Math.round((judgePass / total) * 100)
              }%)` + (disag > 0 ? `  disagree=${disag}` : ''),
            );
          }
          auditByVariant.push({ variantId, aliases: byAlias });
        }

        // Re-ensure dump dir per case — Windows tmpdir wipe defense.
        mkdirSync(AUDIT_DUMP_ROOT, { recursive: true });
        const auditPath = join(AUDIT_DUMP_ROOT, `${c.id}.json`);
        const totalRows = auditByVariant.reduce(
          (sum, v) => sum + v.aliases.reduce((s, a) => s + a.rows.length, 0),
          0,
        );
        writeFileSync(
          auditPath,
          JSON.stringify(
            {
              case: c.id,
              polarity: c.polarity,
              judges,
              totalRows,
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
            ? 'DATA INVALID — disagreement > 10%, redesign regex/judge before applying SHIP/PARTIAL/REVERT'
            : 'DATA VALID — regex-vs-judge agreement within tolerance, proceed to decision matrix'
        }`,
      );
      // eslint-disable-next-line no-console
      console.log(finalLines.join('\n'));
    },
  );
});
