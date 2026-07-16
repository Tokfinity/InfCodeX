import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { Command } from 'commander';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

let configHome = '';
let previousKodaXHome: string | undefined;
let configureIntegrationCommands: typeof import('./integration-cli.js').configureIntegrationCommands;

beforeAll(async () => {
  previousKodaXHome = process.env.KODAX_HOME;
  configHome = path.join(mkdtempSync(path.join(os.tmpdir(), 'kodax-integration-cli-')), '.kodax');
  process.env.KODAX_HOME = configHome;
  vi.resetModules();
  ({ configureIntegrationCommands } = await import('./integration-cli.js'));
});

afterAll(() => {
  if (previousKodaXHome === undefined) delete process.env.KODAX_HOME;
  else process.env.KODAX_HOME = previousKodaXHome;
  rmSync(path.dirname(configHome), { recursive: true, force: true });
});

async function runCommand(args: readonly string[]): Promise<string> {
  const program = new Command().exitOverride();
  program.name('kodax');
  configureIntegrationCommands(program, { version: '0.7.69' });
  let output = '';
  const writer = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    output += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  });
  try {
    await program.parseAsync(['node', 'kodax', ...args]);
    return output;
  } finally {
    writer.mockRestore();
  }
}

describe('integration CLI', () => {
  it('prints a canonical template without creating active or example files', async () => {
    const output = await runCommand(['config', 'template', 'a2a']);

    expect(output).toContain('"agents": {}');
    expect(existsSync(configHome)).toBe(false);
  });

  it('adds, lists, and removes an MCP server through the split domain file', async () => {
    await runCommand(['mcp', 'add', 'local', '--command', 'node', '--arg', 'server.mjs']);
    const listed = JSON.parse(await runCommand(['mcp', 'list'])) as Record<string, unknown>;
    expect(listed).toMatchObject({
      local: { type: 'stdio', command: 'node', args: ['server.mjs'], connect: 'lazy' },
    });

    await runCommand(['mcp', 'remove', 'local']);
    expect(JSON.parse(await runCommand(['mcp', 'list']))).toEqual({});
  });

  it('creates an inert authenticated A2A server declaration without persisting a token', async () => {
    await runCommand([
      'a2a', 'expose', '--name', 'Demo Agent', '--description', 'General document work',
      '--token-env', 'DEMO_A2A_TOKEN',
    ]);

    const raw = readFileSync(path.join(configHome, 'integrations', 'a2a.json'), 'utf8');
    expect(raw).toContain('"tokenEnv": "DEMO_A2A_TOKEN"');
    expect(raw).not.toContain('secret-token');
    expect(JSON.parse(raw)).toMatchObject({
      server: {
        execution: { kind: 'runtime-default', workspace: { mode: 'managed' } },
        published: { name: 'Demo Agent' },
      },
    });
  });

  it('validates a named user Markdown Agent before publishing its reference', async () => {
    await expect(runCommand(['a2a', 'expose', 'missing-agent']))
      .rejects.toThrow(/not found/i);
    const agents = path.join(configHome, 'agents');
    mkdirSync(agents, { recursive: true });
    writeFileSync(path.join(agents, 'office-agent.md'), [
      '---',
      'name: office-agent',
      'description: Office work',
      '---',
      'Complete general office tasks.',
    ].join('\n'), 'utf8');

    await runCommand(['a2a', 'expose', 'office-agent']);
    const document = JSON.parse(
      readFileSync(path.join(configHome, 'integrations', 'a2a.json'), 'utf8'),
    ) as { readonly server: { readonly execution: unknown } };
    expect(document.server.execution).toMatchObject({
      kind: 'local-agent',
      agentRef: { source: 'markdown:user', name: 'office-agent' },
    });
  });

  it('rejects non-loopback use of the built-in A2A listener', async () => {
    await expect(runCommand(['a2a', 'serve', '--host', '0.0.0.0']))
      .rejects.toThrow(/loopback-only/i);
  });

  it('requires explicit apply before legacy cleanup', async () => {
    await expect(runCommand(['integrations', 'migrate', '--cleanup-legacy']))
      .rejects.toThrow(/requires --apply/i);
  });

  it('reports split paths and validates every current domain snapshot', async () => {
    const paths = JSON.parse(await runCommand(['config', 'paths'])) as {
      readonly home: string;
      readonly integrationExamples: Record<string, string>;
    };
    expect(paths.home).toBe(configHome);
    expect(Object.keys(paths.integrationExamples).sort()).toEqual(['a2a', 'extensions', 'mcp']);

    const status = JSON.parse(await runCommand(['integrations', 'status'])) as Array<{
      readonly domain: string;
    }>;
    expect(status.map((entry) => entry.domain)).toEqual(['mcp', 'a2a', 'extensions']);
    await expect(runCommand(['integrations', 'validate'])).resolves.toContain('"ok": true');
    await expect(runCommand(['integrations', 'reload'])).resolves.toContain('"ok": true');
    await expect(runCommand(['config', 'template', 'unknown'])).rejects.toThrow(/unknown/i);
  });

  it('validates MCP command shape and supports an HTTP transport declaration', async () => {
    await expect(runCommand(['mcp', 'add', 'invalid'])).rejects.toThrow(/exactly one/i);
    await expect(runCommand([
      'mcp', 'add', 'invalid', '--command', 'node', '--url', 'https://mcp.example.com',
    ])).rejects.toThrow(/exactly one/i);

    await runCommand([
      'mcp', 'add', 'remote', '--url', 'https://mcp.example.com/api',
      '--transport', 'streamable-http', '--connect', 'prewarm',
    ]);
    expect(JSON.parse(await runCommand(['mcp', 'list']))).toMatchObject({
      remote: {
        type: 'streamable-http', url: 'https://mcp.example.com/api', connect: 'prewarm',
      },
    });
    await runCommand(['mcp', 'remove', 'remote']);
  });

  it('validates, stores, reloads, and removes an Extension entrypoint', async () => {
    const extensionDir = path.join(path.dirname(configHome), 'demo-extension');
    mkdirSync(extensionDir, { recursive: true });
    const entrypoint = path.join(extensionDir, 'extension.mjs');
    writeFileSync(entrypoint, 'export default function activate() {}\n', 'utf8');

    await runCommand(['extensions', 'add', extensionDir]);
    expect(JSON.parse(await runCommand(['extensions', 'list']))).toEqual([entrypoint]);
    await expect(runCommand(['extensions', 'reload'])).resolves.toContain('"validated": 1');
    await expect(runCommand(['extensions', 'remove', extensionDir]))
      .resolves.toContain('"removed": true');
    expect(JSON.parse(await runCommand(['extensions', 'list']))).toEqual([]);
  });

  it('calls a configured loopback A2A Agent without application code', async () => {
    let baseUrl = '';
    let getTaskCalls = 0;
    const methods: string[] = [];
    const server = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/card') {
        response.end(JSON.stringify({
          name: 'Loopback Agent',
          description: 'Local deterministic Agent',
          version: '1.0.0',
          supportedInterfaces: [{
            url: `${baseUrl}/rpc`, protocolBinding: 'JSONRPC', protocolVersion: '1.0',
          }],
          capabilities: { streaming: false },
          defaultInputModes: ['text/plain'],
          defaultOutputModes: ['text/plain'],
          skills: [{ id: 'general', name: 'General', description: 'General tasks', tags: [] }],
        }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        readonly id: string;
        readonly method: string;
      };
      methods.push(payload.method);
      if (payload.method === 'SendMessage') {
        response.end(JSON.stringify({
          jsonrpc: '2.0', id: payload.id,
          result: {
            task: {
              id: 'task-1', contextId: 'context-1',
              status: { state: 'TASK_STATE_SUBMITTED' },
            },
          },
        }));
        return;
      }
      getTaskCalls += 1;
      response.end(JSON.stringify({
        jsonrpc: '2.0', id: payload.id,
        result: {
          id: 'task-1', contextId: 'context-1',
          status: getTaskCalls === 1
            ? { state: 'TASK_STATE_WORKING' }
            : {
                state: 'TASK_STATE_COMPLETED',
                message: {
                  messageId: 'result-1', role: 'ROLE_AGENT',
                  parts: [{ text: 'completed', mediaType: 'text/plain' }],
                },
              },
        },
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await runCommand(['a2a', 'add', 'loopback', `${baseUrl}/card`, '--no-test']);
      await expect(runCommand(['a2a', 'test', 'loopback']))
        .resolves.toContain('Loopback Agent');
      await expect(runCommand(['a2a', 'call', 'loopback', 'Prepare report']))
        .resolves.toContain('completed');
      expect(methods).toEqual(expect.arrayContaining(['SendMessage', 'GetTask']));
      await expect(runCommand(['a2a', 'remove', 'loopback']))
        .resolves.toContain('"removed": true');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (
        error ? reject(error) : resolve()
      )));
    }
  });

  it('rejects invalid A2A policy arguments before changing server config', async () => {
    await expect(runCommand(['a2a', 'add', 'bad', 'https://agents.example.com', '--effect', 'delete']))
      .rejects.toThrow(/effect/i);
    await expect(runCommand(['a2a', 'expose', '--workspace-mode', 'fixed']))
      .rejects.toThrow(/workspace-root/i);
    await expect(runCommand(['a2a', 'expose', '--workspace-mode', 'shared']))
      .rejects.toThrow(/workspace-mode/i);
    await expect(runCommand(['a2a', 'expose', '--workspace-access', 'execute']))
      .rejects.toThrow(/workspace-access/i);
    await expect(runCommand(['a2a', 'expose', '--mcp', 'missing-separator']))
      .rejects.toThrow(/name:value/i);
  });
});
