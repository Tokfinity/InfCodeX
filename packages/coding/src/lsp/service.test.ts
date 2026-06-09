import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import type { Diagnostic } from 'vscode-languageserver-protocol';
import { LspService } from './service.js';
import type { LspClient } from './client.js';
import type { LspServerInfo } from './servers.js';

function err(line: number, message: string): Diagnostic {
  return {
    severity: 1,
    range: { start: { line, character: 0 }, end: { line, character: 1 } },
    message,
  };
}

function fakeClient(diagnostics: readonly Diagnostic[]): LspClient {
  return {
    serverId: 'fake',
    root: '/r',
    notifyOpenOrChange: vi.fn(async () => 0),
    waitForDiagnostics: vi.fn(async () => undefined),
    diagnostics: () => diagnostics,
    shutdown: vi.fn(async () => undefined),
    killSync: vi.fn(() => undefined),
  };
}

function fakeServer(overrides: Partial<LspServerInfo> = {}): LspServerInfo {
  return {
    id: 'fake',
    languageIds: ['typescript'],
    rootMarkers: ['package.json', '.git'],
    discover: () => ({ command: 'noop', args: [] }),
    installGuidance: 'install fake-server',
    ...overrides,
  };
}

const ROOT = path.join(os.tmpdir(), 'kodax-lsp-svc');
const TS_FILE = path.join(ROOT, 'src', 'mod.ts');

describe('LspService.getDiagnosticsBlock', () => {
  it('returns empty for a language with no server', async () => {
    const service = new LspService({ servers: [fakeServer()] });
    expect(await service.getDiagnosticsBlock(path.join(ROOT, 'note.txt'), { gitRoot: ROOT })).toBe('');
  });

  it('refluxes an error block when the server reports errors', async () => {
    const service = new LspService({
      servers: [fakeServer()],
      createClient: async () => fakeClient([err(2, "Type 'string' is not assignable to 'number'")]),
    });
    const block = await service.getDiagnosticsBlock(TS_FILE, { gitRoot: ROOT });
    expect(block).toContain('LSP errors detected in this file');
    expect(block).toContain("ERROR [3:1] Type 'string' is not assignable to 'number'");
  });

  it('returns empty when the server reports no errors', async () => {
    const service = new LspService({
      servers: [fakeServer()],
      createClient: async () => fakeClient([]),
    });
    expect(await service.getDiagnosticsBlock(TS_FILE, { gitRoot: ROOT })).toBe('');
  });

  it('blacklists an uninstalled server and never re-probes it', async () => {
    const discover = vi.fn(() => undefined);
    const service = new LspService({ servers: [fakeServer({ discover })] });
    expect(await service.getDiagnosticsBlock(TS_FILE, { gitRoot: ROOT })).toBe('');
    expect(await service.getDiagnosticsBlock(TS_FILE, { gitRoot: ROOT })).toBe('');
    expect(discover).toHaveBeenCalledTimes(1);
  });

  it('spawns a client once and reuses it across edits', async () => {
    const createClient = vi.fn(async () => fakeClient([err(0, 'boom')]));
    const service = new LspService({ servers: [fakeServer()], createClient });
    await service.getDiagnosticsBlock(TS_FILE, { gitRoot: ROOT });
    await service.getDiagnosticsBlock(TS_FILE, { gitRoot: ROOT });
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it('does not double-spawn under concurrent edits (spawning dedup)', async () => {
    const createClient = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return fakeClient([err(0, 'boom')]);
    });
    const service = new LspService({ servers: [fakeServer()], createClient });
    await Promise.all([
      service.getDiagnosticsBlock(TS_FILE, { gitRoot: ROOT }),
      service.getDiagnosticsBlock(TS_FILE, { gitRoot: ROOT }),
    ]);
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it('short-circuits on an aborted signal', async () => {
    const createClient = vi.fn(async () => fakeClient([err(0, 'boom')]));
    const service = new LspService({ servers: [fakeServer()], createClient });
    const block = await service.getDiagnosticsBlock(TS_FILE, {
      gitRoot: ROOT,
      signal: AbortSignal.abort(),
    });
    expect(block).toBe('');
    expect(createClient).not.toHaveBeenCalled();
  });

  it('shutdownAll disposes spawned clients', async () => {
    const client = fakeClient([err(0, 'boom')]);
    const service = new LspService({ servers: [fakeServer()], createClient: async () => client });
    await service.getDiagnosticsBlock(TS_FILE, { gitRoot: ROOT });
    await service.shutdownAll();
    expect(client.shutdown).toHaveBeenCalledTimes(1);
  });

  it('resetBroken lets a previously-uninstalled server be retried', async () => {
    const discover = vi.fn(() => undefined);
    const service = new LspService({ servers: [fakeServer({ discover })] });
    await service.getDiagnosticsBlock(TS_FILE, { gitRoot: ROOT });
    expect(discover).toHaveBeenCalledTimes(1);
    service.resetBroken();
    await service.getDiagnosticsBlock(TS_FILE, { gitRoot: ROOT });
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it('killAllSync kills every spawned client', async () => {
    const client = fakeClient([err(0, 'boom')]);
    const service = new LspService({ servers: [fakeServer()], createClient: async () => client });
    await service.getDiagnosticsBlock(TS_FILE, { gitRoot: ROOT });
    service.killAllSync();
    expect(client.killSync).toHaveBeenCalledTimes(1);
  });

  it('does NOT auto-install when KODAX_LSP_DOWNLOAD is unset', async () => {
    const acquire = vi.fn(async () => ({ command: 'noop', args: [] as string[] }));
    const service = new LspService({
      servers: [fakeServer({ discover: () => undefined, acquire })],
      createClient: async () => fakeClient([err(0, 'x')]),
    });
    expect(await service.getDiagnosticsBlock(TS_FILE, { gitRoot: ROOT })).toBe('');
    expect(acquire).not.toHaveBeenCalled();
  });

  it('auto-installs (opt-in) when KODAX_LSP_DOWNLOAD=1 and discovery fails', async () => {
    const prev = process.env.KODAX_LSP_DOWNLOAD;
    process.env.KODAX_LSP_DOWNLOAD = '1';
    try {
      const acquire = vi.fn(async () => ({ command: 'noop', args: [] as string[] }));
      const service = new LspService({
        servers: [fakeServer({ discover: () => undefined, acquire })],
        createClient: async () => fakeClient([err(0, 'boom')]),
      });
      const block = await service.getDiagnosticsBlock(TS_FILE, { gitRoot: ROOT });
      expect(acquire).toHaveBeenCalledTimes(1);
      expect(block).toContain('boom');
    } finally {
      if (prev === undefined) delete process.env.KODAX_LSP_DOWNLOAD;
      else process.env.KODAX_LSP_DOWNLOAD = prev;
    }
  });
});
