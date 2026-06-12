/**
 * FEATURE_217 (v0.7.49) — Workflow run-graph events.
 *
 * Append-only event stream for a workflow run. Each event carries a
 * monotonic `seq` so ordering is stable and verifiable regardless of
 * wall-clock (the durable writer in Phase D adds timestamps via an
 * injected clock). The run graph models agent relationships as a
 * thread/edge/event stream, not just a final summary blob.
 */

export type WorkflowEventType =
  | 'workflow_started'
  | 'phase_started'
  | 'phase_finished'
  | 'agent_spawned'
  | 'agent_message_sent'
  | 'agent_completed'
  | 'agent_stopped'
  | 'artifact_written'
  | 'synthesis_completed'
  | 'workflow_completed'
  | 'workflow_failed';

export interface WorkflowEvent {
  /** Monotonic sequence number — stable append ordering. */
  readonly seq: number;
  readonly type: WorkflowEventType;
  /** Structured payload (agent name/id, phase name, error message, …). */
  readonly data?: Record<string, unknown>;
}

/**
 * Append-only event recorder. Assigns sequential `seq` and fans each
 * event out to an optional sink (the durable JSONL writer / UI consumer
 * subscribes here in Phase D).
 */
export class WorkflowEventRecorder {
  private seq = 0;
  private readonly events: WorkflowEvent[] = [];

  constructor(private readonly sink?: (event: WorkflowEvent) => void) {}

  /** Append an event, returning the materialized record. */
  emit(type: WorkflowEventType, data?: Record<string, unknown>): WorkflowEvent {
    const event: WorkflowEvent = data === undefined
      ? { seq: this.seq++, type }
      : { seq: this.seq++, type, data };
    this.events.push(event);
    this.sink?.(event);
    return event;
  }

  /** Immutable snapshot of all events emitted so far. */
  snapshot(): readonly WorkflowEvent[] {
    return [...this.events];
  }
}
