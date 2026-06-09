import { describe, expect, it, vi } from 'vitest';
import type { KodaXToolExecutionContext } from '../types.js';
import {
  toolLspDefinition,
  toolLspHover,
  toolLspReferences,
  toolLspDocumentSymbols,
} from './lsp-navigation.js';
import { getBuiltinToolDefinition } from './registry.js';

function ctx(lspService?: unknown): KodaXToolExecutionContext {
  return { backups: new Map(), executionCwd: '/proj', lspService } as unknown as KodaXToolExecutionContext;
}

describe('lsp navigation tools', () => {
  it('return a clear message when no LSP service is wired', async () => {
    expect(await toolLspDefinition({ path: 'a.ts', line: 1 }, ctx(undefined))).toContain('LSP is unavailable');
    expect(await toolLspDocumentSymbols({ path: 'a.ts' }, ctx(undefined))).toContain('LSP is unavailable');
  });

  it('validate the required 1-based line', async () => {
    const getDefinition = vi.fn();
    const result = await toolLspDefinition({ path: 'a.ts' }, ctx({ getDefinition }));
    expect(result).toContain('[Tool Error]');
    expect(getDefinition).not.toHaveBeenCalled();
  });

  it('convert 1-based line/column to a 0-based LSP position', async () => {
    const getDefinition = vi.fn(async () => 'a.ts:3:5');
    await toolLspDefinition({ path: 'a.ts', line: 3, character: 5 }, ctx({ getDefinition }));
    expect(getDefinition).toHaveBeenCalledWith(
      expect.stringContaining('a.ts'),
      { line: 2, character: 4 },
      expect.anything(),
    );
  });

  it('default the column to the line start (0-based 0)', async () => {
    const getHover = vi.fn(async () => 'const x: number');
    await toolLspHover({ path: 'a.ts', line: 7 }, ctx({ getHover }));
    expect(getHover).toHaveBeenCalledWith(expect.any(String), { line: 6, character: 0 }, expect.anything());
  });

  it('hover / references / document_symbols delegate to the service', async () => {
    const service = {
      getHover: vi.fn(async () => 'const x: number'),
      getReferences: vi.fn(async () => 'a.ts:1:1\na.ts:3:1'),
      getDocumentSymbols: vi.fn(async () => 'Class Foo (1)'),
    };
    expect(await toolLspHover({ path: 'a.ts', line: 1 }, ctx(service))).toBe('const x: number');
    expect(await toolLspReferences({ path: 'a.ts', line: 1 }, ctx(service))).toContain('a.ts:3:1');
    expect(await toolLspDocumentSymbols({ path: 'a.ts' }, ctx(service))).toBe('Class Foo (1)');
  });

  it('are registered as readonly builtins', () => {
    for (const name of ['lsp_definition', 'lsp_hover', 'lsp_references', 'lsp_document_symbols']) {
      const def = getBuiltinToolDefinition(name);
      expect(def, name).toBeDefined();
      expect(def?.sideEffect).toBe('readonly');
    }
  });
});
