/**
 * Typed MCP integration CRUD.
 *
 * FEATURE_268 stores active declarations in `integrations/mcp.json`. When that
 * file is absent, reads use the legacy `config.json#mcpServers` field. The
 * first mutation stages every legacy entry into the new document before
 * applying the requested change, so creating the authoritative file cannot
 * silently deactivate an existing server.
 */

import {
  getAgentConfigHome,
  type McpServerConfig as KodaXMcpServerConfig,
  type McpServersConfig as KodaXMcpServersConfig,
} from '@kodax-ai/agent';

import {
  parseMcpIntegrationDocument,
  readMcpIntegration,
  writeIntegrationDocument,
} from './integration-config.js';

export function listMcpServers(): KodaXMcpServersConfig {
  return structuredClone(readMcpIntegration(getAgentConfigHome()).document.servers);
}

export function getMcpServerConfig(
  name: string,
): KodaXMcpServerConfig | undefined {
  if (typeof name !== 'string' || name.length === 0) return undefined;
  const config = readMcpIntegration(getAgentConfigHome()).document.servers[name];
  return config === undefined ? undefined : structuredClone(config);
}

export function upsertMcpServer(
  name: string,
  config: KodaXMcpServerConfig,
): KodaXMcpServerConfig {
  validateMcpServerConfig(name, config);
  const configHome = getAgentConfigHome();
  const current = readMcpIntegration(configHome);
  const stored = structuredClone(config);
  writeIntegrationDocument({
    domain: 'mcp',
    configHome,
    ...(current.source === 'user' ? { expectedRevision: current.revision } : {}),
    document: {
      version: 1,
      servers: { ...current.document.servers, [name]: stored },
    },
    validate: parseMcpIntegrationDocument,
  });
  return structuredClone(stored);
}

export function removeMcpServer(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0) return false;
  const configHome = getAgentConfigHome();
  const current = readMcpIntegration(configHome);
  if (!(name in current.document.servers)) return false;
  const servers = structuredClone(current.document.servers);
  delete servers[name];
  writeIntegrationDocument({
    domain: 'mcp',
    configHome,
    ...(current.source === 'user' ? { expectedRevision: current.revision } : {}),
    document: { version: 1, servers },
    validate: parseMcpIntegrationDocument,
  });
  return true;
}

export function validateMcpServerConfig(
  name: string,
  config: KodaXMcpServerConfig,
): void {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError('MCP server name must be a non-empty string');
  }
  parseMcpIntegrationDocument({ version: 1, servers: { [name]: config } });
}
