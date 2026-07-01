import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyModelTiersFromOptions } from './task-engine.js';

/**
 * M2 — the SDK path: KodaXOptions.modelTiers is bridged UNCONDITIONALLY to the
 * KODAX_FAST/DEEP_PROVIDER/MODEL env vars (SDK outranks shell env in the
 * precedence rule). The config.json path (repl prepareRuntimeConfig) bridges
 * env-wins; this is the trusted-caller override.
 */
const VARS = ['KODAX_FAST_PROVIDER', 'KODAX_FAST_MODEL', 'KODAX_DEEP_PROVIDER', 'KODAX_DEEP_MODEL'] as const;

describe('applyModelTiersFromOptions (M2 SDK bridge)', () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
    for (const v of VARS) delete process.env[v];
  });
  afterEach(() => {
    for (const v of VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
  });

  it('writes each configured tier field to its env var', () => {
    applyModelTiersFromOptions({
      fast: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      deep: { provider: 'zhipu-coding', model: 'glm-5.2' },
    });
    expect(process.env.KODAX_FAST_PROVIDER).toBe('deepseek');
    expect(process.env.KODAX_FAST_MODEL).toBe('deepseek-v4-flash');
    expect(process.env.KODAX_DEEP_PROVIDER).toBe('zhipu-coding');
    expect(process.env.KODAX_DEEP_MODEL).toBe('glm-5.2');
  });

  it('OVERRIDES a pre-existing env var (SDK outranks shell env)', () => {
    process.env.KODAX_DEEP_MODEL = 'shell-set';
    applyModelTiersFromOptions({ deep: { model: 'sdk-set' } });
    expect(process.env.KODAX_DEEP_MODEL).toBe('sdk-set');
  });

  it('leaves env untouched when modelTiers is undefined or a tier is partial', () => {
    applyModelTiersFromOptions(undefined);
    expect(process.env.KODAX_FAST_PROVIDER).toBeUndefined();
    applyModelTiersFromOptions({ fast: { provider: 'only-provider' } });
    expect(process.env.KODAX_FAST_PROVIDER).toBe('only-provider');
    expect(process.env.KODAX_FAST_MODEL).toBeUndefined();
  });
});
