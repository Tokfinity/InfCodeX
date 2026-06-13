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
  WorkflowApprovalSummary,
  WorkflowApproval,
  WorkflowRun,
  WorkflowModule,
  WorkflowAgentBackend,
  WorkflowRunStatus,
  WorkflowRunState,
} from './types.js';

export type { WorkflowEvent, WorkflowEventType } from './events.js';
export { WorkflowEventRecorder } from './events.js';

export type { WorkflowPatternId, WorkflowScriptManifest } from './manifest.js';
export { WORKFLOW_PATTERN_IDS, validateWorkflowScriptManifest } from './manifest.js';

export {
  WorkflowScriptExecutionError,
  createRestrictedWorkflowModule,
  runRestrictedWorkflowScript,
} from './script-runner.js';
export type {
  RestrictedWorkflowModuleInput,
  RunRestrictedWorkflowScriptOptions,
} from './script-runner.js';

export {
  WorkflowAbortError,
  WorkflowBudgetError,
  WorkflowLimitError,
  createWorkflowRuntime,
  normalizeWorkflowLimits,
  runWorkflow,
} from './runtime.js';
export type {
  CreateWorkflowRuntimeOptions,
  WorkflowRuntimeHandle,
  WorkflowRunOutcome,
} from './runtime.js';
