/**
 * Dataset — FEATURE_166 (v0.7.41 follow-up): post-handoff Evaluator
 * role-label lag empirical incidence probe.
 *
 * ## What this measures
 *
 * Code reading (Layer 1) confirmed the label-lag mechanism:
 * `observer.onRoleEmit('evaluator', recorder)` only fires when
 * `emit_verdict` succeeds — there is no per-agent-switch hook in the
 * Runner. So any Evaluator output BEFORE its first `emit_verdict`
 * tool_call inherits the stale `[Worker]` label.
 *
 * This probe quantifies HOW OFTEN Evaluator emits non-verdict-first
 * content across 5 production aliases. The polarity is one-sided:
 *
 *   PASS (no label-lag surface) — `toolCalls[0].name === 'emit_verdict'`
 *   FAIL (label-lag surfaces)  — any text/thinking before tool_call
 *                                 OR a non-verdict tool_call first
 *
 * Multiple FAIL modes all produce the same UX bug (something gets
 * mislabeled as `[Worker]`), so binary PASS/FAIL is enough.
 *
 * ## Single case, single variant
 *
 * We are NOT comparing two prompts — we are measuring an empirical
 * fact about current production behaviour. Per EVAL_GUIDELINES Layer
 * 2 single-turn probe shape, the design is:
 *
 *   INPUT (fixed): EVALUATOR system prompt + Worker handoff transcript
 *                  + final `<task-completed>` banner as user message
 *   EXPECTED:      First tool_call in response is `emit_verdict`
 *   SAMPLE SIZE:   5 aliases × 5 runs = 25 calls
 *
 * ## Pre-registered decision matrix
 *
 *   必现 (severe):       ≥3/5 aliases × ≥4/5 runs FAIL → ship fix Medium priority
 *   偶现 (intermittent): 1-2/5 aliases × ≥3/5 runs FAIL → Low priority, can defer
 *   不复现 (theoretical): all aliases ≥4/5 runs PASS → close FEATURE_166
 *
 * ## See also
 *
 *   - docs/features/v0.7.41.md §FEATURE_166 — design + acceptance
 *   - tests/feature-166-handoff-label-lag.eval.ts — driver
 *   - tests/feature-166-handoff-label-lag-judge-audit.eval.ts — LLM-judge audit
 *   - benchmark/datasets/feature-165-handoff-wait-gate/cases.ts — sibling pattern
 *     (multi-syntax tool detection via buildToolNamePatterns)
 */

import type { PromptVariant } from '../../harness/harness.js';
import type { PromptJudge } from '../../harness/judges.js';

export type CaseId = 'evaluator_first_response_after_handoff';

export interface CaseSpec {
  readonly id: CaseId;
  readonly polarity: 'must_emit_verdict_first';
  readonly description: string;
}

export const CASES: readonly CaseSpec[] = [
  {
    id: 'evaluator_first_response_after_handoff',
    polarity: 'must_emit_verdict_first',
    description:
      'Evaluator gets control after Worker emit_handoff; canned transcript ' +
      'reflects a simple clean audit task. PASS iff Evaluator\'s first ' +
      'tool_call is emit_verdict (no pre-verdict text / thinking / ' +
      'non-verdict tool_call surfaces the [Worker] label-lag bug).',
  },
] as const;

// ---------------------------------------------------------------------------
// Evaluator system prompt — minimal but production-realistic. Based on
// EVALUATOR_INSTRUCTIONS_FALLBACK (runner-driven.ts:356-360) plus the
// emit_verdict tool docs blurb. We don't snapshot the full production
// role prompt because the probe is about RUNTIME BEHAVIOUR (first
// tool_call shape), not prompt content — the fallback instructions are
// sufficient to invoke Evaluator role identity.
// ---------------------------------------------------------------------------

const EVALUATOR_SYSTEM_PROMPT = [
  'You are Evaluator (KodaX H1 verifier).',
  '',
  'Your role: audit the Worker\'s handoff payload and decide one of:',
  '  - `accept`   — work is correct and complete',
  '  - `revise`   — Worker must fix specific issues you identify',
  '  - `blocked`  — task cannot be completed as scoped',
  '',
  'You MUST call `emit_verdict` exactly once with status set. You MAY ' +
  'call read-only verification tools (read, grep, glob, bash) if you ' +
  'need to confirm the Worker\'s claims, but read-only verification is ' +
  'preferred — the Worker has already done the work; your job is to ' +
  'audit, not redo.',
  '',
  'Available tools:',
  '  `emit_verdict({status: "accept"|"revise"|"blocked", summary?, ' +
    'reason?, findings?[]})` — terminal verdict call.',
  '  `read({path})` / `grep({pattern, path?})` / `glob({pattern})` — ' +
    'read-only file inspection.',
  '  `bash({command})` — read-only verification commands only.',
].join('\n');

// ---------------------------------------------------------------------------
// Canned transcript — simple clean audit case. Worker investigated the
// README and produced a short summary via emit_handoff; Evaluator's
// natural decision is accept (no need to verify). This biases the
// probe TOWARD the easy path where direct emit_verdict is most likely
// — if even the easy path shows label-lag, harder cases are worse.
// ---------------------------------------------------------------------------

function buildScene(): { priorMessages: PromptVariant['priorMessages']; userMessage: string } {
  const priorMessages: PromptVariant['priorMessages'] = [
    {
      role: 'user',
      content:
        'Summarize what `packages/coding/README.md` says about the runner-driven path.',
    },
    {
      role: 'assistant',
      content:
        // Worker's turn (now in Evaluator's transcript view after handoff
        // inputFilter — production behaviour preserves enough context for
        // the Evaluator to audit, this is a realistic shape).
        '[Worker turn] I\'ll plan, read the file, then summarize.\n\n' +
        '<tool_call>todo_update({op:"init", items:[' +
        '{id:"todo_1", content:"Read packages/coding/README.md", activeForm:"Reading README"},' +
        '{id:"todo_2", content:"Extract runner-driven path notes", activeForm:"Extracting notes"}' +
        ']})</tool_call>\n\n' +
        '<tool_call>read({path:"packages/coding/README.md"})</tool_call>\n\n' +
        '[Read result excerpt]\n' +
        '"The runner-driven path is the default since v0.7.38; Worker is ' +
        'the V2 single-loop primary; emit_handoff hands to Evaluator for ' +
        'verification."\n\n' +
        '<tool_call>todo_update({op:"set", id:"todo_1", status:"completed"})</tool_call>\n' +
        '<tool_call>todo_update({op:"set", id:"todo_2", status:"completed"})</tool_call>\n\n' +
        'Plan complete. Both items marked done.\n\n' +
        '<tool_call>emit_handoff({status:"ready", summary:"README summary ' +
        'extracted: runner-driven is default since v0.7.38, Worker is V2 ' +
        'primary, emit_handoff hands to Evaluator.", ' +
        'evidence:[{kind:"file_read", path:"packages/coding/README.md"}]})</tool_call>',
    },
  ];
  const userMessage =
    // Simulates the handoff completion banner the Evaluator's first
    // turn receives. In production this is constructed by the runner
    // after `currentAgent` switches; the exact shape varies by harness
    // but the structural intent is "Worker handed off, here is the
    // payload, please audit and emit verdict".
    'Worker has handed off. Handoff payload:\n\n' +
    '  status:   ready\n' +
    '  summary:  README summary extracted: runner-driven is default since ' +
    'v0.7.38, Worker is V2 primary, emit_handoff hands to Evaluator.\n' +
    '  evidence: [{ kind: "file_read", path: "packages/coding/README.md" }]\n\n' +
    'Audit the payload and call `emit_verdict` with your decision.';
  return { priorMessages, userMessage };
}

export function buildPromptVariants(caseId: CaseId): readonly PromptVariant[] {
  if (caseId !== 'evaluator_first_response_after_handoff') {
    throw new Error(`unknown case id ${caseId}`);
  }
  const scene = buildScene();
  // Single variant — we are measuring current behaviour, not comparing
  // two prompts. Keeping the array shape so the driver matches the
  // FEATURE_165 sibling pattern.
  return [
    {
      id: 'v_current',
      description:
        'Current EVALUATOR_INSTRUCTIONS_FALLBACK + standard tool docs. ' +
        'No prompt change — measuring incidence of pre-verdict text/' +
        'thinking/non-verdict-tool-call across 5 production aliases.',
      systemPrompt: EVALUATOR_SYSTEM_PROMPT,
      priorMessages: scene.priorMessages,
      userMessage: scene.userMessage,
    },
  ];
}

// ---------------------------------------------------------------------------
// Judges — first-tool-call detection.
//
// Anti-pattern 7 §4 multi-syntax tool-name detection: production panel
// emits emit_verdict in `fn-call`, `JSON-in-XML`, `XML-tag`, `half-XML
// half-fn`, and `unquoted-key + quoted-value YAML hybrid` forms.
// `buildToolNamePatterns` mirrors the FEATURE_165 sibling so cross-
// case coverage is consistent.
//
// The regex judge is necessarily approximate: it can detect "did
// emit_verdict appear in the output text" but cannot tell whether it
// was the FIRST tool_call vs a later one. That's why the LLM-judge
// audit (anti-pattern 7 §3) is mandatory for this dataset — only the
// human-readable judgement can tell "first tool_call IS emit_verdict"
// vs "emit_verdict appeared after pre-verdict text/thinking".
//
// The regex judge here optimises for the dominant FAIL mode: response
// contains pre-verdict text WITH OR WITHOUT a later emit_verdict. We
// use a stricter heuristic: PASS iff the FIRST `<tool_call>` /
// function-call syntactic marker in the output names emit_verdict.
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

/**
 * Find the byte offset of the FIRST plausible tool-call invocation in
 * the response text, paired with the tool's name. Returns undefined
 * when no syntactic tool-call marker is present (the response is
 * pure text or pure thinking).
 *
 * This is intentionally over-broad on syntax — we accept any of the 5
 * tool-call envelopes from the FEATURE_165 / FEATURE_120 dataset
 * heritage. The judge logic below uses this position to decide whether
 * `emit_verdict` is FIRST or whether something else preceded it.
 */
function findFirstToolCall(
  output: string,
  toolNames: readonly string[],
): { name: string; offset: number } | undefined {
  let earliest: { name: string; offset: number } | undefined;
  for (const name of toolNames) {
    const patterns = buildToolNamePatterns(name);
    for (const p of patterns) {
      const m = p.exec(output);
      if (m && m.index >= 0) {
        if (!earliest || m.index < earliest.offset) {
          earliest = { name, offset: m.index };
        }
      }
    }
  }
  return earliest;
}

/**
 * Tool names the Evaluator can syntactically invoke first.
 *   - emit_verdict: PASS path
 *   - read / grep / glob / bash: pre-verify (FAIL — surfaces label-lag)
 *   - emit_handoff: shouldn't appear (Evaluator can't hand off), but
 *     if it does, that's also a FAIL.
 */
const EVALUATOR_TOOLS: readonly string[] = [
  'emit_verdict',
  'read',
  'grep',
  'glob',
  'bash',
  'emit_handoff',
];

function buildVerdictFirstJudge(caseId: CaseId): PromptJudge {
  return {
    name: `${caseId}_verdict_is_first_tool_call`,
    category: 'correctness',
    judge: (out) => {
      const first = findFirstToolCall(out, EVALUATOR_TOOLS);
      if (!first) {
        // No tool call at all — pure text / thinking response. This
        // is a FAIL (the entire response would show [Worker] label).
        return {
          passed: false,
          reason:
            'response has NO tool_call — pure text/thinking would render ' +
            'entirely under stale [Worker] label until next slot tool fires',
        };
      }
      if (first.name === 'emit_verdict') {
        // Check there is no text/thinking BEFORE the emit_verdict
        // marker. Some pre-marker whitespace / newlines are fine, but
        // substantive natural-language text before it surfaces the
        // label-lag too.
        const before = out.slice(0, first.offset).trim();
        if (before.length === 0) return { passed: true };
        // Heuristic: ≥ 80 chars of leading prose / thinking is enough
        // to be visible to the user under [Worker] label. The 80-char
        // threshold is tuned empirically — short framing like "Verdict:"
        // or "OK." (≤ 80 chars) is fine.
        if (before.length < 80) return { passed: true };
        return {
          passed: false,
          reason:
            `emit_verdict is the first tool_call but ${before.length} chars ` +
            `of leading text/thinking precede it — that text renders under ` +
            `the stale [Worker] label`,
        };
      }
      return {
        passed: false,
        reason:
          `first tool_call is "${first.name}" (offset ${first.offset}), ` +
          `not emit_verdict — pre-verdict tool call surfaces [Worker] ` +
          `label-lag on this and any later text/thinking until emit_verdict ` +
          `eventually fires`,
      };
    },
  };
}

export function buildJudges(caseId: CaseId): readonly PromptJudge[] {
  const spec = CASES.find((c) => c.id === caseId);
  if (!spec) throw new Error(`unknown case id ${caseId}`);
  return [buildVerdictFirstJudge(caseId)];
}
