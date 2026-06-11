/**
 * MCP server CRUD — v0.7.42 (closes the "MCP popout" request from
 * KodaX Space).
 *
 * Before v0.7.42 the only way for an SDK embedder to register a new
 * MCP server was to:
 *   1. Read `~/.kodax/config.json` directly.
 *   2. Hand-build a `KodaXMcpServersConfig` entry (no exported
 *      validator — Space wrote a parallel zod schema).
 *   3. Write the file back, hoping `mcpServers` shape stayed in sync
 *      with whatever the KodaX SDK currently expects.
 *   4. Restart the runtime — the existing `McpCapabilityProvider`
 *      caches its server list at construction time so config changes
 *      do NOT take effect mid-process.
 *
 * The KodaX Space "MCP popout" panel wants step 4 OUT of the loop:
 * users add/remove an MCP server, click "save", and have it live
 * immediately in the next agent turn. That requires (a) a typed CRUD
 * surface that owns the file format, and (b) an explicit re-hydrate
 * hook so the next agent run picks up the changes.
 *
 * This module covers (a). The re-hydrate hook is implicit: every new
 * substrate frame reads `loadConfig().mcpServers` at session start
 * (see `repl/.../bootstrap` flow) — so the next `runKodaX` /
 * `startKodaX` call sees the new list. In-flight runs continue with
 * the snapshot the substrate took at start; that matches the
 * pre-v0.7.42 invariant and avoids surprising tool-list mutations
 * mid-turn.
 *
 * Schema: this module relies on TypeScript's structural typing against
 * `KodaXMcpServerConfig` (exported from `@kodax-ai/agent` via the coding
 * barrel). Unlike custom providers — which have a runtime validator —
 * MCP entries have no canonical zod schema in the SDK today, so the
 * CRUD does shape-level checks only (required `name`, recognized
 * transport `type`, transport-shape coherence: stdio→command, http-like
 * transports→url). Embedders that need stricter validation can
 * layer it on top.
 *
 * Path resolution: like `custom-providers.ts`, this module resolves
 * the config file path on EVERY call via `getAgentConfigPath`, so
 * `setAgentConfigHome()` overrides (tests, multi-tenant substrate
 * consumers) take effect immediately.
 */

import fs from 'node:fs';
import path from 'node:path';

import { getAgentConfigPath, type KodaXMcpServerConfig, type KodaXMcpServersConfig } from '@kodax-ai/coding';

/**
 * Return a snapshot of every MCP server currently persisted in
 * `~/.kodax/config.json` under `mcpServers`. Returned record is a
 * defensive deep copy — mutating it does NOT change the on-disk
 * config (use {@link upsertMcpServer} / {@link removeMcpServer} for
 * mutation). Order is undefined (object key order semantics).
 */
export function listMcpServers(): KodaXMcpServersConfig {
  const config = readWholeConfig();
  return cloneMcpServers(extractMcpServers(config));
}

/**
 * Look up a single MCP server config by `name`. Returns `undefined`
 * if no such server is configured. Returned value is a defensive
 * deep copy.
 */
export function getMcpServerConfig(
  name: string,
): KodaXMcpServerConfig | undefined {
  if (typeof name !== 'string' || name.length === 0) {
    return undefined;
  }
  const servers = extractMcpServers(readWholeConfig());
  const entry = servers[name];
  return entry ? cloneMcpServerConfig(entry) : undefined;
}

/**
 * Add a new MCP server OR replace an existing one with the same
 * name. Shape is validated via {@link validateMcpServerConfig}; on
 * validation failure the call throws and the config is NOT touched.
 *
 * Returns the deep-cloned stored shape (so callers can observe the
 * normalized value without re-reading the file).
 */
export function upsertMcpServer(
  name: string,
  config: KodaXMcpServerConfig,
): KodaXMcpServerConfig {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('upsertMcpServer: name must be a non-empty string');
  }
  validateMcpServerConfig(name, config);

  const cloned = cloneMcpServerConfig(config);
  const whole = readWholeConfig();
  const existing = extractMcpServers(whole);
  const next: KodaXMcpServersConfig = { ...existing, [name]: cloned };
  writeWholeConfig({ ...whole, mcpServers: next });
  return cloneMcpServerConfig(cloned);
}

/**
 * Remove the MCP server identified by `name`. Returns `true` when an
 * entry was removed, `false` when no server with that name existed
 * (the file is NOT rewritten in that case — no-op for unknown names
 * so caller code can be idempotent).
 */
export function removeMcpServer(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0) {
    return false;
  }
  const whole = readWholeConfig();
  const existing = extractMcpServers(whole);
  if (!(name in existing)) {
    return false;
  }
  // Immutable update — produce a new record without the named key.
  const next: KodaXMcpServersConfig = {};
  for (const key of Object.keys(existing)) {
    if (key !== name) {
      next[key] = existing[key]!;
    }
  }
  writeWholeConfig({ ...whole, mcpServers: next });
  return true;
}

/**
 * Shape-level validation. Throws on malformed input — used by
 * {@link upsertMcpServer} before the disk write. Exposed so
 * embedders can pre-validate user input from a popout form before
 * showing a "save" button.
 *
 * Checks:
 *   - `config` is a plain object
 *   - transport `type` (when set) is one of stdio | sse | streamable-http | http
 *   - stdio transport requires `command`
 *   - sse / streamable-http / http transport requires `url`
 *   - `connect` (when set) is one of lazy | prewarm | disabled
 *
 * Does NOT check that `command` resolves on PATH or that `url` is
 * reachable — both are runtime concerns surfaced by McpServerRuntime
 * at connection time.
 */
export function validateMcpServerConfig(
  name: string,
  config: KodaXMcpServerConfig,
): void {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('MCP server name must be a non-empty string');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new TypeError(`MCP server "${name}": config must be a plain object`);
  }
  const transport = config.type ?? 'stdio';
  if (!['stdio', 'sse', 'streamable-http', 'http'].includes(transport)) {
    throw new TypeError(
      `MCP server "${name}": unknown transport type "${transport}" (expected stdio | sse | streamable-http | http)`,
    );
  }
  if (transport === 'stdio') {
    if (typeof config.command !== 'string' || config.command.length === 0) {
      throw new TypeError(
        `MCP server "${name}": stdio transport requires a non-empty "command"`,
      );
    }
  } else {
    if (typeof config.url !== 'string' || config.url.length === 0) {
      throw new TypeError(
        `MCP server "${name}": "${transport}" transport requires a non-empty "url"`,
      );
    }
  }
  if (config.connect !== undefined
    && !['lazy', 'prewarm', 'disabled'].includes(config.connect)) {
    throw new TypeError(
      `MCP server "${name}": unknown connect mode "${config.connect}" (expected lazy | prewarm | disabled)`,
    );
  }
}

// ============== Internals ==============

function configFilePath(): string {
  return getAgentConfigPath('config.json');
}

function readWholeConfig(): Record<string, unknown> {
  const file = configFilePath();
  if (!fs.existsSync(file)) {
    return {};
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function writeWholeConfig(config: Record<string, unknown>): void {
  const file = configFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config, null, 2), 'utf-8');
}

function extractMcpServers(
  config: Record<string, unknown>,
): KodaXMcpServersConfig {
  const value = config.mcpServers;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as KodaXMcpServersConfig;
}

function cloneMcpServerConfig(config: KodaXMcpServerConfig): KodaXMcpServerConfig {
  return structuredClone(config);
}

function cloneMcpServers(servers: KodaXMcpServersConfig): KodaXMcpServersConfig {
  return structuredClone(servers);
}
