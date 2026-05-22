/**
 * McpManager — v0.7.42 (extends FEATURE_186 MCP popout surface).
 *
 * `McpCapabilityProvider` (`./provider.ts`) is the capability-provider-
 * shaped object KodaX uses internally to plug MCP into the agent runtime
 * — its public methods are `search` / `describe` / `execute` / `read` /
 * `getPrompt` / `getDiagnostics` / `refresh` / `dispose`, which is the
 * shape the substrate consumes but NOT the shape a popout UI wants.
 *
 * KodaX Space reported that `@kodax-ai/kodax/mcp` only exposed "types +
 * helpers, no manager-shape API" — concretely they wanted a thin
 * `listServers / startServer / stopServer / getServerLogs / listTools`
 * surface to drive a popout panel:
 *
 *   - One row per configured MCP server with live status
 *   - "Start" / "Stop" buttons that map to refreshCatalog(true) / dispose
 *   - Server logs (last error + status) so users can debug failures
 *   - Per-server tool list (filtered descriptors) for the "what does
 *     this MCP server expose" pane
 *
 * `McpManager` is the thin wrapper. It owns one `McpCapabilityProvider`
 * instance internally, so all the existing lifecycle invariants
 * (cache-dir capture, refresh, dispose, server-config validation) are
 * preserved verbatim. The capability-provider-shaped methods stay
 * available via `manager.provider()` as an escape hatch.
 *
 * Trust boundary: same as the rest of FEATURE_186 — KodaX is a
 * single-user CLI, last-write-wins on the server-config-vs-active-
 * runtime path; a Space popout that swaps configs hot would still need
 * to construct a fresh `McpManager` (or call `dispose()` then
 * `createMcpManager` again) to pick up the new wire.
 */

import type { CapabilityResult, CapabilityKind } from '@kodax-ai/agent';

import type { McpCapabilityDescriptor, McpCatalogItem, McpServerCatalogSnapshot } from './catalog.js';
import type { McpServerConfig, McpServersConfig, McpConnectMode } from './config.js';
import { McpCapabilityProvider, type McpProviderOptions } from './provider.js';
import type { McpServerRuntime, McpServerRuntimeDiagnostics } from './runtime.js';

export interface McpServerStatus {
  readonly serverId: string;
  readonly config: McpServerConfig;
  readonly connect: McpConnectMode;
  readonly status: McpServerRuntimeDiagnostics['status'];
  readonly tools: number;
  readonly resources: number;
  readonly prompts: number;
  readonly dirty: boolean;
  readonly cachedAt?: string;
  readonly lastError?: string;
}

export interface McpServerLogs {
  readonly serverId: string;
  readonly status: McpServerRuntimeDiagnostics['status'];
  readonly connect: McpConnectMode;
  readonly lastError?: string;
  readonly cachedAt?: string;
}

export interface McpServerToolList {
  readonly serverId: string;
  readonly tools: readonly McpCapabilityDescriptor[];
  readonly cachedAt?: string;
}

/**
 * Manager-shape facade over {@link McpCapabilityProvider}. Construct
 * via the {@link createMcpManager} factory or `new McpManager(...)`
 * directly.
 */
export class McpManager {
  private readonly capabilityProvider: McpCapabilityProvider;
  private readonly serversConfig: McpServersConfig;

  constructor(
    servers: McpServersConfig | undefined,
    options: McpProviderOptions = {},
  ) {
    this.serversConfig = { ...(servers ?? {}) };
    this.capabilityProvider = new McpCapabilityProvider(servers, options);
  }

  /**
   * Escape hatch — returns the underlying {@link McpCapabilityProvider}
   * for callers that need the search / describe / execute / read /
   * getPrompt API (e.g. embedding into a custom agent runtime).
   */
  provider(): McpCapabilityProvider {
    return this.capabilityProvider;
  }

  /**
   * One status row per configured server (lazy / prewarm / disabled
   * all included). Returned objects are plain readonly snapshots —
   * mutating them does NOT affect runtime state.
   */
  listServers(): McpServerStatus[] {
    const result: McpServerStatus[] = [];
    for (const serverId of this.capabilityProvider.getServerIds()) {
      result.push(this.buildStatus(serverId));
    }
    return result;
  }

  /**
   * Force a connection + catalog refresh for `serverId`. Returns the
   * post-start status row. Throws if `serverId` is not configured.
   *
   * For lazy servers, this is the explicit "connect now" trigger —
   * useful when a popout user clicks "Start" before any tool call has
   * forced the lazy connection.
   */
  async startServer(serverId: string): Promise<McpServerStatus> {
    const runtime = this.requireRuntime(serverId);
    await runtime.refreshCatalog(true);
    return this.buildStatus(serverId);
  }

  /**
   * Disconnect `serverId` — closes the transport, drops the pending
   * request queue, but keeps the server in the config so a subsequent
   * `startServer` / `listTools` can reconnect. Returns the post-stop
   * status (`status: 'idle'`).
   */
  async stopServer(serverId: string): Promise<McpServerStatus> {
    const runtime = this.requireRuntime(serverId);
    await runtime.dispose();
    return this.buildStatus(serverId);
  }

  /**
   * Return the most recent runtime diagnostic envelope for `serverId`
   * — status, last error, last cached timestamp. Designed as the data
   * source for a popout "Logs" pane.
   *
   * Logs API is intentionally conservative in v0.7.42: only the last
   * error message + status are exposed. A future iteration may add a
   * ring buffer of recent events; the field shape will extend (add
   * fields), never break (rename / remove).
   */
  getServerLogs(serverId: string): McpServerLogs {
    const diag = this.requireRuntime(serverId).getDiagnostics();
    return {
      serverId,
      status: diag.status,
      connect: diag.connect,
      lastError: diag.lastError,
      cachedAt: diag.cachedAt,
    };
  }

  /**
   * Return the tool descriptors for `serverId`. Triggers a lazy
   * connect + catalog fetch if the catalog has not yet been built;
   * pass `{ forceRefresh: true }` to force a fresh catalog regardless
   * of cache state.
   *
   * Only `kind === 'tool'` descriptors are returned (filters out
   * resources + prompts so popout consumers can render a clean
   * "tools" table). Use the underlying `provider().describe(id)` for
   * full descriptor introspection including resources + prompts.
   */
  async listTools(
    serverId: string,
    options: { forceRefresh?: boolean } = {},
  ): Promise<McpServerToolList> {
    const runtime = this.requireRuntime(serverId);
    const snapshot = await runtime.getCatalog(options.forceRefresh ?? false);
    return {
      serverId,
      tools: snapshot.descriptors.filter((descriptor) => descriptor.kind === 'tool'),
      cachedAt: snapshot.updatedAt,
    };
  }

  /**
   * Dispose all runtimes. After calling, the manager is no longer
   * usable for `startServer` / `listTools` (they would reconnect, but
   * the consumer should construct a fresh manager instead).
   */
  async dispose(): Promise<void> {
    await this.capabilityProvider.dispose();
  }

  /** v0.7.42 — escape hatch for advanced uses; usually consumers use the typed methods above. */
  async search(
    query: string,
    options: { kind?: CapabilityKind; limit?: number; server?: string } = {},
  ): Promise<readonly McpCatalogItem[]> {
    const items = await this.capabilityProvider.search(query, options);
    return items as readonly McpCatalogItem[];
  }

  /** v0.7.42 — escape hatch for advanced uses; usually consumers use {@link listTools}. */
  async describe(id: string): Promise<McpCapabilityDescriptor | undefined> {
    const result = await this.capabilityProvider.describe(id);
    return (result as McpCapabilityDescriptor | undefined) ?? undefined;
  }

  /** v0.7.42 — invoke a tool by capability id (`mcp://<serverId>/<kind>/<name>`). */
  async execute(id: string, input: Record<string, unknown>): Promise<CapabilityResult> {
    return this.capabilityProvider.execute(id, input);
  }

  /** v0.7.42 — read a resource by capability id. */
  async read(id: string, options: Record<string, unknown> = {}): Promise<CapabilityResult> {
    return this.capabilityProvider.read(id, options);
  }

  // ============== Internals ==============

  private requireRuntime(serverId: string): McpServerRuntime {
    const runtime = this.capabilityProvider.getRuntime(serverId);
    if (!runtime) {
      throw new Error(
        `Unknown MCP server: ${serverId}. Configured ids: ${this.capabilityProvider.getServerIds().join(', ') || '(none)'}`,
      );
    }
    return runtime;
  }

  private buildStatus(serverId: string): McpServerStatus {
    const runtime = this.requireRuntime(serverId);
    const diag = runtime.getDiagnostics();
    const config = this.serversConfig[serverId] ?? {};
    return {
      serverId,
      config: { ...config },
      connect: diag.connect,
      status: diag.status,
      tools: diag.tools,
      resources: diag.resources,
      prompts: diag.prompts,
      dirty: diag.dirty,
      cachedAt: diag.cachedAt,
      lastError: diag.lastError,
    };
  }
}

/**
 * Convenience factory matching the rest of the FEATURE_186 surface
 * naming (`createSessionControl`, etc.). Equivalent to
 * `new McpManager(servers, options)`.
 */
export function createMcpManager(
  servers: McpServersConfig | undefined,
  options: McpProviderOptions = {},
): McpManager {
  return new McpManager(servers, options);
}

/**
 * Build an {@link McpManager} from the persisted `~/.kodax/config.json`
 * mcpServers section. Reads config via `listMcpServers` from the
 * `@kodax-ai/kodax/repl` CRUD surface — but to keep `@kodax-ai/mcp`
 * dependency-free (no `@kodax-ai/repl` import here), this function
 * accepts the servers config object directly. Popout consumers
 * compose:
 *
 *   import { listMcpServers } from '@kodax-ai/kodax/repl';
 *   import { createMcpManager } from '@kodax-ai/kodax/mcp';
 *   const manager = createMcpManager(listMcpServers());
 *
 * is the standard recipe.
 */
