/**
 * FEATURE_132 — language-server registry + discovery (cascade step ①).
 *
 * Each `LspServerInfo` is data describing one server: which languageIds it
 * serves, the project-root markers it should be rooted at, how to discover
 * an installed binary, and one line of actionable install guidance for when
 * it is absent. Adding a language = appending one entry here (data-driven,
 * per the LLM-First design principle).
 *
 * Phase A registers TypeScript/JavaScript only. Phase B/C append Python,
 * Go, Rust, Java.
 */

import { resolveNodePackageBin, resolveTsserver, whichGlobal } from './discovery.js';

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

export interface LspServerInfo {
  readonly id: string;
  readonly languageIds: readonly string[];
  readonly rootMarkers: readonly string[];
  /** Locate an installed server, or `undefined` if not installed. */
  discover(ctx: DiscoverContext): LspServerLaunch | undefined;
  /** One actionable line shown when discovery fails (cascade step ③). */
  readonly installGuidance: string;
}

const TYPESCRIPT: LspServerInfo = {
  id: 'typescript',
  languageIds: ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'],
  rootMarkers: ['tsconfig.json', 'jsconfig.json', 'package.json', '.git'],
  discover({ root, moduleUrl }) {
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
  },
  installGuidance:
    'Install the TypeScript language server for in-editor diagnostics: '
    + '`npm i -D typescript typescript-language-server` (project-local, recommended) '
    + 'or `npm i -g typescript-language-server`.',
};

/** Resolve a global PATH binary as a launch command, or undefined. */
function globalLaunch(binary: string): LspServerLaunch | undefined {
  const found = whichGlobal(binary);
  return found ? { command: found, args: [] } : undefined;
}

/** All servers KodaX knows how to drive. */
export const LSP_SERVERS: readonly LspServerInfo[] = Object.freeze([TYPESCRIPT]);

/** Servers that can serve the given languageId. */
export function serversForLanguage(languageId: string): readonly LspServerInfo[] {
  return LSP_SERVERS.filter((server) => server.languageIds.includes(languageId));
}
