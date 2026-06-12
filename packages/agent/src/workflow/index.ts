/**
 * FEATURE_217 (v0.7.49) — `@kodax-ai/agent/workflow` public barrel.
 *
 * Domain-neutral workflow orchestration runtime. The coding layer
 * provides a concrete `WorkflowAgentBackend` (Phase B); this package
 * stays free of any `@kodax-ai/coding` dependency.
 */

export type {
  WorkflowTaskStatus,
  WorkflowModelHint,
  WorkflowIsolation,
  WorkflowSpawnAgentInput,
  WorkflowTaskHandle,
  WorkflowTaskUsage,
  WorkflowTaskResult,
  WorkflowTaskSnapshot,
  WorkflowWaitOptions,
  WorkflowParallelOptions,
  WorkflowSynthesizeInput,
  WorkflowSynthesis,
  WorkflowArtifactRef,
  WorkflowLogEvent,
  WorkflowBudget,
  WorkflowLimits,
  WorkflowApi,
  WorkflowMeta,
  WorkflowRun,
  WorkflowModule,
  WorkflowAgentBackend,
  WorkflowRunStatus,
  WorkflowRunState,
} from './types.js';

export type { WorkflowEvent, WorkflowEventType } from './events.js';
export { WorkflowEventRecorder } from './events.js';

export {
  WorkflowAbortError,
  WorkflowLimitError,
  createWorkflowRuntime,
  runWorkflow,
} from './runtime.js';
export type {
  CreateWorkflowRuntimeOptions,
  WorkflowRuntimeHandle,
  WorkflowRunOutcome,
} from './runtime.js';
