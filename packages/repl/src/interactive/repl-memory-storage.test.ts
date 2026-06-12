import { describe, expect, it } from 'vitest';

interface MemorySessionStorageLike {
  save(
    id: string,
    data: {
      messages: Array<{ role: 'user' | 'assistant'; content: string }>;
      title: string;
      gitRoot: string;
      tag?: string;
    },
  ): Promise<void>;
  load(id: string): Promise<{ tag?: string } | null>;
  list(): Promise<Array<{ id: string; tag?: string }>>;
  fork?(
    id: string,
    selector?: string,
    options?: { sessionId?: string; title?: string },
  ): Promise<{ data: { tag?: string } } | null>;
}

type MemorySessionStorageConstructor = new () => MemorySessionStorageLike;

async function createInteractiveMemoryStorage(): Promise<MemorySessionStorageLike> {
  const mod = await import('./repl.js') as unknown as {
    MemorySessionStorage?: MemorySessionStorageConstructor;
  };
  const Storage = mod.MemorySessionStorage;
  expect(Storage).toBeDefined();
  if (!Storage) {
    throw new Error('MemorySessionStorage export is missing');
  }
  return new Storage();
}

describe('interactive MemorySessionStorage session tag', () => {
  it('preserves tag through save, load, list, and fork', async () => {
    const storage = await createInteractiveMemoryStorage();

    await storage.save('interactive-memory-source', {
      messages: [{ role: 'user', content: 'hello' }],
      title: 'Interactive Memory Source',
      gitRoot: '/repo',
      tag: 'partner',
    });

    const listed = await storage.list();
    const forked = await storage.fork?.('interactive-memory-source', undefined, {
      sessionId: 'interactive-memory-fork',
      title: 'Interactive Memory Fork',
    });
    const loadedFork = await storage.load('interactive-memory-fork');

    expect(listed.find((session) => session.id === 'interactive-memory-source')?.tag).toBe('partner');
    expect(forked?.data.tag).toBe('partner');
    expect(loadedFork?.tag).toBe('partner');
  });
});
