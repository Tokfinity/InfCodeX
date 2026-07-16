/**
 * FEATURE_132 — filesystem path normalization for LSP map keys.
 *
 * Diagnostics arrive keyed by `file://` URI; the tools look them up by the
 * absolute path returned from `resolveExecutionPath`. On Windows those use
 * backslashes while `fileURLToPath` yields a drive-letter path — normalize
 * both sides to forward slashes, and fully lowercase on Windows (whose
 * filesystem is case-insensitive) so a server echoing a differently-cased
 * path component still matches our lookup. Used only as a Map key — display
 * paths keep their original case.
 */

const IS_WINDOWS = process.platform === 'win32';

/** Normalize an absolute path to a stable LSP-map key (forward slashes). */
export function normalizeFsPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  return IS_WINDOWS ? normalized.toLowerCase() : normalized;
}
