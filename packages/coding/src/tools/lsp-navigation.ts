/**
 * FEATURE_132 Phase E — read-only LSP navigation tools.
 *
 * `lsp_definition` / `lsp_hover` / `lsp_references` / `lsp_document_symbols`
 * answer precise, real-time, single-point questions about the CURRENT code
 * (the symbol under a given line/column) via the language server. They
 * complement the repo-intelligence symbol tools, which give batch, repo-scope
 * structure. Positions are 1-based in the tool surface (the line/col the agent
 * reads in a file), converted to LSP's 0-based positions internally.
 */

import type { Position } from 'vscode-languageserver-protocol';
import type { KodaXToolExecutionContext } from '../types.js';
import { resolveExecutionPath } from '../runtime-paths.js';

const NO_SERVICE = 'LSP is unavailable (disabled via KODAX_LSP=0, or no service wired).';

function navRequest(ctx: KodaXToolExecutionContext): {
  gitRoot?: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
} {
  return { gitRoot: ctx.gitRoot, signal: ctx.abortSignal, onProgress: ctx.reportToolProgress };
}

/** Convert 1-based tool input (line, optional character/column) to a 0-based LSP Position. */
function toPosition(input: Record<string, unknown>): Position | string {
  const line = Number(input.line);
  if (!Number.isInteger(line) || line < 1) {
    return '`line` is required and must be a 1-based line number.';
  }
  const rawChar = input.character ?? input.column;
  const character = rawChar === undefined || rawChar === null ? 1 : Number(rawChar);
  if (!Number.isInteger(character) || character < 1) {
    return '`character`/`column` must be a 1-based column number.';
  }
  return { line: line - 1, character: character - 1 };
}

function requiredPath(input: Record<string, unknown>, toolName: string): string | undefined {
  if (typeof input.path !== 'string' || !input.path.trim()) {
    return `[Tool Error] ${toolName}: \`path\` is required.`;
  }
  return undefined;
}

export async function toolLspDefinition(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  if (!ctx.lspService) return NO_SERVICE;
  const pathError = requiredPath(input, 'lsp_definition');
  if (pathError) return pathError;
  const position = toPosition(input);
  if (typeof position === 'string') return `[Tool Error] lsp_definition: ${position}`;
  const filePath = resolveExecutionPath(input.path as string, ctx);
  return ctx.lspService.getDefinition(filePath, position, navRequest(ctx));
}

export async function toolLspHover(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  if (!ctx.lspService) return NO_SERVICE;
  const pathError = requiredPath(input, 'lsp_hover');
  if (pathError) return pathError;
  const position = toPosition(input);
  if (typeof position === 'string') return `[Tool Error] lsp_hover: ${position}`;
  const filePath = resolveExecutionPath(input.path as string, ctx);
  return ctx.lspService.getHover(filePath, position, navRequest(ctx));
}

export async function toolLspReferences(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  if (!ctx.lspService) return NO_SERVICE;
  const pathError = requiredPath(input, 'lsp_references');
  if (pathError) return pathError;
  const position = toPosition(input);
  if (typeof position === 'string') return `[Tool Error] lsp_references: ${position}`;
  const filePath = resolveExecutionPath(input.path as string, ctx);
  return ctx.lspService.getReferences(filePath, position, navRequest(ctx));
}

export async function toolLspDocumentSymbols(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  if (!ctx.lspService) return NO_SERVICE;
  if (typeof input.path !== 'string' || !input.path.trim()) {
    return '[Tool Error] lsp_document_symbols: `path` is required.';
  }
  const filePath = resolveExecutionPath(input.path, ctx);
  return ctx.lspService.getDocumentSymbols(filePath, navRequest(ctx));
}

export async function toolLspWorkspaceSymbols(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  if (!ctx.lspService) return NO_SERVICE;
  const query = typeof input.query === 'string' ? input.query : '';
  return ctx.lspService.getWorkspaceSymbols(query, navRequest(ctx));
}

export async function toolLspImplementation(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  if (!ctx.lspService) return NO_SERVICE;
  const pathError = requiredPath(input, 'lsp_implementation');
  if (pathError) return pathError;
  const position = toPosition(input);
  if (typeof position === 'string') return `[Tool Error] lsp_implementation: ${position}`;
  const filePath = resolveExecutionPath(input.path as string, ctx);
  return ctx.lspService.getImplementation(filePath, position, navRequest(ctx));
}

export async function toolLspPrepareCallHierarchy(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  if (!ctx.lspService) return NO_SERVICE;
  const pathError = requiredPath(input, 'lsp_prepare_call_hierarchy');
  if (pathError) return pathError;
  const position = toPosition(input);
  if (typeof position === 'string') return `[Tool Error] lsp_prepare_call_hierarchy: ${position}`;
  const filePath = resolveExecutionPath(input.path as string, ctx);
  return ctx.lspService.getPrepareCallHierarchy(filePath, position, navRequest(ctx));
}

export async function toolLspIncomingCalls(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  if (!ctx.lspService) return NO_SERVICE;
  const pathError = requiredPath(input, 'lsp_incoming_calls');
  if (pathError) return pathError;
  const position = toPosition(input);
  if (typeof position === 'string') return `[Tool Error] lsp_incoming_calls: ${position}`;
  const filePath = resolveExecutionPath(input.path as string, ctx);
  return ctx.lspService.getIncomingCalls(filePath, position, navRequest(ctx));
}

export async function toolLspOutgoingCalls(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  if (!ctx.lspService) return NO_SERVICE;
  const pathError = requiredPath(input, 'lsp_outgoing_calls');
  if (pathError) return pathError;
  const position = toPosition(input);
  if (typeof position === 'string') return `[Tool Error] lsp_outgoing_calls: ${position}`;
  const filePath = resolveExecutionPath(input.path as string, ctx);
  return ctx.lspService.getOutgoingCalls(filePath, position, navRequest(ctx));
}
