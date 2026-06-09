import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLspClient } from './client.js';
import { LspService } from './service.js';
import type { LspServerInfo } from './servers.js';

const FIXTURE = fileURLToPath(new URL('./fake-lsp-server.fixture.mjs', import.meta.url));

describe('LSP protocol integration (real stdio handshake)', () => {
  let tempDir = '';
  let tsFile = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-lsp-int-'));
    tsFile = path.join(tempDir, 'mod.ts');
    await fs.writeFile(tsFile, 'export const x: number = "oops";\n', 'utf8');
  });
  afterEach(async () => {
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
    tempDir = '';
  });

  it('initializes, opens a document, and receives published diagnostics', async () => {
    const client = await createLspClient({
      serverId: 'fake',
      root: tempDir,
      launch: { command: process.execPath, args: [FIXTURE] },
    });
    try {
      await client.notifyOpenOrChange(tsFile);
      await client.waitForDiagnostics(tsFile, { afterMs: 0, timeoutMs: 4000 });
      const diagnostics = client.diagnostics(tsFile);
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].message).toBe('fake type error');
      expect(diagnostics[0].severity).toBe(1);
    } finally {
      await client.shutdown();
    }
  }, 15000);

  it('end-to-end: LspService.getDiagnosticsBlock against a real server process', async () => {
    const server: LspServerInfo = {
      id: 'fake',
      languageIds: ['typescript'],
      rootMarkers: ['package.json', '.git'],
      discover: () => ({ command: process.execPath, args: [FIXTURE] }),
      installGuidance: 'n/a',
    };
    const service = new LspService({ servers: [server], documentTimeoutMs: 4000 });
    try {
      const block = await service.getDiagnosticsBlock(tsFile, { gitRoot: tempDir });
      expect(block).toContain('LSP errors detected in this file');
      expect(block).toContain('ERROR [1:1] fake type error');
    } finally {
      await service.shutdownAll();
    }
  }, 15000);

  it('reports a fresh diagnostic after a second change (didChange path)', async () => {
    const client = await createLspClient({
      serverId: 'fake',
      root: tempDir,
      launch: { command: process.execPath, args: [FIXTURE] },
    });
    try {
      await client.notifyOpenOrChange(tsFile); // didOpen
      await client.waitForDiagnostics(tsFile, { afterMs: 0, timeoutMs: 4000 });
      const second = Date.now();
      await client.notifyOpenOrChange(tsFile); // didChange
      await client.waitForDiagnostics(tsFile, { afterMs: second, timeoutMs: 4000 });
      expect(client.diagnostics(tsFile)).toHaveLength(1);
    } finally {
      await client.shutdown();
    }
  }, 15000);
});
