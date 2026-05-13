import { describe, expect, it } from 'vitest';
import { buildCLIPrompt } from './prompt-utils.js';
import type { KodaXContentBlock, KodaXMessage } from '../types.js';

describe('buildCLIPrompt', () => {
  it('flattens string and text-block messages when building a fresh CLI prompt', () => {
    const messages: KodaXMessage[] = [
      { role: 'system', content: 'ignored system wrapper' as unknown as KodaXMessage['content'] },
      { role: 'user', content: 'first prompt' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'assistant reply' },
          { type: 'tool_use', id: 'tool-1', name: 'read', input: {} },
        ] satisfies KodaXContentBlock[],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'follow-up' },
          { type: 'text', text: 'with extra context' },
        ] satisfies KodaXContentBlock[],
      },
    ];

    expect(buildCLIPrompt(messages, false)).toBe(
      [
        'ignored system wrapper',
        'first prompt',
        'assistant reply',
        'follow-up\nwith extra context',
      ].join('\n\n'),
    );
  });

  it('sends only the latest message content when resuming an existing CLI session', () => {
    const messages: KodaXMessage[] = [
      { role: 'user', content: 'old prompt' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'latest prompt' },
          { type: 'text', text: 'second line' },
        ] satisfies KodaXContentBlock[],
      },
    ];

    expect(buildCLIPrompt(messages, true)).toBe('latest prompt\nsecond line');
  });

  it('returns an empty string when the latest resumed message has no text blocks', () => {
    const messages: KodaXMessage[] = [
      { role: 'user', content: 'old prompt' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'done' },
        ] satisfies KodaXContentBlock[],
      },
    ];

    expect(buildCLIPrompt(messages, true)).toBe('');
  });
});
