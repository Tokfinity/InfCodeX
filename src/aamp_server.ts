import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { KodaXSessionStorage } from '@kodax/coding';
import { FileSessionStorage, prepareRuntimeConfig } from '@kodax/repl';
import { createDefaultAampLogger, type AampLogger } from './aamp_logger.js';
import type { AampTaskExecutionResult } from './aamp_runtime.js';
import { FileAampTaskStore } from './aamp_store.js';
import type {
  AampDispatchEnvelope,
  AampTaskRecord,
  AampTaskStore,
  AampTransport,
  AampWorkerInput,
} from './aamp_types.js';

/**
 * Handle to an agent process spawned for a single task.dispatch.
 * The process runs KodaXAampRuntime.execute in isolation.
 */
export interface AgentProcessHandle {
  /** OS process ID of the spawned agent process. */
  readonly pid: number;
  /** Send SIGTERM to the process to cancel the task. */
  kill(): void;
  /** Resolves with the execution result or rejects if the process fails/is killed. */
  readonly resultPromise: Promise<AampTaskExecutionResult>;
}

/**
 * Factory that spawns an agent process for each task.
 * The default implementation forks aamp_worker.js via IPC.
 * Inject a custom spawner in tests to avoid real process forks.
 */
export type AgentProcessSpawner = (
  dispatch: AampDispatchEnvelope,
  record: AampTaskRecord,
) => AgentProcessHandle;

function createDefaultProcessSpawner(options: {
  provider: string;
  model?: string;
  repoRoot: string;
}): AgentProcessSpawner {
  return (dispatch, record) => {
    const workerPath = fileURLToPath(new URL('./aamp_worker.js', import.meta.url));
    const workerInput: AampWorkerInput = {
      dispatch,
      record,
      provider: options.provider,
      model: options.model,
      repoRoot: options.repoRoot,
    };

    const child = fork(workerPath, [], {
      env: {
        ...process.env,
        AAMP_WORKER_INPUT: JSON.stringify(workerInput),
      },
      silent: true,
    });

    // Pipe worker output streams to the parent process.
    child.stdout?.on('data', (data: Buffer) => process.stdout.write(data));
    child.stderr?.on('data', (data: Buffer) => process.stderr.write(data));

    const resultPromise = new Promise<AampTaskExecutionResult>((resolve, reject) => {
      child.on('message', (msg) => resolve(msg as AampTaskExecutionResult));
      child.on('error', reject);
      child.on('exit', (code, signal) => {
        if (signal === 'SIGTERM' || signal === 'SIGKILL') {
          reject(new Error(`agent process killed with signal ${signal}`));
        } else if (code !== 0 && code !== null) {
          reject(new Error(`agent process exited with code ${code}`));
        }
      });
    });

    return {
      pid: child.pid!,
      kill: () => child.kill('SIGTERM'),
      resultPromise,
    };
  };
}

export interface KodaXAampServerOptions {
  transport: AampTransport;
  repoRoot?: string;
  provider?: string;
  model?: string;
  mailboxEmail?: string;
  logger?: AampLogger;
  /** @deprecated Session storage is now managed inside the spawned worker process. */
  sessionStorage?: KodaXSessionStorage;
  taskStore?: AampTaskStore;
  /**
   * Factory that creates an AgentProcessHandle for each task.
   * Defaults to forking aamp_worker.js. Inject a mock in tests.
   */
  processSpawner?: AgentProcessSpawner;
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
  private readonly repoRoot: string;
  private readonly provider: string;
  private readonly model?: string;
  private readonly mailboxEmail?: string;
  private readonly logger: AampLogger;
  private readonly processSpawner: AgentProcessSpawner;
  /** Maps taskId → running AgentProcessHandle for active tasks. */
  private readonly taskProcesses = new Map<string, AgentProcessHandle>();
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
    this.processSpawner =
      options.processSpawner ??
      createDefaultProcessSpawner({ provider, model, repoRoot });
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
      await this.transport.listen(
        async (dispatch) => {
          try {
            await this.handleDispatch(dispatch);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error('dispatch.unhandled_error', 'unhandled dispatch error', {
              taskId: dispatch.taskId,
              mailbox: this.mailboxEmail ?? '(configured elsewhere)',
              error: message,
            });
          }
        },
        (targetTaskId) => this.handleCancel(targetTaskId),
      );
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

  handleCancel(targetTaskId: string): void {
    const handle = this.taskProcesses.get(targetTaskId);
    if (handle) {
      this.logger.info('task.cancel_requested', 'cancelling running task process', {
        targetTaskId,
        pid: handle.pid,
        mailbox: this.mailboxEmail ?? '(configured elsewhere)',
      });
      handle.kill();
      this.taskProcesses.delete(targetTaskId);
    } else {
      this.logger.info('task.cancel_not_found', 'no running process found for cancel target', {
        targetTaskId,
        mailbox: this.mailboxEmail ?? '(configured elsewhere)',
      });
    }
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

      const handle = this.processSpawner(dispatch, record);
      this.taskProcesses.set(dispatch.taskId, handle);
      this.logger.info('task.process_spawned', 'agent process spawned', {
        taskId: dispatch.taskId,
        pid: handle.pid,
      });

      let execution: AampTaskExecutionResult;
      try {
        execution = await handle.resultPromise;
      } finally {
        this.taskProcesses.delete(dispatch.taskId);
      }

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
      try {
        await this.transport.sendResult({
          taskId: dispatch.taskId,
          to: dispatch.from,
          status: 'failed',
          output: message,
          inReplyToMessageId: dispatch.messageId,
        });
      } catch (sendError) {
        this.logger.error('task.failure_result_send_failed', 'failed to send failed task.result', {
          taskId: dispatch.taskId,
          sessionId: record.sessionId,
          error: sendError instanceof Error ? sendError.message : String(sendError),
          originalError: message,
        });
      }
      try {
        await this.taskStore.update(dispatch.taskId, {
          status: 'failed',
          resultSummary: message,
        });
      } catch (updateError) {
        this.logger.error('task.failure_state_update_failed', 'failed to persist failed task state', {
          taskId: dispatch.taskId,
          sessionId: record.sessionId,
          error: updateError instanceof Error ? updateError.message : String(updateError),
          originalError: message,
        });
      }
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
