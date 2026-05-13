import { describe, expect, it, vi } from 'vitest';
import { KodaXCodexCliProvider } from './codex-cli.js';
import { KodaXGeminiCliProvider } from './gemini-cli.js';

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

const EXPECTED_IMAGE_INPUT_CLI_BRIDGE_PROFILE = {
  ...EXPECTED_CLI_BRIDGE_PROFILE,
  multimodalSupport: 'image-input',
} as const;

describe('CLI bridge providers', () => {
  it('exposes Gemini CLI as an always-configured bridge provider with image-input capability (FEATURE_134)', () => {
    const provider = new KodaXGeminiCliProvider();

    expect(provider.name).toBe('gemini-cli');
    expect(provider.supportsThinking).toBe(false);
    expect(provider.isConfigured()).toBe(true);
    expect(provider.getAvailableModels()).toContain(provider.getModel());
    expect(provider.getCapabilityProfile()).toEqual(EXPECTED_IMAGE_INPUT_CLI_BRIDGE_PROFILE);

    provider.disconnect();
  });

  it('translates KodaXImageBlock to Gemini CLI `@<path>` token (FEATURE_134)', () => {
    const provider = new KodaXGeminiCliProvider();
    // Reach the protected method via cast — narrow surface, single
    // override point; test pins the exact wire format Gemini CLI expects.
    const token = (provider as unknown as {
      serializeImageBlockToPromptToken: (b: { type: 'image'; path: string }) => string | null;
    }).serializeImageBlockToPromptToken({
      type: 'image',
      path: '/tmp/kodax-paste/paste-abc123.png',
    });
    expect(token).toBe('@/tmp/kodax-paste/paste-abc123.png');
    provider.disconnect();
  });

  it('drops Gemini-CLI image block with whitespace in path rather than emit a broken @<path> token (FEATURE_134)', () => {
    const provider = new KodaXGeminiCliProvider();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const token = (provider as unknown as {
      serializeImageBlockToPromptToken: (b: { type: 'image'; path: string }) => string | null;
    }).serializeImageBlockToPromptToken({
      type: 'image',
      path: '/home/user/My Documents/paste.png',
    });
    expect(token).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('contains whitespace'),
    );
    warnSpy.mockRestore();
    provider.disconnect();
  });

  it('exposes Codex CLI as an always-configured bridge provider (no image input — codex exec --json mode is text-only)', () => {
    const provider = new KodaXCodexCliProvider();

    expect(provider.name).toBe('codex-cli');
    expect(provider.supportsThinking).toBe(false);
    expect(provider.isConfigured()).toBe(true);
    expect(provider.getAvailableModels()).toContain(provider.getModel());
    expect(provider.getCapabilityProfile()).toEqual(EXPECTED_CLI_BRIDGE_PROFILE);

    // Default base-class behavior: image block dropped silently (returns null).
    const token = (provider as unknown as {
      serializeImageBlockToPromptToken: (b: { type: 'image'; path: string }) => string | null;
    }).serializeImageBlockToPromptToken({
      type: 'image',
      path: '/tmp/kodax-paste/paste-xyz.png',
    });
    expect(token).toBeNull();

    provider.disconnect();
  });
});
