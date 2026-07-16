import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createKodaXRuntime } from '../sdk-runtime.js';
import { writeIntegrationDocument } from '@kodax-ai/repl';
import {
  createConfiguredA2ARuntimeIntegration,
  discoverA2ARegistration,
  parseA2AIntegrationDocument,
  type A2AIntegrationDocument,
} from './index.js';

const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-a2a-runtime-config-'));
  roots.push(root);
  return root;
}

function card(name: string): Response {
  return new Response(JSON.stringify({
    name,
    description: `${name} description`,
    version: '1.0.0',
    supportedInterfaces: [{
      url: `https://127.0.0.1/${name.toLowerCase()}/a2a`,
      protocolBinding: 'JSONRPC',
      protocolVersion: '1.0',
    }],
    capabilities: { streaming: false },
    securitySchemes: {
      bearer: { httpAuthSecurityScheme: { scheme: 'Bearer', bearerFormat: 'opaque' } },
    },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [{ id: 'general', name: 'General', description: 'General tasks', tags: [] }],
  }), { headers: { 'content-type': 'application/json' } });
}

function writeA2A(configHome: string, document: A2AIntegrationDocument): void {
  writeIntegrationDocument({
    domain: 'a2a',
    configHome,
    document,
    validate: parseA2AIntegrationDocument,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('configured A2A Runtime integration', () => {
  it('registers configured Agents and reconciles add, failure, and removal without restart', async () => {
    const root = tempRoot();
    const configHome = path.join(root, '.kodax');
    const runtimeHome = path.join(root, 'runtime');
    const documents: A2AIntegrationDocument[] = [{
      version: 1,
      agents: {
        alpha: { cardUrl: 'https://127.0.0.1/alpha/card', credentialEnv: 'ALPHA_TOKEN', effect: 'read' },
      },
    }, {
      version: 1,
      agents: {
        alpha: { cardUrl: 'https://127.0.0.1/broken/card', credentialEnv: 'ALPHA_TOKEN', effect: 'write' },
        beta: { cardUrl: 'https://127.0.0.1/beta/card', effect: 'none' },
      },
    }, {
      version: 1,
      agents: { beta: { cardUrl: 'https://127.0.0.1/beta/card', effect: 'none' } },
    }];
    writeA2A(configHome, documents[0]);
    const events: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const name = url.pathname.split('/').filter(Boolean)[0] ?? 'agent';
      if (name === 'broken') throw new Error('secret upstream detail');
      return card(name);
    });
    await expect(discoverA2ARegistration({
      agentId: 'probe',
      agentCardUrl: 'https://127.0.0.1/alpha/card',
      effects: { remote: 'read' },
    }, {
      networkPolicy: {
        allowedOrigins: ['https://127.0.0.1'],
        allowPrivateAddresses: true,
        requestTimeoutMs: 1_000,
        maxResponseBytes: 1_000_000,
        maxRedirects: 0,
      },
      pollIntervalMs: 100,
      fetch: fetchImpl as typeof fetch,
    })).resolves.toEqual(expect.objectContaining({ registration: expect.objectContaining({ agentId: 'probe' }) }));
    const integration = createConfiguredA2ARuntimeIntegration({
      configHome,
      fetch: fetchImpl as typeof fetch,
      onEvent: (message) => events.push(message),
    });
    const runtime = await createKodaXRuntime({
      mode: 'embedded',
      homeDir: runtimeHome,
      externalAgents: integration.runtimeOptions,
    });
    const handle = await integration.start(runtime);
    try {
      expect(await runtime.admin.agentRegistrations.list()).toEqual([
        expect.objectContaining({ agentId: 'external:alpha', credentialConfigured: true }),
      ]);

      writeA2A(configHome, documents[1]);
      await handle.reload();
      const afterFailure = await runtime.admin.agentRegistrations.list();
      expect(afterFailure.map((entry) => entry.agentId).sort()).toEqual(['external:alpha', 'external:beta']);
      expect(afterFailure.find((entry) => entry.agentId === 'external:alpha'))
        .toEqual(expect.objectContaining({ displayName: 'alpha' }));
      expect(events.some((message) => message.includes('alpha') && !message.includes('secret upstream detail'))).toBe(true);

      writeA2A(configHome, documents[2]);
      await handle.reload();
      expect((await runtime.admin.agentRegistrations.list()).map((entry) => entry.agentId)).toEqual(['external:beta']);
    } finally {
      handle.close();
      await runtime.close();
    }
  });
});
