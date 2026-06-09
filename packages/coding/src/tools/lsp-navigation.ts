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

/** Convert 1-based tool input (line, optional character) to a 0-based LSP Position. */
function toPosition(input: Record<string, unknown>): Position | string {
  const line = Number(input.line);
  if (!Number.isInteger(line) || line < 1) {
    return '`line` is required and must be a 1-based line number.';
  }
  const rawChar = input.character;
  const character = rawChar === undefined || rawChar === null ? 1 : Number(rawChar);
  if (!Number.isInteger(character) || character < 1) {
    return '`character` must be a 1-based column number.';
  }
  return { line: line - 1, character: character - 1 };
}

export async function toolLspDefinition(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  if (!ctx.lspService) return NO_SERVICE;
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
