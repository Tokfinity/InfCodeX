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
 *
 * Phase 1b/1c/1d add `idle-yield.ts`, the `Runner.runWithIdleYield`
 * API, and the common `child-executor.ts` fan-out helper.
 */

export type { ChildTaskRegistry } from './task-registry.js';
export { registerChildTask } from './task-registry.js';
