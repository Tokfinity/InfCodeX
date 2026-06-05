import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createSseTransport, createStreamableHttpTransport } from './transport.js';

// ---------------------------------------------------------------------------
// Minimal SSE server for testing
// ---------------------------------------------------------------------------

function createTestSseServer(): {
  server: http.Server;
  start: () => Promise<{ url: string }>;
  stop: () => Promise<void>;
  postEndpoint: string;
  /** Messages POSTed to the endpoint by the transport. */
  receivedMessages: string[];
  /** Send an SSE event to the connected client. */
  sendEvent: (event: string, data: string) => void;
} {
  const receivedMessages: string[] = [];
  let sseResponse: http.ServerResponse | undefined;
  let postEndpoint = '';

  const sendEvent = (event: string, data: string) => {
    sseResponse?.write(`event:${event}\ndata:${data}\n\n`);
  };

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.headers.accept?.includes('text/event-stream')) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      sseResponse = res;
      // Send endpoint event.
      sendEvent('endpoint', postEndpoint);
      return;
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        receivedMessages.push(body);
        // Parse JSON-RPC and echo a response.
        try {
          const parsed = JSON.parse(body) as { id?: number; method?: string };
          if (parsed.id !== undefined) {
            const responsePayload = JSON.stringify({
              jsonrpc: '2.0',
              id: parsed.id,
              result: { echo: parsed.method },
            });
            // Send as SSE message event.
            sendEvent('message', responsePayload);
          }
        } catch {
          // Ignore parse errors.
        }
        res.writeHead(202);
        res.end();
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  return {
    server,
    receivedMessages,
    postEndpoint,
    sendEvent,
    start: () => new Promise<{ url: string }>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        const url = `http://127.0.0.1:${addr.port}`;
        postEndpoint = `${url}/messages`;
        resolve({ url });
      });
    }),
    stop: () => new Promise<void>((resolve) => {
      sseResponse?.end();
      server.close(() => resolve());
    }),
  };
}

// ---------------------------------------------------------------------------
// Minimal Streamable HTTP server for testing
// ---------------------------------------------------------------------------

function createTestStreamableHttpServer(): {
  server: http.Server;
  start: () => Promise<{ url: string }>;
  stop: () => Promise<void>;
  receivedMessages: string[];
  mode: 'json' | 'sse';
} {
  const receivedMessages: string[] = [];
  const state = { mode: 'json' as 'json' | 'sse' };

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.headers.accept?.includes('text/event-stream')) {
      // Optional notification stream — return 405 to signal unsupported.
      res.writeHead(405);
      res.end();
      return;
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        receivedMessages.push(body);
        try {
          const parsed = JSON.parse(body) as { id?: number; method?: string };
          const responsePayload = JSON.stringify({
            jsonrpc: '2.0',
            id: parsed.id,
            result: { echo: parsed.method },
          });

          if (state.mode === 'sse') {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write(`event:message\ndata:${responsePayload}\n\n`);
            res.end();
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(responsePayload);
          }
        } catch {
          res.writeHead(400);
          res.end();
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  return {
    server,
    receivedMessages,
    get mode() { return state.mode; },
    set mode(m) { state.mode = m; },
    start: () => new Promise<{ url: string }>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        resolve({ url: `http://127.0.0.1:${addr.port}` });
      });
    }),
    stop: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
    }),
  };
}

function createSessionStreamableHttpServer(): {
  server: http.Server;
  start: () => Promise<{ url: string }>;
  stop: () => Promise<void>;
  receivedMessages: string[];
  observedSessionHeaders: string[];
  observedGetSessionHeaders: string[];
  deleteSessionHeaders: string[];
  sessionId: string;
} {
  const sessionId = 'session-abc-123';
  const receivedMessages: string[] = [];
  const observedSessionHeaders: string[] = [];
  const observedGetSessionHeaders: string[] = [];
  const deleteSessionHeaders: string[] = [];

  const server = http.createServer((req, res) => {
    const requestSessionId = req.headers['mcp-session-id'];
    const normalizedSessionId = Array.isArray(requestSessionId)
      ? requestSessionId[0] ?? ''
      : requestSessionId ?? '';

    if (req.method === 'GET' && req.headers.accept?.includes('text/event-stream')) {
      observedGetSessionHeaders.push(normalizedSessionId);
      if (normalizedSessionId !== sessionId) {
        res.writeHead(400);
        res.end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.end();
      return;
    }

    if (req.method === 'DELETE') {
      deleteSessionHeaders.push(normalizedSessionId);
      if (normalizedSessionId !== sessionId) {
        res.writeHead(400);
        res.end();
        return;
      }
      res.writeHead(200);
      res.end();
      return;
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        receivedMessages.push(body);
        try {
          const parsed = JSON.parse(body) as { id?: number; method?: string };
          if (parsed.method !== 'initialize') {
            observedSessionHeaders.push(normalizedSessionId);
            if (normalizedSessionId !== sessionId) {
              res.writeHead(400);
              res.end();
              return;
            }
          }

          if (parsed.method === 'initialize') {
            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Mcp-Session-Id': sessionId,
            });
            res.end(JSON.stringify({
              jsonrpc: '2.0',
              id: parsed.id,
              result: {
                protocolVersion: '2025-06-18',
                capabilities: {},
                serverInfo: { name: 'session-test', version: '1.0.0' },
              },
            }));
            return;
          }

          if (parsed.id === undefined) {
            res.writeHead(202);
            res.end();
            return;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: parsed.id,
            result: { ok: true, method: parsed.method },
          }));
        } catch {
          res.writeHead(400);
          res.end();
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  return {
    server,
    receivedMessages,
    observedSessionHeaders,
    observedGetSessionHeaders,
    deleteSessionHeaders,
    sessionId,
    start: () => new Promise<{ url: string }>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        resolve({ url: `http://127.0.0.1:${addr.port}` });
      });
    }),
    stop: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
    }),
  };
}

// =========================================================================
// Tests
// =========================================================================

describe('SSE transport', () => {
  const servers: Array<{ stop: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.stop()));
  });

  it('connects, receives endpoint event, sends JSON-RPC, receives SSE response', async () => {
    const mock = createTestSseServer();
    servers.push(mock);
    const { url } = await mock.start();
    // The endpoint URL needs to be set after the server starts.
    (mock as { postEndpoint: string }).postEndpoint = `${url}/messages`;

    const transport = createSseTransport({ url });
    const messages: string[] = [];

    await transport.open({
      onMessage: (raw) => messages.push(raw),
      onError: () => {},
      onClose: () => {},
    });

    expect(transport.connected).toBe(true);

    // Send a JSON-RPC request.
    await transport.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'test/echo', params: {} }));

    // Wait for the SSE response.
    await new Promise((r) => setTimeout(r, 200));

    expect(mock.receivedMessages.length).toBeGreaterThanOrEqual(1);
    expect(messages.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(messages[0]!) as { id: number; result: { echo: string } };
    expect(parsed.id).toBe(1);
    expect(parsed.result.echo).toBe('test/echo');

    await transport.close();
  });
});

describe('Streamable HTTP transport', () => {
  const servers: Array<{ stop: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.stop()));
  });

  it('sends JSON-RPC and receives JSON response', async () => {
    const mock = createTestStreamableHttpServer();
    mock.mode = 'json';
    servers.push(mock);
    const { url } = await mock.start();

    const transport = createStreamableHttpTransport({ url });
    const messages: string[] = [];

    await transport.open({
      onMessage: (raw) => messages.push(raw),
      onError: () => {},
      onClose: () => {},
    });

    await transport.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'test/json', params: {} }));

    // send() should have delivered the response synchronously via onMessage.
    expect(messages).toHaveLength(1);
    const parsed = JSON.parse(messages[0]!) as { id: number; result: { echo: string } };
    expect(parsed.id).toBe(1);
    expect(parsed.result.echo).toBe('test/json');

    await transport.close();
  });

  it('sends JSON-RPC and receives SSE streamed response', async () => {
    const mock = createTestStreamableHttpServer();
    mock.mode = 'sse';
    servers.push(mock);
    const { url } = await mock.start();

    const transport = createStreamableHttpTransport({ url });
    const messages: string[] = [];

    await transport.open({
      onMessage: (raw) => messages.push(raw),
      onError: () => {},
      onClose: () => {},
    });

    await transport.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'test/sse', params: {} }));

    expect(messages).toHaveLength(1);
    const parsed = JSON.parse(messages[0]!) as { id: number; result: { echo: string } };
    expect(parsed.id).toBe(2);
    expect(parsed.result.echo).toBe('test/sse');

    await transport.close();
  });

  it('persists Mcp-Session-Id from initialize and sends it on later POST, GET, and DELETE requests', async () => {
    const mock = createSessionStreamableHttpServer();
    servers.push(mock);
    const { url } = await mock.start();

    const transport = createStreamableHttpTransport({ url });
    const messages: string[] = [];

    await transport.open({
      onMessage: (raw) => messages.push(raw),
      onError: () => {},
      onClose: () => {},
    });

    await transport.send(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    }));
    await transport.send(JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
      params: {},
    }));
    await transport.send(JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    }));

    await new Promise((resolve) => setTimeout(resolve, 50));
    await transport.close();

    expect(messages).toHaveLength(2);
    expect(mock.observedSessionHeaders).toEqual([
      mock.sessionId,
      mock.sessionId,
    ]);
    expect(mock.observedGetSessionHeaders).toContain(mock.sessionId);
    expect(mock.deleteSessionHeaders).toEqual([mock.sessionId]);
  });
});
