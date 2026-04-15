import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import type { KodaXSessionStorage } from '@kodax-ai/coding';
import { prepareRuntimeConfig } from '@kodax-ai/repl';
import { createDefaultAampLogger, type AampLogger } from './aamp_logger.js';
import type { AampTaskExecutionResult } from './aamp_runtime.js';
import { FileAampTaskStore } from './aamp_store.js';
import type {
  AampDispatchEnvelope,
  AampTaskRecord,
  AampTaskStore,
  AampTransport,
  AampWorkerInput,
  WorkerStreamEventMessage,
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
  streamOptions?: {
    streamId: string;
    onStreamEvent: (msg: WorkerStreamEventMessage) => void;
  },
) => AgentProcessHandle;

/**
 * The role text that identifies a streaming-eligible engineering task.
 * Only dispatches whose bodyText contains this role get real-time streaming.
 */
const STREAMING_ROLE_MARKER = '你是一名负责在本地仓库内执行开发任务的工程师。';

function isStreamingTask(dispatch: AampDispatchEnvelope): boolean {
  return dispatch.bodyText.includes(STREAMING_ROLE_MARKER);
}

function isWorkerStreamEvent(msg: unknown): msg is WorkerStreamEventMessage {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    '__streamEvent' in msg &&
    (msg as WorkerStreamEventMessage).__streamEvent === true
  );
}

function createDefaultProcessSpawner(options: {
  provider: string;
  model?: string;
  repoRoot: string;
  dangerousFullPermissions: boolean;
}): AgentProcessSpawner {
  return (dispatch, record, streamOptions) => {
    const workerPath = fileURLToPath(new URL('./aamp_worker.js', import.meta.url));
    const workerInput: AampWorkerInput = {
      dispatch,
      record,
      provider: options.provider,
      model: options.model,
      repoRoot: options.repoRoot,
      dangerousFullPermissions: options.dangerousFullPermissions,
    };

    // When streaming is active, pass streamId so the worker knows to send incremental events.
    if (streamOptions) {
      workerInput.streamId = streamOptions.streamId;
    }

    const workerEnv: NodeJS.ProcessEnv = {
      ...process.env,
      AAMP_WORKER_INPUT: JSON.stringify(workerInput),
    };
    // Child process stdout is piped (not a TTY), so chalk auto-detect would disable colors.
    // Preserve terminal color output by forwarding FORCE_COLOR from parent when appropriate.
    if (!workerEnv.FORCE_COLOR && process.stdout.isTTY) {
      workerEnv.FORCE_COLOR = '1';
    }

    const child = fork(workerPath, [], {
      env: workerEnv,
      silent: true,
    });

    // Pipe worker output streams to the parent process.
    child.stdout?.on('data', (data: Buffer) => process.stdout.write(data));
    child.stderr?.on('data', (data: Buffer) => process.stderr.write(data));

    const resultPromise = new Promise<AampTaskExecutionResult>((resolve, reject) => {
      let settled = false;
      const resolveOnce = (value: AampTaskExecutionResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(value);
      };
      const rejectOnce = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      };

      child.on('message', (msg) => {
        if (streamOptions && isWorkerStreamEvent(msg)) {
          streamOptions.onStreamEvent(msg);
        } else {
          resolveOnce(msg as AampTaskExecutionResult);
        }
      });
      child.on('error', (error) => rejectOnce(error));
      child.on('exit', (code, signal) => {
        if (settled) {
          return;
        }
        if (signal === 'SIGTERM' || signal === 'SIGKILL') {
          rejectOnce(new Error(`agent process killed with signal ${signal}`));
          return;
        }
        if (code === 0) {
          rejectOnce(new Error('agent process exited before sending result'));
          return;
        }
        if (code !== null) {
          rejectOnce(new Error(`agent process exited with code ${code}`));
          return;
        }
        rejectOnce(new Error('agent process exited before sending result'));
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
  dangerousFullPermissions?: boolean;
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
  private readonly dangerousFullPermissions: boolean;
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
    this.dangerousFullPermissions = options.dangerousFullPermissions === true;
    this.mailboxEmail = options.mailboxEmail;
    this.logger = options.logger ?? createDefaultAampLogger();
    this.processSpawner =
      options.processSpawner ??
      createDefaultProcessSpawner({
        provider,
        model,
        repoRoot,
        dangerousFullPermissions: this.dangerousFullPermissions,
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
      dangerousFullPermissions: this.dangerousFullPermissions,
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

    // ── Streaming setup for eligible tasks ──
    const streaming = isStreamingTask(dispatch);
    let streamId: string | undefined;

    if (streaming && this.transport.createStream && this.transport.sendStreamOpened && this.transport.appendStreamEvent) {
      try {
        const stream = await this.transport.createStream({
          taskId: dispatch.taskId,
          peerEmail: dispatch.from,
        });
        streamId = stream.streamId;

        await this.transport.sendStreamOpened({
          to: dispatch.from,
          taskId: dispatch.taskId,
          streamId,
          inReplyTo: dispatch.messageId,
        });

        await this.transport.appendStreamEvent({
          streamId,
          type: 'status',
          payload: { stage: 'running', message: 'agent accepted task' },
        });

        this.logger.info('stream.opened', 'streaming enabled for task', {
          taskId: dispatch.taskId,
          streamId,
        });
        process.stdout.write(
          `\n${chalk.bgMagenta.bold(' ⚡ STREAM ')} ${chalk.magentaBright('streaming response activated')}` +
          ` ${chalk.dim('taskId=')}${dispatch.taskId}` +
          ` ${chalk.dim('streamId=')}${streamId}\n\n`,
        );
      } catch (streamError) {
        const msg = streamError instanceof Error ? streamError.message : String(streamError);
        this.logger.error('stream.setup_failed', 'failed to set up stream, proceeding without streaming', {
          taskId: dispatch.taskId,
          error: msg,
        });
        streamId = undefined;
      }
    }

    try {
      this.logger.info('task.running', 'executing task', {
        taskId: dispatch.taskId,
        sessionId: record.sessionId,
      });
      await this.taskStore.update(dispatch.taskId, { status: 'running' });

      // Build stream options for the spawner when streaming is active.
      const streamOptions = streamId && this.transport.appendStreamEvent
        ? {
            streamId,
            onStreamEvent: (msg: WorkerStreamEventMessage) => {
              this.transport.appendStreamEvent!({
                streamId: streamId!,
                type: msg.eventType,
                payload: msg.payload,
              }).catch((err) => {
                const errMsg = err instanceof Error ? err.message : String(err);
                this.logger.error('stream.append_failed', 'failed to append stream event', {
                  taskId: dispatch.taskId,
                  streamId: streamId!,
                  error: errMsg,
                });
              });
            },
          }
        : undefined;

      const handle = this.processSpawner(dispatch, record, streamOptions);
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

      // ── Stream teardown ──
      if (streamId && this.transport.appendStreamEvent && this.transport.closeStream) {
        try {
          await this.transport.appendStreamEvent({
            streamId,
            type: 'done',
            payload: { reason: 'completed' },
          });
          await this.transport.closeStream({
            streamId,
            payload: { reason: 'completed' },
          });
          this.logger.info('stream.closed', 'stream closed', {
            taskId: dispatch.taskId,
            streamId,
          });
          process.stdout.write(
            `\n${chalk.bgGreen.bold(' ✓ STREAM ')} ${chalk.greenBright('stream closed')}` +
            ` ${chalk.dim('taskId=')}${dispatch.taskId}\n`,
          );
        } catch (streamError) {
          const msg = streamError instanceof Error ? streamError.message : String(streamError);
          this.logger.error('stream.close_failed', 'failed to close stream', {
            taskId: dispatch.taskId,
            streamId,
            error: msg,
          });
        }
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

      // ── Stream error teardown ──
      if (streamId && this.transport.appendStreamEvent && this.transport.closeStream) {
        try {
          await this.transport.appendStreamEvent({
            streamId,
            type: 'error',
            payload: { message },
          });
          await this.transport.closeStream({
            streamId,
            payload: { reason: 'failed', error: message },
          });
        } catch {
          // Best-effort; error already logged above.
        }
      }

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
