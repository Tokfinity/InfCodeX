/**
 * v0.7.42 — McpManager tests. Uses the real MCP test fixture (a Node-
 * scripted MCP server speaking stdio JSON-RPC over Content-Length
 * framing) so the manager exercises actual transport + catalog +
 * lifecycle paths — no mocking of @kodax-ai/mcp internals.
 *
 * Each test gets a per-case temp dir so cache state never leaks between
 * cases. dispose() is awaited in afterEach so the spawned MCP server
 * subprocess doesn't outlive the test.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createMcpTestServerFixture, type McpTestServerFixture } from './test-helpers.js';
import { McpManager, createMcpManager } from './manager.js';

let tmpDir: string;
let fixture: McpTestServerFixture;
let manager: McpManager | undefined;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kodax-mcp-manager-test-'));
  fixture = await createMcpTestServerFixture(tmpDir);
});

afterEach(async () => {
  await manager?.dispose();
  manager = undefined;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('McpManager — listServers', () => {
  it('returns one status row per configured server', async () => {
    manager = new McpManager(fixture.servers, { cacheDir: fixture.cacheDir });
    const rows = manager.listServers();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.serverId).toBe(fixture.serverId);
    expect(rows[0]?.connect).toBe('prewarm');
    expect(rows[0]?.tools).toBeGreaterThanOrEqual(0);
  });

  it('returns empty array when no servers are configured', () => {
    manager = new McpManager(undefined, { cacheDir: fixture.cacheDir });
    expect(manager.listServers()).toEqual([]);
  });

  it('excludes disabled servers from the live registry', () => {
    manager = new McpManager(
      { ...fixture.servers, disabled: { type: 'stdio', command: 'noop', connect: 'disabled' } },
      { cacheDir: fixture.cacheDir },
    );
    const ids = manager.listServers().map((s) => s.serverId);
    expect(ids).toContain(fixture.serverId);
    expect(ids).not.toContain('disabled');
  });

  it('status row carries deep-cloned server config (mutation safe)', () => {
    manager = new McpManager(fixture.servers, { cacheDir: fixture.cacheDir });
    const row = manager.listServers()[0]!;
    expect(row.config.command).toBe(process.execPath);
    // Mutate the returned row — original config must stay intact.
    (row.config as { command?: string }).command = 'tampered';
    const next = manager.listServers()[0]!;
    expect(next.config.command).toBe(process.execPath);
  });
});

describe('McpManager — startServer + listTools (real MCP roundtrip)', () => {
  it('startServer forces a fresh catalog + reports ready status', async () => {
    manager = new McpManager(fixture.servers, { cacheDir: fixture.cacheDir });
    const post = await manager.startServer(fixture.serverId);
    expect(['ready', 'idle']).toContain(post.status);
    expect(post.tools).toBeGreaterThanOrEqual(1);
    expect(post.cachedAt).toBeDefined();
  });

  it('listTools returns tool descriptors (filters resources + prompts)', async () => {
    manager = new McpManager(fixture.servers, { cacheDir: fixture.cacheDir });
    await manager.startServer(fixture.serverId);
    const tools = await manager.listTools(fixture.serverId);
    expect(tools.serverId).toBe(fixture.serverId);
    expect(tools.tools.length).toBeGreaterThanOrEqual(1);
    // Every returned descriptor must be a tool — no resources/prompts.
    for (const tool of tools.tools) {
      expect(tool.kind).toBe('tool');
    }
    expect(tools.cachedAt).toBeDefined();
  });

  it('listTools triggers lazy connect when called without prior startServer', async () => {
    // Override the fixture's prewarm to lazy so we can observe a cold
    // connect happening inside listTools.
    const lazyServers = {
      [fixture.serverId]: { ...fixture.servers[fixture.serverId]!, connect: 'lazy' as const },
    };
    manager = new McpManager(lazyServers, { cacheDir: fixture.cacheDir });
    const tools = await manager.listTools(fixture.serverId);
    expect(tools.tools.length).toBeGreaterThanOrEqual(1);
  });

  it('listTools({forceRefresh:true}) bypasses cache + reconnects', async () => {
    manager = new McpManager(fixture.servers, { cacheDir: fixture.cacheDir });
    await manager.startServer(fixture.serverId);
    const first = await manager.listTools(fixture.serverId);
    const second = await manager.listTools(fixture.serverId, { forceRefresh: true });
    expect(second.tools.length).toBe(first.tools.length);
  });
});

describe('McpManager — getCatalog (full catalog)', () => {
  it('returns tools + resources + prompts in a single snapshot', async () => {
    manager = new McpManager(fixture.servers, { cacheDir: fixture.cacheDir });
    await manager.startServer(fixture.serverId);
    const catalog = await manager.getCatalog(fixture.serverId);

    expect(catalog.serverId).toBe(fixture.serverId);
    expect(catalog.descriptors.length).toBeGreaterThanOrEqual(3); // 1 tool + 1 resource + 1 prompt minimum

    const kinds = new Set(catalog.descriptors.map((d) => d.kind));
    expect(kinds.has('tool')).toBe(true);
    expect(kinds.has('resource')).toBe(true);
    expect(kinds.has('prompt')).toBe(true);

    // items + descriptors must have the same length (1:1 mapping).
    expect(catalog.items.length).toBe(catalog.descriptors.length);
    expect(catalog.updatedAt).toBeDefined();
  });

  it('forceRefresh:true bypasses the on-disk cache', async () => {
    manager = new McpManager(fixture.servers, { cacheDir: fixture.cacheDir });
    await manager.startServer(fixture.serverId);
    const cold = await manager.getCatalog(fixture.serverId);
    const refreshed = await manager.getCatalog(fixture.serverId, { forceRefresh: true });
    expect(refreshed.descriptors.length).toBe(cold.descriptors.length);
  });

  it('throws for unknown serverId', async () => {
    manager = new McpManager(fixture.servers, { cacheDir: fixture.cacheDir });
    await expect(manager.getCatalog('does-not-exist')).rejects.toThrow(/Unknown MCP server/);
  });

  it('triggers lazy connect when called without prior startServer', async () => {
    const lazyServers = {
      [fixture.serverId]: { ...fixture.servers[fixture.serverId]!, connect: 'lazy' as const },
    };
    manager = new McpManager(lazyServers, { cacheDir: fixture.cacheDir });
    const catalog = await manager.getCatalog(fixture.serverId);
    expect(catalog.descriptors.length).toBeGreaterThan(0);
  });
});

describe('McpManager — stopServer', () => {
  it('disposes the transport but keeps the server in the config', async () => {
    manager = new McpManager(fixture.servers, { cacheDir: fixture.cacheDir });
    await manager.startServer(fixture.serverId);
    const stopped = await manager.stopServer(fixture.serverId);
    expect(stopped.serverId).toBe(fixture.serverId);
    // After stop, the server is still listed (so the popout UI can keep
    // showing its row with a "stopped" indicator).
    const rows = manager.listServers();
    expect(rows.map((r) => r.serverId)).toContain(fixture.serverId);
  });

  it('stop -> start cycle reconnects cleanly', async () => {
    manager = new McpManager(fixture.servers, { cacheDir: fixture.cacheDir });
    await manager.startServer(fixture.serverId);
    await manager.stopServer(fixture.serverId);
    const restarted = await manager.startServer(fixture.serverId);
    expect(restarted.status).toBe('ready');
    expect(restarted.tools).toBeGreaterThanOrEqual(1);
  });
});

describe('McpManager — getServerLogs', () => {
  it('returns status + last-error fields', async () => {
    manager = new McpManager(fixture.servers, { cacheDir: fixture.cacheDir });
    const logs = manager.getServerLogs(fixture.serverId);
    expect(logs.serverId).toBe(fixture.serverId);
    expect(logs.connect).toBe('prewarm');
    expect(['idle', 'ready', 'connecting']).toContain(logs.status);
  });

  it('captures lastError after a failed connect', async () => {
    manager = new McpManager(
      {
        broken: {
          type: 'stdio',
          command: 'definitely-not-a-real-binary-xyz',
          connect: 'lazy',
          startupTimeoutMs: 500,
        },
      },
      { cacheDir: fixture.cacheDir },
    );
    // Trigger a real connect attempt that will fail; suppress the throw
    // since we only care about the diagnostic capture.
    try {
      await manager.startServer('broken');
    } catch {
      /* expected */
    }
    const logs = manager.getServerLogs('broken');
    expect(logs.status).toBe('error');
    expect(logs.lastError).toBeDefined();
  });
});

describe('McpManager — error paths', () => {
  it('startServer throws for unknown serverId', async () => {
    manager = new McpManager(fixture.servers, { cacheDir: fixture.cacheDir });
    await expect(manager.startServer('does-not-exist')).rejects.toThrow(/Unknown MCP server/);
  });

  it('stopServer throws for unknown serverId', async () => {
    manager = new McpManager(fixture.servers, { cacheDir: fixture.cacheDir });
    await expect(manager.stopServer('does-not-exist')).rejects.toThrow(/Unknown MCP server/);
  });

  it('getServerLogs throws for unknown serverId', () => {
    manager = new McpManager(fixture.servers, { cacheDir: fixture.cacheDir });
    expect(() => manager!.getServerLogs('does-not-exist')).toThrow(/Unknown MCP server/);
  });

  it('listTools throws for unknown serverId', async () => {
    manager = new McpManager(fixture.servers, { cacheDir: fixture.cacheDir });
    await expect(manager.listTools('does-not-exist')).rejects.toThrow(/Unknown MCP server/);
  });
});

describe('McpManager — escape hatches', () => {
  it('provider() returns the underlying McpCapabilityProvider', () => {
    manager = new McpManager(fixture.servers, { cacheDir: fixture.cacheDir });
    const provider = manager.provider();
    expect(provider).toBeDefined();
    expect(provider.id).toBe('mcp');
    expect(provider.hasActiveServers()).toBe(true);
  });

  it('execute() forwards to capability provider', async () => {
    manager = new McpManager(fixture.servers, { cacheDir: fixture.cacheDir });
    await manager.startServer(fixture.serverId);
    const result = await manager.execute(fixture.toolId, { text: 'hello' });
    expect(result.kind).toBe('tool');
  });

  it('describe() returns the tool descriptor by capability id', async () => {
    manager = new McpManager(fixture.servers, { cacheDir: fixture.cacheDir });
    await manager.startServer(fixture.serverId);
    const desc = await manager.describe(fixture.toolId);
    expect(desc?.id).toBe(fixture.toolId);
    expect(desc?.kind).toBe('tool');
  });
});

describe('createMcpManager factory', () => {
  it('returns a fresh McpManager instance', () => {
    manager = createMcpManager(fixture.servers, { cacheDir: fixture.cacheDir });
    expect(manager).toBeInstanceOf(McpManager);
    expect(manager.listServers().length).toBe(1);
  });
});
