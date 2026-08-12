import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(() => ({})),
}));

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  spawn: spawnMock,
}));

const { spawnLspProcess } = await import('./spawn.js');

describe('spawnLspProcess background options', () => {
  beforeEach(() => {
    spawnMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('hides native language-server windows in GUI hosts', () => {
    spawnLspProcess('language-server.exe', ['--stdio'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: false,
    });

    expect(spawnMock).toHaveBeenCalledWith(
      'language-server.exe',
      ['--stdio'],
      expect.objectContaining({
        shell: false,
        windowsHide: true,
      }),
    );
  });

  it('hides Windows command-shim language servers', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

    spawnLspProcess('C:\\Program Files\\server.cmd', ['--stdio'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: false,
    });

    expect(spawnMock).toHaveBeenCalledWith(
      '"C:\\Program Files\\server.cmd" --stdio',
      expect.objectContaining({
        shell: true,
        windowsHide: true,
      }),
    );
  });

  it('hides the internal Node or Electron language-server process', () => {
    spawnLspProcess(process.execPath, ['server.mjs', '--stdio'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: false,
    });

    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      ['server.mjs', '--stdio'],
      expect.objectContaining({
        env: expect.not.objectContaining({ ELECTRON_RUN_AS_NODE: '1' }),
        shell: false,
        windowsHide: true,
      }),
    );
  });

  it('runs JavaScript language servers through Bun mode in a standalone executable', () => {
    vi.stubEnv('KODAX_BUNDLED', 'true');

    spawnLspProcess(process.execPath, ['server.mjs', '--stdio'], {
      env: { KODAX_SENTINEL: 'preserved' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      ['server.mjs', '--stdio'],
      expect.objectContaining({
        env: expect.objectContaining({
          BUN_BE_BUN: '1',
          KODAX_SENTINEL: 'preserved',
        }),
        shell: false,
        windowsHide: true,
      }),
    );
  });
});
