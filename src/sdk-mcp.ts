/**
 * SDK subpath entry — `@kodax-ai/kodax/mcp` (v0.7.42; FEATURE_194 v0.7.43 inline).
 *
 * Re-exports the MCP surface from `@kodax-ai/agent` — MCP server config
 * types, capability provider, transport factory, catalog helpers, and
 * runtime diagnostics. Post-FEATURE_194 the MCP code lives at
 * `packages/agent/src/capabilities/mcp/`.
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
 * See docs/ADR.md ADR-024 for the SDK subpath formalization decision.
 */

export * from '@kodax-ai/agent';
