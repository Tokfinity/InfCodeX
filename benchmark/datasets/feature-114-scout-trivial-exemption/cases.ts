/**
 * Dataset — FEATURE_114 v0.7.36 Slice 8b: Scout TRIVIAL-EXEMPTION boundary
 * (V1 prompt regression probe).
 *
 * Slice 8a (commit 1ce8ebb) pinned the existing wording with unit tests at
 * the role-prompt source level (Layer 1, mechanical). Slice 8b is the
 * Layer 2 behavioural counterpart: does the EMIT TIMING + TRIVIAL-EXEMPTION
 * wording actually drive Scout's tool choice in cross-family LLM probes?
 *
 * The TRIVIAL-EXEMPTION rule reads (verbatim from `role-prompt.ts:616-623`):
 *
 *   TRIVIAL-EXEMPTION (narrow, do not abuse): you may execute directly
 *   WITHOUT emit_scout_verdict ONLY for tasks with exactly ONE distinct
 *   execution step — a single typo fix, a single-line edit, a single-action
 *   lookup, a one-sentence answer. EVERYTHING ELSE — including review /
 *   audit / investigation tasks that touch ≥2 files, areas, or feature
 *   threads, even when the harness ends up being H0_DIRECT — MUST
 *   emit_scout_verdict EARLY with executionObligations populated.
 *
 * Three cases probe both sides of that boundary:
 *
 *   1. **single_step_lookup_no_emit** (negative)
 *      Single-action lookup ("paste line N of file F"). One distinct step.
 *      Expect: NO `emit_scout_verdict` in the LLM's first move.
 *
 *   2. **two_file_investigation_emits** (positive)
 *      Investigation that necessarily touches ≥2 files ("compare how
 *      function X is implemented across packages/foo and packages/bar").
 *      Expect: `emit_scout_verdict` with `executionObligations` populated
 *      (at least 2 entries, mirroring the 2 files / 2 distinct compare
 *      steps).
 *
 *   3. **explain_how_x_works_emits** (positive)
 *      Cross-file explanation ("explain how cache invalidation works in
 *      this repo"). Requires reading multiple files even though no
 *      mutation is performed. Per the rule's "review / investigation
 *      tasks that touch ≥2 files" clause: MUST emit_scout_verdict.
 *      Expect: `emit_scout_verdict` with `executionObligations` populated.
 *
 * **Pre-registered SHIP/PARTIAL/REJECT decision matrix** (set BEFORE any
 * LLM call, per EVAL_GUIDELINES §5):
 *
 *   - SHIP:    ≥3 of 4 aliases hit ≥80% on EACH positive case
 *              AND ≤20% on the negative case
 *              → Slice 8a wording is final, no Scout-side regression
 *   - PARTIAL: 1-2 aliases ≥80% positive, others <80% but trending OK
 *              → log behaviour in test guide; do not change wording
 *                without a fresh re-eval (anti-pattern 5: blind retry)
 *   - REJECT:  0 aliases ≥80% positive, OR negative case >40% on any alias
 *              → wording is broken — open a separate prompt-iteration
 *                slice (NOT in v0.7.38 scope)
 *
 * **EVAL_GUIDELINES compliance** (post-FEATURE_151 hardening):
 *   - n=5 runs/cell (anti-pattern 4)
 *   - Raw output dump to `os.tmpdir()/kodax-eval-dumps/feature-114-scout-trivial-exemption/`
 *     (anti-pattern 7; per-case JSON for offline LLM-judge audit)
 *   - Negative case carries dual judges (regex + LLM-judge audit advisory
 *     in driver doc-comment) — the FEATURE_151 Slice I real-case false
 *     negative on kimi happened on the same shape of judge
 *   - Pre-registered decision matrix (this doc-comment)
 *   - Layer 1 drift guard in `cases.test.ts` greps the runtime
 *     `role-prompt.ts` for the same anchor strings so any rename of
 *     TRIVIAL-EXEMPTION / EMIT TIMING / emit_scout_verdict fails Layer 1
 *     before the snapshot can silently desync.
 */

import type { PromptVariant } from '../../harness/harness.js';
import type { PromptJudge } from '../../harness/judges.js';

export type CaseId =
  | 'single_step_lookup_no_emit'
  | 'two_file_investigation_emits'
  | 'explain_how_x_works_emits';

export interface CaseSpec {
  readonly id: CaseId;
  readonly description: string;
  readonly behaviour: string;
  /** True when the LLM should emit emit_scout_verdict in its first move. */
  readonly expectEmit: boolean;
  /** Minimum executionObligations entries for positive cases. Ignored otherwise. */
  readonly minObligations?: number;
}

export const CASES: readonly CaseSpec[] = [
  {
    id: 'single_step_lookup_no_emit',
    description:
      'Single-action lookup ("what does line 42 say"). Exactly ONE ' +
      'distinct execution step. Per TRIVIAL-EXEMPTION: NO emit_scout_verdict.',
    behaviour:
      'output does NOT mention emit_scout_verdict; goes straight to read or grep',
    expectEmit: false,
  },
  {
    id: 'two_file_investigation_emits',
    description:
      'Compare-across-2-files investigation. Two distinct execution steps ' +
      '(read package/foo, read packages/bar, compare). Per TRIVIAL-EXEMPTION ' +
      'investigation clause: MUST emit_scout_verdict EARLY with ' +
      'executionObligations populated.',
    behaviour:
      'output mentions emit_scout_verdict AND executionObligations with ≥2 entries',
    expectEmit: true,
    minObligations: 2,
  },
  {
    id: 'explain_how_x_works_emits',
    description:
      'Cross-file explanation request. Investigation that touches ≥2 files ' +
      'even though no mutation is performed. Per TRIVIAL-EXEMPTION ' +
      'review/investigation clause: MUST emit_scout_verdict EARLY.',
    behaviour:
      'output mentions emit_scout_verdict AND executionObligations with ≥2 entries',
    expectEmit: true,
    minObligations: 2,
  },
] as const;

// ---------------------------------------------------------------------------
// Variants — every case ships exactly one variant ("v0.7.38"). The system
// prompt is a controlled snapshot of the V1 Scout role-prompt segments
// relevant to TRIVIAL-EXEMPTION + EMIT TIMING + EXECUTION OBLIGATIONS.
// ---------------------------------------------------------------------------

/**
 * Replicated essence of the Scout role-prompt sections relevant to
 * TRIVIAL-EXEMPTION boundary behaviour. Source of truth lives in
 * `packages/coding/src/task-engine/_internal/managed-task/role-prompt.ts`;
 * this is a controlled snapshot keyed to v0.7.36/v0.7.34 wording (the
 * EMIT TIMING + TRIVIAL-EXEMPTION + EXECUTION OBLIGATIONS sections that
 * Slice 8a pinned). Per EVAL_GUIDELINES §"controlled input": the LLM
 * input is the exact bytes the model sees, not a re-derivation through
 * `runKodaX`. Drift guard in `cases.test.ts` pins the anchor strings
 * against the runtime source.
 */
const SCOUT_PROMPT_TRIVIAL_EXEMPTION_SECTIONS = [
  'You are the Scout — KodaX V1 routing role. Your job is to investigate,',
  'pick the right harness (H0_DIRECT / H1_EXECUTE_EVAL / H2_PLAN_EXECUTE_EVAL),',
  'and either execute (H0) or escalate (H1/H2) via emit_scout_verdict.',
  '',
  'QUALITY FRAMEWORK — Think of yourself as a senior engineer who just received this task.',
  '',
  'You have the full default tool set: read / grep / glob / dispatch_child_task(read-only) / emit_scout_verdict.',
  '',
  'H0 — Bounded mutation OR pure answer. ≤1 file ≤30 lines mutation, OR no file',
  '  mutation at all (lookup / review / answer / git commit / config change / one-off',
  '  scratch file / straightforward typo).',
  '  → For mutation tasks within this bound, complete directly. For non-mutation tasks',
  '    (lookup / review / answer), no emit needed when the trivial-exemption applies.',
  '',
  'H1 — Multi-file change in known territory: bug fix across modules, refactor of familiar',
  '  code, security/perf fix. ≥2 files OR >30 lines mutation in 1 file.',
  '  → Call emit_scout_verdict with confirmed_harness="H1_EXECUTE_EVAL" to escalate.',
  '',
  'H2 — New code without existing anchor: project from scratch, cross-module refactor,',
  '  new feature, system design, database migration.',
  '  → Call emit_scout_verdict with confirmed_harness="H2_PLAN_EXECUTE_EVAL" to escalate.',
  '',
  'EXECUTION OBLIGATIONS:',
  '  For any task that requires ≥ 2 distinct execution steps (whether at H0_DIRECT,',
  '  H1_EXECUTE_EVAL, or H2_PLAN_EXECUTE_EVAL), populate executionObligations with',
  '  one entry per step BEFORE calling emit_scout_verdict.',
  '',
  '  Examples of "distinct execution steps" (DO list separately):',
  '    - Editing files in different modules',
  '    - Refactor + verification (e.g. rename + run tests)',
  '    - Multiple changes to the same file when each is independent',
  '',
  '  Examples of NOT distinct steps (do NOT split into multiple obligations):',
  '    - Reading a file before editing it (preparation, not a step)',
  '    - "Think about X" or "analyze Y" (reasoning, not a step)',
  '    - Single-token typo fixes (single action, no plan needed)',
  '',
  'EMIT TIMING (CRITICAL — read this carefully):',
  '  emit_scout_verdict is your PLAN COMMITMENT, not a final report. Call it',
  '  EARLY — within the first 1-2 scoping turns (read/grep/glob), BEFORE the',
  '  main implementation or investigation work. executionObligations describes',
  '  what you PLAN TO DO next, NOT what you have already done.',
  '',
  '  TRIVIAL-EXEMPTION (narrow, do not abuse): you may execute directly',
  '  WITHOUT emit_scout_verdict ONLY for tasks with exactly ONE distinct',
  '  execution step — a single typo fix, a single-line edit, a single-action',
  '  lookup, a one-sentence answer. EVERYTHING ELSE — including review /',
  '  audit / investigation tasks that touch ≥2 files, areas, or feature',
  '  threads, even when the harness ends up being H0_DIRECT — MUST',
  '  emit_scout_verdict EARLY with executionObligations populated, THEN',
  '  continue as the H0 executor and call todo_update at each step transition.',
].join('\n');

const TOOL_DOCS_BLURB = [
  '## Available Tools',
  '',
  '`emit_scout_verdict`:',
  '  Input:  { confirmed_harness:"H0_DIRECT"|"H1_EXECUTE_EVAL"|"H2_PLAN_EXECUTE_EVAL",',
  '            summary:string,',
  '            scope:string[],',
  '            review_files_or_areas:string[],',
  '            executionObligations:string[] }',
  '  Output: confirms the routing decision and seeds the realtime plan list.',
  '',
  '`read` / `grep` / `glob`:',
  '  Standard read-only file inspection tools.',
].join('\n');

const SYSTEM_PROMPT = [
  SCOUT_PROMPT_TRIVIAL_EXEMPTION_SECTIONS,
  '',
  TOOL_DOCS_BLURB,
].join('\n');

function buildSingleStepLookupVariant(): PromptVariant {
  return {
    id: 'v0.7.38',
    description:
      'Single-line lookup, one distinct step → expect NO emit_scout_verdict',
    systemPrompt: SYSTEM_PROMPT,
    userMessage:
      'What does line 42 of `packages/core/src/timeout.ts` say? Just the ' +
      'one line is fine.',
  };
}

function buildTwoFileInvestigationVariant(): PromptVariant {
  return {
    id: 'v0.7.38',
    description:
      'Compare-across-2-files investigation, expect emit_scout_verdict with ≥2 obligations',
    systemPrompt: SYSTEM_PROMPT,
    userMessage:
      'Compare how the `withTimeout` helper is implemented in ' +
      '`packages/core/src/timeout.ts` versus the version in ' +
      '`packages/agent/src/utils/timeout.ts`. List the differences in ' +
      'behavior — error handling, default timeout, cancellation. ' +
      'Plan first, then read.',
  };
}

function buildExplainHowXWorksVariant(): PromptVariant {
  return {
    id: 'v0.7.38',
    description:
      'Cross-file explanation, expect emit_scout_verdict with ≥2 obligations',
    systemPrompt: SYSTEM_PROMPT,
    userMessage:
      'Explain how the cache invalidation flow works in this repo. I ' +
      'want a step-by-step walkthrough — which file emits the invalidation ' +
      'event, which file consumes it, and what the propagation looks like. ' +
      'You will need to inspect multiple files to answer this fully.',
  };
}

function buildVariantForCase(caseId: CaseId): PromptVariant {
  switch (caseId) {
    case 'single_step_lookup_no_emit':
      return buildSingleStepLookupVariant();
    case 'two_file_investigation_emits':
      return buildTwoFileInvestigationVariant();
    case 'explain_how_x_works_emits':
      return buildExplainHowXWorksVariant();
  }
}

export function buildPromptVariants(caseId: CaseId): readonly PromptVariant[] {
  return [buildVariantForCase(caseId)];
}

// ---------------------------------------------------------------------------
// Judges — deterministic regex over LLM output text. Negative case leans on
// LLM-judge audit at the driver layer (anti-pattern 7) since "does NOT
// mention X" is the high-false-negative-risk shape — see FEATURE_151 Slice I
// kimi false-negative incident logged in EVAL_GUIDELINES §168.
// ---------------------------------------------------------------------------

const EMIT_VERDICT_PATTERN = /emit_scout_verdict/i;
const OBLIGATIONS_PATTERN = /executionObligations/i;

function judgesExpectNoEmit(): readonly PromptJudge[] {
  return [
    {
      name: 'does_not_call_emit_scout_verdict',
      category: 'correctness',
      judge: (out) =>
        EMIT_VERDICT_PATTERN.test(out)
          ? {
              passed: false,
              reason:
                'output references emit_scout_verdict on a single-step lookup task',
            }
          : { passed: true },
    },
  ];
}

function judgesExpectEmit(minObligations: number): readonly PromptJudge[] {
  return [
    {
      name: 'mentions_emit_scout_verdict',
      category: 'correctness',
      judge: (out) =>
        EMIT_VERDICT_PATTERN.test(out)
          ? { passed: true }
          : {
              passed: false,
              reason:
                'multi-file investigation but output does not mention emit_scout_verdict',
            },
    },
    {
      name: `mentions_executionObligations_with_${minObligations}_entries`,
      category: 'correctness',
      judge: (out) => {
        if (!OBLIGATIONS_PATTERN.test(out)) {
          return {
            passed: false,
            reason: 'output does not mention executionObligations',
          };
        }
        // Heuristic: count quoted string entries that look like obligation
        // items in the obligations region. We slice the string after the
        // first executionObligations match and count `"..."` or `'...'`
        // tokens until closing `]`. Loose but cheap; the LLM-judge audit
        // covers structural disagreement.
        const lower = out.toLowerCase();
        const idx = lower.indexOf('executionobligations');
        if (idx < 0) {
          return {
            passed: false,
            reason: 'executionObligations not found in output',
          };
        }
        const tail = out.slice(idx);
        const closeIdx = tail.indexOf(']');
        const region = closeIdx >= 0 ? tail.slice(0, closeIdx) : tail;
        const stringMatches = region.match(/"[^"\n]{6,}"|'[^'\n]{6,}'/g);
        const count = stringMatches ? stringMatches.length : 0;
        if (count >= minObligations) return { passed: true };
        return {
          passed: false,
          reason: `expected ≥${minObligations} obligation entries, found ${count} in obligations region`,
        };
      },
    },
  ];
}

export function buildJudges(caseId: CaseId): readonly PromptJudge[] {
  switch (caseId) {
    case 'single_step_lookup_no_emit':
      return judgesExpectNoEmit();
    case 'two_file_investigation_emits':
      return judgesExpectEmit(2);
    case 'explain_how_x_works_emits':
      return judgesExpectEmit(2);
  }
}
