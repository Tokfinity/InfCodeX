/**
 * v0.7.42 — MCP server CRUD tests. Mirrors `custom-providers.test.ts`:
 * each test uses a per-case `KODAX_HOME` override pointing at a fresh
 * temp dir so the real `~/.kodax/config.json` is never touched.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setAgentConfigHome } from '@kodax-ai/coding';

import {
  getMcpServerConfig,
  listMcpServers,
  removeMcpServer,
  upsertMcpServer,
  validateMcpServerConfig,
} from './mcp-servers.js';

let tmpHome: string;
let configPath: string;

beforeEach(() => {
  setAgentConfigHome(undefined);
  tmpHome = mkdtempSync(join(tmpdir(), 'kodax-mcp-crud-test-'));
  setAgentConfigHome(tmpHome);
  mkdirSync(tmpHome, { recursive: true });
  configPath = join(tmpHome, 'config.json');
});

afterEach(() => {
  setAgentConfigHome(undefined);
  rmSync(tmpHome, { recursive: true, force: true });
});

function writeConfig(content: unknown): void {
  writeFileSync(configPath, JSON.stringify(content, null, 2), 'utf-8');
}

function readConfig(): { mcpServers?: Record<string, unknown> } {
  if (!existsSync(configPath)) return {};
  return JSON.parse(readFileSync(configPath, 'utf-8')) as {
    mcpServers?: Record<string, unknown>;
  };
}

// Minimal valid stdio MCP server.
function makeStdioServer(command: string = 'echo'): import('@kodax-ai/coding').KodaXMcpServerConfig {
  return { command, args: ['hello'] };
}

function makeSseServer(url: string = 'https://example.local/sse'): import('@kodax-ai/coding').KodaXMcpServerConfig {
  return { type: 'sse', url };
}

describe('listMcpServers', () => {
  it('returns empty object when no config exists', () => {
    expect(listMcpServers()).toEqual({});
  });

  it('returns empty object when config has no mcpServers field', () => {
    writeConfig({ provider: 'anthropic' });
    expect(listMcpServers()).toEqual({});
  });

  it('returns all configured servers', () => {
    writeConfig({
      mcpServers: {
        foo: makeStdioServer('foo-cmd'),
        bar: makeSseServer('https://bar.local'),
      },
    });
    const list = listMcpServers();
    expect(Object.keys(list).sort()).toEqual(['bar', 'foo']);
    expect(list.foo?.command).toBe('foo-cmd');
    expect(list.bar?.url).toBe('https://bar.local');
  });

  it('returns deep clones — mutating result does NOT affect on-disk config', () => {
    writeConfig({ mcpServers: { foo: makeStdioServer() } });
    const list = listMcpServers();
    delete list.foo;
    expect(listMcpServers().foo).toBeDefined();
  });
});

describe('getMcpServerConfig', () => {
  it('returns undefined when nothing is configured', () => {
    expect(getMcpServerConfig('foo')).toBeUndefined();
  });

  it('returns undefined for unknown name', () => {
    writeConfig({ mcpServers: { foo: makeStdioServer() } });
    expect(getMcpServerConfig('bar')).toBeUndefined();
  });

  it('returns a deep-cloned match by name', () => {
    writeConfig({ mcpServers: { foo: makeStdioServer('foo-cmd') } });
    const config = getMcpServerConfig('foo');
    expect(config?.command).toBe('foo-cmd');
  });

  it('returns undefined for empty / non-string input (defensive)', () => {
    writeConfig({ mcpServers: { foo: makeStdioServer() } });
    expect(getMcpServerConfig('')).toBeUndefined();
    // @ts-expect-error — runtime validation test
    expect(getMcpServerConfig(undefined)).toBeUndefined();
  });
});

describe('upsertMcpServer — insert', () => {
  it('creates config.json + mcpServers when none exists', () => {
    expect(existsSync(configPath)).toBe(false);
    upsertMcpServer('foo', makeStdioServer('foo-cmd'));

    expect(existsSync(configPath)).toBe(true);
    expect(readConfig().mcpServers).toHaveProperty('foo');
  });

  it('appends a new entry to existing mcpServers', () => {
    writeConfig({ mcpServers: { foo: makeStdioServer() } });
    upsertMcpServer('bar', makeSseServer());

    const servers = readConfig().mcpServers ?? {};
    expect(Object.keys(servers).sort()).toEqual(['bar', 'foo']);
  });

  it('preserves other top-level config fields on insert', () => {
    writeConfig({ provider: 'anthropic', model: 'claude', mcpServers: {} });
    upsertMcpServer('foo', makeStdioServer());

    const persisted = readConfig() as { provider?: string; model?: string };
    expect(persisted.provider).toBe('anthropic');
    expect(persisted.model).toBe('claude');
  });
});

describe('upsertMcpServer — replace (same name)', () => {
  it('replaces in-place when name already exists', () => {
    writeConfig({
      mcpServers: {
        foo: makeStdioServer('old-cmd'),
        bar: makeStdioServer(),
      },
    });
    upsertMcpServer('foo', makeStdioServer('new-cmd'));

    const persisted = readConfig().mcpServers as Record<string, { command?: string }>;
    expect(persisted.foo?.command).toBe('new-cmd');
    expect(persisted.bar).toBeDefined();
  });
});

describe('upsertMcpServer — validation', () => {
  it('rejects empty name — file untouched', () => {
    writeConfig({ mcpServers: { foo: makeStdioServer() } });

    expect(() => upsertMcpServer('', makeStdioServer())).toThrow();
    expect(Object.keys(readConfig().mcpServers ?? {})).toEqual(['foo']);
  });

  it('rejects stdio entry missing command', () => {
    writeConfig({ mcpServers: { foo: makeStdioServer() } });

    // @ts-expect-error — validation test
    expect(() => upsertMcpServer('bar', { type: 'stdio' })).toThrow(/command/);
    expect(Object.keys(readConfig().mcpServers ?? {})).toEqual(['foo']);
  });

  it('rejects sse entry missing url', () => {
    // @ts-expect-error — validation test
    expect(() => upsertMcpServer('bar', { type: 'sse' })).toThrow(/url/);
  });

  it('rejects unknown transport type', () => {
    expect(() =>
      // @ts-expect-error — validation test
      upsertMcpServer('bar', { type: 'websocket', url: 'wss://x' }),
    ).toThrow(/transport/);
  });

  it('rejects unknown connect mode', () => {
    expect(() =>
      upsertMcpServer('bar', {
        ...makeStdioServer(),
        // @ts-expect-error — validation test
        connect: 'eager',
      }),
    ).toThrow(/connect/);
  });

  it('accepts valid stdio + sse + streamable-http transports', () => {
    expect(() => upsertMcpServer('a', makeStdioServer())).not.toThrow();
    expect(() => upsertMcpServer('b', makeSseServer())).not.toThrow();
    expect(() => upsertMcpServer('c', { type: 'streamable-http', url: 'https://x.local' })).not.toThrow();
  });
});

describe('removeMcpServer', () => {
  it('removes a configured server by name and returns true', () => {
    writeConfig({
      mcpServers: { foo: makeStdioServer(), bar: makeSseServer() },
    });

    expect(removeMcpServer('foo')).toBe(true);
    const remaining = readConfig().mcpServers ?? {};
    expect(Object.keys(remaining)).toEqual(['bar']);
  });

  it('returns false (no-op, file unchanged) for unknown name', () => {
    writeConfig({ mcpServers: { foo: makeStdioServer() } });
    const before = readFileSync(configPath, 'utf-8');

    expect(removeMcpServer('not-there')).toBe(false);
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
  });

  it('returns false for empty / non-string input', () => {
    writeConfig({ mcpServers: { foo: makeStdioServer() } });
    expect(removeMcpServer('')).toBe(false);
    // @ts-expect-error — runtime validation test
    expect(removeMcpServer(undefined)).toBe(false);
  });

  it('returns false when no mcpServers section exists', () => {
    expect(removeMcpServer('foo')).toBe(false);
  });

  it('preserves other top-level config fields on remove', () => {
    writeConfig({
      provider: 'anthropic',
      mcpServers: { foo: makeStdioServer() },
    });
    expect(removeMcpServer('foo')).toBe(true);

    const persisted = readConfig() as { provider?: string; mcpServers?: Record<string, unknown> };
    expect(persisted.provider).toBe('anthropic');
    expect(persisted.mcpServers).toEqual({});
  });
});

describe('validateMcpServerConfig — standalone', () => {
  it('accepts a minimal stdio config', () => {
    expect(() => validateMcpServerConfig('foo', makeStdioServer())).not.toThrow();
  });

  it('rejects non-object config', () => {
    // @ts-expect-error — runtime validation test
    expect(() => validateMcpServerConfig('foo', null)).toThrow();
    // @ts-expect-error — runtime validation test
    expect(() => validateMcpServerConfig('foo', 'string')).toThrow();
    // @ts-expect-error — runtime validation test
    expect(() => validateMcpServerConfig('foo', [])).toThrow();
  });
});

describe('round-trip — upsert + remove leaves config empty', () => {
  it('add → remove returns to no-mcpServers state', () => {
    upsertMcpServer('foo', makeStdioServer());
    expect(Object.keys(listMcpServers())).toEqual(['foo']);

    expect(removeMcpServer('foo')).toBe(true);
    expect(listMcpServers()).toEqual({});
  });
});
