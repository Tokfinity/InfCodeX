import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createAgentExecutorPlane, type AgentExecutorEvent } from '@kodax-ai/agent';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
  parseA2ATask,
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

function fakeRuntime(
  output = 'runtime-result',
  artifactLedger?: readonly {
    readonly id: string;
    readonly kind: 'file_created' | 'file_modified';
    readonly target: string;
    readonly timestamp: string;
    readonly sourceTool?: string;
    readonly action?: string;
  }[],
): KodaXRuntime {
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
            ...(artifactLedger ? { artifactLedger } : {}),
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

function interactiveRuntime(): {
  readonly runtime: KodaXRuntime;
  readonly starts: () => number;
  readonly answer: () => unknown;
} {
  let startCount = 0;
  let resolvedAnswer: unknown;
  let resolveResult!: (result: RuntimeRunResult) => void;
  const listeners: RuntimeEventListener[] = [];
  const result = new Promise<RuntimeRunResult>((resolve) => { resolveResult = resolve; });
  const runtime = {
    identity: {
      runtimeId: 'runtime-a2a-interactive', mode: 'embedded', profile: 'a2a-interactive',
      startedAt: new Date(0).toISOString(), version: 'test',
    },
    sessions: { async create() { return { id: 'session-interactive', title: 'interactive', surface: 'a2a' }; } },
    runs: {
      async start() {
        startCount += 1;
        if (startCount > 1) throw new Error('continuation must not create another run');
        setTimeout(() => {
          for (const listener of listeners) {
            listener({
              id: 'event-input', seq: 1, time: new Date().toISOString(),
              sessionId: 'session-interactive', runId: 'run-interactive',
              type: 'user_input.requested',
              payload: {
                id: 'input-1', revision: 0, sessionId: 'session-interactive',
                runId: 'run-interactive', kind: 'askUserInput',
                options: {
                  question: 'Which color?',
                  default: 'private-prefill',
                  customInputDefault: 'private-custom-prefill',
                },
                createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
              },
            });
          }
        }, 0);
        return { runId: 'run-interactive', sessionId: 'session-interactive', result };
      },
      async get() {
        return {
          runId: 'run-interactive', sessionId: 'session-interactive', phase: 'waiting_user_input',
          startedAt: new Date(0).toISOString(), provider: 'test',
        };
      },
      async await() { return result; },
      async abort() {},
    },
    userInputs: {
      async listPending() { return []; },
      async respond(requestId: string, answer: unknown) {
        expect(requestId).toBe('input-1');
        resolvedAnswer = answer;
        resolveResult({
          runId: 'run-interactive', sessionId: 'session-interactive', phase: 'completed',
          result: {
            success: true, lastText: `answer:${String(answer)}`, messages: [], sessionId: 'session-interactive',
          },
        });
        return { requestId, accepted: true, status: 'answered' as const };
      },
      async dismiss(requestId: string) { return { requestId, accepted: true, status: 'dismissed' as const }; },
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
  return { runtime, starts: () => startCount, answer: () => resolvedAnswer };
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
  listenerCount(): number;
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
    listenerCount: () => listeners.length,
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

  it('rejects a Part whose selected content field has the wrong wire type', async () => {
    const server = createKodaXA2AServer(serverOptions(fakeRuntime(), temporaryRoot()));
    const baseUrl = await server.listen({ hostname: '127.0.0.1', port: 0 });
    try {
      const response = await rpc(baseUrl, 'SendMessage', {
        message: {
          messageId: 'invalid-part-type', role: 'ROLE_USER',
          parts: [{ text: 42, mediaType: 'text/plain' }],
        },
      });
      expect((response.body.error as { readonly code: number }).code).toBe(-32602);
    } finally {
      await server.close();
    }
  });

  it('maps an unknown forward-compatible task state to unspecified', () => {
    expect(parseA2ATask({
      id: 'future-task', contextId: 'future-context',
      status: { state: 'TASK_STATE_PAUSED_BY_REMOTE' },
    }).status.state).toBe('TASK_STATE_UNSPECIFIED');
  });

  it('accepts an omitted optional task context ID from a remote Agent', () => {
    expect(parseA2ATask({
      id: 'contextless-task', status: { state: 'TASK_STATE_COMPLETED' },
    }).contextId).toBe('');
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

  it('passes sanitized message scope to host authorization', async () => {
    const authorize = vi.fn(async () => true);
    const base = serverOptions(fakeRuntime(), temporaryRoot());
    const server = createKodaXA2AServer({ ...base, authorize });
    const baseUrl = await server.listen({ hostname: '127.0.0.1', port: 0 });
    try {
      await rpc(baseUrl, 'SendMessage', {
        message: {
          messageId: 'authorization-scope', contextId: 'caller-context',
          role: 'ROLE_USER', parts: [{ text: 'scoped text' }],
        },
      });
      expect(authorize).toHaveBeenCalledWith(expect.objectContaining({
        operation: 'send-message', contextId: 'caller-context', inputModes: ['text/plain'],
      }));
    } finally {
      await server.close();
    }
  });

  it('resumes INPUT_REQUIRED through the pending Runtime interaction without starting another run', async () => {
    const controlled = interactiveRuntime();
    const server = createKodaXA2AServer(serverOptions(controlled.runtime, temporaryRoot()));
    const baseUrl = await server.listen({ hostname: '127.0.0.1', port: 0 });
    try {
      const sent = await rpc(baseUrl, 'SendMessage', {
        message: { messageId: 'interactive-start', role: 'ROLE_USER', parts: [{ text: 'start' }] },
        configuration: { returnImmediately: true },
      });
      const taskId = (sent.body.result as { readonly task: { readonly id: string } }).task.id;
      let waiting: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        waiting = (await rpc(baseUrl, 'GetTask', { id: taskId })).body.result as Record<string, unknown>;
        if (JSON.stringify(waiting).includes('TASK_STATE_INPUT_REQUIRED')) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(JSON.stringify(waiting)).toContain('Which color?');
      expect(JSON.stringify(waiting)).not.toContain('private-prefill');
      expect(JSON.stringify(waiting)).not.toContain('private-custom-prefill');

      const continued = await rpc(baseUrl, 'SendMessage', {
        message: {
          messageId: 'interactive-answer', taskId, role: 'ROLE_USER',
          parts: [{ text: 'blue', mediaType: 'text/plain' }],
        },
      });
      expect(JSON.stringify(continued.body)).toContain('TASK_STATE_COMPLETED');
      expect(JSON.stringify(continued.body)).toContain('answer:blue');
      expect(controlled.starts()).toBe(1);
      expect(controlled.answer()).toBe('blue');
    } finally {
      await server.close();
    }
  });

  it('prunes only the oldest terminal task before admitting work at the retention limit', async () => {
    const base = serverOptions(fakeRuntime(), temporaryRoot());
    const server = createKodaXA2AServer({
      ...base,
      limits: { ...base.limits, maxTasksPerPrincipal: undefined, maxRetainedTasksPerPrincipal: 2 },
    });
    const baseUrl = await server.listen({ hostname: '127.0.0.1', port: 0 });
    const taskIds: string[] = [];
    try {
      for (let index = 0; index < 3; index += 1) {
        const sent = await rpc(baseUrl, 'SendMessage', {
          message: { messageId: `retained-${index}`, role: 'ROLE_USER', parts: [{ text: `${index}` }] },
        });
        expect(sent.body.error).toBeUndefined();
        taskIds.push((sent.body.result as { readonly task: { readonly id: string } }).task.id);
      }
      const pruned = await rpc(baseUrl, 'GetTask', { id: taskIds[0] });
      expect((pruned.body.error as { readonly code: number }).code).toBe(-32001);
      const listed = await rpc(baseUrl, 'ListTasks', {});
      expect((listed.body.result as { readonly tasks: readonly unknown[] }).tasks).toHaveLength(2);
    } finally {
      await server.close();
    }
  });

  it('publishes explicitly staged run files as inline A2A artifacts and stream updates', async () => {
    const workspace = temporaryRoot();
    const staging = path.join(workspace, '.kodax-a2a-staging');
    const output = path.join(staging, 'report.pptx');
    mkdirSync(staging, { recursive: true });
    writeFileSync(output, 'ppt-content', 'utf8');
    const runtime = fakeRuntime('presentation ready', [{
      id: 'artifact-1', kind: 'file_created', target: output, timestamp: new Date().toISOString(),
    }]);
    const base = serverOptions(runtime, temporaryRoot());
    const server = createKodaXA2AServer({
      ...base,
      agent: {
        ...base.agent,
        projectPath: workspace,
        outputModes: ['text/plain', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
      },
    });
    const baseUrl = await server.listen({ hostname: '127.0.0.1', port: 0 });
    try {
      const response = await fetch(`${baseUrl}/a2a`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token', 'content-type': 'application/json', 'a2a-version': '1.0',
        },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 'artifact-stream', method: 'SendStreamingMessage',
          params: {
            message: { messageId: 'artifact-message', role: 'ROLE_USER', parts: [{ text: 'make slides' }] },
          },
        }),
      });
      const streamed = await response.text();
      expect(streamed).toContain('artifactUpdate');
      expect(streamed).toContain(Buffer.from('ppt-content').toString('base64'));
      expect(streamed).not.toContain(workspace);
    } finally {
      await server.close();
    }
  });

  it('publishes successful sandboxed Skill outputs without exposing ordinary workspace writes', async () => {
    const workspace = temporaryRoot();
    const skillOutput = path.join(workspace, 'deliverables', 'slides.pptx');
    const ordinaryWrite = path.join(workspace, 'notes.txt');
    mkdirSync(path.dirname(skillOutput), { recursive: true });
    writeFileSync(skillOutput, 'skill-ppt-content', 'utf8');
    writeFileSync(ordinaryWrite, 'private working notes', 'utf8');
    const timestamp = new Date().toISOString();
    const runtime = fakeRuntime('presentation ready', [
      {
        id: 'skill-output', kind: 'file_created', target: skillOutput,
        timestamp, sourceTool: 'run_skill_script', action: 'promote_output',
      },
      {
        id: 'ordinary-write', kind: 'file_modified', target: ordinaryWrite,
        timestamp, sourceTool: 'write',
      },
    ]);
    const base = serverOptions(runtime, temporaryRoot());
    const server = createKodaXA2AServer({
      ...base,
      agent: {
        ...base.agent,
        projectPath: workspace,
        outputModes: ['text/plain', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
      },
    });
    const baseUrl = await server.listen({ hostname: '127.0.0.1', port: 0 });
    try {
      const sent = await rpc(baseUrl, 'SendMessage', {
        message: { messageId: 'skill-artifact', role: 'ROLE_USER', parts: [{ text: 'make slides' }] },
      });
      const serialized = JSON.stringify(sent.body);
      expect(serialized).toContain(Buffer.from('skill-ppt-content').toString('base64'));
      expect(serialized).not.toContain(Buffer.from('private working notes').toString('base64'));
      expect(serialized).not.toContain(workspace);
    } finally {
      await server.close();
    }
  });

  it('keeps a successful task completed when a declared output is no longer materializable', async () => {
    const workspace = path.join(temporaryRoot(), 'removed-workspace');
    const runtime = fakeRuntime('completed without retained file', [{
      id: 'missing-output', kind: 'file_created',
      target: path.join(workspace, '.kodax-a2a-staging', 'missing.pdf'),
      timestamp: new Date().toISOString(),
    }]);
    const base = serverOptions(runtime, temporaryRoot());
    const server = createKodaXA2AServer({
      ...base,
      agent: { ...base.agent, projectPath: workspace },
    });
    const baseUrl = await server.listen({ hostname: '127.0.0.1', port: 0 });
    try {
      const sent = await rpc(baseUrl, 'SendMessage', {
        message: { messageId: 'missing-output', role: 'ROLE_USER', parts: [{ text: 'finish' }] },
      });
      const task = (sent.body.result as { readonly task: { readonly status: { readonly state: string } } }).task;
      expect(task.status.state).toBe('TASK_STATE_COMPLETED');
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

  it('honors bounded history, list timestamp filters, and accepted output modes', async () => {
    const server = createKodaXA2AServer(serverOptions(fakeRuntime('history-result'), temporaryRoot()));
    const baseUrl = await server.listen({ hostname: '127.0.0.1', port: 0 });
    try {
      const sent = await rpc(baseUrl, 'SendMessage', {
        message: { messageId: 'history-message', role: 'ROLE_USER', parts: [{ text: 'history' }] },
        configuration: { historyLength: 1 },
      });
      const task = (sent.body.result as { readonly task: { readonly id: string; readonly history: readonly unknown[] } }).task;
      expect(task.history).toHaveLength(1);

      const withoutHistory = await rpc(baseUrl, 'GetTask', { id: task.id, historyLength: 0 });
      expect((withoutHistory.body.result as { readonly history?: readonly unknown[] }).history).toBeUndefined();
      const invalidHistory = await rpc(baseUrl, 'GetTask', { id: task.id, historyLength: -1 });
      expect((invalidHistory.body.error as { readonly code: number }).code).toBe(-32602);

      const future = new Date(Date.now() + 60_000).toISOString();
      const filtered = await rpc(baseUrl, 'ListTasks', { statusTimestampAfter: future, historyLength: 1 });
      expect((filtered.body.result as { readonly tasks: readonly unknown[] }).tasks).toHaveLength(0);

      const unsupported = await rpc(baseUrl, 'SendMessage', {
        message: { messageId: 'unsupported-output', role: 'ROLE_USER', parts: [{ text: 'binary' }] },
        configuration: { acceptedOutputModes: ['application/x-unsupported'] },
      });
      expect((unsupported.body.error as { readonly code: number }).code).toBe(-32005);

      const invalidConfiguration = await rpc(baseUrl, 'SendMessage', {
        message: { messageId: 'invalid-configuration', role: 'ROLE_USER', parts: [{ text: 'invalid' }] },
        configuration: 'not-an-object',
      });
      expect((invalidConfiguration.body.error as { readonly code: number }).code).toBe(-32602);

      for (const params of [
        { includeArtifacts: 'yes' },
        { contextId: 42 },
        { pageToken: 42 },
      ]) {
        const invalidList = await rpc(baseUrl, 'ListTasks', params);
        expect((invalidList.body.error as { readonly code: number }).code).toBe(-32602);
      }
    } finally {
      await server.close();
    }
  });

  it('uses a stable opaque ListTasks cursor when newer tasks arrive between pages', async () => {
    let tick = 0;
    const base = serverOptions(fakeRuntime(), temporaryRoot());
    const server = createKodaXA2AServer({
      ...base,
      now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, tick++)),
    });
    const baseUrl = await server.listen({ hostname: '127.0.0.1', port: 0 });
    try {
      const originalIds: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const sent = await rpc(baseUrl, 'SendMessage', {
          message: { messageId: `cursor-${index}`, role: 'ROLE_USER', parts: [{ text: `${index}` }] },
        });
        originalIds.push((sent.body.result as { readonly task: { readonly id: string } }).task.id);
      }
      const first = await rpc(baseUrl, 'ListTasks', { pageSize: 1 });
      const firstPage = first.body.result as {
        readonly tasks: readonly { readonly id: string }[];
        readonly nextPageToken: string;
      };
      expect(firstPage.tasks).toHaveLength(1);
      expect(firstPage.nextPageToken).not.toBe('');

      const inserted = await rpc(baseUrl, 'SendMessage', {
        message: { messageId: 'cursor-newer', role: 'ROLE_USER', parts: [{ text: 'newer' }] },
      });
      const insertedId = (inserted.body.result as { readonly task: { readonly id: string } }).task.id;
      const second = await rpc(baseUrl, 'ListTasks', {
        pageSize: 1, pageToken: firstPage.nextPageToken,
      });
      const secondTask = (second.body.result as {
        readonly tasks: readonly { readonly id: string }[];
      }).tasks[0];
      expect(secondTask?.id).not.toBe(firstPage.tasks[0]?.id);
      expect(secondTask?.id).not.toBe(insertedId);
      expect(originalIds).toContain(secondTask?.id);
    } finally {
      await server.close();
    }
  });

  it('redacts workspace paths from successful task text', async () => {
    const workspace = temporaryRoot();
    const runtime = fakeRuntime(`saved to ${path.join(workspace, 'report.txt')}`);
    const base = serverOptions(runtime, temporaryRoot());
    const server = createKodaXA2AServer({
      ...base,
      agent: { ...base.agent, projectPath: workspace },
    });
    const baseUrl = await server.listen({ hostname: '127.0.0.1', port: 0 });
    try {
      const sent = await rpc(baseUrl, 'SendMessage', {
        message: { messageId: 'redacted-output', role: 'ROLE_USER', parts: [{ text: 'save' }] },
      });
      expect(JSON.stringify(sent.body)).not.toContain(workspace);
      expect(JSON.stringify(sent.body)).toContain('[redacted-path]');
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
      expect(controlled.listenerCount()).toBe(0);
      const second = await rpc(baseUrl, 'CancelTask', { id: taskId });
      expect((second.body.error as { readonly code: number }).code).toBe(-32002);
    } finally {
      await server.close();
    }
  });

  it('turns Runtime start failures into terminal redacted tasks instead of stuck active work', async () => {
    const baseRuntime = fakeRuntime();
    const runtime = {
      ...baseRuntime,
      runs: {
        ...baseRuntime.runs,
        async start() { throw new Error('secret C:\\private\\provider.json'); },
      },
    } as KodaXRuntime;
    const base = serverOptions(runtime, temporaryRoot());
    const server = createKodaXA2AServer({
      ...base,
      limits: { ...base.limits, maxActiveTasksPerPrincipal: 1 },
    });
    const baseUrl = await server.listen({ hostname: '127.0.0.1', port: 0 });
    try {
      const failed = await rpc(baseUrl, 'SendMessage', {
        message: { messageId: 'failed-start', role: 'ROLE_USER', parts: [{ text: 'start' }] },
      });
      expect(JSON.stringify(failed.body)).not.toContain('provider.json');
      const listed = await rpc(baseUrl, 'ListTasks', {});
      expect(JSON.stringify(listed.body)).toContain('TASK_STATE_FAILED');
      const second = await rpc(baseUrl, 'SendMessage', {
        message: { messageId: 'failed-start-2', role: 'ROLE_USER', parts: [{ text: 'start again' }] },
      });
      expect((second.body.error as { readonly code: number }).code).toBe(-32603);
      expect(JSON.stringify(second.body)).not.toContain('active task limit');
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

  it('uses the credential broker for authenticated outbound SSE', async () => {
    const origin = 'http://127.0.0.1:43128';
    const methods: string[] = [];
    const authorizations: Array<string | null> = [];
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.body === undefined) {
        return new Response(JSON.stringify({
          name: 'authenticated stream', description: 'authenticated stream', version: '1.0.0',
          supportedInterfaces: [{ url: `${origin}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
          capabilities: { streaming: true },
          securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
          securityRequirements: [{ schemes: { bearer: { list: [] } } }],
          defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], skills: [],
        }), { headers: { 'content-type': 'application/json' } });
      }
      const request = JSON.parse(String(init.body)) as { readonly id: string; readonly method: string };
      methods.push(request.method);
      authorizations.push(new Headers(init.headers).get('authorization'));
      if (request.method !== 'SubscribeToTask') throw new Error(`Unexpected method: ${request.method}`);
      return new Response(
        `data: ${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
          statusUpdate: {
            taskId: 'authenticated-task', contextId: 'authenticated-context',
            status: { state: 'TASK_STATE_COMPLETED' },
          },
        } })}\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }) as typeof fetch;
    const options = {
      networkPolicy: {
        allowedOrigins: [origin], allowPrivateAddresses: true,
        requestTimeoutMs: 1_000, maxResponseBytes: 128 * 1024, maxRedirects: 0,
      },
      pollIntervalMs: 10,
      fetch: fetchImpl,
    } as const;
    const discovered = await discoverA2ARegistration({
      agentId: 'external:authenticated-stream',
      agentCardUrl: `${origin}/.well-known/agent-card.json`,
      credentialRef: 'env:A2A_TOKEN',
      effects: { remote: 'read' },
    }, options);
    const executor = await createA2AAgentExecutorFactory(options).create(discovered.registration, {
      async withCredential(reference, use) {
        expect(reference).toBe('env:A2A_TOKEN');
        return use('broker-token');
      },
      async authorizeArtifact() {},
    });
    const events: AgentExecutorEvent[] = [];
    for await (const event of executor.events({
      idempotencyKey: 'authenticated-stream', remoteTaskId: 'authenticated-task',
      metadata: { contextId: 'authenticated-context' },
    })) events.push(event);
    expect(events.at(-1)).toEqual(expect.objectContaining({ state: 'completed' }));
    expect(methods).toEqual(['SubscribeToTask']);
    expect(authorizations).toEqual(['Bearer broker-token']);
    await executor.dispose();
  });

  it('accumulates appended artifact chunks before a streamed task completes', async () => {
    const origin = 'http://127.0.0.1:43131';
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.body === undefined) {
        return new Response(JSON.stringify({
          name: 'chunked stream', description: 'chunked stream', version: '1.0.0',
          supportedInterfaces: [{ url: `${origin}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
          capabilities: { streaming: true }, defaultInputModes: ['text/plain'],
          defaultOutputModes: ['text/plain'], skills: [],
        }), { headers: { 'content-type': 'application/json' } });
      }
      const request = JSON.parse(String(init.body)) as { readonly id: string; readonly method: string };
      if (request.method !== 'SubscribeToTask') throw new Error(`Unexpected method: ${request.method}`);
      const frames = [
        { artifactUpdate: {
          taskId: 'chunked-task', contextId: 'chunked-context', append: false, lastChunk: false,
          artifact: { artifactId: 'report', parts: [{ text: 'first chunk' }] },
        } },
        { artifactUpdate: {
          taskId: 'chunked-task', contextId: 'chunked-context', append: true, lastChunk: true,
          artifact: { artifactId: 'report', parts: [{ text: 'second chunk' }] },
        } },
        { statusUpdate: {
          taskId: 'chunked-task', contextId: 'chunked-context',
          status: { state: 'TASK_STATE_COMPLETED' },
        } },
      ].map((result) => `data: ${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n\n`).join('');
      return new Response(frames, { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    const options = {
      networkPolicy: {
        allowedOrigins: [origin], allowPrivateAddresses: true,
        requestTimeoutMs: 1_000, maxResponseBytes: 128 * 1024, maxRedirects: 0,
      },
      pollIntervalMs: 10,
      fetch: fetchImpl,
    } as const;
    const discovered = await discoverA2ARegistration({
      agentId: 'external:chunked-stream', agentCardUrl: `${origin}/.well-known/agent-card.json`,
      effects: { remote: 'read' },
    }, options);
    const executor = await createA2AAgentExecutorFactory(options).create(discovered.registration, {
      async withCredential(_reference, use) { return use('unused'); },
      async authorizeArtifact() {},
    });
    const events: AgentExecutorEvent[] = [];
    for await (const event of executor.events({
      idempotencyKey: 'chunked-stream', remoteTaskId: 'chunked-task',
      metadata: { contextId: 'chunked-context' },
    })) events.push(event);

    expect(events.at(-1)).toEqual(expect.objectContaining({
      state: 'completed',
      output: 'first chunk\nsecond chunk',
    }));
    await executor.dispose();
  });

  it('does not time out a paused stream consumer and aborts it on dispose', async () => {
    const endpoint = 'http://127.0.0.1:43123/a2a';
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let streamSignal: AbortSignal | undefined;
    let streamRequestId = '';
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.body === undefined) {
        return new Response(JSON.stringify({
          name: 'idle remote',
          description: 'idle remote',
          supportedInterfaces: [{
            url: endpoint,
            protocolBinding: 'JSONRPC',
            protocolVersion: '1.0',
          }],
          version: '1.0.0',
          capabilities: { streaming: true, pushNotifications: false },
          defaultInputModes: ['text/plain'],
          defaultOutputModes: ['text/plain'],
          skills: [],
        }), { headers: { 'content-type': 'application/json' } });
      }
      streamSignal = init.signal ?? undefined;
      streamRequestId = (JSON.parse(String(init.body)) as { readonly id: string }).id;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
          markStarted();
        },
      }), { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    const options = {
      networkPolicy: {
        allowedOrigins: ['http://127.0.0.1:43123'], allowPrivateAddresses: true,
        requestTimeoutMs: 20, maxResponseBytes: 128 * 1024, maxRedirects: 0,
      },
      pollIntervalMs: 100,
      fetch: fetchImpl,
    } as const;
    const discovered = await discoverA2ARegistration({
      agentId: 'external:idle-stream',
      agentCardUrl: 'http://127.0.0.1:43123/.well-known/agent-card.json',
      effects: { remote: 'read' },
    }, options);
    const executor = await createA2AAgentExecutorFactory(options).create(
      discovered.registration,
      {
        async withCredential(_reference, use) { return use('unused'); },
        async authorizeArtifact() {},
      },
    );
    const iterator = executor.events({
      idempotencyKey: 'idle-stream-op',
      remoteTaskId: 'idle-task',
      metadata: { contextId: 'idle-context' },
    })[Symbol.asyncIterator]();
    const pending = iterator.next();
    await started;
    streamController?.enqueue(new TextEncoder().encode(
      `data: ${JSON.stringify({
        jsonrpc: '2.0', id: streamRequestId,
        result: { statusUpdate: {
          taskId: 'idle-task', contextId: 'idle-context', status: { state: 'TASK_STATE_WORKING' },
        } },
      })}\n\n`,
    ));
    await pending;
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    expect(streamSignal?.aborted).toBe(false);

    await executor.dispose();
    const abortedByDispose = streamSignal?.aborted === true;
    streamController?.close();

    expect(abortedByDispose).toBe(true);
  });

  it('falls back to polling when an outbound event stream stays idle', async () => {
    const endpoint = 'http://127.0.0.1:43124/a2a';
    let streamAborted = false;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.body === undefined) {
        return new Response(JSON.stringify({
          name: 'idle remote',
          description: 'idle remote',
          supportedInterfaces: [{
            url: endpoint,
            protocolBinding: 'JSONRPC',
            protocolVersion: '1.0',
          }],
          version: '1.0.0',
          capabilities: { streaming: true, pushNotifications: false },
          defaultInputModes: ['text/plain'],
          defaultOutputModes: ['text/plain'],
          skills: [],
        }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () => {
            streamAborted = true;
            controller.error(init.signal?.reason);
          }, { once: true });
        },
      }), { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    const options = {
      networkPolicy: {
        allowedOrigins: ['http://127.0.0.1:43124'], allowPrivateAddresses: true,
        requestTimeoutMs: 20, maxResponseBytes: 128 * 1024, maxRedirects: 0,
      },
      pollIntervalMs: 100,
      fetch: fetchImpl,
    } as const;
    const discovered = await discoverA2ARegistration({
      agentId: 'external:idle-timeout',
      agentCardUrl: 'http://127.0.0.1:43124/.well-known/agent-card.json',
      effects: { remote: 'read' },
    }, options);
    const executor = await createA2AAgentExecutorFactory(options).create(
      discovered.registration,
      {
        async withCredential(_reference, use) { return use('unused'); },
        async authorizeArtifact() {},
      },
    );
    const iterator = executor.events({
      idempotencyKey: 'idle-timeout-op',
      remoteTaskId: 'idle-task',
      metadata: { contextId: 'idle-context' },
    })[Symbol.asyncIterator]();

    const first = await Promise.race([
      iterator.next(),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 250)),
    ]);
    await executor.dispose();

    expect(streamAborted).toBe(true);
    expect(first?.value).toEqual({ progress: { message: 'A2A stream unavailable; polling.' } });
  });

  it('falls back to polling when an outbound stream ends before an interrupted or terminal state', async () => {
    const origin = 'http://127.0.0.1:43125';
    let getCalls = 0;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.body === undefined) {
        return new Response(JSON.stringify({
          name: 'early eof', description: 'early eof', version: '1.0.0',
          supportedInterfaces: [{ url: `${origin}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
          capabilities: { streaming: true }, defaultInputModes: ['text/plain'],
          defaultOutputModes: ['text/plain'], skills: [],
        }), { headers: { 'content-type': 'application/json' } });
      }
      const request = JSON.parse(String(init.body)) as { readonly id: string; readonly method: string };
      if (request.method === 'SubscribeToTask') {
        return new Response(
          `data: ${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
            statusUpdate: { taskId: 'early-task', contextId: 'early-context', status: { state: 'TASK_STATE_WORKING' } },
          } })}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      getCalls += 1;
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id: request.id,
        result: {
          id: 'early-task', contextId: 'early-context', status: { state: 'TASK_STATE_COMPLETED' },
          artifacts: [{ artifactId: 'final', parts: [{ text: 'polled-completion' }] }],
        },
      }), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const options = {
      networkPolicy: {
        allowedOrigins: [origin], allowPrivateAddresses: true,
        requestTimeoutMs: 1_000, maxResponseBytes: 128 * 1024, maxRedirects: 0,
      },
      pollIntervalMs: 1,
      fetch: fetchImpl,
    } as const;
    const discovered = await discoverA2ARegistration({
      agentId: 'external:early-eof', agentCardUrl: `${origin}/.well-known/agent-card.json`,
      effects: { remote: 'read' },
    }, options);
    const executor = await createA2AAgentExecutorFactory(options).create(discovered.registration, {
      async withCredential(_reference, use) { return use('unused'); },
      async authorizeArtifact() {},
    });
    const events: AgentExecutorEvent[] = [];
    for await (const event of executor.events({
      idempotencyKey: 'early-eof', remoteTaskId: 'early-task', metadata: { contextId: 'early-context' },
    })) events.push(event);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: 'working' }),
      { progress: { message: 'A2A stream unavailable; polling.' } },
      expect.objectContaining({ state: 'completed', output: 'polled-completion' }),
    ]));
    expect(getCalls).toBe(1);
  });

  it('rejects a cross-task SSE event and falls back to task-scoped polling', async () => {
    const origin = 'http://127.0.0.1:43130';
    const methods: string[] = [];
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.body === undefined) {
        return new Response(JSON.stringify({
          name: 'cross task stream', description: 'cross task stream', version: '1.0.0',
          supportedInterfaces: [{ url: `${origin}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
          capabilities: { streaming: true }, defaultInputModes: ['text/plain'],
          defaultOutputModes: ['text/plain'], skills: [],
        }), { headers: { 'content-type': 'application/json' } });
      }
      const request = JSON.parse(String(init.body)) as { readonly id: string; readonly method: string };
      methods.push(request.method);
      if (request.method === 'SubscribeToTask') {
        return new Response(
          `data: ${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
            statusUpdate: {
              taskId: 'different-task', contextId: 'different-context',
              status: { state: 'TASK_STATE_COMPLETED' },
            },
          } })}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id: request.id,
        result: {
          id: 'expected-task', contextId: 'expected-context',
          status: { state: 'TASK_STATE_COMPLETED' },
          artifacts: [{ artifactId: 'final', parts: [{ text: 'scoped completion' }] }],
        },
      }), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const options = {
      networkPolicy: {
        allowedOrigins: [origin], allowPrivateAddresses: true,
        requestTimeoutMs: 1_000, maxResponseBytes: 64 * 1024, maxRedirects: 0,
      },
      pollIntervalMs: 1,
      fetch: fetchImpl,
    } as const;
    const discovered = await discoverA2ARegistration({
      agentId: 'external:cross-task', agentCardUrl: `${origin}/.well-known/agent-card.json`,
      effects: { remote: 'read' },
    }, options);
    const executor = await createA2AAgentExecutorFactory(options).create(discovered.registration, {
      async withCredential(_reference, use) { return use('unused'); },
      async authorizeArtifact() {},
    });
    const events: AgentExecutorEvent[] = [];
    for await (const event of executor.events({
      idempotencyKey: 'cross-task', remoteTaskId: 'expected-task',
      metadata: { contextId: 'expected-context' },
    })) events.push(event);
    expect(methods).toEqual(['SubscribeToTask', 'GetTask']);
    expect(events).toEqual(expect.arrayContaining([
      { progress: { message: 'A2A stream unavailable; polling.' } },
      expect.objectContaining({ state: 'completed', output: 'scoped completion' }),
    ]));
    await executor.dispose();
  });

  it('authorizes and preserves inline remote file artifacts as materializable references', async () => {
    const origin = 'http://127.0.0.1:43127';
    const raw = Buffer.from('remote-ppt').toString('base64');
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.body === undefined) {
        return new Response(JSON.stringify({
          name: 'artifact remote', description: 'artifact remote', version: '1.0.0',
          supportedInterfaces: [{ url: `${origin}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
          capabilities: { streaming: false }, defaultInputModes: ['text/plain'],
          defaultOutputModes: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'], skills: [],
        }), { headers: { 'content-type': 'application/json' } });
      }
      const request = JSON.parse(String(init.body)) as { readonly id: string };
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id: request.id,
        result: {
          id: 'artifact-task', contextId: 'artifact-context', status: { state: 'TASK_STATE_COMPLETED' },
          artifacts: [{
            artifactId: 'slides', name: 'slides.pptx',
            parts: [
              { text: 'presentation preview', mediaType: 'text/plain' },
              { raw, filename: 'slides.pptx', mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
            ],
          }],
        },
      }), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const options = {
      networkPolicy: {
        allowedOrigins: [origin], allowPrivateAddresses: true,
        requestTimeoutMs: 1_000, maxResponseBytes: 128 * 1024, maxRedirects: 0,
      },
      pollIntervalMs: 1,
      fetch: fetchImpl,
    } as const;
    const discovered = await discoverA2ARegistration({
      agentId: 'external:artifact', agentCardUrl: `${origin}/.well-known/agent-card.json`,
      effects: { remote: 'read' },
    }, options);
    const authorizeArtifact = vi.fn(async () => undefined);
    const executor = await createA2AAgentExecutorFactory(options).create(discovered.registration, {
      async withCredential(_reference, use) { return use('unused'); },
      authorizeArtifact,
    });
    const snapshot = await executor.get({
      idempotencyKey: 'artifact-get', remoteTaskId: 'artifact-task', metadata: { contextId: 'artifact-context' },
    });
    expect(authorizeArtifact).toHaveBeenCalledOnce();
    expect(snapshot.artifacts?.[0]).toMatchObject({
      name: 'slides.pptx', size: Buffer.byteLength('remote-ppt'),
      uri: `data:application/vnd.openxmlformats-officedocument.presentationml.presentation;base64,${raw}`,
    });
  });

  it('authorizes and preserves file Parts from a direct A2A Message response', async () => {
    const origin = 'http://127.0.0.1:43131';
    const raw = Buffer.from('direct-ppt').toString('base64');
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.body === undefined) {
        return new Response(JSON.stringify({
          name: 'direct artifact', description: 'direct artifact', version: '1.0.0',
          supportedInterfaces: [{ url: `${origin}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
          capabilities: { streaming: false }, defaultInputModes: ['text/plain'],
          defaultOutputModes: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
          skills: [],
        }), { headers: { 'content-type': 'application/json' } });
      }
      const request = JSON.parse(String(init.body)) as { readonly id: string; readonly method: string };
      if (request.method !== 'SendMessage') throw new Error(`Unexpected method: ${request.method}`);
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id: request.id,
        result: {
          message: {
            messageId: 'direct-response', role: 'ROLE_AGENT',
            parts: [{
              raw, filename: 'slides.pptx',
              mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            }],
          },
        },
      }), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const options = {
      networkPolicy: {
        allowedOrigins: [origin], allowPrivateAddresses: true,
        requestTimeoutMs: 1_000, maxResponseBytes: 64 * 1024, maxRedirects: 0,
      },
      pollIntervalMs: 10,
      fetch: fetchImpl,
    } as const;
    const discovered = await discoverA2ARegistration({
      agentId: 'external:direct-artifact', agentCardUrl: `${origin}/.well-known/agent-card.json`,
      effects: { remote: 'read' },
    }, options);
    const authorized: Array<{ readonly name: string; readonly uri?: string }> = [];
    const executor = await createA2AAgentExecutorFactory(options).create(discovered.registration, {
      async withCredential(_reference, use) { return use('unused'); },
      async authorizeArtifact(artifact) { authorized.push(artifact); },
    });
    const reference = await executor.start({
      agentId: discovered.registration.agentId,
      idempotencyKey: 'direct-artifact', objective: 'make slides',
      context: { actorId: 'direct-artifact-test' },
    });
    const events: AgentExecutorEvent[] = [];
    for await (const event of executor.events(reference)) events.push(event);
    expect(authorized).toEqual([expect.objectContaining({
      name: 'slides.pptx',
      uri: `data:application/vnd.openxmlformats-officedocument.presentationml.presentation;base64,${raw}`,
    })]);
    expect(events.at(-1)).toEqual(expect.objectContaining({
      state: 'completed', artifacts: [expect.objectContaining({ name: 'slides.pptx' })],
    }));
    await executor.dispose();
  });

  it('rejects a mismatched JSON-RPC response ID from a remote Agent', async () => {
    const origin = 'http://127.0.0.1:43129';
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.body === undefined) {
        return new Response(JSON.stringify({
          name: 'wrong response id', description: 'wrong response id', version: '1.0.0',
          supportedInterfaces: [{ url: `${origin}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
          capabilities: { streaming: false }, defaultInputModes: ['text/plain'],
          defaultOutputModes: ['text/plain'], skills: [],
        }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id: 'different-request',
        result: { id: 'remote-task', status: { state: 'TASK_STATE_COMPLETED' } },
      }), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const options = {
      networkPolicy: {
        allowedOrigins: [origin], allowPrivateAddresses: true,
        requestTimeoutMs: 1_000, maxResponseBytes: 64 * 1024, maxRedirects: 0,
      },
      pollIntervalMs: 10,
      fetch: fetchImpl,
    } as const;
    const discovered = await discoverA2ARegistration({
      agentId: 'external:wrong-id', agentCardUrl: `${origin}/.well-known/agent-card.json`,
      effects: { remote: 'read' },
    }, options);
    const executor = await createA2AAgentExecutorFactory(options).create(discovered.registration, {
      async withCredential(_reference, use) { return use('unused'); },
      async authorizeArtifact() {},
    });
    await expect(executor.get({
      idempotencyKey: 'wrong-id', remoteTaskId: 'remote-task',
    })).rejects.toThrow(/response id/i);
    await executor.dispose();
  });

  it('returns a running task when a blocking A2A wait reaches its configured limit', async () => {
    const controlled = pendingRuntime();
    const options = serverOptions(controlled.runtime, temporaryRoot());
    const server = createKodaXA2AServer({
      ...options,
      limits: { ...options.limits, maxTaskWaitMs: 20 },
    });
    const baseUrl = await server.listen({ hostname: '127.0.0.1', port: 0 });
    const response = rpc(baseUrl, 'SendMessage', {
      message: { messageId: 'bounded-blocking', role: 'ROLE_USER', parts: [{ text: 'wait' }] },
    });
    const bounded = await Promise.race([
      response,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 250)),
    ]);
    controlled.complete();
    await response;
    await server.close();

    expect(bounded?.status).toBe(200);
    expect(JSON.stringify(bounded?.body)).toContain('TASK_STATE_WORKING');
  });

  it('uses one hot-option snapshot for authentication and authorization during a request', async () => {
    const initial = serverOptions(fakeRuntime(), temporaryRoot());
    const server = createKodaXA2AServer(initial);
    await server.whenReady();
    let releaseBody!: () => void;
    const bodyGate = new Promise<void>((resolve) => { releaseBody = resolve; });
    let markReading!: () => void;
    const reading = new Promise<void>((resolve) => { markReading = resolve; });
    const payload = JSON.stringify({ jsonrpc: '2.0', id: 'hot', method: 'ListTasks', params: {} });
    const split = Math.floor(payload.length / 2);
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (sent) return;
        sent = true;
        controller.enqueue(new TextEncoder().encode(payload.slice(0, split)));
        markReading();
        await bodyGate;
        controller.enqueue(new TextEncoder().encode(payload.slice(split)));
        controller.close();
      },
    });
    const request = new Request('http://127.0.0.1:1/a2a', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token', 'content-type': 'application/json', 'a2a-version': '1.0',
      },
      body,
      duplex: 'half',
    } as RequestInit & { readonly duplex: 'half' });
    const response = server.handle(request);
    await reading;
    server.updateHot({
      agent: initial.agent,
      limits: initial.limits,
      authentication: {
        ...initial.authentication,
        async authenticate() { return null; },
      },
      authorize: initial.authorize,
    });
    releaseBody();

    expect((await response).status).toBe(200);
    const nextRequest = new Request('http://127.0.0.1:1/a2a', {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token', 'content-type': 'application/json', 'a2a-version': '1.0',
      },
      body: payload,
    });
    expect((await server.handle(nextRequest)).status).toBe(401);
    await server.close();
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

  it('rejects a Card-selected interface outside the trusted Card origin', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({
      name: 'retargeted', description: 'retargeted', version: '1.0.0',
      supportedInterfaces: [{
        url: 'http://127.0.0.1:8765/internal', protocolBinding: 'JSONRPC', protocolVersion: '1.0',
      }],
      capabilities: {}, defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], skills: [],
    }), { headers: { 'content-type': 'application/json' } })) as typeof fetch;
    await expect(discoverA2ARegistration({
      agentId: 'external:retargeted', agentCardUrl: 'http://127.0.0.1:43126/.well-known/agent-card.json',
      effects: { remote: 'read' },
    }, {
      fetch: fetchImpl,
      pollIntervalMs: 10,
      networkPolicy: {
        allowedOrigins: ['http://127.0.0.1:43126'], allowPrivateAddresses: true,
        requestTimeoutMs: 1_000, maxResponseBytes: 64 * 1024, maxRedirects: 0,
      },
    })).rejects.toThrow(/same origin/i);

    const sameOriginWithoutAuth = (async () => new Response(JSON.stringify({
      name: 'no-auth', description: 'no-auth', version: '1.0.0',
      supportedInterfaces: [{
        url: 'http://127.0.0.1:43126/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0',
      }],
      capabilities: {}, defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], skills: [],
    }), { headers: { 'content-type': 'application/json' } })) as typeof fetch;
    await expect(discoverA2ARegistration({
      agentId: 'external:no-auth', agentCardUrl: 'http://127.0.0.1:43126/.well-known/agent-card.json',
      credentialRef: 'env:A2A_TOKEN', effects: { remote: 'read' },
    }, {
      fetch: sameOriginWithoutAuth,
      pollIntervalMs: 10,
      networkPolicy: {
        allowedOrigins: ['http://127.0.0.1:43126'], allowPrivateAddresses: true,
        requestTimeoutMs: 1_000, maxResponseBytes: 64 * 1024, maxRedirects: 0,
      },
    })).rejects.toThrow(/Bearer security scheme/i);
  });

  it('rejects wrong protocol versions, message-ID conflicts, and corrupt durable state', async () => {
    const dataDir = temporaryRoot();
    const server = createKodaXA2AServer(serverOptions(fakeRuntime(), dataDir));
    const baseUrl = await server.listen({ hostname: '127.0.0.1', port: 0 });
    try {
      const card = await fetch(`${baseUrl}/.well-known/agent-card.json`)
        .then((response) => response.json() as Promise<{ readonly supportedInterfaces: readonly { readonly url: string }[] }>);
      expect(card.supportedInterfaces[0]?.url).toBe(`${baseUrl}/a2a`);

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
      const inlinePush = await rpc(baseUrl, 'SendMessage', {
        message: { messageId: 'inline-push', role: 'ROLE_USER', parts: [{ text: 'push' }] },
        configuration: { taskPushNotificationConfig: { url: 'https://example.com/events' } },
      });
      expect((inlinePush.body.error as { readonly code: number }).code).toBe(-32003);
      const extended = await rpc(baseUrl, 'GetExtendedAgentCard', {});
      expect((extended.body.error as { readonly code: number }).code).toBe(-32004);
      const unsupported = await rpc(baseUrl, 'SendMessage', {
        message: {
          messageId: 'unsupported-media', role: 'ROLE_USER',
          parts: [{ raw: 'dGNr', mediaType: 'application/x-unsupported' }],
        },
      });
      expect((unsupported.body.error as { readonly code: number }).code).toBe(-32005);

      const defaultVersion = await fetch(`${baseUrl}/a2a`, {
        method: 'POST',
        headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'default-version', method: 'ListTasks', params: {} }),
      });
      const defaultVersionBody = await defaultVersion.json() as { readonly error: { readonly code: number } };
      expect(defaultVersionBody.error.code).toBe(-32009);
      const wrongContentType = await fetch(`${baseUrl}/`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token', 'content-type': 'text/plain', 'a2a-version': '1.0',
        },
        body: '{}',
      });
      expect(wrongContentType.status).toBe(415);
      const oversized = await fetch(`${baseUrl}/`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer test-token', 'content-type': 'application/json', 'a2a-version': '1.0',
        },
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
