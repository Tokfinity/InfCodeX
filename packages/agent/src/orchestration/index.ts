/**
 * Orchestration primitives for the agent runtime — generic fan-out,
 * idle-yield, and steering surfaces.
 *
 * FEATURE_120 v0.7.39 Step 0 lifts the previously coding-private
 * orchestration utilities here so the `@kodax-ai/agent` package can be
 * consumed standalone for agent-framework workloads outside KodaX's
 * coding flavor (ADR-021).
 *
 * Module set (each module owns one concern):
 *   - `task-registry.ts` — in-flight child-task tracking + cleanup
 *   - `idle-yield.ts` — async wait-and-resume mechanic (FEATURE_155)
 *
 * Phase 1c/1d add the `Runner.runWithIdleYield` API and the common
 * `child-executor.ts` fan-out helper.
 */

export type { ChildTaskRegistry } from './task-registry.js';
export { registerChildTask } from './task-registry.js';

export type {
  IdleYieldSnapshot,
  WaitForWakeEventOptions,
  WakeEvent,
} from './idle-yield.js';
export {
  composeIdleYieldUserMessage,
  countLastAssistantToolCalls,
  detectIdleYield,
  isIdleYieldEnabled,
  waitForWakeEvent,
} from './idle-yield.js';
