/**
 * FEATURE_116 (v0.7.37) Phase 1.3 — KodaXAcpProvider strip tests.
 *
 * Symmetric with openai-cache-control.test.ts — ACP CLI bridge subprocess
 * never sees KodaX-internal cache-boundary markers.
 */

import { describe, expect, it } from 'vitest';
import { KodaXAcpProvider } from './acp-base.js';
import type {
  AcpClientOptions,
} from '../cli-events/acp-client.js';
import type {
  KodaXMessage,
  KodaXProviderConfig,
} from '../types.js';

class TestAcpProvider extends KodaXAcpProvider {
  readonly name = 'test-acp';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'NONE',
    model: 'test-cli',
    reasoningCapability: 'prompt-only',
    models: [{ id: 'test-cli' }],
    contextWindow: 64_000,
    supportsThinking: false,
  };
  protected readonly acpClientOptions: AcpClientOptions = {} as AcpClientOptions;

  public exposedStripCacheBoundariesFromMessages(messages: KodaXMessage[]) {
    return this.stripCacheBoundariesFromMessages(messages);
  }
}

describe('KodaXAcpProvider.stripCacheBoundariesFromMessages', () => {
  it('strips boundary markers from array-content messages', () => {
    const provider = new TestAcpProvider();
    const messages: KodaXMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'cache-boundary' },
        ],
      },
    ];
    const result = provider.exposedStripCacheBoundariesFromMessages(messages);
    expect(result[0]!.content).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('preserves identity when no boundaries present', () => {
    const provider = new TestAcpProvider();
    const messages: KodaXMessage[] = [
      { role: 'user', content: 'plain' },
    ];
    const result = provider.exposedStripCacheBoundariesFromMessages(messages);
    expect(result[0]).toBe(messages[0]);
  });
});
