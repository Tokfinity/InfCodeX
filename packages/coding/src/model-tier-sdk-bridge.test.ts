import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyConfigOptionsToEnv, applyModelTiersFromOptions } from './task-engine.js';
import type { KodaXOptions } from './types.js';

/**
 * M2 — the SDK path: KodaXOptions.modelTiers is bridged UNCONDITIONALLY to the
 * KODAX_FAST/DEEP_PROVIDER/MODEL env vars (SDK outranks shell env in the
 * precedence rule). The config.json path (repl prepareRuntimeConfig) bridges
 * env-wins; this is the trusted-caller override.
 */
const VARS = [
  'KODAX_FAST_PROVIDER', 'KODAX_FAST_MODEL', 'KODAX_DEEP_PROVIDER', 'KODAX_DEEP_MODEL',
  'KODAX_MAX_OUTPUT_TOKENS', 'KODAX_DISABLE_PROMPT_CACHE', 'KODAX_LSP',
] as const;

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

describe('applyConfigOptionsToEnv (M2 config-surface SDK peers)', () => {
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

  it('bridges the SDK peers to their env vars using the reader-expected encoding', () => {
    applyConfigOptionsToEnv({ maxOutputTokens: 8192, disablePromptCache: true, lsp: false } as KodaXOptions);
    expect(process.env.KODAX_MAX_OUTPUT_TOKENS).toBe('8192');
    expect(process.env.KODAX_DISABLE_PROMPT_CACHE).toBe('1'); // anthropic checks === '1'
    expect(process.env.KODAX_LSP).toBe('0'); // service checks === '0' to disable
  });

  it('only fires for fields the embedder set (lsp:true and unset are no-ops)', () => {
    applyConfigOptionsToEnv({ provider: 'x' } as KodaXOptions);
    expect(process.env.KODAX_MAX_OUTPUT_TOKENS).toBeUndefined();
    expect(process.env.KODAX_DISABLE_PROMPT_CACHE).toBeUndefined();
    applyConfigOptionsToEnv({ provider: 'x', lsp: true } as KodaXOptions);
    // lsp:true = default-enabled → no env write (only lsp:false disables via '0')
    expect(process.env.KODAX_LSP).toBeUndefined();
  });
});
