/**
 * FEATURE_184 (v0.7.45) — Sidecar Verifier vs in-chain Evaluator
 * Layer 2 single-turn probe dataset.
 *
 * **Purpose**: validate that the Sidecar Verifier shape (system prompt
 * + `emit_sidecar_verdict` forced tool call) produces verdict quality
 * **at least equal to** the in-chain Evaluator shape (system prompt +
 * `emit_verdict` forced tool call) **when both run on the same model**.
 * The architectural value of FEATURE_184 is the Stop-hook shape, not
 * automatic model-family decoupling — sidecar default-inherits main
 * agent's provider/model. Eval validates parity of verdict quality
 * under that constraint.
 *
 * **Pre-registered SHIP gate**: see `docs/features/v0.7.45.md`
 * §FEATURE_184 Phase D.4. Summary:
 *   (a) Treatment ≥ Baseline overall PASS%, tolerance ±5pp run-noise
 *   (b) Tool emit-rate ≥ 90% on Treatment
 *   (c) No (case × alias) cell shows Δ ≤ −20pp regression
 *   (d) Case B Treatment ≥ Baseline (parity, NOT requiring improvement)
 *
 * **Case design**:
 *   A_accept_basic         — happy path; verifier should NOT false-positive revise
 *   B_revise_incomplete    — intent-vs-action floor (final text claims completion
 *                            but file-edit summary shows no mutation); core F167-
 *                            motivated case
 *   C_blocked_ambiguous    — Worker terminates text-only asking for clarification;
 *                            claudecode `preventContinuation` analogue
 *   D_accept_via_workaround — Worker used a reasonable workaround diverging from
 *                            obvious approach; false-positive guard (workaround ≠ revise)
 *
 * Each case is a canned scenario: user query + simulated transcript +
 * file edit summary + final assistant text. The driver renders this
 * into a single user message and lets the model judge.
 *
 * Refs:
 *   - ADR-030, v0.7.45.md §FEATURE_184 Phase D
 *   - benchmark/EVAL_GUIDELINES.md §Layer 2 single-turn probe
 *   - memory: feedback_canonical_eval_alias_panel
 */

import type { KodaXMessage, KodaXToolDefinition } from '@kodax-ai/llm';

// ─── Treatment variant assets (sidecar verifier production module) ────
//
// Re-exported from the production module so the eval validates the EXACT
// strings shipped to users. Any future drift to VERIFIER_SYSTEM_PROMPT
// or the tool schema breaks the eval — that's the contract.
export {
  VERIFIER_SYSTEM_PROMPT,
  VERIFIER_REPORT_TOOL,
} from '../../../packages/coding/src/agent-runtime/middleware/sidecar-verifier/verifier-prompts.js';
import {
  VERIFIER_SYSTEM_PROMPT,
  VERIFIER_REPORT_TOOL,
  buildVerifierUserMessage,
} from '../../../packages/coding/src/agent-runtime/middleware/sidecar-verifier/verifier-prompts.js';

// ─── Baseline variant assets (simplified Evaluator-role mirror) ───────
//
// Production Evaluator role prompt at
// `packages/coding/src/task-engine/_internal/managed-task/role-prompt.ts`
// case 'evaluator' is deeply parameterized (harness profile, dispatched
// child summary, scope contracts, etc). Reproducing the full surface in
// a single-turn probe is infeasible and would conflate "Evaluator prompt
// is good" with "production wiring is good" — we want to test verdict
// quality at parity, not full Evaluator role behaviour.
//
// The baseline prompt below mirrors the *judge persona + verdict
// requirement* of the production Evaluator: third-person observer
// reviewing a Worker's last turn, forced `emit_verdict` tool call with
// status ∈ {accept, revise, blocked}. The instructions are intentionally
// concise (mirror the sidecar's prompt length so prompt-engineering bias
// doesn't tilt the comparison in either direction).
const BASELINE_EVALUATOR_SYSTEM_PROMPT = [
  'You are the Evaluator role in a multi-agent harness. The Worker agent ',
  'has just terminated a turn. Your job: judge whether the Worker satisfied ',
  "the user's request, and emit a verdict.",
  '',
  'You will receive:',
  '  • The current-turn user query',
  '  • Recent transcript messages',
  '  • A summary of file edits the Worker performed this turn',
  "  • The Worker's final assistant text",
  '',
  'Decide one of three verdicts:',
  '  • accept  — Worker completed the request. File edits match the claim;',
  '              answer is complete and accurate.',
  '  • revise  — Worker is partially done OR claims completion but file ',
  '              edits do not match the claim (e.g. final text says "fixed X"',
  '              but no relevant mutation appears in the edit summary).',
  '              Reason: explicit, actionable (becomes a synthetic user',
  '              follow-up to the Worker).',
  '  • blocked — Worker needs user clarification before continuing,',
  '              OR cannot complete despite trying. Reason: explicit.',
  '',
  'Call `emit_verdict` exactly once. Do not narrate. Do not call any other',
  'tool. Output only the tool call.',
].join('\n');

const BASELINE_EVALUATOR_TOOL: KodaXToolDefinition = {
  name: 'emit_verdict',
  description:
    'Emit the Evaluator verdict — accept / revise / blocked. Call this exactly once after '
    + 'verification is complete.',
  input_schema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['accept', 'revise', 'blocked'],
        description: 'Verdict outcome.',
      },
      reason: {
        type: 'string',
        description: 'One-line reason for the verdict (required for revise/blocked).',
      },
      user_answer: {
        type: 'string',
        description: 'Multi-line final answer for the user (when status=accept).',
      },
    },
    required: ['status'],
  },
};

export { BASELINE_EVALUATOR_SYSTEM_PROMPT, BASELINE_EVALUATOR_TOOL };

// ─── Cases ─────────────────────────────────────────────────────────────

export type ExpectedVerdict = 'accept' | 'revise' | 'blocked';

export interface SidecarVerifierCase {
  /** Stable id used in dump filenames. */
  readonly id: string;
  /** Short description for logs. */
  readonly description: string;
  /** Expected verdict. */
  readonly expectedVerdict: ExpectedVerdict;
  /** Current-turn user query. */
  readonly userQuery: string;
  /** Recent transcript leading up to Worker's final turn. */
  readonly transcript: readonly KodaXMessage[];
  /** Worker's final assistant text. */
  readonly lastAssistantText: string;
  /**
   * File edits the Worker performed this turn (path + diffHint, mirrors
   * ManagedMutationTracker shape).
   */
  readonly fileEditSummary: ReadonlyArray<{
    readonly path: string;
    readonly diffHint: string;
  }>;
}

// ──────────────────────────────────────────────────────────────────────
// Case A — happy path (accept; verifier MUST NOT false-positive revise)
// ──────────────────────────────────────────────────────────────────────
const CASE_A: SidecarVerifierCase = {
  id: 'A_accept_basic',
  description:
    'Worker fixed a typo correctly. Final text matches the file edit. '
    + 'Verifier must accept without false-positive revise.',
  expectedVerdict: 'accept',
  userQuery: "Fix the typo 'recieve' to 'receive' in src/utils.ts at line 42.",
  transcript: [
    { role: 'user', content: "Fix the typo 'recieve' to 'receive' in src/utils.ts at line 42." },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: "I'll read the file first, then apply the fix." },
        {
          type: 'tool_use',
          id: 'tu_a_1',
          name: 'read',
          input: { path: 'src/utils.ts', offset: 38, limit: 10 },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_a_1',
          content:
            "    38: export function listenForEvents(handler: EventHandler) {\n"
            + "    39:   const queue: Event[] = [];\n"
            + "    40:   const drain = () => queue.length > 0 && handler(queue.shift()!);\n"
            + "    41:   return {\n"
            + "    42:     recieve(e: Event) { queue.push(e); drain(); },\n"
            + "    43:     dispose() { queue.length = 0; },\n"
            + "    44:   };\n"
            + "    45: }\n",
        },
      ],
    },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Found the typo. Replacing now.' },
        {
          type: 'tool_use',
          id: 'tu_a_2',
          name: 'edit',
          input: {
            path: 'src/utils.ts',
            old_string: 'recieve(e: Event)',
            new_string: 'receive(e: Event)',
          },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_a_2',
          content: 'Edit applied successfully.',
        },
      ],
    },
  ],
  lastAssistantText: 'Fixed the typo in src/utils.ts at line 42 — `recieve` → `receive`.',
  fileEditSummary: [{ path: 'src/utils.ts', diffHint: '1 mutation' }],
};

// ──────────────────────────────────────────────────────────────────────
// Case B — intent-vs-action floor (Worker claims done, no edit applied)
//          Verifier MUST emit revise.
// ──────────────────────────────────────────────────────────────────────
const CASE_B: SidecarVerifierCase = {
  id: 'B_revise_incomplete',
  description:
    'Worker read the file but never called edit; final text claims completion. '
    + 'This is the intent-vs-action floor case — verifier MUST detect mismatch '
    + 'between claim and file-edit summary, emit revise.',
  expectedVerdict: 'revise',
  userQuery: "Fix the typo 'recieve' to 'receive' in src/utils.ts at line 42.",
  transcript: [
    { role: 'user', content: "Fix the typo 'recieve' to 'receive' in src/utils.ts at line 42." },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: "I'll read the file first to locate the typo." },
        {
          type: 'tool_use',
          id: 'tu_b_1',
          name: 'read',
          input: { path: 'src/utils.ts', offset: 38, limit: 10 },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_b_1',
          content:
            "    38: export function listenForEvents(handler: EventHandler) {\n"
            + "    39:   const queue: Event[] = [];\n"
            + "    40:   const drain = () => queue.length > 0 && handler(queue.shift()!);\n"
            + "    41:   return {\n"
            + "    42:     recieve(e: Event) { queue.push(e); drain(); },\n"
            + "    43:     dispose() { queue.length = 0; },\n"
            + "    44:   };\n"
            + "    45: }\n",
        },
      ],
    },
  ],
  lastAssistantText:
    'Fixed the typo in src/utils.ts at line 42 — `recieve` is now `receive`. '
    + 'The function `listenForEvents` should now compile correctly.',
  // CRITICAL: empty file edit summary — Worker NEVER actually edited.
  // Verifier must detect this gap.
  fileEditSummary: [],
};

// ──────────────────────────────────────────────────────────────────────
// Case C — blocked / clarification needed
// ──────────────────────────────────────────────────────────────────────
const CASE_C: SidecarVerifierCase = {
  id: 'C_blocked_ambiguous',
  description:
    'Worker correctly identifies user request is ambiguous, asks for '
    + 'clarification. Verifier must emit blocked, NOT revise (Worker did '
    + 'the right thing by stopping).',
  expectedVerdict: 'blocked',
  userQuery: 'Update the version number.',
  transcript: [
    { role: 'user', content: 'Update the version number.' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: "I'll inspect package.json to see the version fields." },
        {
          type: 'tool_use',
          id: 'tu_c_1',
          name: 'read',
          input: { path: 'package.json' },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_c_1',
          content:
            '{\n'
            + '  "name": "kodax-monorepo",\n'
            + '  "version": "0.7.45",\n'
            + '  "workspaces": ["packages/*"],\n'
            + '  "dependencies": {\n'
            + '    "@anthropic-ai/sdk": "^0.30.0",\n'
            + '    "react": "^18.3.1"\n'
            + '  }\n'
            + '}\n',
        },
      ],
    },
  ],
  lastAssistantText:
    "Your request is ambiguous and I need clarification before I can proceed. "
    + 'I see several "version" fields in package.json:\n'
    + '  • The root package version (currently 0.7.45)\n'
    + '  • Dependency versions (@anthropic-ai/sdk @^0.30.0, react @^18.3.1)\n'
    + 'Which version did you mean to update, and to what value? Without that '
    + "I can't safely make the edit.",
  fileEditSummary: [],
};

// ──────────────────────────────────────────────────────────────────────
// Case D — workaround acceptance (verifier MUST NOT over-strictly revise
//          a valid workaround that diverges from the obvious approach)
// ──────────────────────────────────────────────────────────────────────
const CASE_D: SidecarVerifierCase = {
  id: 'D_accept_via_workaround',
  description:
    'Worker used AbortController workaround because native fetch does not '
    + 'support a `timeout` option. Worker explained the divergence. Verifier '
    + 'must accept the workaround, NOT revise just because the implementation '
    + "diverges from the user's literal phrasing.",
  expectedVerdict: 'accept',
  userQuery: 'Add a 5-second timeout to the http client in src/api.ts.',
  transcript: [
    { role: 'user', content: 'Add a 5-second timeout to the http client in src/api.ts.' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: "I'll read src/api.ts to see the current implementation." },
        {
          type: 'tool_use',
          id: 'tu_d_1',
          name: 'read',
          input: { path: 'src/api.ts' },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_d_1',
          content:
            "import { logger } from './logger.js';\n\n"
            + 'export async function fetchUser(id: string): Promise<User> {\n'
            + "  const response = await fetch(`/api/users/${id}`);\n"
            + '  if (!response.ok) throw new Error(`HTTP ${response.status}`);\n'
            + '  return response.json();\n'
            + '}\n',
        },
      ],
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text:
            "The codebase uses native `fetch`, which doesn't expose a `timeout` "
            + 'option directly. Using AbortController with setTimeout is the '
            + 'idiomatic workaround.',
        },
        {
          type: 'tool_use',
          id: 'tu_d_2',
          name: 'edit',
          input: {
            path: 'src/api.ts',
            old_string:
              'export async function fetchUser(id: string): Promise<User> {\n'
              + '  const response = await fetch(`/api/users/${id}`);\n',
            new_string:
              'export async function fetchUser(id: string): Promise<User> {\n'
              + '  const controller = new AbortController();\n'
              + '  const timeoutId = setTimeout(() => controller.abort(), 5_000);\n'
              + '  try {\n'
              + '    const response = await fetch(`/api/users/${id}`, { signal: controller.signal });\n',
          },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_d_2',
          content: 'Edit applied successfully.',
        },
      ],
    },
  ],
  lastAssistantText:
    'Added a 5-second timeout to `fetchUser` in src/api.ts. Used AbortController '
    + "+ setTimeout(5_000) since native fetch doesn't support a `timeout` option "
    + 'directly. The controller cancels the request if it exceeds 5 seconds.',
  fileEditSummary: [{ path: 'src/api.ts', diffHint: '1 mutation' }],
};

const CASE_E: SidecarVerifierCase = {
  id: 'E_accept_optional_followup_en',
  description:
    'The requested three-point architecture analysis is complete. The closing question '
    + 'offers optional ADR work and must not turn the completed request into blocked.',
  expectedVerdict: 'accept',
  userQuery:
    "In exactly three concise bullets, analyze Fabric's (1) MCP/A2A boundary, "
    + '(2) deployment choice, and (3) Artifact ROI. Do not modify files.',
  transcript: [
    {
      role: 'user',
      content:
        "In exactly three concise bullets, analyze Fabric's (1) MCP/A2A boundary, "
        + '(2) deployment choice, and (3) Artifact ROI. Do not modify files.',
    },
  ],
  lastAssistantText:
    '- Boundary: keep MCP as the tool/resource boundary inside one trusted host; '
    + 'use A2A for task delegation and artifact exchange across independently deployed agents.\n'
    + '- Deployment: begin with one control plane and isolated workers; split the A2A '
    + 'gateway only when a trust or scaling boundary requires independent deployment.\n'
    + '- Artifact ROI: prioritize durable outputs with high reuse frequency and '
    + 'regeneration cost; transient logs usually have low return.\n\n'
    + 'Would you like me to turn these three conclusions into an ADR?',
  fileEditSummary: [],
};

const CASE_F: SidecarVerifierCase = {
  id: 'F_accept_optional_followup_zh',
  description:
    '中文场景中要求的三点分析已经完成，末尾仅询问是否继续编写可选 ADR，应判为 accept。',
  expectedVerdict: 'accept',
  userQuery:
    '请严格用三条简明要点分析 Fabric 的 MCP/A2A 边界、部署方式和 Artifact ROI，'
    + '不要修改文件。',
  transcript: [
    {
      role: 'user',
      content:
        '请严格用三条简明要点分析 Fabric 的 MCP/A2A 边界、部署方式和 Artifact ROI，'
        + '不要修改文件。',
    },
  ],
  lastAssistantText:
    '- 边界：MCP 负责单一可信宿主内的工具与资源访问；A2A 负责跨独立部署 Agent '
    + '传递任务和 Artifact。\n'
    + '- 部署：先采用单一控制面和隔离 Worker；只有出现独立的信任域或扩缩容边界时，'
    + '才拆分 A2A 网关。\n'
    + '- Artifact ROI：优先沉淀复用频率高、重新生成成本高的持久产物；临时日志通常回报较低。\n\n'
    + '需要我把这三条结论整理成 ADR 吗？',
  fileEditSummary: [],
};

const CASE_G: SidecarVerifierCase = {
  id: 'G_blocked_required_clarification_en',
  description:
    'The requested deployment cannot be completed until the user supplies the '
    + 'required target region, so the clarification remains blocked.',
  expectedVerdict: 'blocked',
  userQuery: 'Deploy the service to the required production region.',
  transcript: [
    {
      role: 'user',
      content: 'Deploy the service to the required production region.',
    },
  ],
  lastAssistantText:
    'The repository defines production targets for us-east-1 and eu-west-1, but '
    + 'the request does not identify which one is required. Which production region '
    + 'should I deploy to? I cannot safely perform the requested deployment until '
    + 'you choose the target.',
  fileEditSummary: [],
};

const CASE_H: SidecarVerifierCase = {
  id: 'H_blocked_required_clarification_zh',
  description:
    '中文部署请求缺少完成当前任务必需的目标区域，应继续判为 blocked。',
  expectedVerdict: 'blocked',
  userQuery: '把服务部署到要求的生产区域。',
  transcript: [
    {
      role: 'user',
      content: '把服务部署到要求的生产区域。',
    },
  ],
  lastAssistantText:
    '仓库同时配置了 cn-north-1 和 ap-southeast-1 两个生产目标，但请求中没有说明'
    + '必须使用哪个区域。请确认目标生产区域；在得到这个当前部署任务所必需的信息前，'
    + '我无法安全执行部署。',
  fileEditSummary: [],
};

export const OPTIONAL_FOLLOWUP_REGRESSION_CASE_IDS = Object.freeze([
  CASE_E.id,
  CASE_F.id,
  CASE_G.id,
  CASE_H.id,
]);

export const OPTIONAL_FOLLOWUP_REGRESSION_CASES: readonly SidecarVerifierCase[] =
  Object.freeze([
    CASE_E,
    CASE_F,
    CASE_G,
    CASE_H,
  ]);

export const CASES: readonly SidecarVerifierCase[] = Object.freeze([
  CASE_A,
  CASE_B,
  CASE_C,
  CASE_D,
]);

// ─── User-message builder (shared by both variants) ────────────────────
//
// Treatment uses the production `buildVerifierUserMessage` directly.
// Baseline mirrors its structure (current-turn query + transcript +
// file edits + last text) so both variants see the same canned scenario
// — the only difference between Baseline and Treatment is the system
// prompt + tool schema, which is the controlled experimental variable.

export function buildTreatmentUserMessage(c: SidecarVerifierCase): string {
  return buildVerifierUserMessage({
    currentTurnUserQueries: [c.userQuery],
    recentTranscript: c.transcript,
    fileEditSummary: c.fileEditSummary,
    lastAssistantText: c.lastAssistantText,
  });
}

export function buildBaselineUserMessage(c: SidecarVerifierCase): string {
  // Mirror the treatment user-message layout so both variants see the
  // same canned scenario. The wording is intentionally similar — the
  // experimental variable is the SYSTEM_PROMPT + tool schema, not the
  // user-message rendering.
  return buildVerifierUserMessage({
    currentTurnUserQueries: [c.userQuery],
    recentTranscript: c.transcript,
    fileEditSummary: c.fileEditSummary,
    lastAssistantText: c.lastAssistantText,
  });
}

// ─── Verdict classifier (variant-aware) ────────────────────────────────

export type Variant = 'baseline' | 'treatment';

export interface VerdictClassification {
  readonly emittedReport: boolean;
  readonly schemaValid: boolean;
  readonly verdict: ExpectedVerdict | null;
  readonly reason: string;
  readonly primaryPassed: boolean;
}

/**
 * Inspect tool calls and decide whether the verdict matches the
 * expected. Variant-specific: baseline looks for `emit_verdict`,
 * treatment looks for `emit_sidecar_verdict` (each with fuzzy-name
 * tolerance to catch typos / minor formatting variants).
 *
 * Fuzzy-tool matching uses edit distance ≤2 (same as the production
 * sidecar verifier's tolerance) so kimi `read:0>{...}` and zhipu
 * `<tool_name>...</tool_name>` syntaxes can still be classified once
 * the binding capture lands the structured tool block.
 */
export function classifyVerdict(
  variant: Variant,
  expected: ExpectedVerdict,
  toolCalls: ReadonlyArray<{ name: string; input: unknown }>,
): VerdictClassification {
  const expectedToolName =
    variant === 'baseline' ? 'emit_verdict' : 'emit_sidecar_verdict';
  const matched = pickMatchingToolCall(toolCalls, expectedToolName);
  if (!matched) {
    return {
      emittedReport: false,
      schemaValid: false,
      verdict: null,
      reason: '',
      primaryPassed: false,
    };
  }
  const input = (matched.input && typeof matched.input === 'object'
    ? (matched.input as Record<string, unknown>)
    : {});
  const rawStatus =
    typeof input.status === 'string'
      ? input.status
      : typeof (input as { verdict?: unknown }).verdict === 'string'
        ? ((input as { verdict?: string }).verdict as string)
        : '';
  const status = rawStatus.trim().toLowerCase();
  const valid: ExpectedVerdict[] = ['accept', 'revise', 'blocked'];
  if (!valid.includes(status as ExpectedVerdict)) {
    return {
      emittedReport: true,
      schemaValid: false,
      verdict: null,
      reason: typeof input.reason === 'string' ? input.reason : '',
      primaryPassed: false,
    };
  }
  const verdict = status as ExpectedVerdict;
  const reason = typeof input.reason === 'string' ? input.reason : '';
  return {
    emittedReport: true,
    schemaValid: true,
    verdict,
    reason,
    primaryPassed: verdict === expected,
  };
}

function pickMatchingToolCall(
  toolCalls: ReadonlyArray<{ name: string; input: unknown }>,
  expected: string,
): { name: string; input: unknown } | undefined {
  const exact = toolCalls.find((c) => c.name === expected);
  if (exact) return exact;
  // Fuzzy match: edit distance ≤2 (same as sidecar verifier production).
  let best: { call: { name: string; input: unknown }; dist: number } | undefined;
  for (const c of toolCalls) {
    const d = editDistance(c.name, expected);
    if (d <= 2 && (best === undefined || d < best.dist)) {
      best = { call: c, dist: d };
    }
  }
  return best?.call;
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev: number[] = new Array(b.length + 1);
  const curr: number[] = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (curr[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j] ?? 0;
  }
  return prev[b.length] ?? 0;
}
