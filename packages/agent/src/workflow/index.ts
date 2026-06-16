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
  WorkflowTaskSummaryKind,
  WorkflowTaskSummaryEventUpdate,
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

export {
  createWorkflowProcessTracker,
  isFinalWorkflowProcessStatus,
} from './process.js';
export type {
  WorkflowEventCorrelation,
  WorkflowProcessArtifact,
  WorkflowProcessCounts,
  WorkflowProcessEvent,
  WorkflowProcessItem,
  WorkflowProcessItemKind,
  WorkflowProcessItemStatus,
  WorkflowProcessProgress,
  WorkflowProcessSnapshot,
  WorkflowProcessSource,
  WorkflowProcessStatus,
  WorkflowProcessSummaryStatus,
  WorkflowProcessTokenUsage,
  WorkflowProcessTracker,
  WorkflowProcessTrackerOptions,
  WorkflowTaskSummaryUpdate,
} from './process.js';

export type { WorkflowPatternId, WorkflowScriptManifest } from './manifest.js';
export { WORKFLOW_PATTERN_IDS, validateWorkflowScriptManifest } from './manifest.js';

export {
  WorkflowScriptExecutionError,
  createRestrictedWorkflowModule,
  runRestrictedWorkflowScript,
  validateRestrictedWorkflowSource,
} from './script-runner.js';
export type {
  RestrictedWorkflowModuleInput,
  RunRestrictedWorkflowScriptOptions,
  ValidateRestrictedWorkflowSourceOptions,
} from './script-runner.js';

export {
  WORKFLOW_CAPSULE_API_VERSION,
  WORKFLOW_CAPSULE_FORMAT,
  WORKFLOW_CAPSULE_VERSION,
  createWorkflowCapsule,
  createWorkflowModuleFromCapsule,
  validateWorkflowCapsule,
} from './capsule.js';
export type {
  CreateWorkflowCapsuleInput,
  WorkflowCapsule,
  WorkflowCapsuleEnvironmentRequirement,
  WorkflowCapsuleInputs,
  WorkflowCapsuleIntent,
  WorkflowCapsuleProvenance,
  WorkflowCapsuleRequirements,
} from './capsule.js';

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
