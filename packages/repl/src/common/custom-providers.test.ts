/**
 * v0.7.42 — Custom provider CRUD tests (closes gap 7 reported by KodaX
 * Space). Each test uses a per-case `KODAX_HOME` override pointing at a
 * fresh temp dir so the real `~/.kodax/config.json` is never touched.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setAgentConfigHome } from '@kodax-ai/coding';

import {
  getCustomProviderConfig,
  listCustomProviders,
  removeCustomProvider,
  upsertCustomProvider,
} from './custom-providers.js';

let tmpHome: string;
let configPath: string;

beforeEach(() => {
  setAgentConfigHome(undefined);
  tmpHome = mkdtempSync(join(tmpdir(), 'kodax-cp-crud-test-'));
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

function readConfig(): { customProviders?: Array<{ name: string }> } {
  if (!existsSync(configPath)) return {};
  return JSON.parse(readFileSync(configPath, 'utf-8')) as {
    customProviders?: Array<{ name: string }>;
  };
}

// Minimal valid OpenAI-protocol custom provider. The validator requires
// name + protocol ('anthropic' | 'openai') + baseUrl + apiKeyEnv + model.
function makeProvider(name: string, model: string = 'fake-model'): import('@kodax-ai/coding').KodaXCustomProviderConfig {
  return {
    name,
    protocol: 'openai',
    baseUrl: 'https://example.local/v1',
    apiKeyEnv: 'FAKE_API_KEY',
    model,
  };
}

describe('listCustomProviders', () => {
  it('returns empty array when no config exists', () => {
    expect(listCustomProviders()).toEqual([]);
  });

  it('returns empty array when config has no customProviders field', () => {
    writeConfig({ provider: 'anthropic' });
    expect(listCustomProviders()).toEqual([]);
  });

  it('returns deep-cloned snapshots — mutating result does NOT affect on-disk config', () => {
    writeConfig({ customProviders: [makeProvider('alpha')] });

    const list = listCustomProviders();
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe('alpha');

    // Mutate the returned array + entry.
    list.length = 0;
    const list2 = listCustomProviders();
    expect(list2).toHaveLength(1);
    expect(list2[0]?.name).toBe('alpha');
  });

  it('preserves file order (insertion order)', () => {
    writeConfig({
      customProviders: [makeProvider('beta'), makeProvider('alpha'), makeProvider('gamma')],
    });
    expect(listCustomProviders().map((p) => p.name)).toEqual(['beta', 'alpha', 'gamma']);
  });
});

describe('getCustomProviderConfig', () => {
  it('returns undefined when nothing is configured', () => {
    expect(getCustomProviderConfig('alpha')).toBeUndefined();
  });

  it('returns undefined for unknown name', () => {
    writeConfig({ customProviders: [makeProvider('alpha')] });
    expect(getCustomProviderConfig('beta')).toBeUndefined();
  });

  it('returns deep-cloned match by name', () => {
    writeConfig({
      customProviders: [makeProvider('alpha', 'm1'), makeProvider('beta', 'm2')],
    });

    const beta = getCustomProviderConfig('beta');
    expect(beta?.name).toBe('beta');
    expect(beta?.model).toBe('m2');
  });

  it('returns undefined for empty / non-string input (defensive)', () => {
    writeConfig({ customProviders: [makeProvider('alpha')] });
    expect(getCustomProviderConfig('')).toBeUndefined();
    // @ts-expect-error — runtime validation test
    expect(getCustomProviderConfig(undefined)).toBeUndefined();
  });
});

describe('upsertCustomProvider — insert', () => {
  it('creates config.json + customProviders array when none exists', () => {
    expect(existsSync(configPath)).toBe(false);
    upsertCustomProvider(makeProvider('alpha'));

    expect(existsSync(configPath)).toBe(true);
    const persisted = readConfig().customProviders ?? [];
    expect(persisted.map((p) => p.name)).toEqual(['alpha']);
  });

  it('appends a new entry to existing customProviders', () => {
    writeConfig({ customProviders: [makeProvider('alpha')] });
    upsertCustomProvider(makeProvider('beta'));

    const persisted = readConfig().customProviders ?? [];
    expect(persisted.map((p) => p.name)).toEqual(['alpha', 'beta']);
  });

  it('preserves other top-level config fields on insert', () => {
    writeConfig({ provider: 'anthropic', model: 'claude', customProviders: [] });
    upsertCustomProvider(makeProvider('alpha'));

    const persisted = readConfig() as { provider?: string; model?: string; customProviders?: unknown[] };
    expect(persisted.provider).toBe('anthropic');
    expect(persisted.model).toBe('claude');
    expect(persisted.customProviders).toHaveLength(1);
  });
});

describe('upsertCustomProvider — replace (same name)', () => {
  it('replaces in-place when name already exists (no append)', () => {
    writeConfig({
      customProviders: [makeProvider('alpha', 'old-model'), makeProvider('beta')],
    });
    upsertCustomProvider(makeProvider('alpha', 'new-model'));

    const persisted = readConfig().customProviders ?? [];
    expect(persisted.map((p) => p.name)).toEqual(['alpha', 'beta']);
    expect((persisted[0] as { model?: string }).model).toBe('new-model');
  });

  it('preserves position when replacing (no reorder)', () => {
    writeConfig({
      customProviders: [makeProvider('alpha'), makeProvider('beta'), makeProvider('gamma')],
    });
    upsertCustomProvider(makeProvider('beta', 'updated'));

    expect((readConfig().customProviders ?? []).map((p) => p.name)).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);
  });
});

describe('upsertCustomProvider — validation', () => {
  it('rejects malformed input — file untouched', () => {
    writeConfig({ customProviders: [makeProvider('alpha')] });

    expect(() =>
      upsertCustomProvider({
        // @ts-expect-error — testing validation
        name: 123,
        protocol: 'openai-compat',
        baseUrl: 'https://x',
        apiKeyEnv: 'K',
        transport: 'native-api',
        model: 'm',
      }),
    ).toThrow();

    // Config still has the original alpha, untouched.
    expect((readConfig().customProviders ?? []).map((p) => p.name)).toEqual(['alpha']);
  });
});

describe('removeCustomProvider', () => {
  it('removes a configured provider by name and returns true', () => {
    writeConfig({
      customProviders: [makeProvider('alpha'), makeProvider('beta')],
    });

    expect(removeCustomProvider('alpha')).toBe(true);
    expect((readConfig().customProviders ?? []).map((p) => p.name)).toEqual(['beta']);
  });

  it('returns false (no-op, file unchanged) for unknown name', () => {
    writeConfig({ customProviders: [makeProvider('alpha')] });
    const before = readFileSync(configPath, 'utf-8');

    expect(removeCustomProvider('not-there')).toBe(false);
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
  });

  it('returns false for empty / non-string input', () => {
    writeConfig({ customProviders: [makeProvider('alpha')] });
    expect(removeCustomProvider('')).toBe(false);
    // @ts-expect-error — runtime validation test
    expect(removeCustomProvider(undefined)).toBe(false);
  });

  it('returns false when no customProviders array exists', () => {
    expect(removeCustomProvider('alpha')).toBe(false);
  });

  it('preserves other top-level config fields on remove', () => {
    writeConfig({
      provider: 'anthropic',
      customProviders: [makeProvider('alpha')],
    });
    expect(removeCustomProvider('alpha')).toBe(true);

    const persisted = readConfig() as { provider?: string; customProviders?: unknown[] };
    expect(persisted.provider).toBe('anthropic');
    expect(persisted.customProviders).toEqual([]);
  });
});

describe('round-trip — upsert + remove leaves config empty', () => {
  it('add → remove returns to no-customProviders state', () => {
    upsertCustomProvider(makeProvider('alpha'));
    expect(listCustomProviders().map((p) => p.name)).toEqual(['alpha']);

    expect(removeCustomProvider('alpha')).toBe(true);
    expect(listCustomProviders()).toEqual([]);
  });

  it('upsert is idempotent — same value applied twice still has one entry', () => {
    upsertCustomProvider(makeProvider('alpha', 'm1'));
    upsertCustomProvider(makeProvider('alpha', 'm1'));
    expect(listCustomProviders()).toHaveLength(1);
  });
});
