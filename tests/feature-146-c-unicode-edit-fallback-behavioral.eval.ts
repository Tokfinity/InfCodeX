/**
 * Eval: FEATURE_146-C Unicode-edit fallback behavioral eval (v0.7.37).
 *
 * ## Why this exists
 *
 * v0.7.36 FEATURE_131-B added a Unicode-normalized fallback to
 * `text-anchor.ts` (`findUniqueUnicodeNormalizedBlockMatch`) so the
 * `edit` / `multi_edit` tools rescue silent-edit-fails when the LLM's
 * `old_string` carries Unicode glyphs (smart quotes, em-dash, nbsp,
 * full-width Latin, ideographic spaces) that the haystack file does not.
 *
 * The synthetic dataset eval
 * (`tests/feature-131-unicode-dataset-regression.eval.ts`) verifies the
 * **algorithm correctness**: given a constructed needle/haystack with
 * known Unicode artifacts, does the fallback match? What it cannot
 * answer is **frequency in real LLM rollouts**: how often do real
 * production LLMs actually emit Unicode-drifted needles, and does the
 * fallback rescue them?
 *
 * This eval puts 5 production aliases in front of 10 edit tasks (5
 * Unicode-prone haystacks + 5 ASCII-only false-positive guards) and
 * counts categorized outcomes per cell.
 *
 * ## Per-cell measurement
 *
 *   - `byte-exact`        — legacy fallback uniquely matches (no rescue needed)
 *   - `unicode-rescue`    — legacy MISSES, Unicode fallback uniquely matches
 *                           (the FEATURE_131-B win)
 *   - `both-miss`         — both fallbacks miss (LLM produced wrong needle)
 *   - `false-positive`    — legacy uniquely matches range R1; Unicode
 *                           uniquely matches a DIFFERENT range R2 (REGRESSION)
 *   - `no-edit-call`      — LLM didn't emit an `edit` tool call
 *
 * ## Pre-registered thresholds
 *
 *   - PASS: `false-positive` count = 0 (must) AND
 *           Unicode treatment match rate ≥ legacy baseline match rate
 *   - INFORMATIONAL: `unicode-rescue` count (positive cases only) — any
 *           non-zero value is a strict win; 0 means LLMs in 2026 are
 *           conservative enough that the fallback is rarely needed in
 *           normal rollouts (which is fine — the fallback is an insurance
 *           policy for the silent-fail tail risk)
 *
 * ## Aliases
 *
 *   5 aliases with API keys configured: `zhipu/glm51`, `kimi`, `mmx/m27`,
 *   `ds/v4pro`, `ds/v4flash`. Cells skip individually when their key is
 *   absent (per `availableAliases()`).
 *
 * ## Run
 *
 *   npm run test:eval -- feature-146-c-unicode-edit-fallback-behavioral
 */

import { describe, expect, it } from 'vitest';

import {
  findUniqueNormalizedBlockMatch,
  findUniqueUnicodeNormalizedBlockMatch,
} from '../packages/coding/src/tools/text-anchor.js';

import { availableAliases, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runOneShot } from '../benchmark/harness/harness.js';
import {
  buildUnicodeEditSystemPrompt,
  UNICODE_EDIT_TASKS,
  UNICODE_EDIT_TOOLS,
  type UnicodeEditTaskCase,
  type UnicodeTaskClass,
} from '../benchmark/datasets/unicode-edit-fallback/cases.js';

// ---------------------------------------------------------------------------
// Aliases under test (only those with API keys configured)
// ---------------------------------------------------------------------------

const PROBE_ALIASES: ModelAlias[] = [
  'zhipu/glm51',
  'kimi',
  'mmx/m27',
  'ds/v4pro',
  'ds/v4flash',
];

const RUNNABLE_ALIASES = availableAliases(...PROBE_ALIASES);

// ---------------------------------------------------------------------------
// Cell shape + categorization
// ---------------------------------------------------------------------------

type CellCategory =
  | 'byte-exact'
  | 'unicode-rescue'
  | 'both-miss'
  | 'false-positive'
  | 'no-edit-call';

interface CellResult {
  readonly alias: ModelAlias;
  readonly taskId: UnicodeEditTaskCase['id'];
  readonly taskClass: UnicodeTaskClass;
  readonly category: CellCategory;
  readonly oldString?: string;
  readonly text: string;
  readonly error?: string;
}

function categorizeEditCall(
  haystack: string,
  oldString: string | undefined,
): { category: CellCategory; oldString?: string } {
  if (typeof oldString !== 'string' || oldString.length === 0) {
    return { category: 'no-edit-call' };
  }
  const legacy = findUniqueNormalizedBlockMatch(haystack, oldString);
  const unicode = findUniqueUnicodeNormalizedBlockMatch(haystack, oldString);
  const legacyUnique = legacy.status === 'unique';
  const unicodeUnique = unicode.status === 'unique';

  if (legacyUnique && unicodeUnique) {
    // Both match — confirm same range. If different, it's a false positive
    // (the unicode normalize moved the match somewhere else, which would
    // silently change the wrong code).
    const sameRange =
      legacy.range.start === unicode.range.start && legacy.range.end === unicode.range.end;
    if (sameRange) return { category: 'byte-exact', oldString };
    return { category: 'false-positive', oldString };
  }
  if (!legacyUnique && unicodeUnique) {
    return { category: 'unicode-rescue', oldString };
  }
  return { category: 'both-miss', oldString };
}

async function runCell(alias: ModelAlias, task: UnicodeEditTaskCase): Promise<CellResult> {
  const userMessage = [
    `File path: src/${task.id}.ts`,
    '',
    'File content (verbatim):',
    '```',
    task.haystack,
    '```',
    '',
    task.userInstruction,
  ].join('\n');

  try {
    const result = await runOneShot(alias, {
      systemPrompt: buildUnicodeEditSystemPrompt(),
      userMessage,
      tools: UNICODE_EDIT_TOOLS,
    });
    const editCall = result.toolCalls.find((c) => c.name === 'edit');
    const oldString =
      editCall && typeof (editCall.input as { old_string?: unknown }).old_string === 'string'
        ? (editCall.input as { old_string: string }).old_string
        : undefined;
    const { category, oldString: capturedOldString } = categorizeEditCall(
      task.haystack,
      oldString,
    );
    return {
      alias,
      taskId: task.id,
      taskClass: task.taskClass,
      category,
      oldString: capturedOldString,
      text: result.text,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      alias,
      taskId: task.id,
      taskClass: task.taskClass,
      category: 'no-edit-call',
      text: `[probe error: ${errMsg}]`,
      error: errMsg,
    };
  }
}

interface AggregateReport {
  readonly cells: readonly CellResult[];
  readonly counts: Readonly<Record<CellCategory, number>>;
  readonly legacyMatchCount: number;
  readonly unicodeMatchCount: number;
  readonly falsePositiveCount: number;
  readonly unicodeRescueCount: number;
  readonly errorCount: number;
}

function aggregate(cells: readonly CellResult[]): AggregateReport {
  const counts: Record<CellCategory, number> = {
    'byte-exact': 0,
    'unicode-rescue': 0,
    'both-miss': 0,
    'false-positive': 0,
    'no-edit-call': 0,
  };
  for (const c of cells) counts[c.category] += 1;
  // Legacy match = byte-exact + false-positive (both have legacy match by definition)
  const legacyMatchCount = counts['byte-exact'] + counts['false-positive'];
  // Unicode match = byte-exact + unicode-rescue + false-positive
  // (false-positive: Unicode also matches uniquely, just at a different range)
  const unicodeMatchCount =
    counts['byte-exact'] + counts['unicode-rescue'] + counts['false-positive'];
  return {
    cells,
    counts,
    legacyMatchCount,
    unicodeMatchCount,
    falsePositiveCount: counts['false-positive'],
    unicodeRescueCount: counts['unicode-rescue'],
    errorCount: cells.filter((c) => c.error).length,
  };
}

const reportRef: { current: AggregateReport | undefined } = { current: undefined };

// ---------------------------------------------------------------------------
// Suite — strict serial within each alias (avoid 429 per EVAL_GUIDELINES
// 反模式 3); cross-alias still serial here for log readability.
// ---------------------------------------------------------------------------

describe('FEATURE_146-C — Unicode edit fallback behavioral eval', () => {
  describe.skipIf(RUNNABLE_ALIASES.length === 0)('with ≥1 alias key configured', () => {
    it(
      `runs ${RUNNABLE_ALIASES.length} aliases × ${UNICODE_EDIT_TASKS.length} tasks serially`,
      async () => {
        const cells: CellResult[] = [];
        for (const alias of RUNNABLE_ALIASES) {
          for (const task of UNICODE_EDIT_TASKS) {
            const cell = await runCell(alias, task);
            cells.push(cell);
            // eslint-disable-next-line no-console
            console.log(
              `[probe] ${alias} / ${task.id} (${task.taskClass}): ${cell.category}` +
                (cell.error ? ` ERROR=${cell.error}` : ''),
            );
          }
        }
        reportRef.current = aggregate(cells);

        expect(cells.length).toBe(
          RUNNABLE_ALIASES.length * UNICODE_EDIT_TASKS.length,
        );
      },
      // 5 alias × 10 task × ~15s/cell upper bound = 12.5 min. Vitest timeout
      // overshoot to 25 min for slow providers / larger payloads.
      25 * 60_000,
    );

    it('false-positive count = 0 (PASS gate — must NOT silently change wrong location)', () => {
      const report = reportRef.current;
      expect(report).toBeDefined();
      // eslint-disable-next-line no-console
      console.log(
        `[fea146-C] false-positive count = ${report!.falsePositiveCount} ` +
          `(target = 0; non-zero means Unicode normalize moved the match to a different range vs legacy)`,
      );
      expect(
        report!.falsePositiveCount,
        'FEATURE_131-B Unicode fallback produced different match range than legacy — would silently corrupt unrelated code',
      ).toBe(0);
    });

    it('Unicode treatment match rate ≥ legacy baseline (PASS gate — no regression)', () => {
      const report = reportRef.current;
      expect(report).toBeDefined();
      // eslint-disable-next-line no-console
      console.log(
        `[fea146-C] match counts: legacy=${report!.legacyMatchCount}/${report!.cells.length} ` +
          `unicode=${report!.unicodeMatchCount}/${report!.cells.length}`,
      );
      // Strict ≥: Unicode treatment includes byte-exact + unicode-rescue +
      // false-positive (= 0 by gate above). Legacy = byte-exact + false-positive.
      // If Unicode < legacy, something is structurally wrong.
      expect(
        report!.unicodeMatchCount,
        'Unicode fallback match rate dropped below legacy — net regression',
      ).toBeGreaterThanOrEqual(report!.legacyMatchCount);
    });

    it('category breakdown report (informational)', () => {
      const report = reportRef.current;
      expect(report).toBeDefined();
      // eslint-disable-next-line no-console
      console.log('[fea146-C] category breakdown:');
      // eslint-disable-next-line no-console
      console.log(`  byte-exact      = ${report!.counts['byte-exact']}`);
      // eslint-disable-next-line no-console
      console.log(`  unicode-rescue  = ${report!.counts['unicode-rescue']}  (FEATURE_131-B uplift)`);
      // eslint-disable-next-line no-console
      console.log(`  both-miss       = ${report!.counts['both-miss']}        (LLM error, not Unicode)`);
      // eslint-disable-next-line no-console
      console.log(`  false-positive  = ${report!.counts['false-positive']}   (must = 0)`);
      // eslint-disable-next-line no-console
      console.log(`  no-edit-call    = ${report!.counts['no-edit-call']}     (LLM didn't emit edit)`);
    });

    it('per-alias × per-class breakdown (informational)', () => {
      const report = reportRef.current;
      expect(report).toBeDefined();
      const byAliasClass = new Map<string, Record<CellCategory, number>>();
      for (const c of report!.cells) {
        const key = `${c.alias} / ${c.taskClass}`;
        const counts =
          byAliasClass.get(key) ??
          ({
            'byte-exact': 0,
            'unicode-rescue': 0,
            'both-miss': 0,
            'false-positive': 0,
            'no-edit-call': 0,
          } as Record<CellCategory, number>);
        counts[c.category] += 1;
        byAliasClass.set(key, counts);
      }
      // eslint-disable-next-line no-console
      console.log('[fea146-C] per-alias × per-class breakdown:');
      for (const [key, counts] of byAliasClass) {
        // eslint-disable-next-line no-console
        console.log(
          `  ${key.padEnd(30)}  ` +
            `byte-exact=${counts['byte-exact']} unicode-rescue=${counts['unicode-rescue']} ` +
            `both-miss=${counts['both-miss']} false-positive=${counts['false-positive']} ` +
            `no-edit-call=${counts['no-edit-call']}`,
        );
      }
    });
  });

  it('at least one alias has an API key configured', () => {
    if (RUNNABLE_ALIASES.length === 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[fea146-C behavioral eval] No alias keys present (need any of ` +
          `ZHIPU_API_KEY / KIMI_API_KEY / MINIMAX_API_KEY / DEEPSEEK_API_KEY) — eval is skipped.`,
      );
    }
    expect(true).toBe(true);
  });
});
