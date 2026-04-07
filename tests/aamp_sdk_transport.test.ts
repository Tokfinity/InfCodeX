import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AampLogger } from '../src/aamp_logger.js';

const { clientInstances } = vi.hoisted(() => ({
  clientInstances: [] as Array<{
    email: string;
    pollingFallback: boolean;
    handlers: Map<string, (...args: any[]) => any>;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    sendResult: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock('aamp-sdk', () => ({
  AampClient: class {
    email: string;
    pollingFallback = false;
    handlers = new Map<string, (...args: any[]) => any>();
    connect = vi.fn(async () => undefined);
    disconnect = vi.fn(() => undefined);
    sendResult = vi.fn(async () => undefined);

    constructor(config: { email: string }) {
      this.email = config.email;
      clientInstances.push(this);
    }

    on(event: string, handler: (...args: any[]) => any): void {
      this.handlers.set(event, handler);
    }

    isUsingPollingFallback(): boolean {
      return this.pollingFallback;
    }
  },
}));

import { AampSdkTransport } from '../src/aamp_sdk_transport.js';

describe('AampSdkTransport', () => {
  let logger: AampLogger & {
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    clientInstances.length = 0;
    logger = {
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };
  });

  it('logs connection lifecycle events and forwards task.dispatch', async () => {
    const transport = new AampSdkTransport({
      email: 'agent@example.com',
      jmapToken: 'token',
      jmapUrl: 'https://meshmail.ai',
      smtpHost: 'meshmail.ai',
      smtpPassword: 'secret',
    }, logger);

    const handler = vi.fn(async () => undefined);
    await transport.listen(handler);

    const client = clientInstances[0]!;
    expect(client.connect).toHaveBeenCalledTimes(1);

    client.handlers.get('connected')?.();
    expect(logger.info).toHaveBeenCalledWith(
      'jmap.connected',
      'connected to JMAP push',
      expect.objectContaining({
        mailbox: 'agent@example.com',
        pollingFallback: false,
      }),
    );

    await client.handlers.get('task.dispatch')?.({
      taskId: 'task-1',
      from: 'sender@example.com',
      subject: 'hello',
      bodyText: 'hi',
      messageId: 'msg-1',
      dispatchContext: { project_key: 'proj_123' },
    });
    expect(handler).toHaveBeenCalledWith({
      taskId: 'task-1',
      from: 'sender@example.com',
      subject: 'hello',
      bodyText: 'hi',
      messageId: 'msg-1',
      dispatchContext: { project_key: 'proj_123' },
    });

    client.pollingFallback = true;
    client.handlers.get('error')?.(new Error('websocket handshake failed'));
    expect(logger.error).toHaveBeenCalledWith(
      'jmap.polling_fallback',
      'websocket handshake failed',
      expect.objectContaining({
        mailbox: 'agent@example.com',
        pollingFallback: true,
      }),
    );

    client.handlers.get('disconnected')?.('socket closed');
    expect(logger.error).toHaveBeenCalledWith(
      'jmap.disconnected',
      'JMAP connection disconnected',
      expect.objectContaining({
        mailbox: 'agent@example.com',
        reason: 'socket closed',
      }),
    );
  });
});
