/**
 * Dataset — FEATURE_185 ledger recall pilot (2026-05-20)
 *
 * **Status**: Pilot stage. Validates whether the LLM, when given a
 * post-compact ledger summary containing structured hits/tail in the
 * system prompt, can answer questions directly from the ledger instead
 * of re-running the underlying tool (re-grep / re-bash).
 *
 * **Background**: FEATURE_185 commits 1-3 extend the artifactLedger so
 * that grep/code_search hits + bash exit_code/tail survive past
 * microcompact in `metadata`. Post-compact attachment renders these as
 * a `[Post-compact: recent operations]` system message. The infrastructure
 * works (unit + integration tests confirm). The remaining question is
 * behavioural: does the LLM actually USE this ledger to short-circuit
 * tool calls, or does it ignore the system message and re-run anyway?
 *
 * **EVAL_GUIDELINES Layer**: Layer 2 single-turn probe — fire one
 * (system + user) pair where the system contains a realistic
 * post-compact ledger, the user asks a question whose answer is
 * literally in the ledger, and we observe whether the model:
 *   - cites the ledger (PASS)
 *   - calls grep/bash to re-derive (FAIL — model ignored ledger)
 *
 * **Layer 1 check first**: NO — whether a model utilises injected
 * system-prompt context is a behavioural-distribution question, not
 * answerable by code inspection.
 *
 * **Pilot topology**: 1 alias (ds/v4flash) × 2 cases × 1 run = 2 calls
 *                     (~$0.01).
 * **Scale topology** (post-pilot, only if pilot validates): 5 alias × 2
 * cases × 5 runs = 50 calls (~$0.50).
 *
 * **Pre-registered pilot gate** (frozen before any pilot run):
 *   - PILOT MUST yield ≥1/2 cases with `passKeyword` match on ds/v4flash.
 *   - If pilot fails BOTH cases: ledger format is likely too dense /
 *     poorly placed — refine system-prompt insertion before scale.
 *   - If pilot passes ≥1: proceed to scale to characterise per-alias
 *     behaviour.
 *
 * **Scale gate** (pre-registered):
 *   - SHIP if ≥4/5 alias have ledger-cite rate ≥ 60% across both cases.
 *   - PARTIAL ship if ≥3/5 alias clear the bar — note which alias has
 *     structural floor in known-issues.
 *   - DEFER if ≥3/5 alias have ledger-cite rate < 60% — investigate
 *     ledger-format / system-prompt-position fixes before promoting.
 *
 * **Why content-grounded keywords matter** (re. lenient-positive-
 * keyword discipline): each case's `passKeywords` is a specific
 * `path:line` token that literally appears in the ledger and CANNOT
 * be produced without consulting the ledger. Generic phrases like
 * "I found" / "located" / "matches" would be inadequate — the model
 * could emit them while ignoring the ledger.
 *
 * **Why we expose grep + bash tools**: a model that ignores the ledger
 * can demonstrate the failure mode by calling the underlying tool.
 * If we hid the tools, the model would have no choice but to cite —
 * we wouldn't learn whether the ledger is genuinely persuasive.
 */

import type { KodaXMessage, KodaXToolDefinition } from '@kodax-ai/llm';

export interface LedgerRecallCase {
  /** Stable id used in dump filenames. */
  readonly id: string;
  /** Short description for logs. */
  readonly description: string;
  /** Full system prompt including post-compact ledger block. */
  readonly systemPrompt: string;
  /** User message asking a question answerable from the ledger. */
  readonly userMessage: string;
  /**
   * Content-grounded keywords. Any one match counts as PASS-text — they
   * are specific `path:line` references that literally appear in the
   * ledger and cannot be produced via guessing.
   */
  readonly passKeywords: readonly string[];
  /**
   * Tool names whose invocation signals FAIL (the model ignored the
   * ledger and went to re-derive). Empty array = "any tool use other
   * than respond" implicitly counts as FAIL.
   */
  readonly failToolNames: readonly string[];
}

/** Common system header — minimal coding-agent persona so the model
 *  has reasonable defaults but no extra instructions about ledger
 *  use. We want to measure baseline ledger-utilisation, not test a
 *  prompt that aggressively tells the model "USE THE LEDGER". */
const SYSTEM_HEADER = `You are a coding assistant. When the user asks a question, prefer to answer from the conversation context already provided. Only invoke tools when the context is insufficient.

Tools available: grep, bash. Use them sparingly.

[对话历史摘要]
The user was investigating authentication flow. Earlier in the session you grep'd for "authenticate" across the source tree and ran npm test to check the lint status. The user is now asking follow-up questions.

`;

/** Grep ledger fixture — formatted exactly like `renderLedgerSummary`
 *  post-compact output for a grep entry with hits in metadata. Mirrors
 *  `post-compact.ts:FEATURE_185` rendering: `path:line "preview"`.
 *  Pilot 1 (2026-05-20) on ds/v4flash showed that without preview
 *  text, the model re-greps to disambiguate def vs use — preview
 *  rendering is the production fix that this fixture co-evolves with. */
const POST_COMPACT_GREP = `[Post-compact: recent operations]
Read: src/auth.ts, src/login.ts, src/session.ts
Search: grep "authenticate" src/ → 3 hits: src/auth.ts:42 "function authenticate(user) {", src/auth.ts:78 "await authenticate(req.user);", src/login.ts:13 "import { authenticate } from \\"../auth\\";"
Commands: npm test --coverage`;

/** Bash ledger fixture — exit 1 + tail (failed lint). */
const POST_COMPACT_BASH = `[Post-compact: recent operations]
Read: package.json, src/foo.ts
Commands: npm run lint (exit 1) tail: "ESLint found 3 problems | src/foo.ts:42:5 error  unused-vars | src/bar.ts:13:9 error  no-implicit-any | src/baz.ts:8:1 error  no-unused-imports"`;

export const TOOLS: readonly KodaXToolDefinition[] = [
  {
    name: 'grep',
    description: 'Search file contents for a regex pattern. Returns matching lines.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        path: { type: 'string', description: 'File or directory to search in' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'bash',
    description: 'Execute a bash command. Returns stdout + exit code.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to execute' },
      },
      required: ['command'],
    },
  },
];

export const CASES: readonly LedgerRecallCase[] = [
  {
    id: 'A1_grep_recall',
    description: 'Model should cite path:line from ledger instead of re-grepping',
    systemPrompt: SYSTEM_HEADER + POST_COMPACT_GREP,
    userMessage:
      'Where is the `authenticate` function defined? Just tell me the path and line — '
      + 'I want to navigate there, not re-search.',
    // Content-grounded: these specific path:line tokens are literally in
    // the ledger and cannot be hallucinated.
    passKeywords: ['auth.ts:42', 'auth.ts:78', 'login.ts:13'],
    failToolNames: ['grep'],
  },
  {
    id: 'B1_bash_recall',
    description: 'Model should recall lint failure from ledger without re-running npm',
    systemPrompt: SYSTEM_HEADER + POST_COMPACT_BASH,
    userMessage:
      'Did the lint pass last time we ran it? If not, which files have errors?',
    // Content-grounded matchers. Two flavours:
    //   (a) `path:line` direct match (some models echo verbatim)
    //   (b) ESLint rule names lifted verbatim from the ledger tail —
    //       impossible to produce without having read the tail
    //       (`unused-vars` / `no-implicit-any` / `no-unused-imports`).
    // Multiple variants of (a) because models reformat into tables /
    // bullet lists, splitting the original `foo.ts:42:5` into
    // `foo.ts | 42:5` etc. Pilot 1 (2026-05-20) on ds/v4flash showed
    // a perfect markdown-table cite of `src/foo.ts | 42:5 | unused-vars`
    // that the original strict `foo.ts:42` keyword missed — regex-
    // tightening per `feedback_regex_audit_per_new_eval`.
    passKeywords: [
      'unused-vars',
      'no-implicit-any',
      'no-unused-imports',
      'foo.ts:42',
      'bar.ts:13',
      'baz.ts:8',
      'exit 1',
    ],
    failToolNames: ['bash'],
  },
];

export interface ClassifiedResult {
  /** Any failToolName was invoked. */
  readonly invokedDerivativeTool: boolean;
  /** Any passKeyword found in response text (case-insensitive). */
  readonly citedLedger: boolean;
  /** Which passKeyword(s) matched (lowercase). */
  readonly matchedKeywords: readonly string[];
  /** Which fail-tool was invoked, if any. */
  readonly invokedToolName?: string;
  /** Primary PASS decision: cited AND no derivative tool. */
  readonly primaryPassed: boolean;
}

/**
 * Normalise a response for keyword matching. Strips markdown formatting
 * and rewrites common "path-then-line" phrasings to the canonical
 * `path:line` form so a single keyword like `auth.ts:42` catches all of:
 *   - `auth.ts:42`
 *   - `**auth.ts**, line 42`
 *   - ``\`auth.ts\` at line 42``
 *   - `src/auth.ts, line **42**`
 *
 * Scale run 1 (2026-05-20) on ds/v4flash + ds/v4pro showed every A1
 * answer was a correct cite phrased in markdown rather than `:N` —
 * lifting the disagreement floor below the SHIP gate. Regex-audit per
 * `feedback_regex_audit_per_new_eval` motivated this normalisation.
 */
function normaliseForCite(text: string): string {
  let out = text;
  // Strip markdown formatting characters that fragment path:line tokens.
  out = out.replace(/[*`_]+/g, '');
  // Rewrite "at line N" / ", line N" / " line N" → ":N"
  // Comma-separated form `path, line N` is common in chat models — the
  // `,?` lets the same rule swallow the comma so the resulting token
  // is `path:N` (not `path,:N`).
  out = out.replace(/,?\s+(?:at\s+)?line\s+(\d+)/gi, ':$1');
  // Rewrite "(at line N)" too
  out = out.replace(/\(\s*(?:at\s+)?line\s+(\d+)\s*\)/gi, ':$1');
  // Rewrite trailing comma+digits with optional " line" already stripped.
  return out.toLowerCase();
}

export function classifyResponse(
  c: LedgerRecallCase,
  responseText: string,
  toolCalls: ReadonlyArray<{ name: string; input: unknown }>,
): ClassifiedResult {
  const directLower = responseText.toLowerCase();
  const normalised = normaliseForCite(responseText);
  const matched = c.passKeywords.filter((kw) => {
    const kwLower = kw.toLowerCase();
    return directLower.includes(kwLower) || normalised.includes(kwLower);
  });
  const failToolHit = toolCalls.find((t) => c.failToolNames.includes(t.name));
  return {
    invokedDerivativeTool: failToolHit !== undefined,
    citedLedger: matched.length > 0,
    matchedKeywords: matched.map((kw) => kw.toLowerCase()),
    invokedToolName: failToolHit?.name,
    primaryPassed: matched.length > 0 && failToolHit === undefined,
  };
}

/** Helper for the driver — build prior messages (empty here, the entire
 *  context lives in system + user). Kept as a stable hook in case future
 *  cases need a multi-turn prior. */
export function buildPriorMessages(_c: LedgerRecallCase): readonly KodaXMessage[] {
  return [];
}
