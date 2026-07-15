import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createExtensionRuntime } from '../extensions/runtime.js';
import type { KodaXToolExecutionContext } from '../types.js';
import { registerConfiguredMcpCapabilityProvider } from '../capabilities/providers/mcp-adapter.js';
import { createMcpTestServerFixture } from '@kodax-ai/agent';
import {
  toolMcpCall,
  toolMcpDescribe,
  toolMcpGetPrompt,
  toolMcpReadResource,
  toolMcpSearch,
} from './index.js';

describe('MCP retrieval tools', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('searches, describes, invokes, and reads MCP capabilities through the shared extension runtime', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-mcp-tools-'));
    tempDirs.push(tempDir);
    const fixture = await createMcpTestServerFixture(tempDir);
    const runtime = createExtensionRuntime().activate();
    await registerConfiguredMcpCapabilityProvider(runtime, fixture.servers, { cacheDir: fixture.cacheDir });
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      executionCwd: tempDir,
      gitRoot: tempDir,
      extensionRuntime: runtime,
    };

    const searchOutput = await toolMcpSearch({ query: 'echo', server: fixture.serverId }, ctx);
    expect(searchOutput).toContain('Retrieval result for mcp_search');
    expect(searchOutput).toContain(fixture.toolId);

    const browseOutput = await toolMcpSearch({ server: fixture.serverId, kind: 'tool', limit: 10 }, ctx);
    expect(browseOutput).toContain('Retrieval result for mcp_search');
    expect(browseOutput).toContain(fixture.toolId);

    const emptyQueryOutput = await toolMcpSearch({ query: '', server: fixture.serverId, kind: 'tool' }, ctx);
    expect(emptyQueryOutput).toContain(fixture.toolId);

    const toolIdWithoutScheme = fixture.toolId.replace(/^mcp:/, '');
    const resourceIdWithoutScheme = fixture.resourceId.replace(/^mcp:/, '');
    const promptIdWithoutScheme = fixture.promptId.replace(/^mcp:/, '');

    const describeOutput = await toolMcpDescribe({ id: fixture.toolId }, ctx);
    expect(describeOutput).toContain('Retrieval result for mcp_describe');
    expect(describeOutput).toContain('Echo Tool');
    expect(describeOutput).toContain(fixture.serverId);

    const describeWithoutSchemeOutput = await toolMcpDescribe({ id: toolIdWithoutScheme }, ctx);
    expect(describeWithoutSchemeOutput).toContain('Retrieval result for mcp_describe');
    expect(describeWithoutSchemeOutput).toContain(`Described MCP capability ${fixture.toolId}.`);
    expect(describeWithoutSchemeOutput).toContain(fixture.toolId);
    expect(describeWithoutSchemeOutput).not.toContain(`Described MCP capability ${toolIdWithoutScheme}.`);

    const callOutput = await toolMcpCall({ id: fixture.toolId, args: { text: 'hello', mode: 'demo' } }, ctx);
    expect(callOutput).toContain('Retrieval result for mcp_call');
    expect(callOutput).toContain('echo:hello');
    expect(callOutput).toContain('"mode":"demo"');
    expect(callOutput.split(fixture.toolId)).toHaveLength(2);

    const callWithoutSchemeOutput = await toolMcpCall({ id: toolIdWithoutScheme, args: { text: 'legacy', mode: 'demo' } }, ctx);
    expect(callWithoutSchemeOutput).toContain('Retrieval result for mcp_call');
    expect(callWithoutSchemeOutput).toContain(`Executed MCP tool ${fixture.toolId}.`);
    expect(callWithoutSchemeOutput).toContain('echo:legacy');
    expect(callWithoutSchemeOutput).toContain(fixture.toolId);
    expect(callWithoutSchemeOutput).not.toContain(`Executed MCP tool ${toolIdWithoutScheme}.`);

    const readOutput = await toolMcpReadResource({ id: fixture.resourceId }, ctx);
    expect(readOutput).toContain('Retrieval result for mcp_read_resource');
    expect(readOutput).toContain('resource:memory://guide');
    expect(readOutput.match(/resource:memory:\/\/guide/g)).toHaveLength(1);
    expect(readOutput).toContain('"mimeType":"text/plain"');
    expect(readOutput.split(fixture.resourceId)).toHaveLength(2);

    const readWithoutSchemeOutput = await toolMcpReadResource({ id: resourceIdWithoutScheme }, ctx);
    expect(readWithoutSchemeOutput).toContain('Retrieval result for mcp_read_resource');
    expect(readWithoutSchemeOutput).toContain(`Read MCP resource ${fixture.resourceId}.`);
    expect(readWithoutSchemeOutput).toContain('resource:memory://guide');
    expect(readWithoutSchemeOutput).not.toContain(`Read MCP resource ${resourceIdWithoutScheme}.`);

    const promptOutput = await toolMcpGetPrompt({ id: fixture.promptId, args: { topic: 'test' } }, ctx);
    expect(promptOutput).toContain('Retrieval result for mcp_get_prompt');
    expect(promptOutput).toContain('prompt:draft_prompt:test');

    const promptWithoutSchemeOutput = await toolMcpGetPrompt({ id: promptIdWithoutScheme, args: { topic: 'legacy' } }, ctx);
    expect(promptWithoutSchemeOutput).toContain('Retrieval result for mcp_get_prompt');
    expect(promptWithoutSchemeOutput).toContain(`Retrieved MCP prompt ${fixture.promptId}.`);
    expect(promptWithoutSchemeOutput).toContain('prompt:draft_prompt:legacy');
    expect(promptWithoutSchemeOutput).not.toContain(`Retrieved MCP prompt ${promptIdWithoutScheme}.`);

    await runtime.dispose();
  });

  it('preserves provider text whitespace through MCP call, resource, and prompt rendering', async () => {
    const extensionRuntime = {
      executeCapability: async () => ({
        kind: 'tool',
        content: '  tool body\n',
      }),
      readCapability: async (_providerId: string, capabilityId: string) => capabilityId.endsWith(':identical')
        ? {
            kind: 'resource',
            content: 'same body',
            structuredContent: 'same body',
          }
        : {
            kind: 'resource',
            content: '\n  resource body\n',
            structuredContent: { format: 'markdown', lines: 1 },
          },
      getCapabilityPrompt: async () => '  prompt body\n',
    } as unknown as NonNullable<KodaXToolExecutionContext['extensionRuntime']>;
    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      executionCwd: process.cwd(),
      extensionRuntime,
    };

    const callOutput = await toolMcpCall({ id: 'mcp:demo:tool:whitespace' }, ctx);
    const resourceOutput = await toolMcpReadResource({ id: 'mcp:demo:resource:data%3A%2F%2Fwhitespace' }, ctx);
    const identicalResourceOutput = await toolMcpReadResource({ id: 'mcp:demo:resource:identical' }, ctx);
    const promptOutput = await toolMcpGetPrompt({ id: 'mcp:demo:prompt:whitespace' }, ctx);

    expect(callOutput).toContain('Content:\n  tool body\n\n\nMetadata:');
    expect(resourceOutput).toContain('Content:\n\n  resource body\n\n\nStructured content:');
    expect(resourceOutput).toContain('Structured content:\n{"format":"markdown","lines":1}');
    expect(identicalResourceOutput.match(/same body/g)).toHaveLength(1);
    expect(promptOutput).toContain('Content:\n  prompt body\n\n\nArtifacts:');
  });

  it('probes one extra MCP capability and marks an explicit result limit', async () => {
    let requestedLimit: number | undefined;
    const extensionRuntime = {
      searchCapabilities: async (
        _providerId: string,
        _query: string,
        options: { limit?: number },
      ) => {
        requestedLimit = options.limit;
        return [
          { id: 'mcp:demo:tool:one', kind: 'tool', name: 'one' },
          { id: 'mcp:demo:tool:two', kind: 'tool', name: 'two' },
          { id: 'mcp:demo:tool:three', kind: 'tool', name: 'three' },
        ];
      },
    } as unknown as NonNullable<KodaXToolExecutionContext['extensionRuntime']>;

    const output = await toolMcpSearch({ query: 'tool', limit: 2 }, {
      backups: new Map(),
      executionCwd: process.cwd(),
      extensionRuntime,
    });

    expect(requestedLimit).toBe(3);
    expect(output).toContain('RESULT_LIMIT_REACHED');
    expect(output).toContain('[tool] two');
    expect(output).not.toContain('[tool] three');
  });
});
