/**
 * v0.7.43 — session-snapshot middleware tests focused on the
 * "caller supplied session.id but forgot storage" trap. KodaX Space
 * embedder hit this — silent no-op meant runs completed successfully
 * but ~/.kodax/sessions/<id>.jsonl never appeared.
 *
 * The middleware adds a one-shot console.warn keyed by session.id
 * so the same id firing terminal save multiple times only warns
 * once, but legitimately new runs (different ids) each get their
 * own onboarding warning.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { KodaXOptions } from '../../types.js';
import { saveSessionSnapshot } from './session-snapshot.js';

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

const minimalData = {
  messages: [{ role: 'user' as const, content: 'hi' }],
  title: 'test',
  gitRoot: '/repo',
};

describe('saveSessionSnapshot — silent no-op when no storage', () => {
  it('returns early without throwing when options.session is undefined', async () => {
    const opts = { provider: 'anthropic' } as KodaXOptions;
    await expect(saveSessionSnapshot(opts, 'sess-1', minimalData)).resolves.toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does NOT warn when only id is missing — no embedder mistake to signal', async () => {
    const opts = { provider: 'anthropic', session: {} } as unknown as KodaXOptions;
    await saveSessionSnapshot(opts, 'sess-2', minimalData);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('saveSessionSnapshot — v0.7.43 console.warn for id-without-storage trap', () => {
  it('warns once when session.id is set but storage is undefined', async () => {
    const opts = {
      provider: 'anthropic',
      session: { id: `sdk-trap-warn-${Date.now()}-1` },
    } as KodaXOptions;
    await saveSessionSnapshot(opts, opts.session!.id!, minimalData);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = warnSpy.mock.calls[0]?.[0] as string;
    expect(msg).toContain('[KodaX SDK]');
    expect(msg).toContain('session.storage is undefined');
    expect(msg).toContain('createSessionManager');
    expect(msg).toContain('SDK_EMBEDDER_GUIDE.md');
  });

  it('does not double-warn for the same session id across multiple terminal sites', async () => {
    const id = `sdk-trap-warn-${Date.now()}-2`;
    const opts = { provider: 'anthropic', session: { id } } as KodaXOptions;
    // SA loop calls saveSessionSnapshot at 4 sites (mid-flow / success /
    // error / limit). They all hit the same id — only the first should warn.
    await saveSessionSnapshot(opts, id, minimalData);
    await saveSessionSnapshot(opts, id, minimalData);
    await saveSessionSnapshot(opts, id, minimalData);
    await saveSessionSnapshot(opts, id, minimalData);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('warns separately for distinct session ids', async () => {
    const id1 = `sdk-trap-warn-${Date.now()}-3a`;
    const id2 = `sdk-trap-warn-${Date.now()}-3b`;
    await saveSessionSnapshot(
      { provider: 'anthropic', session: { id: id1 } } as KodaXOptions,
      id1,
      minimalData,
    );
    await saveSessionSnapshot(
      { provider: 'anthropic', session: { id: id2 } } as KodaXOptions,
      id2,
      minimalData,
    );
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });
});

describe('saveSessionSnapshot — happy path with storage', () => {
  it('calls storage.save and does NOT emit the embedder warning', async () => {
    const saveMock = vi.fn().mockResolvedValue(undefined);
    const opts = {
      provider: 'anthropic',
      session: {
        id: `sdk-happy-${Date.now()}`,
        scope: 'user' as const,
        storage: { save: saveMock } as never,
      },
    } as unknown as KodaXOptions;
    await saveSessionSnapshot(opts, opts.session!.id!, minimalData);
    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // FEATURE_173 dual-writer fix — persistedByHost ownership gate.
  it('persistedByHost: skips ROUTINE save (host owns persistence)', async () => {
    const saveMock = vi.fn().mockResolvedValue(undefined);
    const opts = {
      provider: 'anthropic',
      session: {
        id: `host-routine-${Date.now()}`,
        scope: 'user' as const,
        storage: { save: saveMock } as never,
        persistedByHost: true,
      },
    } as unknown as KodaXOptions;
    await saveSessionSnapshot(opts, opts.session!.id!, minimalData);
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('persistedByHost: STILL persists error-recovery save (carries errorMetadata)', async () => {
    const saveMock = vi.fn().mockResolvedValue(undefined);
    const opts = {
      provider: 'anthropic',
      session: {
        id: `host-error-${Date.now()}`,
        scope: 'user' as const,
        storage: { save: saveMock } as never,
        persistedByHost: true,
      },
    } as unknown as KodaXOptions;
    await saveSessionSnapshot(opts, opts.session!.id!, {
      ...minimalData,
      errorMetadata: { lastError: 'boom', lastErrorTime: 1, consecutiveErrors: 1 },
    });
    expect(saveMock).toHaveBeenCalledTimes(1);
  });

  it('absorbs storage.save errors via console.error (does NOT throw to caller)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const saveMock = vi.fn().mockRejectedValue(new Error('disk full'));
    const opts = {
      provider: 'anthropic',
      session: {
        id: `sdk-err-${Date.now()}`,
        storage: { save: saveMock } as never,
      },
    } as unknown as KodaXOptions;
    await expect(saveSessionSnapshot(opts, opts.session!.id!, minimalData)).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
    expect(errSpy.mock.calls[0]?.[0]).toContain('[SessionSnapshot]');
    errSpy.mockRestore();
  });
});
