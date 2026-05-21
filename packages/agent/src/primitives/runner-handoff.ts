/**
 * Runner Handoff Helpers — FEATURE_084 Shard 4 (v0.7.26).
 *
 * When a tool result carries `metadata.handoffTarget`, the Runner should
 * switch ownership to the target Agent declared in
 * `currentAgent.handoffs`. This module provides pure helpers for that
 * transition:
 *
 *   - `detectHandoffSignal(currentAgent, toolResults)` — find the first
 *     tool result that carries a matching handoff and return the resolved
 *     Handoff + target.
 *   - `replaceSystemMessage(transcript, newAgent)` — swap the leading
 *     system message so the next LLM turn sees the new agent's
 *     instructions.
 *   - `emitHandoffSpan(parentSpan, from, to, ...)` — emit the
 *     `HandoffSpan` (FEATURE_083 span kind).
 *
 * Guardrail scoping for Shard 4: input / output guardrails are **run-scoped**
 * — they use the starting agent's declarations and run once at start/end of
 * the overall run. They do NOT re-run on handoff. Tool guardrails apply to
 * every tool invocation regardless of which agent is calling. This keeps
 * the mental model simple; later shards may refine.
 */

import type { Span } from '@kodax-ai/tracing';

import type { Agent, AgentMessage, Handoff } from './agent.js';
import type { RunnerToolCall, RunnerToolResult } from './runner-tool-loop.js';

export interface HandoffSignal {
  readonly from: Agent;
  readonly to: Agent;
  readonly handoff: Handoff;
  /** Index of the tool result that triggered the handoff. */
  readonly triggerIndex: number;
}

/**
 * Find the first tool result with a `handoffTarget` metadata field that
 * resolves to a declared handoff on `currentAgent`. Returns `undefined` if
 * no result carries a handoff target or if the target isn't declared.
 */
export function detectHandoffSignal(
  currentAgent: Agent,
  _toolCalls: readonly RunnerToolCall[],
  toolResults: readonly RunnerToolResult[],
): HandoffSignal | undefined {
  if (!currentAgent.handoffs || currentAgent.handoffs.length === 0) {
    return undefined;
  }
  for (let i = 0; i < toolResults.length; i += 1) {
    const result = toolResults[i]!;
    const meta = result.metadata as { handoffTarget?: unknown } | undefined;
    const target = typeof meta?.handoffTarget === 'string' ? meta.handoffTarget : undefined;
    if (!target) continue;
    const handoff = currentAgent.handoffs.find((h) => h.target.name === target);
    if (handoff) {
      return { from: currentAgent, to: handoff.target, handoff, triggerIndex: i };
    }
  }
  return undefined;
}

function resolveInstructions(agent: Agent): string {
  const { instructions } = agent;
  if (typeof instructions === 'function') {
    return instructions(undefined);
  }
  return instructions;
}

/**
 * Replace the leading system message with `newAgent`'s instructions so the
 * next LLM turn runs under the new role. The rest of the transcript
 * (user, assistant tool_use, tool_result blocks) is preserved verbatim so
 * the new agent sees the full lead-up.
 */
export function replaceSystemMessage(
  transcript: readonly AgentMessage[],
  newAgent: Agent,
): AgentMessage[] {
  const newSystem: AgentMessage = {
    role: 'system',
    content: resolveInstructions(newAgent),
  };
  if (transcript.length > 0 && transcript[0]!.role === 'system') {
    return [newSystem, ...transcript.slice(1)];
  }
  return [newSystem, ...transcript];
}

/**
 * FEATURE_184 (v0.7.45) — detect a terminal tool signal.
 *
 * Returns true when ALL of:
 *   1. The current agent has an EMPTY handoffs array (i.e. it was declared
 *      as a terminal executor — Generator or Worker post-C.1).
 *   2. Any tool result carries `metadata.isTerminal: true` without a
 *      `metadata.handoffTarget`.
 *
 * The agent-handoffs guard is load-bearing: Scout also produces
 * `isTerminal: true` tool results (H0_DIRECT path) but still needs a
 * follow-up text-only turn to produce its answer. Scout always has a
 * non-empty `handoffs` array (H1 + H2 targets), so this helper returns
 * false for Scout even when its emit result is terminal.
 *
 * Disjoint from `detectHandoffSignal`: that helper requires a non-empty
 * `handoffs` array and a matching `handoffTarget`; this helper fires only
 * when `handoffs` is empty AND `isTerminal` is true with no target.
 */
export function detectTerminalToolSignal(
  currentAgent: Agent,
  toolResults: readonly RunnerToolResult[],
): boolean {
  if (!currentAgent.handoffs || currentAgent.handoffs.length > 0) {
    return false;
  }
  for (const result of toolResults) {
    const meta = result.metadata as { isTerminal?: unknown; handoffTarget?: unknown } | undefined;
    if (meta?.isTerminal === true && !meta?.handoffTarget) {
      return true;
    }
  }
  return false;
}

/**
 * Emit a `HandoffSpan` as a child of the agent span. Ends immediately
 * because a handoff is a point-in-time event (unlike agent/tool spans
 * which wrap a duration).
 */
export function emitHandoffSpan(
  parentSpan: Span | null,
  from: Agent,
  to: Agent,
  handoffKind: 'continuation' | 'as-tool',
  description?: string,
): void {
  if (!parentSpan) return;
  const span = parentSpan.addChild(`handoff:${from.name}→${to.name}`, {
    kind: 'handoff',
    fromAgent: from.name,
    toAgent: to.name,
    handoffKind,
    description,
  });
  span.end();
}
