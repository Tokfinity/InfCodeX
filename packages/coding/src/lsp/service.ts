/**
 * FEATURE_132 — LSP service: spawns/caches one client per (root, server) and
 * exposes the post-edit diagnostics façade the write-family tools call.
 *
 * State machine mirrors opencode:
 *   - `clients`  — live clients, keyed `root|serverId`.
 *   - `broken`   — keys that failed discovery or startup; skipped forever
 *                  (no retry storm — a one-shot blacklist).
 *   - `spawning` — in-flight startups, so concurrent edits never double-spawn.
 *
 * `getDiagnosticsBlock` is deliberately SILENT when no server is installed
 * (returns `""`): nagging an install hint on every edit would be noise.
 * Install guidance is surfaced on explicit, user-initiated surfaces instead
 * (Phase E navigation tools / status), not the diagnostics reflux path.
 */

import path from 'path';
import { getRunScopedConfig } from '@kodax-ai/llm';
import type { Diagnostic, Position } from 'vscode-languageserver-protocol';
import { languageIdForPath } from './language.js';
import { report } from './diagnostic.js';
import {
  formatCallHierarchyItems,
  formatHover,
  formatIncomingCalls,
  formatLocations,
  formatOutgoingCalls,
  formatSymbols,
  formatWorkspaceSymbols,
} from './format.js';
import { normalizeFsPath } from './paths.js';
import { findNearestRoot } from './discovery.js';
import { LSP_SERVERS, type LspServerInfo, type LspServerLaunch } from './servers.js';
import { isAutoInstallEnabled } from './acquirer.js';
import { createLspClient, type CreateLspClientParams, type LspClient } from './client.js';

/** Per-edit hints the service needs to root + cancel work. */
export interface DiagnosticsRequest {
  /** Project root (git root) — bounds the upward root-marker search. */
  readonly gitRoot?: string;
  /** Cancels the work when the host aborts the turn. */
  readonly signal?: AbortSignal;
  /** Live progress line (e.g. "Starting typescript language server…"). */
  readonly onProgress?: (message: string) => void;
}

export interface LspServiceConfig {
  /** `import.meta.url` used to resolve the bundled TypeScript fallback. */
  readonly moduleUrl?: string;
  /** How long to wait for a fresh diagnostics publish per file. Default 5s. */
  readonly documentTimeoutMs?: number;
  /** Server registry override (tests). Defaults to {@link LSP_SERVERS}. */
  readonly servers?: readonly LspServerInfo[];
  /** Client factory override (tests). Defaults to {@link createLspClient}. */
  readonly createClient?: (params: CreateLspClientParams) => Promise<LspClient>;
  /** Debug sink (off unless wired). */
  readonly debug?: (message: string) => void;
}

const DEFAULT_DOCUMENT_TIMEOUT_MS = 5_000;

export class LspService {
  private readonly clients = new Map<string, LspClient>();
  private readonly broken = new Set<string>();
  private readonly spawning = new Map<string, Promise<LspClient | undefined>>();
  private readonly servers: readonly LspServerInfo[];
  private shuttingDown = false;

  constructor(private readonly config: LspServiceConfig = {}) {
    this.servers = config.servers ?? LSP_SERVERS;
  }

  /**
   * Touch a just-written file and return an appendable diagnostics block
   * (`"\n\n…"`) when the language server reports errors, or `""` when there
   * are none / no server is available. Never throws.
   */
  async getDiagnosticsBlock(file: string, request: DiagnosticsRequest = {}): Promise<string> {
    if (request.signal?.aborted) return '';
    const languageId = languageIdForPath(file);
    if (!languageId) return '';
    const servers = this.servers.filter((server) => server.languageIds.includes(languageId));
    if (servers.length === 0) return '';

    const absolute = path.resolve(file);
    const stopDir = request.gitRoot ?? path.dirname(absolute);
    const timeoutMs = this.config.documentTimeoutMs ?? DEFAULT_DOCUMENT_TIMEOUT_MS;

    const clients: LspClient[] = [];
    for (const server of servers) {
      const root = findNearestRoot(absolute, server.rootMarkers, stopDir);
      const client = await this.getClient(server, root, request);
      if (client) clients.push(client);
    }
    if (clients.length === 0) return '';

    await Promise.all(
      clients.map(async (client) => {
        try {
          const sentAt = await client.notifyOpenOrChange(absolute);
          await client.waitForDiagnostics(absolute, { afterMs: sentAt, timeoutMs });
        } catch (error) {
          this.config.debug?.(`diagnostics wait failed (${client.serverId}): ${(error as Error).message}`);
        }
      }),
    );

    const issues: Diagnostic[] = [];
    for (const client of clients) issues.push(...client.diagnostics(absolute));
    const block = report(absolute, issues);
    return block ? `\n\nLSP errors detected in this file, please fix:\n${block}` : '';
  }

  /** Definition site(s) of the symbol at `position` (0-based), as text. */
  async getDefinition(file: string, position: Position, request: DiagnosticsRequest = {}): Promise<string> {
    const resolved = await this.navClient(file, request);
    if (resolved.kind !== 'client') return resolved.message;
    const locations = await resolved.client
      .definition(path.resolve(file), position)
      .catch(() => []);
    return formatLocations(locations, 'No definition found at that position.');
  }

  /** Hover (type/signature/doc) for the symbol at `position` (0-based). */
  async getHover(file: string, position: Position, request: DiagnosticsRequest = {}): Promise<string> {
    const resolved = await this.navClient(file, request);
    if (resolved.kind !== 'client') return resolved.message;
    const hover = await resolved.client.hover(path.resolve(file), position).catch(() => null);
    return formatHover(hover);
  }

  /** All references to the symbol at `position` (0-based), as text. */
  async getReferences(file: string, position: Position, request: DiagnosticsRequest = {}): Promise<string> {
    const resolved = await this.navClient(file, request);
    if (resolved.kind !== 'client') return resolved.message;
    const locations = await resolved.client
      .references(path.resolve(file), position)
      .catch(() => []);
    return formatLocations(locations, 'No references found at that position.');
  }

  /** The file's symbol outline, as indented text. */
  async getDocumentSymbols(file: string, request: DiagnosticsRequest = {}): Promise<string> {
    const resolved = await this.navClient(file, request);
    if (resolved.kind !== 'client') return resolved.message;
    const symbols = await resolved.client.documentSymbols(path.resolve(file)).catch(() => []);
    return formatSymbols(symbols, 'No symbols found in this file.');
  }

  /** Project-wide symbols matching `query`, across all available language servers. */
  async getWorkspaceSymbols(query: string, request: DiagnosticsRequest = {}): Promise<string> {
    const clients = await this.workspaceClients(request);
    if (clients.length === 0) return 'No language server is available for workspace symbol search.';
    const results = await Promise.all(
      clients.map((client) => client.workspaceSymbols(query).catch(() => [])),
    );
    return formatWorkspaceSymbols(results.flat(), 'No workspace symbols found for that query.');
  }

  /** Implementation site(s) of the symbol at `position` (0-based), as text. */
  async getImplementation(file: string, position: Position, request: DiagnosticsRequest = {}): Promise<string> {
    const resolved = await this.navClient(file, request);
    if (resolved.kind !== 'client') return resolved.message;
    const locations = await resolved.client
      .implementation(path.resolve(file), position)
      .catch(() => []);
    return formatLocations(locations, 'No implementation found at that position.');
  }

  /** Prepared call hierarchy item(s) for the symbol at `position` (0-based). */
  async getPrepareCallHierarchy(file: string, position: Position, request: DiagnosticsRequest = {}): Promise<string> {
    const resolved = await this.navClient(file, request);
    if (resolved.kind !== 'client') return resolved.message;
    const items = await resolved.client
      .prepareCallHierarchy(path.resolve(file), position)
      .catch(() => []);
    return formatCallHierarchyItems(items, 'No call hierarchy item found at that position.');
  }

  /** Incoming callers of the symbol at `position` (0-based). */
  async getIncomingCalls(file: string, position: Position, request: DiagnosticsRequest = {}): Promise<string> {
    const resolved = await this.navClient(file, request);
    if (resolved.kind !== 'client') return resolved.message;
    const absolute = path.resolve(file);
    const items = await resolved.client.prepareCallHierarchy(absolute, position).catch(() => []);
    if (items.length === 0) return 'No call hierarchy item found at that position.';
    const calls = await Promise.all(
      items.map((item) => resolved.client.incomingCalls(item).catch(() => [])),
    );
    return formatIncomingCalls(calls.flat(), 'No incoming calls found for that symbol.');
  }

  /** Outgoing callees of the symbol at `position` (0-based). */
  async getOutgoingCalls(file: string, position: Position, request: DiagnosticsRequest = {}): Promise<string> {
    const resolved = await this.navClient(file, request);
    if (resolved.kind !== 'client') return resolved.message;
    const absolute = path.resolve(file);
    const items = await resolved.client.prepareCallHierarchy(absolute, position).catch(() => []);
    if (items.length === 0) return 'No call hierarchy item found at that position.';
    const calls = await Promise.all(
      items.map((item) => resolved.client.outgoingCalls(item).catch(() => [])),
    );
    return formatOutgoingCalls(calls.flat(), 'No outgoing calls found for that symbol.');
  }

  /**
   * Resolve the primary client for a navigation request, opening the file so
   * the server has current content. Returns guidance text when no server is
   * installed (navigation is user-initiated, so — unlike diagnostics — it is
   * NOT silent), or an unsupported message for non-LSP file types.
   */
  private async navClient(
    file: string,
    request: DiagnosticsRequest,
  ): Promise<{ kind: 'client'; client: LspClient } | { kind: 'message'; message: string }> {
    const languageId = languageIdForPath(file);
    if (!languageId) {
      return { kind: 'message', message: `No language server is configured for ${path.basename(file)}.` };
    }
    const servers = this.servers.filter((server) => server.languageIds.includes(languageId));
    if (servers.length === 0) {
      return { kind: 'message', message: `No language server is configured for ${path.basename(file)}.` };
    }
    const absolute = path.resolve(file);
    const stopDir = request.gitRoot ?? path.dirname(absolute);
    for (const server of servers) {
      const root = findNearestRoot(absolute, server.rootMarkers, stopDir);
      const client = await this.getClient(server, root, request);
      if (client) {
        await client.notifyOpenOrChange(absolute).catch(() => undefined);
        return { kind: 'client', client };
      }
    }
    return { kind: 'message', message: servers.map((server) => server.installGuidance).join('\n') };
  }

  private async workspaceClients(request: DiagnosticsRequest): Promise<LspClient[]> {
    const root = path.resolve(request.gitRoot ?? process.cwd());
    const clients: LspClient[] = [];
    for (const server of this.servers) {
      const client = await this.getClient(server, root, request);
      if (client) clients.push(client);
    }
    return clients;
  }

  /** Shut down all spawned servers gracefully (call on session teardown). */
  async shutdownAll(): Promise<void> {
    this.shuttingDown = true;
    try {
      // Await in-flight spawns first: a server still starting would otherwise
      // surface AFTER this returns and leak as a zombie. The `shuttingDown`
      // guard in spawnClient self-shuts those, so we just drain them here.
      await Promise.all([...this.spawning.values()].map((task) => task.catch(() => undefined)));
      const all = [...this.clients.values()];
      this.clients.clear();
      this.broken.clear();
      await Promise.all(all.map((client) => client.shutdown().catch(() => undefined)));
    } finally {
      // Allow reuse after a clean teardown (tests, or a host that re-opens).
      this.shuttingDown = false;
    }
  }

  /** Synchronous best-effort kill of all servers — for `process.on('exit')`. */
  killAllSync(): void {
    for (const client of this.clients.values()) client.killSync();
    this.clients.clear();
  }

  /**
   * Clear the broken blacklist so a server that failed earlier (e.g. installed
   * mid-session, or a transient startup failure) can be retried. Pass a
   * `root|serverId` key to clear one entry, or omit to clear all.
   */
  resetBroken(key?: string): void {
    if (key) this.broken.delete(key);
    else this.broken.clear();
  }

  private async getClient(
    server: LspServerInfo,
    root: string,
    request: DiagnosticsRequest,
  ): Promise<LspClient | undefined> {
    const key = `${normalizeFsPath(root)}|${server.id}`;
    const existing = this.clients.get(key);
    if (existing) return existing;
    if (this.broken.has(key)) return undefined;
    const inflight = this.spawning.get(key);
    if (inflight) return inflight;
    // Register the in-flight task BEFORE awaiting and delete only after it
    // settles. spawnClient itself must NOT touch `spawning`: its no-server
    // path returns synchronously, so a `finally` inside it would delete the
    // key before this `set` ran — stranding a stale entry that masks retries.
    const task = this.spawnClient(server, root, key, request);
    this.spawning.set(key, task);
    try {
      return await task;
    } finally {
      this.spawning.delete(key);
    }
  }

  private async spawnClient(
    server: LspServerInfo,
    root: string,
    key: string,
    request: DiagnosticsRequest,
  ): Promise<LspClient | undefined> {
    try {
      let launch = server.discover({ root, moduleUrl: this.config.moduleUrl });
      if (!launch) {
        launch = await this.acquireIfEnabled(server, root, request);
      }
      if (!launch) {
        this.broken.add(key);
        this.config.debug?.(`${server.id} not installed at ${root} — ${server.installGuidance}`);
        return undefined;
      }
      request.onProgress?.(`Starting ${server.id} language server…`);
      const createClient = this.config.createClient ?? createLspClient;
      const client = await createClient({
        serverId: server.id,
        root,
        launch,
        debug: this.config.debug,
      });
      // If teardown began while this server was starting, don't register it —
      // shut it down immediately so it isn't orphaned after shutdownAll().
      if (this.shuttingDown) {
        await client.shutdown().catch(() => undefined);
        return undefined;
      }
      this.clients.set(key, client);
      return client;
    } catch (error) {
      this.broken.add(key);
      this.config.debug?.(`${server.id} failed to start at ${root}: ${(error as Error).message}`);
      return undefined;
    }
  }

  /** Cascade step ②: opt-in auto-install, only when the user enabled it. */
  private async acquireIfEnabled(
    server: LspServerInfo,
    root: string,
    request: DiagnosticsRequest,
  ): Promise<LspServerLaunch | undefined> {
    if (!server.acquire || !isAutoInstallEnabled()) return undefined;
    try {
      return await server.acquire({
        root,
        signal: request.signal,
        onProgress: request.onProgress,
        debug: this.config.debug,
      });
    } catch (error) {
      this.config.debug?.(`${server.id} auto-install failed: ${(error as Error).message}`);
      return undefined;
    }
  }
}

let defaultService: LspService | undefined;
let exitCleanupRegistered = false;

/**
 * Process-wide default service used by the write-family tools when the host
 * does not inject one. `KODAX_LSP=0` disables it entirely (returns undefined,
 * so tools no-op). `KODAX_DEBUG_LSP` routes internal logs to stderr.
 */
export function getDefaultLspService(): LspService | undefined {
  // Run-scoped (concurrency-safe) first, then the global env fallback.
  const scopedLsp = getRunScopedConfig()?.lsp;
  if (scopedLsp === false || (scopedLsp === undefined && process.env.KODAX_LSP === '0')) {
    return undefined;
  }
  if (!defaultService) {
    defaultService = new LspService({
      moduleUrl: import.meta.url,
      debug: process.env.KODAX_DEBUG_LSP
        ? (message) => process.stderr.write(`[kodax:lsp] ${message}\n`)
        : undefined,
    });
    if (!exitCleanupRegistered) {
      // Last-resort sync kill on natural exit / process.exit() so spawned
      // servers don't linger (Windows does not auto-reap orphans). Hosts
      // that own the lifecycle should call shutdownDefaultLspService() on
      // teardown for a graceful stop; this does not hook SIGINT (the REPL
      // owns signal handling).
      exitCleanupRegistered = true;
      process.once('exit', () => defaultService?.killAllSync());
    }
  }
  return defaultService;
}

/** Gracefully shut down the process-wide default service (host teardown). */
export async function shutdownDefaultLspService(): Promise<void> {
  await defaultService?.shutdownAll();
}

/** Test seam — reset the process-wide singleton. */
export function __resetDefaultLspServiceForTest(): void {
  defaultService = undefined;
  exitCleanupRegistered = false;
}
