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

  it('carries extension session state and records into host-owned persistence payloads', () => {
    const payload = buildHostSessionPayload({
      messages: [{ role: 'user', content: 'extension request' }],
      title: 'Extension Session',
      gitRoot: '/repo',
      extensionState: { 'ext:sample': { visits: 2 } },
      extensionRecords: [
        {
          id: 'record-1',
          extensionId: 'ext:sample',
          type: 'turn',
          ts: 1,
          data: { ok: true },
        },
      ],
    });

    expect(payload.extensionState).toEqual({ 'ext:sample': { visits: 2 } });
    expect(payload.extensionRecords).toEqual([
      expect.objectContaining({
        id: 'record-1',
        extensionId: 'ext:sample',
        type: 'turn',
      }),
    ]);
  });
});
