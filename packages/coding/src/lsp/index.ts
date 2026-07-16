/**
 * FEATURE_132 — native LSP integration (public surface for @kodax-ai/coding).
 *
 * Edit-time diagnostics reflux: after the write-family tools change a file,
 * `LspService.getDiagnosticsBlock` touches it through a language server and
 * returns any type errors as an appendable block, so the agent fixes them in
 * the same turn instead of waiting for the next build.
 */

export { LANGUAGE_EXTENSIONS, languageIdForPath } from './language.js';
export { MAX_PER_FILE, pretty, report } from './diagnostic.js';
export { normalizeFsPath } from './paths.js';
export {
  LSP_SERVERS,
  serversForLanguage,
  isAutoInstallEnabled,
  type LspServerInfo,
  type LspServerLaunch,
  type DiscoverContext,
  type AcquireContext,
} from './servers.js';
export {
  LspService,
  getDefaultLspService,
  shutdownDefaultLspService,
  __resetDefaultLspServiceForTest,
  type DiagnosticsRequest,
  type LspServiceConfig,
} from './service.js';
export { runInstallCommand, type InstallCommand } from './acquirer.js';
export type { LspClient, DiagnosticsWaitOptions } from './client.js';
