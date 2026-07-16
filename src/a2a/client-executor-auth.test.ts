import { describe, expect, it, vi } from 'vitest';
import {
  createAgentExecutorPlane,
  createMemoryAgentExecutorPlaneStore,
  setKodaXDiagnosticSink,
  type AgentArtifactReference,
  type AgentExecutorEvent,
  type KodaXDiagnostic,
} from '@kodax-ai/agent';

import { createA2AAgentExecutorFactory, discoverA2ARegistration } from './client-executor.js';
import type { A2AClientAuthenticationInput } from './types.js';

const CARD_ORIGIN = 'http://127.0.0.1:43190';
const TOKEN_ORIGIN = 'http://127.0.0.1:43191';

function card() {
  return {
    name: 'OAuth Agent',
    description: 'OAuth Agent',
    version: '1.0.0',
    supportedInterfaces: [{
      url: `${CARD_ORIGIN}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0',
    }],
    capabilities: {},
    securitySchemes: {
      enterprise: {
        oauth2SecurityScheme: {
          flows: {
            clientCredentials: {
              tokenUrl: `${TOKEN_ORIGIN}/token`,
              scopes: { 'a2a.invoke': 'Invoke the Agent' },
            },
          },
        },
      },
    },
    securityRequirements: [{ schemes: { enterprise: { list: ['a2a.invoke'] } } }],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [],
  };
}

function options(fetchImpl: typeof fetch) {
  return {
    fetch: fetchImpl,
    pollIntervalMs: 10,
    networkPolicy: {
      allowedOrigins: [CARD_ORIGIN, TOKEN_ORIGIN],
      allowPrivateAddresses: true,
      requestTimeoutMs: 1_000,
      maxResponseBytes: 64 * 1024,
      maxRedirects: 0,
    },
  } as const;
}

describe('A2A outbound authentication planning', () => {
  it('keeps Card discovery small while allowing a separately bounded task response', async () => {
    const output = 'x'.repeat(80 * 1024);
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes('.well-known/agent-card.json')) {
        return Response.json({ ...card(), securitySchemes: {}, securityRequirements: [] });
      }
      const request = JSON.parse(String(init?.body)) as { readonly id: string };
      return Response.json({
        jsonrpc: '2.0', id: request.id,
        result: { message: { messageId: 'large-reply', role: 'ROLE_AGENT', parts: [{ text: output }] } },
      });
    });
    const clientOptions = {
      ...options(fetchImpl),
      maxTaskResponseBytes: 128 * 1024,
    } as const;
    const discovered = await discoverA2ARegistration({
      agentId: 'external:large-task-response',
      agentCardUrl: `${CARD_ORIGIN}/.well-known/agent-card.json`,
      effects: { remote: 'read' },
    }, clientOptions);
    const executor = await createA2AAgentExecutorFactory(clientOptions).create(discovered.registration, {
      async withCredential(_reference, use) { return use('unused'); },
      async authorizeArtifact() {},
    });
    const reference = await executor.start({
      agentId: discovered.registration.agentId,
      objective: 'large response',
      idempotencyKey: 'large-task-response',
      context: { actorId: 'test' },
    });
    const events: AgentExecutorEvent[] = [];
    for await (const event of executor.events(reference)) events.push(event);
    expect(events.at(-1)?.output?.length).toBe(output.length);
    await executor.dispose();
  });

  it('obtains a dynamic token and refreshes it once after a 401 response', async () => {
    const seen: Array<{ readonly url: string; readonly authorization: string | null }> = [];
    let tokenRequests = 0;
    let rpcRequests = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      seen.push({ url, authorization: new Headers(init?.headers).get('authorization') });
      if (url.includes('.well-known/agent-card.json')) {
        return Response.json(card());
      }
      if (url === `${TOKEN_ORIGIN}/token`) {
        expect(await new Request(input, init).text()).toContain('grant_type=client_credentials');
        tokenRequests += 1;
        return Response.json({
          access_token: `dynamic-token-${tokenRequests}`, token_type: 'Bearer', expires_in: 120,
        });
      }
      const request = JSON.parse(String(init?.body)) as { readonly id: string };
      rpcRequests += 1;
      if (rpcRequests === 1) {
        return Response.json({
          jsonrpc: '2.0', id: request.id, error: { code: -32600, message: 'invalid token' },
        }, { status: 401 });
      }
      return Response.json({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          message: {
            messageId: 'reply', role: 'ROLE_AGENT',
            parts: [{ text: 'reflected dynamic-token-1 and Bearer dynamic-token-2' }],
          },
        },
      });
    });
    const discovered = await discoverA2ARegistration({
      agentId: 'external:oauth',
      agentCardUrl: `${CARD_ORIGIN}/.well-known/agent-card.json`,
      authentication: {
        type: 'oauth2-client-credentials',
        scheme: 'enterprise',
        issuer: `${TOKEN_ORIGIN}/`,
        tokenUrl: `${TOKEN_ORIGIN}/token`,
        clientId: 'kodax-client',
        clientSecretRef: 'env:OAUTH_CLIENT_SECRET',
        scopes: ['a2a.invoke'],
        clientAuthentication: 'client-secret-basic',
      },
      effects: { remote: 'read' },
    }, options(fetchImpl));
    const plane = await createAgentExecutorPlane({
      factories: [createA2AAgentExecutorFactory(options(fetchImpl))],
      policy: () => ({ allowed: true }),
      credentialBroker: {
        isAvailable: () => true,
        async withCredential(reference, use) {
          expect(reference).toBe('env:OAUTH_CLIENT_SECRET');
          return use('local-client-secret');
        },
      },
      store: createMemoryAgentExecutorPlaneStore(),
    });
    await plane.registrations.upsert(discovered.registration);
    const completed = await plane.tasks.start({
      agentId: discovered.registration.agentId,
      objective: 'do work',
      input: 'do work',
      taskId: 'oauth-task',
      idempotencyKey: 'oauth-message',
      context: { actorId: 'test' },
    });

    expect(seen.filter((entry) => entry.url === `${CARD_ORIGIN}/a2a`).map((entry) => entry.authorization))
      .toEqual(['Bearer dynamic-token-1', 'Bearer dynamic-token-2']);
    expect(tokenRequests).toBe(2);
    expect(JSON.stringify(completed)).not.toContain('dynamic-token-1');
    expect(JSON.stringify(completed)).not.toContain('dynamic-token-2');
    expect(JSON.stringify(await plane.tasks.events(completed.taskId))).not.toContain('dynamic-token');
    expect(JSON.stringify(discovered.registration)).not.toContain('local-client-secret');
    await plane.close();
  });

  it('coalesces refresh when concurrent late 401 responses reject the same OAuth token', async () => {
    let releaseLateRejection: (() => void) | undefined;
    const lateRejection = new Promise<void>((resolve) => { releaseLateRejection = resolve; });
    let tokenRequests = 0;
    let oldRpcRequests = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes('.well-known/agent-card.json')) return Response.json(card());
      if (url === `${TOKEN_ORIGIN}/token`) {
        tokenRequests += 1;
        return Response.json({
          access_token: tokenRequests === 1 ? 'shared-old-token' : 'shared-fresh-token',
          token_type: 'Bearer',
          expires_in: 120,
        });
      }
      const request = JSON.parse(String(init?.body)) as { readonly id: string };
      const authorization = new Headers(init?.headers).get('authorization');
      if (authorization === 'Bearer shared-old-token') {
        oldRpcRequests += 1;
        if (oldRpcRequests === 2) await lateRejection;
        return Response.json({
          jsonrpc: '2.0', id: request.id,
          error: { code: -32600, message: 'old token rejected' },
        }, { status: 401 });
      }
      releaseLateRejection?.();
      return Response.json({
        jsonrpc: '2.0', id: request.id,
        result: {
          message: { messageId: `reply-${request.id}`, role: 'ROLE_AGENT', parts: [{ text: 'done' }] },
        },
      });
    });
    const discovered = await discoverA2ARegistration({
      agentId: 'external:oauth-concurrent',
      agentCardUrl: `${CARD_ORIGIN}/.well-known/agent-card.json`,
      authentication: {
        type: 'oauth2-client-credentials', scheme: 'enterprise', issuer: `${TOKEN_ORIGIN}/`,
        tokenUrl: `${TOKEN_ORIGIN}/token`, clientId: 'kodax-client',
        clientSecretRef: 'env:OAUTH_CLIENT_SECRET', scopes: ['a2a.invoke'],
        clientAuthentication: 'client-secret-basic',
      },
      effects: { remote: 'read' },
    }, options(fetchImpl));
    const executor = await createA2AAgentExecutorFactory(options(fetchImpl)).create(
      discovered.registration,
      {
        async withCredential(_reference, use) { return use('local-client-secret'); },
        async authorizeArtifact() {},
      },
    );

    await expect(Promise.all([
      executor.start({
        agentId: discovered.registration.agentId, objective: 'first', input: 'first',
        idempotencyKey: 'first-message', context: { actorId: 'test' },
      }),
      executor.start({
        agentId: discovered.registration.agentId, objective: 'second', input: 'second',
        idempotencyKey: 'second-message', context: { actorId: 'test' },
      }),
    ])).resolves.toHaveLength(2);
    expect(oldRpcRequests).toBe(2);
    expect(tokenRequests).toBe(2);
    await executor.dispose();
  });

  it('releases the cached OAuth token when the last executor for an Agent is disposed', async () => {
    let tokenRequests = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes('.well-known/agent-card.json')) return Response.json(card());
      if (url === `${TOKEN_ORIGIN}/token`) {
        tokenRequests += 1;
        return Response.json({
          access_token: `lifecycle-token-${tokenRequests}`,
          token_type: 'Bearer',
          expires_in: 120,
        });
      }
      const request = JSON.parse(String(init?.body)) as { readonly id: string };
      return Response.json({
        jsonrpc: '2.0', id: request.id,
        result: {
          message: { messageId: request.id, role: 'ROLE_AGENT', parts: [{ text: 'done' }] },
        },
      });
    });
    const discovered = await discoverA2ARegistration({
      agentId: 'external:oauth-disposal',
      agentCardUrl: `${CARD_ORIGIN}/.well-known/agent-card.json`,
      authentication: {
        type: 'oauth2-client-credentials', scheme: 'enterprise', issuer: `${TOKEN_ORIGIN}/`,
        tokenUrl: `${TOKEN_ORIGIN}/token`, clientId: 'kodax-client',
        clientSecretRef: 'env:OAUTH_CLIENT_SECRET', scopes: ['a2a.invoke'],
        clientAuthentication: 'client-secret-basic',
      },
      effects: { remote: 'read' },
    }, options(fetchImpl));
    const factory = createA2AAgentExecutorFactory(options(fetchImpl));
    const context = {
      async withCredential<T>(_reference: string, use: (credential: string) => Promise<T>) {
        return use('local-client-secret');
      },
      async authorizeArtifact() {},
    };
    const input = {
      agentId: discovered.registration.agentId,
      objective: 'lifecycle',
      input: 'lifecycle',
      context: { actorId: 'test' },
    } as const;

    const first = await factory.create(discovered.registration, context);
    const shared = await factory.create(discovered.registration, context);
    await first.start({ ...input, idempotencyKey: 'lifecycle-first' });
    await first.dispose();
    await shared.start({ ...input, idempotencyKey: 'lifecycle-shared' });
    expect(tokenRequests).toBe(1);
    await shared.dispose();
    const second = await factory.create(discovered.registration, context);
    await second.start({ ...input, idempotencyKey: 'lifecycle-second' });

    expect(tokenRequests).toBe(2);
    await second.dispose();
  });

  it('rebuilds the OAuth token manager when a resolver changes its trusted fetch transport', async () => {
    const tokenRequests = { first: 0, second: 0 };
    const seenRpcAuthorizations: string[] = [];
    const transport = (name: 'first' | 'second') => vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes('.well-known/agent-card.json')) return Response.json(card());
      if (url === `${TOKEN_ORIGIN}/token`) {
        tokenRequests[name] += 1;
        return Response.json({ access_token: `${name}-token`, token_type: 'Bearer', expires_in: 120 });
      }
      const request = JSON.parse(String(init?.body)) as { readonly id: string };
      seenRpcAuthorizations.push(new Headers(init?.headers).get('authorization') ?? '');
      return Response.json({
        jsonrpc: '2.0', id: request.id,
        result: { message: { messageId: `${name}-reply`, role: 'ROLE_AGENT', parts: [{ text: 'done' }] } },
      });
    });
    const firstFetch = transport('first');
    const secondFetch = transport('second');
    const discovered = await discoverA2ARegistration({
      agentId: 'external:oauth-transport-policy',
      agentCardUrl: `${CARD_ORIGIN}/.well-known/agent-card.json`,
      authentication: {
        type: 'oauth2-client-credentials', scheme: 'enterprise', issuer: `${TOKEN_ORIGIN}/`,
        tokenUrl: `${TOKEN_ORIGIN}/token`, clientId: 'kodax-client',
        clientSecretRef: 'env:OAUTH_CLIENT_SECRET', scopes: ['a2a.invoke'],
        clientAuthentication: 'client-secret-basic',
      },
      effects: { remote: 'read' },
    }, options(firstFetch));
    let activeOptions = options(firstFetch);
    const factory = createA2AAgentExecutorFactory(() => activeOptions);
    const context = {
      async withCredential<T>(_reference: string, use: (credential: string) => Promise<T>) {
        return use('local-client-secret');
      },
      async authorizeArtifact() {},
    };
    const input = {
      agentId: discovered.registration.agentId, objective: 'transport isolation', input: 'run',
      idempotencyKey: 'transport-isolation', context: { actorId: 'test' },
    } as const;

    const firstExecutor = await factory.create(discovered.registration, context);
    await firstExecutor.start(input);
    activeOptions = options(secondFetch);
    const secondExecutor = await factory.create(discovered.registration, context);
    await secondExecutor.start({ ...input, idempotencyKey: 'transport-isolation-2' });

    expect(tokenRequests).toEqual({ first: 1, second: 1 });
    expect(seenRpcAuthorizations).toEqual(['Bearer first-token', 'Bearer second-token']);
    await firstExecutor.dispose();
    await secondExecutor.dispose();
  });

  it('applies a resolver-tightened network policy to subsequent OAuth token requests', async () => {
    let tokenRequests = 0;
    let firstTokenRpcRequests = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes('.well-known/agent-card.json')) return Response.json(card());
      if (url === `${TOKEN_ORIGIN}/token`) {
        tokenRequests += 1;
        return Response.json({
          access_token: `policy-token-${tokenRequests}`, token_type: 'Bearer', expires_in: 120,
          ...(tokenRequests === 2 ? { padding: 'x'.repeat(1_024) } : {}),
        });
      }
      const request = JSON.parse(String(init?.body)) as { readonly id: string };
      const authorization = new Headers(init?.headers).get('authorization');
      if (authorization === 'Bearer policy-token-1') {
        firstTokenRpcRequests += 1;
        if (firstTokenRpcRequests === 2) {
          return Response.json({
            jsonrpc: '2.0', id: request.id, error: { code: -32600, message: 'token rejected' },
          }, { status: 401 });
        }
      }
      return Response.json({
        jsonrpc: '2.0', id: request.id,
        result: { message: { messageId: 'policy-reply', role: 'ROLE_AGENT', parts: [{ text: 'done' }] } },
      });
    });
    const discovered = await discoverA2ARegistration({
      agentId: 'external:oauth-network-policy',
      agentCardUrl: `${CARD_ORIGIN}/.well-known/agent-card.json`,
      authentication: {
        type: 'oauth2-client-credentials', scheme: 'enterprise', issuer: `${TOKEN_ORIGIN}/`,
        tokenUrl: `${TOKEN_ORIGIN}/token`, clientId: 'kodax-client',
        clientSecretRef: 'env:OAUTH_CLIENT_SECRET', scopes: ['a2a.invoke'],
        clientAuthentication: 'client-secret-basic',
      },
      effects: { remote: 'read' },
    }, options(fetchImpl));
    let maxResponseBytes = 64 * 1_024;
    const factory = createA2AAgentExecutorFactory(() => ({
      ...options(fetchImpl),
      networkPolicy: { ...options(fetchImpl).networkPolicy, maxResponseBytes },
    }));
    const context = {
      async withCredential<T>(_reference: string, use: (credential: string) => Promise<T>) {
        return use('local-client-secret');
      },
      async authorizeArtifact() {},
    };
    const input = {
      agentId: discovered.registration.agentId, objective: 'policy tightening', input: 'run',
      idempotencyKey: 'policy-tightening', context: { actorId: 'test' },
    } as const;

    const firstExecutor = await factory.create(discovered.registration, context);
    await firstExecutor.start(input);
    maxResponseBytes = 512;
    const secondExecutor = await factory.create(discovered.registration, context);

    await expect(secondExecutor.start({ ...input, idempotencyKey: 'policy-tightening-2' }))
      .rejects.toThrow(/token request failed/i);
    expect(tokenRequests).toBe(2);
    await firstExecutor.dispose();
    await secondExecutor.dispose();
  });

  it('does not retry a second OAuth-authenticated 401 response', async () => {
    let tokenRequests = 0;
    let rpcRequests = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('.well-known/agent-card.json')) return Response.json(card());
      if (url === `${TOKEN_ORIGIN}/token`) {
        tokenRequests += 1;
        return Response.json({
          access_token: `rejected-token-${tokenRequests}`,
          token_type: 'Bearer',
          expires_in: 120,
        });
      }
      rpcRequests += 1;
      return Response.json({
        jsonrpc: '2.0', id: 'rpc', error: { code: -32600, message: 'invalid token' },
      }, { status: 401 });
    });
    const discovered = await discoverA2ARegistration({
      agentId: 'external:oauth-rejected',
      agentCardUrl: `${CARD_ORIGIN}/.well-known/agent-card.json`,
      authentication: {
        type: 'oauth2-client-credentials',
        scheme: 'enterprise',
        issuer: `${TOKEN_ORIGIN}/`,
        tokenUrl: `${TOKEN_ORIGIN}/token`,
        clientId: 'kodax-client',
        clientSecretRef: 'env:OAUTH_CLIENT_SECRET',
        scopes: ['a2a.invoke'],
        clientAuthentication: 'client-secret-basic',
      },
      effects: { remote: 'read' },
    }, options(fetchImpl));
    const plane = await createAgentExecutorPlane({
      factories: [createA2AAgentExecutorFactory(options(fetchImpl))],
      policy: () => ({ allowed: true }),
      credentialBroker: {
        async withCredential(_reference, use) { return use('local-client-secret'); },
      },
      store: createMemoryAgentExecutorPlaneStore(),
    });
    await plane.registrations.upsert(discovered.registration);

    await expect(plane.tasks.start({
      agentId: discovered.registration.agentId,
      objective: 'do work',
      input: 'do work',
      taskId: 'oauth-rejected-task',
      idempotencyKey: 'oauth-rejected-message',
      context: { actorId: 'test' },
    })).resolves.toMatchObject({ state: 'failed' });
    expect(tokenRequests).toBe(2);
    expect(rpcRequests).toBe(2);
    await plane.close();
  });

  it('redacts a reflected dynamic access token from persisted task failures', async () => {
    const reflectedToken = 'reflected-access-token';
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes('.well-known/agent-card.json')) return Response.json(card());
      if (url === `${TOKEN_ORIGIN}/token`) {
        return Response.json({ access_token: reflectedToken, token_type: 'Bearer', expires_in: 120 });
      }
      const request = JSON.parse(String(init?.body)) as { readonly id: string };
      return Response.json({
        jsonrpc: '2.0', id: request.id,
        error: { code: -32603, message: `upstream reflected ${reflectedToken}` },
      });
    });
    const discovered = await discoverA2ARegistration({
      agentId: 'external:oauth-reflection',
      agentCardUrl: `${CARD_ORIGIN}/.well-known/agent-card.json`,
      authentication: {
        type: 'oauth2-client-credentials',
        scheme: 'enterprise',
        issuer: `${TOKEN_ORIGIN}/`,
        tokenUrl: `${TOKEN_ORIGIN}/token`,
        clientId: 'kodax-client',
        clientSecretRef: 'env:OAUTH_CLIENT_SECRET',
        scopes: ['a2a.invoke'],
        clientAuthentication: 'client-secret-basic',
      },
      effects: { remote: 'read' },
    }, options(fetchImpl));
    const plane = await createAgentExecutorPlane({
      factories: [createA2AAgentExecutorFactory(options(fetchImpl))],
      policy: () => ({ allowed: true }),
      credentialBroker: {
        async withCredential(_reference, use) { return use('local-client-secret'); },
      },
      store: createMemoryAgentExecutorPlaneStore(),
    });
    await plane.registrations.upsert(discovered.registration);
    const failed = await plane.tasks.start({
      agentId: discovered.registration.agentId,
      objective: 'do work',
      input: 'do work',
      taskId: 'oauth-reflection-task',
      idempotencyKey: 'oauth-reflection-message',
      context: { actorId: 'test' },
    });

    expect(failed.state).toBe('failed');
    expect(JSON.stringify(failed)).not.toContain(reflectedToken);
    expect(JSON.stringify(await plane.tasks.events(failed.taskId))).not.toContain(reflectedToken);
    expect(failed.error).toContain('[REDACTED]');
    await plane.close();
  });

  it('redacts current authorization values from successful messages, tasks, and artifacts', async () => {
    const accessToken = 'successful-reflection-token';
    const authorization = `Bearer ${accessToken}`;
    const authorizedArtifacts: AgentArtifactReference[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes('.well-known/agent-card.json')) return Response.json(card());
      if (url === `${TOKEN_ORIGIN}/token`) {
        return Response.json({ access_token: accessToken, token_type: 'Bearer', expires_in: 120 });
      }
      const request = JSON.parse(String(init?.body)) as {
        readonly id: string;
        readonly method: string;
      };
      if (request.method === 'SendMessage') {
        return Response.json({
          jsonrpc: '2.0', id: request.id,
          result: {
            message: {
              messageId: 'reflected-message', role: 'ROLE_AGENT',
              parts: [{ text: `message echoed ${authorization} and ${accessToken}` }],
            },
          },
        });
      }
      return Response.json({
        jsonrpc: '2.0', id: request.id,
        result: {
          id: 'reflected-task', contextId: 'reflected-context',
          status: {
            state: 'TASK_STATE_COMPLETED',
            message: {
              messageId: 'status-message', role: 'ROLE_AGENT',
              parts: [{ text: `status echoed ${accessToken}` }],
            },
          },
          artifacts: [
            {
              artifactId: 'text-artifact', name: `artifact-${authorization}`,
              parts: [{ text: `artifact echoed ${accessToken}` }],
            },
            {
              artifactId: 'data-artifact',
              parts: [{ data: { echoed: authorization }, mediaType: 'application/json' }],
            },
          ],
        },
      });
    });
    const discovered = await discoverA2ARegistration({
      agentId: 'external:oauth-success-reflection',
      agentCardUrl: `${CARD_ORIGIN}/.well-known/agent-card.json`,
      authentication: {
        type: 'oauth2-client-credentials', scheme: 'enterprise', issuer: `${TOKEN_ORIGIN}/`,
        tokenUrl: `${TOKEN_ORIGIN}/token`, clientId: 'kodax-client',
        clientSecretRef: 'env:OAUTH_CLIENT_SECRET', scopes: ['a2a.invoke'],
        clientAuthentication: 'client-secret-basic',
      },
      effects: { remote: 'read' },
    }, options(fetchImpl));
    const executor = await createA2AAgentExecutorFactory(options(fetchImpl)).create(
      discovered.registration,
      {
        async withCredential(_reference, use) { return use('local-client-secret'); },
        async authorizeArtifact(artifact) { authorizedArtifacts.push(artifact); },
      },
    );

    const directReference = await executor.start({
      agentId: discovered.registration.agentId, objective: 'message', input: 'message',
      idempotencyKey: 'message-reflection', context: { actorId: 'test' },
    });
    const directEvents: AgentExecutorEvent[] = [];
    for await (const event of executor.events(directReference)) directEvents.push(event);
    const taskSnapshot = await executor.get({
      idempotencyKey: 'task-reflection', remoteTaskId: 'reflected-task',
      metadata: { contextId: 'reflected-context' },
    });

    expect(JSON.stringify({ directReference, directEvents, taskSnapshot, authorizedArtifacts }))
      .not.toContain(accessToken);
    expect(JSON.stringify({ directReference, directEvents, taskSnapshot, authorizedArtifacts }))
      .toContain('[REDACTED]');
    await executor.dispose();
  });

  it('redacts authorization values from SSE events and stream transport diagnostics', async () => {
    const accessToken = 'stream-reflection-token';
    const authorization = `Bearer ${accessToken}`;
    let releaseTransportFailure: (() => void) | undefined;
    const transportFailure = new Promise<void>((resolve) => { releaseTransportFailure = resolve; });
    const diagnostics: KodaXDiagnostic[] = [];
    const restoreDiagnostics = setKodaXDiagnosticSink((diagnostic) => diagnostics.push(diagnostic));
    let sentEvent = false;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes('.well-known/agent-card.json')) {
        return Response.json({ ...card(), capabilities: { streaming: true } });
      }
      if (url === `${TOKEN_ORIGIN}/token`) {
        return Response.json({ access_token: accessToken, token_type: 'Bearer', expires_in: 120 });
      }
      const request = JSON.parse(String(init?.body)) as {
        readonly id: string;
        readonly method: string;
      };
      if (request.method === 'SubscribeToTask') {
        return new Response(new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (!sentEvent) {
              sentEvent = true;
              controller.enqueue(new TextEncoder().encode(
                `data: ${JSON.stringify({
                  jsonrpc: '2.0', id: request.id,
                  result: {
                    statusUpdate: {
                      taskId: 'stream-task', contextId: 'stream-context',
                      status: {
                        state: 'TASK_STATE_WORKING',
                        message: {
                          messageId: 'stream-status', role: 'ROLE_AGENT',
                          parts: [{ text: `event echoed ${accessToken}` }],
                        },
                      },
                    },
                  },
                })}\n\n`,
              ));
              return;
            }
            await transportFailure;
            controller.error(new Error(`stream transport echoed ${authorization}`));
          },
        }), { headers: { 'content-type': 'text/event-stream' } });
      }
      return Response.json({
        jsonrpc: '2.0', id: request.id,
        result: {
          id: 'stream-task', contextId: 'stream-context',
          status: { state: 'TASK_STATE_COMPLETED' },
        },
      });
    });

    try {
      const discovered = await discoverA2ARegistration({
        agentId: 'external:oauth-stream-reflection',
        agentCardUrl: `${CARD_ORIGIN}/.well-known/agent-card.json`,
        authentication: {
          type: 'oauth2-client-credentials', scheme: 'enterprise', issuer: `${TOKEN_ORIGIN}/`,
          tokenUrl: `${TOKEN_ORIGIN}/token`, clientId: 'kodax-client',
          clientSecretRef: 'env:OAUTH_CLIENT_SECRET', scopes: ['a2a.invoke'],
          clientAuthentication: 'client-secret-basic',
        },
        effects: { remote: 'read' },
      }, options(fetchImpl));
      const executor = await createA2AAgentExecutorFactory(options(fetchImpl)).create(
        discovered.registration,
        {
          async withCredential(_reference, use) { return use('local-client-secret'); },
          async authorizeArtifact() {},
        },
      );
      const iterator = executor.events({
        idempotencyKey: 'stream-reflection', remoteTaskId: 'stream-task',
        metadata: { contextId: 'stream-context' },
      })[Symbol.asyncIterator]();

      const streamed = await iterator.next();
      expect(JSON.stringify(streamed)).not.toContain(accessToken);
      expect(JSON.stringify(streamed)).toContain('[REDACTED]');
      releaseTransportFailure?.();
      const fallback = await iterator.next();
      const completed = await iterator.next();

      const diagnosticText = diagnostics.map((diagnostic) => (
        diagnostic.detail instanceof Error
          ? diagnostic.detail.message
          : JSON.stringify(diagnostic.detail)
      )).join('\n');
      expect(JSON.stringify({ fallback, completed })).not.toContain(accessToken);
      expect(diagnosticText).not.toContain(accessToken);
      expect(diagnosticText).toContain('[REDACTED]');
      await executor.dispose();
    } finally {
      restoreDiagnostics();
    }
  });

  it('redacts authorization values from SSE JSON-RPC errors before diagnostics', async () => {
    const accessToken = 'stream-error-token';
    const diagnostics: KodaXDiagnostic[] = [];
    const restoreDiagnostics = setKodaXDiagnosticSink((diagnostic) => diagnostics.push(diagnostic));
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes('.well-known/agent-card.json')) {
        return Response.json({ ...card(), capabilities: { streaming: true } });
      }
      if (url === `${TOKEN_ORIGIN}/token`) {
        return Response.json({ access_token: accessToken, token_type: 'Bearer', expires_in: 120 });
      }
      const request = JSON.parse(String(init?.body)) as {
        readonly id: string;
        readonly method: string;
      };
      if (request.method === 'SubscribeToTask') {
        return new Response(
          `data: ${JSON.stringify({
            jsonrpc: '2.0', id: request.id,
            error: { code: -32603, message: `stream error echoed Bearer ${accessToken}` },
          })}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return Response.json({
        jsonrpc: '2.0', id: request.id,
        result: {
          id: 'stream-error-task', contextId: 'stream-error-context',
          status: { state: 'TASK_STATE_COMPLETED' },
        },
      });
    });

    try {
      const discovered = await discoverA2ARegistration({
        agentId: 'external:oauth-stream-error',
        agentCardUrl: `${CARD_ORIGIN}/.well-known/agent-card.json`,
        authentication: {
          type: 'oauth2-client-credentials', scheme: 'enterprise', issuer: `${TOKEN_ORIGIN}/`,
          tokenUrl: `${TOKEN_ORIGIN}/token`, clientId: 'kodax-client',
          clientSecretRef: 'env:OAUTH_CLIENT_SECRET', scopes: ['a2a.invoke'],
          clientAuthentication: 'client-secret-basic',
        },
        effects: { remote: 'read' },
      }, options(fetchImpl));
      const executor = await createA2AAgentExecutorFactory(options(fetchImpl)).create(
        discovered.registration,
        {
          async withCredential(_reference, use) { return use('local-client-secret'); },
          async authorizeArtifact() {},
        },
      );
      const events: AgentExecutorEvent[] = [];
      for await (const event of executor.events({
        idempotencyKey: 'stream-error', remoteTaskId: 'stream-error-task',
        metadata: { contextId: 'stream-error-context' },
      })) events.push(event);

      const diagnosticText = diagnostics.map((diagnostic) => (
        diagnostic.detail instanceof Error
          ? diagnostic.detail.message
          : JSON.stringify(diagnostic.detail)
      )).join('\n');
      expect(JSON.stringify(events)).not.toContain(accessToken);
      expect(diagnosticText).not.toContain(accessToken);
      expect(diagnosticText).toContain('[REDACTED]');
      await executor.dispose();
    } finally {
      restoreDiagnostics();
    }
  });

  it('retains a stream authorization for redaction until the stream closes', async () => {
    const streamToken = 'long-lived-stream-token';
    let releaseStreamEvent: (() => void) | undefined;
    const streamEventReady = new Promise<void>((resolve) => { releaseStreamEvent = resolve; });
    let credentialUse = 0;
    const bearerCard = {
      ...card(),
      capabilities: { streaming: true },
      securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
      securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    };
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes('.well-known/agent-card.json')) return Response.json(bearerCard);
      const request = JSON.parse(String(init?.body)) as {
        readonly id: string;
        readonly method: string;
      };
      if (request.method === 'SubscribeToTask') {
        return new Response(new ReadableStream<Uint8Array>({
          async pull(controller) {
            await streamEventReady;
            controller.enqueue(new TextEncoder().encode(
              `data: ${JSON.stringify({
                jsonrpc: '2.0', id: request.id,
                result: {
                  statusUpdate: {
                    taskId: 'retained-stream-task', contextId: 'retained-stream-context',
                    status: {
                      state: 'TASK_STATE_COMPLETED',
                      message: {
                        messageId: 'retained-status', role: 'ROLE_AGENT',
                        parts: [{ text: `late event echoed ${streamToken}` }],
                      },
                    },
                  },
                },
              })}\n\n`,
            ));
            controller.close();
          },
        }), { headers: { 'content-type': 'text/event-stream' } });
      }
      return Response.json({
        jsonrpc: '2.0', id: request.id,
        result: {
          message: { messageId: `rotation-${request.id}`, role: 'ROLE_AGENT', parts: [{ text: 'ok' }] },
        },
      });
    });
    const discovered = await discoverA2ARegistration({
      agentId: 'external:retained-stream-auth',
      agentCardUrl: `${CARD_ORIGIN}/.well-known/agent-card.json`,
      credentialRef: 'env:A2A_TOKEN',
      effects: { remote: 'read' },
    }, options(fetchImpl));
    const executor = await createA2AAgentExecutorFactory(options(fetchImpl)).create(
      discovered.registration,
      {
        async withCredential(_reference, use) {
          credentialUse += 1;
          return use(credentialUse === 1 ? streamToken : `rotation-token-${credentialUse}`);
        },
        async authorizeArtifact() {},
      },
    );
    const reference = {
      idempotencyKey: 'retained-stream', remoteTaskId: 'retained-stream-task',
      metadata: { contextId: 'retained-stream-context' },
    } as const;
    const iterator = executor.events(reference)[Symbol.asyncIterator]();
    const streamed = iterator.next();
    await vi.waitFor(() => expect(credentialUse).toBe(1));
    for (let index = 0; index < 5; index += 1) {
      await executor.sendInput(reference, { content: `rotation ${index}` });
    }
    releaseStreamEvent?.();

    const completed = await streamed;
    expect(JSON.stringify(completed)).not.toContain(streamToken);
    expect(JSON.stringify(completed)).toContain('[REDACTED]');
    await executor.dispose();
  });

  it('retains each slow RPC authorization through response parsing despite later rotations', async () => {
    const slowMessageToken = 'slow-message-token';
    const slowTaskToken = 'slow-task-token';
    let releaseMessage: (() => void) | undefined;
    let releaseTask: (() => void) | undefined;
    const messageGate = new Promise<void>((resolve) => { releaseMessage = resolve; });
    const taskGate = new Promise<void>((resolve) => { releaseTask = resolve; });
    const seenAuthorizations: string[] = [];
    const authorizedArtifacts: AgentArtifactReference[] = [];
    let credentialUse = 0;
    const bearerCard = {
      ...card(),
      securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
      securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    };
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes('.well-known/agent-card.json')) return Response.json(bearerCard);
      const authorization = new Headers(init?.headers).get('authorization') ?? '';
      seenAuthorizations.push(authorization);
      const request = JSON.parse(String(init?.body)) as {
        readonly id: string;
        readonly method: string;
      };
      if (authorization === `Bearer ${slowMessageToken}`) {
        await messageGate;
        return Response.json({
          jsonrpc: '2.0', id: request.id,
          result: {
            message: {
              messageId: 'slow-reflected-message', role: 'ROLE_AGENT',
              parts: [{ text: `message echoed Bearer ${slowMessageToken} and ${slowMessageToken}` }],
            },
          },
        });
      }
      if (authorization === `Bearer ${slowTaskToken}`) {
        await taskGate;
        return Response.json({
          jsonrpc: '2.0', id: request.id,
          result: {
            id: 'slow-reflected-task', contextId: 'slow-reflected-context',
            status: {
              state: 'TASK_STATE_COMPLETED',
              message: {
                messageId: 'slow-task-status', role: 'ROLE_AGENT',
                parts: [{ text: `status echoed ${slowTaskToken}` }],
              },
            },
            artifacts: [
              {
                artifactId: 'slow-text-artifact',
                parts: [{ text: `artifact echoed Bearer ${slowTaskToken}` }],
              },
              {
                artifactId: 'slow-data-artifact',
                parts: [{ data: { echoed: slowTaskToken }, mediaType: 'application/json' }],
              },
            ],
          },
        });
      }
      return Response.json({
        jsonrpc: '2.0', id: request.id,
        result: {
          message: { messageId: `rotation-${request.id}`, role: 'ROLE_AGENT', parts: [{ text: 'ok' }] },
        },
      });
    });
    const discovered = await discoverA2ARegistration({
      agentId: 'external:slow-rpc-auth',
      agentCardUrl: `${CARD_ORIGIN}/.well-known/agent-card.json`,
      credentialRef: 'env:A2A_TOKEN',
      effects: { remote: 'read' },
    }, options(fetchImpl));
    const executor = await createA2AAgentExecutorFactory(options(fetchImpl)).create(
      discovered.registration,
      {
        async withCredential(_reference, use) {
          credentialUse += 1;
          if (credentialUse === 1) return use(slowMessageToken);
          if (credentialUse === 2) return use(slowTaskToken);
          return use(`rotation-token-${credentialUse}`);
        },
        async authorizeArtifact(artifact) { authorizedArtifacts.push(artifact); },
      },
    );
    const taskReference = {
      idempotencyKey: 'slow-task', remoteTaskId: 'slow-reflected-task',
      metadata: { contextId: 'slow-reflected-context' },
    } as const;

    const slowMessage = executor.start({
      agentId: discovered.registration.agentId, objective: 'slow message', input: 'slow message',
      idempotencyKey: 'slow-message', context: { actorId: 'test' },
    });
    await vi.waitFor(() => expect(seenAuthorizations).toContain(`Bearer ${slowMessageToken}`));
    const slowTask = executor.get(taskReference);
    await vi.waitFor(() => expect(seenAuthorizations).toContain(`Bearer ${slowTaskToken}`));
    for (let index = 0; index < 5; index += 1) {
      await executor.sendInput(taskReference, { content: `rotation ${index}` });
    }
    releaseMessage?.();
    releaseTask?.();

    const messageReference = await slowMessage;
    const messageEvents: AgentExecutorEvent[] = [];
    for await (const event of executor.events(messageReference)) messageEvents.push(event);
    const taskSnapshot = await slowTask;
    const serialized = JSON.stringify({
      messageReference, messageEvents, taskSnapshot, authorizedArtifacts,
    });
    expect(serialized).not.toContain(slowMessageToken);
    expect(serialized).not.toContain(slowTaskToken);
    expect(serialized).toContain('[REDACTED]');
    const materializedArtifacts = authorizedArtifacts.map((artifact) => {
      const uri = artifact.uri ?? '';
      const separator = uri.indexOf(',');
      return uri.startsWith('data:') && separator >= 0
        ? Buffer.from(uri.slice(separator + 1), 'base64').toString('utf8')
        : uri;
    }).join('\n');
    expect(materializedArtifacts).not.toContain(slowTaskToken);
    expect(materializedArtifacts).toContain('[REDACTED]');
    await executor.dispose();
  });

  it.each(['2', 'a'])('does not corrupt protocol fields or content for a short Bearer token %j', async (token) => {
    const responseText = token === '2'
      ? 'Protocol version 2.0 remains available.'
      : 'Agent data remains available.';
    const bearerCard = {
      ...card(),
      securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
      securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    };
    const seenAuthorizations: Array<string | null> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes('.well-known/agent-card.json')) return Response.json(bearerCard);
      seenAuthorizations.push(new Headers(init?.headers).get('authorization'));
      const request = JSON.parse(String(init?.body)) as { readonly id: string };
      return Response.json({
        jsonrpc: '2.0', id: request.id,
        result: {
          message: {
            messageId: `reply-${token}`, role: 'ROLE_AGENT', parts: [{ text: responseText }],
          },
        },
      });
    });
    const clientOptions = { ...options(fetchImpl), authorization: `Bearer ${token}` };
    const discovered = await discoverA2ARegistration({
      agentId: `external:short-token-${token}`,
      agentCardUrl: `${CARD_ORIGIN}/.well-known/agent-card.json`,
      effects: { remote: 'read' },
    }, clientOptions);
    const executor = await createA2AAgentExecutorFactory(clientOptions).create(
      discovered.registration,
      { async withCredential(_reference, use) { return use('unused'); }, async authorizeArtifact() {} },
    );

    const reference = await executor.start({
      agentId: discovered.registration.agentId, objective: 'short token', input: 'short token',
      idempotencyKey: `short-token-${token}`, context: { actorId: 'test' },
    });
    const events: AgentExecutorEvent[] = [];
    for await (const event of executor.events(reference)) events.push(event);

    expect(seenAuthorizations).toEqual([`Bearer ${token}`]);
    expect(events).toEqual([{ state: 'completed', output: responseText }]);
    await executor.dispose();
  });

  it('rejects ambient non-Bearer authorization before discovery or RPC transport', async () => {
    const anonymousCard = {
      ...card(), securitySchemes: {}, securityRequirements: [],
    };
    const discoveryFetch = vi.fn<typeof fetch>(async () => Response.json(anonymousCard));
    const basicOptions = { ...options(discoveryFetch), authorization: 'Basic c2VjcmV0' };
    await expect(discoverA2ARegistration({
      agentId: 'external:ambient-basic',
      agentCardUrl: `${CARD_ORIGIN}/.well-known/agent-card.json`,
      effects: { remote: 'read' },
    }, basicOptions)).rejects.toThrow(/authorization.*Bearer|Bearer.*authorization/i);
    expect(discoveryFetch).toHaveBeenCalledTimes(1);

    const transportAuthorizations: Array<string | null> = [];
    const transportFetch = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes('.well-known/agent-card.json')) return Response.json(anonymousCard);
      transportAuthorizations.push(new Headers(init?.headers).get('authorization'));
      throw new Error('RPC transport must not be reached.');
    });
    const discovered = await discoverA2ARegistration({
      agentId: 'external:forged-ambient-basic',
      agentCardUrl: `${CARD_ORIGIN}/.well-known/agent-card.json`,
      effects: { remote: 'read' },
    }, options(transportFetch));
    const executor = await createA2AAgentExecutorFactory({
      ...options(transportFetch), authorization: 'Basic c2VjcmV0',
    }).create(
      discovered.registration,
      { async withCredential(_reference, use) { return use('unused'); }, async authorizeArtifact() {} },
    );
    await expect(executor.start({
      agentId: discovered.registration.agentId, objective: 'must not send', input: 'must not send',
      idempotencyKey: 'ambient-basic', context: { actorId: 'test' },
    })).rejects.toThrow(/authorization.*Bearer|Bearer.*authorization/i);
    expect(transportAuthorizations).toEqual([]);
    await executor.dispose();
  });

  it('rejects required authentication when no compatible client configuration is present', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(card()));
    await expect(discoverA2ARegistration({
      agentId: 'external:missing-auth',
      agentCardUrl: `${CARD_ORIGIN}/.well-known/agent-card.json`,
      effects: { remote: 'read' },
    }, options(fetchImpl))).rejects.toThrow(/requires authentication/i);
  });

  it('rejects a locally configured token endpoint that does not match the Agent Card', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(card()));
    await expect(discoverA2ARegistration({
      agentId: 'external:mismatch',
      agentCardUrl: `${CARD_ORIGIN}/.well-known/agent-card.json`,
      authentication: {
        type: 'oauth2-client-credentials',
        scheme: 'enterprise',
        issuer: `${TOKEN_ORIGIN}/`,
        tokenUrl: `${TOKEN_ORIGIN}/other-token`,
        clientId: 'kodax-client',
        clientSecretRef: 'env:OAUTH_CLIENT_SECRET',
        scopes: ['a2a.invoke'],
        clientAuthentication: 'client-secret-basic',
      },
      effects: { remote: 'read' },
    }, options(fetchImpl))).rejects.toThrow(/tokenUrl does not match/i);
  });

  it('rejects unsafe structured OAuth URLs during direct SDK discovery', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(card()));
    const authentication = {
      type: 'oauth2-client-credentials', scheme: 'enterprise', issuer: `${TOKEN_ORIGIN}/`,
      tokenUrl: `${TOKEN_ORIGIN}/token`, clientId: 'kodax-client',
      clientSecretRef: 'env:OAUTH_CLIENT_SECRET', scopes: ['a2a.invoke'],
      clientAuthentication: 'client-secret-basic',
    } as const;
    type OAuthInput = Extract<A2AClientAuthenticationInput, { readonly type: 'oauth2-client-credentials' }>;
    const discover = (overrides: Partial<OAuthInput>) => discoverA2ARegistration({
      agentId: 'external:unsafe-oauth-url',
      agentCardUrl: `${CARD_ORIGIN}/.well-known/agent-card.json`,
      authentication: { ...authentication, ...overrides },
      effects: { remote: 'read' },
    }, options(fetchImpl));

    await expect(discover({ issuer: 'http://identity.example.com' }))
      .rejects.toThrow(/issuer.*HTTPS|loopback/i);
    await expect(discover({ tokenUrl: 'file:///oauth/token' }))
      .rejects.toThrow(/token endpoint.*HTTP/i);
    await expect(discover({ resource: '/relative-resource' }))
      .rejects.toThrow(/resource.*absolute/i);
    await expect(discover({ clientId: '   ' }))
      .rejects.toThrow(/clientId.*non-empty/i);
    await expect(discover({ clientSecretRef: '' }))
      .rejects.toThrow(/clientSecretRef.*non-empty/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects malformed structured OAuth authentication before Agent Card fetch', async () => {
    type OAuthInput = Extract<A2AClientAuthenticationInput, { readonly type: 'oauth2-client-credentials' }>;
    const base: OAuthInput = {
      type: 'oauth2-client-credentials', scheme: 'enterprise', issuer: `${TOKEN_ORIGIN}/`,
      tokenUrl: `${TOKEN_ORIGIN}/token`, clientId: 'kodax-client',
      clientSecretRef: 'env:OAUTH_CLIENT_SECRET', scopes: ['a2a.invoke'],
      clientAuthentication: 'client-secret-basic',
    };
    const cases: readonly {
      readonly authentication: A2AClientAuthenticationInput;
      readonly pattern: RegExp;
    }[] = [
      {
        authentication: { ...base, type: 'oauth' } as unknown as A2AClientAuthenticationInput,
        pattern: /authentication\.type/i,
      },
      { authentication: { ...base, scheme: '   ' }, pattern: /scheme.*non-empty/i },
      {
        authentication: {
          ...base,
          clientAuthentication: 'client-secret-jwt' as OAuthInput['clientAuthentication'],
        },
        pattern: /clientAuthentication.*invalid/i,
      },
      {
        authentication: { ...base, scopes: 'a2a.invoke' as unknown as readonly string[] },
        pattern: /scopes.*array/i,
      },
      {
        authentication: { ...base, scopes: [123] as unknown as readonly string[] },
        pattern: /scopes.*string/i,
      },
      { authentication: { ...base, scopes: ['bad scope'] }, pattern: /scope-token/i },
      {
        authentication: { ...base, scopes: ['a2a.invoke', 'a2a.invoke'] },
        pattern: /scopes.*duplicates/i,
      },
    ];
    const fetchImpl = vi.fn<typeof fetch>();
    for (const entry of cases) {
      await expect(discoverA2ARegistration({
        agentId: 'external:malformed-oauth',
        agentCardUrl: `${CARD_ORIGIN}/.well-known/agent-card.json`,
        authentication: entry.authentication,
        effects: { remote: 'read' },
      }, options(fetchImpl))).rejects.toThrow(entry.pattern);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects blank legacy and structured Bearer credential references during discovery', async () => {
    const bearerCard = {
      ...card(),
      securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
      securityRequirements: [{ schemes: { bearer: { list: [] } } }],
    };
    const bearerFetch = vi.fn<typeof fetch>(async () => Response.json(bearerCard));

    await expect(discoverA2ARegistration({
      agentId: 'external:blank-legacy-ref',
      agentCardUrl: `${CARD_ORIGIN}/.well-known/agent-card.json`,
      credentialRef: '   ',
      effects: { remote: 'read' },
    }, options(bearerFetch))).rejects.toThrow(/credentialRef.*non-empty/i);
    await expect(discoverA2ARegistration({
      agentId: 'external:blank-bearer-ref',
      agentCardUrl: `${CARD_ORIGIN}/.well-known/agent-card.json`,
      authentication: { type: 'http-bearer', scheme: 'bearer', credentialRef: '' },
      effects: { remote: 'read' },
    }, options(bearerFetch))).rejects.toThrow(/credentialRef.*non-empty/i);

    const oauthFetch = vi.fn<typeof fetch>(async () => Response.json(card()));
    await expect(discoverA2ARegistration({
      agentId: 'external:ambiguous-empty-legacy-ref',
      agentCardUrl: `${CARD_ORIGIN}/.well-known/agent-card.json`,
      credentialRef: '',
      authentication: {
        type: 'oauth2-client-credentials', scheme: 'enterprise', issuer: `${TOKEN_ORIGIN}/`,
        tokenUrl: `${TOKEN_ORIGIN}/token`, clientId: 'kodax-client',
        clientSecretRef: 'env:OAUTH_CLIENT_SECRET', scopes: ['a2a.invoke'],
        clientAuthentication: 'client-secret-basic',
      },
      effects: { remote: 'read' },
    }, options(oauthFetch))).rejects.toThrow(/credentialRef.*non-empty|cannot combine/i);
    await expect(discoverA2ARegistration({
      agentId: 'external:ambiguous-legacy-ref',
      agentCardUrl: `${CARD_ORIGIN}/.well-known/agent-card.json`,
      credentialRef: 'env:LEGACY_TOKEN',
      authentication: {
        type: 'oauth2-client-credentials', scheme: 'enterprise', issuer: `${TOKEN_ORIGIN}/`,
        tokenUrl: `${TOKEN_ORIGIN}/token`, clientId: 'kodax-client',
        clientSecretRef: 'env:OAUTH_CLIENT_SECRET', scopes: ['a2a.invoke'],
        clientAuthentication: 'client-secret-basic',
      },
      effects: { remote: 'read' },
    }, options(oauthFetch))).rejects.toThrow(/cannot combine/i);
    expect(bearerFetch).not.toHaveBeenCalled();
    expect(oauthFetch).not.toHaveBeenCalled();
  });

  it('changes the registration revision when local authentication changes but the Card does not', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(card()));
    const discover = (
      clientId: string,
      clientSecretRef: string,
      effect: 'read' | 'write' = 'read',
    ) => discoverA2ARegistration({
      agentId: 'external:rotation',
      agentCardUrl: `${CARD_ORIGIN}/.well-known/agent-card.json`,
      authentication: {
        type: 'oauth2-client-credentials',
        scheme: 'enterprise',
        issuer: `${TOKEN_ORIGIN}/`,
        tokenUrl: `${TOKEN_ORIGIN}/token`,
        clientId,
        clientSecretRef,
        scopes: ['a2a.invoke'],
        clientAuthentication: 'client-secret-basic',
      },
      effects: { remote: effect },
    }, options(fetchImpl));

    const before = await discover('kodax-client', 'env:OLD_CLIENT_SECRET');
    const secretRotation = await discover('kodax-client', 'env:NEW_CLIENT_SECRET');
    const clientRotation = await discover('kodax-client-rotated', 'env:NEW_CLIENT_SECRET');
    const effectChange = await discover('kodax-client-rotated', 'env:NEW_CLIENT_SECRET', 'write');

    expect(secretRotation.registration.configurationRevision)
      .not.toBe(before.registration.configurationRevision);
    expect(secretRotation.registration.endpointIdentityHash)
      .toBe(before.registration.endpointIdentityHash);
    expect(clientRotation.registration.configurationRevision)
      .not.toBe(secretRotation.registration.configurationRevision);
    expect(clientRotation.registration.endpointIdentityHash)
      .not.toBe(before.registration.endpointIdentityHash);
    expect(effectChange.registration.configurationRevision)
      .not.toBe(clientRotation.registration.configurationRevision);
    expect(effectChange.registration.endpointIdentityHash)
      .toBe(clientRotation.registration.endpointIdentityHash);
  });

  it('exposes only Skills whose security requirements the configured client can satisfy', async () => {
    const skillCard = {
      ...card(),
      securityRequirements: [],
      skills: [
        { id: 'public', name: 'Public', description: 'Public work', tags: [] },
        {
          id: 'protected', name: 'Protected', description: 'Protected work', tags: [],
          securityRequirements: [{ schemes: { enterprise: { list: ['a2a.invoke'] } } }],
        },
      ],
    };
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(skillCard));
    const anonymous = await discoverA2ARegistration({
      agentId: 'external:skills-anonymous',
      agentCardUrl: `${CARD_ORIGIN}/.well-known/agent-card.json`,
      effects: { remote: 'read' },
    }, options(fetchImpl));
    const authenticated = await discoverA2ARegistration({
      agentId: 'external:skills-oauth',
      agentCardUrl: `${CARD_ORIGIN}/.well-known/agent-card.json`,
      authentication: {
        type: 'oauth2-client-credentials',
        scheme: 'enterprise',
        issuer: `${TOKEN_ORIGIN}/`,
        tokenUrl: `${TOKEN_ORIGIN}/token`,
        clientId: 'kodax-client',
        clientSecretRef: 'env:OAUTH_CLIENT_SECRET',
        scopes: ['a2a.invoke'],
        clientAuthentication: 'client-secret-basic',
      },
      effects: { remote: 'read' },
    }, options(fetchImpl));

    expect(anonymous.registration.skills).toEqual(['public']);
    expect(authenticated.registration.skills).toEqual(['public', 'protected']);
  });

  it('does not follow an Agent RPC redirect into the OAuth token trust origin', async () => {
    let tokenOriginReceivedRpc = false;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('.well-known/agent-card.json')) return Response.json(card());
      if (url === `${TOKEN_ORIGIN}/token`) {
        return Response.json({ access_token: 'dynamic-token', token_type: 'Bearer', expires_in: 120 });
      }
      if (url === `${TOKEN_ORIGIN}/collect`) {
        tokenOriginReceivedRpc = true;
        return Response.json({});
      }
      return new Response(null, {
        status: 302,
        headers: { location: `${TOKEN_ORIGIN}/collect` },
      });
    });
    const discovered = await discoverA2ARegistration({
      agentId: 'external:no-cross-origin-rpc',
      agentCardUrl: `${CARD_ORIGIN}/.well-known/agent-card.json`,
      authentication: {
        type: 'oauth2-client-credentials',
        scheme: 'enterprise',
        issuer: `${TOKEN_ORIGIN}/`,
        tokenUrl: `${TOKEN_ORIGIN}/token`,
        clientId: 'kodax-client',
        clientSecretRef: 'env:OAUTH_CLIENT_SECRET',
        scopes: ['a2a.invoke'],
        clientAuthentication: 'client-secret-basic',
      },
      effects: { remote: 'read' },
    }, options(fetchImpl));
    const executor = await createA2AAgentExecutorFactory(options(fetchImpl)).create(
      discovered.registration,
      {
        async withCredential(_reference, use) { return use('local-client-secret'); },
        async authorizeArtifact() {},
      },
    );

    await expect(executor.start({
      agentId: discovered.registration.agentId,
      objective: 'confidential prompt',
      input: 'confidential prompt',
      idempotencyKey: 'redirect-message',
      context: { actorId: 'test' },
    })).rejects.toThrow(/origin|redirect/i);
    expect(tokenOriginReceivedRpc).toBe(false);
  });
});
