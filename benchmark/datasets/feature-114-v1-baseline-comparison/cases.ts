/**
 * Dataset — FEATURE_114 V1 baseline comparison (Slice 7 decision input).
 *
 * Pre-Slice-7 question: when the V2 Worker shows 45% pass rate on the
 * "edit + build verify" multi-step task across 4 aliases (Slice 6
 * multi_step_no_fanout_seeds_plan, post-revert), is V1 Scout BETTER on
 * the same task — meaning V2 default-flag-flip would be a regression
 * for weak-model users — or is V1 SIMILAR — meaning V2 ship is a
 * neutral-or-positive change?
 *
 * Hypothesis: V1 Scout has the same instruction-recall ceiling on
 * weak models (Kimi, MMX); the failure pattern is model-side, not
 * V1-vs-V2 architecture-side.
 *
 * Design: SAME user message as Slice 6 multi_step_no_fanout_seeds_plan
 * ("add negative-timeout guard, then run build"). DIFFERENT system
 * prompt — V1 Scout sections instead of V2 Worker sections. Same 4
 * aliases (ds/v4pro, zhipu/glm51, kimi, mmx/m27) × 5 runs.
 *
 * V1 plan-list render path: TodoListSurface renders when
 *   emit_scout_verdict({executionObligations:[...≥2 entries]})
 * is called. So the eval judge mirrors Slice 8b's
 * `mentions_emit_scout_verdict` + `executionObligations ≥2` shape.
 *
 * V2 plan-list render path: TodoListSurface renders when
 *   todo_update({op:"init", items:[...≥2 entries]})
 * is called. (Slice 6's existing judges.)
 *
 * The two judges target STRUCTURALLY DIFFERENT but UX-EQUIVALENT
 * outputs — both are "did the model commit a plan list the user
 * would see during the 30-60s mid-task window?".
 *
 * **Pre-registered decision matrix**:
 *
 *   - V1 ≥ V2 by ≥10pp on overall pass rate → V2 is regression on
 *     weak models → keep flag default-OFF (Option B)
 *   - V1 ≈ V2 (within ±10pp) → V2 ship is neutral on plan visibility →
 *     flag flip OK (Option A)
 *   - V1 ≤ V2 by ≥10pp → V2 is improvement on weak models → flag flip
 *     definitely safe (Option A, strong)
 *
 * Topology: 1 case × 4 alias × 5 runs = 20 LLM calls ≈ $0.60.
 *
 * **EVAL_GUIDELINES compliance**:
 *   - n=5 runs/cell (anti-pattern 4)
 *   - Raw-output dump to `os.tmpdir()/kodax-eval-dumps/feature-114-v1-baseline-comparison/`
 *   - Pre-registered decision matrix (this doc-comment)
 *   - Layer 1 drift guard: `cases.test.ts` greps runtime role-prompt.ts
 *     for the V1 anchor strings (QUALITY FRAMEWORK / EMIT TIMING /
 *     emit_scout_verdict).
 */

import type { PromptVariant } from '../../harness/harness.js';
import type { PromptJudge } from '../../harness/judges.js';

export type CaseId = 'multi_step_v1_scout';

export interface CaseSpec {
  readonly id: CaseId;
  readonly description: string;
  readonly behaviour: string;
  readonly minObligations: number;
}

export const CASES: readonly CaseSpec[] = [
  {
    id: 'multi_step_v1_scout',
    description:
      'V1 Scout prompt + same multi-step user message as Slice 6 V2 ' +
      '"multi_step_no_fanout_seeds_plan". Tests whether V1 path on weak ' +
      'models produces a render-eligible plan more reliably than V2 path.',
    behaviour:
      'output mentions emit_scout_verdict (or confirmed_harness payload) AND executionObligations with ≥2 entries',
    minObligations: 2,
  },
] as const;

// ---------------------------------------------------------------------------
// V1 Scout prompt — controlled snapshot of the QUALITY FRAMEWORK + SCOPE
// COMMITMENT + EXECUTION OBLIGATIONS + EMIT TIMING + TRIVIAL-EXEMPTION
// sections from `packages/coding/src/task-engine/_internal/managed-task/
// role-prompt.ts`. Anchor strings pinned by `cases.test.ts` against the
// runtime source.
//
// Differences from Slice 8b's V1 Scout snapshot:
//   - Slice 8b included tool docs for `emit_scout_verdict`, `read`, `grep`
//   - This dataset includes `bash` (for build) so the model has the option
//     to express "run build" as a step in executionObligations.
// ---------------------------------------------------------------------------

const V1_SCOUT_SECTIONS = [
  'You are the Scout — KodaX V1 routing role. Your job is to investigate,',
  'pick the right harness (H0_DIRECT / H1_EXECUTE_EVAL / H2_PLAN_EXECUTE_EVAL),',
  'and either execute (H0) or escalate (H1/H2) via emit_scout_verdict.',
  '',
  'QUALITY FRAMEWORK — Think of yourself as a senior engineer who just received this task.',
  '',
  'You have the full default tool set: read / grep / glob / bash / write / edit /',
  'dispatch_child_task(read-only) / emit_scout_verdict.',
  '',
  'H0 — Bounded mutation OR pure answer. ≤1 file ≤30 lines mutation, OR no file',
  '  mutation at all (lookup / review / answer / git commit / config change / one-off',
  '  scratch file / straightforward typo).',
  '  → For mutation tasks within this bound, complete directly. For non-mutation tasks',
  '    (lookup / review / answer), no emit needed when trivial-exemption applies.',
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
  '  After emit_scout_verdict, when continuing as H0_DIRECT executor, call',
  '  todo_update at each transition (pending → in_progress → completed) so the',
  '  user sees real-time progress.',
  '',
  'EMIT TIMING (CRITICAL — read this carefully):',
  '  emit_scout_verdict is your PLAN COMMITMENT, not a final report. Call it',
  '  EARLY — within the first 1-2 scoping turns (read/grep/glob), BEFORE the',
  '  main implementation or investigation work.',
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
  '`read` / `grep` / `glob` / `edit` / `bash`:',
  '  Standard file inspection / mutation / shell tools.',
].join('\n');

const SYSTEM_PROMPT = [V1_SCOUT_SECTIONS, '', TOOL_DOCS_BLURB].join('\n');

function buildMultiStepV1ScoutVariant(): PromptVariant {
  return {
    id: 'v1-baseline',
    description:
      'V1 Scout prompt on the same multi-step user message as Slice 6 V2',
    systemPrompt: SYSTEM_PROMPT,
    // BYTE-IDENTICAL user message to Slice 6 V2's
    // multi_step_no_fanout_seeds_plan case — only the system prompt differs.
    userMessage:
      'In `packages/core/src/timeout.ts`, find the function `withTimeout` ' +
      'and add a guard that throws if the timeout is negative. After the ' +
      'edit, run the build to verify the change typechecks. Plan first.',
  };
}

export function buildPromptVariants(_caseId: CaseId): readonly PromptVariant[] {
  return [buildMultiStepV1ScoutVariant()];
}

// ---------------------------------------------------------------------------
// Judges — mirror Slice 8b two_file_investigation_emits judge shape so the
// V1 vs V2 comparison is apples-to-apples on the "did the model commit a
// plan list" semantic.
// ---------------------------------------------------------------------------

const VERDICT_SEMANTIC_PATTERN = /emit_scout_verdict|confirmed_harness/i;
const OBLIGATIONS_PATTERN = /executionObligations/i;

export function buildJudges(_caseId: CaseId): readonly PromptJudge[] {
  const minObligations = 2;
  return [
    {
      name: 'mentions_emit_scout_verdict',
      category: 'correctness',
      judge: (out) =>
        VERDICT_SEMANTIC_PATTERN.test(out)
          ? { passed: true }
          : {
              passed: false,
              reason:
                'multi-step task but output does not commit a verdict (no emit_scout_verdict OR confirmed_harness payload)',
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
        const lower = out.toLowerCase();
        const idx = lower.indexOf('executionobligations');
        if (idx < 0) {
          return {
            passed: false,
            reason: 'executionObligations not found in output',
          };
        }
        const tail = out.slice(idx);
        const region = tail.slice(0, 4096);

        // Array form
        const closeIdx = region.indexOf(']');
        if (closeIdx > 0) {
          const arrayRegion = region.slice(0, closeIdx);
          const arrayMatches = arrayRegion.match(/"[^"\n]{6,}"|'[^'\n]{6,}'/g);
          if (arrayMatches && arrayMatches.length >= minObligations) {
            return { passed: true };
          }
        }

        // String form
        const stringMatch = region.match(
          /executionobligations\s*[:=]\s*"([^"]+)"/i,
        );
        if (stringMatch) {
          const inner = stringMatch[1];
          const parts = inner
            .split(/[,;]|\sand\s/i)
            .filter((p) => p.trim().length >= 5);
          if (parts.length >= minObligations) return { passed: true };
        }

        // Fallback
        const fallback = region.match(/"[^"\n]{6,}"|'[^'\n]{6,}'/g);
        const count = fallback ? fallback.length : 0;
        if (count >= minObligations) return { passed: true };

        return {
          passed: false,
          reason: `expected ≥${minObligations} obligation entries, found ${count} in obligations region`,
        };
      },
    },
  ];
}
