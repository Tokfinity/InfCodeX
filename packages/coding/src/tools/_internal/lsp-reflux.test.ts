import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KodaXToolExecutionContext } from '../../types.js';
import { appendLspDiagnostics } from './lsp-reflux.js';
import { toolWrite } from '../write.js';
import { toolEdit } from '../edit.js';

function ctxWith(lspService: unknown): KodaXToolExecutionContext {
  return { backups: new Map(), lspService } as unknown as KodaXToolExecutionContext;
}

describe('appendLspDiagnostics', () => {
  it('returns empty when no LSP service is wired', async () => {
    expect(await appendLspDiagnostics('/a.ts', ctxWith(undefined))).toBe('');
  });

  it('forwards the service block', async () => {
    const getDiagnosticsBlock = vi.fn(async () => '\n\nLSP errors detected in this file, please fix:\n<diagnostics/>');
    const block = await appendLspDiagnostics('/a.ts', ctxWith({ getDiagnosticsBlock }));
    expect(block).toContain('LSP errors detected');
    expect(getDiagnosticsBlock).toHaveBeenCalledWith('/a.ts', expect.objectContaining({ gitRoot: undefined }));
  });

  it('swallows a service failure (never fails the write)', async () => {
    const getDiagnosticsBlock = vi.fn(async () => {
      throw new Error('server crashed');
    });
    expect(await appendLspDiagnostics('/a.ts', ctxWith({ getDiagnosticsBlock }))).toBe('');
  });
});

describe('write tool reflux wiring', () => {
  let tempDir = '';
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-lsp-write-'));
  });
  afterEach(async () => {
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
    tempDir = '';
  });

  it('appends the injected diagnostics block to the write result', async () => {
    const filePath = path.join(tempDir, 'mod.ts');
    const getDiagnosticsBlock = vi.fn(async () => '\n\nLSP errors detected in this file, please fix:\n<diagnostics file="mod.ts">\nERROR [1:1] boom\n</diagnostics>');
    const ctx = {
      backups: new Map(),
      executionCwd: tempDir,
      lspService: { getDiagnosticsBlock },
    } as unknown as KodaXToolExecutionContext;

    const result = await toolWrite({ path: filePath, content: 'export const x: number = 1;\n' }, ctx);
    expect(result).toContain('File created');
    expect(result).toContain('ERROR [1:1] boom');
    expect(getDiagnosticsBlock).toHaveBeenCalledOnce();
  });

  it('does not append anything when no LSP service is present', async () => {
    const filePath = path.join(tempDir, 'mod.ts');
    const ctx = { backups: new Map(), executionCwd: tempDir } as unknown as KodaXToolExecutionContext;
    const result = await toolWrite({ path: filePath, content: 'const x = 1;\n' }, ctx);
    expect(result).not.toContain('LSP errors detected');
  });

  it('does not reflux diagnostics on a [Tool Error] result', async () => {
    const getDiagnosticsBlock = vi.fn(async () => '\n\nLSP errors detected in this file, please fix:\n<x/>');
    const ctx = {
      backups: new Map(),
      executionCwd: tempDir,
      lspService: { getDiagnosticsBlock },
    } as unknown as KodaXToolExecutionContext;
    // edit on a non-existent file → [Tool Error]; LSP must NOT be consulted.
    const result = await toolEdit({ path: path.join(tempDir, 'missing.ts'), old_string: 'a', new_string: 'b' }, ctx);
    expect(result).toContain('[Tool Error]');
    expect(getDiagnosticsBlock).not.toHaveBeenCalled();
  });
});
