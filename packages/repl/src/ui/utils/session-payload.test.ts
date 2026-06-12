import { describe, expect, it } from 'vitest';

import { buildHostSessionPayload } from './session-payload.js';

describe('buildHostSessionPayload', () => {
  it('carries the session tag into host-owned persistence payloads', () => {
    const payload = buildHostSessionPayload({
      messages: [{ role: 'user', content: 'partner request' }],
      title: 'Partner Session',
      gitRoot: '/repo',
      tag: 'partner',
    });

    expect(payload.tag).toBe('partner');
  });

  it('treats an empty string tag as a real tag', () => {
    const payload = buildHostSessionPayload({
      messages: [{ role: 'user', content: 'empty tag request' }],
      title: 'Empty Tag Session',
      gitRoot: '/repo',
      tag: '',
    });

    expect(payload).toHaveProperty('tag', '');
  });
});
