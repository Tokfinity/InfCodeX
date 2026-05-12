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

export type {
  RunWithIdleYieldOptions,
  RunWithIdleYieldRunResult,
} from './runner-with-idle-yield.js';
export {
  DEFAULT_IDLE_YIELD_MAX_ITERATIONS,
  runWithIdleYield,
} from './runner-with-idle-yield.js';

export type {
  FanOutOutcome,
  FanOutProgressEvent,
  RunFanOutOptions,
  RunFanOutResult,
} from './fan-out.js';
export { runFanOut } from './fan-out.js';

export type {
  RouteMessageOptions,
  RouteMessageResult,
} from './send-message-router.js';
export { routeMessage } from './send-message-router.js';

export type {
  RequestTaskStopOptions,
  RequestTaskStopResult,
  TaskAbortRegistry,
} from './task-stop.js';
export { requestTaskStop } from './task-stop.js';
