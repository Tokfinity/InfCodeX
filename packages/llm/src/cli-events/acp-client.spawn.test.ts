import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

const { initializeMock, spawnMock } = vi.hoisted(() => ({
  initializeMock: vi.fn(async () => undefined),
  spawnMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('@agentclientprotocol/sdk', () => ({
  ClientSideConnection: class {
    readonly signal = new AbortController().signal;
    initialize = initializeMock;
  },
  PROTOCOL_VERSION: 1,
  ndJsonStream: vi.fn(() => ({})),
}));

const { AcpClient } = await import('./acp-client.js');

describe('AcpClient spawned server', () => {
  it('hides the native ACP server window in GUI hosts', async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
    };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    spawnMock.mockReturnValue(child);

    const client = new AcpClient({ command: 'test-acp', args: ['serve'] });
    await client.connect();

    expect(spawnMock.mock.calls[0]?.[2]?.windowsHide).toBe(true);
  });
});
