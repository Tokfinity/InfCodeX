/**
 * FEATURE_132 Phase E — format LSP navigation results as compact,
 * LLM-readable text. Locations render as `path:line:col` (1-based, the form
 * the agent reads/greps with); symbols render as an indented outline.
 */

import { fileURLToPath } from 'url';
import { SymbolKind, type Location, type Hover, type DocumentSymbol, type SymbolInformation } from 'vscode-languageserver-protocol';

function uriToPath(uri: string): string {
  try {
    return fileURLToPath(uri);
  } catch {
    return uri;
  }
}

/** `path:line:col` per location (1-based), or `emptyMessage` when none. */
export function formatLocations(locations: readonly Location[], emptyMessage: string): string {
  if (locations.length === 0) return emptyMessage;
  return locations
    .map((loc) => `${uriToPath(loc.uri)}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`)
    .join('\n');
}

function markedToString(marked: string | { value: string }): string {
  return typeof marked === 'string' ? marked : marked.value;
}

/** Extract hover text from any of the LSP hover content shapes. */
export function formatHover(hover: Hover | null): string {
  if (!hover) return 'No hover information.';
  const contents = hover.contents;
  if (typeof contents === 'string') return contents.trim() || 'No hover information.';
  if (Array.isArray(contents)) return contents.map(markedToString).join('\n').trim() || 'No hover information.';
  if ('kind' in contents) return contents.value.trim() || 'No hover information.';
  return markedToString(contents).trim() || 'No hover information.';
}

const SYMBOL_KIND_NAME: Readonly<Record<number, string>> = Object.freeze({
  [SymbolKind.File]: 'File',
  [SymbolKind.Module]: 'Module',
  [SymbolKind.Namespace]: 'Namespace',
  [SymbolKind.Package]: 'Package',
  [SymbolKind.Class]: 'Class',
  [SymbolKind.Method]: 'Method',
  [SymbolKind.Property]: 'Property',
  [SymbolKind.Field]: 'Field',
  [SymbolKind.Constructor]: 'Constructor',
  [SymbolKind.Enum]: 'Enum',
  [SymbolKind.Interface]: 'Interface',
  [SymbolKind.Function]: 'Function',
  [SymbolKind.Variable]: 'Variable',
  [SymbolKind.Constant]: 'Constant',
  [SymbolKind.Struct]: 'Struct',
  [SymbolKind.EnumMember]: 'EnumMember',
  [SymbolKind.TypeParameter]: 'TypeParameter',
});

function kindName(kind: number): string {
  return SYMBOL_KIND_NAME[kind] ?? 'Symbol';
}

/** Render a document's symbols as an indented outline with 1-based lines. */
export function formatSymbols(
  symbols: ReadonlyArray<DocumentSymbol | SymbolInformation>,
  emptyMessage: string,
): string {
  if (symbols.length === 0) return emptyMessage;
  const lines: string[] = [];
  const walk = (items: ReadonlyArray<DocumentSymbol | SymbolInformation>, depth: number): void => {
    for (const symbol of items) {
      const indent = '  '.repeat(depth);
      if ('location' in symbol) {
        // SymbolInformation (flat)
        lines.push(`${indent}${kindName(symbol.kind)} ${symbol.name} (${symbol.location.range.start.line + 1})`);
      } else {
        // DocumentSymbol (hierarchical)
        lines.push(`${indent}${kindName(symbol.kind)} ${symbol.name} (${symbol.range.start.line + 1})`);
        if (symbol.children && symbol.children.length > 0) walk(symbol.children, depth + 1);
      }
    }
  };
  walk(symbols, 0);
  return lines.join('\n');
}
