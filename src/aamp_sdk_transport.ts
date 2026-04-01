import { AampClient, type AampClientConfig, type TaskDispatch } from 'aamp-sdk';
import type { AampDispatchEnvelope, AampTaskAck, AampTaskResult, AampTransport } from './aamp_types.js';

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

  constructor(config: AampClientConfig) {
    this.client = new AampClient(config);
  }

  async listen(handler: (dispatch: AampDispatchEnvelope) => Promise<void>): Promise<void> {
    this.client.on('task.dispatch', async (task) => {
      await handler(toDispatchEnvelope(task));
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
}
