/**
 * Eval: FEATURE_121 v0.7.40 — blob summarizer ground-truth token retention.
 *
 * ## Purpose
 *
 * Verifies the LLM-driven last-resort lossy summarizer in
 * `packages/coding/src/tools/blob-summarizer.ts` produces summaries
 * that preserve ground-truth tokens (file paths, line numbers, error
 * codes, distinctive findings) at ≥70% retention across the panel of
 * production coding-plan models.
 *
 * The summarizer is a **last-resort fallback**: it fires ONLY when
 *   (a) child-task output spilled-failed to disk (ENOSPC / EACCES / EROFS / etc.)
 *   AND
 *   (b) the raw content exceeds `LARGE_CONTENT_THRESHOLD_BYTES` (100 KB).
 * Without this fallback, the data-loss-guard inlines the full payload
 * into the Worker LLM context — which can blow past the context window
 * and corrupt the run. The summarizer compresses to the 2-8 KB band
 * while keeping decision-relevant tokens.
 *
 * Two cases, both POSITIVE retention assertions:
 *
 *   1. audit_report   — ~30 KB verbose prose with 14 ground-truth tokens
 *                       (file paths, line markers, identifiers, findings)
 *   2. grep_findings  — ~30 KB grep output with 18 ground-truth tokens
 *                       (file:line pairs, error codes, identifiers)
 *
 * Per EVAL_GUIDELINES anti-pattern 7: judges are POSITIVE
 * `output.includes(token)` checks — anti-pattern 7's false-negative
 * surface (negative regex on chain-of-thought "I should NOT...") does
 * not apply because we want the model to LITERALLY repeat the token
 * substrings. A literal `includes` is the right primitive.
 *
 * Also includes a structural `no_preamble_or_fence` judge that catches
 * the most common instruction-following failure (wrapping output in
 * ```fences```). The structural check is anchored to position 0 (no
 * `m` flag) so mid-output mentions of fences in chain-of-thought are
 * not false-positives.
 *
 * ## Run model — Layer 2 (single-turn probe, multi-alias)
 *
 * Each run is ONE provider.stream() call — NOT a multi-step agent
 * loop. Topology: 4 alias × 2 case × 3 runs = 24 LLM calls (~$1.2-2.4).
 *
 * **Pre-registered decision matrix** (set BEFORE any LLM call):
 *
 *   - SHIP:    ≥3 of 4 aliases hit ≥70% retention on EACH case
 *              → ship blob summarizer in v0.7.40 as designed
 *   - PARTIAL: 1-2 aliases ≥70% on each case, rest ≥50%
 *              → ship anyway; document model-specific retention floor
 *              in the test guide. The alternative (raw 100 KB inline)
 *              is strictly worse — over-budget AND structurally unreadable
 *   - REJECT:  0 aliases ≥70% on either case
 *              → do not ship LLM fallback in v0.7.40; revert to inline-
 *              over-budget for the residual <0.1% double-failure path
 *
 * No hard `expect.fail` in this commit — eval records numbers per case
 * for inspection. Decision is taken by reading the printed pass-rate
 * matrix against the matrix above.
 *
 * ## Cost / value
 *
 *   Cost: ~$1.2-2.4 (24 calls × ~$0.05-0.10/call avg; input ~30 KB
 *         + output ~8 KB per call)
 *   Value: 1 ship-or-revert decision for the LLM summarizer fallback
 *         path. Well under EVAL_GUIDELINES "$5 实验换一条 production
 *         prompt 改动: 值" threshold.
 *
 * ## Gating
 *
 * Skipped by default — set `KODAX_EVAL_F121_SUMMARIZER=1` to enable.
 * This is a paid LLM-call eval; gating prevents accidental CI cost
 * and keeps `npm run test` cheap. Pattern matches sibling feature
 * evals (FEATURE_120 child-steering, FEATURE_151 fan-out).
 *
 * ## Run
 *
 *   KODAX_EVAL_F121_SUMMARIZER=1 npm run test:eval -- feature-121-blob-summarizer
 *
 * Skips per-alias when API key absent (FEATURE_104 standard pattern).
 *
 * ## See also
 *
 *   - benchmark/datasets/feature-121-blob-summarizer/cases.ts (data)
 *   - packages/coding/src/tools/blob-summarizer.ts (subject under test)
 *   - tests/feature-120-child-steering.eval.ts (sibling driver pattern)
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it } from 'vitest';

import { availableAliases } from '../benchmark/harness/aliases.js';
import { runBenchmark } from '../benchmark/harness/harness.js';
import {
  CASES,
  buildJudges,
  buildPromptVariants,
} from '../benchmark/datasets/feature-121-blob-summarizer/cases.js';

// Raw-output dump root — driver writes per-case JSON for offline LLM-
// judge cross-validation against the regex judges (EVAL_GUIDELINES
// §"Raw output preservation"). Lives under OS tmpdir so the dump is
// treated as a transient runtime artifact (OS reaps it) and cannot
// accidentally leak into the repo working tree.
const DUMP_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'feature-121-blob-summarizer');

const STAGE_LABEL = 'phase1-multialias-3run-with-dump';
const RUNS_PER_CELL = 3;

// 4-alias panel — same cross-family selection as feature-120-child-steering
// minus ark/glm51 (zhipu/glm51 already covers the glm-5.1 family). Drop to
// 4 because the summarizer prompt is small + uncontroversial; the variance
// signal we care about is RETENTION across diverse families, not sampling
// every alias variant within a family.
const PHASE1_ALIASES = [
  'zhipu/glm51',
  'kimi',
  'mmx/m27',
  'ds/v4pro',
] as const;

// EVAL_GUIDELINES gate: this is a paid eval. Gating prevents accidental
// CI cost. Operator opts in via env var, same convention as sibling
// feature evals.
const ENABLED = process.env.KODAX_EVAL_F121_SUMMARIZER === '1';

describe('Eval: FEATURE_121 blob-summarizer retention (v0.7.40)', () => {
  if (!ENABLED) {
    it('skips: KODAX_EVAL_F121_SUMMARIZER not set (paid LLM eval, opt-in)', () => {
      // No-op test makes the skip visible in vitest output.
    });
    return;
  }

  const aliases = availableAliases(...PHASE1_ALIASES);
  if (aliases.length === 0) {
    it('skips: no provider API keys in env for any Phase 1 alias', () => {
      // No-op test makes the skip visible in vitest output.
    });
    return;
  }

  for (const c of CASES) {
    it(
      `${c.id} — ${STAGE_LABEL}`,
      // 30-min cap: 4 alias × 3 runs × 150s/call worst case ≈ 30 min/case.
      // ~30 KB input + ~8 KB output is heavier than other eval cases —
      // some Chinese coding-plan providers can take 60-120s for output of
      // this size on busy days.
      { timeout: 30 * 60_000 },
      async () => {
        const variants = buildPromptVariants(c.id);
        const judges = buildJudges(c.id);

        const result = await runBenchmark({
          variants,
          models: aliases,
          judges,
          runs: RUNS_PER_CELL,
        });

        // Print per-case + per-alias pass rates to test console without
        // hard-failing. Operator reads the matrix and matches against the
        // pre-registered SHIP/PARTIAL/REJECT decision matrix in the file
        // header above.
        const lines: string[] = [];
        lines.push(`[feature-121-blob-summarizer][${c.id}]`);
        lines.push(`  retentionThreshold: ${(c.retentionThreshold * 100).toFixed(0)}%`);
        lines.push(`  groundTruthTokens:  ${c.groundTruthTokens.length}`);
        lines.push(`  behaviour:          ${c.behaviour}`);
        const cells = result.byVariant['v0.7.40'] ?? [];
        let totalRuns = 0;
        let totalPassed = 0;
        for (const cell of cells) {
          let cellPassed = 0;
          const failureCount: Record<string, number> = {};
          for (const run of cell.runsRaw) {
            totalRuns++;
            if (run.passed) {
              totalPassed++;
              cellPassed++;
            } else {
              for (const j of run.judges) {
                if (!j.passed) {
                  failureCount[j.name] = (failureCount[j.name] ?? 0) + 1;
                }
              }
            }
          }
          const cellTotal = cell.runsRaw.length;
          const cellRate =
            cellTotal > 0 ? ((cellPassed / cellTotal) * 100).toFixed(0) : 'n/a';
          const failureSummary = Object.entries(failureCount)
            .map(([name, n]) => `${name}×${n}`)
            .join(',');
          lines.push(
            `  ${cell.alias.padEnd(13)} ${cellPassed}/${cellTotal} (${cellRate}%)` +
              (failureSummary ? `  (failed: ${failureSummary})` : ''),
          );
        }
        const overallRate =
          totalRuns > 0 ? ((totalPassed / totalRuns) * 100).toFixed(1) : 'n/a';
        lines.push(`  overall: ${totalPassed}/${totalRuns} (${overallRate}%)`);
        // eslint-disable-next-line no-console
        console.log(lines.join('\n'));

        // Dump raw outputs for LLM-as-judge cross-validation.
        // EVAL_GUIDELINES §"Raw output preservation" mandates this for
        // any regex-judge'd eval that drives a ship decision — operator
        // MUST be able to spot-check whether the regex pass/fail
        // reflects actual model behaviour.
        mkdirSync(DUMP_ROOT, { recursive: true });
        const variant = variants[0];
        const dump = {
          case: c.id,
          stage: STAGE_LABEL,
          retentionThreshold: c.retentionThreshold,
          groundTruthTokenCount: c.groundTruthTokens.length,
          behaviour: c.behaviour,
          // Trim the prompt to avoid bloating the dump with ~30 KB of
          // input content per case. The systemPrompt / first 500 chars
          // of userMessage are enough for an offline judge to recognize
          // which prompt the model received; full content can be
          // re-derived deterministically via `buildContentForCase` on
          // demand.
          systemPrompt: variant?.systemPrompt ?? '',
          userMessagePreview:
            (variant?.userMessage ?? '').slice(0, 500) +
            (variant && variant.userMessage.length > 500 ? '\n…[truncated]' : ''),
          userMessageLength: variant?.userMessage.length ?? 0,
          aliases: cells.map((cell) => ({
            alias: cell.alias,
            passRate: cell.passRate,
            runs: cell.runsRaw.map((run) => ({
              runIndex: run.runIndex,
              text: run.text,
              outputLength: run.text.length,
              toolCalls: run.toolCalls,
              durationMs: run.durationMs,
              error: run.error,
              regexPassed: run.passed,
              regexJudges: run.judges.map((j) => ({
                name: j.name,
                passed: j.passed,
                reason: j.reason,
              })),
            })),
          })),
        };
        const dumpPath = join(DUMP_ROOT, `${c.id}.json`);
        writeFileSync(dumpPath, JSON.stringify(dump, null, 2), 'utf8');
        // eslint-disable-next-line no-console
        console.log(`  raw-output dump: ${dumpPath}`);
      },
    );
  }
});
