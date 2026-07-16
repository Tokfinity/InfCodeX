/**
 * FEATURE_196 (v0.7.43) — Sidecar Verifier content-aware fire gate.
 *
 * Pre-F196 the sidecar verifier fired on every Worker text-only
 * termination — including "你好" trivial chat with zero action surface
 * to verify. 3-cost: latency (3-10s tail) + verifier LLM call + UI noise.
 *
 * The current H2 gate is metric-refined: objective work-scale signals fire the
 * verifier, trivial observed work can skip, short conversational greetings can
 * skip, and the default remains fire to preserve the F184 intent-vs-action
 * floor ("Worker claims it did X but never invoked X tool").
 *
 * Escape hatch: `KODAX_VERIFIER_ALWAYS=1` env var (or
 * `verifierAlwaysOn: true` in `~/.kodax/config.json`) forces 100% fire
 * regardless of gate decision. Debug / regression sweep / paranoid mode.
 *
 * Design rationale + risk analysis in `docs/features/v0.7.43.md#feature_196`.
 * SHIP gate criteria + Layer 2 eval design in the same doc.
 */
import type { StopHookContext } from '@kodax-ai/agent';
import type { KodaXMessage, KodaXContentBlock } from '@kodax-ai/llm';

/**
 * Final gate decision: `fire=true` means run the sidecar verifier;
 * `fire=false` means skip. `reason` is for trace / debug observability
 * (surfaced via `observer.sidecarGateDecision` when `KODAX_VERIFIER_LOG=1`).
 */
export interface GateDecision {
  readonly fire: boolean;
  readonly reason: string;
}

/**
 * Objective execution metrics read at the gate point (cumulative for the
 * current task run). Sourced from `mutationTracker` (writes), `roundRef`
 * (rounds), and `todoStore` (plan). NOT self-reported by the Worker — these
 * describe what the Worker actually DID, so they cannot be polluted by the
 * LLM's completion bias (an LLM finishing a task won't volunteer "I didn't
 * finish / please review me").
 */
export interface VerifierGateMetrics {
  /** High-risk bash mutations (git push/rm/install/…). bash file/line is a blind spot → fire conservatively. */
  readonly riskyShellOps: number;
  /** FS mutations whose touched file can't be attributed (undo / worktree_* / stage_*) — a blind spot → fire conservatively. */
  readonly unattributedWriteOps: number;
  /** write/edit/insert + risky-bash op count. 0 ⇒ no write happened this run. */
  readonly writeOps: number;
  /** Distinct files touched by write/edit tools (precise). */
  readonly filesChanged: number;
  /**
   * Sum of per-file line deltas from write/edit tools. ESTIMATED (derived from
   * old_string/new_string/content line counts), NOT a precise git diff.
   */
  readonly estimatedChangedLines: number;
  /** Worker committed a Todolist (todoStore non-empty) ⇒ it self-judged the task non-trivial. */
  readonly hasPlan: boolean;
  /** Total rounds (LLM turns) the Worker ran this task. */
  readonly rounds: number;
}

/**
 * A task that runs longer than this many rounds is treated as substantial
 * enough to warrant verification even when the visible output is small (a long
 * investigation may have produced an incomplete / unreliable result). Tunable.
 */
export const ROUNDS_VERIFY_THRESHOLD = 10;

/**
 * A single-file change at or below this many ESTIMATED lines (with no plan and
 * a short round count) is treated as trivial and skips verification. Tunable.
 */
export const TRIVIAL_LINES = 20;

/**
 * Find the last user message in the transcript. Used by Layer 2 to
 * detect conversational intent.
 *
 * Skips `_synthetic` user messages (auto-continue / retry prompts
 * injected by the harness) — those don't reflect actual user intent.
 */
function findLastUserMessage(
  transcript: readonly KodaXMessage[],
): KodaXMessage | undefined {
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const msg = transcript[i];
    if (msg.role === 'user' && !msg._synthetic) return msg;
  }
  return undefined;
}

/**
 * Extract the plain text content of a message. For string content,
 * returns it directly. For block-array content, concatenates all
 * text blocks (skipping tool_use / tool_result / image / thinking).
 */
function extractMessageText(msg: KodaXMessage): string {
  if (typeof msg.content === 'string') return msg.content;
  const parts: string[] = [];
  for (const block of msg.content as readonly KodaXContentBlock[]) {
    if (block.type === 'text') parts.push(block.text);
  }
  return parts.join('\n');
}

/**
 * Did the Worker take ANY observable tool action (reads included) in response
 * to the current request? Scans assistant turns AFTER the last non-synthetic
 * user message for any `tool_use` block.
 *
 * This is broader than the write-only `mutationTracker` (which never records
 * reads/grep/glob). It lets the metric gate tell apart a grounded read-only
 * lookup (skip-eligible) from a text-only claim with no tool evidence (must
 * fire — F184 floor).
 */
function taskHasAnyToolUse(transcript: readonly KodaXMessage[]): boolean {
  let requestIdx = -1;
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const msg = transcript[i];
    if (msg.role === 'user' && !msg._synthetic) {
      requestIdx = i;
      break;
    }
  }
  for (let i = requestIdx + 1; i < transcript.length; i += 1) {
    const msg = transcript[i];
    if (msg.role !== 'assistant') continue;
    if (typeof msg.content === 'string') continue;
    for (const block of msg.content as readonly KodaXContentBlock[]) {
      if (block.type === 'tool_use') return true;
    }
  }
  return false;
}

/**
 * Metric-refinement layer (H2) — replaces FEATURE_196's blunt Layer 1
 * ("any tool use → fire") for the cases where the Worker DID observable work.
 *
 * Returns `{fire}` when the work is measurable (write/plan/read), `undefined`
 * when there is NO observable work at all — in which case the decision falls
 * through to `detectConversationalIntent` + default-fire, preserving the F184
 * intent-vs-action floor (a text-only claim with no tool evidence still fires).
 *
 * Fire on any substantial / risky signal; skip only provably-trivial observed
 * work (single small edit, or a short grounded read-only lookup, with no plan).
 */
export function detectWorkScale(
  ctx: StopHookContext,
  metrics: VerifierGateMetrics,
): GateDecision | undefined {
  // Precondition for EVERY fire branch below (incl. the rounds check): the
  // Worker did observable work. A long-running task that invoked NO tools and
  // only claimed completion is NOT caught here — it returns undefined and is
  // handled by the default-fire path (F184 floor), which is the correct result.
  const didObservableWork =
    metrics.writeOps > 0 ||
    metrics.riskyShellOps > 0 ||
    metrics.unattributedWriteOps > 0 ||
    metrics.hasPlan ||
    taskHasAnyToolUse(ctx.transcript);
  if (!didObservableWork) return undefined;

  if (metrics.riskyShellOps > 0) {
    return {
      fire: true,
      reason: `metric-gate: ${metrics.riskyShellOps} high-risk shell op(s) — bash file/line is a blind spot, fire conservatively`,
    };
  }
  if (metrics.unattributedWriteOps > 0) {
    return {
      fire: true,
      reason: `metric-gate: ${metrics.unattributedWriteOps} write op(s) with no attributable file (undo / worktree / stage) — blind spot, fire conservatively`,
    };
  }
  if (metrics.hasPlan) {
    return {
      fire: true,
      reason: 'metric-gate: Worker committed a Todolist — self-judged non-trivial',
    };
  }
  if (metrics.rounds > ROUNDS_VERIFY_THRESHOLD) {
    return {
      fire: true,
      reason: `metric-gate: ${metrics.rounds} rounds > ${ROUNDS_VERIFY_THRESHOLD} — long task may be incomplete`,
    };
  }
  if (metrics.filesChanged >= 2) {
    return {
      fire: true,
      reason: `metric-gate: ${metrics.filesChanged} files changed — multi-file edit`,
    };
  }
  if (metrics.estimatedChangedLines > TRIVIAL_LINES) {
    return {
      fire: true,
      reason: `metric-gate: ~${metrics.estimatedChangedLines} estimated lines > ${TRIVIAL_LINES} — large single-file edit`,
    };
  }
  return {
    fire: false,
    reason: 'metric-gate: trivial observed work (single small edit or read-only lookup; no plan; short)',
  };
}

/**
 * Greeting prefixes — Worker text-only response to one of these is
 * almost certainly a polite reciprocation, not a hallucinated
 * completion. Coverage: Chinese (你好/您好/嗨/早...) + English (hi/hello/
 * hey/thanks/bye/ok) + common emoji (👋). Anchored to start of message.
 */
const GREETING_PREFIX_REGEX =
  /^(你好|您好|嗨|嘿|早安|早上好|早|hi|hello|hey|thanks|thank\s*you|谢谢|多谢|谢|byebye|bye|再见|拜拜|拜|ok|okay|好的|好|嗯|嗯嗯|哦|noted|got\s*it|sure|👋|🙏)/iu;

/**
 * Imperative verbs — presence of any in user message signals "user
 * asked Worker to DO something", so even a short message is NOT a
 * conversational greeting. Covers Chinese single-char + English
 * multi-char common forms.
 *
 * Bias toward false-positive (over-fire) — a single missed imperative
 * pattern just means one wasted verifier call. False-negative
 * (skipping when we should fire) misses zhipu floor catch which is
 * F184's core contract. Verb list errs on the broad side.
 */
const IMPERATIVE_VERB_REGEX =
  /(?:^|\s|，|。|；|,)(查|读|看|找|搜|搜索|寻找|定位|修|改|删|增|加|创|写|做|执行|实现|完成|检查|检测|审查|审计|分析|调查|诊断|调试|测试|验证|确认|生成|创建|编译|构建|启动|运行|部署|发布|run|fix|check|show|implement|build|debug|test|create|delete|find|search|investigate|analyze|verify|generate|compile|deploy|launch|setup|install)/iu;

/** Conservative upper bound on what counts as "short". Mixed
 * Chinese-English greeting messages routinely run 12-18 chars
 * ("你好，谢谢" / "thanks 很有用"); 20 covers the realistic top end
 * without inviting longer "you should X" requests in disguise. */
const CONVERSATIONAL_MAX_LENGTH = 20;

/**
 * Layer 2 — conversational user-intent detector.
 *
 * Returns `{fire: false}` ONLY when ALL of these hold:
 *   1. user message length ≤ 20 chars (Unicode codepoints, trimmed)
 *   2. starts with a greeting prefix
 *   3. contains NO imperative verb
 *
 * Returns `undefined` otherwise (defer to safe-default fire).
 *
 * Conservative by design: false-positive (firing on a conversational
 * message) costs one wasted verifier call. False-negative (skipping
 * when user asked Worker to do something) misses zhipu floor catch —
 * F184 contract violation. Always tilt toward the safe (fire) side.
 */
export function detectConversationalIntent(
  ctx: StopHookContext,
): GateDecision | undefined {
  const userMsg = findLastUserMessage(ctx.transcript);
  if (!userMsg) return undefined;
  const text = extractMessageText(userMsg).trim();
  // Codepoint length — `text.length` counts surrogate pairs as 2;
  // for CJK + emoji safety we use the iterator-based count, which
  // matches user perception of "characters" on the message UI.
  const codepointLength = Array.from(text).length;
  if (codepointLength === 0) return undefined;
  if (codepointLength > CONVERSATIONAL_MAX_LENGTH) return undefined;
  if (!GREETING_PREFIX_REGEX.test(text)) return undefined;
  if (IMPERATIVE_VERB_REGEX.test(text)) return undefined;
  return {
    fire: false,
    reason: `conversational-intent: user message is a short greeting (${codepointLength} char)`,
  };
}

/**
 * Compose final gate decision (H2 metric-refined).
 *
 * Decision order (first match wins):
 *   1. Escape hatch `KODAX_VERIFIER_ALWAYS=1` env → fire (debug mode)
 *   2. Metric work-scale (when Worker did observable work):
 *        risky-shell / plan / >threshold rounds / multi-file / large edit → fire;
 *        trivial observed work (single small edit, or grounded read-only) → skip.
 *      No observable work at all → fall through (preserves F184 floor).
 *   3. Conversational-intent (short greeting, no imperative) → skip.
 *   4. Safe default → fire (no-action + non-greeting = claim without evidence).
 *
 * The metric layer ONLY refines the "Worker did work" branch — the
 * conversational floor and default-fire are unchanged from FEATURE_196, so the
 * F184 intent-vs-action floor (text-only claim, no tools) still fires.
 *
 * `env` is injected for testability (tests pass a fixed `Record<string,string>`
 * rather than mutating `process.env`).
 */
export function composeGateDecision(
  ctx: StopHookContext,
  metrics: VerifierGateMetrics,
  env: Record<string, string | undefined>,
): GateDecision {
  if (env.KODAX_VERIFIER_ALWAYS === '1') {
    return {
      fire: true,
      reason: 'escape-hatch: KODAX_VERIFIER_ALWAYS=1 forces 100% fire',
    };
  }
  const workScale = detectWorkScale(ctx, metrics);
  if (workScale) return workScale;
  const conversational = detectConversationalIntent(ctx);
  if (conversational) return conversational;
  return {
    fire: true,
    reason: 'default: no skip signal — fire safely (F184 contract preserved)',
  };
}
