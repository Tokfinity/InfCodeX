import { AampClient, type AampClientConfig, type TaskDispatch } from 'aamp-sdk';
import { createDefaultAampLogger, type AampLogger } from './aamp_logger.js';
import type { AampDispatchEnvelope, AampTaskAck, AampTaskResult, AampTransport } from './aamp_types.js';

export type AampSdkTransportConfig = Omit<AampClientConfig, 'mailboxToken' | 'baseUrl'> & {
  mailboxToken?: string;
  baseUrl?: string;
  jmapToken?: string;
  jmapUrl?: string;
};

function toDispatchEnvelope(task: TaskDispatch): AampDispatchEnvelope {
  return {
    taskId: task.taskId,
    from: task.from,
    subject: task.subject,
    bodyText: task.bodyText,
    messageId: task.messageId,
    dispatchContext: task.dispatchContext,
  };
}

export class AampSdkTransport implements AampTransport {
  private readonly client: AampClient;
  private readonly logger: AampLogger;
  private connectionEventWired = false;

  constructor(config: AampSdkTransportConfig, logger: AampLogger = createDefaultAampLogger()) {
    const mailboxToken = config.mailboxToken ?? config.jmapToken;
    const baseUrl = config.baseUrl ?? config.jmapUrl;

    this.client = new AampClient({
      email: config.email,
      mailboxToken: mailboxToken!,
      baseUrl: baseUrl!,
      httpSendBaseUrl: config.httpSendBaseUrl,
      smtpHost: config.smtpHost,
      smtpPort: config.smtpPort,
      smtpPassword: config.smtpPassword,
      reconnectInterval: config.reconnectInterval,
      rejectUnauthorized: config.rejectUnauthorized,
    });
    this.logger = logger;
  }

  async listen(handler: (dispatch: AampDispatchEnvelope) => Promise<void>): Promise<void> {
    this.ensureConnectionEventLogging();
    this.client.on('task.dispatch', (task) => {
      const dispatch = toDispatchEnvelope(task);
      void handler(dispatch).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error('dispatch.handler_failed', 'task.dispatch handler failed', {
          mailbox: this.client.email,
          taskId: dispatch.taskId,
          error: message,
        });
      });
    });
    await this.client.connect();
  }

  async sendAck(_ack: AampTaskAck): Promise<void> {
    // aamp-sdk automatically sends task.ack for inbound task.dispatch messages.
  }

  async sendResult(result: AampTaskResult): Promise<void> {
    await this.client.sendResult({
      to: result.to,
      taskId: result.taskId,
      status: result.status === 'completed' ? 'completed' : 'rejected',
      output: result.output,
      errorMsg: result.status === 'failed' ? result.output : undefined,
      inReplyTo: result.inReplyToMessageId,
    });
  }

  async dispose(): Promise<void> {
    this.client.disconnect();
  }

  private ensureConnectionEventLogging(): void {
    if (this.connectionEventWired) {
      return;
    }

    this.connectionEventWired = true;
    this.client.on('connected', () => {
      const pollingFallback = this.client.isUsingPollingFallback();
      this.logger.info(
        pollingFallback ? 'jmap.connected_polling' : 'jmap.connected',
        pollingFallback ? 'connected using polling fallback' : 'connected to JMAP push',
        {
          mailbox: this.client.email,
          pollingFallback,
        },
      );
    });
    this.client.on('disconnected', (reason) => {
      this.logger.error(
        'jmap.disconnected',
        'JMAP connection disconnected',
        {
          mailbox: this.client.email,
          reason,
        },
      );
    });
    this.client.on('error', (error) => {
      const pollingFallback = this.client.isUsingPollingFallback();
      this.logger.error(
        pollingFallback ? 'jmap.polling_fallback' : 'jmap.error',
        error.message,
        {
          mailbox: this.client.email,
          pollingFallback,
        },
      );
    });
  }
}
