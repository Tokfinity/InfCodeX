import { randomUUID } from 'node:crypto';
import type { KodaXSessionStorage } from '@kodax/coding';
import { FileSessionStorage, prepareRuntimeConfig } from '@kodax/repl';
import { createDefaultAampLogger, type AampLogger } from './aamp_logger.js';
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
  mailboxEmail?: string;
  logger?: AampLogger;
  sessionStorage?: KodaXSessionStorage;
  taskStore?: AampTaskStore;
}

let activeAampServerCount = 0;

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
  private readonly repoRoot: string;
  private readonly provider: string;
  private readonly model?: string;
  private readonly mailboxEmail?: string;
  private readonly logger: AampLogger;
  private started = false;

  constructor(options: KodaXAampServerOptions) {
    const config = prepareRuntimeConfig();
    const repoRoot = options.repoRoot ?? process.cwd();
    const provider = options.provider ?? config.provider ?? 'openai';
    const model = options.model ?? config.model;

    this.transport = options.transport;
    this.taskStore = options.taskStore ?? new FileAampTaskStore();
    this.repoRoot = repoRoot;
    this.provider = provider;
    this.model = model;
    this.mailboxEmail = options.mailboxEmail;
    this.logger = options.logger ?? createDefaultAampLogger();
    this.runtime = new KodaXAampRuntime({
      provider,
      model,
      repoRoot,
      sessionStorage: options.sessionStorage ?? new FileSessionStorage(),
    });
  }

  async start(): Promise<void> {
    if (this.started || activeAampServerCount > 0) {
      const error = new Error('AAMP server is already running in this process. Only one worker instance is allowed.');
      this.logger.error('worker.singleton_violation', 'refusing to start a second AAMP worker', {
        mailbox: this.mailboxEmail ?? '(configured elsewhere)',
      });
      throw error;
    }

    activeAampServerCount += 1;
    this.started = true;
    this.logger.info('worker.starting', 'worker starting', {
      mailbox: this.mailboxEmail ?? '(configured elsewhere)',
      repoRoot: this.repoRoot,
      provider: this.provider,
      model: this.model ?? '(default)',
    });
    try {
      await this.transport.listen(async (dispatch) => {
        await this.handleDispatch(dispatch);
      });
      this.logger.info('worker.started', 'worker listening for task.dispatch messages', {
        mailbox: this.mailboxEmail ?? '(configured elsewhere)',
      });
    } catch (error) {
      activeAampServerCount = Math.max(0, activeAampServerCount - 1);
      this.started = false;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('worker.start_failed', 'worker failed to start', {
        mailbox: this.mailboxEmail ?? '(configured elsewhere)',
        error: message,
      });
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    this.started = false;
    activeAampServerCount = Math.max(0, activeAampServerCount - 1);
    this.logger.info('worker.stopping', 'worker stopping', {
      mailbox: this.mailboxEmail ?? '(configured elsewhere)',
    });
    await this.transport.dispose?.();
  }

  async handleDispatch(dispatch: AampDispatchEnvelope): Promise<void> {
    let record = await this.taskStore.get(dispatch.taskId);
    if (!record) {
      this.logger.info('dispatch.received', 'received task.dispatch', {
        taskId: dispatch.taskId,
        sender: dispatch.from,
        messageId: dispatch.messageId,
        subject: dispatch.subject,
      });
      record = createTaskRecord(dispatch);
      await this.taskStore.put(record);
    }

    if (record.status === 'completed') {
      this.logger.info('dispatch.duplicate_skipped', 'skip duplicate completed task', {
        taskId: dispatch.taskId,
        sessionId: record.sessionId,
      });
      return;
    }

    this.logger.info('task.ack_sent', 'acknowledging task.dispatch', {
      taskId: dispatch.taskId,
      sender: dispatch.from,
      messageId: dispatch.messageId,
    });
    await this.transport.sendAck({
      taskId: dispatch.taskId,
      to: dispatch.from,
      inReplyToMessageId: dispatch.messageId,
    });
    record = await this.taskStore.update(dispatch.taskId, { status: 'acknowledged' });

    try {
      this.logger.info('task.running', 'executing task', {
        taskId: dispatch.taskId,
        sessionId: record.sessionId,
      });
      await this.taskStore.update(dispatch.taskId, { status: 'running' });
      const execution = await this.runtime.execute(dispatch, record);

      await this.transport.sendResult(execution.outbound);
      this.logger.info('task.result_sent', 'sent task.result', {
        taskId: dispatch.taskId,
        status: execution.outbound.status,
        sessionId: record.sessionId,
      });
      await this.taskStore.update(dispatch.taskId, {
        status: execution.outbound.status === 'completed' ? 'completed' : 'failed',
        resultSummary: execution.outbound.output,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error('task.failed', 'task failed', {
        taskId: dispatch.taskId,
        sessionId: record.sessionId,
        error: message,
      });
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

export function resetAampServerSingletonForTests(): void {
  activeAampServerCount = 0;
}
