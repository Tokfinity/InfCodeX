import { describe, expect, it } from 'vitest';

import { MemorySessionStorage } from './session-storage.js';

describe('MemorySessionStorage session tag', () => {
  it('preserves tag through save, load, and list', async () => {
    const storage = new MemorySessionStorage();

    await storage.save('memory-tagged', {
      messages: [{ role: 'user', content: 'hello' }],
      title: 'Memory Tagged',
      gitRoot: '/repo',
      tag: 'partner',
    });

    const loaded = await storage.load('memory-tagged');
    const listed = await storage.list();

    expect(loaded?.tag).toBe('partner');
    expect(listed.find((session) => session.id === 'memory-tagged')?.tag).toBe('partner');
  });

  it('keeps an existing tag when a later save omits it', async () => {
    const storage = new MemorySessionStorage();

    await storage.save('memory-partial', {
      messages: [{ role: 'user', content: 'hello' }],
      title: 'Memory Partial',
      gitRoot: '/repo',
      tag: 'partner',
    });
    await storage.save('memory-partial', {
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'reply' },
      ],
      title: 'Memory Partial Updated',
      gitRoot: '/repo',
    });

    const loaded = await storage.load('memory-partial');

    expect(loaded?.tag).toBe('partner');
  });

  it('copies tag to forked sessions', async () => {
    const storage = new MemorySessionStorage();

    await storage.save('memory-fork-source', {
      messages: [{ role: 'user', content: 'hello' }],
      title: 'Memory Fork Source',
      gitRoot: '/repo',
      tag: 'partner',
    });

    const forked = await storage.fork?.('memory-fork-source', undefined, {
      sessionId: 'memory-fork-copy',
      title: 'Forked Memory',
    });
    const loadedFork = await storage.load('memory-fork-copy');

    expect(forked?.data.tag).toBe('partner');
    expect(loadedFork?.tag).toBe('partner');
  });
});
