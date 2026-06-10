import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { McpServerRuntime } from './runtime.js';
import type { McpReverseCapabilities } from './reverse-capabilities.js';

type JsonObject = Record<string, unknown>;

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kodax-mcp-runtime-'));
  tempDirs.push(dir);
  return dir;
}

function asRecord(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function getHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function writeJsonRpcResponse(
  res: http.ServerResponse,
  id: unknown,
  result: JsonObject,
  headers: Record<string, string> = {},
): void {
  res.writeHead(200, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
}

async function writeScript(dir: string, source: string): Promise<string> {
  const scriptPath = path.join(dir, 'server.cjs');
  await writeFile(scriptPath, source, 'utf8');
  return scriptPath;
}

function createNdjsonServerSource(options: {
  startsPath: string;
  protocolPath?: string;
  responseProtocolVersion?: string;
}): string {
  const responseProtocolVersion = options.responseProtocolVersion ?? '2025-11-25';
  return `
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(options.startsPath)}, 'start\\n');
let buffer = '';

function writeMessage(payload) {
  process.stdout.write(JSON.stringify(payload) + '\\n');
}

function writeList(id, key) {
  const result = {};
  result[key] = key === 'tools'
    ? [{ name: 'echo_tool', inputSchema: { type: 'object' } }]
    : [];
  writeMessage({ jsonrpc: '2.0', id, result });
}

function handle(message) {
  const method = message.method;
  if (method === 'initialize') {
    ${options.protocolPath
    ? `fs.writeFileSync(${JSON.stringify(options.protocolPath)}, String((message.params || {}).protocolVersion || ''));`
    : ''}
    writeMessage({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: ${JSON.stringify(responseProtocolVersion)},
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: 'runtime-test', version: '1.0.0' },
      },
    });
    return;
  }
  if (method === 'tools/list') {
    writeList(message.id, 'tools');
    return;
  }
  if (method === 'resources/list') {
    writeList(message.id, 'resources');
    return;
  }
  if (method === 'prompts/list') {
    writeList(message.id, 'prompts');
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const lineEnd = buffer.indexOf('\\n');
    if (lineEnd < 0) {
      return;
    }
    const line = buffer.slice(0, lineEnd).replace(/\\r$/, '').trim();
    buffer = buffer.slice(lineEnd + 1);
    if (!line) {
      continue;
    }
    try {
      handle(JSON.parse(line));
    } catch {
      process.exit(2);
    }
  }
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
`;
}

function createContentLengthServerSource(startsPath: string): string {
  return `
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(startsPath)}, 'start\\n');
let buffer = Buffer.alloc(0);

function writeMessage(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  process.stdout.write('Content-Length: ' + body.length + '\\r\\n\\r\\n');
  process.stdout.write(body);
}

function writeList(id, key) {
  const result = {};
  result[key] = key === 'tools'
    ? [{ name: 'legacy_tool', inputSchema: { type: 'object' } }]
    : [];
  writeMessage({ jsonrpc: '2.0', id, result });
}

function handle(message) {
  const method = message.method;
  if (method === 'initialize') {
    writeMessage({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: 'legacy-runtime-test', version: '1.0.0' },
      },
    });
    return;
  }
  if (method === 'tools/list') {
    writeList(message.id, 'tools');
    return;
  }
  if (method === 'resources/list') {
    writeList(message.id, 'resources');
    return;
  }
  if (method === 'prompts/list') {
    writeList(message.id, 'prompts');
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  if (buffer[0] === 0x7B) {
    process.exit(3);
  }
  while (true) {
    const headerEnd = buffer.indexOf('\\r\\n\\r\\n');
    if (headerEnd < 0) {
      return;
    }
    const header = buffer.subarray(0, headerEnd).toString('utf8');
    const match = header.match(/Content-Length:\\s*(\\d+)/i);
    if (!match) {
      process.exit(4);
    }
    const length = Number(match[1]);
    const frameEnd = headerEnd + 4 + length;
    if (buffer.length < frameEnd) {
      return;
    }
    const body = buffer.subarray(headerEnd + 4, frameEnd).toString('utf8');
    buffer = buffer.subarray(frameEnd);
    handle(JSON.parse(body));
  }
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
`;
}

function createCapabilityServerSource(options: {
  pongPath: string;
  numberPongPath?: string;
  cancelPath: string;
}): string {
  return `
const fs = require('node:fs');
let buffer = '';

function writeMessage(payload) {
  process.stdout.write(JSON.stringify(payload) + '\\n');
}

function handle(message) {
  // Response from the client (e.g. our ping's pong) — no method, has result.
  if (message.method === undefined && message.id !== undefined && message.result !== undefined) {
    if (message.id === 'srv-ping') {
      fs.writeFileSync(${JSON.stringify(options.pongPath)}, 'pong');
    }
    if (message.id === 42 && ${options.numberPongPath ? 'true' : 'false'}) {
      fs.writeFileSync(${JSON.stringify(options.numberPongPath ?? '')}, 'pong-number');
    }
    return;
  }
  const method = message.method;
  if (method === 'initialize') {
    writeMessage({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: 'cap-test', version: '1.0.0' },
      },
    });
    // Proactively ping the client; the spec requires an empty-result reply.
    writeMessage({ jsonrpc: '2.0', id: 'srv-ping', method: 'ping' });
    writeMessage({ jsonrpc: '2.0', id: 42, method: 'ping' });
    return;
  }
  if (method === 'notifications/cancelled') {
    fs.appendFileSync(${JSON.stringify(options.cancelPath)}, JSON.stringify(message.params) + '\\n');
    return;
  }
  if (method === 'tools/list') {
    writeMessage({ jsonrpc: '2.0', id: message.id, result: { tools: [
      {
        name: 'safe_tool',
        inputSchema: { type: 'object' },
        icons: [{ src: 'https://example.com/i.png' }, { src: 'javascript:bad' }],
        execution: { taskSupport: 'optional' },
      },
      { name: 'task_only', inputSchema: { type: 'object' }, execution: { taskSupport: 'required' } },
    ] } });
    return;
  }
  if (method === 'resources/list') {
    writeMessage({ jsonrpc: '2.0', id: message.id, result: { resources: [] } });
    return;
  }
  if (method === 'prompts/list') {
    writeMessage({ jsonrpc: '2.0', id: message.id, result: { prompts: [] } });
    return;
  }
  // tools/call is intentionally left unanswered so the client times out and
  // (per spec) emits notifications/cancelled.
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const lineEnd = buffer.indexOf('\\n');
    if (lineEnd < 0) {
      return;
    }
    const line = buffer.slice(0, lineEnd).replace(/\\r$/, '').trim();
    buffer = buffer.slice(lineEnd + 1);
    if (!line) {
      continue;
    }
    try {
      handle(JSON.parse(line));
    } catch {
      process.exit(2);
    }
  }
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
`;
}

function createUnsupportedRequestsServerSource(recordPath: string): string {
  return `
const fs = require('node:fs');
let buffer = '';

function writeMessage(payload) {
  process.stdout.write(JSON.stringify(payload) + '\\n');
}

function record(payload) {
  fs.appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify(payload) + '\\n');
}

function handle(message) {
  if (message.method === undefined && message.id !== undefined) {
    record(message);
    return;
  }
  if (message.method === 'initialize') {
    writeMessage({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {}, resources: {}, prompts: {} },
        serverInfo: { name: 'unsupported-requests-test', version: '1.0.0' },
      },
    });
    writeMessage({ jsonrpc: '2.0', id: 'roots-1', method: 'roots/list' });
    writeMessage({ jsonrpc: '2.0', id: 'sampling-1', method: 'sampling/createMessage', params: {} });
    writeMessage({ jsonrpc: '2.0', id: 'elicitation-1', method: 'elicitation/create', params: {} });
    return;
  }
  if (message.method === 'tools/list') {
    writeMessage({ jsonrpc: '2.0', id: message.id, result: { tools: [] } });
    return;
  }
  if (message.method === 'resources/list') {
    writeMessage({ jsonrpc: '2.0', id: message.id, result: { resources: [] } });
    return;
  }
  if (message.method === 'prompts/list') {
    writeMessage({ jsonrpc: '2.0', id: message.id, result: { prompts: [] } });
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const lineEnd = buffer.indexOf('\\n');
    if (lineEnd < 0) {
      return;
    }
    const line = buffer.slice(0, lineEnd).replace(/\\r$/, '').trim();
    buffer = buffer.slice(lineEnd + 1);
    if (!line) {
      continue;
    }
    try {
      handle(JSON.parse(line));
    } catch {
      process.exit(2);
    }
  }
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
`;
}

function createRootsServerSource(recordPath: string): string {
  return `
const fs = require('node:fs');
let buffer = '';
function writeMessage(p){ process.stdout.write(JSON.stringify(p) + '\\n'); }
function record(p){ fs.appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify(p) + '\\n'); }
function handle(m){
  if (m.method === undefined && m.id !== undefined) { record(m); return; } // client response
  if (m.method === 'initialize') {
    record(m); // capture the negotiated capabilities
    writeMessage({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'roots-test', version: '1.0.0' } } });
    writeMessage({ jsonrpc: '2.0', id: 'roots-1', method: 'roots/list' });
    return;
  }
  if (m.method === 'tools/list'){ writeMessage({ jsonrpc: '2.0', id: m.id, result: { tools: [] } }); return; }
  if (m.method === 'resources/list'){ writeMessage({ jsonrpc: '2.0', id: m.id, result: { resources: [] } }); return; }
  if (m.method === 'prompts/list'){ writeMessage({ jsonrpc: '2.0', id: m.id, result: { prompts: [] } }); }
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const lineEnd = buffer.indexOf('\\n');
    if (lineEnd < 0) { return; }
    const line = buffer.slice(0, lineEnd).replace(/\\r$/, '').trim();
    buffer = buffer.slice(lineEnd + 1);
    if (!line) { continue; }
    try { handle(JSON.parse(line)); } catch { process.exit(2); }
  }
});
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
`;
}

function createElicitationServerSource(recordPath: string): string {
  return `
const fs = require('node:fs');
let buffer = '';
function writeMessage(p){ process.stdout.write(JSON.stringify(p) + '\\n'); }
function record(p){ fs.appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify(p) + '\\n'); }
function handle(m){
  if (m.method === undefined && m.id !== undefined) { record(m); return; } // client response
  if (m.method === 'initialize') {
    record(m);
    writeMessage({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'elicit-test', version: '1.0.0' } } });
    writeMessage({ jsonrpc: '2.0', id: 'elicit-1', method: 'elicitation/create', params: { mode: 'form', message: 'Your name?', requestedSchema: { type: 'object', properties: { username: { type: 'string' } }, required: ['username'] } } });
    return;
  }
  if (m.method === 'tools/list'){ writeMessage({ jsonrpc: '2.0', id: m.id, result: { tools: [] } }); return; }
  if (m.method === 'resources/list'){ writeMessage({ jsonrpc: '2.0', id: m.id, result: { resources: [] } }); return; }
  if (m.method === 'prompts/list'){ writeMessage({ jsonrpc: '2.0', id: m.id, result: { prompts: [] } }); }
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const lineEnd = buffer.indexOf('\\n');
    if (lineEnd < 0) { return; }
    const line = buffer.slice(0, lineEnd).replace(/\\r$/, '').trim();
    buffer = buffer.slice(lineEnd + 1);
    if (!line) { continue; }
    try { handle(JSON.parse(line)); } catch { process.exit(2); }
  }
});
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
`;
}

function createUrlElicitationServerSource(recordPath: string): string {
  return `
const fs = require('node:fs');
let buffer = '';
function writeMessage(p){ process.stdout.write(JSON.stringify(p) + '\\n'); }
function record(p){ fs.appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify(p) + '\\n'); }
function handle(m){
  if (m.method === undefined && m.id !== undefined) { record(m); return; } // client response
  if (m.method === 'initialize') {
    record(m);
    writeMessage({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'url-elicit-test', version: '1.0.0' } } });
    writeMessage({ jsonrpc: '2.0', id: 'url-1', method: 'elicitation/create', params: { mode: 'url', message: 'Authorize', url: 'https://auth.example.test/grant', elicitationId: 'flow-1' } });
    return;
  }
  if (m.method === undefined) { return; }
  if (m.method === 'tools/list'){ writeMessage({ jsonrpc: '2.0', id: m.id, result: { tools: [] } }); return; }
  if (m.method === 'resources/list'){ writeMessage({ jsonrpc: '2.0', id: m.id, result: { resources: [] } }); return; }
  if (m.method === 'prompts/list'){
    writeMessage({ jsonrpc: '2.0', id: m.id, result: { prompts: [] } });
    // After the catalog round-trip, signal the url elicitation completed.
    writeMessage({ jsonrpc: '2.0', method: 'notifications/elicitation/complete', params: { elicitationId: 'flow-1' } });
  }
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const lineEnd = buffer.indexOf('\\n');
    if (lineEnd < 0) { return; }
    const line = buffer.slice(0, lineEnd).replace(/\\r$/, '').trim();
    buffer = buffer.slice(lineEnd + 1);
    if (!line) { continue; }
    try { handle(JSON.parse(line)); } catch { process.exit(2); }
  }
});
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
`;
}

async function createRuntime(
  dir: string,
  scriptPath: string,
  startupTimeoutMs = 1_000,
  requestTimeoutMs = 1_000,
  reverse?: McpReverseCapabilities,
): Promise<McpServerRuntime> {
  return new McpServerRuntime(
    'test-server',
    {
      type: 'stdio',
      command: process.execPath,
      args: [scriptPath],
      connect: 'lazy',
      startupTimeoutMs,
      requestTimeoutMs,
    },
    path.join(dir, 'cache'),
    reverse,
  );
}

async function startHttpServer(
  handler: http.RequestListener,
): Promise<{ url: string; stop: () => Promise<void> }> {
  const server = http.createServer(handler);
  const url = await new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
  return {
    url,
    stop: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
    }),
  };
}

describe('McpServerRuntime protocol compatibility', () => {
  it('connects to standard stdio NDJSON servers on the first attempt', async () => {
    const dir = await createTempDir();
    const startsPath = path.join(dir, 'starts.txt');
    const protocolPath = path.join(dir, 'protocol.txt');
    const scriptPath = await writeScript(dir, createNdjsonServerSource({
      startsPath,
      protocolPath,
    }));
    const runtime = await createRuntime(dir, scriptPath);

    try {
      await runtime.refreshCatalog(true);
    } finally {
      await runtime.dispose();
    }

    const starts = await readFile(startsPath, 'utf8');
    const requestedVersion = await readFile(protocolPath, 'utf8');
    expect(starts.trim().split('\n')).toHaveLength(1);
    expect(requestedVersion).toBe('2025-11-25');
    expect(runtime.getDiagnostics().tools).toBe(1);
  });

  it('keeps Content-Length as a fallback for legacy stdio servers', async () => {
    const dir = await createTempDir();
    const startsPath = path.join(dir, 'starts.txt');
    const scriptPath = await writeScript(dir, createContentLengthServerSource(startsPath));
    const runtime = await createRuntime(dir, scriptPath);

    try {
      await runtime.refreshCatalog(true);
    } finally {
      await runtime.dispose();
    }

    const starts = await readFile(startsPath, 'utf8');
    expect(starts.trim().split('\n')).toHaveLength(2);
    expect(runtime.getDiagnostics().tools).toBe(1);
  });

  it('rejects unsupported server protocol versions instead of trying another framing', async () => {
    const dir = await createTempDir();
    const startsPath = path.join(dir, 'starts.txt');
    const scriptPath = await writeScript(dir, createNdjsonServerSource({
      startsPath,
      responseProtocolVersion: '2099-01-01',
    }));
    const runtime = await createRuntime(dir, scriptPath);

    await expect(runtime.refreshCatalog(true)).rejects.toThrow(/Unsupported MCP protocol version/);
    await runtime.dispose();

    const starts = await readFile(startsPath, 'utf8');
    expect(starts.trim().split('\n')).toHaveLength(1);
  });

  it('sends the negotiated protocol version on streamable HTTP follow-up requests', async () => {
    const dir = await createTempDir();
    const observedProtocolHeaders: string[] = [];
    let initializeProtocolVersion = '';
    const sessionId = 'session-one';
    const server = await startHttpServer(async (req, res) => {
      if (req.method === 'GET') {
        observedProtocolHeaders.push(getHeaderValue(req.headers['mcp-protocol-version']));
        res.writeHead(405);
        res.end();
        return;
      }

      if (req.method !== 'POST') {
        res.writeHead(404);
        res.end();
        return;
      }

      const payload = asRecord(JSON.parse(await readRequestBody(req)));
      const method = typeof payload?.method === 'string' ? payload.method : '';

      if (method === 'initialize') {
        const params = asRecord(payload?.params);
        initializeProtocolVersion = typeof params?.protocolVersion === 'string'
          ? params.protocolVersion
          : '';
        writeJsonRpcResponse(
          res,
          payload?.id,
          {
            protocolVersion: '2025-11-25',
            capabilities: { tools: {}, resources: {}, prompts: {} },
            serverInfo: { name: 'http-test', version: '1.0.0' },
          },
          { 'MCP-Session-Id': sessionId },
        );
        return;
      }

      observedProtocolHeaders.push(getHeaderValue(req.headers['mcp-protocol-version']));
      if (getHeaderValue(req.headers['mcp-session-id']) !== sessionId) {
        res.writeHead(400);
        res.end();
        return;
      }
      if (observedProtocolHeaders.at(-1) !== '2025-11-25') {
        res.writeHead(400);
        res.end();
        return;
      }

      if (payload?.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }

      const key = method === 'tools/list'
        ? 'tools'
        : method === 'resources/list'
          ? 'resources'
          : 'prompts';
      writeJsonRpcResponse(res, payload.id, { [key]: [] });
    });

    const runtime = new McpServerRuntime(
      'http-test',
      {
        type: 'streamable-http',
        url: server.url,
        connect: 'lazy',
        startupTimeoutMs: 1_000,
        requestTimeoutMs: 1_000,
      },
      path.join(dir, 'cache'),
    );

    try {
      await runtime.refreshCatalog(true);
    } finally {
      await runtime.dispose();
      await server.stop();
    }

    expect(initializeProtocolVersion).toBe('2025-11-25');
    expect(observedProtocolHeaders.length).toBeGreaterThan(0);
    expect(observedProtocolHeaders.every((header) => header === '2025-11-25')).toBe(true);
  });

  it('uses the negotiated older protocol version in streamable HTTP follow-up headers', async () => {
    const dir = await createTempDir();
    const observedProtocolHeaders: string[] = [];
    let initializeCapabilities: JsonObject | undefined;
    const sessionId = 'session-legacy-version';
    const server = await startHttpServer(async (req, res) => {
      if (req.method === 'GET') {
        observedProtocolHeaders.push(getHeaderValue(req.headers['mcp-protocol-version']));
        res.writeHead(405);
        res.end();
        return;
      }

      if (req.method !== 'POST') {
        res.writeHead(404);
        res.end();
        return;
      }

      const payload = asRecord(JSON.parse(await readRequestBody(req)));
      const method = typeof payload?.method === 'string' ? payload.method : '';

      if (method === 'initialize') {
        const params = asRecord(payload?.params);
        initializeCapabilities = asRecord(params?.capabilities);
        writeJsonRpcResponse(
          res,
          payload?.id,
          {
            protocolVersion: '2025-06-18',
            capabilities: { tools: {}, resources: {}, prompts: {} },
            serverInfo: { name: 'http-legacy-version-test', version: '1.0.0' },
          },
          { 'MCP-Session-Id': sessionId },
        );
        return;
      }

      observedProtocolHeaders.push(getHeaderValue(req.headers['mcp-protocol-version']));
      if (getHeaderValue(req.headers['mcp-session-id']) !== sessionId) {
        res.writeHead(400);
        res.end();
        return;
      }
      if (observedProtocolHeaders.at(-1) !== '2025-06-18') {
        res.writeHead(400);
        res.end();
        return;
      }

      if (payload?.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }

      const key = method === 'tools/list'
        ? 'tools'
        : method === 'resources/list'
          ? 'resources'
          : 'prompts';
      writeJsonRpcResponse(res, payload.id, { [key]: [] });
    });

    const runtime = new McpServerRuntime(
      'http-legacy-version-test',
      {
        type: 'streamable-http',
        url: server.url,
        connect: 'lazy',
        startupTimeoutMs: 1_000,
        requestTimeoutMs: 1_000,
      },
      path.join(dir, 'cache'),
    );

    try {
      await runtime.refreshCatalog(true);
    } finally {
      await runtime.dispose();
      await server.stop();
    }

    expect(initializeCapabilities).toEqual({});
    expect(observedProtocolHeaders.length).toBeGreaterThan(0);
    expect(observedProtocolHeaders.every((header) => header === '2025-06-18')).toBe(true);
  });

  it('reinitializes streamable HTTP when a session expires during a request', async () => {
    const dir = await createTempDir();
    let initializeCount = 0;
    let activeSessionId = '';
    let expiredOnce = false;
    const server = await startHttpServer(async (req, res) => {
      if (req.method === 'GET') {
        res.writeHead(405);
        res.end();
        return;
      }

      if (req.method !== 'POST') {
        res.writeHead(404);
        res.end();
        return;
      }

      const payload = asRecord(JSON.parse(await readRequestBody(req)));
      const method = typeof payload?.method === 'string' ? payload.method : '';

      if (method === 'initialize') {
        initializeCount += 1;
        activeSessionId = `session-${initializeCount}`;
        writeJsonRpcResponse(
          res,
          payload?.id,
          {
            protocolVersion: '2025-11-25',
            capabilities: { tools: {}, resources: {}, prompts: {} },
            serverInfo: { name: 'http-expire-test', version: '1.0.0' },
          },
          { 'MCP-Session-Id': activeSessionId },
        );
        return;
      }

      if (
        getHeaderValue(req.headers['mcp-session-id']) !== activeSessionId
        || getHeaderValue(req.headers['mcp-protocol-version']) !== '2025-11-25'
      ) {
        res.writeHead(400);
        res.end();
        return;
      }

      if (method === 'tools/list' && !expiredOnce) {
        expiredOnce = true;
        res.writeHead(404);
        res.end();
        return;
      }

      if (payload?.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }

      const key = method === 'tools/list'
        ? 'tools'
        : method === 'resources/list'
          ? 'resources'
          : 'prompts';
      writeJsonRpcResponse(res, payload.id, { [key]: [] });
    });

    const runtime = new McpServerRuntime(
      'http-expire-test',
      {
        type: 'streamable-http',
        url: server.url,
        connect: 'lazy',
        startupTimeoutMs: 1_000,
        requestTimeoutMs: 1_000,
      },
      path.join(dir, 'cache'),
    );

    try {
      await runtime.refreshCatalog(true);
    } finally {
      await runtime.dispose();
      await server.stop();
    }

    expect(initializeCount).toBe(2);
    expect(expiredOnce).toBe(true);
  });

  it('answers server pings, surfaces sanitized icons + taskSupport, and cancels on timeout', async () => {
    const dir = await createTempDir();
    const pongPath = path.join(dir, 'pong.txt');
    const numberPongPath = path.join(dir, 'pong-number.txt');
    const cancelPath = path.join(dir, 'cancel.txt');
    const scriptPath = await writeScript(dir, createCapabilityServerSource({
      pongPath,
      numberPongPath,
      cancelPath,
    }));
    const runtime = await createRuntime(dir, scriptPath);

    try {
      const catalog = await runtime.getCatalog(true);

      const safe = catalog.descriptors.find((descriptor) => descriptor.name === 'safe_tool');
      // The javascript: icon is dropped; only the https one survives.
      expect(safe?.icons).toEqual([{ src: 'https://example.com/i.png' }]);
      expect(safe?.taskSupport).toBe('optional');
      expect(
        catalog.descriptors.find((descriptor) => descriptor.name === 'task_only')?.taskSupport,
      ).toBe('required');

      // The client must answer the server's ping with an empty result.
      await expect
        .poll(() => readFile(pongPath, 'utf8').catch(() => ''))
        .toBe('pong');
      await expect
        .poll(() => readFile(numberPongPath, 'utf8').catch(() => ''))
        .toBe('pong-number');

      // A task-required tool fails fast with a clear error (no tools/call sent).
      await expect(runtime.callTool('task_only', {})).rejects.toThrow(/only runs as a task/);

      // A normal call times out; the client emits notifications/cancelled.
      await expect(runtime.callTool('safe_tool', {})).rejects.toThrow(/timed out/);
      await expect
        .poll(() => readFile(cancelPath, 'utf8').catch(() => ''))
        .toMatch(/"requestId"/);
    } finally {
      await runtime.dispose();
    }
  });

  it('loads the catalog before direct calls so task-required tools fail fast', async () => {
    const dir = await createTempDir();
    const pongPath = path.join(dir, 'pong.txt');
    const cancelPath = path.join(dir, 'cancel.txt');
    const scriptPath = await writeScript(dir, createCapabilityServerSource({ pongPath, cancelPath }));
    const runtime = await createRuntime(dir, scriptPath, 1_000, 100);

    try {
      await expect(runtime.callTool('task_only', {})).rejects.toThrow(/only runs as a task/);
    } finally {
      await runtime.dispose();
    }
  });

  it('rejects unadvertised server-to-client capabilities with method-not-found', async () => {
    const dir = await createTempDir();
    const recordPath = path.join(dir, 'unsupported.jsonl');
    const scriptPath = await writeScript(dir, createUnsupportedRequestsServerSource(recordPath));
    const runtime = await createRuntime(dir, scriptPath);

    try {
      await runtime.refreshCatalog(true);
      await expect
        .poll(() => readFile(recordPath, 'utf8').catch(() => ''))
        .toContain('elicitation-1');
    } finally {
      await runtime.dispose();
    }

    const responses = (await readFile(recordPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => asRecord(JSON.parse(line)));
    expect(responses).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'roots-1', error: expect.objectContaining({ code: -32601 }) }),
      expect.objectContaining({ id: 'sampling-1', error: expect.objectContaining({ code: -32601 }) }),
      expect.objectContaining({ id: 'elicitation-1', error: expect.objectContaining({ code: -32601 }) }),
    ]));
  });

  it('FEATURE_222 Slice A: advertises roots + serves roots/list from injected workspace roots', async () => {
    const dir = await createTempDir();
    const recordPath = path.join(dir, 'roots.jsonl');
    const scriptPath = await writeScript(dir, createRootsServerSource(recordPath));
    const reverse: McpReverseCapabilities = {
      listRoots: () => [{ uri: 'file:///workspace/proj', name: 'proj' }],
    };
    const runtime = await createRuntime(dir, scriptPath, 1_000, 1_000, reverse);

    try {
      await runtime.refreshCatalog(true);
      await expect
        .poll(() => readFile(recordPath, 'utf8').catch(() => ''))
        .toContain('roots-1');
    } finally {
      await runtime.dispose();
    }

    const records = (await readFile(recordPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => asRecord(JSON.parse(line)));

    // initialize advertised the roots capability
    const initialize = records.find((r) => r?.method === 'initialize');
    const advertised = asRecord(asRecord(initialize?.params)?.capabilities);
    expect(advertised?.roots).toEqual({ listChanged: false });

    // roots/list was answered with the injected file:// root (not -32601)
    const rootsResponse = records.find((r) => r?.id === 'roots-1' && r?.method === undefined);
    expect(asRecord(rootsResponse?.result)?.roots).toEqual([
      { uri: 'file:///workspace/proj', name: 'proj' },
    ]);
  });

  it('FEATURE_222 Slice B: advertises form elicitation + routes elicitation/create to the injected elicit', async () => {
    const dir = await createTempDir();
    const recordPath = path.join(dir, 'elicit.jsonl');
    const scriptPath = await writeScript(dir, createElicitationServerSource(recordPath));
    const seen: unknown[] = [];
    const reverse: McpReverseCapabilities = {
      elicit: async (request) => {
        seen.push(request);
        return { action: 'accept', content: { username: 'alice' } };
      },
    };
    const runtime = await createRuntime(dir, scriptPath, 1_000, 1_000, reverse);

    try {
      await runtime.refreshCatalog(true);
      await expect
        .poll(() => readFile(recordPath, 'utf8').catch(() => ''))
        .toContain('elicit-1');
    } finally {
      await runtime.dispose();
    }

    const records = (await readFile(recordPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => asRecord(JSON.parse(line)));

    // advertised form elicitation (not url)
    const initialize = records.find((r) => r?.method === 'initialize');
    const advertised = asRecord(asRecord(initialize?.params)?.capabilities);
    expect(advertised?.elicitation).toEqual({ form: {} });

    // the request reached the host elicit callback as a parsed form request
    expect(seen).toEqual([{ mode: 'form', message: 'Your name?', requestedSchema: expect.objectContaining({ type: 'object' }) }]);

    // the client responded accept + content (not -32601)
    const response = records.find((r) => r?.id === 'elicit-1' && r?.method === undefined);
    expect(response?.result).toEqual({ action: 'accept', content: { username: 'alice' } });
  });

  it('FEATURE_222 Slice C: advertises url elicitation, routes url requests, and forwards completion', async () => {
    const dir = await createTempDir();
    const recordPath = path.join(dir, 'url-elicit.jsonl');
    const scriptPath = await writeScript(dir, createUrlElicitationServerSource(recordPath));
    const seen: unknown[] = [];
    const completed: string[] = [];
    const reverse: McpReverseCapabilities = {
      elicit: async (request) => {
        seen.push(request);
        // host showed the URL + got consent (anti-phishing UI is host-side)
        return { action: 'accept', content: {} };
      },
      elicitationModes: { form: true, url: true },
      onElicitationComplete: (id) => completed.push(id),
    };
    const runtime = await createRuntime(dir, scriptPath, 1_000, 1_000, reverse);

    try {
      await runtime.refreshCatalog(true);
      await expect.poll(() => completed.length > 0).toBe(true);
    } finally {
      await runtime.dispose();
    }

    const records = (await readFile(recordPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => asRecord(JSON.parse(line)));

    // advertised both form + url
    const initialize = records.find((r) => r?.method === 'initialize');
    const advertised = asRecord(asRecord(initialize?.params)?.capabilities);
    expect(advertised?.elicitation).toEqual({ form: {}, url: {} });

    // the url request reached the host elicit with mode + url + elicitationId
    expect(seen).toEqual([
      { mode: 'url', message: 'Authorize', url: 'https://auth.example.test/grant', elicitationId: 'flow-1' },
    ]);

    // the completion notification was forwarded to the host
    expect(completed).toEqual(['flow-1']);
  });
});
