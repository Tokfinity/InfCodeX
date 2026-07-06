export interface WorkflowDoneHandle {
  readonly done: Promise<unknown>;
}

export function unsubscribeWorkflowLiveProcessOnDone(
  managed: WorkflowDoneHandle,
  unsubscribeProcess: () => void,
): void {
  void managed.done
    .finally(() => {
      try {
        unsubscribeProcess();
      } catch {
        // Process subscriptions are observers; cleanup failure must not turn a
        // settled workflow into a process-level unhandled rejection.
      }
    })
    .catch(() => {});
}
