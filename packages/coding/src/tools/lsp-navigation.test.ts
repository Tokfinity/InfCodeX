import { describe, expect, it, vi } from 'vitest';
import type { KodaXToolExecutionContext } from '../types.js';
import {
  toolLspDefinition,
  toolLspHover,
  toolLspReferences,
  toolLspDocumentSymbols,
  toolLspWorkspaceSymbols,
  toolLspImplementation,
  toolLspPrepareCallHierarchy,
  toolLspIncomingCalls,
  toolLspOutgoingCalls,
} from './lsp-navigation.js';
import { getBuiltinToolDefinition } from './registry.js';

function ctx(lspService?: unknown): KodaXToolExecutionContext {
  return { backups: new Map(), executionCwd: '/proj', lspService } as unknown as KodaXToolExecutionContext;
}

describe('lsp navigation tools', () => {
  it('return a clear message when no LSP service is wired', async () => {
    const results = [
      await toolLspDefinition({ path: 'a.ts', line: 1 }, ctx(undefined)),
      await toolLspHover({ path: 'a.ts', line: 1 }, ctx(undefined)),
      await toolLspReferences({ path: 'a.ts', line: 1 }, ctx(undefined)),
      await toolLspDocumentSymbols({ path: 'a.ts' }, ctx(undefined)),
      await toolLspWorkspaceSymbols({ query: 'Foo' }, ctx(undefined)),
      await toolLspImplementation({ path: 'a.ts', line: 1 }, ctx(undefined)),
      await toolLspPrepareCallHierarchy({ path: 'a.ts', line: 1 }, ctx(undefined)),
      await toolLspIncomingCalls({ path: 'a.ts', line: 1 }, ctx(undefined)),
      await toolLspOutgoingCalls({ path: 'a.ts', line: 1 }, ctx(undefined)),
    ];
    for (const result of results) {
      expect(result).toContain('LSP is unavailable');
    }
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

  it('accepts column as an alias for character', async () => {
    const getImplementation = vi.fn(async () => 'a.ts:3:5');
    await toolLspImplementation({ path: 'a.ts', line: 3, column: 5 }, ctx({ getImplementation }));
    expect(getImplementation).toHaveBeenCalledWith(
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

  it('workspace symbols and call hierarchy tools delegate to the service', async () => {
    const service = {
      getWorkspaceSymbols: vi.fn(async () => 'Function run /proj/a.ts:1:1'),
      getPrepareCallHierarchy: vi.fn(async () => 'Function run /proj/a.ts:1:1'),
      getIncomingCalls: vi.fn(async () => 'Function main /proj/main.ts:2:3 calls at 2:3'),
      getOutgoingCalls: vi.fn(async () => 'Function save /proj/store.ts:4:5 called at 3:9'),
    };
    expect(await toolLspWorkspaceSymbols({ query: 'run' }, ctx(service))).toContain('Function run');
    expect(await toolLspPrepareCallHierarchy({ path: 'a.ts', line: 1 }, ctx(service))).toContain('Function run');
    expect(await toolLspIncomingCalls({ path: 'a.ts', line: 1 }, ctx(service))).toContain('calls at');
    expect(await toolLspOutgoingCalls({ path: 'a.ts', line: 1 }, ctx(service))).toContain('called at');
  });

  it('are registered as readonly builtins', () => {
    for (const name of [
      'lsp_definition',
      'lsp_hover',
      'lsp_references',
      'lsp_document_symbols',
      'lsp_workspace_symbols',
      'lsp_implementation',
      'lsp_prepare_call_hierarchy',
      'lsp_incoming_calls',
      'lsp_outgoing_calls',
    ]) {
      const def = getBuiltinToolDefinition(name);
      expect(def, name).toBeDefined();
      expect(def?.sideEffect).toBe('readonly');
    }
  });
});
