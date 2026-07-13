import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

let configHome = '';
let previousKodaXHome: string | undefined;
let coding: typeof import('@kodax-ai/coding');
let repl: typeof import('@kodax-ai/repl');
let startIntegrationHotReload: typeof import('./integration-hot-reload.js').startIntegrationHotReload;

beforeAll(async () => {
  previousKodaXHome = process.env.KODAX_HOME;
  configHome = path.join(mkdtempSync(path.join(os.tmpdir(), 'kodax-hot-reload-')), '.kodax');
  process.env.KODAX_HOME = configHome;
  vi.resetModules();
  const [codingModule, replModule, hotReloadModule] = await Promise.all([
    import('@kodax-ai/coding'),
    import('@kodax-ai/repl'),
    import('./integration-hot-reload.js'),
  ]);
  coding = codingModule;
  repl = replModule;
  startIntegrationHotReload = hotReloadModule.startIntegrationHotReload;
});

afterAll(() => {
  if (previousKodaXHome === undefined) delete process.env.KODAX_HOME;
  else process.env.KODAX_HOME = previousKodaXHome;
  rmSync(path.dirname(configHome), { recursive: true, force: true });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for integration hot reload.');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('integration hot reload', () => {
  it('updates live MCP and Extension surfaces while retaining the last valid snapshot', async () => {
    const runtime = coding.createExtensionRuntime().activate();
    const events: string[] = [];
    const hotReload = await startIntegrationHotReload({ runtime, onEvent: (message) => events.push(message) });
    try {
      repl.writeIntegrationDocument({
        domain: 'mcp', configHome,
        document: {
          version: 1,
          servers: { local: { type: 'stdio', command: 'node', args: ['server.mjs'], connect: 'lazy' } },
        },
        validate: repl.parseMcpIntegrationDocument,
      });
      await waitUntil(() => runtime.hasCapabilityProvider('mcp'));
      expect(events).toContainEqual(expect.stringContaining('MCP configuration hot-reloaded'));

      const extensionPath = path.join(path.dirname(configHome), 'hot-extension.mjs');
      writeFileSync(extensionPath, `export default function(api) {
        api.registerTool({
          name: 'hot_reload_echo',
          description: 'Hot reload test',
          input_schema: { type: 'object', properties: {} },
          handler: async () => 'ok'
        });
      }`, 'utf8');
      repl.writeIntegrationDocument({
        domain: 'extensions', configHome,
        document: { version: 1, paths: [extensionPath] },
        validate: repl.parseExtensionsIntegrationDocument,
      });
      await waitUntil(() => runtime.getDiagnostics().loadedExtensions.length === 1);
      expect(events).toContainEqual(expect.stringContaining('Extension configuration hot-reloaded'));

      writeFileSync(
        repl.resolveIntegrationConfigPath('extensions', configHome),
        JSON.stringify({ version: 1, paths: [42] }),
        'utf8',
      );
      await waitUntil(() => hotReload.statuses().some((status) => (
        status.domain === 'extensions' && status.diagnostic?.code === 'invalid-config'
      )));
      expect(runtime.getDiagnostics().loadedExtensions).toHaveLength(1);
    } finally {
      hotReload.close();
      await runtime.dispose();
    }
  });
});
