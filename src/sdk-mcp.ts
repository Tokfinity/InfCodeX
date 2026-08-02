/**
 * SDK subpath entry — `@kodax-ai/kodax/mcp` (v0.7.42; FEATURE_194 v0.7.43 inline + narrow).
 *
 * Narrow subset alias: exposes ONLY the MCP capability surface — server
 * config types, capability provider, transport factory, catalog helpers,
 * runtime diagnostics. Post-FEATURE_194 the MCP code lives at
 * `packages/agent/src/capabilities/mcp/`.
 *
 * Symbol set = the pre-FEATURE_194 `@kodax-ai/mcp` standalone package's
 * complete public API. Migrating from v0.7.42 `@kodax-ai/mcp` requires
 * only changing the import specifier; symbol coverage is unchanged.
 *
 * If you need agent framework symbols (Runner / fan-out / session) — those
 * live under `@kodax-ai/kodax/agent`, not here.
 *
 * Usage:
 * ```ts
 * import {
 *   McpCapabilityProvider,
 *   createMcpTransport,
 *   searchMcpCatalog,
 *   type McpServerConfig,
 * } from '@kodax-ai/kodax/mcp';
 * ```
 *
 * For server-list CRUD against `~/.kodax/config.json` (popout-friendly
 * add / remove / list), pair this with `@kodax-ai/kodax/repl`:
 * ```ts
 * import {
 *   listMcpServers,
 *   upsertMcpServer,
 *   removeMcpServer,
 * } from '@kodax-ai/kodax/repl';
 * ```
 *
 * The CRUD helpers live in the repl subpath (not here) because they
 * depend on the agent-config-home path resolution surface — keeping
 * `@kodax-ai/kodax/mcp` minimal so consumers who only need the
 * transport / provider layer don't pull in the repl bundle.
 *
 * Note: explicit named re-exports (not `export * from
 * '@kodax-ai/agent/capabilities/mcp'`) because rollup-plugin-dts does
 * not resolve package.json subpath exports for monorepo workspace packages
 * — see sdk-session.ts comment. Runtime path is unchanged.
 *
 * See docs/ADR.md ADR-024 (SDK subpath formalization) and ADR-036
 * (narrow-subset subpath convention).
 */

export type {
  // config.js
  McpServerConfig,
  McpServersConfig,
  McpTransportKind,
  McpConnectMode,
  // catalog.js
  McpCapabilityKind,
  McpCapabilityRisk,
  McpIcon,
  McpToolTaskSupport,
  McpCatalogItem,
  McpCapabilityDescriptor,
  McpServerCatalogSnapshot,
  // runtime.js
  McpServerRuntimeDiagnostics,
  // provider.js
  McpProviderOptions,
  // reverse-capabilities.js
  McpReverseCapabilities,
  McpRoot,
  McpElicitRequest,
  McpElicitResult,
  McpSamplingRequest,
  McpSamplingResult,
  // transport.js
  McpTransport,
  McpTransportEvents,
  // oauth-discovery.js / oauth-login.js
  ProtectedResourceMetadata,
  AuthorizationServerMetadata,
  DiscoveredOAuthEndpoints,
  WwwAuthenticateChallenge,
  OAuthLoginConsent,
  PerformOAuthLoginOptions,
  OAuthClientInfo,
  // manager.js
  McpServerStatus,
  McpServerLogs,
  McpServerToolList,
  McpServerCatalog,
} from '@kodax-ai/agent';

export {
  // catalog.js
  defaultMcpCacheDir,
  createMcpCapabilityId,
  normalizeMcpCapabilityId,
  parseMcpCapabilityId,
  searchMcpCatalog,
  getMcpCachePaths,
  // runtime.js
  McpServerRuntime,
  // provider.js
  McpCapabilityProvider,
  // reverse-capabilities.js
  buildInitializeCapabilities,
  // transport.js
  createMcpTransport,
  McpAuthRequiredError,
  McpTransportCleanupIncompleteError,
  McpExpiredSessionError,
  // oauth-discovery.js / oauth-login.js
  discoverOAuthEndpoints,
  discoverProtectedResourceMetadata,
  discoverAuthorizationServerMetadata,
  extractResourceMetadataUrl,
  extractInsufficientScope,
  performOAuthLogin,
  loadValidToken,
  registerOAuthClient,
  // manager.js
  McpManager,
  createMcpManager,
  // test-helpers.js
  createMcpTestServerFixture,
} from '@kodax-ai/agent';
