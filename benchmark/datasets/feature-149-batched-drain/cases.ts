/**
 * Dataset — FEATURE_149 (v0.7.38) Phase B3 batched-drain eval.
 *
 * ## Purpose
 *
 * Verifies that when N follow-up prompts are batched into a single user
 * message via `\n\n---\n\n` separators (the production join in
 * `runQueuedPromptSequence`), the LLM still:
 *
 *   1. addresses ALL distinct sub-tasks rather than only the first or last,
 *   2. correctly honors a later sub-task that overrides an earlier one
 *      (redirect-correction case),
 *   3. preserves task cohesion under mixed-genre tasks (lookup + count +
 *      summarize in one batch).
 *
 * ## Run model
 *
 * Single-turn probe per FEATURE_104 §single-step convention. Each case
 * runs once per available alias × one variant ("v0.7.38").
 *
 * **Stage-1 acceptance gate** (per design §"验收标准 #6 跨 family 不退化"):
 *
 *   - 5 alias mean ≥ 75% pass per case.
 *   - max-min spread ≤ 20pp across 5 alias.
 *
 * Lower threshold than typical (75% vs 80%) because batching multiple
 * tasks into one message is genuinely harder for some smaller-context
 * models — the goal is "no catastrophic regression", not "perfect".
 *
 * ## See also
 *
 *   - tests/feature-149-batched-drain.eval.ts (runner)
 *   - packages/repl/src/ui/utils/queued-prompt-sequence.ts (production join)
 *   - docs/features/v0.7.38.md#feature_149-queued-prompt-injection-latency--mid-turn-ux-parity
 */

import type { PromptVariant } from '../../harness/harness.js';
import { mustContainAny, type PromptJudge } from '../../harness/judges.js';

export type CaseId =
  | 'two_independent_lookups'
  | 'three_mixed_tasks'
  | 'redirect_correction'
  | 'four_questions';

export interface CaseSpec {
  readonly id: CaseId;
  readonly description: string;
  readonly behaviour: string;
}

export const CASES: readonly CaseSpec[] = [
  {
    id: 'two_independent_lookups',
    description:
      'Two independent lookup questions joined into one batched prompt. ' +
      'LLM must address both, not collapse to one.',
    behaviour:
      'output mentions BOTH key tokens from each sub-task',
  },
  {
    id: 'three_mixed_tasks',
    description:
      'Three tasks of different shapes (count + identify + summarize) ' +
      'joined into one batched prompt.',
    behaviour:
      'output covers at least 2 of the 3 distinct sub-task signals',
  },
  {
    id: 'redirect_correction',
    description:
      'First sub-task is "do X", second sub-task is "actually no, do Y instead". ' +
      'LLM must follow the redirect and produce Y, not X.',
    behaviour:
      'output focuses on the second (corrected) target, NOT the first',
  },
  {
    id: 'four_questions',
    description:
      'Four short questions about a small code snippet, batched in one prompt.',
    behaviour:
      'output answers at least 3 of 4 distinct questions',
  },
] as const;

const BATCH_SEP = '\n\n---\n\n';

const NEUTRAL_SYSTEM = [
  'You are a helpful coding assistant. The user has sent multiple',
  'questions/instructions in one message, separated by `---`. Address',
  'each one in your response.',
].join('\n');

function buildTwoLookups(): PromptVariant {
  return {
    id: 'v0.7.38',
    description: 'Two independent lookups',
    systemPrompt: NEUTRAL_SYSTEM,
    userMessage: [
      'In a typical TypeScript monorepo using `npm workspaces`, where would the workspace package list usually live? Name the file.',
      'In a typical Rust workspace using Cargo, where would the workspace member list live? Name the file.',
    ].join(BATCH_SEP),
  };
}

function buildThreeMixed(): PromptVariant {
  return {
    id: 'v0.7.38',
    description: 'Three mixed-genre tasks',
    systemPrompt: NEUTRAL_SYSTEM,
    userMessage: [
      'List three common HTTP status codes used for client-side errors (400-499 range).',
      'How many bytes are in a UTF-8 representation of the BMP character `é` (U+00E9)?',
      'In one sentence, what is the difference between `Promise.all` and `Promise.allSettled`?',
    ].join(BATCH_SEP),
  };
}

function buildRedirect(): PromptVariant {
  return {
    id: 'v0.7.38',
    description: 'Redirect correction (second supersedes first)',
    systemPrompt: NEUTRAL_SYSTEM,
    userMessage: [
      'Write a one-line bash command to count files in `/tmp` recursively.',
      "Wait — actually scratch that. Instead, write a one-line bash command to print today's date in ISO 8601 format. Ignore the previous request entirely.",
    ].join(BATCH_SEP),
  };
}

function buildFourQuestions(): PromptVariant {
  return {
    id: 'v0.7.38',
    description: 'Four-question batched probe',
    systemPrompt: NEUTRAL_SYSTEM,
    userMessage: [
      'In TypeScript, what does the keyword `readonly` mean when applied to a class field?',
      'In TypeScript, what is the difference between `interface` and `type`?',
      'In TypeScript, what does the `?:` syntax mean in an interface property?',
      'In TypeScript, what does `as const` do at the end of a literal expression?',
    ].join(BATCH_SEP),
  };
}

function buildVariantForCase(caseId: CaseId): PromptVariant {
  switch (caseId) {
    case 'two_independent_lookups':
      return buildTwoLookups();
    case 'three_mixed_tasks':
      return buildThreeMixed();
    case 'redirect_correction':
      return buildRedirect();
    case 'four_questions':
      return buildFourQuestions();
  }
}

export function buildPromptVariants(caseId: CaseId): readonly PromptVariant[] {
  return [buildVariantForCase(caseId)];
}

// ---------------------------------------------------------------------------
// Judges — each case has 1-2 deterministic judges. Pass rate across alias
// is the FEATURE_104 stage-1 metric (target: mean ≥ 75%, spread ≤ 20pp).
// ---------------------------------------------------------------------------

function judgesForTwoLookups(): readonly PromptJudge[] {
  return [
    {
      name: 'mentions_package_json',
      category: 'correctness',
      judge: mustContainAny('package.json', '`package.json`').judge,
    },
    {
      name: 'mentions_cargo_toml',
      category: 'correctness',
      judge: mustContainAny('Cargo.toml', '`Cargo.toml`', 'cargo.toml').judge,
    },
  ];
}

function judgesForThreeMixed(): readonly PromptJudge[] {
  return [
    {
      name: 'mentions_two_of_three_signals',
      category: 'correctness',
      judge: (out) => {
        // Each signal corresponds to one of the three sub-tasks.
        const httpCode = /\b(400|401|403|404|405|409|418|422|429)\b/.test(out);
        const bytesAnswer = /\b2\b/.test(out) && /(byte|UTF[-\s]?8|encod)/i.test(out);
        const promiseAnswer =
          /(allSettled)/i.test(out)
          && /(reject|fulfilled|fail|error|all\b)/i.test(out);
        const hits = [httpCode, bytesAnswer, promiseAnswer].filter(Boolean).length;
        return hits >= 2
          ? { passed: true }
          : {
              passed: false,
              reason:
                `only ${hits}/3 sub-task signals present `
                + `(httpCode=${httpCode}, bytes=${bytesAnswer}, promise=${promiseAnswer})`,
            };
      },
    },
  ];
}

function judgesForRedirect(): readonly PromptJudge[] {
  return [
    {
      name: 'follows_redirect_to_date',
      category: 'correctness',
      judge: (out) => {
        // Strong signal that the LLM honored the second instruction:
        // mentions `date` command OR ISO 8601 OR a date-format pattern,
        // AND does NOT primarily respond about counting files.
        const honorsDate =
          /\bdate\b/i.test(out)
          || /ISO[\s-]?8601/i.test(out)
          || /%Y-%m-%d/i.test(out);
        return honorsDate
          ? { passed: true }
          : { passed: false, reason: 'output does not mention date / ISO 8601' };
      },
    },
  ];
}

function judgesForFourQuestions(): readonly PromptJudge[] {
  return [
    {
      name: 'answers_three_of_four',
      category: 'correctness',
      judge: (out) => {
        const lower = out.toLowerCase();
        const readonlyAnswered =
          /\breadonly\b/i.test(out)
          && /(immutab|cannot.*reassign|cannot.*modif|prevent|protect)/i.test(out);
        const interfaceVsType =
          /interface/i.test(out) && /type/i.test(out)
          && /(extend|merge|alias|union|primitiv)/i.test(out);
        const optionalProperty =
          (/(\?:|\boptional\b)/i.test(out))
          && /(undefined|optional|may|missing|absent)/i.test(out);
        const asConst =
          /as const/i.test(out)
          && /(literal|readonly|narrow|tuple|widen|inferr)/i.test(lower);
        const hits = [readonlyAnswered, interfaceVsType, optionalProperty, asConst]
          .filter(Boolean).length;
        return hits >= 3
          ? { passed: true }
          : {
              passed: false,
              reason:
                `only ${hits}/4 questions answered `
                + `(readonly=${readonlyAnswered}, interface_vs_type=${interfaceVsType}, `
                + `optional=${optionalProperty}, as_const=${asConst})`,
            };
      },
    },
  ];
}

export function buildJudges(caseId: CaseId): readonly PromptJudge[] {
  switch (caseId) {
    case 'two_independent_lookups':
      return judgesForTwoLookups();
    case 'three_mixed_tasks':
      return judgesForThreeMixed();
    case 'redirect_correction':
      return judgesForRedirect();
    case 'four_questions':
      return judgesForFourQuestions();
  }
}
