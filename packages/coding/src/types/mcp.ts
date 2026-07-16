/**
 * FEATURE_200 Phase F (v0.7.45) — MCP domain types extracted from types.ts.
 * Thin KodaX-facing aliases over the @kodax-ai/agent MCP types. Re-exported
 * from ../types.ts so all `../types` importers are unaffected.
 */
import type {
  McpServerConfig,
  McpServersConfig,
  McpTransportKind,
  McpConnectMode,
} from '@kodax-ai/agent';

export type KodaXMcpTransport = McpTransportKind;
export type KodaXMcpConnectMode = McpConnectMode;
export type KodaXMcpServerConfig = McpServerConfig;
/** Flat map of MCP server configs, keyed under `mcpServers` in config.json. */
export type KodaXMcpServersConfig = McpServersConfig;
