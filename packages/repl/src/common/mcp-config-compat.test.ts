import { describe, expect, it } from 'vitest';
import type { McpServersConfig } from '@kodax-ai/agent';
import { loadConfig } from './utils.js';

/**
 * Regression guard for a reported SDK type drift: a consumer doing
 *   `new McpManager(loadConfig().mcpServers)`
 * got a type error because the `McpServerConfig.type` union on the two surfaces
 * had diverged when the `"http"` transport alias was added.
 *
 * `McpManager`'s ctor param (`McpServersConfig`, from `@kodax-ai/agent` /
 * `@kodax-ai/kodax/mcp`) and `loadConfig()`'s `mcpServers` (the coding-layer
 * `KodaXMcpServersConfig` alias surfaced via `@kodax-ai/kodax/repl`) MUST stay
 * the same type — including every `McpTransportKind` value (`stdio` / `sse` /
 * `streamable-http` / `http`). The assignment below is the compile-time guard:
 * if either surface narrows its transport union, drops `http`, or reintroduces
 * a separate `McpServerConfig` shape, THIS FILE FAILS TO COMPILE.
 */
type LoadConfigMcpServers = NonNullable<ReturnType<typeof loadConfig>['mcpServers']>;

describe('MCP SDK config type compatibility (regression)', () => {
  it('loadConfig().mcpServers is assignable to the McpManager ctor param, incl. type:"http"', () => {
    const servers: LoadConfigMcpServers = {
      remote: { type: 'http', url: 'https://example.test/mcp', connect: 'lazy' },
    };
    // Compile-time guard — must remain assignable in BOTH directions of the alias.
    const forManager: McpServersConfig = servers;
    const backToConfig: LoadConfigMcpServers = forManager;
    expect(forManager.remote?.type).toBe('http');
    expect(backToConfig.remote?.url).toBe('https://example.test/mcp');
  });

  it('accepts every McpTransportKind value (no narrowing)', () => {
    const servers: LoadConfigMcpServers = {
      a: { type: 'stdio', command: 'x' },
      b: { type: 'sse', url: 'https://b.test' },
      c: { type: 'streamable-http', url: 'https://c.test' },
      d: { type: 'http', url: 'https://d.test' },
    };
    const forManager: McpServersConfig = servers;
    expect(Object.keys(forManager)).toHaveLength(4);
  });
});
