export type AampTaskStatus = 'received' | 'acknowledged' | 'running' | 'completed' | 'failed';

export interface AampDispatchEnvelope {
  taskId: string;
  from: string;
  subject?: string;
  bodyText: string;
  messageId?: string;
  dispatchContext?: Record<string, string>;
}

export interface AampTaskAck {
  taskId: string;
  to: string;
  inReplyToMessageId?: string;
}

import type { StructuredResultField } from 'aamp-sdk';

export interface AampTaskResult {
  taskId: string;
  to: string;
  status: 'completed' | 'failed';
  output: string;
  inReplyToMessageId?: string;
  structuredResult?: StructuredResultField[];
}

export interface AampTaskRecord {
  aampTaskId: string;
  sessionId: string;
  status: AampTaskStatus;
  senderEmail: string;
  subject?: string;
  dispatchContext?: Record<string, string>;
  inboundMessageId?: string;
  resultSummary?: string;
  executionStatus?: 'completed' | 'failed';
  planningSummary?: string;
  todoList?: string[];
  parseError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AampTaskStore {
  get(taskId: string): Promise<AampTaskRecord | null>;
  put(record: AampTaskRecord): Promise<void>;
  update(taskId: string, patch: Partial<AampTaskRecord>): Promise<AampTaskRecord>;
}

export interface AampTransport {
  listen(
    handler: (dispatch: AampDispatchEnvelope) => Promise<void>,
    cancelHandler?: (targetTaskId: string) => void,
  ): Promise<void>;
  sendAck(ack: AampTaskAck): Promise<void>;
  sendResult(result: AampTaskResult): Promise<void>;
  dispose?(): Promise<void>;

  /* ── Streaming (optional, supported by AampSdkTransport) ── */
  createStream?(opts: { taskId: string; peerEmail: string }): Promise<{ streamId: string }>;
  sendStreamOpened?(opts: {
    to: string;
    taskId: string;
    streamId: string;
    inReplyTo?: string;
  }): Promise<void>;
  appendStreamEvent?(opts: {
    streamId: string;
    type: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
  closeStream?(opts: { streamId: string; payload?: Record<string, unknown> }): Promise<void>;
}

export interface AampWorkerInput {
  dispatch: AampDispatchEnvelope;
  record: AampTaskRecord;
  provider: string;
  model?: string;
  repoRoot: string;
  dangerousFullPermissions?: boolean;
  /** When set, the worker should send stream events via IPC. */
  streamId?: string;
}

/**
 * IPC message sent from the worker to the parent process for streaming events.
 * Discriminated from the final AampTaskExecutionResult by the `__streamEvent` flag.
 */
export interface WorkerStreamEventMessage {
  __streamEvent: true;
  eventType: string;
  payload: Record<string, unknown>;
}
