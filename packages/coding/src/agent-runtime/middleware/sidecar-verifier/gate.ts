/**
 * FEATURE_196 (v0.7.43) — Sidecar Verifier content-aware fire gate.
 *
 * Pre-F196 the sidecar verifier fired on every Worker text-only
 * termination — including "你好" trivial chat with zero action surface
 * to verify. 3-cost: latency (3-10s tail) + verifier LLM call + UI noise.
 *
 * F196 introduces a 2-layer content-aware gate to skip sidecar on
 * conversational turns while preserving the F184 core contract of
 * catching zhipu intent-vs-action floor ("Worker claims it did X but
 * never invoked X tool"):
 *
 *   Layer 1 (action-surface, deterministic): if the Worker invoked
 *   ANY tool in its last assistant turn → fire (something to verify).
 *
 *   Layer 2 (user intent, deterministic): if Layer 1 is empty AND the
 *   user's last message is a short conversational greeting → skip.
 *
 *   Default: fire (safe baseline — F184 contract preserved).
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
 * Tools whose presence in the last assistant turn means "Worker did
 * real work this turn — verify the claim."
 *
 * Includes the file-mutation set, dispatch_child_task (work was
 * delegated), AND all the repointel pull-tools / grep / read / glob /
 * bash / todo_* — basically any tool use whatsoever signals "non-
 * conversational turn", which is the cheap conservative gate. The
 * narrower "only mutations" cut would be unsafe because a Worker
 * grep → false-claim-of-finding flow needs verifier.
 *
 * Empty set (no tool use at all) is the only state that can reach
 * Layer 2 (conversational intent detection).
 */

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
 * Find the last assistant message in the transcript (closest to the
 * stop-hook fire point). Returns `undefined` for transcripts with no
 * assistant turn (defensive — Runner's stop-hook contract guarantees
 * at least one assistant message, but the wider transcript type allows
 * the case).
 */
function findLastAssistantMessage(
  transcript: readonly KodaXMessage[],
): KodaXMessage | undefined {
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const msg = transcript[i];
    if (msg.role === 'assistant') return msg;
  }
  return undefined;
}

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
 * Returns true if the last assistant message contains at least one
 * `tool_use` content block — any tool, not just mutations. The
 * conservative gate: a tool call means there's something for the
 * verifier to check (real work or false claim that work happened).
 */
function lastAssistantHasToolUse(
  transcript: readonly KodaXMessage[],
): boolean {
  const last = findLastAssistantMessage(transcript);
  if (!last) return false;
  if (typeof last.content === 'string') return false;
  for (const block of last.content as readonly KodaXContentBlock[]) {
    if (block.type === 'tool_use') return true;
  }
  return false;
}

/**
 * Layer 1 — action-surface detector.
 *
 * Returns `{fire: true}` if the last assistant turn had any tool use.
 * Returns `undefined` if no signal (defer to Layer 2).
 */
export function detectActionSurface(
  ctx: StopHookContext,
): GateDecision | undefined {
  if (lastAssistantHasToolUse(ctx.transcript)) {
    return {
      fire: true,
      reason: 'action-surface: last assistant turn invoked a tool',
    };
  }
  return undefined;
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
 * Compose final gate decision from L1 + L2 + escape hatch.
 *
 * Decision order (first match wins):
 *   1. Escape hatch `KODAX_VERIFIER_ALWAYS=1` env → fire (debug mode)
 *   2. Layer 1 action-surface signal → fire (Worker did real work)
 *   3. Layer 2 conversational-intent signal → skip (trivial chat)
 *   4. Safe default → fire
 *
 * `env` is injected for testability (tests pass a fixed `Record<string,string>`
 * rather than mutating `process.env`).
 */
export function composeGateDecision(
  ctx: StopHookContext,
  env: Record<string, string | undefined>,
): GateDecision {
  if (env.KODAX_VERIFIER_ALWAYS === '1') {
    return {
      fire: true,
      reason: 'escape-hatch: KODAX_VERIFIER_ALWAYS=1 forces 100% fire',
    };
  }
  const actionSurface = detectActionSurface(ctx);
  if (actionSurface) return actionSurface;
  const conversational = detectConversationalIntent(ctx);
  if (conversational) return conversational;
  return {
    fire: true,
    reason: 'default: no skip signal — fire safely (F184 contract preserved)',
  };
}
