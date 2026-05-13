import { describe, expect, it } from 'vitest';
import {
  getProviderConfiguredCapabilityProfile,
  getProviderList,
  getProviderModels,
} from './registry.js';

const EXPECTED_CLI_BRIDGE_PROFILE = {
  transport: 'cli-bridge',
  conversationSemantics: 'last-user-message',
  mcpSupport: 'none',
  contextFidelity: 'lossy',
  toolCallingFidelity: 'limited',
  sessionSupport: 'stateless',
  longRunningSupport: 'limited',
  multimodalSupport: 'none',
  evidenceSupport: 'limited',
} as const;

const EXPECTED_NATIVE_PROFILE = {
  transport: 'native-api',
  conversationSemantics: 'full-history',
  mcpSupport: 'none',
  contextFidelity: 'full',
  toolCallingFidelity: 'full',
  sessionSupport: 'full',
  longRunningSupport: 'full',
  multimodalSupport: 'none',
  evidenceSupport: 'full',
} as const;

const EXPECTED_IMAGE_INPUT_NATIVE_PROFILE = {
  ...EXPECTED_NATIVE_PROFILE,
  multimodalSupport: 'image-input',
} as const;

describe('provider capability profiles', () => {
  it('marks CLI bridge providers as lossy bridge transports in snapshot metadata', () => {
    expect(getProviderConfiguredCapabilityProfile('gemini-cli')).toEqual(
      EXPECTED_CLI_BRIDGE_PROFILE,
    );
    expect(getProviderConfiguredCapabilityProfile('codex-cli')).toEqual(
      EXPECTED_CLI_BRIDGE_PROFILE,
    );

    const providers = getProviderList();
    expect(
      providers.find((provider) => provider.name === 'gemini-cli')?.capabilityProfile,
    ).toEqual(EXPECTED_CLI_BRIDGE_PROFILE);
    expect(
      providers.find((provider) => provider.name === 'codex-cli')?.capabilityProfile,
    ).toEqual(EXPECTED_CLI_BRIDGE_PROFILE);
  });

  it('keeps multimodal-native providers on image-input capable native profiles', () => {
    expect(getProviderConfiguredCapabilityProfile('anthropic')).toEqual(
      EXPECTED_IMAGE_INPUT_NATIVE_PROFILE,
    );
    expect(getProviderConfiguredCapabilityProfile('openai')).toEqual(
      EXPECTED_IMAGE_INPUT_NATIVE_PROFILE,
    );
  });

  it('marks Anthropic-compat + OpenAI-compat providers as image-input capable (FEATURE_134 v0.7.40)', () => {
    // Anthropic-compat clones inherit anthropic.ts:770 image block forwarding.
    // OpenAI-compat clones inherit openai.ts:904 image_url forwarding. The
    // flag means KodaX does not artificially block multimodal requests at
    // the SA-path policy gate; per-model vision support is the upstream
    // provider's contract.
    const visionCapableNativeProviders = [
      'anthropic',
      'openai',
      'deepseek',
      'kimi',
      'kimi-code',
      'qwen',
      'zhipu',
      'zhipu-coding',
      'minimax-coding',
      'mimo-coding',
      'ark-coding',
    ] as const;
    for (const provider of visionCapableNativeProviders) {
      expect(getProviderConfiguredCapabilityProfile(provider)?.multimodalSupport).toBe(
        'image-input',
      );
    }
  });

  it('keeps CLI-bridge providers (gemini-cli, codex-cli) text-only — different serialization path', () => {
    expect(getProviderConfiguredCapabilityProfile('gemini-cli')?.multimodalSupport).toBe(
      'none',
    );
    expect(getProviderConfiguredCapabilityProfile('codex-cli')?.multimodalSupport).toBe(
      'none',
    );
  });

  it('returns null for unknown providers instead of inventing a native profile', () => {
    expect(getProviderConfiguredCapabilityProfile('unknown-provider')).toBeNull();
  });

  it('exposes the current MiniMax coding model lineup in snapshot metadata', () => {
    expect(getProviderModels('minimax-coding')).toEqual([
      'MiniMax-M2.7',
      'MiniMax-M2.7-highspeed',
      'MiniMax-M2.5',
      'MiniMax-M2.5-highspeed',
      'MiniMax-M2.1',
      'MiniMax-M2.1-highspeed',
      'MiniMax-M2',
    ]);

    expect(
      getProviderList().find((provider) => provider.name === 'minimax-coding')?.model,
    ).toBe('MiniMax-M2.7');
  });
});
