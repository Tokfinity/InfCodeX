import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { LSP_SERVERS, serversForLanguage } from './servers.js';
import { runInstallCommand } from './acquirer.js';
import { LANGUAGE_EXTENSIONS } from './language.js';

describe('LSP server registry', () => {
  it('registers all five languages', () => {
    expect([...LSP_SERVERS.map((s) => s.id)].sort()).toEqual([
      'gopls',
      'jdtls',
      'pyright',
      'rust-analyzer',
      'typescript',
    ]);
  });

  it('maps languageIds to the right servers', () => {
    expect(serversForLanguage('typescript').map((s) => s.id)).toEqual(['typescript']);
    expect(serversForLanguage('javascriptreact').map((s) => s.id)).toEqual(['typescript']);
    expect(serversForLanguage('python').map((s) => s.id)).toEqual(['pyright']);
    expect(serversForLanguage('go').map((s) => s.id)).toEqual(['gopls']);
    expect(serversForLanguage('rust').map((s) => s.id)).toEqual(['rust-analyzer']);
    expect(serversForLanguage('java').map((s) => s.id)).toEqual(['jdtls']);
    expect(serversForLanguage('ruby')).toEqual([]);
  });

  it('every server has root markers + actionable install guidance', () => {
    for (const server of LSP_SERVERS) {
      expect(server.rootMarkers.length).toBeGreaterThan(0);
      expect(server.installGuidance.length).toBeGreaterThan(10);
    }
  });

  it('discovery returns undefined or a well-formed launch (never throws)', () => {
    const bogusRoot = path.join(os.tmpdir(), 'kodax-no-such-proj');
    for (const server of LSP_SERVERS) {
      const launch = server.discover({ root: bogusRoot, moduleUrl: import.meta.url });
      if (launch !== undefined) {
        expect(typeof launch.command).toBe('string');
        expect(Array.isArray(launch.args)).toBe(true);
      }
    }
  });

  it('only gopls exposes an opt-in acquire (the Go-toolchain cheap acquirer)', () => {
    const withAcquire = LSP_SERVERS.filter((s) => typeof s.acquire === 'function').map((s) => s.id);
    expect(withAcquire).toEqual(['gopls']);
  });

  it('drift guard: every server languageId is reachable from the extension map', () => {
    // If a server serves a languageId no extension maps to, it can never be
    // triggered by an edit — catch that mismatch here.
    const mappedLanguageIds = new Set(Object.values(LANGUAGE_EXTENSIONS));
    for (const server of LSP_SERVERS) {
      for (const languageId of server.languageIds) {
        expect(mappedLanguageIds.has(languageId), `${server.id} serves unmapped languageId "${languageId}"`).toBe(true);
      }
    }
  });
});

describe('runInstallCommand', () => {
  it('resolves true on a clean exit', async () => {
    // Bare `node` (on PATH wherever vitest runs) — avoids the spaces-in-path
    // pitfall of process.execPath under the Windows shell.
    expect(await runInstallCommand({ command: 'node', args: ['--version'] })).toBe(true);
  });

  it('resolves false when the command cannot start', async () => {
    expect(await runInstallCommand({ command: 'kodax-nonexistent-cmd-xyz', args: [] })).toBe(false);
  });
});
