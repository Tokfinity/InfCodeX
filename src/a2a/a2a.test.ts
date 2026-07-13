import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createAgentExecutorPlane } from '@kodax-ai/agent';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  KodaXRuntime,
  RuntimeEventFilter,
  RuntimeEventListener,
  RuntimeRunHandle,
  RuntimeRunResult,
} from '../sdk-runtime.js';
import {
  A2A_EXECUTOR_ID,
  createA2AAgentExecutorFactory,
  createKodaXA2AServer,
  discoverA2ARegistration,
  assertSafeA2AUrl,
  safeA2AFetch,
  parseA2AAgentCard,
  type A2AServerEvent,
} from './index.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'kodax-a2a-'));
  roots.push(root);
  return root;
}

function fakeRuntime(output = 'runtime-result'): KodaXRuntime {
  let sessionCounter = 0;
  let runCounter = 0;
  const phases = new Map<string, RuntimeRunResult['phase']>();
  const listeners: Array<{ filter: RuntimeEventFilter; listener: RuntimeEventListener }> = [];
  const runtime = {
    identity: {
      runtimeId: 'runtime-a2a-test',
      mode: 'embedded',
      profile: 'a2a-test',
      startedAt: new Date(0).toISOString(),
      version: 'test',
    },
    sessions: {
      async create() {
        sessionCounter += 1;
        return { id: `session-${sessionCounter}`, title: 'A2A test', surface: 'a2a' };
      },
    },
    runs: {
      async start(input: { readonly sessionId: string }): Promise<RuntimeRunHandle> {
        runCounter += 1;
        const runId = `run-${runCounter}`;
        phases.set(runId, 'running');
        const result = Promise.resolve({
          runId,
          sessionId: input.sessionId,
          phase: 'completed' as const,
          result: {
            success: true,
            lastText: output,
            messages: [],
            sessionId: input.sessionId,
          },
        }).then((value) => {
          phases.set(runId, 'completed');
          for (const entry of listeners) {
            if (entry.filter.runId === undefined || entry.filter.runId === runId) {
              entry.listener({
                id: `event-${runId}`,
                seq: 1,
                time: new Date().toISOString(),
                sessionId: input.sessionId,
                runId,
                type: 'run.completed',
                payload: {},
              });
            }
          }
          return value;
        });
        return { runId, sessionId: input.sessionId, result };
      },
      async get(runId: string) {
        const phase = phases.get(runId);
        if (!phase) throw new Error('run not found');
        return {
          runId,
          sessionId: 'session-1',
          phase,
          startedAt: new Date(0).toISOString(),
          provider: 'test',
        };
      },
      async abort(runId: string) {
        phases.set(runId, 'cancelled');
      },
      async await(runId: string) {
        const phase = phases.get(runId);
        if (!phase) throw new Error('run not found');
        return { runId, sessionId: 'session-1', phase };
      },
    },
    events: {
      subscribe(filter: RuntimeEventFilter, listener: RuntimeEventListener) {
        const entry = { filter, listener };
        listeners.push(entry);
        return { close: () => listeners.splice(listeners.indexOf(entry), 1) };
      },
      async replay() { return []; },
    },
    async close() {},
  };
  return runtime as unknown as KodaXRuntime;
}

function serverOptions(runtime: KodaXRuntime, dataDir: string, events: A2AServerEvent[] = []) {
  return {
    runtime,
    dataDir,
    agent: {
      name: 'KodaX Test Agent',
      description: 'Runs deterministic test work.',
      version: '1.0.0',
      publicBaseUrl: 'http://127.0.0.1:1',
      skills: [{ id: 'code', name: 'Code', description: 'Complete coding work.', tags: ['code'] }],
      inputModes: ['text/plain'],
      outputModes: ['text/plain'],
    },
    authentication: {
      securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
      securityRequirements: [{ schemes: { bearer: { list: [] } } }],
      async authenticate(request: Request) {
        const authorization = request.headers.get('authorization');
        if (authorization === 'Bearer test-token') return { subject: 'caller-1', scopes: ['a2a'] };
        if (authorization === 'Bearer other-token') return { subject: 'caller-2', scopes: ['a2a'] };
        return null;
      },
    },
    async authorize() { return true; },
    limits: {
      maxRequestBytes: 64 * 1024,
      maxPartBytes: 32 * 1024,
      maxConcurrentTasks: 4,
      maxTasksPerPrincipal: 8,
    },
    onEvent: (event: A2AServerEvent) => events.push(event),
  } as const;
}

function pendingRuntime(): {
  readonly runtime: KodaXRuntime;
  complete(output?: string): void;
} {
  let resolveResult: ((result: RuntimeRunResult) => void) | undefined;
  let phase: RuntimeRunResult['phase'] = 'running';
  const listeners: RuntimeEventListener[] = [];
  const result = new Promise<RuntimeRunResult>((resolve) => { resolveResult = resolve; });
  const runtime = {
    identity: {
      runtimeId: 'runtime-a2a-pending', mode: 'daemon', profile: 'a2a-pending',
      startedAt: new Date(0).toISOString(), version: 'test',
    },
    sessions: { async create() { return { id: 'session-pending', title: 'pending', surface: 'a2a' }; } },
    runs: {
      async start() { return { runId: 'run-pending', sessionId: 'session-pending', result }; },
      async get() {
        return {
          runId: 'run-pending', sessionId: 'session-pending', phase,
          startedAt: new Date(0).toISOString(), provider: 'test',
        };
      },
      async await() { return result; },
      async abort() {
        phase = 'cancelled';
        resolveResult?.({ runId: 'run-pending', sessionId: 'session-pending', phase: 'cancelled' });
      },
    },
    events: {
      subscribe(_filter: RuntimeEventFilter, listener: RuntimeEventListener) {
        listeners.push(listener);
        return { close: () => listeners.splice(listeners.indexOf(listener), 1) };
      },
      async replay() { return []; },
    },
    async close() {},
  } as unknown as KodaXRuntime;
  return {
    runtime,
    complete(output = 'recovered-result') {
      phase = 'completed';
      for (const listener of listeners) {
        listener({
          id: 'event-complete', seq: 1, time: new Date().toISOString(),
          sessionId: 'session-pending', runId: 'run-pending', type: 'run.completed', payload: {},
        });
      }
      resolveResult?.({
        runId: 'run-pending', sessionId: 'session-pending', phase: 'completed',
        result: { success: true, lastText: output, messages: [], sessionId: 'session-pending' },
      });
    },
  };
}

async function rpc(
  baseUrl: string,
  method: string,
  params: Readonly<Record<string, unknown>>,
  authorization = 'Bearer test-token',
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/a2a`, {
    method: 'POST',
    headers: {
      authorization,
      'content-type': 'application/json',
      'a2a-version': '1.0',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: `${method}-id`, method, params }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

describe('FEATURE_267 bidirectional A2A', () => {
  it('validates the frozen A2A 1.0 Agent Card shape', () => {
    const card = parseA2AAgentCard({
      name: 'remote',
      description: 'remote agent',
      supportedInterfaces: [{
        url: 'https://agent.example/a2a',
        protocolBinding: 'JSONRPC',
        protocolVersion: '1.0',
      }],
      version: '1.0.0',
      capabilities: { streaming: true, pushNotifications: false },
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      skills: [{ id: 'review', name: 'Review', description: 'Review code.', tags: ['review'] }],
    });
    expect(card.supportedInterfaces[0]?.protocolVersion).toBe('1.0');
    expect(() => parseA2AAgentCard({ name: 'missing-fields' })).toThrow(/Agent Card/i);
  });

  it('hot-reloads publication metadata without replacing execution state', async () => {
    const options = serverOptions(fakeRuntime(), temporaryRoot());
    const server = createKodaXA2AServer(options);
    server.updateHot({
      agent: { ...options.agent, name: 'Reloaded General Agent', description: 'New public projection.' },
      limits: { ...options.limits, maxConcurrentTasks: 2 },
      authentication: options.authentication,
      authorize: options.authorize,
    });

    expect(server.agentCard).toMatchObject({
      name: 'Reloaded General Agent', description: 'New public projection.',
    });
    await server.close();
  });

  it('prepares a user Markdown Agent through the Runtime-owned binding capability', async () => {
    const base = fakeRuntime();
    let closed = false;
    const execution = {
      async openOwnerSession() { return { ownerSessionId: 'owner-1' }; },
      async bindLocal() {
        return {
          ownerSessionId: 'owner-1', bindingId: 'binding-1',
          executionPolicyRevision: 'execution-r1', toolPolicyRevision: 'tools-r1',
          workspaceBindingRevision: 'workspace-r1', skillSetRevision: 'skills-r1',
          effectiveSkills: [], effectiveTools: ['read'],
          ref: { source: 'markdown:user' as const, name: 'office-agent' },
          agentId: 'markdown:user:office-agent', displayName: 'office-agent', description: 'Office',
          configurationRevision: 'agent-r1',
        };
      },
      async startLocal(input: { sessionId: string }) {
        return base.runs.start({ sessionId: input.sessionId, input: { type: 'text', text: 'test' } });
      },
      async prepareWorkspace() { return temporaryRoot(); },
      async closeOwnerSession() { closed = true; },
    };
    const runtime = { ...base, agents: { execution } } as unknown as KodaXRuntime;
    const options = serverOptions(runtime, temporaryRoot());
    const server = await (await import('./server.js')).prepareKodaXA2AServer({
      ...options,
      execution: {
        kind: 'local-agent', agentRef: { source: 'markdown:user', name: 'office-agent' },
        workspace: { mode: 'managed' },
        toolPolicy: {
          workspace: 'read', process: 'deny', network: { mode: 'deny' },
          tools: [], mcp: {}, skillScripts: {}, subagents: 'deny',
        },
      },
    });
    await server.close();
    expect(closed).toBe(true);
  });

  it('serves KodaX inbound and dispatches it through the F258 outbound plane', async () => {
    const runtime = fakeRuntime('A2A completed');
    const server = createKodaXA2AServer(serverOptions(runtime, temporaryRoot()));
    const baseUrl = await server.listen({ hostname: '127.0.0.1', port: 0 });
    const cardUrl = `${baseUrl}/.well-known/agent-card.json`;
    const clientOptions = {
      networkPolicy: {
        allowedOrigins: [baseUrl],
        allowPrivateAddresses: true,
        requestTimeoutMs: 2_000,
        maxResponseBytes: 128 * 1024,
        maxRedirects: 2,
      },
      pollIntervalMs: 5,
      authorization: 'Bearer test-token',
    } as const;

    try {
      const discovered = await discoverA2ARegistration({
        agentId: 'external:kodax-test',
        agentCardUrl: cardUrl,
        effects: { remote: 'read' },
      }, clientOptions);
      expect(discovered.registration.executorId).toBe(A2A_EXECUTOR_ID);
      expect(discovered.registration.skills).toContain('code');

      const plane = await createAgentExecutorPlane({
        factories: [createA2AAgentExecutorFactory(clientOptions)],
        policy: () => ({ allowed: true }),
      });
      await plane.registrations.upsert(discovered.registration);
      const task = await plane.tasks.start({
        agentId: discovered.registration.agentId,
        objective: 'Implement the feature',
        context: { actorId: 'test-host' },
      });
      const completed = await plane.tasks.wait(task.taskId, 2_000);
      expect(completed.state).toBe('completed');
      expect(completed.output).toContain('A2A completed');
      await plane.close();
    } finally {
      await server.close();
    }
  });

  it('enforces authentication and deduplicates inbound message IDs', async () => {
    const events: A2AServerEvent[] = [];
    const server = createKodaXA2AServer(serverOptions(fakeRuntime(), temporaryRoot(), events));
    const baseUrl = await server.listen({ hostname: '127.0.0.1', port: 0 });
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 'rpc-1',
      method: 'SendMessage',
      params: {
        message: {
          messageId: 'message-1',
          role: 'ROLE_USER',
          parts: [{ text: 'hello', mediaType: 'text/plain' }],
        },
        configuration: { returnImmediately: true },
      },
    });
    try {
      const denied = await fetch(`${baseUrl}/a2a`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'a2a-version': '1.0' },
        body,
      });
      expect(denied.status).toBe(401);

      const send = () => fetch(`${baseUrl}/a2a`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json',
          'a2a-version': '1.0',
        },
        body,
      }).then((response) => response.json() as Promise<{ result: { task: { id: string } } }>);
      const first = await send();
      const second = await send();
      expect(second.result.task.id).toBe(first.result.task.id);
      expect(events.some((event) => event.type === 'task.deduplicated')).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('streams ordered task states and supports caller-scoped list/get operations', async () => {
    const controlled = pendingRuntime();
    const server = createKodaXA2AServer(serverOptions(controlled.runtime, temporaryRoot()));
    const baseUrl = await server.listen({ hostname: '127.0.0.1', port: 0 });
    try {
      const response = await fetch(`${baseUrl}/a2a`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json',
          'a2a-version': '1.0',
        },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 'stream-id', method: 'SendStreamingMessage',
          params: { message: { messageId: 'stream-message', role: 'ROLE_USER', parts: [{ text: 'stream' }] } },
        }),
      });
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      controlled.complete('stream-result');
      const streamed = await response.text();
      expect(streamed).toContain('TASK_STATE_WORKING');
      expect(streamed).toContain('TASK_STATE_COMPLETED');
      expect(streamed).toContain('stream-result');

      const listed = await rpc(baseUrl, 'ListTasks', { pageSize: 10 });
      const listResult = listed.body.result as { readonly tasks: readonly { readonly id: string }[] };
      expect(listResult.tasks).toHaveLength(1);
      const taskId = listResult.tasks[0]?.id ?? '';
      const hidden = await rpc(baseUrl, 'GetTask', { id: taskId }, 'Bearer other-token');
      expect((hidden.body.error as { readonly code: number }).code).toBe(-32001);
    } finally {
      await server.close();
    }
  });

  it('cancels active work and preserves terminal state', async () => {
    const controlled = pendingRuntime();
    const server = createKodaXA2AServer(serverOptions(controlled.runtime, temporaryRoot()));
    const baseUrl = await server.listen({ hostname: '127.0.0.1', port: 0 });
    try {
      const sent = await rpc(baseUrl, 'SendMessage', {
        message: { messageId: 'cancel-message', role: 'ROLE_USER', parts: [{ text: 'wait' }] },
        configuration: { returnImmediately: true },
      });
      const taskId = ((sent.body.result as { readonly task: { readonly id: string } }).task.id);
      const canceled = await rpc(baseUrl, 'CancelTask', { id: taskId });
      expect((((canceled.body.result as { readonly status: { readonly state: string } }).status.state))).toBe('TASK_STATE_CANCELED');
      const second = await rpc(baseUrl, 'CancelTask', { id: taskId });
      expect((second.body.error as { readonly code: number }).code).toBe(-32002);
    } finally {
      await server.close();
    }
  });

  it('reattaches a surviving Runtime run after an A2A edge restart', async () => {
    const controlled = pendingRuntime();
    const dataDir = temporaryRoot();
    const first = createKodaXA2AServer(serverOptions(controlled.runtime, dataDir));
    const firstUrl = await first.listen({ hostname: '127.0.0.1', port: 0 });
    const sent = await rpc(firstUrl, 'SendMessage', {
      message: { messageId: 'recover-message', role: 'ROLE_USER', parts: [{ text: 'recover' }] },
      configuration: { returnImmediately: true },
    });
    const taskId = ((sent.body.result as { readonly task: { readonly id: string } }).task.id);
    await first.close();

    const second = createKodaXA2AServer(serverOptions(controlled.runtime, dataDir));
    const secondUrl = await second.listen({ hostname: '127.0.0.1', port: 0 });
    try {
      controlled.complete('reattached');
      await new Promise((resolve) => setTimeout(resolve, 10));
      const recovered = await rpc(secondUrl, 'GetTask', { id: taskId });
      const task = recovered.body.result as { readonly status: { readonly state: string }; readonly artifacts: readonly unknown[] };
      expect(task.status.state).toBe('TASK_STATE_COMPLETED');
      expect(JSON.stringify(task.artifacts)).toContain('reattached');
    } finally {
      await second.close();
    }
  });

  it('uses A2A SSE from the outbound executor and observes remote completion', async () => {
    const controlled = pendingRuntime();
    const server = createKodaXA2AServer(serverOptions(controlled.runtime, temporaryRoot()));
    const baseUrl = await server.listen({ hostname: '127.0.0.1', port: 0 });
    const options = {
      networkPolicy: {
        allowedOrigins: [baseUrl], allowPrivateAddresses: true,
        requestTimeoutMs: 2_000, maxResponseBytes: 128 * 1024, maxRedirects: 1,
      },
      pollIntervalMs: 100,
      authorization: 'Bearer test-token',
    } as const;
    try {
      const discovered = await discoverA2ARegistration({
        agentId: 'external:streaming-kodax',
        agentCardUrl: `${baseUrl}/.well-known/agent-card.json`,
        effects: { remote: 'read' },
      }, options);
      const plane = await createAgentExecutorPlane({
        factories: [createA2AAgentExecutorFactory(options)],
        policy: () => ({ allowed: true }),
      });
      await plane.registrations.upsert(discovered.registration);
      const started = await plane.tasks.start({
        agentId: discovered.registration.agentId,
        objective: 'stream through A2A',
        context: { actorId: 'stream-test' },
      });
      setTimeout(() => controlled.complete('outbound-stream-result'), 20);
      const completed = await plane.tasks.wait(started.taskId, 2_000);
      expect(completed.state).toBe('completed');
      expect(completed.output).toContain('outbound-stream-result');
      await plane.close();
    } finally {
      await server.close();
    }
  });

  it('fails closed for private targets and strips authorization on cross-origin redirect', async () => {
    const deniedPolicy = {
      allowedOrigins: ['http://127.0.0.1:4000'], allowPrivateAddresses: false,
      requestTimeoutMs: 1_000, maxResponseBytes: 1024, maxRedirects: 1,
    } as const;
    await expect(assertSafeA2AUrl(new URL('http://127.0.0.1:4000/a2a'), deniedPolicy))
      .rejects.toThrow(/private network/i);

    const seen: Array<{ readonly url: string; readonly authorization: string | null }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      const authorization = new Headers(init?.headers).get('authorization');
      seen.push({ url, authorization });
      return seen.length === 1
        ? new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:4001/final' } })
        : new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    await safeA2AFetch(new URL('http://127.0.0.1:4000/start'), {
      headers: { authorization: 'Bearer secret' },
    }, {
      allowedOrigins: ['http://127.0.0.1:4000', 'http://127.0.0.1:4001'],
      allowPrivateAddresses: true,
      requestTimeoutMs: 1_000,
      maxResponseBytes: 1024,
      maxRedirects: 1,
    }, fetchImpl);
    expect(seen.map((entry) => entry.authorization)).toEqual(['Bearer secret', null]);
  });

  it('rejects wrong protocol versions, message-ID conflicts, and corrupt durable state', async () => {
    const dataDir = temporaryRoot();
    const server = createKodaXA2AServer(serverOptions(fakeRuntime(), dataDir));
    const baseUrl = await server.listen({ hostname: '127.0.0.1', port: 0 });
    try {
      const card = await fetch(`${baseUrl}/.well-known/agent-card.json`)
        .then((response) => response.json() as Promise<{ readonly supportedInterfaces: readonly { readonly url: string }[] }>);
      expect(card.supportedInterfaces[0]?.url).toBe(`${baseUrl}/`);

      const wrongVersion = await fetch(`${baseUrl}/a2a`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json',
          'a2a-version': '0.3',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'v', method: 'ListTasks', params: {} }),
      }).then((response) => response.json() as Promise<{
        readonly error: { readonly code: number; readonly data: readonly { readonly reason: string }[] };
      }>);
      expect(wrongVersion.error.code).toBe(-32009);
      expect(wrongVersion.error.data[0]?.reason).toBe('VERSION_NOT_SUPPORTED');

      const push = await rpc(baseUrl, 'CreateTaskPushNotificationConfig', {});
      expect((push.body.error as { readonly code: number }).code).toBe(-32003);
      const unsupported = await rpc(baseUrl, 'SendMessage', {
        message: {
          messageId: 'unsupported-media', role: 'ROLE_USER',
          parts: [{ raw: 'dGNr', mediaType: 'application/x-unsupported' }],
        },
      });
      expect((unsupported.body.error as { readonly code: number }).code).toBe(-32005);

      const defaultVersion = await fetch(`${baseUrl}/`, {
        method: 'POST',
        headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'default-version', method: 'ListTasks', params: {} }),
      });
      expect(defaultVersion.status).toBe(200);
      const wrongContentType = await fetch(`${baseUrl}/`, {
        method: 'POST',
        headers: { authorization: 'Bearer test-token', 'content-type': 'text/plain' },
        body: '{}',
      });
      expect(wrongContentType.status).toBe(415);
      const oversized = await fetch(`${baseUrl}/`, {
        method: 'POST',
        headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
        body: 'x'.repeat(70 * 1024),
      });
      expect(oversized.status).toBe(413);

      await rpc(baseUrl, 'SendMessage', {
        message: { messageId: 'same-id', role: 'ROLE_USER', parts: [{ text: 'first' }] },
        configuration: { returnImmediately: true },
      });
      const conflict = await rpc(baseUrl, 'SendMessage', {
        message: { messageId: 'same-id', role: 'ROLE_USER', parts: [{ text: 'different' }] },
        configuration: { returnImmediately: true },
      });
      expect((conflict.body.error as { readonly code: number }).code).toBe(-32602);
    } finally {
      await server.close();
    }

    const corrupt = temporaryRoot();
    writeFileSync(path.join(corrupt, 'tasks.json'), '{not-json', 'utf8');
    expect(() => createKodaXA2AServer(serverOptions(fakeRuntime(), corrupt))).toThrow(/task store/i);
  });
});
