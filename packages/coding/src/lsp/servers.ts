/**
 * FEATURE_132 — language-server registry + discovery (cascade step ①).
 *
 * Each `LspServerInfo` is data describing one server: which languageIds it
 * serves, the project-root markers it should be rooted at, how to discover
 * an installed binary, an optional opt-in `acquire()` (cascade step ②), and
 * one line of actionable install guidance for when it is absent (step ③).
 * Adding a language = appending one entry here (data-driven, LLM-First).
 *
 * Phase A: TypeScript/JavaScript. Phase B: Python (pyright) + Go (gopls).
 * Phase C appends Rust, Java.
 */

import { resolveNodePackageBin, resolveTsserver, whichGlobal } from './discovery.js';
import { isAutoInstallEnabled, runInstallCommand } from './acquirer.js';

/** A resolved server launch: program + args + optional init options. */
export interface LspServerLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly initializationOptions?: Record<string, unknown>;
}

export interface DiscoverContext {
  /** Project root the server will be rooted at. */
  readonly root: string;
  /** `import.meta.url` of the LSP module, used for bundled-TypeScript fallback. */
  readonly moduleUrl?: string;
}

export interface AcquireContext {
  readonly root: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (message: string) => void;
  readonly debug?: (message: string) => void;
}

export interface LspServerInfo {
  readonly id: string;
  readonly languageIds: readonly string[];
  readonly rootMarkers: readonly string[];
  /** Locate an installed server, or `undefined` if not installed. */
  discover(ctx: DiscoverContext): LspServerLaunch | undefined;
  /**
   * Opt-in auto-install (only attempted when `KODAX_LSP_DOWNLOAD=1`). Installs
   * the server, then returns its launch (typically by re-running discovery).
   * Absent for servers KodaX won't auto-install.
   */
  acquire?(ctx: AcquireContext): Promise<LspServerLaunch | undefined>;
  /** One actionable line shown when discovery + acquire fail (step ③). */
  readonly installGuidance: string;
}

/** Resolve a global PATH binary as a launch command, or undefined. */
function globalLaunch(binary: string, args: readonly string[] = []): LspServerLaunch | undefined {
  const found = whichGlobal(binary);
  return found ? { command: found, args } : undefined;
}

// ── TypeScript / JavaScript ────────────────────────────────────────────────

function discoverTypescript({ root, moduleUrl }: DiscoverContext): LspServerLaunch | undefined {
  // The server needs a tsserver.js to drive; prefer the project's own
  // TypeScript, fall back to the one bundled with @kodax-ai/coding.
  const tsserver = resolveTsserver(root, moduleUrl);
  if (!tsserver) return undefined;
  const fromProject = resolveNodePackageBin('typescript-language-server', root, 'typescript-language-server');
  const launch = fromProject ?? globalLaunch('typescript-language-server');
  if (!launch) return undefined;
  return {
    command: launch.command,
    args: [...launch.args, '--stdio'],
    initializationOptions: { tsserver: { path: tsserver } },
  };
}

const TYPESCRIPT: LspServerInfo = {
  id: 'typescript',
  languageIds: ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'],
  rootMarkers: ['tsconfig.json', 'jsconfig.json', 'package.json', '.git'],
  discover: discoverTypescript,
  installGuidance:
    'Install the TypeScript language server for in-editor diagnostics: '
    + '`npm i -D typescript typescript-language-server` (project-local, recommended) '
    + 'or `npm i -g typescript-language-server`.',
};

// ── Python (pyright) ───────────────────────────────────────────────────────

function discoverPyright({ root }: DiscoverContext): LspServerLaunch | undefined {
  const fromProject = resolveNodePackageBin('pyright', root, 'pyright-langserver');
  const launch = fromProject ?? globalLaunch('pyright-langserver');
  if (!launch) return undefined;
  return { command: launch.command, args: [...launch.args, '--stdio'] };
}

const PYRIGHT: LspServerInfo = {
  id: 'pyright',
  languageIds: ['python'],
  rootMarkers: ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile', '.git'],
  discover: discoverPyright,
  installGuidance:
    'Install pyright for Python diagnostics: `npm i -g pyright` (or `pip install pyright`).',
};

// ── Go (gopls) ─────────────────────────────────────────────────────────────

function discoverGopls(): LspServerLaunch | undefined {
  // gopls speaks LSP over stdio with no arguments.
  return globalLaunch('gopls');
}

const GOPLS: LspServerInfo = {
  id: 'gopls',
  languageIds: ['go'],
  rootMarkers: ['go.mod', 'go.work', '.git'],
  discover: discoverGopls,
  async acquire({ signal, onProgress, debug }) {
    // Cheap acquirer: borrow the user's Go toolchain (a command they could run
    // themselves). Only reached when KODAX_LSP_DOWNLOAD=1 (gated by the service).
    onProgress?.('Installing gopls via `go install`…');
    const ok = await runInstallCommand(
      { command: 'go', args: ['install', 'golang.org/x/tools/gopls@latest'] },
      { signal, debug },
    );
    return ok ? discoverGopls() : undefined;
  },
  installGuidance:
    'Install gopls for Go diagnostics: `go install golang.org/x/tools/gopls@latest` '
    + '(requires the Go toolchain; ensure GOBIN is on PATH).',
};

/** All servers KodaX knows how to drive. */
export const LSP_SERVERS: readonly LspServerInfo[] = Object.freeze([TYPESCRIPT, PYRIGHT, GOPLS]);

/** Servers that can serve the given languageId. */
export function serversForLanguage(languageId: string): readonly LspServerInfo[] {
  return LSP_SERVERS.filter((server) => server.languageIds.includes(languageId));
}

export { isAutoInstallEnabled };
