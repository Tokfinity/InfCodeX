/**
 * Eval: FEATURE_228 (v0.7.62) - prompt-visible task memory hints.
 *
 * Layer 1 unit tests cover deterministic pack selection, stale/quarantined
 * exclusion, ignore-memory suppression, and prompt rendering without trace
 * metadata. This Layer 2 eval checks the LLM-facing wording:
 *
 * - memory hints are treated as pointers, not authoritative facts;
 * - exact memory detail causes a read of the referenced file;
 * - current repository evidence overrides stale memory;
 * - suppressed memory is not treated as active task guidance.
 *
 * Run modes (env var `KODAX_F228_MEMORY_HINTS_PROBE`):
 * - `pilot`: ark/v4flash x 3 cases x 1 run (~3 calls).
 * - `panel`: zhipu/glm52, kimi, mmx/m3, ark/v4pro, ark/v4flash x 3 cases.
 * - `off`: compile/no-cost smoke path.
 *
 * Run:
 *   KODAX_F228_MEMORY_HINTS_PROBE=pilot npm run test:eval -- feature-228-memory-hints
 *   KODAX_F228_MEMORY_HINTS_PROBE=panel npm run test:eval -- feature-228-memory-hints
 *
 * Raw dump path:
 *   `<tmpdir>/kodax-eval-dumps/feature-228-memory-hints/`
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { availableAliases, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runOneShot } from '../benchmark/harness/harness.js';
import { runJudges } from '../benchmark/harness/judges.js';
import {
  MEMORY_HINT_CASES,
  type MemoryHintEvalCase,
} from '../benchmark/datasets/feature-228-memory-hints/cases.js';

type Mode = 'off' | 'pilot' | 'panel';

const MODE = parseMode(process.env.KODAX_F228_MEMORY_HINTS_PROBE);
const PANEL_ALIASES: readonly ModelAlias[] = [
  'zhipu/glm52',
  'kimi',
  'mmx/m3',
  'ark/v4pro',
  'ark/v4flash',
];
const REQUESTED_ALIASES: readonly ModelAlias[] =
  MODE === 'pilot' ? (['ark/v4flash'] as const) : PANEL_ALIASES;
const DUMP_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'feature-228-memory-hints');

interface EvalRow {
  readonly caseId: string;
  readonly description: string;
  readonly alias: ModelAlias;
  readonly durationMs: number;
  readonly text: string;
  readonly toolCalls: ReadonlyArray<{ readonly name: string; readonly input: unknown }>;
  readonly passed: boolean;
  readonly judgeResults: ReadonlyArray<{
    readonly name: string;
    readonly passed: boolean;
    readonly reason?: string;
  }>;
}

describe(`Eval: FEATURE_228 memory hints (${MODE})`, () => {
  if (MODE === 'off') {
    it('skips: disabled by KODAX_F228_MEMORY_HINTS_PROBE=off', () => {
      // no-op
    });
    return;
  }

  const aliases = availableAliases(...REQUESTED_ALIASES);
  if (aliases.length === 0) {
    it('skips: no provider API keys in env', () => {
      // no-op
    });
    return;
  }

  it(
    'runs all memory-hint probes and dumps raw output',
    { timeout: MODE === 'pilot' ? 600_000 : 1_800_000 },
    async () => {
      mkdirSync(DUMP_ROOT, { recursive: true });
      const rows: EvalRow[] = [];

      for (const testCase of MEMORY_HINT_CASES) {
        for (const alias of aliases) {
          const result = await runOneShot(alias, {
            systemPrompt: testCase.systemPrompt,
            userMessage: testCase.userMessage,
            tools: testCase.tools,
          });
          const judgeRun = runJudges(result.text, testCase.judges, {
            toolCalls: result.toolCalls,
          });
          rows.push(rowFromResult(testCase, alias, result, judgeRun.passed, judgeRun.results));
        }
      }

      const dumpPath = join(DUMP_ROOT, `${MODE}-${Date.now()}.json`);
      writeFileSync(
        dumpPath,
        JSON.stringify({ mode: MODE, aliases, rows }, null, 2),
        'utf8',
      );

      const failed = rows.filter((row) => !row.passed);
      expect(failed).toEqual([]);
    },
  );
});

function rowFromResult(
  testCase: MemoryHintEvalCase,
  alias: ModelAlias,
  result: Awaited<ReturnType<typeof runOneShot>>,
  passed: boolean,
  judgeResults: ReadonlyArray<{ readonly name: string; readonly passed: boolean; readonly reason?: string }>,
): EvalRow {
  return {
    caseId: testCase.id,
    description: testCase.description,
    alias,
    durationMs: result.durationMs,
    text: result.text,
    toolCalls: result.toolCalls,
    passed,
    judgeResults,
  };
}

function parseMode(value: string | undefined): Mode {
  if (value === 'off' || value === 'pilot' || value === 'panel') return value;
  return 'pilot';
}
