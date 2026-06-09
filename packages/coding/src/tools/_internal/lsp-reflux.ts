/**
 * FEATURE_132 (v0.7.47) — shared helper to reflux LSP diagnostics into a
 * write-family tool result. Returns an appendable block (`"\n\nLSP errors…"`)
 * or `""` when there is nothing to report / no server is available.
 *
 * Kept in `tools/_internal` (not the `lsp/` module) so the LSP package stays
 * decoupled from `KodaXToolExecutionContext`.
 */

import type { KodaXToolExecutionContext } from '../../types.js';

export async function appendLspDiagnostics(
  filePath: string,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  if (!ctx.lspService) return '';
  try {
    return await ctx.lspService.getDiagnosticsBlock(filePath, {
      gitRoot: ctx.gitRoot,
      signal: ctx.abortSignal,
      onProgress: ctx.reportToolProgress,
    });
  } catch {
    // Diagnostics are a best-effort enhancement; never fail the write.
    return '';
  }
}
