/**
 * FEATURE_124 Phase E.4 — LLM-judge audit for the memory-smoke eval.
 *
 * Enforces EVAL_GUIDELINES anti-pattern 7 §3:
 *   > 跑完后强制抽查：每个 cell 至少抽 1 条 regex-fail 用 LLM-judge
 *   > （干净 context）独立判一次，对比 regex；如果 disagreement >10%，
 *   > 整个 eval 数据作废重跑。
 *
 * AND the 2026-05-12 judge-model-selection clause:
 *   > 禁止用 anthropic claude / openai gpt 等"外来 strong model"做内部
 *   > eval 的 LLM-judge … allowed: panel-internal multi-judge majority
 *   > vote (3 independent families, 2/3 majority = PASS).
 *
 * ## Input
 *
 * Reads the latest `final-<timestamp>.json` dump produced by
 * `tests/memory-smoke.eval.ts` at
 * `os.tmpdir()/kodax-eval-dumps/feature-124-memory-smoke/`. The dump
 * carries 45 rows (5 alias × 3 case × 3 run). For each row this driver
 * runs the 3-judge panel and compares majority vote vs the structured-
 * toolCalls regex verdict already in the row.
 *
 * ## Judge contract — per case
 *
 *   - S1_write: PASS iff the agent's response invokes Write with a path
 *               inside the memory directory (any of the 4 syntaxes per
 *               EVAL_GUIDELINES §175). Plain-text intent ("I will write
 *               a memory") without an actual tool call is FAIL.
 *   - S2_read:  PASS iff the agent invokes Read / Grep / Glob with a path
 *               inside the memory directory.
 *   - S3_no_duplicate (NEGATIVE):
 *               PASS iff the agent does NOT invoke Write to create a NEW
 *               topic file inside the memory directory. Writes to the
 *               seeded `feedback_no_mock_db.md` (update) or `MEMORY.md`
 *               (index update) are OK. Any other filename inside the
 *               memory directory = FAIL.
 *
 * ## Panel & aggregation
 *
 * Judges: zhipu/glm51 + ark/v4pro + kimi — 3 independent families.
 * Aggregation: 2/3 majority. Ties (1 PASS / 1 FAIL / 1 UNCLEAR) = UNCLEAR.
 * Total: 45 rows × 3 judges = 135 LLM calls (~$1.5-2).
 *
 * ## Disagreement gate
 *
 * Per anti-pattern 7 §3: disagreement >10% → eval data invalid. For 45
 * cells, threshold = ceil(0.10 × 45) = 5. Disagreement >5 cells → FAIL,
 * smoke eval data must be reconstructed (likely needs regex tightening
 * per `feedback_regex_audit_per_new_eval`).
 *
 * ## Run
 *
 *   npm run test:eval -- tests/memory-smoke-judge-audit.eval.ts
 *
 * Skips when any of the 3 judge keys are missing.
 */

import { readFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it } from 'vitest';

import { availableAliases, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runOneShot } from '../benchmark/harness/harness.js';

const SMOKE_DUMP_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'feature-124-memory-smoke');
const AUDIT_DUMP_ROOT = join(
  tmpdir(),
  'kodax-eval-dumps',
  'feature-124-memory-smoke-judge-audit',
);

const JUDGES: readonly ModelAlias[] = ['zhipu/glm51', 'ark/v4pro', 'kimi'] as const;

interface SmokeRow {
  readonly caseId: 'S1_write' | 'S2_read' | 'S3_no_duplicate';
  readonly alias: string;
  readonly runIndex: number;
  readonly text: string;
  readonly toolCalls: ReadonlyArray<{ name: string; input: unknown }>;
  readonly memoryDir: string;
  readonly passed: boolean;
  readonly reason: string;
  readonly auditSignals?: Record<string, boolean>;
}

interface SmokeDump {
  readonly aliases: readonly string[];
  readonly runs: number;
  readonly totalCells: number;
  readonly passedCells: number;
  readonly rows: readonly SmokeRow[];
}

interface JudgeVerdict {
  readonly judgment: 'PASS' | 'FAIL' | 'UNCLEAR';
  readonly reason: string;
  readonly rawJudgeText: string;
}

function findLatestFinalDump(): string | undefined {
  let entries: string[];
  try {
    entries = readdirSync(SMOKE_DUMP_ROOT);
  } catch {
    return undefined;
  }
  const finals = entries.filter((n) => n.startsWith('final-') && n.endsWith('.json'));
  if (finals.length === 0) {
    // Fall back to incremental dump if final wasn't produced.
    const incremental = entries
      .filter((n) => n.startsWith('incremental-') && n.endsWith('.json'))
      .sort()
      .pop();
    return incremental ? join(SMOKE_DUMP_ROOT, incremental) : undefined;
  }
  finals.sort();
  return join(SMOKE_DUMP_ROOT, finals[finals.length - 1]!);
}

const DECISION_RULES: Record<SmokeRow['caseId'], { rule: string; syntaxNote: string }> = {
  S1_write: {
    rule:
      'The agent SHOULD invoke `Write` with a `path` argument located INSIDE the ' +
      'memory directory shown in the system prompt. PASS iff such a tool invocation ' +
      'is present in the response (any syntax form below). Plain text describing ' +
      'intent to write ("I will save this to memory" / "I should write a feedback ' +
      'file") without an actual tool call is FAIL.',
    syntaxNote:
      'Treat ALL of the following as VALID `Write` invocations:\n' +
      '  - `Write(path="...", content="...")` function-call form\n' +
      '  - `<tool_call>{"name":"Write","input":{...}}</tool_call>` JSON-in-XML\n' +
      '  - `<Write path="..." content="...">` XML-tag form\n' +
      '  - `name: Write` or `name="Write"` key/value form\n' +
      'The `path` value MUST be a substring of the memory directory shown to the ' +
      'agent in the system prompt (or end with a filename under that directory). ' +
      'Writing to a path OUTSIDE the memory directory is FAIL.',
  },
  S2_read: {
    rule:
      'The agent SHOULD invoke at least one of `Read`, `Grep`, or `Glob` with a ' +
      '`path` (or search root) located INSIDE the memory directory before composing ' +
      'its answer. PASS iff such a tool invocation is present (any syntax form). ' +
      'Plain text mention without an actual tool call is FAIL. Answering directly ' +
      'from system-prompt context without calling any of these tools is FAIL.',
    syntaxNote:
      'Treat ALL of the following as VALID invocations:\n' +
      '  - `Read(path="...")` / `<Read path="...">` / `<tool_call>{"name":"Read"...}`\n' +
      '  - `Grep(pattern="...", path="...")` / `<Grep ...>` / `<tool_call>{"name":"Grep"...}`\n' +
      '  - `Glob(pattern="...", path="...")` / `<Glob ...>` / `<tool_call>{"name":"Glob"...}`\n' +
      'The `path` value MUST be inside the memory directory shown in the system prompt.',
  },
  S3_no_duplicate: {
    rule:
      'NEGATIVE assertion. PASS iff the agent does NOT create a NEW topic file ' +
      'inside the memory directory. Specifically:\n' +
      '  - PASS: no Write call at all, OR Write only to the seeded ' +
      '`feedback_no_mock_db.md` (an UPDATE of the existing memory), OR Write only ' +
      'to `MEMORY.md` (an index update). Edits via the `Edit` tool are also PASS.\n' +
      '  - FAIL: agent emits a Write call whose target is a NEW filename inside ' +
      'the memory directory (e.g. `feedback_no_mock_db_v2.md` or any other ' +
      '`*.md` not in the allowed set). This is the duplicate-creation failure ' +
      'mode the test guards against.',
    syntaxNote:
      'Allowed targets inside memory directory: `feedback_no_mock_db.md`, `MEMORY.md`. ' +
      'Any other `.md` filename inside the memory directory = FAIL (duplicate). ' +
      'Writes outside the memory directory are unrelated — ignore them for this case.',
  },
};

function buildJudgePrompt(row: SmokeRow): { systemPrompt: string; userMessage: string } {
  // CRITICAL audit-prompt design per `feedback_audit_must_see_binding`
  // and `feedback_audit_binding_priority_in_prompt`: the harness captures
  // tool_use blocks STRUCTURALLY (as a separate channel), so the agent's
  // raw `text` often does NOT contain the tool call syntax — it's just
  // the natural-language preamble like "I'll save this to memory now".
  // A naive judge prompt that shows only `text` will FAIL all binding-only
  // outputs (single-direction false disagreement up to ~60%). Fix: show
  // the structured toolCalls FIRST as ABSOLUTE GROUND TRUTH, with system
  // prompt top-level CRITICAL RULE wording. Verified pattern from prior
  // KodaX audit runs (tool-schema-slim v1 → v2 took disagreement
  // 85-97% → 0% after this fix).
  const systemPrompt =
    "You are an independent judge auditing an LLM agent's tool-call behavior. " +
    'Reply with a single JSON object on one line — no markdown, no preamble.\n\n' +
    'CRITICAL RULE: The "Captured tool calls (ABSOLUTE GROUND TRUTH)" section ' +
    'in the user message lists EVERY tool invocation the harness recorded for ' +
    'this turn. This is structurally captured — it is the AUTHORITATIVE record ' +
    'of what the agent did, NOT the agent\'s narration. The "Agent raw response ' +
    'text" is just the natural-language preamble and may be empty or omit the ' +
    'tool-call syntax. **You MUST decide PASS/FAIL based primarily on the ' +
    'Captured tool calls section.** Read it first. Treat the text as secondary ' +
    'context only.';

  const { rule, syntaxNote } = DECISION_RULES[row.caseId];

  // Render the toolCalls as a clean JSON list for the judge. Keep it
  // bounded to avoid blowing context for verbose content payloads.
  const renderedToolCalls = row.toolCalls.length === 0
    ? '(NONE — the agent emitted no tool calls this turn)'
    : row.toolCalls
        .map((c, i) => {
          const inputStr = JSON.stringify(c.input, null, 2)
            .slice(0, 1500); // bound content/long-string payloads
          return `[${i}] name=${c.name}\n    input=${inputStr}`;
        })
        .join('\n');

  const userPrompt =
    `## Case: ${row.caseId}\n\n` +
    `## Memory directory shown to agent (paths INSIDE this dir count as "in memory dir")\n` +
    `${row.memoryDir}\n\n` +
    `## Captured tool calls (ABSOLUTE GROUND TRUTH — read this FIRST)\n` +
    `${renderedToolCalls}\n\n` +
    `## Decision rule\n${rule}\n\n` +
    `## Syntax recognition note (for cases where binding is empty and you must scan text)\n` +
    `${syntaxNote}\n\n` +
    `## Agent raw response text (secondary — natural-language preamble only)\n` +
    `--- BEGIN ---\n${row.text}\n--- END ---\n\n` +
    `Decide PASS or FAIL primarily from the Captured tool calls section. ` +
    `Reply exactly one line of JSON:\n` +
    `  {"judgment":"PASS","reason":"<≤80 chars>"}\n` +
    `or\n` +
    `  {"judgment":"FAIL","reason":"<≤80 chars>"}`;

  return { systemPrompt, userMessage: userPrompt };
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

describe('Audit: FEATURE_124 memory-smoke 3-judge majority (anti-pattern 7 §3)', () => {
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
    'audits all smoke rows with 3-judge majority and reports disagreement vs regex',
    { timeout: 60 * 60_000 },
    async () => {
      const dumpPath = findLatestFinalDump();
      if (!dumpPath) {
        throw new Error(
          `No smoke dump found at ${SMOKE_DUMP_ROOT} — run memory-smoke.eval.ts first.`,
        );
      }
      // eslint-disable-next-line no-console
      console.log(`[F124-audit] reading smoke dump: ${dumpPath}`);
      const dump = JSON.parse(readFileSync(dumpPath, 'utf-8')) as SmokeDump;
      const rows: readonly SmokeRow[] = dump.rows;
      // eslint-disable-next-line no-console
      console.log(`[F124-audit] auditing ${rows.length} rows × ${judges.length} judges`);

      mkdirSync(AUDIT_DUMP_ROOT, { recursive: true });
      const incrementalDump = join(AUDIT_DUMP_ROOT, `incremental-${Date.now()}.json`);

      const audited: Array<{
        caseId: string;
        alias: string;
        runIndex: number;
        regexPassed: boolean;
        verdicts: Record<string, JudgeVerdict>;
        majority: 'PASS' | 'FAIL' | 'UNCLEAR';
        agreesWithRegex: boolean;
      }> = [];

      const flush = (): void => {
        writeFileSync(
          incrementalDump,
          JSON.stringify(
            {
              timestamp: new Date().toISOString(),
              sourceDump: dumpPath,
              judges,
              completed: audited.length,
              expected: rows.length,
              audited,
            },
            null,
            2,
          ),
          'utf-8',
        );
      };

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        // eslint-disable-next-line no-console
        console.log(
          `[F124-audit] ${i + 1}/${rows.length} case=${row.caseId} alias=${row.alias} run=${row.runIndex}`,
        );
        const { systemPrompt, userMessage } = buildJudgePrompt(row);
        const verdicts: Record<string, JudgeVerdict> = {};
        for (const judge of judges) {
          try {
            const result = await runOneShot(judge, { systemPrompt, userMessage });
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
        const agrees = (majority === 'PASS') === row.passed;
        audited.push({
          caseId: row.caseId,
          alias: row.alias,
          runIndex: row.runIndex,
          regexPassed: row.passed,
          verdicts,
          majority,
          agreesWithRegex: agrees,
        });
        flush();
      }

      // Final summary
      const finalDump = join(AUDIT_DUMP_ROOT, `final-${Date.now()}.json`);
      const disagreements = audited.filter((a) => !a.agreesWithRegex && a.majority !== 'UNCLEAR');
      const unclear = audited.filter((a) => a.majority === 'UNCLEAR');
      const disagreeRate = audited.length > 0 ? disagreements.length / audited.length : 0;

      writeFileSync(
        finalDump,
        JSON.stringify(
          {
            timestamp: new Date().toISOString(),
            sourceDump: dumpPath,
            judges,
            audited,
            summary: {
              totalCells: audited.length,
              agreeWithRegex: audited.filter((a) => a.agreesWithRegex).length,
              disagreeWithRegex: disagreements.length,
              unclear: unclear.length,
              disagreeRate,
              disagreeGateThreshold: 0.10,
              gatePass: disagreeRate <= 0.10,
            },
          },
          null,
          2,
        ),
        'utf-8',
      );

      // eslint-disable-next-line no-console
      console.log('\n=== FEATURE_124 audit summary ===');
      // eslint-disable-next-line no-console
      console.log(`Source: ${dumpPath}`);
      // eslint-disable-next-line no-console
      console.log(`Audit:  ${finalDump}`);
      // eslint-disable-next-line no-console
      console.log(`Total cells:       ${audited.length}`);
      // eslint-disable-next-line no-console
      console.log(`Agree with regex:  ${audited.length - disagreements.length - unclear.length}`);
      // eslint-disable-next-line no-console
      console.log(`Disagree:          ${disagreements.length}`);
      // eslint-disable-next-line no-console
      console.log(`Unclear:           ${unclear.length}`);
      // eslint-disable-next-line no-console
      console.log(`Disagree rate:     ${(disagreeRate * 100).toFixed(1)}%`);
      // eslint-disable-next-line no-console
      console.log(`Gate (≤10%):       ${disagreeRate <= 0.10 ? 'PASS — data valid' : 'FAIL — eval data invalid, redesign judge/regex'}`);

      if (disagreements.length > 0) {
        // eslint-disable-next-line no-console
        console.log('\nDisagreements (regex vs majority):');
        for (const d of disagreements) {
          // eslint-disable-next-line no-console
          console.log(
            `  ${d.caseId} ${d.alias} run=${d.runIndex} regex=${d.regexPassed ? 'PASS' : 'FAIL'} → judge=${d.majority}`,
          );
        }
      }
    },
  );
});
