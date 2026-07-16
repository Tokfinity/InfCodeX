import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Command } from 'commander';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeCapture = vi.hoisted((): {
  options?: { readonly defaultProvider?: string; readonly defaultModel?: string };
} => ({}));

vi.mock('./sdk-runtime.js', async () => {
  const actual = await vi.importActual<typeof import('./sdk-runtime.js')>('./sdk-runtime.js');
  return {
    ...actual,
    createKodaXRuntime: vi.fn(async (
      options: Parameters<typeof actual.createKodaXRuntime>[0],
    ) => {
      if (!options) throw new Error('A2A Runtime options are required');
      runtimeCapture.options = {
        ...(options.defaultProvider !== undefined
          ? { defaultProvider: options.defaultProvider }
          : {}),
        ...(options.defaultModel !== undefined ? { defaultModel: options.defaultModel } : {}),
      };
      throw new Error('captured A2A Runtime options');
    }),
  };
});

let rootDir = '';
let configHome = '';
let previousKodaXHome: string | undefined;
let previousProvider: string | undefined;
let configureKodaXRootCommand: typeof import('./kodax_cli.js').configureKodaXRootCommand;
let configureIntegrationCommands: typeof import('./integration-cli.js').configureIntegrationCommands;

beforeAll(async () => {
  previousKodaXHome = process.env.KODAX_HOME;
  previousProvider = process.env.KODAX_PROVIDER;
  delete process.env.KODAX_PROVIDER;
  rootDir = mkdtempSync(path.join(os.tmpdir(), 'kodax-a2a-serve-cli-'));
  configHome = path.join(rootDir, '.kodax');
  process.env.KODAX_HOME = configHome;
  vi.resetModules();
  ({ configureKodaXRootCommand } = await import('./kodax_cli.js'));
  ({ configureIntegrationCommands } = await import('./integration-cli.js'));
});

afterAll(() => {
  if (previousKodaXHome === undefined) delete process.env.KODAX_HOME;
  else process.env.KODAX_HOME = previousKodaXHome;
  if (previousProvider === undefined) delete process.env.KODAX_PROVIDER;
  else process.env.KODAX_PROVIDER = previousProvider;
  rmSync(rootDir, { recursive: true, force: true });
});

beforeEach(async () => {
  runtimeCapture.options = undefined;
  delete process.env.KODAX_PROVIDER;
  rmSync(configHome, { recursive: true, force: true });
  mkdirSync(configHome, { recursive: true });

  const program = new Command().name('kodax').exitOverride();
  configureIntegrationCommands(program, { version: '0.7.70' });
  const writer = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    await program.parseAsync(['node', 'kodax', 'a2a', 'expose']);
  } finally {
    writer.mockRestore();
  }
});

function writeCoreConfig(config: { readonly provider?: string; readonly model?: string }): void {
  writeFileSync(path.join(configHome, 'config.json'), JSON.stringify(config), 'utf8');
}

async function captureServeOptions(args: readonly string[]): Promise<{
  readonly defaultProvider?: string;
  readonly defaultModel?: string;
}> {
  const program = configureKodaXRootCommand(new Command().name('kodax').exitOverride());
  configureIntegrationCommands(program, { version: '0.7.70' });
  await expect(program.parseAsync(['node', 'kodax', ...args]))
    .rejects.toThrow('captured A2A Runtime options');
  if (!runtimeCapture.options) throw new Error('A2A Runtime options were not captured.');
  return runtimeCapture.options;
}

describe('A2A serve Runtime selection', () => {
  it('uses provider and model options placed after the serve subcommand', async () => {
    await expect(captureServeOptions([
      'a2a', 'serve', '--provider', 'zai-coding', '--model', 'glm-5.2',
    ])).resolves.toEqual({
      defaultProvider: 'zai-coding',
      defaultModel: 'glm-5.2',
    });
  });

  it('uses prefixed root provider and model options for A2A serve', async () => {
    await expect(captureServeOptions([
      '--provider', 'zai-coding', '--model', 'glm-5.2', 'a2a', 'serve',
    ])).resolves.toEqual({
      defaultProvider: 'zai-coding',
      defaultModel: 'glm-5.2',
    });
  });

  it('lets the more specific serve options override prefixed root defaults', async () => {
    await expect(captureServeOptions([
      '--provider', 'root-provider',
      '--model', 'root-model',
      'a2a', 'serve',
      '--provider', 'serve-provider',
      '--model', 'serve-model',
    ])).resolves.toEqual({
      defaultProvider: 'serve-provider',
      defaultModel: 'serve-model',
    });
  });

  it('falls back to the configured provider and matching configured model', async () => {
    writeCoreConfig({ provider: 'config-provider', model: 'config-model' });

    await expect(captureServeOptions(['a2a', 'serve'])).resolves.toEqual({
      defaultProvider: 'config-provider',
      defaultModel: 'config-model',
    });
  });

  it('always supplies the built-in Runtime provider when no override is configured', async () => {
    const options = await captureServeOptions(['a2a', 'serve']);

    expect(options.defaultProvider).toEqual(expect.any(String));
    expect(options.defaultProvider?.trim()).not.toBe('');
  });

  it('prefers the environment provider and drops a model configured for another provider', async () => {
    writeCoreConfig({ provider: 'config-provider', model: 'config-model' });
    process.env.KODAX_PROVIDER = 'environment-provider';

    await expect(captureServeOptions(['a2a', 'serve'])).resolves.toEqual({
      defaultProvider: 'environment-provider',
    });
  });
});
