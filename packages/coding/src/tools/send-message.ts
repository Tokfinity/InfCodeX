/**
 * send_message — coordinator → in-flight child instruction tool.
 *
 * FEATURE_120 v0.7.39 Phase 2b. Lets a coordinator-class agent (Worker /
 * Scout) append a refinement instruction to a running child task's
 * message queue. The child sees the message as a
 * `<coordinator-instruction>…</coordinator-instruction>` block at its
 * next LLM turn boundary (drained by the runner-driven outer loop's
 * mid-turn drain at `priority: 'user'`).
 *
 * Parent-only: this tool is filtered out of child agents via
 * `CHILD_EXCLUDE_TOOLS_BASE` in `child-executor.ts` — children must not
 * be able to steer their siblings (recursion ban + protocol clarity).
 *
 * Uses `routeMessage` (the generic cross-agent router primitive in
 * `@kodax-ai/agent`). Coding-flavor concerns owned here:
 *   - `<coordinator-instruction>` framing tag (the contract the child
 *     prompt is steered against — see Worker prompt Phase 5a).
 *   - Reject `to === '*'` broadcast (deferred to FEATURE_123 v0.7.44).
 *   - Reject when the runner is in sync-only mode (no registry).
 */

import { getMessageQueue, routeMessage } from '@kodax-ai/agent';

import type { KodaXToolExecutionContext } from '../types.js';

const TOOL_NAME = 'send_message';

export async function toolSendMessage(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  // --- Validate input ---
  const to = typeof input.to === 'string' ? input.to.trim() : '';
  const content = typeof input.content === 'string' ? input.content.trim() : '';

  if (!to) {
    return `[Tool Error] ${TOOL_NAME}: Missing required parameter: to (child task_id from dispatch_child_task)`;
  }
  if (!content) {
    return `[Tool Error] ${TOOL_NAME}: Missing required parameter: content (instruction text to append to the child's queue)`;
  }

  // --- Reject broadcast sentinel (deferred to FEATURE_123) ---
  if (to === '*') {
    return `[Tool Error] ${TOOL_NAME}: Broadcast 'to: *' is not yet supported (planned in FEATURE_123 v0.7.44). Send to a specific task_id.`;
  }

  // --- Reject when async dispatch is disabled (no registry) ---
  const registry = ctx.childTaskRegistry;
  if (!registry) {
    return `[Tool Error] ${TOOL_NAME}: Async dispatch is disabled (no childTaskRegistry on context). Children run synchronously and complete inside their dispatch_child_task call — there is no in-flight target to steer.`;
  }

  // --- Route via @kodax-ai/agent primitive ---
  const wrapped = `<coordinator-instruction>\n${content}\n</coordinator-instruction>`;
  const outcome = routeMessage({
    to,
    priority: 'user',
    mode: 'prompt',
    content: wrapped,
    registry,
    queue: getMessageQueue(),
  });

  if (!outcome.ok) {
    return `[Tool Error] ${TOOL_NAME}: Unknown task_id "${outcome.to}". Verify the task_id matches one returned by dispatch_child_task and that the child has not already completed (completed children are auto-cleaned from the registry).`;
  }

  return `Message sent to ${to}. It will be processed at the child's next LLM turn boundary as a <coordinator-instruction> block.`;
}
