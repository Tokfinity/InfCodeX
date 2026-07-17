import type {
  WorkflowArtifactRef,
  WorkflowOutcome,
  WorkflowOutcomeError,
  WorkflowOutcomeResult,
  WorkflowRunState,
  WorkflowTaskResult,
  WorkflowTaskUsage,
} from './types.js';

export interface BuildWorkflowOutcomeInput {
  readonly state: WorkflowRunState;
  readonly summary?: string;
  readonly error?: Error;
}

export function buildWorkflowOutcome(input: BuildWorkflowOutcomeInput): WorkflowOutcome {
  const results = input.state.results.map(toOutcomeResult);
  const completed = input.state.results.filter((result) => (
    result.status === 'completed' || result.status === 'completed_unverified'
  ));
  const unresolved = input.state.results.filter((result) => (
    result.status === 'failed' || result.status === 'stopped'
  ));
  const errors: WorkflowOutcomeError[] = unresolved.map((result) => ({
    taskId: result.taskId,
    name: result.name,
    message: result.finalText.trim() || `Agent ${result.name} ${result.status}.`,
  }));
  if (input.error) errors.push({ message: input.error.message });
  const status = input.state.status === 'stopped'
    ? 'interrupted'
    : input.state.status === 'failed'
      ? 'failed'
      : unresolved.length > 0
        ? 'partial'
        : 'completed';
  const artifacts = dedupeArtifacts([
    ...input.state.artifacts,
    ...input.state.results.flatMap((result) => (
      (result.artifacts ?? []).map((path) => ({ name: path, path }))
    )),
  ]);
  return {
    runId: input.state.runId,
    status,
    summary: input.summary?.trim()
      || input.error?.message
      || defaultSummary(input.state.runId, status),
    results,
    artifacts,
    coverage: completed.map((result) => result.name),
    unresolved: unresolved.map((result) => result.name),
    errors,
    usage: sumUsage(input.state.totalSpawned, input.state.results),
  };
}

function toOutcomeResult(result: WorkflowTaskResult): WorkflowOutcomeResult {
  return {
    taskId: result.taskId,
    name: result.name,
    status: result.status,
    summary: result.digest?.trim() || result.finalText.trim(),
    ...(result.structured === undefined ? {} : { structured: result.structured }),
    artifacts: [...(result.artifacts ?? [])],
    ...(result.usage === undefined ? {} : { usage: result.usage }),
  };
}

function sumUsage(totalSpawned: number, results: readonly WorkflowTaskResult[]): WorkflowOutcome['usage'] {
  const total = results.reduce<Required<WorkflowTaskUsage>>((usage, result) => ({
    inputTokens: usage.inputTokens + (result.usage?.inputTokens ?? 0),
    outputTokens: usage.outputTokens + (result.usage?.outputTokens ?? 0),
    totalTokens: usage.totalTokens + (result.usage?.totalTokens ?? 0),
    cacheReadTokens: usage.cacheReadTokens + (result.usage?.cacheReadTokens ?? 0),
  }), { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0 });
  return { ...total, totalSpawned };
}

function dedupeArtifacts(artifacts: readonly WorkflowArtifactRef[]): readonly WorkflowArtifactRef[] {
  const seen = new Set<string>();
  return artifacts.filter((artifact) => {
    const key = `${artifact.name}\u0000${artifact.path ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function defaultSummary(runId: string, status: WorkflowOutcome['status']): string {
  return `Workflow ${runId} ${status}.`;
}
