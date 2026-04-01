import { randomUUID } from 'node:crypto';
import type { KodaXSessionStorage } from '@kodax/coding';
import { FileSessionStorage, prepareRuntimeConfig } from '@kodax/repl';
import { KodaXAampRuntime } from './aamp_runtime.js';
import { FileAampTaskStore } from './aamp_store.js';
import type {
  AampDispatchEnvelope,
  AampTaskRecord,
  AampTaskStore,
  AampTransport,
} from './aamp_types.js';

export interface KodaXAampServerOptions {
  transport: AampTransport;
  repoRoot?: string;
  provider?: string;
  model?: string;
  sessionStorage?: KodaXSessionStorage;
  taskStore?: AampTaskStore;
}

function createTaskRecord(dispatch: AampDispatchEnvelope): AampTaskRecord {
  const now = new Date().toISOString();
  return {
    aampTaskId: dispatch.taskId,
    sessionId: randomUUID(),
    status: 'received',
    senderEmail: dispatch.from,
    subject: dispatch.subject,
    dispatchContext: dispatch.dispatchContext ? { ...dispatch.dispatchContext } : undefined,
    inboundMessageId: dispatch.messageId,
    createdAt: now,
    updatedAt: now,
  };
}

export class KodaXAampServer {
  private readonly transport: AampTransport;
  private readonly taskStore: AampTaskStore;
  private readonly runtime: KodaXAampRuntime;

  constructor(options: KodaXAampServerOptions) {
    const config = prepareRuntimeConfig();
    const repoRoot = options.repoRoot ?? process.cwd();

    this.transport = options.transport;
    this.taskStore = options.taskStore ?? new FileAampTaskStore();
    this.runtime = new KodaXAampRuntime({
      provider: options.provider ?? config.provider ?? 'openai',
      model: options.model,
      repoRoot,
      sessionStorage: options.sessionStorage ?? new FileSessionStorage(),
    });
  }

  async start(): Promise<void> {
    await this.transport.listen(async (dispatch) => {
      await this.handleDispatch(dispatch);
    });
  }

  async stop(): Promise<void> {
    await this.transport.dispose?.();
  }

  async handleDispatch(dispatch: AampDispatchEnvelope): Promise<void> {
    let record = await this.taskStore.get(dispatch.taskId);
    if (!record) {
      record = createTaskRecord(dispatch);
      await this.taskStore.put(record);
    }

    if (record.status === 'completed') {
      return;
    }

    await this.transport.sendAck({
      taskId: dispatch.taskId,
      to: dispatch.from,
      inReplyToMessageId: dispatch.messageId,
    });
    record = await this.taskStore.update(dispatch.taskId, { status: 'acknowledged' });

    try {
      await this.taskStore.update(dispatch.taskId, { status: 'running' });
      const execution = await this.runtime.execute(dispatch, record);

      await this.transport.sendResult(execution.outbound);
      await this.taskStore.update(dispatch.taskId, {
        status: execution.outbound.status === 'completed' ? 'completed' : 'failed',
        resultSummary: execution.outbound.output,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.transport.sendResult({
        taskId: dispatch.taskId,
        to: dispatch.from,
        status: 'failed',
        output: message,
        inReplyToMessageId: dispatch.messageId,
      });
      await this.taskStore.update(dispatch.taskId, {
        status: 'failed',
        resultSummary: message,
      });
    }
  }
}

export async function runAampServer(options: KodaXAampServerOptions): Promise<void> {
  const server = new KodaXAampServer(options);
  await server.start();
}
