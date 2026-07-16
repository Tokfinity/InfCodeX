import { describe, expect, it } from 'vitest';

import { getModelInputCapabilities } from './capabilities.js';

describe('getModelInputCapabilities', () => {
  it('supports official OpenAI image input from provider-specific capability metadata', () => {
    const caps = getModelInputCapabilities({ provider: 'openai' });
    expect(caps.image.status).toBe('supported');
    expect(caps.image.sdkSupported).toBe(true);
    expect(caps.video.status).toBe('unsupported');
    expect(caps.file.status).toBe('unsupported');
  });

  it('supports documented Kimi model aliases without inferring gateway routes', () => {
    expect(getModelInputCapabilities({ provider: 'kimi', model: 'k2.6' }).image.status).toBe('supported');
    expect(getModelInputCapabilities({ provider: 'kimi', model: 'k2.7-code' }).image.status).toBe('supported');
    expect(getModelInputCapabilities({ provider: 'kimi', model: 'k2.7-code-highspeed' }).image.status).toBe('supported');
    expect(getModelInputCapabilities({ provider: 'kimi', model: 'kimi-k2.5' }).image.status).toBe('supported');
    expect(getModelInputCapabilities({ provider: 'ark-coding', model: 'kimi-k2.6' }).image.status).toBe('unsupported');
    expect(getModelInputCapabilities({ provider: 'kimi-code', model: 'k3' }).image.status).toBe('supported');
    expect(getModelInputCapabilities({ provider: 'kimi-code', model: 'k3' }).video.status).toBe('provider-native-unwired');
    expect(getModelInputCapabilities({ provider: 'kimi-code', model: 'kimi-for-coding-highspeed' }).image.status).toBe('supported');
  });

  it('supports only documented non-official image models, not nearby defaults', () => {
    const supported = getModelInputCapabilities({
      provider: 'minimax-coding',
      model: 'minimax-m3',
    });
    expect(supported.image.status).toBe('supported');
    expect(supported.video.status).toBe('provider-native-unwired');
    expect(supported.video.nativeSupported).toBe(true);
    expect(supported.video.sdkSupported).toBe(false);
    expect(supported.video.mediaTypes).toEqual([]);
    expect(supported.video.nativeMediaTypes).toContain('video/mp4');
    expect(supported.video.reason).toContain('not wired');
    expect(supported.file.maxCount).toBe(0);

    expect(getModelInputCapabilities({ provider: 'minimax-coding' }).image.status).toBe('unsupported');
    expect(getModelInputCapabilities({ provider: 'mimo-coding' }).image.status).toBe('unsupported');
    expect(getModelInputCapabilities({ provider: 'mimo-coding', model: 'mimo-v2.5' }).image.status).toBe('supported');
  });
});
