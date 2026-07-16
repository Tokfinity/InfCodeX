/**
 * Compaction Prompt Eval — v0.7.35.1 FEATURE_142 (B-R1).
 *
 * Compares 3 compaction summary prompts head-to-head on a 10-fixture
 * dataset (5 coding + 5 non-coding) to pick the winner that ships as
 * `DEFAULT_SUMMARY_PROMPT` / `DEFAULT_UPDATE_SUMMARY_PROMPT` in
 * `@kodax-ai/agent`:
 *
 *   - baseline-coding         → verbatim v0.7.35 prompt (coding-flavored)
 *   - candidate-a-conservative → minimal neutralization
 *   - candidate-b-aggressive   → A + bullet collapse + dropped example
 *
 * The baseline-coding prompt is preserved verbatim in @kodax-ai/coding as
 * `CODING_SUMMARY_PROMPT` (byte-equivalent to v0.7.35 — coding caller
 * passes it via the new `summaryPrompt` parameter). Eval picks the
 * neutral default for non-coding consumers.
 *
 * Scoring:
 *   - schema validity (must be 100% — gates the candidate)
 *   - keyFact recall (substring match on annotated ground truth)
 *   - cross-domain consistency (coding recall vs non-coding recall)
 *   - length efficiency (output tokens for equivalent recall)
 *
 * Run:
 *   KODAX_EVAL_COMPACTION_PROMPT=1 npm run test:eval -- compaction-prompt
 *
 * Default skips so CI without API keys does not fail.
 */

import { describe, expect, it } from 'vitest';
import { getProvider, sideQuery, type KodaXTokenUsage } from '@kodax-ai/llm';

import { availableAliases, resolveAlias, type ModelAlias } from '../benchmark/harness/aliases.js';
import {
  ALL_CANDIDATES,
  type CandidateName,
} from '../benchmark/datasets/compaction-prompt/candidates.js';
import {
  COMPACTION_FIXTURES,
  type CompactionFixture,
  type KeyFact,
} from '../benchmark/datasets/compaction-prompt/fixtures.js';

// Mirrors @kodax-ai/agent/src/compaction/summary-generator.ts
// SUMMARIZATION_SYSTEM_PROMPT (module-private). Copying is intentional —
// the eval holds the system prompt fixed across candidates so only the
// user prompt varies. If session-lineage's system prompt is ever changed,
// re-sync this constant manually.
const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization specialist.

CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.
Tool calls will be REJECTED and waste your only turn.

Your response must contain two parts:
1. <analysis> — your scratchpad for walking through messages (will be stripped)
2. <summary> — the structured continuation summary

Do not continue the conversation. Do not answer any user requests.`;

const GATE_ENV = 'KODAX_EVAL_COMPACTION_PROMPT';
const isGateOpen = process.env[GATE_ENV] === '1';

const TIMEOUT_MS = 60_000;

const PREFERRED_ALIASES: readonly ModelAlias[] = [
  'zhipu/glm51',
  'mmx/m27',
  'kimi',
  'ds/v4flash',
  'ds/v4pro',
];

interface CellResult {
  readonly fixtureId: string;
  readonly fixtureDomain: string;
  readonly candidate: CandidateName;
  readonly alias: ModelAlias;
  readonly summary: string;
  readonly schemaValid: boolean;
  readonly schemaMissingHeadings: readonly string[];
  readonly recallTotal: number;
  readonly recallHit: number;
  readonly missedFacts: readonly string[];
  readonly outputTokens: number;
  readonly latencyMs: number;
  readonly stopReason: string;
  readonly error?: string;
}

const REQUIRED_HEADINGS = [
  '## Goal',
  '## Constraints & Preferences',
  '## Progress',
  '### Completed',
  '### In Progress',
  '### Blockers',
  '## Key Decisions',
  '## Next Steps',
  '## Key Context',
  '<read-files>',
  '</read-files>',
  '<modified-files>',
  '</modified-files>',
] as const;

function checkSchemaValidity(summary: string): {
  valid: boolean;
  missing: string[];
} {
  const missing: string[] = [];
  for (const heading of REQUIRED_HEADINGS) {
    if (!summary.includes(heading)) {
      missing.push(heading);
    }
  }
  return { valid: missing.length === 0, missing };
}

function stripAnalysis(text: string): string {
  let cleaned = text.replace(/<analysis>[\s\S]*?<\/analysis>/gi, '').trim();
  cleaned = cleaned.replace(/<\/?summary>/gi, '').trim();
  return cleaned;
}

function checkRecall(summary: string, keyFacts: readonly KeyFact[]): {
  hit: number;
  missed: string[];
} {
  const missed: string[] = [];
  let hit = 0;
  const lowerSummary = summary.toLowerCase();
  for (const fact of keyFacts) {
    const present = fact.mode === 'substring-ci'
      ? lowerSummary.includes(fact.text.toLowerCase())
      : summary.includes(fact.text);
    if (present) {
      hit++;
    } else {
      missed.push(fact.text);
    }
  }
  return { hit, missed };
}

function buildUserPrompt(fixture: CompactionFixture, summaryPrompt: string): string {
  // Mirrors buildCompactionPromptSnapshot's section assembly:
  // - conversation transcript (order 100)
  // - summary instructions (order 300)  ← varies per candidate
  // - file tracking (order 400)         ← empty in eval (no real tool calls)
  const transcript = fixture.transcript
    .map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
    .join('\n');
  return [
    `<conversation>\n${transcript}\n</conversation>`,
    summaryPrompt,
    [
      '---',
      'File tracking:',
      'Read files: None',
      'Modified files: None',
    ].join('\n'),
  ].join('\n\n');
}

async function runCell(
  alias: ModelAlias,
  candidateName: CandidateName,
  candidatePrompt: string,
  fixture: CompactionFixture,
): Promise<CellResult> {
  const target = resolveAlias(alias);
  const provider = getProvider(target.provider);
  const userPrompt = buildUserPrompt(fixture, candidatePrompt);

  const startedAt = Date.now();
  const result = await sideQuery({
    provider,
    model: target.model,
    system: SUMMARIZATION_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
    timeoutMs: TIMEOUT_MS,
    querySource: 'compaction-prompt-eval',
  });
  const latencyMs = Date.now() - startedAt;

  const cleaned = stripAnalysis(result.text);
  const schema = checkSchemaValidity(cleaned);
  const recall = checkRecall(cleaned, fixture.keyFacts);

  return {
    fixtureId: fixture.id,
    fixtureDomain: fixture.domain,
    candidate: candidateName,
    alias,
    summary: cleaned,
    schemaValid: schema.valid,
    schemaMissingHeadings: schema.missing,
    recallTotal: fixture.keyFacts.length,
    recallHit: recall.hit,
    missedFacts: recall.missed,
    outputTokens: result.usage.outputTokens,
    latencyMs,
    stopReason: result.stopReason,
    error: result.error?.message,
  };
}

interface CandidateAggregate {
  readonly candidate: CandidateName;
  readonly cells: number;
  readonly schemaValidPct: number;
  readonly recallPct: number;
  readonly codingRecallPct: number;
  readonly nonCodingRecallPct: number;
  readonly avgOutputTokens: number;
  readonly avgLatencyMs: number;
  readonly errors: number;
}

function aggregate(results: readonly CellResult[], candidate: CandidateName): CandidateAggregate {
  const cells = results.filter((r) => r.candidate === candidate);
  const codingCells = cells.filter((r) => r.fixtureDomain === 'coding');
  const nonCodingCells = cells.filter((r) => r.fixtureDomain !== 'coding');

  const totalRecall = (xs: readonly CellResult[]) =>
    xs.reduce((s, r) => s + r.recallHit, 0) /
    Math.max(1, xs.reduce((s, r) => s + r.recallTotal, 0));

  return {
    candidate,
    cells: cells.length,
    schemaValidPct: cells.filter((r) => r.schemaValid).length / Math.max(1, cells.length),
    recallPct: totalRecall(cells),
    codingRecallPct: totalRecall(codingCells),
    nonCodingRecallPct: totalRecall(nonCodingCells),
    avgOutputTokens:
      cells.reduce((s, r) => s + r.outputTokens, 0) / Math.max(1, cells.length),
    avgLatencyMs:
      cells.reduce((s, r) => s + r.latencyMs, 0) / Math.max(1, cells.length),
    errors: cells.filter((r) => r.error).length,
  };
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function printReport(results: readonly CellResult[]): void {
  console.log('\n=== Compaction Prompt Eval Report ===\n');

  console.log('Per-candidate aggregates:');
  console.log(
    'candidate                    cells  schema   recall  coding  non-cd  out-tok  lat-ms  err',
  );
  for (const candidate of ['baseline-coding', 'candidate-a-conservative', 'candidate-b-aggressive'] as const) {
    const agg = aggregate(results, candidate);
    console.log(
      `${candidate.padEnd(28)} ${String(agg.cells).padStart(5)}  ` +
        `${fmtPct(agg.schemaValidPct).padStart(6)}  ` +
        `${fmtPct(agg.recallPct).padStart(6)}  ` +
        `${fmtPct(agg.codingRecallPct).padStart(6)}  ` +
        `${fmtPct(agg.nonCodingRecallPct).padStart(6)}  ` +
        `${agg.avgOutputTokens.toFixed(0).padStart(7)}  ` +
        `${agg.avgLatencyMs.toFixed(0).padStart(6)}  ` +
        `${String(agg.errors).padStart(3)}`,
    );
  }

  // Per-fixture detail (any cell with schema-invalid or recall < 80%)
  const flagged = results.filter((r) => !r.schemaValid || r.recallHit / r.recallTotal < 0.8 || r.error);
  if (flagged.length > 0) {
    console.log('\nFlagged cells (schema-invalid OR recall<80% OR error):');
    for (const r of flagged) {
      console.log(
        `  [${r.candidate}] ${r.alias} ${r.fixtureId} ` +
          `recall=${r.recallHit}/${r.recallTotal} ` +
          `schema=${r.schemaValid ? 'ok' : `MISSING:${r.schemaMissingHeadings.join(',')}`} ` +
          `${r.error ? `err=${r.error}` : ''}`,
      );
      if (r.missedFacts.length > 0 && r.missedFacts.length <= 5) {
        console.log(`    missed: ${r.missedFacts.join(' | ')}`);
      }
    }
  }
}

interface Cell {
  readonly candidateName: CandidateName;
  readonly summaryPrompt: string;
  readonly fixture: CompactionFixture;
  readonly alias: ModelAlias;
}

async function runWithConcurrency(
  cells: readonly Cell[],
  limit: number,
): Promise<CellResult[]> {
  const results: CellResult[] = [];
  let cursor = 0;
  async function worker(workerId: number): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= cells.length) return;
      const c = cells[idx];
      try {
        const cell = await runCell(c.alias, c.candidateName, c.summaryPrompt, c.fixture);
        results.push(cell);
        // eslint-disable-next-line no-console
        console.log(
          `[eval] [${idx + 1}/${cells.length}] w${workerId} ` +
            `${c.candidateName} × ${c.fixture.id} × ${c.alias} ` +
            `recall=${cell.recallHit}/${cell.recallTotal} ` +
            `schema=${cell.schemaValid ? 'ok' : 'BAD'} ` +
            `lat=${cell.latencyMs}ms tok=${cell.outputTokens}` +
            (cell.error ? ` ERR=${cell.error}` : ''),
        );
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          `[eval] [${idx + 1}/${cells.length}] w${workerId} ` +
            `${c.candidateName} × ${c.fixture.id} × ${c.alias} THROWN: ${(err as Error).message}`,
        );
      }
    }
  }
  await Promise.all(Array.from({ length: limit }, (_, i) => worker(i)));
  return results;
}

describe('Compaction prompt eval — neutral candidate selection', () => {
  if (!isGateOpen) {
    it(`skips: set ${GATE_ENV}=1 to run`, () => {
      expect(true).toBe(true);
    });
    return;
  }

  const aliases = availableAliases(...PREFERRED_ALIASES);
  if (aliases.length === 0) {
    it.skip('no available API keys for preferred aliases', () => {});
    return;
  }

  // 3 candidates × 10 fixtures × N aliases. With aliases.length=5, that's
  // 150 cells. Each cell ≈ 1500 input + 400 output tokens.
  const cells: Cell[] = [];
  for (const candidate of ALL_CANDIDATES) {
    for (const fixture of COMPACTION_FIXTURES) {
      for (const alias of aliases) {
        cells.push({
          candidateName: candidate.name,
          summaryPrompt: candidate.summaryPrompt,
          fixture,
          alias,
        });
      }
    }
  }

  // One concurrent worker per alias so we never have two in-flight
  // requests to the same provider — that avoids artificial rate-limit
  // self-induced retries while keeping the wall-clock low.
  const CONCURRENCY = aliases.length;

  it(
    `runs ${cells.length} cells (concurrency=${CONCURRENCY}) and reports per-candidate aggregates`,
    async () => {
      const startedAt = Date.now();
      // eslint-disable-next-line no-console
      console.log(
        `[eval] starting ${cells.length} cells with concurrency=${CONCURRENCY}, aliases=${aliases.join(',')}`,
      );
      const results = await runWithConcurrency(cells, CONCURRENCY);
      // eslint-disable-next-line no-console
      console.log(
        `[eval] completed ${results.length}/${cells.length} cells in ${(Date.now() - startedAt) / 1000}s`,
      );
      printReport(results);
      // Soft assert — we never fail the test on recall/schema, the report
      // is the verdict. Only fail if every cell errored.
      expect(results.length).toBeGreaterThan(0);
    },
    // Worst case: 150 cells / 5 aliases × 60s timeout = 1800s. Pad to 2400s.
    2_400_000,
  );
});
