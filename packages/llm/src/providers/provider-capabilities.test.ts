/**
 * FEATURE_198 v0.7.44 — Provider capability JSON loader tests.
 *
 * Coverage:
 *   - JSON file schema validation (happy path)
 *   - Validator rejects each major failure mode (missing required,
 *     wrong type, unknown profile, cliBridge contradiction)
 *   - Loader cache behavior (single read per process)
 *   - `_resetProviderSnapshotsCache` test hook
 *   - Profile-name → object resolution
 *   - CLI-bridge dynamic fill (gemini-cli / codex-cli)
 *   - **Drift guard**: every known KODAX provider exists in JSON with
 *     the right shape (catches accidental field deletions in JSON edits)
 *   - **Cross-check**: loader output identity for selected providers
 *     against hard-coded expected values (catches data mis-transcription
 *     during the F198 split)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  CLI_BRIDGE_PROVIDER_CAPABILITY_PROFILE,
  IMAGE_INPUT_CLI_BRIDGE_PROVIDER_CAPABILITY_PROFILE,
  IMAGE_INPUT_NATIVE_PROVIDER_CAPABILITY_PROFILE,
} from './capability-profile.js';
import { KODAX_PROVIDER_SNAPSHOTS } from './registry.js';
import {
  _resetProviderSnapshotsCache,
  getProviderSnapshots,
} from './provider-capabilities.loader.js';
import { validateProviderCapabilitiesJson } from './provider-capabilities.types.js';

describe('FEATURE_198 — provider-capabilities loader', () => {
  beforeEach(() => {
    _resetProviderSnapshotsCache();
  });

  describe('basic loading', () => {
    it('reads JSON from disk and produces the expected provider keys', () => {
      const snapshots = getProviderSnapshots();
      const names = Object.keys(snapshots).sort();
      expect(names).toEqual(
        [
          'anthropic',
          'ark-coding',
          'codex-cli',
          'deepseek',
          'gemini-cli',
          'kimi',
          'kimi-code',
          'minimax-coding',
          'mimo',
          'mimo-coding',
          'openai',
          'qwen',
          'zhipu',
          'zhipu-coding',
        ].sort(),
      );
    });

    it('caches the snapshot — second call returns the same object identity', () => {
      const a = getProviderSnapshots();
      const b = getProviderSnapshots();
      expect(a).toBe(b);
    });

    it('_resetProviderSnapshotsCache forces a fresh load', () => {
      const a = getProviderSnapshots();
      _resetProviderSnapshotsCache();
      const b = getProviderSnapshots();
      expect(a).not.toBe(b);
      // Same data, different identity
      expect(b).toEqual(a);
    });
  });

  describe('profile-name resolution', () => {
    it('resolves "image-input-native" to the imported profile object', () => {
      const anthropic = getProviderSnapshots().anthropic;
      expect(anthropic.capabilityProfile).toBe(
        IMAGE_INPUT_NATIVE_PROVIDER_CAPABILITY_PROFILE,
      );
    });

    it('resolves "image-input-cli-bridge" for gemini-cli', () => {
      const gemini = getProviderSnapshots()['gemini-cli'];
      expect(gemini.capabilityProfile).toBe(
        IMAGE_INPUT_CLI_BRIDGE_PROVIDER_CAPABILITY_PROFILE,
      );
    });

    it('resolves "cli-bridge" for codex-cli', () => {
      const codex = getProviderSnapshots()['codex-cli'];
      expect(codex.capabilityProfile).toBe(CLI_BRIDGE_PROVIDER_CAPABILITY_PROFILE);
    });
  });

  describe('CLI-bridge dynamic fill', () => {
    it('gemini-cli has a non-empty model string filled from cli-bridge-models', () => {
      const gemini = getProviderSnapshots()['gemini-cli'];
      expect(typeof gemini.model).toBe('string');
      expect(gemini.model.length).toBeGreaterThan(0);
      expect(Array.isArray(gemini.models)).toBe(true);
      // models[] excludes the default
      for (const m of gemini.models ?? []) {
        expect(m.id).not.toBe(gemini.model);
      }
    });

    it('codex-cli has a non-empty model string filled from cli-bridge-models', () => {
      const codex = getProviderSnapshots()['codex-cli'];
      expect(typeof codex.model).toBe('string');
      expect(codex.model.length).toBeGreaterThan(0);
      expect(Array.isArray(codex.models)).toBe(true);
      for (const m of codex.models ?? []) {
        expect(m.id).not.toBe(codex.model);
      }
    });
  });

  describe('snapshot frozen', () => {
    it('top-level snapshot map is frozen', () => {
      const snap = getProviderSnapshots();
      expect(Object.isFrozen(snap)).toBe(true);
    });

    it('per-provider snapshot object is frozen', () => {
      const snap = getProviderSnapshots();
      expect(Object.isFrozen(snap.anthropic)).toBe(true);
    });

    it('models array is frozen', () => {
      const snap = getProviderSnapshots();
      const models = snap.anthropic.models;
      expect(Array.isArray(models)).toBe(true);
      expect(Object.isFrozen(models)).toBe(true);
      // each descriptor frozen too
      if (models) {
        for (const m of models) {
          expect(Object.isFrozen(m)).toBe(true);
        }
      }
    });
  });

  describe('registry KODAX_PROVIDER_SNAPSHOTS export', () => {
    it('exports the same snapshot the loader produced', () => {
      const fromLoader = getProviderSnapshots();
      // KODAX_PROVIDER_SNAPSHOTS was initialized at module load; loader
      // cache reset above means a fresh `getProviderSnapshots()` is a
      // DIFFERENT object identity. But the data must be deep-equal.
      expect(KODAX_PROVIDER_SNAPSHOTS).toEqual(fromLoader);
    });
  });

  describe('field-level cross-check (catches data mis-transcription)', () => {
    // The following block hard-codes the EXPECTED values for each
    // statically-known field. If a JSON edit drops or mis-types a value,
    // this fails immediately. CLI-bridge dynamic fields (model/models)
    // are NOT asserted here — they're verified separately above.

    it('anthropic: full field set matches expected', () => {
      const a = getProviderSnapshots().anthropic;
      expect(a.apiKeyEnv).toBe('ANTHROPIC_API_KEY');
      expect(a.model).toBe('claude-sonnet-4-6');
      expect(a.reasoningCapability).toBe('native-adaptive');
      expect(a.reasoningCapabilityV2).toMatchObject({
        reasoningPreset: 'claude-adaptive-max',
        effortStrategy: 'anthropic-output-effort',
        thinkingStrategy: 'anthropic-adaptive',
        defaultEffort: 'high',
      });
      expect(a.supportsThinking).toBe(true);
      expect(a.contextWindow).toBe(200000);
      expect(a.maxOutputTokens).toBe(64000);
      expect(a.thinkingBudgetCap).toBe(28000);
      expect(a.models).toEqual([
        expect.objectContaining({
          id: 'claude-opus-4-8',
          displayName: 'Opus 4.8',
          reasoningCapability: 'native-adaptive',
          reasoningCapabilityV2: expect.objectContaining({
            reasoningPreset: 'claude-adaptive-xhigh',
            effortStrategy: 'anthropic-output-effort',
            thinkingStrategy: 'anthropic-adaptive',
            defaultEffort: 'high',
          }),
          contextWindow: 1000000,
          maxOutputTokens: 128000,
        }),
        expect.objectContaining({
          id: 'claude-opus-4-7',
          displayName: 'Opus 4.7',
          reasoningCapability: 'native-adaptive',
          reasoningCapabilityV2: expect.objectContaining({
            reasoningPreset: 'claude-adaptive-xhigh',
            effortStrategy: 'anthropic-output-effort',
            thinkingStrategy: 'anthropic-adaptive',
            defaultEffort: 'high',
          }),
          contextWindow: 1000000,
          maxOutputTokens: 128000,
        }),
        expect.objectContaining({
          id: 'claude-opus-4-6',
          displayName: 'Opus 4.6',
          reasoningCapability: 'native-adaptive',
          reasoningCapabilityV2: expect.objectContaining({
            reasoningPreset: 'claude-adaptive-max',
          }),
          thinkingBudgetCap: 28000,
        }),
        expect.objectContaining({
          id: 'claude-haiku-4-5',
          displayName: 'Haiku 4.5',
          reasoningCapability: 'native-budget',
          reasoningCapabilityV2: expect.objectContaining({
            reasoningPreset: 'anthropic-budget',
            effortStrategy: 'provider-budget',
          }),
          thinkingBudgetCap: 10000,
        }),
      ]);
    });

    it('exposes effort-first reasoning metadata for OpenAI and Codex CLI', () => {
      const snap = getProviderSnapshots();
      expect(snap.openai.reasoningCapabilityV2).toMatchObject({
        effortStrategy: 'openai-chat-effort',
        defaultEffort: 'medium',
        supportsReasoningEffort: true,
      });
      expect(snap.openai.reasoningCapabilityV2?.supportedEfforts?.map((preset) => preset.value)).toEqual([
        'none',
        'minimal',
        'low',
        'medium',
        'high',
        'xhigh',
      ]);
      expect(snap['codex-cli'].reasoningCapabilityV2).toMatchObject({
        effortStrategy: 'codex-cli-config',
        defaultEffort: 'medium',
        allowCustomEffort: true,
      });
    });

    it('deepseek: KODAX_ESCALATED_MAX_OUTPUT_TOKENS resolved to 64000', () => {
      const d = getProviderSnapshots().deepseek;
      expect(d.maxOutputTokens).toBe(64000);
      expect(d.contextWindow).toBe(1_000_000);
    });

    it('kimi-code: KODAX_CAPPED_MAX_OUTPUT_TOKENS resolved to 32000, no models[]', () => {
      const k = getProviderSnapshots()['kimi-code'];
      expect(k.maxOutputTokens).toBe(32000);
      expect(k.contextWindow).toBe(256000);
      expect(k.models).toBeUndefined();
    });

    it('kimi: K2.7 Code model descriptor is available at 256K context', () => {
      const k = getProviderSnapshots().kimi;
      expect(k.models?.find((m) => m.id === 'kimi-k2.7-code')).toEqual(expect.objectContaining({
        id: 'kimi-k2.7-code',
        displayName: 'Kimi K2.7 Code',
        contextWindow: 256_000,
        reasoningCapability: 'native-toggle',
        reasoningCapabilityV2: expect.objectContaining({
          reasoningPreset: 'kimi-k2.7-code',
          effortStrategy: 'prompt-only',
          localRejectEfforts: ['none', 'minimal'],
        }),
      }));
    });

    it('zhipu: GLM-5.2 model descriptor carries its 1M context override', () => {
      const z = getProviderSnapshots().zhipu;
      expect(z.models?.find((m) => m.id === 'glm-5.2')).toEqual(expect.objectContaining({
        id: 'glm-5.2',
        displayName: 'GLM-5.2',
        contextWindow: 1_000_000,
        maxOutputTokens: 131_072,
        reasoningCapability: 'native-effort',
        reasoningCapabilityV2: expect.objectContaining({
          reasoningPreset: 'zai-glm-5.2',
          effortStrategy: 'openai-chat-effort',
          defaultEffort: 'max',
          effortAliases: { low: 'high', medium: 'high', xhigh: 'max' },
        }),
      }));
    });

    it('zhipu-coding: bench-tuned 16K maxOutputTokens + thinkingBudgetCap', () => {
      const z = getProviderSnapshots()['zhipu-coding'];
      expect(z.maxOutputTokens).toBe(16000);
      expect(z.thinkingBudgetCap).toBe(16000);
      expect(z.contextWindow).toBe(200000);
      expect(z.models?.find((m) => m.id === 'glm-5.2')).toEqual(expect.objectContaining({
        id: 'glm-5.2',
        displayName: 'GLM-5.2',
        contextWindow: 1_000_000,
        maxOutputTokens: 131_072,
        reasoningCapability: 'native-effort',
        reasoningCapabilityV2: expect.objectContaining({
          reasoningPreset: 'zai-glm-5.2',
          effortStrategy: 'openai-chat-effort',
          defaultEffort: 'max',
        }),
      }));
      // 2026-06: GLM-5 / GLM-5.1 retired (auto-routed to GLM-5.2 upstream);
      // catalogue is now GLM-5.2 / GLM-5 Turbo / GLM-4.7, default GLM-5.2.
      expect(z.model).toBe('glm-5.2');
      expect(z.models?.map((m) => m.id)).toEqual(['glm-5.2', 'glm-5-turbo', 'glm-4.7']);
      expect(z.models?.find((m) => m.id === 'glm-4.7')).toEqual(expect.objectContaining({
        id: 'glm-4.7',
        displayName: 'GLM-4.7',
        contextWindow: 200_000,
        reasoningCapability: 'native-toggle',
        reasoningCapabilityV2: expect.objectContaining({
          reasoningPreset: 'zai-glm-toggle',
          effortStrategy: 'provider-toggle',
        }),
      }));
    });

    it('ark-coding: per-model contextWindow overrides preserved', () => {
      const a = getProviderSnapshots()['ark-coding'];
      expect(a.contextWindow).toBe(200000);
      expect(a.maxOutputTokens).toBe(32000);
      const v4pro = a.models?.find((m) => m.id === 'deepseek-v4-pro');
      const v32 = a.models?.find((m) => m.id === 'deepseek-v3.2');
      // 2026-06: minimax-latest retired, replaced by explicit M3 (1M
      // frontier) + M2.7 (204K) entries per user confirmation against
      // the Ark console.
      const m3 = a.models?.find((m) => m.id === 'MiniMax-M3');
      const m27 = a.models?.find((m) => m.id === 'MiniMax-M2.7');
      expect(v4pro?.contextWindow).toBe(1_000_000);
      expect(v32?.contextWindow).toBe(128_000);
      expect(m3?.contextWindow).toBe(1_000_000);
      expect(m27?.contextWindow).toBe(204_800);
    });
  });

  // FEATURE_216 v0.7.45 — per-provider verifyStrategy drift guard.
  // Distribution (from 2026-05-28 12-provider real+fake key probe):
  //   count-tokens (5):    anthropic + 4 anthropic-coding (zhipu/kimi/minimax/ark)
  //   models-list (4):     openai, deepseek, kimi, qwen
  //   minimal-message (3): zhipu, mimo, mimo-coding (each empirical reason)
  //   unsupported (2):     gemini-cli, codex-cli
  describe('FEATURE_216 verifyStrategy per-provider', () => {
    it('count-tokens providers (5): anthropic + 4 anthropic-coding', () => {
      const snap = getProviderSnapshots();
      for (const name of ['anthropic', 'zhipu-coding', 'kimi-code', 'minimax-coding', 'ark-coding']) {
        expect(snap[name].verifyStrategy).toBe('count-tokens');
      }
    });

    it('models-list providers (4): openai-compat with auth-gated /v1/models', () => {
      const snap = getProviderSnapshots();
      for (const name of ['openai', 'deepseek', 'kimi', 'qwen']) {
        expect(snap[name].verifyStrategy).toBe('models-list');
      }
    });

    it('minimal-message providers (3): zhipu (public /models false-positive) + mimo+mimo-coding (count_tokens 404)', () => {
      const snap = getProviderSnapshots();
      for (const name of ['zhipu', 'mimo', 'mimo-coding']) {
        expect(snap[name].verifyStrategy).toBe('minimal-message');
      }
    });

    it('cli-bridge providers (2) MUST be unsupported (credentials in CLI binary)', () => {
      const snap = getProviderSnapshots();
      for (const name of ['gemini-cli', 'codex-cli']) {
        expect(snap[name].verifyStrategy).toBe('unsupported');
      }
    });

    it('all 14 providers have an explicit verifyStrategy (no silent default)', () => {
      const snap = getProviderSnapshots();
      const expected = new Set(['count-tokens', 'models-list', 'minimal-message', 'unsupported']);
      let total = 0;
      for (const [, s] of Object.entries(snap)) {
        expect(expected.has(s.verifyStrategy)).toBe(true);
        total++;
      }
      expect(total).toBe(14);
    });
  });
});

describe('FEATURE_198 — validator failure modes', () => {
  function shouldThrow(raw: unknown, matcher: RegExp | string): void {
    expect(() => validateProviderCapabilitiesJson(raw)).toThrow(matcher);
  }

  it('rejects non-object root', () => {
    shouldThrow(null, /root must be an object/);
    shouldThrow('foo', /root must be an object/);
  });

  it('rejects wrong version', () => {
    shouldThrow({ version: 2, updatedAt: 'x', providers: {} }, /version must be 1/);
  });

  it('rejects missing updatedAt', () => {
    shouldThrow({ version: 1, providers: {} }, /updatedAt/);
  });

  it('rejects missing providers', () => {
    shouldThrow({ version: 1, updatedAt: 'x' }, /providers must be an object/);
  });

  it('rejects unknown reasoningCapability', () => {
    shouldThrow(
      {
        version: 1,
        updatedAt: 'x',
        providers: {
          foo: {
            apiKeyEnv: 'F',
            model: 'm',
            reasoningCapability: 'magic',
            capabilityProfile: 'native',
          },
        },
      },
      /reasoningCapability must be one of/,
    );
  });

  it('rejects unknown capabilityProfile', () => {
    shouldThrow(
      {
        version: 1,
        updatedAt: 'x',
        providers: {
          foo: {
            apiKeyEnv: 'F',
            model: 'm',
            reasoningCapability: 'none',
            capabilityProfile: 'super-deluxe',
          },
        },
      },
      /capabilityProfile must be one of/,
    );
  });

  it('rejects static entry missing model', () => {
    shouldThrow(
      {
        version: 1,
        updatedAt: 'x',
        providers: {
          foo: {
            apiKeyEnv: 'F',
            reasoningCapability: 'none',
            capabilityProfile: 'native',
            verifyStrategy: 'models-list',
          },
        },
      },
      /model is required/,
    );
  });

  it('rejects cliBridge entry that defines model', () => {
    shouldThrow(
      {
        version: 1,
        updatedAt: 'x',
        providers: {
          'foo-cli': {
            apiKeyEnv: 'F',
            model: 'should-not-be-here',
            reasoningCapability: 'none',
            capabilityProfile: 'cli-bridge',
            cliBridge: true,
            verifyStrategy: 'unsupported',
          },
        },
      },
      /cliBridge entry but defines model/,
    );
  });

  it('rejects negative contextWindow', () => {
    shouldThrow(
      {
        version: 1,
        updatedAt: 'x',
        providers: {
          foo: {
            apiKeyEnv: 'F',
            model: 'm',
            reasoningCapability: 'none',
            capabilityProfile: 'native',
            verifyStrategy: 'models-list',
            contextWindow: -1,
          },
        },
      },
      /contextWindow must be a non-negative/,
    );
  });

  it('rejects non-array models', () => {
    shouldThrow(
      {
        version: 1,
        updatedAt: 'x',
        providers: {
          foo: {
            apiKeyEnv: 'F',
            model: 'm',
            reasoningCapability: 'none',
            capabilityProfile: 'native',
            verifyStrategy: 'models-list',
            models: 'not-an-array',
          },
        },
      },
      /models must be an array/,
    );
  });

  it('rejects model descriptor missing id', () => {
    shouldThrow(
      {
        version: 1,
        updatedAt: 'x',
        providers: {
          foo: {
            apiKeyEnv: 'F',
            model: 'm',
            reasoningCapability: 'none',
            capabilityProfile: 'native',
            verifyStrategy: 'models-list',
            models: [{ displayName: 'missing-id' }],
          },
        },
      },
      /id must be a non-empty string/,
    );
  });

  it('accepts minimal valid static entry', () => {
    const result = validateProviderCapabilitiesJson({
      version: 1,
      updatedAt: 'x',
      providers: {
        foo: {
          apiKeyEnv: 'F',
          model: 'm',
          reasoningCapability: 'none',
          capabilityProfile: 'native',
          verifyStrategy: 'models-list',
        },
      },
    });
    expect(result.providers.foo.model).toBe('m');
    expect(result.providers.foo.verifyStrategy).toBe('models-list');
  });

  it('accepts minimal valid cliBridge entry', () => {
    const result = validateProviderCapabilitiesJson({
      version: 1,
      updatedAt: 'x',
      providers: {
        'foo-cli': {
          apiKeyEnv: 'F',
          cliBridge: true,
          reasoningCapability: 'prompt-only',
          capabilityProfile: 'cli-bridge',
          verifyStrategy: 'unsupported',
        },
      },
    });
    expect(result.providers['foo-cli'].cliBridge).toBe(true);
    expect(result.providers['foo-cli'].model).toBeUndefined();
    expect(result.providers['foo-cli'].verifyStrategy).toBe('unsupported');
  });

  // FEATURE_216 v0.7.45 — verifyStrategy validator
  it('rejects missing verifyStrategy', () => {
    shouldThrow(
      {
        version: 1,
        updatedAt: 'x',
        providers: {
          foo: {
            apiKeyEnv: 'F',
            model: 'm',
            reasoningCapability: 'none',
            capabilityProfile: 'native',
          },
        },
      },
      /verifyStrategy must be one of/,
    );
  });

  it('rejects unknown verifyStrategy', () => {
    shouldThrow(
      {
        version: 1,
        updatedAt: 'x',
        providers: {
          foo: {
            apiKeyEnv: 'F',
            model: 'm',
            reasoningCapability: 'none',
            capabilityProfile: 'native',
            verifyStrategy: 'send-postcard',
          },
        },
      },
      /verifyStrategy must be one of/,
    );
  });

  it('rejects cliBridge entry whose verifyStrategy is not "unsupported"', () => {
    shouldThrow(
      {
        version: 1,
        updatedAt: 'x',
        providers: {
          'foo-cli': {
            apiKeyEnv: 'F',
            cliBridge: true,
            reasoningCapability: 'prompt-only',
            capabilityProfile: 'cli-bridge',
            verifyStrategy: 'count-tokens',
          },
        },
      },
      /cliBridge entry but verifyStrategy=/,
    );
  });
});
