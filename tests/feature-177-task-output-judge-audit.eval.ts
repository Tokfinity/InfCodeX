/**
 * LLM-judge audit driver for FEATURE_177 (v0.7.45) `task_output` Worker
 * prompt RULE D — panel-internal 3-judge majority vote
 * (zhipu/glm52 + ark/v4pro + kimi, 2/3 majority).
 *
 * Per EVAL_GUIDELINES anti-pattern 7 §3 strict clause + §Judge model
 * selection. Mirrors `tests/feature-170-todo-v2-migration-judge-audit
 * .eval.ts` but adapted to FEATURE_177's flat `aliases:[{alias, variantId,
 * runs:[...]}]` dump schema (vs FEATURE_170's nested
 * `variants:[{aliases:[...]}]`).
 *
 * ## Why audit?
 *
 * Regex-based judges have known failure modes:
 *
 *   - Anti-pattern 7 §1: verbose CoT models say "I should NOT call
 *     task_output(block:true)" inside `<think>` blocks — regex matches
 *     the string and false-FAILs even when the model's actual response
 *     is correct.
 *   - `feedback_audit_must_see_binding`: providers vary on whether
 *     tool_calls surface as structured binding or text-only XML.
 *     Empty binding + text-only invocation can confuse a naive judge
 *     into "no tool invoked" FAIL.
 *   - Cross-case: a `dispatch_child_task` call in Case 4/5 might
 *     emit a literal `task_output` string inside the objective text
 *     ("after dispatch, parent should use task_output to peek") —
 *     regex would FAIL even though the actual emission is a correct
 *     RULE A/C dispatch.
 *
 * ## Judge panel
 *
 *   `zhipu/glm52` + `ark/v4pro` + `kimi` — 3 independent provider
 *   families, all on coding-plan. 2/3 majority vote. Per
 *   `feedback_audit_binding_priority_in_prompt`: audit prompt MUST
 *   include binding ground truth at top with CRITICAL RULE wording.
 *
 *   `ark/v4pro` replaces `ds/v4pro` (deepseek official API) per
 *   `feedback_canonical_eval_alias_panel` 2026-05-21 update —
 *   DeepSeek-V4 is now sourced via ark-coding gateway.
 *
 * ## Cost
 *
 *   250 runs × 3 judges = 750 LLM calls × ~$0.005-0.01/call ≈ $4-7.50
 *
 * ## Run
 *
 *   npm run test:eval -- feature-177-task-output-judge-audit
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

// KODAX_EVAL_DUMP_DIR env var honored so the audit reads from the same
// transient-but-stable location the panel wrote to. Defaults to OS
// tmpdir per EVAL_GUIDELINES (so guideline-compliant on machines where
// Temp survives ≥1 hour). Override required on Windows Storage-Sense
// machines where Temp wipes mid-workflow.
const DUMP_ROOT_BASE = process.env.KODAX_EVAL_DUMP_DIR ?? tmpdir();
const DUMP_SOURCE_ROOT = join(DUMP_ROOT_BASE, 'kodax-eval-dumps', 'feature-177-task-output');
const AUDIT_DUMP_ROOT = join(
  DUMP_ROOT_BASE,
  'kodax-eval-dumps',
  'feature-177-task-output-judge-audit',
);

const JUDGES: readonly ModelAlias[] = ['zhipu/glm52', 'ark/v4pro', 'kimi'] as const;

interface DumpRun {
  readonly runIndex: number;
  readonly text: string;
  readonly toolCalls: ReadonlyArray<{ name: string; input: unknown }>;
  readonly regexPassed: boolean;
  readonly error?: string;
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
    case 'must_call_task_output':
      return 'PASS iff the response invokes the `task_output` tool with `block` omitted OR set to `false` (status snapshot read). FAIL conditions: (a) no `task_output` invocation at all (text-only intent like "let me check" without a tool call is FAIL); (b) `task_output` invoked with `block:true` (wrong shape — user wanted a status peek, not a wait); (c) some other tool invoked instead (`dispatch_child_task` to re-dispatch is FAIL; `task_stop` to abort is FAIL; `bash` / `read` exploring the parent\'s filesystem is FAIL).';
    case 'must_idle_yield_text_only':
      return 'PASS iff the response contains ZERO tool invocations — the Worker emits a short status sentence (or empty text) and ends the turn so the runner can idle-yield. FAIL conditions: (a) ANY tool invocation (`task_output`, `dispatch_child_task`, `task_stop`, `send_message`, `read`, `bash`, etc.); (b) `task_output(block:true)` is especially-flagged FAIL — it is the canonical misuse pattern this case probes (using block:true as a wait substitute defeats idle-yield). Note: assistant text describing future intent without an actual tool call is fine — only TOOL INVOCATIONS count as FAIL.';
    case 'must_dispatch_readonly_fanout':
      return 'PASS iff the response invokes `dispatch_child_task` (one or more, RULE A — ideally ≥3 dispatches for an audit spanning 4 packages, but ≥1 dispatch counts as a partial PASS since the panel measures the first tool_use). Either readOnly:true OR omitted readOnly counts (audit-task default is read-only). FAIL conditions: (a) `task_output` invoked (no in-flight task exists — this is the FEATURE_177 cross-case anti-pattern: substituting peek for fan-out); (b) `dispatch_child_task` invoked with explicit `readOnly:false` on a pure-audit task (RULE A is read-only); (c) parent does the 4 audits serially via `read` / `grep` / `bash` without dispatching.';
    case 'must_dispatch_write_fanout':
      return 'PASS iff the response invokes `dispatch_child_task` (one or more, RULE C — ≥3 dispatches expected for the 3-file edit task, but ≥1 counts since panel measures first tool_use). The dispatch SHOULD have `readOnly:false` OR an objective string with a write verb (add/edit/write/insert/create/update/patch) — both signal the model picked up RULE C. FAIL conditions: (a) `task_output` invoked (no in-flight task — cross-case anti-pattern); (b) `dispatch_child_task` invoked with explicit `readOnly:true` on a clear-write task; (c) parent does the 3 edits serially via `write` / `edit` / `multi_edit` without dispatching.';
  }
}

function buildJudgePrompt(
  spec: CaseSpec,
  userMessage: string,
  workerResponse: string,
  bindingToolCalls: ReadonlyArray<{ name: string; input: unknown }>,
): { systemPrompt: string; userMessage: string } {
  // Per `feedback_audit_binding_priority_in_prompt`: CRITICAL RULE
  // wording at top of the system prompt, binding flagged as
  // ABSOLUTE GROUND TRUTH and read FIRST. The 2026-05-18 tool-schema-slim
  // audit failure (AUQ_6 85-97% disagreement on weak binding wording)
  // is the cautionary tale this prompt addresses.
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

  // Per `feedback_regex_audit_per_new_eval`: tool-name detection across
  // 9 syntax variants. Inline-document the variants the audit judge
  // should treat as valid so a kimi `tool:N>` or zhipu nested XML
  // doesn't get marked as "no tool call".
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
    '  - Text-only intent statement with NO tool-call markup ("Let me check task_C now." without any of the syntax above)\n' +
    '  - Severely malformed syntax that no production runtime could parse\n' +
    '  - A different tool than required by the decision rule\n';

  const userPrompt =
    'An agent (the "Worker") manages parallel child tasks during a coding run. It has access to:\n' +
    '  - `dispatch_child_task({id, objective, readOnly?, model_hint?})` — launch a child; returns task_id banner\n' +
    '  - `task_output({task_id, block?:boolean, timeout_ms?})` — peek snapshot of an in-flight child (block=false default for status)\n' +
    '  - `task_stop({task_id, reason?})` — graceful abort of a specific child\n' +
    '  - `send_message({to, content})` — send instruction to in-flight child\n' +
    '  - `read` / `grep` / `bash` — standard tools\n\n' +
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

describe('Audit: FEATURE_177 task_output LLM-judge majority-vote (anti-pattern 7 §3)', () => {
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
    // 90-min cap: 750 LLM calls × ~7s = ~90 min worst case.
    { timeout: 90 * 60_000 },
    async () => {
      mkdirSync(AUDIT_DUMP_ROOT, { recursive: true });

      const overall: {
        totalCells: number;
        agreeWithRegex: number;
        disagreeWithRegex: number;
        unclear: number;
      } = { totalCells: 0, agreeWithRegex: 0, disagreeWithRegex: 0, unclear: 0 };

      for (const c of CASES) {
        // Resume support: if the audit dump for this case already exists,
        // skip judging it again. Previous run (b6fgnqo7y → bp71z5ucl) lost
        // ~33 min of work when Windows wiped the audit dir mid-write; this
        // path lets a rerun pick up where the last attempt left off
        // without re-paying judge LLM cost for cases already verified.
        const auditPathPreCheck = join(AUDIT_DUMP_ROOT, `${c.id}.json`);
        try {
          const existing = JSON.parse(
            readFileSync(auditPathPreCheck, 'utf8'),
          ) as { totalRows?: number };
          // eslint-disable-next-line no-console
          console.log(
            `[judge-audit][${c.id}] RESUME-SKIP — audit dump already present at ${auditPathPreCheck} (totalRows=${
              existing.totalRows ?? '?'
            })`,
          );
          continue;
        } catch {
          // File missing — proceed with judging.
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

        // Group dump cells by variantId for nicer reporting.
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
              if (r.error) {
                // Skip provider-error runs from audit — they were never
                // judged at the regex layer either (provider call failed).
                continue;
              }
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

        // Re-ensure dump dir per case — Windows %LOCALAPPDATA%\Temp has
        // been observed to disappear mid-run on long-haul audits (33 min+
        // with rate-limit retries). Cheap per-case mkdir is robust against
        // both fresh cold-starts and aggressive Temp janitor sweeps.
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
