import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setAgentConfigHome } from '../../runtime/agent-home.js';
import { McpServerRuntime } from './runtime.js';
import type { McpReverseCapabilities } from './reverse-capabilities.js';

const servers: http.Server[] = [];
const tempDirs: string[] = [];

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kodax-oauth-connect-'));
  tempDirs.push(dir);
  setAgentConfigHome(dir);
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => resolve(body));
  });
}

async function getFreePort(): Promise<number> {
  const probe = http.createServer();
  const port = await new Promise<number>((resolve) => {
    probe.listen(0, '127.0.0.1', () => resolve((probe.address() as { port: number }).port));
  });
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

interface FakeServer {
  origin: string;
  registrations: number;
  initializeUnauthorized: number;
}

/**
 * A combined fake that is BOTH an authenticated streamable-http MCP server and
 * its OAuth authorization server. Unauthenticated `initialize` → 401 with an
 * RFC 9728 pointer; once a Bearer token is presented, MCP works normally.
 */
async function startProtectedMcpServer(): Promise<FakeServer> {
  const state: FakeServer = { origin: '', registrations: 0, initializeUnauthorized: 0 };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', state.origin || 'http://localhost');
    const json = (body: Record<string, unknown>, headers: Record<string, string> = {}): void => {
      res.writeHead(200, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };

    // --- OAuth discovery + DCR + token ---
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource') {
      json({ authorization_servers: [state.origin], resource: state.origin, scopes_supported: ['mcp'] });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
      json({
        authorization_endpoint: `${state.origin}/authorize`,
        token_endpoint: `${state.origin}/token`,
        registration_endpoint: `${state.origin}/register`,
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/register') {
      state.registrations += 1;
      await readBody(req);
      json({ client_id: 'dcr-client' });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      await readBody(req);
      json({ access_token: 'tok-abc', token_type: 'Bearer', expires_in: 3600, scope: 'mcp' });
      return;
    }

    // --- MCP streamable-http endpoint (root) ---
    if (req.method === 'POST' && url.pathname === '/') {
      const message = JSON.parse(await readBody(req)) as { id?: unknown; method?: string };
      const authorized = (req.headers.authorization ?? '') === 'Bearer tok-abc';

      if (message.method === 'initialize') {
        if (!authorized) {
          state.initializeUnauthorized += 1;
          res.writeHead(401, {
            'WWW-Authenticate': `Bearer resource_metadata="${state.origin}/.well-known/oauth-protected-resource"`,
          });
          res.end();
          return;
        }
        json({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: '2025-11-25',
            capabilities: { tools: {} },
            serverInfo: { name: 'protected-mcp', version: '1.0.0' },
          },
        });
        return;
      }
      if (message.id === undefined) {
        // notification (e.g. notifications/initialized)
        res.writeHead(202);
        res.end();
        return;
      }
      const key = message.method === 'tools/list'
        ? { tools: [{ name: 'secure_tool', inputSchema: { type: 'object' } }] }
        : message.method === 'resources/list'
          ? { resources: [] }
          : { prompts: [] };
      json({ jsonrpc: '2.0', id: message.id, result: key });
      return;
    }

    res.writeHead(404);
    res.end();
  });
  servers.push(server);
  state.origin = await new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
  });
  return state;
}

describe('FEATURE_222 — MCP OAuth connect flow (401 → discovery login → retry)', () => {
  it('authenticates a protected streamable-http server via discovery + DCR', async () => {
    const srv = await startProtectedMcpServer();
    const port = await getFreePort();
    const consentUrls: string[] = [];

    const reverse: McpReverseCapabilities = {
      elicitationModes: { url: true },
      elicit: async (request) => {
        // The host consents to the authorization URL, then "the browser"
        // completes the flow against the loopback callback.
        consentUrls.push(request.url ?? '');
        const state = new URL(request.url ?? '').searchParams.get('state') ?? '';
        setTimeout(() => {
          void fetch(`http://127.0.0.1:${port}/callback?code=auth-code&state=${state}`).catch(() => {});
        }, 80);
        return { action: 'accept', content: {} };
      },
    };

    const runtime = new McpServerRuntime(
      'protected-srv',
      {
        type: 'streamable-http',
        url: srv.origin,
        connect: 'lazy',
        startupTimeoutMs: 2_000,
        requestTimeoutMs: 2_000,
        auth: { type: 'oauth2', redirectPort: port },
      },
      path.join(tempDirs[0], 'cache'),
      reverse,
    );

    try {
      await runtime.refreshCatalog(true);
      const catalog = await runtime.getCatalog();
      expect(catalog.descriptors.map((d) => d.name)).toContain('secure_tool');
    } finally {
      await runtime.dispose();
    }

    // The first initialize was rejected (401), discovery + DCR ran once, and the
    // host was asked to consent to an authorization URL on the AS.
    expect(srv.initializeUnauthorized).toBe(1);
    expect(srv.registrations).toBe(1);
    expect(consentUrls).toHaveLength(1);
    expect(consentUrls[0]).toContain('/authorize');
    expect(consentUrls[0]).toContain('code_challenge_method=S256');
  });

  it('authenticates a protected type:http server via auto-detect + OAuth', async () => {
    const srv = await startProtectedMcpServer();
    const port = await getFreePort();
    const consentUrls: string[] = [];

    const reverse: McpReverseCapabilities = {
      elicitationModes: { url: true },
      elicit: async (request) => {
        consentUrls.push(request.url ?? '');
        const state = new URL(request.url ?? '').searchParams.get('state') ?? '';
        setTimeout(() => {
          void fetch(`http://127.0.0.1:${port}/callback?code=auth-code&state=${state}`).catch(() => {});
        }, 80);
        return { action: 'accept', content: {} };
      },
    };

    const runtime = new McpServerRuntime(
      'protected-http-auto',
      {
        type: 'http',
        url: srv.origin,
        connect: 'lazy',
        startupTimeoutMs: 2_000,
        requestTimeoutMs: 2_000,
        auth: { type: 'oauth2', redirectPort: port },
      },
      path.join(tempDirs[0], 'cache'),
      reverse,
    );

    try {
      await runtime.refreshCatalog(true);
      const catalog = await runtime.getCatalog();
      expect(catalog.descriptors.map((d) => d.name)).toContain('secure_tool');
      expect(runtime.getDiagnostics().resolvedTransport).toBe('http:auto->streamable-http');
    } finally {
      await runtime.dispose();
    }

    expect(srv.initializeUnauthorized).toBe(1);
    expect(srv.registrations).toBe(1);
    expect(consentUrls).toHaveLength(1);
  });

  it('does not log in when the host has no url-consent surface (headless declines)', async () => {
    const srv = await startProtectedMcpServer();
    const runtime = new McpServerRuntime(
      'protected-headless',
      {
        type: 'streamable-http',
        url: srv.origin,
        connect: 'lazy',
        startupTimeoutMs: 2_000,
        requestTimeoutMs: 2_000,
        auth: { type: 'oauth2' },
      },
      path.join(tempDirs[0], 'cache'),
      // roots-only reverse: no elicit → no interactive login possible.
      { listRoots: () => [] },
    );

    try {
      await expect(runtime.refreshCatalog(true)).rejects.toThrow(/requires authorization/);
    } finally {
      await runtime.dispose();
    }
    expect(srv.registrations).toBe(0);
  });
});
