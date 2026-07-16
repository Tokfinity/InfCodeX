/**
 * Dataset — FEATURE_121 v0.7.40 blob-summarizer Layer 2 eval cases.
 *
 * Verifies the LLM-driven last-resort lossy summarizer added in
 * `packages/coding/src/tools/blob-summarizer.ts` (v0.7.40 follow-up).
 * The summarizer fires only when child-task output spilled-failed AND
 * exceeds `LARGE_CONTENT_THRESHOLD_BYTES` (100 KB) — at that point
 * inlining the raw content would blow past the Worker context window,
 * so the summarizer compresses to ~2-8 KB while preserving ground-
 * truth tokens (file paths, line numbers, error codes, identifiers).
 *
 * The Layer 2 eval pins the production prompt text
 * (`SUMMARIZER_SYSTEM_PROMPT` + `buildSummarizerUserMessage`) and
 * measures **ground-truth token retention** on synthetic content
 * specifically designed to embed verbatim audit findings, file paths,
 * line numbers, and error codes. A faithful summarizer must keep
 * ≥70% of those tokens in the output band.
 *
 * Two cases, both POSITIVE retention assertions:
 *
 *   1. **audit_report** — ~30 KB verbose security-audit prose embedding
 *      14 ground-truth tokens (4 file paths, 4 line markers,
 *      3 identifiers, 3 finding strings). Tests retention against
 *      narrative content where a model is tempted to abstract away
 *      specifics into prose summary.
 *
 *   2. **grep_findings** — ~30 KB grep-style output with 18+ file:line
 *      hits and 4 error-code references. Tests retention against
 *      tabular content where a model is tempted to collapse list
 *      structure into "N findings in 5 modules" style abstractions.
 *
 * Per EVAL_GUIDELINES anti-pattern 7: both judges are POSITIVE
 * inclusion checks (regex `output.includes(token)`), NOT negative
 * "must-not-mention" assertions. Anti-pattern 7's false-negative
 * surface (verbose models writing "I should NOT...") does not apply
 * — we want the summarizer to literally repeat the ground-truth
 * strings, so a literal `includes` check is the right primitive.
 *
 * **Design source**: in-conversation discussion with user
 * (2026-05-13) about LLM-based fallback when both spill AND inline
 * are unsafe; specifically the user's pushback on heuristic head/tail
 * fallback ("不用 llm直接处理文本一定会影响语义") and the choice of
 * Option C (callback injection) + worker-same model.
 *
 * Stage-1 acceptance per EVAL_GUIDELINES §"pre-registered decision
 * matrix" (set BEFORE any LLM call):
 *
 *   - SHIP:    ≥3 of 4 aliases hit ≥70% token retention on EACH case
 *              → ship blob summarizer in v0.7.40 as designed; the
 *                summarizer is a last-resort fallback (only fires on
 *                spill+inline-impossible double-failure), so a 70%
 *                retention bar reflects the floor of useful info
 *                survival under that already-degraded scenario
 *   - PARTIAL: 1-2 aliases ≥70% on each case, rest ≥50%
 *              → ship anyway, document model-specific retention floor
 *                in the test guide; the alternative (raw 100 KB inline)
 *                is strictly worse — over-budget AND structurally
 *                unreadable
 *   - REJECT:  0 aliases ≥70% on either case
 *              → do not ship the LLM fallback in v0.7.40; fall back
 *                to inline-over-budget for the residual <0.1%
 *                spill-failure path. Re-evaluate prompt design at
 *                v0.7.41
 *
 * **Why Layer 2 here, not Layer 1**: the summarizer is an LLM call.
 * No unit test can verify "the LLM faithfully preserves verbatim
 * tokens at the 70% level across 4 panel-internal alias families".
 * The unit tests in `blob-summarizer.test.ts` already lock down the
 * deterministic shell (timeout, abort, empty-text rejection, error
 * wrapping); retention is the LLM-bound property and needs probing.
 *
 * **Cost estimate**: 4 alias × 2 case × 3 runs = 24 calls. Each call
 * processes ~30 KB input + ~8 KB output → roughly $0.05-0.10 per call,
 * total ~$1.2-2.4. Well under EVAL_GUIDELINES "$5 实验换一条
 * production prompt 改动: 值" threshold; here the decision is "ship
 * a new fallback path that touches the data-loss-guard contract".
 */

import type { PromptVariant } from '../../harness/harness.js';
import type { PromptJudge } from '../../harness/judges.js';

import {
  DEFAULT_SUMMARY_MAX_CHARS,
  SUMMARIZER_SYSTEM_PROMPT,
  buildSummarizerUserMessage,
} from '../../../packages/coding/src/tools/blob-summarizer.js';

export type CaseId = 'audit_report' | 'grep_findings';

export interface CaseSpec {
  readonly id: CaseId;
  readonly description: string;
  readonly behaviour: string;
  /** Ground-truth tokens that MUST survive verbatim in the summary output. */
  readonly groundTruthTokens: readonly string[];
  /** Minimum fraction (0-1) of ground-truth tokens that must survive. */
  readonly retentionThreshold: number;
}

// ---------------------------------------------------------------------------
// Synthetic content builders.
//
// Each case is built deterministically (no Math.random) so the eval is
// reproducible — running twice produces the same content, the same
// ground-truth token set, and the same judge regexes. Only the LLM
// output varies across runs.
//
// Size target: ~30 KB. This is COMFORTABLY above the 100 KB threshold's
// "would-have-been-an-inline-failure" zone is not relevant for the eval
// — what matters is that there is enough content for an LLM to fall
// back to summarization vs verbatim copy. 30 KB × 4 ≈ 120 KB worth of
// repeat patterns lets us pad without inflating the actual ground-
// truth-token set we judge against.
// ---------------------------------------------------------------------------

const AUDIT_GROUND_TRUTH_TOKENS = [
  // File paths
  'packages/coding/src/tools/blob-summarizer.ts',
  'packages/coding/src/tools/tool-result-policy.ts',
  'packages/coding/src/tools/dispatch-child-tasks.ts',
  'packages/agent/src/runner.ts',
  // Line markers (must survive verbatim — judges use literal includes)
  ':142',
  ':203',
  ':318',
  ':456',
  // Identifiers
  'applyToolResultGuardrail',
  'BlobSummarizerError',
  'LARGE_CONTENT_THRESHOLD_BYTES',
  // Findings (short distinctive phrases)
  'TOCTOU race on permission check',
  'unbounded recursion on cyclic symlinks',
  'silent failure swallows ENOSPC',
] as const;

const GREP_GROUND_TRUTH_TOKENS = [
  // File:line pairs (the grep-output staple)
  'packages/coding/src/agents/worker-role-prompt.ts:88',
  'packages/coding/src/task-engine/runner-driven.ts:4705',
  'packages/coding/src/tools/blob-summarizer.ts:39',
  'packages/coding/src/tools/tool-result-policy.ts:178',
  'packages/agent/src/admit.ts:217',
  'packages/repl/src/components/Transcript.tsx:341',
  // Error codes
  'ENOENT',
  'EACCES',
  'EROFS',
  'ENOSPC',
  // Identifiers / symbol names
  'createBlobSummarizer',
  'persistToolOutput',
  // Distinctive log/match strings
  'spillFailed: true',
  'guarded.spillFailed',
] as const;

/** Build the audit-report style verbose-prose content embedding the ground-truth tokens. */
function buildAuditReportContent(): string {
  const sections: string[] = [];
  sections.push('# Security Audit Report — packages/coding');
  sections.push('');
  sections.push('## Executive Summary');
  sections.push('');
  sections.push(
    'This report covers a targeted audit of packages/coding for input validation, ' +
      'race conditions, error swallowing, and resource exhaustion. Three CRITICAL ' +
      'findings emerged. See the per-file sections below for line-level detail.',
  );
  sections.push('');

  // Finding 1 — TOCTOU race
  sections.push('## Finding 1: TOCTOU race on permission check (CRITICAL)');
  sections.push('');
  sections.push(
    'Location: packages/coding/src/tools/blob-summarizer.ts:142. The summarizer ' +
      'callback does a stat() check before opening the spill file, but the open() ' +
      'call happens in a later microtask. Between the two, an attacker holding ' +
      'write access to the tmp directory could symlink-swap the path. This is a ' +
      'classic TOCTOU race on permission check.',
  );
  sections.push('');
  sections.push(
    'Recommendation: drop the stat() preflight and rely on open() error semantics ' +
      'directly. The `applyToolResultGuardrail` function in ' +
      'packages/coding/src/tools/tool-result-policy.ts already follows this pattern correctly.',
  );
  sections.push('');

  // Finding 2 — unbounded recursion
  sections.push('## Finding 2: unbounded recursion on cyclic symlinks (HIGH)');
  sections.push('');
  sections.push(
    'Location: packages/coding/src/tools/dispatch-child-tasks.ts:203. The directory ' +
      "walker doesn't track visited inodes; a cyclic symlink causes unbounded " +
      'recursion that eventually OOMs the Worker. Triggered consistently by the ' +
      'fixture at tests/fixtures/cyclic-symlinks/. The walker should track a ' +
      'visited-inode Set.',
  );
  sections.push('');
  sections.push(
    'The LARGE_CONTENT_THRESHOLD_BYTES guard does not help here because the failure ' +
      'is wall-clock unbounded, not content-size unbounded — the walker never gets ' +
      'far enough to emit content. Distinct from FEATURE_121 spillover, this is a ' +
      'pre-content failure mode.',
  );
  sections.push('');

  // Finding 3 — ENOSPC swallowing
  sections.push('## Finding 3: silent failure swallows ENOSPC (MEDIUM)');
  sections.push('');
  sections.push(
    'Location: packages/agent/src/runner.ts:318. The Worker run loop catches all ' +
      'errors from spill-to-disk and proceeds with truncated output, silently ' +
      'swallowing ENOSPC and similar fatal filesystem errors. The operator gets no ' +
      'warning; the next run hits the same wall.',
  );
  sections.push('');
  sections.push(
    'Note: this is exactly the failure mode that the v0.7.40 spill-failure data-' +
      'loss guard addresses. The BlobSummarizerError fallback at runner.ts:456 ' +
      'now logs a console.warn that is NOT gated on KODAX_DEBUG_TOOL_GUARDRAILS, ' +
      'so disk failure surfaces immediately.',
  );
  sections.push('');

  // Padding section — verbose prose that the summarizer should compress.
  // We're testing that ground-truth tokens above survive while padding goes.
  sections.push('## Cross-cutting observations');
  sections.push('');
  for (let i = 0; i < 60; i++) {
    sections.push(
      `Observation ${i + 1}: routine code paths in the coding layer follow a ` +
        'consistent pattern of try-catch-log, which means a failure-mode pivot ' +
        'in one tool does not naturally surface in operator-facing logs. The ' +
        'logging discipline is correct in principle but could be tightened by ' +
        'standardizing on a single failure-classification helper. This is not ' +
        'a security finding per se — more an operational hygiene observation. ' +
        'No action required for v0.7.40; revisit when consolidating the ' +
        'observability surface area in a future release.',
    );
    sections.push('');
  }

  sections.push('## Conclusion');
  sections.push('');
  sections.push(
    'Three CRITICAL/HIGH findings actionable in v0.7.40. The TOCTOU at ' +
      'blob-summarizer.ts:142 is highest-priority. The walker fix at ' +
      'dispatch-child-tasks.ts:203 is straightforward. The ENOSPC swallowing at ' +
      'runner.ts:318 is already addressed by the v0.7.40 spill-failure guard.',
  );

  return sections.join('\n');
}

/** Build the grep-style findings content embedding the ground-truth tokens. */
function buildGrepFindingsContent(): string {
  const lines: string[] = [];
  lines.push('# grep results: { ENOENT | EACCES | EROFS | ENOSPC | spillFailed }');
  lines.push('# rg --type ts -nP "(ENOENT|EACCES|EROFS|ENOSPC|spillFailed)"');
  lines.push('');

  // The real findings — embed ground-truth file:line markers + error codes
  // + identifiers in grep-style output (path:line:content).
  const findings: ReadonlyArray<readonly [string, string]> = [
    [
      'packages/coding/src/agents/worker-role-prompt.ts:88',
      'when ENOENT or EACCES blocks the spill path, the Worker should treat it as fatal',
    ],
    [
      'packages/coding/src/task-engine/runner-driven.ts:4705',
      "summarizeBlob: (content) => createBlobSummarizer({ provider, model })(content)",
    ],
    [
      'packages/coding/src/tools/blob-summarizer.ts:39',
      'export const LARGE_CONTENT_THRESHOLD_BYTES = 100 * 1024;',
    ],
    [
      'packages/coding/src/tools/tool-result-policy.ts:178',
      'spillFailed: true — fallback inline; ENOSPC/EROFS treated identically',
    ],
    [
      'packages/agent/src/admit.ts:217',
      'if (err.code === "EACCES") { ... }',
    ],
    [
      'packages/repl/src/components/Transcript.tsx:341',
      'render banner when guarded.spillFailed is true',
    ],
    [
      'packages/coding/src/tools/blob-summarizer.ts:132',
      'export function createBlobSummarizer(opts: CreateBlobSummarizerOptions): SummarizeBlob {',
    ],
    [
      'packages/coding/src/tools/tool-result-policy.ts:191',
      'outputPath = await persistToolOutput(toolName, content, ctx);',
    ],
    [
      'packages/coding/src/tools/tool-result-policy.ts:194',
      'spillFailed = true; spillError = err;',
    ],
    [
      'packages/coding/src/tools/tool-result-policy.ts:225',
      "[ToolGuardrail] persistToolOutput failed for ${toolName}",
    ],
    [
      'packages/coding/src/tools/blob-summarizer.test.ts:42',
      'expect(err).toBeInstanceOf(BlobSummarizerError);',
    ],
    [
      'packages/coding/src/tools/dispatch-child-tasks.ts:262',
      'await applyChildSummaryGuardrailWithSummarizer(toolName, rawContent, ctx)',
    ],
    [
      'packages/coding/src/tools/dispatch-child-tasks.ts:348',
      'if (guarded.spillFailed && rawContent.length > LARGE_CONTENT_THRESHOLD_BYTES) { ... }',
    ],
    [
      'packages/coding/src/tools/dispatch-child-tasks.ts:365',
      "[SPILL FAILED — original compressed via LLM summarizer; raw content unavailable]",
    ],
    [
      'packages/agent/src/runner.ts:512',
      'on EROFS, retry once with a fresh persistToolOutput path then bail',
    ],
    [
      'packages/agent/src/runner.ts:534',
      'if (code === "ENOSPC") log fatal; no retry',
    ],
    [
      'packages/coding/src/tools/truncate.ts:88',
      'function persistToolOutput(toolName, content, ctx): Promise<string>',
    ],
    [
      'packages/coding/src/tools/truncate.ts:120',
      'throws ENOENT when KODAX_TOOL_OUTPUT_DIR points at non-existent directory',
    ],
  ];

  for (const [loc, content] of findings) {
    lines.push(`${loc}: ${content}`);
  }

  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(
    '# Padding context (consider compressed): the bulk of the grep output is the ' +
      'volume of unique match lines above. Below are repeat contextual lines that ' +
      'a faithful summarizer should compress while leaving the path:line: prefix ' +
      'of each finding above intact.',
  );
  lines.push('');

  // Padding — repeated contextual lines that don't add ground-truth tokens.
  for (let i = 0; i < 120; i++) {
    lines.push(
      `# context line ${i + 1}: routine error-handling reference following the ` +
        'spill-failure invariant established in v0.7.40; downstream caller branches ' +
        'on guarded.spillFailed to choose between inline and summarize paths; ' +
        'see the upstream guardrail wrapper for the exact treatment of each ' +
        'failure code and the resulting fallback chain selection logic.',
    );
  }

  lines.push('');
  lines.push('# total: 18 match lines across 6 modules; 4 distinct error codes referenced.');

  return lines.join('\n');
}

function buildContentForCase(caseId: CaseId): string {
  switch (caseId) {
    case 'audit_report':
      return buildAuditReportContent();
    case 'grep_findings':
      return buildGrepFindingsContent();
  }
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

export const CASES: readonly CaseSpec[] = [
  {
    id: 'audit_report',
    description:
      'Verbose security-audit prose (~30 KB) embedding 14 ground-truth tokens ' +
      '(4 file paths, 4 line markers, 3 identifiers, 3 distinctive finding ' +
      'strings). The summarizer must keep ≥70% of these tokens verbatim while ' +
      'compressing surrounding prose.',
    behaviour:
      'output contains ≥70% of AUDIT_GROUND_TRUTH_TOKENS as literal substrings',
    groundTruthTokens: AUDIT_GROUND_TRUTH_TOKENS,
    retentionThreshold: 0.7,
  },
  {
    id: 'grep_findings',
    description:
      'Grep-style output (~30 KB) with 18+ file:line hits plus 4 error codes ' +
      'and 4 identifier tokens. The summarizer must keep ≥70% of these tokens ' +
      'verbatim while compressing the contextual padding.',
    behaviour:
      'output contains ≥70% of GREP_GROUND_TRUTH_TOKENS as literal substrings',
    groundTruthTokens: GREP_GROUND_TRUTH_TOKENS,
    retentionThreshold: 0.7,
  },
] as const;

// ---------------------------------------------------------------------------
// Variants — single variant per case, locked to the EXACT production
// prompt constants. Importing `SUMMARIZER_SYSTEM_PROMPT` +
// `buildSummarizerUserMessage` from `blob-summarizer.ts` ensures the
// eval input is byte-for-byte identical to what the production
// summarizer feeds the LLM. If those constants change, the eval picks
// it up automatically — and per `blob-summarizer.ts` doc, re-running
// this eval is the gate on changing them.
// ---------------------------------------------------------------------------

function buildVariantForCase(caseId: CaseId): PromptVariant {
  const content = buildContentForCase(caseId);
  return {
    id: 'v0.7.40',
    description: `blob-summarizer prompt under test, case=${caseId}`,
    systemPrompt: SUMMARIZER_SYSTEM_PROMPT,
    userMessage: buildSummarizerUserMessage(content, DEFAULT_SUMMARY_MAX_CHARS),
  };
}

export function buildPromptVariants(caseId: CaseId): readonly PromptVariant[] {
  return [buildVariantForCase(caseId)];
}

// ---------------------------------------------------------------------------
// Judges — token-retention measurement.
//
// Two judges per case:
//   1. `retention_${case}` — fraction of ground-truth tokens that appear
//      as literal substrings in the output ≥ threshold.
//   2. `no_preamble_or_fence` — guards against the most common
//      instruction-following failure where a model wraps its answer in
//      ```markdown fences``` or prepends "Here is the summary:". The
//      production summarizer requires raw text only (per
//      SUMMARIZER_SYSTEM_PROMPT). A wrapped-fence reply is structurally
//      broken — the consumer pipes the output directly into the spill-
//      fallback banner without unwrapping.
//
// Per EVAL_GUIDELINES anti-pattern 7 §1: judge 2 is a NEGATIVE
// assertion ("must NOT start with a fence"). To stay clear of the
// false-negative cliff, we anchor the regex to the FIRST non-whitespace
// content of the output — verbose chain-of-thought "I should NOT use a
// fence" prose later in the output is fine because it doesn't match
// `^\s*```` `. The judge inspects structure, not semantics, which makes
// regex appropriate.
// ---------------------------------------------------------------------------

function countTokensRetained(
  output: string,
  tokens: readonly string[],
): { retained: number; missing: readonly string[] } {
  const missing: string[] = [];
  let retained = 0;
  for (const token of tokens) {
    if (output.includes(token)) {
      retained++;
    } else {
      missing.push(token);
    }
  }
  return { retained, missing };
}

function buildRetentionJudge(caseId: CaseId, spec: CaseSpec): PromptJudge {
  return {
    name: `retention_${caseId}`,
    category: 'correctness',
    judge: (out) => {
      const total = spec.groundTruthTokens.length;
      const { retained, missing } = countTokensRetained(out, spec.groundTruthTokens);
      const rate = total > 0 ? retained / total : 1;
      const ratePct = (rate * 100).toFixed(0);
      const thresholdPct = (spec.retentionThreshold * 100).toFixed(0);
      if (rate >= spec.retentionThreshold) {
        return { passed: true };
      }
      // Truncate missing list in the reason field — eval logs need to be
      // grep-able, not a wall of text. Full list is in the raw-output dump.
      const missingPreview = missing.slice(0, 5).join(', ');
      const more = missing.length > 5 ? ` (+${missing.length - 5} more)` : '';
      return {
        passed: false,
        reason: `${retained}/${total} (${ratePct}%) < threshold ${thresholdPct}%; missing: [${missingPreview}${more}]`,
      };
    },
  };
}

/** Regex matching outputs that START with a markdown code fence or
 * preamble like "Here is the summary:" / "Summary:". Anchored to
 * position 0 of the string (NO `m` flag) so a mid-output ```code fence
 * for an example, or a list item "2. Summary: ...", does not falsely
 * trigger. The `i` flag is kept for case-insensitive prose matching. */
const PREAMBLE_OR_FENCE_REGEX =
  /^\s*(```|---\s*$|here\s+is|summary\s*:|the\s+summary)/i;

function buildNoPreambleJudge(): PromptJudge {
  return {
    name: 'no_preamble_or_fence',
    category: 'format',
    judge: (out) => {
      const matched = PREAMBLE_OR_FENCE_REGEX.test(out);
      if (!matched) return { passed: true };
      const head = out.trimStart().slice(0, 60).replace(/\n/g, ' ');
      return {
        passed: false,
        reason: `output starts with preamble/fence: "${head}…"`,
      };
    },
  };
}

export function buildJudges(caseId: CaseId): readonly PromptJudge[] {
  const spec = CASES.find((c) => c.id === caseId);
  if (!spec) {
    throw new Error(`Unknown case id: ${caseId}`);
  }
  return [buildRetentionJudge(caseId, spec), buildNoPreambleJudge()];
}

// Re-exported for the hermetic shape test (`cases.test.ts`) so it can
// assert deterministic content size / token-set invariants without
// duplicating the builders.
export const __INTERNALS = Object.freeze({
  buildContentForCase,
  AUDIT_GROUND_TRUTH_TOKENS,
  GREP_GROUND_TRUTH_TOKENS,
  PREAMBLE_OR_FENCE_REGEX,
});
