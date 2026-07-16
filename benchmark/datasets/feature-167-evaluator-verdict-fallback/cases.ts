/**
 * Dataset — FEATURE_167 (v0.7.41) Evaluator terminal-verdict fallback.
 *
 * Layer 2 probe per EVAL_GUIDELINES: measures Evaluator emit_verdict
 * incidence across 5 production aliases to gate the SHIP/PARTIAL/REJECT
 * decision for the 3 defense layers (B0 fenced-block parser, B1 runtime
 * retry gate, B2 fallback synth).
 *
 * Smoking gun motivating this probe (production session 20260515_185354):
 *
 *   Worker → emit_handoff (clean) → Evaluator runs → Evaluator emits
 *   text-only "Review 已全部完成。核心发现：..." with NO emit_verdict
 *   tool call → run terminates → `deriveFinalStatus` at
 *   runner-driven.ts:4146 falls back to `signal:'COMPLETE'`. The audit
 *   failed but the system reports success.
 *
 * ## Cases (3)
 *
 *   **C1 `evaluator_first_turn_clean_handoff`** — (baseline measurement)
 *     Evaluator's FIRST turn after Worker handoff. PASS iff response
 *     contains an emit_verdict tool call (any of 5 syntactic forms per
 *     anti-pattern 7 §4).
 *
 *   **C2 `evaluator_retry_after_missing`** — (B1 retry recovery rate)
 *     Simulates the B1 path: turn 1 = Evaluator text-only response (no
 *     tool call), then injected EVALUATOR_VERDICT_RETRY_PROMPT as user
 *     message. Probe measures whether turn 2's response contains
 *     emit_verdict — i.e. does the retry actually recover.
 *
 *   **C3 `evaluator_fenced_block_emission_rate`** — (B0 value measurement)
 *     Same scene as C1 but assertion checks for ```kodax-task-verdict```
 *     fenced block in the response text, parseable by
 *     parseManagedTaskVerdictDirectiveFromJson. Tells us whether B0's
 *     dead-code activation would actually catch any production cases.
 *
 * ## Variant
 *
 * Single `v_current` variant — no prompt comparison, just measurement of
 * current production behaviour. The retry prompt for C2 is PINNED to
 * `EVALUATOR_VERDICT_RETRY_PROMPT` (re-exported below).
 *
 * ## Pre-registered SHIP gate (decoupled per layer)
 *
 *   B0 SHIPS iff: C3 emission rate > 5% on ≥ 1 alias
 *   B1 SHIPS iff: C1 < 80% on ≥ 1 alias AND C2 ≥ 80% on ≥ 3/5 alias
 *   B2 SHIPS unconditionally (smoking-gun fix)
 *
 * Sample escalation: 5 run/cell baseline; auto-bump to 10 run/cell on
 * any alias × case landing in the 65-85% statistical-uncertainty band.
 *
 * ## See also
 *
 *   - docs/features/v0.7.41.md §FEATURE_167 — full design
 *   - benchmark/datasets/feature-165-handoff-wait-gate/cases.ts — sibling
 *     pattern (multi-syntax tool name detection, 5-alias panel)
 *   - benchmark/EVAL_GUIDELINES.md — Layer 2 probe contract
 */

import type { PromptVariant } from '../../harness/harness.js';
import type { PromptJudge } from '../../harness/judges.js';

export type CaseId =
  | 'evaluator_first_turn_clean_handoff'
  | 'evaluator_retry_after_missing'
  | 'evaluator_fenced_block_emission_rate';

export interface CaseSpec {
  readonly id: CaseId;
  readonly assertion:
    | 'first_tool_call_includes_emit_verdict'
    | 'turn_2_includes_emit_verdict'
    | 'response_contains_parseable_fenced_verdict_block';
  readonly description: string;
}

export const CASES: readonly CaseSpec[] = [
  {
    id: 'evaluator_first_turn_clean_handoff',
    assertion: 'first_tool_call_includes_emit_verdict',
    description:
      'Evaluator first turn after clean Worker handoff. Baseline rate at ' +
      'which production aliases call emit_verdict without retry intervention. ' +
      '< 80% on any alias triggers B1 retry gate ship consideration.',
  },
  {
    id: 'evaluator_retry_after_missing',
    assertion: 'turn_2_includes_emit_verdict',
    description:
      'Evaluator turn 2 after B1 retry prompt injection. priorMessages ' +
      'simulate a turn-1 text-only response, then the canonical ' +
      'EVALUATOR_VERDICT_RETRY_PROMPT is appended as a user message. ' +
      'Measures whether the retry recovers — ≥ 80% on ≥ 3/5 alias means ' +
      'retry is effective; < 50% means B1 is wasted budget for that alias.',
  },
  {
    id: 'evaluator_fenced_block_emission_rate',
    assertion: 'response_contains_parseable_fenced_verdict_block',
    description:
      'Same canned scene as C1, but assertion is structural: does the ' +
      'response include a ```kodax-task-verdict``` fenced block whose body ' +
      'parses via parseManagedTaskVerdictDirectiveFromJson? Tells us ' +
      'whether the dead-code B0 parser would actually catch any real-world ' +
      'fallback cases. > 5% on any alias justifies wiring B0; 0% on all ' +
      'aliases means leave the parser dead-coded.',
  },
] as const;

// ---------------------------------------------------------------------------
// Pinned constant — EVALUATOR_VERDICT_RETRY_PROMPT
//
// The B1 retry prompt injected after Evaluator emits text-only without a
// verdict. C2 of this probe uses this EXACT string. If the implementation
// later changes the prompt text, the probe MUST be re-run before the new
// version ships (per planner-review 2026-05-15 reproducibility rule).
// ---------------------------------------------------------------------------

export const EVALUATOR_VERDICT_RETRY_PROMPT = [
  'Your previous response ended without calling the `emit_verdict` tool ' +
    'and without a valid ```kodax-task-verdict``` fenced block. The run ' +
    'cannot terminate without a structured verdict.',
  '',
  'Call `emit_verdict` now with this shape:',
  '  emit_verdict({',
  '    status: "accept" | "revise" | "blocked",',
  '    reason: "<one-line reason>",',
  '    user_answer: "<final user-facing answer, multi-line ok>"',
  '  })',
  '',
  'Do NOT respond with text only. Do NOT repeat the review summary in ' +
    'prose — put the consolidated review in `user_answer` and call the tool.',
].join('\n');

// ---------------------------------------------------------------------------
// Evaluator system prompt — production-realistic minimal shape.
//
// Based on EVALUATOR_INSTRUCTIONS_FALLBACK (runner-driven.ts:356-360)
// extended with the verdict payload schema from role-prompt.ts:884-896.
// We don't snapshot the full production role prompt because the probe is
// measuring TOOL-CALL BEHAVIOUR, not prompt content — the fallback
// instructions are sufficient to invoke Evaluator identity and surface
// the verdict-emission ask.
//
// Worth noting: line 895 of production role-prompt.ts documents the
// fenced-block form as an accepted fallback. We include the same line
// here so C3's emission-rate measurement reflects what models would
// actually do given the production framing.
// ---------------------------------------------------------------------------

const EVALUATOR_SYSTEM_PROMPT = [
  'You are Evaluator — the verifier role for a managed KodaX task.',
  '',
  'Your job: audit the Worker\'s handoff payload and emit a terminal ' +
    'verdict. You MUST call `emit_verdict` exactly once with status set.',
  '',
  'You MAY use read-only verification tools (read, grep, glob, bash) if ' +
    'you need to confirm specific Worker claims, but read-only verification ' +
    'is preferred — the Worker has already done the work; your job is to ' +
    'audit, not redo.',
  '',
  'Verdict payload shape:',
  '  emit_verdict({',
  '    status: "accept" | "revise" | "blocked",',
  '    reason: "<one-line reason>",',
  '    user_answer: "<optional final user-facing answer, multi-line ok>"',
  '  })',
  '',
  '(The fenced-block form ```kodax-task-verdict {...JSON...}``` is ' +
    'accepted as a fallback; prefer the tool call.)',
  '',
  'Available tools:',
  '  `emit_verdict({status, reason?, user_answer?})` — TERMINAL verdict call.',
  '  `read({path})` / `grep({pattern, path?})` / `glob({pattern})` — ' +
    'read-only file inspection.',
  '  `bash({command})` — read-only verification commands.',
].join('\n');

// ---------------------------------------------------------------------------
// Canned transcript builder.
//
// scene1 = post-clean-handoff state used by C1 and C3. Worker has finished
//          investigation, dispatched no children (simpler scene), emitted
//          emit_handoff with a clean "ready" payload, runner inserted the
//          tool result. Evaluator's first turn is what we probe.
//
// scene2 = scene1 PLUS a simulated turn-1 Evaluator text-only response
//          AND the canonical EVALUATOR_VERDICT_RETRY_PROMPT as a user
//          message. Used by C2 to measure retry-recovery rate.
// ---------------------------------------------------------------------------

interface SceneFragment {
  readonly priorMessages: PromptVariant['priorMessages'];
  readonly userMessage: string;
}

function sceneCleanHandoff(): SceneFragment {
  const priorMessages: PromptVariant['priorMessages'] = [
    {
      role: 'user',
      content:
        'Summarize what `packages/coding/README.md` says about the runner-driven path.',
    },
    {
      role: 'assistant',
      // Worker's prior turns, condensed. In production Evaluator sees
      // the full transcript (no inputFilter on worker→evaluator handoff,
      // verified runner-driven.ts:2849-2851), but the audit-relevant
      // bits are the handoff payload + summary.
      content:
        '[Worker turn 1] I\'ll plan, read the file, then summarize.\n\n' +
        '<tool_call>todo_update({op:"init", items:[' +
        '{id:"todo_1", content:"Read packages/coding/README.md", activeForm:"Reading README"},' +
        '{id:"todo_2", content:"Extract runner-driven path notes", activeForm:"Extracting notes"}' +
        ']})</tool_call>\n\n' +
        '<tool_call>read({path:"packages/coding/README.md"})</tool_call>\n\n' +
        '[Read result excerpt]\n' +
        '"The runner-driven path is the default since v0.7.38; Worker is ' +
        'the V2 single-loop primary; emit_handoff hands off to the ' +
        'Evaluator for verification."\n\n' +
        '<tool_call>todo_update({op:"set", id:"todo_1", status:"completed"})</tool_call>\n' +
        '<tool_call>todo_update({op:"set", id:"todo_2", status:"completed"})</tool_call>\n\n' +
        '[Worker turn 2] Plan complete. Both items done. Handing off.\n\n' +
        '<tool_call>emit_handoff({status:"ready", summary:"README summary ' +
        'extracted: runner-driven is default since v0.7.38, Worker is V2 ' +
        'primary, emit_handoff hands to Evaluator.", ' +
        'evidence:[{kind:"file_read", path:"packages/coding/README.md"}]})</tool_call>',
    },
  ];
  const userMessage =
    'Worker has handed off. Handoff payload:\n\n' +
    '  status:   ready\n' +
    '  summary:  README summary extracted: runner-driven is default since ' +
    'v0.7.38, Worker is V2 primary, emit_handoff hands to Evaluator.\n' +
    '  evidence: [{ kind: "file_read", path: "packages/coding/README.md" }]\n\n' +
    'Audit the payload and emit your terminal verdict.';
  return { priorMessages, userMessage };
}

function sceneRetryAfterMissing(): SceneFragment {
  const baseScene = sceneCleanHandoff();
  // Build the C2 priorMessages = scene1 priorMessages + (the original
  // userMessage as a user-role message) + a simulated Evaluator
  // text-only response (turn 1). The probe's actual userMessage then
  // becomes the EVALUATOR_VERDICT_RETRY_PROMPT — which is what Evaluator
  // sees as the most recent user-role message when its turn 2 begins.
  const priorMessages: PromptVariant['priorMessages'] = [
    ...baseScene.priorMessages,
    {
      role: 'user',
      content: baseScene.userMessage,
    },
    {
      role: 'assistant',
      // Mimics the production session 20260515_185354 entry 54 shape:
      // Evaluator emits a Chinese-language review summary with no tool
      // call. We keep the text short and structurally identical
      // (3 numbered bullets, no fence, no tool invocation).
      content:
        'Review 已全部完成。核心发现：\n\n' +
        '1. README summary 准确反映了 runner-driven 路径的引入版本和角色拓扑\n' +
        '2. 引用的 evidence 文件存在且包含相关段落\n' +
        '3. 无明显遗漏或事实错误',
    },
  ];
  return { priorMessages, userMessage: EVALUATOR_VERDICT_RETRY_PROMPT };
}

function buildSceneForCase(caseId: CaseId): SceneFragment {
  switch (caseId) {
    case 'evaluator_first_turn_clean_handoff':
    case 'evaluator_fenced_block_emission_rate':
      return sceneCleanHandoff();
    case 'evaluator_retry_after_missing':
      return sceneRetryAfterMissing();
  }
}

export function buildPromptVariants(caseId: CaseId): readonly PromptVariant[] {
  const scene = buildSceneForCase(caseId);
  return [
    {
      id: 'v_current',
      description:
        caseId === 'evaluator_retry_after_missing'
          ? 'Evaluator turn 2 after canonical EVALUATOR_VERDICT_RETRY_PROMPT injection'
          : 'Evaluator first turn after clean Worker handoff (current production prompt)',
      systemPrompt: EVALUATOR_SYSTEM_PROMPT,
      priorMessages: scene.priorMessages,
      userMessage: scene.userMessage,
    },
  ];
}

// ---------------------------------------------------------------------------
// Judges — multi-syntax tool-name detection (anti-pattern 7 §4)
// + structural fenced-block parser invocation for C3.
//
// Same 5-syntax buildToolNamePatterns helper as FEATURE_165 / FEATURE_166
// datasets — duplicated locally (not re-imported) so this dataset stays
// self-contained for review.
// ---------------------------------------------------------------------------

function buildToolNamePatterns(toolName: string): readonly RegExp[] {
  const esc = toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    new RegExp(`\\b${esc}\\s*\\(`, 'i'),                              // tool_name(
    new RegExp(`["'\`]name["'\`]\\s*:\\s*["'\`]${esc}["'\`]`, 'i'),   // "name":"tool_name"
    new RegExp(`\\bname\\s*:\\s*["'\`]${esc}["'\`]`, 'i'),            // name: "tool_name"
    new RegExp(`<${esc}\\b`, 'i'),                                    // <tool_name>
    new RegExp(`\\bname\\s*[:=]\\s*${esc}\\b`, 'i'),                  // name: tool_name
  ];
}

function emitVerdictMentioned(output: string): boolean {
  return buildToolNamePatterns('emit_verdict').some((p) => p.test(output));
}

/**
 * Detect a ```kodax-task-verdict``` fenced block in the response text
 * AND verify its body is parseable as a structured verdict payload.
 *
 * Mirrors the structural check parseManagedTaskVerdictDirectiveFromJson
 * would apply if B0 wired the parser into the V2 path. We don't import
 * the actual parser here (the dataset stays self-contained); the regex
 * + JSON.parse approximation is faithful enough for the emission-rate
 * measurement, and the actual B0 unit tests will pin parser correctness
 * with the full helper.
 */
function fencedVerdictBlockParseable(output: string): boolean {
  const fenceMatch = /```kodax-task-verdict\s*([\s\S]*?)```/i.exec(output);
  if (!fenceMatch) return false;
  const body = fenceMatch[1]?.trim() ?? '';
  if (!body) return false;
  try {
    const parsed = JSON.parse(body) as { status?: unknown };
    return (
      typeof parsed?.status === 'string'
      && ['accept', 'revise', 'blocked'].includes(parsed.status.toLowerCase())
    );
  } catch {
    return false;
  }
}

function buildVerdictPresenceJudge(caseId: CaseId): PromptJudge {
  return {
    name: `${caseId}_response_includes_emit_verdict`,
    category: 'correctness',
    judge: (out) => {
      if (emitVerdictMentioned(out)) return { passed: true };
      return {
        passed: false,
        reason:
          'response does not invoke emit_verdict (checked 5 syntax forms). ' +
          'Per anti-pattern 7 §3, MUST be cross-validated by LLM-judge audit ' +
          'before treating the failure rate as decision evidence.',
      };
    },
  };
}

function buildFencedBlockJudge(caseId: CaseId): PromptJudge {
  return {
    name: `${caseId}_response_includes_parseable_fenced_block`,
    category: 'correctness',
    judge: (out) => {
      if (fencedVerdictBlockParseable(out)) return { passed: true };
      return {
        passed: false,
        reason:
          'response does not include a ```kodax-task-verdict``` fenced ' +
          'block with parseable JSON body (status field valid). C3 PASS ' +
          'requires both fence presence AND parser-compatible body.',
      };
    },
  };
}

export function buildJudges(caseId: CaseId): readonly PromptJudge[] {
  const spec = CASES.find((c) => c.id === caseId);
  if (!spec) throw new Error(`unknown case id ${caseId}`);
  switch (spec.assertion) {
    case 'first_tool_call_includes_emit_verdict':
    case 'turn_2_includes_emit_verdict':
      return [buildVerdictPresenceJudge(caseId)];
    case 'response_contains_parseable_fenced_verdict_block':
      return [buildFencedBlockJudge(caseId)];
  }
}
