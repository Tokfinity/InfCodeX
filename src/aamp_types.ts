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

export interface AampTaskResult {
  taskId: string;
  to: string;
  status: 'completed' | 'failed';
  output: string;
  inReplyToMessageId?: string;
  structuredResult?: Record<string, unknown>;
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
  createdAt: string;
  updatedAt: string;
}

export interface AampTaskStore {
  get(taskId: string): Promise<AampTaskRecord | null>;
  put(record: AampTaskRecord): Promise<void>;
  update(taskId: string, patch: Partial<AampTaskRecord>): Promise<AampTaskRecord>;
}

export interface AampTransport {
  listen(handler: (dispatch: AampDispatchEnvelope) => Promise<void>): Promise<void>;
  sendAck(ack: AampTaskAck): Promise<void>;
  sendResult(result: AampTaskResult): Promise<void>;
  dispose?(): Promise<void>;
}
