import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock only saveConfig so the test never touches the real ~/.kodax/config.json.
vi.mock('../common/utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../common/utils.js')>()),
  saveConfig: vi.fn(),
}));

import { saveConfig } from '../common/utils.js';
import { BUILTIN_COMMANDS } from './commands.js';
import type { CommandCallbacks, CurrentConfig, InteractiveContext } from '../commands/types.js';

const fallbackCmd = BUILTIN_COMMANDS.find((c) => c.name === 'fallback')!;
const ctx = {} as unknown as InteractiveContext;
const cb = {} as unknown as CommandCallbacks;
const cfg = {} as unknown as CurrentConfig;
const run = (args: string[]) => fallbackCmd.handler(args, ctx, cb, cfg);

describe('/fallback command (FEATURE_102 P3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.KODAX_FALLBACK_PROVIDERS;
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.KODAX_FALLBACK_PROVIDERS;
  });

  it('sets the chain from a comma-separated arg (persist + live env)', async () => {
    await run(['ark-coding,kimi-code']);
    expect(saveConfig).toHaveBeenCalledWith({ fallbackProviders: ['ark-coding', 'kimi-code'] });
    expect(process.env.KODAX_FALLBACK_PROVIDERS).toBe('ark-coding,kimi-code');
  });

  it('accepts space-separated provider ids too', async () => {
    await run(['ark-coding', 'kimi-code']);
    expect(saveConfig).toHaveBeenCalledWith({ fallbackProviders: ['ark-coding', 'kimi-code'] });
    expect(process.env.KODAX_FALLBACK_PROVIDERS).toBe('ark-coding,kimi-code');
  });

  it('off clears both the persisted config and the live env', async () => {
    process.env.KODAX_FALLBACK_PROVIDERS = 'ark-coding';
    await run(['off']);
    expect(saveConfig).toHaveBeenCalledWith({ fallbackProviders: undefined });
    expect(process.env.KODAX_FALLBACK_PROVIDERS).toBeUndefined();
  });

  it('status does not persist anything', async () => {
    process.env.KODAX_FALLBACK_PROVIDERS = 'ark-coding,kimi-code';
    await run(['status']);
    await run([]);
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it('rejects an empty chain without persisting', async () => {
    await run([',  ,']);
    expect(saveConfig).not.toHaveBeenCalled();
    expect(process.env.KODAX_FALLBACK_PROVIDERS).toBeUndefined();
  });
});
