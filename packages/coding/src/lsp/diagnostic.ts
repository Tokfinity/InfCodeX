/**
 * FEATURE_132 — diagnostic formatting (pure).
 *
 * Mirrors opencode `lsp/diagnostic.ts`: ERROR-severity only, hard
 * per-file cap, XML-wrapped block, empty string when there is nothing to
 * report. Returning `""` (never null) lets call sites guard with a plain
 * `if (block)`.
 */

import type { Diagnostic } from 'vscode-languageserver-protocol';

/** Hard cap on diagnostics emitted per file — prevents flooding a tool result. */
export const MAX_PER_FILE = 20;

/** LSP DiagnosticSeverity.Error. */
const SEVERITY_ERROR = 1;

const SEVERITY_LABEL: Readonly<Record<number, string>> = Object.freeze({
  1: 'ERROR',
  2: 'WARN',
  3: 'INFO',
  4: 'HINT',
});

/** Format one diagnostic as `SEVERITY [line:col] message` (1-based line/col). */
export function pretty(diagnostic: Diagnostic): string {
  const severity = SEVERITY_LABEL[diagnostic.severity ?? SEVERITY_ERROR] ?? 'ERROR';
  const line = diagnostic.range.start.line + 1;
  const col = diagnostic.range.start.character + 1;
  return `${severity} [${line}:${col}] ${diagnostic.message}`;
}

/**
 * Build the `<diagnostics file="…">…</diagnostics>` block for a file.
 * Only ERROR-severity diagnostics are surfaced (warnings/info/hints are
 * noise the agent should not be nagged about after an edit). Returns `""`
 * when there are no errors to report.
 */
export function report(file: string, issues: readonly Diagnostic[]): string {
  const errors = issues.filter((item) => (item.severity ?? SEVERITY_ERROR) === SEVERITY_ERROR);
  if (errors.length === 0) return '';
  const limited = errors.slice(0, MAX_PER_FILE);
  const overflow = errors.length - MAX_PER_FILE;
  const suffix = overflow > 0 ? `\n... and ${overflow} more` : '';
  return `<diagnostics file="${file}">\n${limited.map(pretty).join('\n')}${suffix}\n</diagnostics>`;
}
