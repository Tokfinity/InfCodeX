/**
 * FEATURE_132 — extension → LSP languageId mapping.
 *
 * Pure data + lookup. The map is intentionally complete for the five
 * languages KodaX ships servers for (TS/JS, Python, Go, Rust, Java); an
 * extension here only matters when `servers.ts` actually has a server for
 * its languageId, so listing an extension never spawns anything on its own.
 *
 * Ported from opencode `lsp/language.ts` (trimmed to KodaX's server set).
 */

/** Lowercase file extension (including the leading dot) → LSP languageId. */
export const LANGUAGE_EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({
  // TypeScript / JavaScript family
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascriptreact',
  // Python
  '.py': 'python',
  '.pyi': 'python',
  // Go
  '.go': 'go',
  // Rust
  '.rs': 'rust',
  // Java
  '.java': 'java',
});

/**
 * Resolve the LSP languageId for a file path, or `undefined` when KodaX
 * has no language mapping for its extension. Case-insensitive on the
 * extension so `.PY` / `.TS` resolve on case-preserving filesystems.
 */
export function languageIdForPath(filePath: string): string | undefined {
  const dot = filePath.lastIndexOf('.');
  if (dot < 0) return undefined;
  const ext = filePath.slice(dot).toLowerCase();
  return LANGUAGE_EXTENSIONS[ext];
}
