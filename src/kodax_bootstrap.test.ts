import { createRequire } from 'node:module';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isBareResumeRequest,
  runKodaXBootstrap,
  type BootstrapResumeRoute,
} from './kodax_bootstrap.js';

describe('KodaX CLI bootstrap', () => {
  it.each([
    [['-r']],
    [['--resume']],
  ])('routes the exact bare resume form through the lightweight selector: %j', async (args) => {
    const argv = ['node', 'kodax', ...args];
    const resolveBareResume = vi.fn(async (): Promise<BootstrapResumeRoute> => ({
      kind: 'continue',
      argv: ['-r', 'selected-session'],
    }));
    const main = vi.fn(async () => undefined);

    await runKodaXBootstrap({
      argv,
      loadResume: async () => ({ resolveBareResume }),
      loadCli: async () => ({ main }),
    });

    expect(resolveBareResume).toHaveBeenCalledTimes(1);
    expect(argv.slice(2)).toEqual(['-r', 'selected-session']);
    expect(main).toHaveBeenCalledTimes(1);
  });

  it.each([
    [[]],
    [['-r', 'session-id']],
    [['--resume', 'Session title']],
    [['-r', '--provider', 'openai']],
    [['--mode', 'json', '-r']],
  ])('keeps non-bare forms on the existing CLI parser: %j', async (args) => {
    const argv = ['node', 'kodax', ...args];
    const loadResume = vi.fn();
    const main = vi.fn(async () => undefined);

    await runKodaXBootstrap({
      argv,
      loadResume,
      loadCli: async () => ({ main }),
    });

    expect(loadResume).not.toHaveBeenCalled();
    expect(argv.slice(2)).toEqual(args);
    expect(main).toHaveBeenCalledTimes(1);
  });

  it('does not load the full CLI when the picker cancels', async () => {
    const loadCli = vi.fn();

    await runKodaXBootstrap({
      argv: ['node', 'kodax', '-r'],
      loadResume: async () => ({
        resolveBareResume: async () => ({ kind: 'exit' }),
      }),
      loadCli,
    });

    expect(loadCli).not.toHaveBeenCalled();
  });

  it('recognizes only an exact one-token bare resume request', () => {
    expect(isBareResumeRequest(['-r'])).toBe(true);
    expect(isBareResumeRequest(['--resume'])).toBe(true);
    expect(isBareResumeRequest(['-r', 'id'])).toBe(false);
    expect(isBareResumeRequest(['--provider', 'openai', '-r'])).toBe(false);
  });
});

describe('production environment preload', () => {
  const require = createRequire(import.meta.url);
  const preloadPath = path.resolve('scripts/production-env.cjs');
  const envKeys = [
    'NODE_ENV',
    'LD_PRELOAD',
    'DYLD_INSERT_LIBRARIES',
    'DYLD_LIBRARY_PATH',
    'ELECTRON_RUN_AS_NODE',
    'KODAX_DISABLE_HARDENING',
  ] as const;
  const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

  afterEach(() => {
    for (const key of envKeys) {
      const value = originalEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete require.cache[require.resolve(preloadPath)];
  });

  it('sets production mode and strips linker and Electron bootstrap variables', () => {
    delete process.env.NODE_ENV;
    delete process.env.KODAX_DISABLE_HARDENING;
    process.env.LD_PRELOAD = '/tmp/preload.so';
    process.env.DYLD_INSERT_LIBRARIES = '/tmp/preload.dylib';
    process.env.DYLD_LIBRARY_PATH = '/tmp/lib';
    process.env.ELECTRON_RUN_AS_NODE = '1';

    delete require.cache[require.resolve(preloadPath)];
    require(preloadPath);

    expect(process.env.NODE_ENV).toBe('production');
    expect(process.env.LD_PRELOAD).toBeUndefined();
    expect(process.env.DYLD_INSERT_LIBRARIES).toBeUndefined();
    expect(process.env.DYLD_LIBRARY_PATH).toBeUndefined();
    expect(process.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it('honors hardening opt-out but always consumes the Electron bootstrap variable', () => {
    process.env.KODAX_DISABLE_HARDENING = '1';
    process.env.LD_PRELOAD = '/tmp/preload.so';
    process.env.ELECTRON_RUN_AS_NODE = '1';

    delete require.cache[require.resolve(preloadPath)];
    require(preloadPath);

    expect(process.env.LD_PRELOAD).toBe('/tmp/preload.so');
    expect(process.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });
});
