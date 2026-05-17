/**
 * Dataset — FEATURE_125 (v0.7.41) Team Mode awareness eval cases.
 *
 * Verifies that when the runner-driven adapter injects the
 * `=== Other active KodaX sessions ===` block into the Worker
 * system prompt (rendered by `buildOtherInstancesPromptBlock` in
 * `@kodax-ai/agent`'s `team/system-prompt-injection.ts`), the
 * Worker LLM picks up the sibling context and exhibits at least
 * the simplest defensive behavior the prompt block describes:
 * re-read the sibling-touched file before editing / answering.
 *
 * Two cases, both POSITIVE (model SHOULD reach for `read` first):
 *
 *   1. **peer_active_file_acknowledge_read_first** — Sibling pid 8888
 *      is actively editing `src/auth.ts` (`activeFiles`). User asks
 *      Worker to "fix the password validation bug in `src/auth.ts`".
 *      Expected: Worker reads `src/auth.ts` first, matching the block's
 *      "consider ... reading their active file before editing" guidance.
 *
 *   2. **peer_recently_modified_reread** — Sibling pid 9999 recently
 *      modified `src/utils.ts` 15 s ago (`recentlyModifiedFiles`).
 *      User asks Worker to describe `formatTimestamp` in that file
 *      (with explicit "check the actual current implementation" hint
 *      so a re-read is unambiguously the right move). Expected: Worker
 *      reads `src/utils.ts` first, matching the block's "may have
 *      just changed; re-read before relying on memory" guidance.
 *
 * **Why "first tool call is `read`" is the mechanical assertion**:
 *
 * The team-mode block is intentionally informational ("consider ...",
 * "let them finish what they started" — no MUST). Multiple valid
 * behaviors exist (re-read, propose alternative file, ask user, defer).
 * Asserting on EACH alternative would require an LLM judge + multi-
 * branch logic. Instead we assert on the SIMPLEST defensive behavior
 * (re-read), accepting partial coverage of the design's full success
 * envelope. The pre-registered SHIP threshold compensates by being
 * lower than feature-120's 80% (see eval driver matrix).
 *
 * Per EVAL_GUIDELINES anti-pattern 7: both cases are POSITIVE
 * assertions; no negative regex. The `read` tool name is detected
 * via the multi-syntax pattern set introduced in feature-120
 * (`buildToolNamePatterns`) so zhipu/glm51's `<read>(args)` /
 * `<tool_call>{"name":"read",...}</tool_call>` variants pass.
 *
 * **Design source**: `docs/features/v0.7.41.md` Step 5 §"Step 7" —
 * acceptance criterion 3 (LLM 自决 ≥80% case 选择避让 / 协作 / re-read).
 * Eval-side threshold is relaxed to 60% because the regex only catches
 * the `read` arm of the three (避让 = propose alternative file is
 * NOT regex-detectable without LLM judge; 协作 = mention peer in text
 * is captured by a secondary judge but does NOT gate the SHIP decision).
 *
 * **Single-turn probe** per FEATURE_104 §single-step convention. The
 * canned `priorMessages` are empty — this is the Worker's first turn
 * after the user's request. The Worker SYSTEM prompt embeds the
 * team-mode block via the `buildOtherInstancesPromptBlock` helper so
 * the eval exercises the exact same prompt text production used at
 * runtime in `runner-driven.ts`.
 */

import {
  buildOtherInstancesPromptBlock,
  type DiscoveredInstance,
} from '@kodax-ai/agent';

import type { PromptVariant } from '../../harness/harness.js';
import type { PromptJudge } from '../../harness/judges.js';

export type CaseId =
  | 'peer_active_file_acknowledge_read_first'
  | 'peer_recently_modified_reread';

export interface CaseSpec {
  readonly id: CaseId;
  readonly description: string;
  readonly behaviour: string;
  /** The file path that the model is expected to `read` first. */
  readonly expectReadTarget: string;
  /**
   * Sibling pid the block describes — used in the secondary
   * "mentions sibling" judge (not in the primary SHIP gate).
   */
  readonly siblingPid: number;
}

export const CASES: readonly CaseSpec[] = [
  {
    id: 'peer_active_file_acknowledge_read_first',
    description:
      'Sibling KodaX session (pid 8888) is actively editing `src/auth.ts` ' +
      '(activeFiles). User asks Worker to fix the password validation bug ' +
      'in the same file. Worker should re-read `src/auth.ts` first per the ' +
      'team-mode block: "consider ... reading their active file before editing".',
    behaviour:
      "first tool call is `read` on `src/auth.ts` (defensive re-read because the sibling block flagged it as active)",
    expectReadTarget: 'src/auth.ts',
    siblingPid: 8888,
  },
  {
    id: 'peer_recently_modified_reread',
    description:
      'Sibling KodaX session (pid 9999) recently modified `src/utils.ts` 15 s ago ' +
      '(recentlyModifiedFiles). User asks Worker to describe a function in that ' +
      "file, with an explicit 'check the actual current implementation' hint. " +
      'Worker should re-read `src/utils.ts` first per the team-mode block: ' +
      '"recentlyModifiedFiles may have just changed; re-read before relying on memory".',
    behaviour:
      "first tool call is `read` on `src/utils.ts` (re-read because the sibling block flagged it as recently modified)",
    expectReadTarget: 'src/utils.ts',
    siblingPid: 9999,
  },
] as const;

// ---------------------------------------------------------------------------
// Variants — one per case ("v0.7.41"). The SYSTEM_PROMPT for each case
// embeds the EXACT bytes the runner-driven adapter produces by composing
// `buildOtherInstancesPromptBlock` over the case's fabricated sibling
// state. Embedding the block-rendering call here keeps the eval input
// in lock-step with the production formatter: any future change to the
// block's wording surfaces in this eval automatically.
// ---------------------------------------------------------------------------

const WORKER_SYSTEM_HEADER = [
  "You are the Worker — KodaX's primary agent for this task.",
  '',
  '## Environment',
  'Working Directory: /repo',
  'Platform: Linux (5.15)',
  'Shell defaults: Unix shell. Use: ls, mv, cp, rm, cat, head, tail.',
  '',
  '## Available Tools',
  '',
  '`read`:',
  '  Input:  { path:string }',
  '  Output: file contents as text',
  '',
  '`edit`:',
  '  Input:  { path:string, old_string:string, new_string:string }',
  '  Effect: replaces `old_string` with `new_string` in `path`. Errors if the file changed since the last read.',
  '',
  '`grep`:',
  '  Input:  { pattern:string, path?:string }',
  '  Output: matching lines',
].join('\n');

/**
 * Fabricate a `DiscoveredInstance` shape that mirrors what
 * `discoverInstances()` returns. The block-renderer reads
 * `state.meta.cwd` / `state.meta.startedAt` / `state.agentPhase` /
 * `state.activeFiles` / `state.recentlyModifiedFiles` / `state.currentIntent`,
 * so we populate exactly those.
 */
function makeSibling(args: {
  readonly pid: number;
  readonly startedAtMsAgo: number;
  readonly phase: 'idle' | 'awaiting_llm' | 'running_tool';
  readonly intent: string;
  readonly activeFiles?: readonly string[];
  readonly recentlyModified?: ReadonlyArray<{ path: string; agoMs: number }>;
}): DiscoveredInstance {
  const now = Date.now();
  const baseState = {
    agentPhase: args.phase,
    currentIntent: args.intent,
    ...(args.activeFiles ? { activeFiles: [...args.activeFiles] } : {}),
    ...(args.recentlyModified
      ? {
          recentlyModifiedFiles: args.recentlyModified.map((f) => ({
            path: f.path,
            modifiedAt: now - f.agoMs,
          })),
        }
      : {}),
  };
  return {
    pid: args.pid,
    instanceDir: `/tmp/instances/${args.pid}`,
    state: {
      ...baseState,
      meta: {
        cwd: '/repo',
        startedAt: now - args.startedAtMsAgo,
        gitBranch: 'main',
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Prompt-iteration pilot variants (2026-05-17) — hypothesis-testing for
// kimi case 2 narrate-without-tool 0% pass-rate. Block produced by
// `buildOtherInstancesPromptBlock` is patched at the "Coordination guidance"
// section. All variants are pure simplification/restructuring — no MUST,
// no new constraints (per `feedback_prompt_strengthening_cross_case_regression`).
//
// V1 = production v0.7.41 block (control)
// V2 = recently_modified wording more concrete & actionable (still informational)
// V3 = bullet order swapped: recently_modified before active_files
// ---------------------------------------------------------------------------

const V1_GUIDANCE = [
  'Coordination guidance:',
  '- If your task overlaps with their active_files, consider working on different files first, reading their active file before editing, or coordinating via the user. Use your judgment — concurrent work on disjoint files is fine.',
  '- Their recentlyModifiedFiles may have just changed; re-read before relying on memory of their content.',
  "- Don't fight them — let them finish what they started.",
].join('\n');

const V2_GUIDANCE = [
  'Coordination guidance:',
  '- If your task overlaps with their active_files, consider working on different files first, reading their active file before editing, or coordinating via the user. Use your judgment — concurrent work on disjoint files is fine.',
  '- Their recentlyModifiedFiles have likely changed since you last saw them. Read the current content before reasoning about them.',
  "- Don't fight them — let them finish what they started.",
].join('\n');

const V3_GUIDANCE = [
  'Coordination guidance:',
  '- Their recentlyModifiedFiles may have just changed; re-read before relying on memory of their content.',
  '- If your task overlaps with their active_files, consider working on different files first, reading their active file before editing, or coordinating via the user. Use your judgment — concurrent work on disjoint files is fine.',
  "- Don't fight them — let them finish what they started.",
].join('\n');

export type PromptVariantKind = 'v1' | 'v2' | 'v3';

function patchGuidance(block: string, variant: PromptVariantKind): string {
  if (variant === 'v1') return block;
  const target = variant === 'v2' ? V2_GUIDANCE : V3_GUIDANCE;
  if (!block.includes(V1_GUIDANCE)) {
    throw new Error('patchGuidance: production block did not contain the v1 guidance block — possible drift');
  }
  return block.replace(V1_GUIDANCE, target);
}

function variantIdOf(v: PromptVariantKind): string {
  switch (v) {
    case 'v1': return 'v_block_v1';
    case 'v2': return 'v_block_v2';
    case 'v3': return 'v_block_v3';
  }
}

function buildActiveFileAcknowledgeVariant(variant: PromptVariantKind): PromptVariant {
  const sibling = makeSibling({
    pid: 8888,
    startedAtMsAgo: 5 * 60_000,
    phase: 'running_tool',
    intent: 'refactoring password hashing in auth module',
    activeFiles: ['src/auth.ts'],
  });
  const block = patchGuidance(buildOtherInstancesPromptBlock([sibling]), variant);
  return {
    id: variant === 'v1' ? 'v0.7.41' : variantIdOf(variant),
    description:
      'team-mode block flags sibling pid 8888 actively editing src/auth.ts; expect Worker to read src/auth.ts first',
    systemPrompt: [WORKER_SYSTEM_HEADER, '', block].join('\n'),
    userMessage:
      'Users are reporting that the password validation logic in `src/auth.ts` ' +
      'rejects strings containing legitimate punctuation characters like `:` ' +
      'and `/`. Please fix the validation so those characters are allowed, ' +
      'while still rejecting obvious injection attempts.',
  };
}

function buildRecentlyModifiedRereadVariant(variant: PromptVariantKind): PromptVariant {
  const sibling = makeSibling({
    pid: 9999,
    startedAtMsAgo: 12 * 60_000,
    phase: 'idle',
    intent: 'just landed a timestamp-formatting fix',
    recentlyModified: [{ path: 'src/utils.ts', agoMs: 15_000 }],
  });
  const block = patchGuidance(buildOtherInstancesPromptBlock([sibling]), variant);
  return {
    id: variant === 'v1' ? 'v0.7.41' : variantIdOf(variant),
    description:
      'team-mode block flags sibling pid 9999 recently modified src/utils.ts; expect Worker to read src/utils.ts first',
    systemPrompt: [WORKER_SYSTEM_HEADER, '', block].join('\n'),
    userMessage:
      'Can you tell me what the `formatTimestamp` function in `src/utils.ts` ' +
      'currently does? I want to know the actual current implementation, ' +
      'not what it used to do — please check the file directly.',
  };
}

function buildVariantForCase(caseId: CaseId, variant: PromptVariantKind): PromptVariant {
  switch (caseId) {
    case 'peer_active_file_acknowledge_read_first':
      return buildActiveFileAcknowledgeVariant(variant);
    case 'peer_recently_modified_reread':
      return buildRecentlyModifiedRereadVariant(variant);
  }
}

export function buildPromptVariants(caseId: CaseId): readonly PromptVariant[] {
  return [buildVariantForCase(caseId, 'v1')];
}

export function buildPromptVariantsIteration(caseId: CaseId): readonly PromptVariant[] {
  return [
    buildVariantForCase(caseId, 'v1'),
    buildVariantForCase(caseId, 'v2'),
    buildVariantForCase(caseId, 'v3'),
  ];
}

// ---------------------------------------------------------------------------
// Judges — multi-syntax tolerant per feature-120 lesson.
//
// Primary SHIP-gate judge: the FIRST tool call (by appearance in the
// response stream) is `read` AND targets the sibling-touched file.
// We accept any of the four syntactic forms enumerated in feature-120's
// `buildToolNamePatterns`. The file-path assertion uses literal
// substring (path includes underscores and dots so word-boundary
// regex would be brittle on Windows-style backslash variants too).
//
// Secondary informational judge (not SHIP-gated): output mentions the
// sibling pid number. Useful diagnostic — tells us whether the model
// is "aware" of the block at all even if it doesn't pick the re-read
// behavior. Recorded in the per-cell judges output, but the SHIP
// matrix is driven by the primary judge alone.
// ---------------------------------------------------------------------------

// FEATURE_125 audit (2026-05-16) — the 4-pattern feature-120 set missed
// several syntactic forms that Phase 1 panel actually emits:
//   zhipu/glm51   `<tool_call id="..."><tool_name>read</tool_name>...</tool_call>`
//   ark/glm51     `<tool_call>read<arg_key>path</arg_key>...</tool_call>`
//   kimi          `read:0>{"path":"..."}` (the digit is kimi's tool-call serial)
//                 and also `<tool>read</tool>` (XML-wrapper alt)
//   mmx/m27       `[TOOL_CALL] {tool => "read", args => {...}} [/TOOL_CALL]`
//   ds/v4pro      `<read>...</read>`                                  (already matched)
// Re-judging the same raw dumps with the broader set flipped case 1 from
// 40% → 84% and case 2 from 48% → 60% — well above the 10% disagreement
// threshold from EVAL_GUIDELINES anti-pattern 7. Source dump:
// `%LOCALAPPDATA%/Temp/kodax-eval-dumps/feature-125-team-mode-awareness/`.
function buildToolNamePatterns(toolName: string): readonly RegExp[] {
  const esc = toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    // 1. fn-call `read(...)` — exclude shell wrappers (`<command>read(...)` /
    //    `<bash>read(...)`); Layer B 2026-05-17 finding: mmx case-2 run 1
    //    misjudged PASS because shell `<command>read(...)` matched.
    new RegExp(`(?<!<command>\\s*|<bash>\\s*|<shell>\\s*)\\b${esc}\\s*\\(`, 'i'),
    new RegExp(`["'\`]name["'\`]\\s*:\\s*["'\`]${esc}["'\`]`, 'i'),   // "name":"read"
    // 3. XML-style `<read>...</read>` OR self-closing `<read ... />`.
    //    Require either a closing tag within 2000 chars (`</read>`) or
    //    `/>` self-close at end of opener tag (ds-style `<read path=".." />`).
    //    Rejects truncated `<read>` (no close) responses.
    new RegExp(`<${esc}\\b(?:[\\s\\S]{0,2000}?</${esc}>|[^>]*/>)`, 'i'),
    new RegExp(`\\bname\\s*[:=]\\s*${esc}\\b`, 'i'),                  // name=read
    new RegExp(`<tool_name>\\s*${esc}\\s*</tool_name>`, 'i'),         // <tool_name>read</tool_name>   (zhipu)
    new RegExp(`<tool>\\s*${esc}\\s*</tool>`, 'i'),                   // <tool>read</tool>            (kimi alt)
    // 7. ark `<tool_call>read<arg_key>...</tool_call>` — require closing
    //    `</tool_call\s*>` within 2000 chars (allow whitespace before `>`;
    //    zhipu emits `</tool_call >` with trailing space); rejects broken-JSON
    //    `<tool_call>read",{` (Layer B 2026-05-17 finding: ark case-1 run 3
    //    misjudged PASS).
    new RegExp(`<tool_call>\\s*${esc}\\b[\\s\\S]{0,2000}?</tool_call\\s*>`, 'i'),
    new RegExp(`\\b${esc}\\s*:\\s*\\d+\\s*[>{]`, 'i'),                // read:0>{...} / read:0{...}   (kimi)
    new RegExp(`tool\\s*=>\\s*["'\`]${esc}["'\`]`, 'i'),              // tool => "read"               (mmx)
  ];
}

function buildPrimaryReadFirstJudge(expectReadTarget: string): PromptJudge {
  const readPatterns = buildToolNamePatterns('read');
  return {
    name: `read_first_on_${expectReadTarget.replace(/[^a-z0-9]/gi, '_')}`,
    category: 'correctness',
    judge: (out) => {
      const readMatch = readPatterns.find((p) => p.test(out));
      if (!readMatch) {
        return {
          passed: false,
          reason: 'output does not invoke `read` (checked fn-call / JSON / XML / kw syntax)',
        };
      }
      if (!out.includes(expectReadTarget)) {
        return {
          passed: false,
          reason: `output invokes \`read\` but does not reference target path \`${expectReadTarget}\``,
        };
      }
      // Light "first" check: the `read` invocation appears before any
      // `edit` / `write` / `multi_edit` invocation in the response
      // text. This is an over-approximation (the model might mention
      // edit in prose without invoking it), but combined with the
      // tool-call detection above it catches the most common failure
      // mode — jumping straight to edit without a defensive re-read.
      const readIdx = out.search(readMatch);
      const mutationPatterns = [
        ...buildToolNamePatterns('edit'),
        ...buildToolNamePatterns('write'),
        ...buildToolNamePatterns('multi_edit'),
      ];
      for (const mp of mutationPatterns) {
        const mi = out.search(mp);
        if (mi !== -1 && mi < readIdx) {
          return {
            passed: false,
            reason: 'a mutation tool (`edit` / `write` / `multi_edit`) appears before the `read` call in the output',
          };
        }
      }
      return { passed: true };
    },
  };
}

function buildMentionsSiblingJudge(siblingPid: number): PromptJudge {
  return {
    name: `mentions_sibling_pid_${siblingPid}`,
    category: 'process',
    judge: (out) => {
      // Either the pid itself OR the canonical block phrasing the
      // model would echo when acknowledging the sibling context.
      const acknowledged =
        out.includes(String(siblingPid)) ||
        /other (active )?KodaX|another (KodaX )?session|sibling session|other (active )?session/i.test(
          out,
        );
      return acknowledged
        ? { passed: true }
        : {
            passed: false,
            reason: `output does not reference sibling pid ${siblingPid} or the canonical "other session" phrasing`,
          };
    },
  };
}

export function buildJudges(caseId: CaseId): readonly PromptJudge[] {
  const spec = CASES.find((c) => c.id === caseId);
  if (!spec) {
    throw new Error(`Unknown FEATURE_125 case id: ${caseId}`);
  }
  return [
    buildPrimaryReadFirstJudge(spec.expectReadTarget),
    buildMentionsSiblingJudge(spec.siblingPid),
  ];
}
