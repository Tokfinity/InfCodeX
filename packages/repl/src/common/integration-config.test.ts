import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  IntegrationConfigController,
  migrateLegacyIntegrationConfig,
  planLegacyIntegrationMigration,
  parseExtensionsIntegrationDocument,
  parseMcpIntegrationDocument,
  readExtensionsIntegration,
  readMcpIntegration,
  resolveIntegrationConfigPath,
  writeIntegrationDocument,
} from './integration-config.js';

let configHome: string;

beforeEach(() => {
  configHome = mkdtempSync(path.join(tmpdir(), 'kodax-integrations-'));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(configHome, { recursive: true, force: true });
});

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

describe('FEATURE_268 integration config substrate', () => {
  it('uses exactly one user file per integration domain', () => {
    expect(resolveIntegrationConfigPath('mcp', configHome)).toBe(
      path.join(configHome, 'integrations', 'mcp.json'),
    );
    expect(resolveIntegrationConfigPath('a2a', configHome)).toBe(
      path.join(configHome, 'integrations', 'a2a.json'),
    );
    expect(resolveIntegrationConfigPath('extensions', configHome)).toBe(
      path.join(configHome, 'integrations', 'extensions.json'),
    );
  });

  it('strictly validates versioned MCP and Extension documents', () => {
    expect(parseMcpIntegrationDocument({
      version: 1,
      servers: { local: { command: 'node', args: ['server.mjs'] } },
    }).servers.local?.command).toBe('node');
    expect(() => parseMcpIntegrationDocument({
      version: 1,
      servers: {},
      extra: true,
    })).toThrow(/unknown.*extra/i);
    expect(() => parseMcpIntegrationDocument({ version: 2, servers: {} }))
      .toThrow(/version/i);

    expect(parseExtensionsIntegrationDocument({
      version: 1,
      paths: ['~/.kodax/extensions/reporting'],
    }).paths).toEqual(['~/.kodax/extensions/reporting']);
    expect(() => parseExtensionsIntegrationDocument({
      version: 1,
      paths: ['ok', ''],
    })).toThrow(/paths/i);
  });

  it('reads legacy core declarations only while the domain file is absent', () => {
    writeJson(path.join(configHome, 'config.json'), {
      provider: 'anthropic',
      mcpServers: { legacy: { command: 'legacy-server' } },
      extensions: ['legacy-extension.mjs'],
    });

    expect(readMcpIntegration(configHome)).toMatchObject({
      source: 'legacy-user',
      document: { version: 1, servers: { legacy: { command: 'legacy-server' } } },
    });
    expect(readExtensionsIntegration(configHome)).toMatchObject({
      source: 'legacy-user',
      document: { version: 1, paths: ['legacy-extension.mjs'] },
    });

    writeIntegrationDocument({
      domain: 'mcp',
      configHome,
      document: { version: 1, servers: { current: { command: 'current-server' } } },
      validate: parseMcpIntegrationDocument,
    });
    expect(readMcpIntegration(configHome)).toMatchObject({
      source: 'user',
      document: { version: 1, servers: { current: { command: 'current-server' } } },
    });
  });

  it('atomically writes one domain without rewriting core config or sibling domains', () => {
    const core = path.join(configHome, 'config.json');
    const extensions = resolveIntegrationConfigPath('extensions', configHome);
    writeJson(core, { provider: 'deepseek' });
    writeJson(extensions, { version: 1, paths: ['keep.mjs'] });
    const coreBefore = readFileSync(core, 'utf8');
    const extensionsBefore = readFileSync(extensions, 'utf8');

    const written = writeIntegrationDocument({
      domain: 'mcp',
      configHome,
      document: { version: 1, servers: { local: { command: 'node' } } },
      validate: parseMcpIntegrationDocument,
    });

    expect(written.source).toBe('user');
    expect(existsSync(resolveIntegrationConfigPath('mcp', configHome))).toBe(true);
    expect(readFileSync(core, 'utf8')).toBe(coreBefore);
    expect(readFileSync(extensions, 'utf8')).toBe(extensionsBefore);
  });

  it('rejects stale expected revisions instead of silently overwriting', () => {
    const first = writeIntegrationDocument({
      domain: 'mcp',
      configHome,
      document: { version: 1, servers: {} },
      validate: parseMcpIntegrationDocument,
    });
    writeIntegrationDocument({
      domain: 'mcp',
      configHome,
      expectedRevision: first.revision,
      document: { version: 1, servers: { newer: { command: 'newer' } } },
      validate: parseMcpIntegrationDocument,
    });

    expect(() => writeIntegrationDocument({
      domain: 'mcp',
      configHome,
      expectedRevision: first.revision,
      document: { version: 1, servers: { stale: { command: 'stale' } } },
      validate: parseMcpIntegrationDocument,
    })).toThrow(/revision.*changed/i);
  });

  it('keeps last-known-good state after an invalid reload and recovers later', async () => {
    const file = resolveIntegrationConfigPath('extensions', configHome);
    writeJson(file, { version: 1, paths: ['one.mjs'] });
    const controller = new IntegrationConfigController({
      domain: 'extensions',
      configHome,
      validate: parseExtensionsIntegrationDocument,
      read: () => readExtensionsIntegration(configHome),
    });

    await controller.initialize();
    expect(controller.snapshot()?.document.paths).toEqual(['one.mjs']);

    writeFileSync(file, '{ broken', 'utf8');
    const rejected = await controller.reload();
    expect(rejected.ok).toBe(false);
    expect(controller.snapshot()?.document.paths).toEqual(['one.mjs']);
    expect(controller.status().diagnostic?.message).not.toContain('{ broken');

    writeJson(file, { version: 1, paths: ['two.mjs'] });
    await expect(controller.ensureCurrent()).resolves.toMatchObject({ ok: true });
    expect(controller.snapshot()?.document.paths).toEqual(['two.mjs']);
    controller.close();
  });

  it('recovers a missed watch event through the metadata fallback', async () => {
    const controller = new IntegrationConfigController({
      domain: 'extensions',
      configHome,
      validate: parseExtensionsIntegrationDocument,
      read: () => readExtensionsIntegration(configHome),
    });
    await controller.initialize();
    controller.startWatching(10_000, 20);
    try {
      writeIntegrationDocument({
        domain: 'extensions',
        configHome,
        document: { version: 1, paths: ['fallback.mjs'] },
        validate: parseExtensionsIntegrationDocument,
      });
      await vi.waitFor(() => {
        expect(controller.snapshot()?.document.paths).toEqual(['fallback.mjs']);
      }, { timeout: 2_000 });
    } finally {
      controller.close();
    }
  });

  it('commits a watched candidate only after runtime subscribers accept it', async () => {
    const file = resolveIntegrationConfigPath('extensions', configHome);
    writeJson(file, { version: 1, paths: ['one.mjs'] });
    const controller = new IntegrationConfigController({
      domain: 'extensions', configHome,
      validate: parseExtensionsIntegrationDocument,
      read: () => readExtensionsIntegration(configHome),
    });
    await controller.initialize();
    const apply = vi.fn(async (snapshot: ReturnType<typeof readExtensionsIntegration>) => {
      if (snapshot.document.paths.includes('broken.mjs')) {
        throw new Error('candidate activation failed token=SECRET123 C:\\private\\extension.mjs');
      }
    });
    controller.subscribe(apply);

    writeJson(file, { version: 1, paths: ['broken.mjs'] });
    await expect(controller.reload()).resolves.toMatchObject({ ok: false });
    expect(controller.snapshot()?.document.paths).toEqual(['one.mjs']);
    expect(controller.status().diagnostic).toMatchObject({ code: 'activation-failed' });
    expect(controller.status().diagnostic?.message).not.toContain('SECRET123');
    expect(controller.status().diagnostic?.message).not.toContain('C:\\private');

    writeJson(file, { version: 1, paths: ['two.mjs'] });
    await expect(controller.reload()).resolves.toMatchObject({ ok: true });
    expect(controller.snapshot()?.document.paths).toEqual(['two.mjs']);
    expect(apply).toHaveBeenCalledTimes(2);
    controller.close();
  });

  it('previews and applies legacy migration without overwriting domain files', () => {
    const core = path.join(configHome, 'config.json');
    writeJson(core, {
      provider: 'deepseek',
      mcpServers: { legacy: { command: 'legacy-server' } },
      extensions: ['legacy-extension.mjs'],
    });

    expect(planLegacyIntegrationMigration(configHome)).toMatchObject({
      mcp: { action: 'create', entries: 1 },
      extensions: { action: 'create', entries: 1 },
    });
    const applied = migrateLegacyIntegrationConfig({
      configHome,
      cleanupLegacy: true,
    });
    expect(applied.applied).toEqual(['mcp', 'extensions']);
    expect(readMcpIntegration(configHome).source).toBe('user');
    expect(readExtensionsIntegration(configHome).source).toBe('user');
    expect(JSON.parse(readFileSync(core, 'utf8'))).toEqual({ provider: 'deepseek' });

    writeJson(resolveIntegrationConfigPath('mcp', configHome), {
      version: 1,
      servers: { current: { command: 'current-server' } },
    });
    expect(planLegacyIntegrationMigration(configHome).mcp.action).toBe('none');
  });
});
