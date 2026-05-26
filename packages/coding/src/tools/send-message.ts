/**
 * send_message — cross-agent text-routing tool.
 *
 * Lineage:
 *   - FEATURE_120 v0.7.39: Worker → child only. `to === '*'` rejected,
 *     child agents excluded from the tool entirely.
 *   - FEATURE_123 v0.7.44: routing-agnostic. Same tool now also handles
 *       child → child (peer)
 *       child → Worker (`to: 'worker'`)
 *       any → broadcast (`to: '*'`)
 *     Children are no longer in `CHILD_EXCLUDE_TOOLS_BASE`. The policy
 *     that used to live in "is this caller the Worker?" now lives in
 *     the target-shape branches below.
 *
 * Routing surface (one tool, three target shapes):
 *   - `*`         → fan out to every other in-flight sibling in the
 *                   parent's `childTaskRegistry`, plus the parent
 *                   Worker. Capped at 20 distinct targets (excluding
 *                   self).
 *   - `worker`    → addressed to `ctx.parentAgentId` (grand-child's
 *                   parent) or to `agentId: undefined` (top-level
 *                   Worker) when the caller has no parentAgentId.
 *   - `<task_id>` → single sibling lookup against the shared
 *                   `childTaskRegistry`. Self-targeted sends rejected
 *                   as a single-hop cycle guard.
 *
 * Priority + framing rules (mirrors the design doc table in v0.7.44.md):
 *
 *   sender → target          | priority    | wrapper tag
 *   -------------------------+-------------+--------------------------------
 *   Worker → child           | user        | <coordinator-instruction>
 *   child  → child (peer)    | background  | <peer-message from=A>
 *   child  → Worker          | background  | <child-notification from=A>
 *   broadcast (any → *)      | background  | <peer-broadcast from=A>
 *
 * Background-priority messages are only drained when the recipient
 * yields (idle / Sleep), so peer chatter does not interrupt active
 * work; user-priority Worker → child instructions are drained at
 * every tool boundary (existing FEATURE_115 behavior).
 *
 * **NOT in scope for v0.7.44 (deferred to v0.7.45)**:
 *   - `seen_by` cycle hop list (A→B→A multi-hop loop guard). Self-send
 *     rejection covers the 1-hop case; multi-hop forwarding is itself
 *     a model intent — the floor risk does not justify the envelope
 *     schema change in this version.
 *   - Per-turn flood throttle (≤5/child-turn, ≤20/Worker-turn). Needs
 *     a turn-boundary observer that the runtime does not currently
 *     surface to tools. Broadcast cap is in place; aggregate per-run
 *     limits will land alongside the goalContext / lifecycle composer
 *     wiring in v0.7.45.
 */

import { getMessageQueue, routeMessage } from '@kodax-ai/agent';
import type { MessagePriority } from '@kodax-ai/agent';

import type { KodaXToolExecutionContext } from '../types.js';

const TOOL_NAME = 'send_message';
const BROADCAST_TARGET_CAP = 20;
const WORKER_PER_TURN_CAP = 20;
const CHILD_PER_TURN_CAP = 5;

/**
 * Per-turn flood throttle. Counts each outbound enqueue (broadcast
 * counts as N — one per recipient). Cap is 20/Worker-turn, 5/child-
 * turn; over-cap returns a Tool Error before any enqueue happens.
 *
 * The counter lives on `ctx.sendMessageTurnCounter` (allocated by
 * `buildToolExecutionContext`, reset to 0 in runner-driven's
 * `beforeNextTurn`). Bypassed when the counter is unset (sync-mode
 * dispatch / test ctx without the substrate).
 *
 * Returns `null` on accept (counter pre-charged with `additional`)
 * or an error message on reject.
 */
function chargeTurnCounter(
  ctx: KodaXToolExecutionContext,
  additional: number,
): string | null {
  const counter = ctx.sendMessageTurnCounter;
  if (!counter) return null;
  const cap = ctx.currentAgentId === undefined ? WORKER_PER_TURN_CAP : CHILD_PER_TURN_CAP;
  const role = ctx.currentAgentId === undefined ? 'Worker' : 'child';
  if (counter.count + additional > cap) {
    return `[Tool Error] ${TOOL_NAME}: per-turn send_message limit reached for this ${role} (${counter.count} already sent this turn + ${additional} requested > cap ${cap}). Wait until the next LLM turn — peer coordination that needs more than ${cap} messages per turn is almost always a storm or a misfire.`;
  }
  counter.count += additional;
  return null;
}

/** Mirrors `MessageQueue` enqueue shape — re-declared narrow to keep the import surface small. */
interface QueueLike {
  enqueue: (input: {
    priority: MessagePriority;
    mode: 'prompt' | 'task-notification' | 'system-reminder';
    agentId?: string;
    content: string;
  }) => string;
}

/**
 * Send an addressed message to the immediate parent agent.
 * Worker is uniquely keyed by `agentId: undefined` on the queue when
 * the caller has no `parentAgentId`; grand-children route to their
 * direct parent (a specific task_id) when one is set.
 *
 * **LLM-prompt semantics note**: the child role prompt teaches
 * `to:"worker"` as "notify your parent Worker". For first-tier
 * children (the only path that exists in v0.7.44 because
 * `dispatch_child_task` is in CHILD_EXCLUDE_TOOLS_BASE), the
 * immediate parent IS the Worker, so prompt and implementation
 * agree. A future v0.7.4x that opens grand-child dispatch would
 * need to either (a) keep this immediate-parent semantic and
 * rephrase the prompt to "notify your immediate parent", or (b)
 * introduce a separate `to:"parent"` sentinel and route
 * `to:"worker"` always to the top Worker. Deferred to that
 * version — see v0.7.44 CHANGELOG deferred-to-v0.7.45 list.
 */
function sendToWorker(
  fromId: string,
  content: string,
  parentAgentId: string | undefined,
  queue: QueueLike,
  ctx: KodaXToolExecutionContext,
): string {
  const chargeError = chargeTurnCounter(ctx, 1);
  if (chargeError) return chargeError;
  const wrapped = `<child-notification from="${fromId}">\n${content}\n</child-notification>`;
  queue.enqueue({
    priority: 'background',
    mode: 'task-notification',
    agentId: parentAgentId,
    content: wrapped,
  });
  const target = parentAgentId ?? 'worker';
  return `Message sent to ${target}. It will surface as a <child-notification from="${fromId}"> block when the parent next yields.`;
}

/**
 * Fan-out broadcast to all in-flight siblings (excluding self) +
 * the parent Worker. Cap = BROADCAST_TARGET_CAP distinct addressed
 * targets; over-cap returns a Tool Error with no enqueues.
 */
function broadcast(
  fromId: string | undefined,
  content: string,
  ctx: KodaXToolExecutionContext,
  queue: QueueLike,
): string {
  const registry = ctx.childTaskRegistry;
  if (!registry) {
    return `[Tool Error] ${TOOL_NAME}: Broadcast requires a sibling registry, but none is bound to this context (sync-mode dispatch). Send to a specific task_id or 'worker' instead.`;
  }
  // Exclude self AND the immediate parent (when the parent is also a
  // registered child — happens for grand-children). The parent
  // receives one enqueue on the dedicated worker channel below; the
  // filter prevents a double-enqueue for the same agent.
  const parentAgentId = ctx.parentAgentId;
  const sibTargets = [...registry.keys()].filter(
    (id) => id !== fromId && id !== parentAgentId,
  );
  // Whether to also notify the parent Worker. Children always notify
  // their parent; the Worker broadcasting to its own children skips
  // self (it has no parent in this process).
  const includeWorker = fromId !== undefined;
  const targetCount = sibTargets.length + (includeWorker ? 1 : 0);
  if (targetCount > BROADCAST_TARGET_CAP) {
    return `[Tool Error] ${TOOL_NAME}: Broadcast target count ${targetCount} exceeds cap ${BROADCAST_TARGET_CAP}. Narrow the audience by sending to specific task_ids.`;
  }
  if (targetCount === 0) {
    return `[Tool Error] ${TOOL_NAME}: Broadcast has zero recipients (no other in-flight siblings, and you have no parent Worker to notify).`;
  }
  // Pre-charge the per-turn counter before any enqueue. Counter is
  // bumped by `targetCount` because broadcast fan-out is the worst-
  // case storm vector — a single broadcast call could otherwise
  // skip the throttle that targeted sends respect.
  const chargeError = chargeTurnCounter(ctx, targetCount);
  if (chargeError) return chargeError;
  const fromLabel = fromId ?? 'worker';
  const wrapped = `<peer-broadcast from="${fromLabel}">\n${content}\n</peer-broadcast>`;
  for (const sibId of sibTargets) {
    queue.enqueue({
      priority: 'background',
      mode: 'prompt',
      agentId: sibId,
      content: wrapped,
    });
  }
  if (includeWorker) {
    queue.enqueue({
      priority: 'background',
      mode: 'task-notification',
      agentId: ctx.parentAgentId,
      content: wrapped,
    });
  }
  return `Broadcast sent from ${fromLabel} to ${targetCount} target(s) (${sibTargets.length} sibling(s)${includeWorker ? ' + parent' : ''}). Recipients will see the <peer-broadcast> block when they next yield.`;
}

export async function toolSendMessage(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  // --- Validate input ---
  const to = typeof input.to === 'string' ? input.to.trim() : '';
  const content = typeof input.content === 'string' ? input.content.trim() : '';

  if (!to) {
    return `[Tool Error] ${TOOL_NAME}: Missing required parameter: to (task_id of an in-flight sibling, 'worker' to notify the parent, or '*' to broadcast).`;
  }
  if (!content) {
    return `[Tool Error] ${TOOL_NAME}: Missing required parameter: content (the message body).`;
  }

  const queue: QueueLike = getMessageQueue();
  const myId = ctx.currentAgentId;

  // --- Branch 1: broadcast ---
  if (to === '*') {
    return broadcast(myId, content, ctx, queue);
  }

  // --- Branch 2: address the parent Worker ---
  if (to === 'worker') {
    if (myId === undefined) {
      return `[Tool Error] ${TOOL_NAME}: send_message(to='worker') is for children notifying their parent — you are the Worker (top of the agent tree).`;
    }
    return sendToWorker(myId, content, ctx.parentAgentId, queue, ctx);
  }

  // --- Branch 3: address a specific task_id (peer or Worker→child) ---
  const registry = ctx.childTaskRegistry;
  if (!registry) {
    return `[Tool Error] ${TOOL_NAME}: Async dispatch is disabled (no childTaskRegistry on context). Children run synchronously and complete inside their dispatch_child_task call — there is no in-flight target to steer.`;
  }
  if (myId !== undefined && to === myId) {
    return `[Tool Error] ${TOOL_NAME}: Cannot send a message to yourself (to='${to}'). Use task tools to record your own notes; send_message routes between distinct agents.`;
  }

  // Priority + framing depends on who's sending:
  //   Worker (myId === undefined) → child:    priority='user', <coordinator-instruction>
  //   child  (myId !== undefined) → peer:     priority='background', <peer-message from=A>
  const isCoordinatorPath = myId === undefined;
  const priority: MessagePriority = isCoordinatorPath ? 'user' : 'background';
  const wrapped = isCoordinatorPath
    ? `<coordinator-instruction>\n${content}\n</coordinator-instruction>`
    : `<peer-message from="${myId}">\n${content}\n</peer-message>`;

  // Pre-charge before enqueue — keep the throttle ahead of every
  // outbound message, including the cheap targeted single-recipient
  // path. If the recipient is unknown we still consumed the charge
  // (the agent wasted a budget unit on a misfired call — matches
  // codex semantics where bad sends count against the rate limit).
  const chargeError = chargeTurnCounter(ctx, 1);
  if (chargeError) return chargeError;

  const outcome = routeMessage({
    to,
    priority,
    mode: 'prompt',
    content: wrapped,
    registry,
    queue: getMessageQueue(),
  });

  if (!outcome.ok) {
    return `[Tool Error] ${TOOL_NAME}: Unknown task_id "${outcome.to}". Verify the task_id matches one returned by dispatch_child_task and that the target has not already completed (completed children are auto-cleaned from the registry).`;
  }

  if (isCoordinatorPath) {
    return `Message sent to ${to}. It will be processed at the child's next LLM turn boundary as a <coordinator-instruction> block.`;
  }
  return `Peer message sent to ${to} from ${myId}. It will be processed when the peer next yields as a <peer-message from="${myId}"> block.`;
}
