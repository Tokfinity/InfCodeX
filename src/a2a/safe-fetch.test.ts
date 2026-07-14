import { createServer } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { lookup } = vi.hoisted(() => ({
  lookup: vi.fn(async () => [{ address: '127.0.0.1', family: 4 as const }]),
}));

vi.mock('node:dns/promises', () => ({ lookup }));

import { decodeUtf8, safeA2AFetch } from './safe-fetch.js';

describe('safe A2A fetch', () => {
  const servers: Array<ReturnType<typeof createServer>> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })));
    lookup.mockClear();
  });

  it('uses the validated DNS address for the network connection', async () => {
    let acceptEncoding: string | undefined;
    const server = createServer((request, response) => {
      acceptEncoding = request.headers['accept-encoding'];
      response.setHeader('content-type', 'text/plain');
      response.end('pinned');
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected TCP server address.');
    const origin = `http://rebind.test:${address.port}`;

    const result = await safeA2AFetch(new URL(`${origin}/a2a`), {}, {
      allowedOrigins: [origin],
      allowPrivateAddresses: true,
      requestTimeoutMs: 1_000,
      maxResponseBytes: 1_024,
      maxRedirects: 0,
    });

    expect(decodeUtf8(result.body)).toBe('pinned');
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(acceptEncoding).toBe('identity');
  });
});
