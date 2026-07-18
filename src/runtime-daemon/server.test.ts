import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { ExternalAgentRegistrationConflictError } from '@kodax-ai/agent';

import type {
  KodaXRuntime,
  RuntimeClientCapabilities,
  RuntimeCompactSessionResult,
  RuntimeEvent,
  RuntimeEventFilter,
  RuntimeEventListener,
  RuntimeEventReplayFilter,
  RuntimePermissionDecision,
  RuntimePermissionRespondOptions,
  RuntimeRunResult,
  RuntimeStartRunInput,
} from '../sdk-runtime.js';
import {
  RUNTIME_DAEMON_METHODS,
  createRuntimeDaemonRequest,
  isRuntimeDaemonSuccessResponse,
  type RuntimeDaemonMethod,
  type RuntimeDaemonNotification,
} from './protocol.js';
import {
  createRuntimeDaemonDispatcher,
  createRuntimeDaemonRunResultStore,
} from './server.js';
import {
  createRuntimeDaemonClient,
  type RuntimeDaemonClientTransport,
} from './client.js';
import { createRuntimeControlJournal } from './control-journal.js';
import { createRuntimeDaemonReverseBridgeHub } from './reverse-bridge.js';
import type { RuntimeDaemonManagementController } from './management.js';

describe('runtime daemon dispatcher', () => {
  it('passes Agent revision fences and maps stale follow-ups to conflict', async () => {
    const runtime = makeRuntime();
    const followup = vi.spyOn(runtime.agents, 'followup').mockRejectedValue(Object.assign(
      new Error('Actor revision 4 is stale; current revision is 5.'),
      { code: 'revision_conflict' as const, expectedRevision: 4, currentRevision: 5 },
    ));
    const dispatcher = createRuntimeDaemonDispatcher({ runtime });
    await initializeDispatcher(dispatcher);

    const response = await dispatcher.handle(createRuntimeDaemonRequest(
      'req-agent-followup-conflict',
      'agents.followup',
      {
        sessionId: 'session-1',
        actorPath: '/root/worker',
        objective: 'Distinct stale follow-up.',
        expectedRevision: 4,
      },
    ));

    expect(followup).toHaveBeenCalledWith(
      'session-1',
      '/root/worker',
      'Distinct stale follow-up.',
      { expectedRevision: 4 },
    );
    expect(isRuntimeDaemonSuccessResponse(response)).toBe(false);
    if (!isRuntimeDaemonSuccessResponse(response)) {
      expect(response.error).toMatchObject({
        code: 'conflict',
        data: {
          conflict: 'revision_conflict',
          expectedRevision: 4,
          currentRevision: 5,
        },
      });
    }
    dispatcher.close();
  });

  it('maps fenced external Agent registration conflicts to the stable daemon conflict code', async () => {
    const runtime = makeRuntime();
    vi.spyOn(runtime.admin.agentRegistrations, 'upsert')
      .mockRejectedValue(new ExternalAgentRegistrationConflictError('external:stale'));
    const dispatcher = createRuntimeDaemonDispatcher({
      runtime,
      allowAgentRegistrationAdmin: true,
    });
    await initializeDispatcher(dispatcher);

    const response = await dispatcher.handle(createRuntimeDaemonRequest(
      'req-registration-conflict',
      'agentRegistrations.upsert',
      {
        registration: {
          agentId: 'external:stale',
          displayName: 'Stale',
          enabled: true,
          executorId: 'a2a',
          protocol: 'a2a',
          configurationRevision: 'stale-revision',
          endpointIdentityHash: 'stale-endpoint',
          capabilities: {},
          effects: { remote: 'read', workspace: 'proposal' },
        },
        expectedConfigurationRevision: 'expected-revision',
      },
    ));

    expect(isRuntimeDaemonSuccessResponse(response)).toBe(false);
    if (!isRuntimeDaemonSuccessResponse(response)) {
      expect(response.error).toMatchObject({
        code: 'conflict',
        data: {
          agentId: 'external:stale',
          conflict: 'external_agent_registration_conflict',
        },
      });
    }
    dispatcher.close();
  });

  it('requires initialize before runtime methods and rejects double initialize', async () => {
    const dispatcher = createRuntimeDaemonDispatcher({ runtime: makeRuntime() });

    const preInitialize = await dispatcher.handle(createRuntimeDaemonRequest('req-before-init', 'run.list'));
    expect(isRuntimeDaemonSuccessResponse(preInitialize)).toBe(false);
    if (!isRuntimeDaemonSuccessResponse(preInitialize)) {
      expect(preInitialize.error.code).toBe('not_initialized');
    }

    await initializeDispatcher(dispatcher);

    const secondInitialize = await dispatcher.handle(createRuntimeDaemonRequest('req-init-again', 'initialize', {
      profile: 'default',
    }));
    expect(isRuntimeDaemonSuccessResponse(secondInitialize)).toBe(false);
    if (!isRuntimeDaemonSuccessResponse(secondInitialize)) {
      expect(secondInitialize.error.code).toBe('conflict');
    }
  });

  it('validates method params and dispatcher results against the protocol schema', async () => {
    const dispatcher = createRuntimeDaemonDispatcher({
      runtime: makeRuntime(),
      providerList: () => ({ invalid: 'provider-list-result' }),
    });
    await initializeDispatcher(dispatcher);

    const invalidParams = await dispatcher.handle(createRuntimeDaemonRequest(
      'req-invalid-params',
      'session.load',
      { sessionId: 42 },
    ));
    const invalidResult = await dispatcher.handle(createRuntimeDaemonRequest(
      'req-invalid-result',
      'provider.list',
    ));

    expect(isRuntimeDaemonSuccessResponse(invalidParams)).toBe(false);
    expect(isRuntimeDaemonSuccessResponse(invalidResult)).toBe(false);
    if (!isRuntimeDaemonSuccessResponse(invalidParams)) {
      expect(invalidParams.error).toMatchObject({ code: 'invalid_params' });
      expect(invalidParams.error.data).toMatchObject({
        issues: expect.arrayContaining(['params.sessionId must be string.']),
      });
    }
    if (!isRuntimeDaemonSuccessResponse(invalidResult)) {
      expect(invalidResult.error).toMatchObject({ code: 'internal_error' });
      expect(invalidResult.error.message).toContain('invalid result');
    }
  });

  it('applies session admission to event, interaction, and diagnostic side paths', async () => {
    const runtime = makeRuntime();
    vi.spyOn(runtime.sessions, 'transcript').mockImplementation(async (sessionId) => {
      if (sessionId === 'partner-session') {
        throw Object.assign(new Error('Partner session is not admitted.'), {
          code: 'session_not_admitted' as const,
        });
      }
      return null;
    });
    const dispatcher = createRuntimeDaemonDispatcher({ runtime });
    await initializeDispatcher(dispatcher);

    const requests = [
      createRuntimeDaemonRequest('req-event-subscribe', 'event.subscribe', {
        filter: { sessionId: 'partner-session' },
      }),
      createRuntimeDaemonRequest('req-event-replay', 'event.replay', {
        sessionId: 'partner-session',
      }),
      createRuntimeDaemonRequest('req-permission-list', 'permission.list', {
        sessionId: 'partner-session',
      }),
      createRuntimeDaemonRequest('req-permission-request', 'permission.request', {
        sessionId: 'partner-session',
        runId: 'partner-run',
        toolName: 'read',
      }),
      createRuntimeDaemonRequest('req-user-input-list', 'user_input.listPending', {
        sessionId: 'partner-session',
      }),
      createRuntimeDaemonRequest('req-diagnostic', 'context.budget.get', {
        sessionId: 'partner-session',
      }),
    ];

    for (const request of requests) {
      const response = await dispatcher.handle(request);
      expect(isRuntimeDaemonSuccessResponse(response)).toBe(false);
      if (!isRuntimeDaemonSuccessResponse(response)) {
        expect(response.error.code).toBe('session_not_admitted');
      }
    }
  });

  it('requires the configured daemon token during initialize', async () => {
    const dispatcher = createRuntimeDaemonDispatcher({
      runtime: makeRuntime(),
      authToken: 'token-1',
    });

    const missing = await dispatcher.handle(createRuntimeDaemonRequest('req-missing-token', 'initialize', {
      profile: 'default',
    }));
    expect(isRuntimeDaemonSuccessResponse(missing)).toBe(false);
    if (!isRuntimeDaemonSuccessResponse(missing)) {
      expect(missing.error.code).toBe('unauthorized');
    }

    const accepted = await dispatcher.handle(createRuntimeDaemonRequest('req-token', 'initialize', {
      profile: 'default',
      token: 'token-1',
    }));
    expect(isRuntimeDaemonSuccessResponse(accepted)).toBe(true);
  });

  it('requires the negotiated durable envelope and deduplicates an exact mutation retry', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-server-operations-'));
    try {
      const runtime = makeRuntime();
      const start = vi.spyOn(runtime.runs, 'start');
      const controlJournal = createRuntimeControlJournal({ rootDir });
      const dispatcher = createRuntimeDaemonDispatcher({
        runtime,
        controlJournal,
        requireOperationEnvelope: true,
      });
      await initializeDispatcher(dispatcher, { operationDeduplication: true });

      const missing = await dispatcher.handle(createRuntimeDaemonRequest(
        'req-missing-operation',
        'run.start',
        { sessionId: 'session-1', prompt: 'hello' },
      ));
      expect(isRuntimeDaemonSuccessResponse(missing)).toBe(false);
      if (!isRuntimeDaemonSuccessResponse(missing)) {
        expect(missing.error.code).toBe('operation_required');
      }

      const operation = {
        operationId: 'op-server-1',
        journalEpoch: controlJournal.journalEpoch,
      } as const;
      const first = await dispatcher.handle(createRuntimeDaemonRequest(
        'req-operation-1',
        'run.start',
        { sessionId: 'session-1', prompt: 'hello' },
        operation,
      ));
      const retried = await dispatcher.handle(createRuntimeDaemonRequest(
        'req-operation-2',
        'run.start',
        { sessionId: 'session-1', prompt: 'hello' },
        operation,
      ));
      const receipt = await dispatcher.handle(createRuntimeDaemonRequest(
        'req-operation-get',
        'operation.get',
        operation,
      ));

      expect(isRuntimeDaemonSuccessResponse(first)).toBe(true);
      expect(retried).toEqual({ ...first, id: 'req-operation-2' });
      expect(isRuntimeDaemonSuccessResponse(receipt)).toBe(true);
      if (isRuntimeDaemonSuccessResponse(receipt)) {
        expect(receipt.result).toMatchObject({ operationId: operation.operationId, state: 'applied' });
        expect(receipt.result).toMatchObject({
          result: { runId: 'run-1', sessionId: 'session-1' },
        });
      }
      expect(start).toHaveBeenCalledTimes(1);
      dispatcher.close();
    } finally {
      fs.rmSync(rootDir, { force: true, recursive: true });
    }
  });

  it('marks every dispatched mutation unknown-safe before applying its effect', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-server-dispatch-'));
    try {
      const runtime = makeRuntime();
      let resolveCreate: ((value: Awaited<ReturnType<KodaXRuntime['sessions']['create']>>) => void)
        | undefined;
      const pendingCreate = new Promise<Awaited<ReturnType<KodaXRuntime['sessions']['create']>>>(
        (resolve) => { resolveCreate = resolve; },
      );
      vi.spyOn(runtime.sessions, 'create').mockImplementation(() => pendingCreate);
      const controlJournal = createRuntimeControlJournal({ rootDir });
      const dispatcher = createRuntimeDaemonDispatcher({
        runtime,
        controlJournal,
        requireOperationEnvelope: true,
      });
      await initializeDispatcher(dispatcher, { operationDeduplication: true });
      const operation = {
        operationId: 'op-session-create',
        journalEpoch: controlJournal.journalEpoch,
      } as const;

      const response = dispatcher.handle(createRuntimeDaemonRequest(
        'req-session-create',
        'session.create',
        { title: 'Created once' },
        operation,
      ));

      await vi.waitFor(() => {
        expect(controlJournal.get(operation.operationId)?.state).toBe('dispatched');
      });
      resolveCreate?.({ id: 'session-created', title: 'Created once' });
      expect(isRuntimeDaemonSuccessResponse(await response)).toBe(true);
      expect(controlJournal.get(operation.operationId)?.state).toBe('applied');
      dispatcher.close();
    } finally {
      fs.rmSync(rootDir, { force: true, recursive: true });
    }
  });

  it('keeps a legacy client read-only when durable operations are required', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-server-legacy-'));
    try {
      const dispatcher = createRuntimeDaemonDispatcher({
        runtime: makeRuntime(),
        controlJournal: createRuntimeControlJournal({ rootDir }),
        requireOperationEnvelope: true,
      });
      await initializeDispatcher(dispatcher, {});

      const read = await dispatcher.handle(createRuntimeDaemonRequest('req-read', 'run.list'));
      const mutation = await dispatcher.handle(createRuntimeDaemonRequest(
        'req-write',
        'session.create',
        { title: 'legacy write' },
      ));

      expect(isRuntimeDaemonSuccessResponse(read)).toBe(true);
      expect(isRuntimeDaemonSuccessResponse(mutation)).toBe(false);
      if (!isRuntimeDaemonSuccessResponse(mutation)) {
        expect(mutation.error.code).toBe('client_upgrade_required');
      }
      dispatcher.close();
    } finally {
      fs.rmSync(rootDir, { force: true, recursive: true });
    }
  });

  it('routes reverse-bridge state changes through the daemon draining fence', async () => {
    const fencedMutations: RuntimeDaemonMethod[] = [];
    const conflict = Object.assign(new Error('Runtime daemon is draining.'), {
      code: 'conflict' as const,
    });
    const management: RuntimeDaemonManagementController = {
      attachClient() {},
      detachClient() {},
      async runMutation<T>(method: RuntimeDaemonMethod): Promise<T> {
        fencedMutations.push(method);
        throw conflict;
      },
      async preflight() { throw new Error('not used'); },
      async inspect() { throw new Error('not used'); },
      async stop() { throw new Error('not used'); },
      async rollbackToInline() { throw new Error('not used'); },
      close() {},
    };
    const dispatcher = createRuntimeDaemonDispatcher({
      runtime: makeRuntime(),
      management,
      requireOperationEnvelope: true,
    });
    await initializeDispatcher(dispatcher, { operationDeduplication: true });
    const requests: readonly {
      readonly method: RuntimeDaemonMethod;
      readonly params: unknown;
    }[] = [
      {
        method: 'credential.register',
        params: { leaseId: 'credential-fenced', providers: ['mock'] },
      },
      { method: 'credential.revoke', params: { leaseId: 'credential-fenced' } },
      {
        method: 'credential.supply',
        params: { requestId: 'credential-request-fenced', credential: 'never-dispatched' },
      },
      {
        method: 'host_tool.register',
        params: {
          leaseId: 'host-tools-fenced',
          tools: [{
            name: 'space_artifact_create',
            inputSchema: { type: 'object' },
            sideEffect: 'non_idempotent',
          }],
        },
      },
      { method: 'host_tool.revoke', params: { leaseId: 'host-tools-fenced' } },
      {
        method: 'host_tool.complete',
        params: { invocationId: 'host-invocation-fenced', error: 'not dispatched' },
      },
    ];

    for (const [index, request] of requests.entries()) {
      const response = await dispatcher.handle(createRuntimeDaemonRequest(
        `req-fenced-${index}`,
        request.method,
        request.params,
      ));
      expect(isRuntimeDaemonSuccessResponse(response)).toBe(false);
      if (!isRuntimeDaemonSuccessResponse(response)) {
        expect(response.error).toMatchObject({ code: 'conflict' });
      }
    }

    expect(fencedMutations).toEqual(requests.map((request) => request.method));
    dispatcher.close();
  });

  it('rejects non-versioned session setting writes on a shared daemon', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-server-settings-'));
    try {
      const runtime = makeRuntime();
      const update = vi.spyOn(runtime.sessions, 'updateSettings');
      const controlJournal = createRuntimeControlJournal({ rootDir });
      const dispatcher = createRuntimeDaemonDispatcher({
        runtime,
        controlJournal,
        requireOperationEnvelope: true,
      });
      await initializeDispatcher(dispatcher, { operationDeduplication: true });

      const response = await dispatcher.handle(createRuntimeDaemonRequest(
        'req-legacy-settings',
        'session.settings.update',
        { sessionId: 'session-1', patch: { model: 'racing-model' } },
        {
          operationId: 'op-legacy-settings',
          journalEpoch: controlJournal.journalEpoch,
        },
      ));

      expect(isRuntimeDaemonSuccessResponse(response)).toBe(false);
      if (!isRuntimeDaemonSuccessResponse(response)) {
        expect(response.error.code).toBe('client_upgrade_required');
      }
      expect(update).not.toHaveBeenCalled();
      dispatcher.close();
    } finally {
      fs.rmSync(rootDir, { force: true, recursive: true });
    }
  });

  it('orders an after-turn continuation once across an exact operation retry', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-server-input-'));
    try {
      const runtime = makeRuntime();
      vi.spyOn(runtime.runs, 'get').mockResolvedValue({
        runId: 'run-active',
        sessionId: 'session-1',
        phase: 'running',
        startedAt: '2026-07-14T00:00:00.000Z',
        provider: 'mock',
      });
      const submit = vi.spyOn(runtime.runs, 'submitInput').mockResolvedValue({
        accepted: true,
        delivery: 'after_turn',
        runId: 'run-continuation',
        sessionId: 'session-1',
        afterRunId: 'run-active',
        sessionOrder: 2,
      });
      const controlJournal = createRuntimeControlJournal({ rootDir });
      const dispatcher = createRuntimeDaemonDispatcher({
        runtime,
        controlJournal,
        requireOperationEnvelope: true,
      });
      await initializeDispatcher(dispatcher, { operationDeduplication: true });
      const operation = {
        operationId: 'op-input-1',
        journalEpoch: controlJournal.journalEpoch,
      } as const;
      const params = {
        sessionId: 'session-1',
        afterRunId: 'run-active',
        delivery: 'after_turn',
        input: { type: 'text', text: 'continue' },
      } as const;

      const first = await dispatcher.handle(createRuntimeDaemonRequest(
        'req-input-1',
        'run.input.submit',
        params,
        operation,
      ));
      const retry = await dispatcher.handle(createRuntimeDaemonRequest(
        'req-input-2',
        'run.input.submit',
        params,
        operation,
      ));

      expect(isRuntimeDaemonSuccessResponse(first)).toBe(true);
      expect(retry).toEqual({ ...first, id: 'req-input-2' });
      expect(submit).toHaveBeenCalledTimes(1);
      dispatcher.close();
    } finally {
      fs.rmSync(rootDir, { force: true, recursive: true });
    }
  });

  it('binds credential and host-tool reverse calls only to the requesting run', async () => {
    const runtime = makeRuntime();
    const reverseBridgeHub = createRuntimeDaemonReverseBridgeHub();
    let notificationListener: ((notification: RuntimeDaemonNotification) => void) | undefined;
    const dispatcher = createRuntimeDaemonDispatcher({
      runtime,
      reverseBridgeHub,
      notify(notification) {
        notificationListener?.(notification);
      },
    });
    await initializeDispatcher(dispatcher);
    const transport: RuntimeDaemonClientTransport = {
      async request(method, params, operation) {
        const response = await dispatcher.handle(createRuntimeDaemonRequest(
          `req-loopback-${randomRequestSuffix()}`,
          method,
          params,
          operation,
        ));
        if (isRuntimeDaemonSuccessResponse(response)) return response.result;
        throw Object.assign(new Error(response.error.message), { code: response.error.code });
      },
      subscribe(listener) {
        notificationListener = listener;
        return {
          close() {
            if (notificationListener === listener) notificationListener = undefined;
          },
        };
      },
    };
    let handlerCalls = 0;
    const start = vi.spyOn(runtime.runs, 'start').mockImplementation(async (input) => {
      const trusted = input as RuntimeStartRunInput & {
        readonly providerCredential?: string;
        readonly trustedRunId: string;
      };
      expect(trusted.providerCredential).toBe('space-secret');
      const extensionRuntime = input.options?.extensionRuntime;
      if (!extensionRuntime) throw new Error('expected run-bound extension runtime');
      const [tool] = await extensionRuntime.searchCapabilities('mcp', 'space_artifact_create', {
        kind: 'tool',
      }) as Array<{ readonly id: string }>;
      if (!tool) throw new Error('expected bound host tool');
      await expect(extensionRuntime.executeCapability('mcp', tool.id, { title: 'Report' }))
        .resolves.toMatchObject({ content: 'artifact-created' });
      const result: RuntimeRunResult = {
        runId: trusted.trustedRunId,
        sessionId: input.sessionId,
        phase: 'completed',
      };
      return { runId: result.runId, sessionId: result.sessionId, result: Promise.resolve(result) };
    });
    vi.spyOn(runtime.runs, 'get').mockImplementation(async (runId) => ({
      runId,
      sessionId: 'session-1',
      phase: 'running',
      startedAt: '2026-07-14T00:00:00.000Z',
      provider: 'mock',
    }));
    const client = createRuntimeDaemonClient({
      identity: runtime.identity,
      transport,
      capabilities: {},
    });
    const credential = await client.credentials.register({ providers: ['mock'] }, async () => 'space-secret');
    const tools = await client.hostTools.register([{
      name: 'space_artifact_create',
      description: 'Create a Space artifact',
      inputSchema: { type: 'object' },
      sideEffect: 'non_idempotent',
    }], {
      async space_artifact_create() {
        handlerCalls += 1;
        return { content: 'artifact-created' };
      },
    });

    const handle = await client.runs.start({
      sessionId: 'session-1',
      prompt: 'create an artifact',
      credential: { leaseId: credential.id, provider: 'mock' },
      hostTools: { leaseId: tools.id },
    });
    await expect(client.runs.get(handle.runId)).resolves.toMatchObject({
      requirements: {
        credential: { leaseId: credential.id, provider: 'mock', state: 'ready' },
        hostTools: { leaseId: tools.id, state: 'ready' },
      },
    });

    expect(start).toHaveBeenCalledTimes(1);
    expect(handlerCalls).toBe(1);
    await client.close();
    dispatcher.close();
    reverseBridgeHub.close();
  });

  it('rejects initialize when the requested profile differs from the daemon identity', async () => {
    const dispatcher = createRuntimeDaemonDispatcher({ runtime: makeRuntime() });

    const mismatch = await dispatcher.handle(createRuntimeDaemonRequest('req-profile-mismatch', 'initialize', {
      profile: 'space',
    }));
    expect(isRuntimeDaemonSuccessResponse(mismatch)).toBe(false);
    if (!isRuntimeDaemonSuccessResponse(mismatch)) {
      expect(mismatch.error.code).toBe('conflict');
      expect(mismatch.error.message).toContain('Runtime daemon profile mismatch');
    }

    const accepted = await dispatcher.handle(createRuntimeDaemonRequest('req-profile-ok', 'initialize', {
      profile: 'default',
    }));
    expect(isRuntimeDaemonSuccessResponse(accepted)).toBe(true);
  });

  it('routes every declared daemon method to an implemented dispatcher branch', async () => {
    for (const method of RUNTIME_DAEMON_METHODS) {
      const dispatcher = createRuntimeDaemonDispatcher({
        runtime: makeRuntime(),
        allowAgentRegistrationAdmin: true,
      });
      if (!isInitializeMethod(method)) {
        await initializeDispatcher(dispatcher);
      }

      const response = await dispatcher.handle(createRuntimeDaemonRequest(
        `req-${method.replace(/[^a-zA-Z0-9]/g, '-')}`,
        method,
        METHOD_SMOKE_PARAMS[method],
      ));
      dispatcher.close();

      const implemented = isRuntimeDaemonSuccessResponse(response) || (
        (
          method === 'daemon.management.get'
          || method === 'daemon.rollbackToInline'
        )
        && response.error.code === 'client_upgrade_required'
      );
      expect(
        implemented,
        `${method} should be implemented by runtime daemon dispatcher`,
      ).toBe(true);
    }
  });

  it('requires host authorization but never treats client capability claims as authorization', async () => {
    const hostDenied = createRuntimeDaemonDispatcher({
      runtime: makeRuntime(),
      capabilities: {
        externalAgentAdmin: { version: 99 },
        a2aConfigReconciler: { version: 99 },
      },
    });
    const deniedInitialization = await initializeDispatcher(hostDenied, { configAdmin: true });
    expect(deniedInitialization).toMatchObject({ capabilities: { externalAgents: true } });
    expect((deniedInitialization.capabilities as Record<string, unknown>).externalAgentAdmin)
      .toBeUndefined();
    expect((deniedInitialization.capabilities as Record<string, unknown>).a2aConfigReconciler)
      .toBeUndefined();
    const denied = await hostDenied.handle(createRuntimeDaemonRequest(
      'req-agent-admin-host-denied',
      'agentRegistrations.list',
    ));
    expect(isRuntimeDaemonSuccessResponse(denied)).toBe(false);
    if (!isRuntimeDaemonSuccessResponse(denied)) {
      expect(denied.error.code).toBe('permission_denied');
    }

    const hostAccepted = createRuntimeDaemonDispatcher({
      runtime: makeRuntime(),
      allowAgentRegistrationAdmin: true,
    });
    const acceptedInitialization = await initializeDispatcher(hostAccepted, {});
    expect(acceptedInitialization).toMatchObject({
      capabilities: { externalAgentAdmin: { version: 1 } },
    });
    const accepted = await hostAccepted.handle(createRuntimeDaemonRequest(
      'req-agent-admin-host-accepted',
      'agentRegistrations.list',
    ));
    expect(isRuntimeDaemonSuccessResponse(accepted)).toBe(true);
  });

  it('forwards registration ownership and revision-CAS mutation fields', async () => {
    const runtime = makeRuntime();
    const upsert = vi.spyOn(runtime.admin.agentRegistrations, 'upsert');
    const setEnabled = vi.spyOn(runtime.admin.agentRegistrations, 'setEnabled');
    const remove = vi.spyOn(runtime.admin.agentRegistrations, 'remove');
    const dispatcher = createRuntimeDaemonDispatcher({
      runtime,
      allowAgentRegistrationAdmin: true,
    });
    await initializeDispatcher(dispatcher);

    const response = await dispatcher.handle(createRuntimeDaemonRequest(
      'req-agent-set-enabled-cas',
      'agentRegistrations.setEnabled',
      {
        agentId: 'external:smoke',
        enabled: false,
        expectedConfigurationRevision: 'rev-1',
        expectedManagementOwner: null,
        claimOwner: 'runtime-config-test',
      },
    ));
    expect(isRuntimeDaemonSuccessResponse(response)).toBe(true);
    expect(setEnabled).toHaveBeenCalledWith('external:smoke', false, {
      expectedConfigurationRevision: 'rev-1',
      expectedManagementOwner: null,
      claimOwner: 'runtime-config-test',
    });

    await dispatcher.handle(createRuntimeDaemonRequest(
      'req-agent-upsert-cas',
      'agentRegistrations.upsert',
      {
        registration: METHOD_SMOKE_PARAMS['agentRegistrations.upsert'].registration,
        expectedConfigurationRevision: null,
        expectedManagementOwner: null,
      },
    ));
    expect(upsert).toHaveBeenCalledWith(
      METHOD_SMOKE_PARAMS['agentRegistrations.upsert'].registration,
      { expectedConfigurationRevision: null, expectedManagementOwner: null },
    );

    await dispatcher.handle(createRuntimeDaemonRequest(
      'req-agent-remove-cas',
      'agentRegistrations.remove',
      {
        agentId: 'external:smoke',
        expectedConfigurationRevision: 'rev-1',
        expectedManagementOwner: 'runtime-config-test',
      },
    ));
    expect(remove).toHaveBeenCalledWith('external:smoke', {
      expectedConfigurationRevision: 'rev-1',
      expectedManagementOwner: 'runtime-config-test',
    });

    const invalid = await dispatcher.handle(createRuntimeDaemonRequest(
      'req-agent-set-enabled-empty-owner',
      'agentRegistrations.setEnabled',
      { agentId: 'external:smoke', enabled: false, claimOwner: '' },
    ));
    expect(isRuntimeDaemonSuccessResponse(invalid)).toBe(false);
    if (!isRuntimeDaemonSuccessResponse(invalid)) {
      expect(invalid.error).toMatchObject({ code: 'invalid_request' });
    }
  });

  it('uses server-issued scopes instead of client capability claims for authorization', async () => {
    const dispatcher = createRuntimeDaemonDispatcher({
      runtime: makeRuntime(),
      grantedScopes: ['session:observe'],
    });
    await initializeDispatcher(dispatcher, { configAdmin: true });

    const read = await dispatcher.handle(createRuntimeDaemonRequest('req-scoped-read', 'session.list'));
    const write = await dispatcher.handle(createRuntimeDaemonRequest('req-scoped-write', 'config.patch', {
      patch: { model: 'mock-model' },
    }));

    expect(isRuntimeDaemonSuccessResponse(read)).toBe(true);
    expect(isRuntimeDaemonSuccessResponse(write)).toBe(false);
    if (!isRuntimeDaemonSuccessResponse(write)) {
      expect(write.error.code).toBe('unauthorized');
      expect(write.error.message).toContain('integration:admin');
    }
  });

  it('advertises versioned shared-daemon facts without claiming interrupt support', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-server-capabilities-'));
    try {
      const controlJournal = createRuntimeControlJournal({ rootDir });
      const dispatcher = createRuntimeDaemonDispatcher({
        runtime: makeRuntime(),
        controlJournal,
        allowAgentRegistrationAdmin: true,
      });
      const initialized = await initializeDispatcher(dispatcher, { operationDeduplication: true });

      expect(initialized).toMatchObject({
        capabilities: {
          sessionObservation: { version: 1 },
          operationDeduplication: { version: 1 },
          externalAgentAdmin: {
            version: 1,
            activation: true,
            conditionalMutations: true,
            managementOwner: true,
          },
          afterTurnInput: { version: 1 },
          askUserTransport: { version: 1 },
          permissionCas: { version: 1 },
          providerCredentialBroker: { version: 1 },
          runBoundHostTools: { version: 1 },
          coderOwnerFencing: { version: 1 },
          crashOutcomeModel: { version: 1 },
          sessionAdmission: { version: 1, partnerDenied: true },
          completeObservationSnapshot: { version: 1, queuedInputs: true },
          connectionLifecycle: { version: 1 },
          typedRuntimeEvents: { version: 1 },
          daemonSafeRunInput: { version: 1 },
          sharedSessionSettings: {
            version: 1,
            keys: expect.arrayContaining([
              'agentMode',
              'autoModeEngine',
              'autoModeClassifierModel',
              'autoModeTimeoutMs',
            ]),
          },
          durableRecoveryQueries: {
            version: 1,
            operationResult: true,
            daemonPreflight: true,
            terminalAcknowledgement: false,
          },
        },
      });
      expect((initialized.capabilities as Record<string, unknown>).interruptInput).toBeUndefined();
      dispatcher.close();
    } finally {
      fs.rmSync(rootDir, { force: true, recursive: true });
    }
  });

  it('routes canonical protocol aliases for external clients', async () => {
    const dispatcher = createRuntimeDaemonDispatcher({ runtime: makeRuntime() });
    const initialized = await dispatcher.handle(createRuntimeDaemonRequest('req-init', 'runtime.initialize', {
      profile: 'default',
      capabilities: { contextDiagnostics: true },
    }));
    expect(isRuntimeDaemonSuccessResponse(initialized)).toBe(true);

    const status = await dispatcher.handle(createRuntimeDaemonRequest('req-status', 'runtime.status'));
    const capabilities = await dispatcher.handle(createRuntimeDaemonRequest('req-capabilities', 'runtime.capabilities'));
    const setModel = await dispatcher.handle(createRuntimeDaemonRequest('req-model', 'run.setModel', {
      runId: 'run-1',
      model: 'mock-model-2',
    }));
    const setProvider = await dispatcher.handle(createRuntimeDaemonRequest('req-provider', 'run.setProvider', {
      runId: 'run-1',
      provider: 'mock-provider-2',
    }));
    const setReasoning = await dispatcher.handle(createRuntimeDaemonRequest('req-reasoning', 'run.setReasoning', {
      runId: 'run-1',
      reasoning: 'balanced',
    }));
    const activeEntry = await dispatcher.handle(createRuntimeDaemonRequest('req-active-entry', 'session.activeEntry.set', {
      sessionId: 'session-1',
      entryId: 'entry-1',
    }));
    const pendingPermissions = await dispatcher.handle(createRuntimeDaemonRequest(
      'req-permissions',
      'permission.listPending',
    ));
    const skill = await dispatcher.handle(createRuntimeDaemonRequest('req-skill-read', 'skill.read', {
      name: 'review',
    }));
    const removedMcp = await dispatcher.handle(createRuntimeDaemonRequest('req-mcp-remove', 'mcp.server.remove', {
      name: 'local',
    }));

    for (const response of [
      status,
      capabilities,
      setModel,
      setProvider,
      setReasoning,
      activeEntry,
      pendingPermissions,
      skill,
      removedMcp,
    ]) {
      expect(isRuntimeDaemonSuccessResponse(response)).toBe(true);
    }
    if (isRuntimeDaemonSuccessResponse(capabilities)) {
      expect(capabilities.result).toMatchObject({
        events: true,
        contextDiagnostics: true,
        actorControlPlane: { version: 1, methodNamespace: 'agents' },
      });
    }
    if (isRuntimeDaemonSuccessResponse(activeEntry)) {
      expect(activeEntry.result).toMatchObject({ id: 'session-1', title: 'Active Entry Session' });
    }
    if (isRuntimeDaemonSuccessResponse(skill)) {
      expect(skill.result).toMatchObject({ name: 'review', content: 'Review instructions' });
    }
    if (isRuntimeDaemonSuccessResponse(removedMcp)) {
      expect(removedMcp.result).toBe(true);
    }
  });

  it('returns an explicit upgrade path for the retired agentTasks namespace', async () => {
    const dispatcher = createRuntimeDaemonDispatcher({ runtime: makeRuntime() });
    await initializeDispatcher(dispatcher);

    const response = await dispatcher.handle({
      ...createRuntimeDaemonRequest('req-retired-agent-tasks', 'ping'),
      method: 'agentTasks.start',
      params: {},
    });

    expect(response).toMatchObject({
      kind: 'error',
      error: {
        code: 'client_upgrade_required',
        message: expect.stringContaining('actorControlPlane v1'),
      },
    });
    dispatcher.close();
  });

  it('routes run.start and run.await through the hosted runtime', async () => {
    const runtime = makeRuntime();
    const dispatcher = createRuntimeDaemonDispatcher({ runtime });
    await initializeDispatcher(dispatcher);

    const started = await dispatcher.handle(createRuntimeDaemonRequest('req-1', 'run.start', {
      sessionId: 'session-1',
      prompt: 'hello',
    }));
    const awaited = await dispatcher.handle(createRuntimeDaemonRequest('req-2', 'run.await', {
      runId: 'run-1',
    }));

    expect(isRuntimeDaemonSuccessResponse(started)).toBe(true);
    expect(isRuntimeDaemonSuccessResponse(awaited)).toBe(true);
    if (isRuntimeDaemonSuccessResponse(started)) {
      expect(started.result).toMatchObject({ runId: 'run-1', sessionId: 'session-1' });
    }
    if (isRuntimeDaemonSuccessResponse(awaited)) {
      expect(awaited.result).toMatchObject({ runId: 'run-1', sessionId: 'session-1', phase: 'completed' });
    }
  });

  it('shares retained run results across daemon dispatchers', async () => {
    const runtime = makeRuntime();
    const runResults = createRuntimeDaemonRunResultStore();
    const firstConnection = createRuntimeDaemonDispatcher({ runtime, runResults });
    const secondConnection = createRuntimeDaemonDispatcher({ runtime, runResults });
    await initializeDispatcher(firstConnection);
    await initializeDispatcher(secondConnection);

    const started = await firstConnection.handle(createRuntimeDaemonRequest('req-1', 'run.start', {
      sessionId: 'session-1',
      prompt: 'hello',
    }));
    expect(isRuntimeDaemonSuccessResponse(started)).toBe(true);
    await Promise.resolve();

    const awaited = await secondConnection.handle(createRuntimeDaemonRequest('req-2', 'run.await', {
      runId: 'run-1',
    }));

    expect(isRuntimeDaemonSuccessResponse(awaited)).toBe(true);
    if (isRuntimeDaemonSuccessResponse(awaited)) {
      expect(awaited.result).toMatchObject({
        runId: 'run-1',
        sessionId: 'session-1',
        phase: 'completed',
        result: {
          success: true,
          lastText: 'done',
        },
      });
    }
  });

  it('serializes retained run errors into a stable JSON wire shape', async () => {
    const runResults = createRuntimeDaemonRunResultStore();
    runResults.remember('run-failed', Promise.resolve({
      runId: 'run-failed',
      sessionId: 'session-1',
      phase: 'failed',
      error: new TypeError('provider unavailable'),
    }));
    const dispatcher = createRuntimeDaemonDispatcher({
      runtime: makeRuntime(),
      runResults,
    });
    await initializeDispatcher(dispatcher);

    const awaited = await dispatcher.handle(createRuntimeDaemonRequest(
      'req-failed',
      'run.await',
      { runId: 'run-failed' },
    ));

    expect(isRuntimeDaemonSuccessResponse(awaited)).toBe(true);
    if (isRuntimeDaemonSuccessResponse(awaited)) {
      const wireResponse = JSON.parse(JSON.stringify(awaited)) as unknown;
      expect(wireResponse).toMatchObject({
        result: {
          phase: 'failed',
          error: {
            name: 'TypeError',
            message: 'provider unavailable',
          },
        },
      });
    }
  });

  it('forwards runtime event subscriptions as daemon notifications', async () => {
    const runtime = makeRuntime();
    const notifications: RuntimeDaemonNotification[] = [];
    const dispatcher = createRuntimeDaemonDispatcher({
      runtime,
      notify: (notification) => notifications.push(notification),
    });
    await initializeDispatcher(dispatcher);

    const subscribed = await dispatcher.handle(createRuntimeDaemonRequest('req-1', 'event.subscribe', {
      filter: { sessionId: 'session-1' },
    }));
    expect(isRuntimeDaemonSuccessResponse(subscribed)).toBe(true);

    const event: RuntimeEvent = {
      id: 'evt-1',
      seq: 1,
      time: '2026-07-09T00:00:00.000Z',
      sessionId: 'session-1',
      runId: 'run-1',
      type: 'run.completed',
      payload: { ok: true },
    };
    runtime.emit(event);

    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.method).toBe('event');
    expect(notifications[0]?.params).toMatchObject({ event });
  });

  it('assigns a subscription id before synchronous runtime notifications', async () => {
    const runtime = makeRuntime();
    const event: RuntimeEvent = {
      id: 'evt-sync',
      seq: 1,
      time: '2026-07-09T00:00:00.000Z',
      sessionId: 'session-1',
      runId: 'run-1',
      type: 'run.started',
      payload: {},
    };
    runtime.events.subscribe = (_filter, listener) => {
      listener(event);
      return { close() {} };
    };
    const notifications: RuntimeDaemonNotification[] = [];
    const dispatcher = createRuntimeDaemonDispatcher({
      runtime,
      notify: (notification) => notifications.push(notification),
    });
    await initializeDispatcher(dispatcher);

    const subscribed = await dispatcher.handle(createRuntimeDaemonRequest(
      'req-sub-sync',
      'event.subscribe',
      { filter: {} },
    ));

    expect(isRuntimeDaemonSuccessResponse(subscribed)).toBe(true);
    if (isRuntimeDaemonSuccessResponse(subscribed)) {
      expect(notifications).toHaveLength(1);
      expect(notifications[0]?.params).toMatchObject({
        subscriptionId: (subscribed.result as { subscriptionId: string }).subscriptionId,
        event,
      });
    }
  });

  it('returns latest context diagnostic payloads from runtime event replay', async () => {
    const runtime = makeRuntime();
    const dispatcher = createRuntimeDaemonDispatcher({ runtime });
    await initializeDispatcher(dispatcher);

    runtime.emit({
      id: 'evt-budget-1',
      seq: 1,
      time: '2026-07-09T00:00:00.000Z',
      sessionId: 'session-1',
      runId: 'run-1',
      type: 'context.budget.snapshot',
      payload: { usedTokens: 100 },
    });
    runtime.emit({
      id: 'evt-budget-2',
      seq: 2,
      time: '2026-07-09T00:00:01.000Z',
      sessionId: 'session-1',
      runId: 'run-1',
      type: 'context.budget.snapshot',
      payload: { usedTokens: 80 },
    });
    runtime.emit({
      id: 'evt-exposure-1',
      seq: 3,
      time: '2026-07-09T00:00:02.000Z',
      sessionId: 'session-1',
      runId: 'run-1',
      type: 'tool.exposure.planned',
      payload: { profile: 'bridge_non_core', bridgedCount: 4 },
    });

    const budget = await dispatcher.handle(createRuntimeDaemonRequest('req-1', 'context.budget.get', {
      sessionId: 'session-1',
      runId: 'run-1',
    }));
    const exposure = await dispatcher.handle(createRuntimeDaemonRequest('req-2', 'tool.exposure.preview', {
      sessionId: 'session-1',
    }));

    expect(isRuntimeDaemonSuccessResponse(budget)).toBe(true);
    expect(isRuntimeDaemonSuccessResponse(exposure)).toBe(true);
    if (isRuntimeDaemonSuccessResponse(budget)) {
      expect(budget.result).toEqual({ usedTokens: 80 });
    }
    if (isRuntimeDaemonSuccessResponse(exposure)) {
      expect(exposure.result).toEqual({ profile: 'bridge_non_core', bridgedCount: 4 });
    }
  });

  it('gates context diagnostics by negotiated client capability', async () => {
    const runtime = makeRuntime();
    runtime.emit({
      id: 'evt-normal',
      seq: 1,
      time: '2026-07-09T00:00:00.000Z',
      sessionId: 'session-1',
      runId: 'run-1',
      type: 'run.completed',
      payload: { ok: true },
    });
    runtime.emit({
      id: 'evt-budget',
      seq: 2,
      time: '2026-07-09T00:00:01.000Z',
      sessionId: 'session-1',
      runId: 'run-1',
      type: 'context.budget.snapshot',
      payload: { usedTokens: 42 },
    });
    runtime.emit({
      id: 'evt-compaction-skipped',
      seq: 3,
      time: '2026-07-09T00:00:02.000Z',
      sessionId: 'session-1',
      runId: 'run-1',
      type: 'context.compaction.skipped',
      payload: { reason: 'cooldown' },
    });

    const basic = createRuntimeDaemonDispatcher({ runtime });
    await initializeDispatcher(basic, {});
    const basicReplay = await basic.handle(createRuntimeDaemonRequest('req-basic-replay', 'event.replay'));
    const basicBudget = await basic.handle(createRuntimeDaemonRequest('req-basic-budget', 'context.budget.get', {
      sessionId: 'session-1',
      runId: 'run-1',
    }));

    expect(isRuntimeDaemonSuccessResponse(basicReplay)).toBe(true);
    if (isRuntimeDaemonSuccessResponse(basicReplay)) {
      expect(basicReplay.result).toEqual([
        expect.objectContaining({ type: 'run.completed' }),
      ]);
    }
    expect(isRuntimeDaemonSuccessResponse(basicBudget)).toBe(false);
    if (!isRuntimeDaemonSuccessResponse(basicBudget)) {
      expect(basicBudget.error.code).toBe('unauthorized');
    }

    const diagnostic = createRuntimeDaemonDispatcher({ runtime });
    await initializeDispatcher(diagnostic, { contextDiagnostics: true });
    const diagnosticReplay = await diagnostic.handle(createRuntimeDaemonRequest(
      'req-diagnostic-replay',
      'event.replay',
    ));
    const diagnosticBudget = await diagnostic.handle(createRuntimeDaemonRequest(
      'req-diagnostic-budget',
      'context.budget.get',
      { sessionId: 'session-1', runId: 'run-1' },
    ));

    expect(isRuntimeDaemonSuccessResponse(diagnosticReplay)).toBe(true);
    if (isRuntimeDaemonSuccessResponse(diagnosticReplay)) {
      expect(diagnosticReplay.result).toEqual([
        expect.objectContaining({ type: 'run.completed' }),
        expect.objectContaining({ type: 'context.budget.snapshot' }),
        expect.objectContaining({ type: 'context.compaction.skipped' }),
      ]);
    }
    expect(isRuntimeDaemonSuccessResponse(diagnosticBudget)).toBe(true);
    if (isRuntimeDaemonSuccessResponse(diagnosticBudget)) {
      expect(diagnosticBudget.result).toEqual({ usedTokens: 42 });
    }
  });

  it('serves redacted config and provider/model catalogs through admin methods', async () => {
    const dispatcher = createRuntimeDaemonDispatcher({
      runtime: makeRuntime(),
      config: () => ({
        provider: 'openai',
        apiKey: 'secret-api-key',
        nested: {
          token: 'secret-token',
          safe: 'visible',
        },
      }),
      providerList: () => [
        {
          name: 'openai',
          model: 'gpt-test',
          models: ['gpt-test', 'gpt-other'],
          configured: true,
          reasoningCapability: 'native',
          capabilityProfile: { transport: 'http' },
        },
      ],
    });
    await initializeDispatcher(dispatcher);

    const config = await dispatcher.handle(createRuntimeDaemonRequest('req-1', 'config.read'));
    const providers = await dispatcher.handle(createRuntimeDaemonRequest('req-2', 'provider.list'));
    const models = await dispatcher.handle(createRuntimeDaemonRequest('req-3', 'model.list', {
      provider: 'openai',
    }));
    const customProviders = await dispatcher.handle(createRuntimeDaemonRequest('req-4', 'provider.custom.list'));

    expect(isRuntimeDaemonSuccessResponse(config)).toBe(true);
    expect(isRuntimeDaemonSuccessResponse(providers)).toBe(true);
    expect(isRuntimeDaemonSuccessResponse(models)).toBe(true);
    expect(isRuntimeDaemonSuccessResponse(customProviders)).toBe(true);
    if (isRuntimeDaemonSuccessResponse(config)) {
      expect(config.result).toEqual({
        provider: 'openai',
        apiKey: '[redacted]',
        nested: {
          token: '[redacted]',
          safe: 'visible',
        },
      });
    }
    if (isRuntimeDaemonSuccessResponse(providers)) {
      expect(providers.result).toMatchObject([{ name: 'openai', models: ['gpt-test', 'gpt-other'] }]);
    }
    if (isRuntimeDaemonSuccessResponse(models)) {
      expect(models.result).toEqual({ provider: 'openai', models: ['gpt-test', 'gpt-other'] });
    }
    if (isRuntimeDaemonSuccessResponse(customProviders)) {
      expect(customProviders.result).toEqual([{
        name: 'custom-openai',
        protocol: 'openai',
        baseUrl: 'https://example.invalid/v1',
        apiKeyEnv: 'CUSTOM_OPENAI_KEY',
        model: 'custom-model',
      }]);
    }
  });

  it('routes config, MCP, command, skill, and artifact methods through runtime services', async () => {
    const dispatcher = createRuntimeDaemonDispatcher({ runtime: makeRuntime() });
    await initializeDispatcher(dispatcher);

    const patched = await dispatcher.handle(createRuntimeDaemonRequest('req-config', 'config.patch', {
      patch: { model: 'mock-model' },
    }));
    const customUpsert = await dispatcher.handle(createRuntimeDaemonRequest('req-custom-upsert', 'provider.custom.upsert', {
      config: {
        name: 'custom-openai',
        protocol: 'openai',
        baseUrl: 'https://example.invalid/v1',
        apiKeyEnv: 'CUSTOM_OPENAI_KEY',
        model: 'custom-model',
      },
    }));
    const customRemove = await dispatcher.handle(createRuntimeDaemonRequest('req-custom-remove', 'provider.custom.remove', {
      name: 'custom-openai',
    }));
    const mcpUpsert = await dispatcher.handle(createRuntimeDaemonRequest('req-mcp-upsert', 'mcp.server.upsert', {
      name: 'local',
      config: { type: 'stdio', command: 'echo' },
    }));
    const mcpValidate = await dispatcher.handle(createRuntimeDaemonRequest('req-mcp-validate', 'mcp.server.validate', {
      name: 'local',
      config: { type: 'stdio', command: 'echo' },
    }));
    const extensions = await dispatcher.handle(createRuntimeDaemonRequest('req-extension-list', 'extension.list'));
    const command = await dispatcher.handle(createRuntimeDaemonRequest('req-command', 'command.resolve', {
      name: 'help',
    }));
    const skill = await dispatcher.handle(createRuntimeDaemonRequest('req-skill', 'skill.describe', {
      name: 'review',
    }));
    const artifact = await dispatcher.handle(createRuntimeDaemonRequest('req-artifact', 'artifact.create', {
      kind: 'file',
      path: '/tmp/input.txt',
    }));

    expect(isRuntimeDaemonSuccessResponse(patched)).toBe(true);
    expect(isRuntimeDaemonSuccessResponse(customUpsert)).toBe(true);
    expect(isRuntimeDaemonSuccessResponse(customRemove)).toBe(true);
    expect(isRuntimeDaemonSuccessResponse(mcpUpsert)).toBe(true);
    expect(isRuntimeDaemonSuccessResponse(mcpValidate)).toBe(true);
    expect(isRuntimeDaemonSuccessResponse(extensions)).toBe(true);
    expect(isRuntimeDaemonSuccessResponse(command)).toBe(true);
    expect(isRuntimeDaemonSuccessResponse(skill)).toBe(true);
    expect(isRuntimeDaemonSuccessResponse(artifact)).toBe(true);
    if (isRuntimeDaemonSuccessResponse(patched)) {
      expect(patched.result).toMatchObject({ provider: 'mock', model: 'mock-model' });
    }
    if (isRuntimeDaemonSuccessResponse(customUpsert)) {
      expect(customUpsert.result).toMatchObject({ name: 'custom-openai', model: 'custom-model' });
    }
    if (isRuntimeDaemonSuccessResponse(customRemove)) {
      expect(customRemove.result).toBe(true);
    }
    if (isRuntimeDaemonSuccessResponse(mcpUpsert)) {
      expect(mcpUpsert.result).toEqual({ type: 'stdio', command: 'echo' });
    }
    if (isRuntimeDaemonSuccessResponse(mcpValidate)) {
      expect(mcpValidate.result).toEqual({ ok: true, config: { type: 'stdio', command: 'echo' } });
    }
    if (isRuntimeDaemonSuccessResponse(extensions)) {
      expect(extensions.result).toMatchObject({
        active: true,
        extensions: [{ label: 'demo' }],
      });
    }
    if (isRuntimeDaemonSuccessResponse(command)) {
      expect(command.result).toMatchObject({ name: 'help', description: 'Show help' });
    }
    if (isRuntimeDaemonSuccessResponse(skill)) {
      expect(skill.result).toMatchObject({ name: 'review', content: 'Review instructions' });
    }
    if (isRuntimeDaemonSuccessResponse(artifact)) {
      expect(artifact.result).toMatchObject({ id: 'art-1', kind: 'file', path: '/tmp/input.txt' });
    }
  });

  it('passes permission response run bindings to the hosted runtime', async () => {
    const baseRuntime = makeRuntime();
    let captured: {
      readonly requestId: string;
      readonly decision: RuntimePermissionDecision;
      readonly options?: RuntimePermissionRespondOptions;
    } | undefined;
    const runtime: KodaXRuntime & { emit(event: RuntimeEvent): void } = {
      ...baseRuntime,
      permissions: {
        ...baseRuntime.permissions,
        async respond(requestId, decision, options) {
          captured = {
            requestId,
            decision,
            ...(options !== undefined ? { options } : {}),
          };
          return false;
        },
      },
    };
    const dispatcher = createRuntimeDaemonDispatcher({ runtime });
    await initializeDispatcher(dispatcher);

    const response = await dispatcher.handle(createRuntimeDaemonRequest('req-permission', 'permission.respond', {
      requestId: 'perm-1',
      decision: { type: 'allow_once' },
      runId: 'run-1',
    }));

    expect(isRuntimeDaemonSuccessResponse(response)).toBe(true);
    if (isRuntimeDaemonSuccessResponse(response)) {
      expect(response.result).toBe(false);
    }
    expect(captured).toEqual({
      requestId: 'perm-1',
      decision: { type: 'allow_once' },
      options: { runId: 'run-1' },
    });
  });
});

async function initializeDispatcher(
  dispatcher: ReturnType<typeof createRuntimeDaemonDispatcher>,
  capabilities: RuntimeClientCapabilities = {
    contextDiagnostics: true,
    permissionPrompts: true,
    configAdmin: true,
  },
): Promise<Record<string, unknown>> {
  const initialized = await dispatcher.handle(createRuntimeDaemonRequest('req-init', 'initialize', {
    profile: 'default',
    clientInfo: { name: 'vitest' },
    capabilities,
  }));
  expect(isRuntimeDaemonSuccessResponse(initialized)).toBe(true);
  if (!isRuntimeDaemonSuccessResponse(initialized)) {
    throw new Error(`Runtime daemon initialize failed: ${initialized.error.message}`);
  }
  if (!initialized.result || typeof initialized.result !== 'object' || Array.isArray(initialized.result)) {
    throw new Error('Runtime daemon initialize returned an invalid result');
  }
  return initialized.result as Record<string, unknown>;
}

function isInitializeMethod(method: RuntimeDaemonMethod): boolean {
  return method === 'initialize' || method === 'runtime.initialize';
}

let loopbackRequestSequence = 0;
function randomRequestSuffix(): string {
  loopbackRequestSequence += 1;
  return String(loopbackRequestSequence);
}

const METHOD_SMOKE_PARAMS = {
  initialize: { profile: 'default', capabilities: { contextDiagnostics: true } },
  'runtime.initialize': { profile: 'default', capabilities: { contextDiagnostics: true } },
  ping: undefined,
  'runtime.identity': undefined,
  'runtime.status': undefined,
  'runtime.shutdown': undefined,
  'runtime.capabilities': undefined,
  'daemon.status': undefined,
  'daemon.stop': undefined,
  'daemon.logs': undefined,
  'daemon.preflight': undefined,
  'daemon.management.get': undefined,
  'daemon.rollbackToInline': {
    expectedRuntimeId: 'runtime-smoke',
    expectedRevision: 0,
    expectedOwnerPolicyRevision: 0,
  },
  'operation.get': { operationId: 'op-missing', journalEpoch: 'epoch-missing' },
  'session.create': { sessionId: 'session-smoke', title: 'Smoke Session' },
  'session.load': { sessionId: 'session-1' },
  'session.list': { limit: 5 },
  'session.transcript': { sessionId: 'session-1' },
  'session.observe': { sessionId: 'session-1' },
  'session.fork': { sessionId: 'session-1' },
  'session.notice.append': { sessionId: 'session-1', content: 'smoke' },
  'session.rewind': { sessionId: 'session-1', selector: 'entry-1' },
  'session.active_entry.set': { sessionId: 'session-1', entryId: 'entry-1' },
  'session.activeEntry.set': { sessionId: 'session-1', entryId: 'entry-1' },
  'session.compact': { sessionId: 'session-1' },
  'session.archive': { sessionId: 'session-1' },
  'session.unarchive': { sessionId: 'session-1' },
  'session.delete': { sessionId: 'session-1' },
  'session.settings.get': { sessionId: 'session-1' },
  'session.settings.getVersioned': { sessionId: 'session-1' },
  'session.settings.update': { sessionId: 'session-1', patch: { model: 'mock-model' } },
  'session.settings.updateVersioned': {
    sessionId: 'session-1',
    patch: { model: 'mock-model' },
    expectedRevision: 0,
  },
  'run.start': { sessionId: 'session-1', prompt: 'hello daemon' },
  'run.input.submit': {
    sessionId: 'session-1',
    afterRunId: 'run-1',
    delivery: 'after_turn',
    input: { type: 'text', text: 'continue' },
  },
  'run.get': { runId: 'run-1' },
  'run.list': { sessionId: 'session-1' },
  'run.await': { runId: 'run-1' },
  'run.abort': { runId: 'run-1' },
  'run.model.set': { runId: 'run-1', model: 'mock-model' },
  'run.provider.set': { runId: 'run-1', provider: 'mock' },
  'run.reasoning.set': { runId: 'run-1', reasoning: 'off' },
  'run.setModel': { runId: 'run-1', model: 'mock-model' },
  'run.setProvider': { runId: 'run-1', provider: 'mock' },
  'run.setReasoning': { runId: 'run-1', reasoning: 'off' },
  'event.subscribe': { filter: { sessionId: 'session-1' } },
  'event.unsubscribe': { subscriptionId: 'sub-missing' },
  'event.replay': { sessionId: 'session-1', limit: 5 },
  'permission.list': { runId: 'run-1' },
  'permission.listPending': { runId: 'run-1' },
  'permission.request': { sessionId: 'session-1', runId: 'run-1', toolName: 'read' },
  'permission.respond': { requestId: 'perm-1', runId: 'run-1', decision: { type: 'allow_once' } },
  'permission.grants.list': {},
  'permission.grants.revoke': { grantId: 'grant-1', expectedRevision: 0 },
  'user_input.listPending': { sessionId: 'session-1' },
  'user_input.respond': { requestId: 'input-1', answer: 'yes', expectedRevision: 0 },
  'user_input.dismiss': { requestId: 'input-1', expectedRevision: 0 },
  'credential.register': { leaseId: 'credential-1', providers: ['mock'] },
  'credential.get': { leaseId: 'credential-1' },
  'credential.revoke': { leaseId: 'credential-1' },
  'credential.supply': { requestId: 'credential-request-1', error: 'unavailable' },
  'host_tool.register': {
    leaseId: 'host-tools-1',
    tools: [{
      name: 'space_artifact_create',
      description: 'Create a Space artifact',
      inputSchema: { type: 'object' },
      sideEffect: 'non_idempotent',
    }],
  },
  'host_tool.get': { leaseId: 'host-tools-1' },
  'host_tool.invocation.get': { invocationId: 'host-invocation-1' },
  'host_tool.revoke': { leaseId: 'host-tools-1' },
  'host_tool.complete': { invocationId: 'host-invocation-1', error: 'unknown' },
  'workflow.list': { runId: 'run-1' },
  'workflow.get': { runId: 'run-1' },
  'workflow.subscribe': { filter: { runId: 'run-1' } },
  'workflow.unsubscribe': { subscriptionId: 'workflow-sub-missing' },
  'workflow.pause': { runId: 'run-1' },
  'workflow.resume': { runId: 'run-1' },
  'workflow.stop': { runId: 'run-1' },
  'learning.list': {},
  'learning.get': { nameOrSlug: 'runtime-test-skill' },
  'learning.snapshot': undefined,
  'learning.events': { afterRevision: 0 },
  'learning.acknowledge': { nameOrSlug: 'runtime-test-skill' },
  'learning.snooze': { nameOrSlug: 'runtime-test-skill', until: '2026-07-18T00:00:00.000Z' },
  'learning.reject': { nameOrSlug: 'runtime-test-skill' },
  'learning.disable': { nameOrSlug: 'runtime-test-skill' },
  'learning.rollback': { nameOrSlug: 'runtime-test-skill' },
  'learning.promote': { nameOrSlug: 'runtime-test-skill', scope: 'user' },
  'learning.review': { nameOrSlug: 'runtime-test-skill' },
  'learning.trust': { nameOrSlug: 'runtime-test-skill' },
  'config.read': undefined,
  'config.patch': { patch: { model: 'mock-model' } },
  'config.reload': undefined,
  'model.list': { provider: 'mock' },
  'provider.list': undefined,
  'provider.custom.list': undefined,
  'provider.custom.upsert': {
    config: {
      name: 'custom-openai',
      protocol: 'openai',
      baseUrl: 'https://example.invalid/v1',
      apiKeyEnv: 'CUSTOM_OPENAI_KEY',
      model: 'custom-model',
    },
  },
  'provider.custom.remove': { name: 'custom-openai' },
  'mcp.server.list': undefined,
  'mcp.server.get': { name: 'local' },
  'mcp.server.validate': { name: 'local', config: { type: 'stdio', command: 'echo' } },
  'mcp.server.upsert': { name: 'local', config: { type: 'stdio', command: 'echo' } },
  'mcp.server.delete': { name: 'local' },
  'mcp.server.remove': { name: 'local' },
  'mcp.server.reload': undefined,
  'mcp.tool.list': { server: 'local' },
  'extension.list': undefined,
  'extension.reload': undefined,
  'command.list': { projectRoot: process.cwd() },
  'command.resolve': { name: 'help', projectRoot: process.cwd() },
  'skill.list': { projectRoot: process.cwd(), userInvocableOnly: true },
  'skill.describe': { name: 'review', projectRoot: process.cwd() },
  'skill.read': { name: 'review', projectRoot: process.cwd() },
  'artifact.create': { kind: 'file', path: '/tmp/runtime-daemon-smoke.txt' },
  'artifact.get': { artifactId: 'art-1' },
  'artifact.delete': { artifactId: 'art-1' },
  'agentRegistrations.list': undefined,
  'agentRegistrations.upsert': {
    registration: {
      agentId: 'external:smoke',
      displayName: 'Smoke Agent',
      enabled: true,
      executorId: 'smoke-executor',
      protocol: 'http',
      configurationRevision: 'rev-1',
      endpointIdentityHash: 'sha256:smoke',
      capabilities: {
        streaming: 'supported',
        durableTasks: 'supported',
        inputRequired: 'supported',
        cancellation: 'supported',
        artifacts: 'supported',
      },
      effects: { remote: 'read', workspace: 'proposal' },
    },
  },
  'agentRegistrations.setEnabled': { agentId: 'external:smoke', enabled: false },
  'agentRegistrations.remove': { agentId: 'external:smoke' },
  'agents.listDispatchable': { actorId: 'actor-smoke' },
  'agents.describe': { agentId: 'external:smoke', query: { actorId: 'actor-smoke' } },
  'agents.preflight': {
    agentId: 'external:smoke',
    query: { actorId: 'actor-smoke' },
  },
  'agents.tree': { sessionId: 'session-1' },
  'agents.detail': { sessionId: 'session-1', actorPath: '/root' },
  'agents.spawn': {
    sessionId: 'session-1',
    input: { taskName: 'smoke', objective: 'Smoke test' },
  },
  'agents.send': {
    sessionId: 'session-1', actorPath: '/root/smoke', content: 'continue',
  },
  'agents.followup': {
    sessionId: 'session-1', actorPath: '/root/smoke', objective: 'Continue',
  },
  'agents.interrupt': { sessionId: 'session-1', actorPath: '/root/smoke' },
  'agents.output': { sessionId: 'session-1', actorPath: '/root/smoke' },
  'agents.events': { sessionId: 'session-1', afterSequence: 0 },
  'agents.wait': { sessionId: 'session-1', afterSequence: 0, timeoutMs: 1 },
  'context.budget.get': { sessionId: 'session-1', runId: 'run-1' },
  'tool.exposure.preview': { sessionId: 'session-1', runId: 'run-1' },
} satisfies Record<RuntimeDaemonMethod, unknown>;

function makeRuntime(): KodaXRuntime & { emit(event: RuntimeEvent): void } {
  const listeners: Array<{
    readonly filter: RuntimeEventFilter;
    readonly listener: RuntimeEventListener;
  }> = [];
  const runs = new Map<string, RuntimeRunResult>();
  const eventLog: RuntimeEvent[] = [];
  const externalCapabilities = {
    streaming: 'supported',
    durableTasks: 'supported',
    inputRequired: 'supported',
    cancellation: 'supported',
    artifacts: 'supported',
  } as const;
  const externalRegistration = {
    agentId: 'external:smoke',
    displayName: 'Smoke Agent',
    enabled: true,
    executorId: 'smoke-executor',
    protocol: 'http',
    configurationRevision: 'rev-1',
    endpointIdentityHash: 'sha256:smoke',
    credentialConfigured: false,
    capabilities: externalCapabilities,
    effects: { remote: 'read', workspace: 'proposal' },
    diagnostics: [],
  } as const;
  const externalListing = {
    descriptor: {
      agentId: externalRegistration.agentId,
      displayName: externalRegistration.displayName,
      origin: 'external',
      protocol: 'http',
      configurationRevision: externalRegistration.configurationRevision,
      skills: [],
      inputModalities: ['text'],
      outputModalities: ['text'],
      capabilities: externalCapabilities,
      effects: externalRegistration.effects,
    },
    dispatchability: {
      status: 'dispatchable',
      checkedAt: '2026-07-09T00:00:00.000Z',
      reasons: [],
    },
  } as const;
  const runtime: KodaXRuntime & { emit(event: RuntimeEvent): void } = {
    identity: {
      runtimeId: 'runtime-test',
      mode: 'embedded',
      profile: 'default',
      startedAt: '2026-07-09T00:00:00.000Z',
      version: '0.7.66',
    },
    sessions: {
      async create(input) {
        return {
          id: input?.sessionId ?? 'session-1',
          title: input?.title ?? 'Test Session',
        };
      },
      async load(sessionId) {
        return { id: sessionId, title: 'Loaded Session' };
      },
      async list() {
        return [{ id: 'session-1', title: 'Test Session', msgCount: 0 }];
      },
      async transcript() {
        return null;
      },
      async observe(sessionId) {
        return createTestObservation(sessionId);
      },
      async fork() {
        return { id: 'fork-1', title: 'Forked Session' };
      },
      async getSettings() {
        return {};
      },
      async getSettingsVersioned() {
        return { revision: 0, value: {} };
      },
      async updateSettings(_sessionId, patch) {
        return Object.fromEntries(
          Object.entries(patch).filter((entry): entry is [string, string | boolean] => (
            entry[1] !== null && entry[1] !== undefined
          )),
        );
      },
      async updateSettingsVersioned(_sessionId, patch, options) {
        return {
          revision: options.expectedRevision + 1,
          value: Object.fromEntries(
            Object.entries(patch).filter((entry): entry is [string, string | boolean] => (
              entry[1] !== null && entry[1] !== undefined
            )),
          ),
        };
      },
      async appendNotice() {
        return null;
      },
      async rewind(input) {
        return { id: input.sessionId, title: 'Rewound Session' };
      },
      async setActiveEntry(input) {
        return { id: input.sessionId, title: 'Active Entry Session' };
      },
      async compact(input) {
        return {
          compacted: false,
          tokensBefore: 0,
          tokensAfter: 0,
          session: { id: input.sessionId, title: 'Compacted Session' },
        } as RuntimeCompactSessionResult;
      },
      async archive() {},
      async unarchive() {},
      async delete() {},
    },
    runs: {
      async start(input: RuntimeStartRunInput) {
        const result: RuntimeRunResult = {
          runId: 'run-1',
          sessionId: input.sessionId,
          phase: 'completed',
          result: {
            success: true,
            lastText: 'done',
            messages: [],
            sessionId: input.sessionId,
          },
        };
        runs.set(result.runId, result);
        return {
          runId: result.runId,
          sessionId: result.sessionId,
          result: Promise.resolve(result),
        };
      },
      async submitInput(input) {
        return {
          accepted: false,
          delivery: input.delivery,
          sessionId: input.sessionId,
          afterRunId: input.afterRunId,
          reason: 'stale_run',
        };
      },
      async await(runId) {
        const result = runs.get(runId);
        if (result) return result;
        return { runId, sessionId: 'session-1', phase: 'completed' };
      },
      async get(runId) {
        const result = runs.get(runId);
        return {
          runId,
          sessionId: result?.sessionId ?? 'session-1',
          phase: result?.phase ?? 'completed',
          startedAt: '2026-07-09T00:00:00.000Z',
          provider: 'mock',
        };
      },
      async list() {
        return [];
      },
      async abort() {},
      async setModel() {},
      async setProvider() {},
      async setReasoning() {},
    },
    events: {
      subscribe(filter, listener) {
        listeners.push({ filter, listener });
        return {
          close() {
            const index = listeners.findIndex((entry) => entry.listener === listener);
            if (index >= 0) listeners.splice(index, 1);
          },
        };
      },
      async replay(filter) {
        const matched = eventLog.filter((event) => eventMatchesReplayFilter(event, filter));
        return filter?.limit !== undefined ? matched.slice(-filter.limit) : matched;
      },
    },
    permissions: {
      async request() {
        return { type: 'allow_once' };
      },
      async listPending() {
        return [];
      },
      async respond() {
        return true;
      },
      async listGrants() { return { revision: 0, value: [] }; },
      async revokeGrant() { return false; },
    },
    userInputs: createTestUserInputs(),
    credentials: createTestCredentialService(),
    hostTools: createTestHostToolService(),
    operations: {
      async get(input) {
        return {
          ...input,
          principalId: 'vitest',
          method: 'run.start',
          requestDigest: 'digest',
          state: 'applied',
          updatedAt: '2026-07-14T00:00:00.000Z',
        };
      },
    },
    workflows: {
      async list() {
        return [];
      },
      async get() {
        return undefined;
      },
      subscribe() {
        return { close() {} };
      },
      async pause() {
        return false;
      },
      async resume() {
        return false;
      },
      async stop() {
        return false;
      },
    },
    learning: {
      async list() {
        return { items: [], revision: 0 };
      },
      async get(nameOrSlug) {
        return {
          schemaVersion: 1,
          capabilityId: 'lc_runtime_test',
          displayName: 'Runtime test Skill',
          slug: nameOrSlug,
          carrier: 'skill',
          lifecycle: 'ready',
          revision: 1,
          createdAt: '2026-07-17T00:00:00.000Z',
          updatedAt: '2026-07-17T00:00:00.000Z',
          source: { kind: 'learning_controller' },
        };
      },
      async getSnapshot() {
        return { ready: 0, newlyActive: 0, attention: 0, active: 0, revision: 0 };
      },
      async events() { return []; },
      async *subscribe() {},
      async acknowledge() {},
      async snooze() {},
      async reject() {},
      async disable() {},
      async rollback() {},
      async promote() {},
      async review() {},
      async trust() {},
    },
    config: {
      async read() {
        return { provider: 'mock' };
      },
      async patch(patch) {
        return { provider: 'mock', ...patch };
      },
      async reload() {
        return { ok: true, config: { provider: 'mock' } };
      },
    },
    catalog: {
      async providers() {
        return [{ name: 'mock', models: ['mock-model'] }];
      },
      async models(filter) {
        return filter?.provider
          ? { provider: filter.provider, models: ['mock-model'] }
          : [{ provider: 'mock', models: ['mock-model'] }];
      },
      async commands() {
        return [{
          name: 'help',
          aliases: ['h'],
          description: 'Show help',
          source: 'builtin',
        }];
      },
      async resolveCommand(input) {
        return input.name === 'help'
          ? {
              name: 'help',
              aliases: ['h'],
              description: 'Show help',
              source: 'builtin',
            }
          : null;
      },
      async skills() {
        return [{
          name: 'review',
          description: 'Review code',
          userInvocable: true,
          path: '/skills/review',
          source: 'project',
          disableModelInvocation: false,
        }];
      },
      async describeSkill(input) {
        return input.name === 'review'
          ? {
              name: 'review',
              description: 'Review code',
              userInvocable: true,
              path: '/skills/review',
              source: 'project',
              disableModelInvocation: false,
              content: 'Review instructions',
              skillFilePath: '/skills/review/SKILL.md',
          }
          : null;
      },
      async customProviders() {
        return [{
          name: 'custom-openai',
          protocol: 'openai',
          baseUrl: 'https://example.invalid/v1',
          apiKeyEnv: 'CUSTOM_OPENAI_KEY',
          model: 'custom-model',
        }];
      },
      async upsertCustomProvider(config) {
        return config;
      },
      async deleteCustomProvider() {
        return true;
      },
      async extensions() {
        return {
          active: true,
          extensions: [{
            path: '/extensions/demo/index.js',
            label: 'demo',
            loadSource: 'api',
          }],
          diagnostics: {
            loadedExtensions: [{
              path: '/extensions/demo/index.js',
              label: 'demo',
              loadSource: 'api',
            }],
            capabilityProviders: [],
            commands: [],
            tools: [],
            hooks: [],
            failures: [],
            defaults: {
              modelSelection: {},
            },
          },
        };
      },
      async reloadExtensions() {
        return { ok: true, active: false };
      },
    },
    mcp: {
      async listServers() {
        return {};
      },
      async getServer() {
        return undefined;
      },
      async validateServer(_name, config) {
        return {
          ok: true,
          config: config as Parameters<KodaXRuntime['mcp']['upsertServer']>[1],
        };
      },
      async upsertServer(_name, config) {
        return config;
      },
      async deleteServer() {
        return true;
      },
      async reloadServers() {
        return { ok: true, servers: [] };
      },
      async listTools() {
        return [];
      },
    },
    artifacts: {
      async create(input) {
        return {
          id: 'art-1',
          kind: input.kind,
          path: input.path,
          sizeBytes: 0,
          createdAt: '2026-07-09T00:00:00.000Z',
        };
      },
      async get(artifactId) {
        return artifactId === 'art-1'
          ? {
              id: 'art-1',
              kind: 'file',
              path: '/tmp/file.txt',
              sizeBytes: 0,
              createdAt: '2026-07-09T00:00:00.000Z',
            }
          : undefined;
      },
      async delete() {
        return true;
      },
    },
    admin: {
      agentRegistrations: {
        async list() { return [externalRegistration]; },
        async upsert() { return externalRegistration; },
        async setEnabled() { return { ...externalRegistration, enabled: false as const }; },
        async remove() { return true; },
      },
    },
    agents: {
      enabled: true,
      async listDispatchable() { return [externalListing]; },
      async describe() { return externalListing; },
      async preflight() {
        return {
          ok: true,
          descriptor: externalListing.descriptor,
          dispatchability: externalListing.dispatchability,
          reasons: [],
        };
      },
      async tree() {
        return {
          rootPath: '/root' as const,
          actors: [],
          activeNonRootTurns: 0,
          maxConcurrentThreads: 4,
          revision: 0,
        };
      },
      async detail() {
        return {
          actor: {
            path: '/root',
            taskName: 'root',
            kind: 'native' as const,
            state: 'idle' as const,
            capabilities: {
              tools: [], filesystem: 'write' as const, network: true, providers: [], canAskUser: true,
            },
            turnIds: [],
            mailboxCursor: 0,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            revision: 0,
          },
          turns: [],
          mailbox: [],
        };
      },
      async spawn() {
        return { actorPath: '/root/smoke', turnId: 'turn-smoke', state: 'accepted' as const };
      },
      async send() {},
      async followup() {
        return {
          delivery: 'started_turn' as const,
          turn: { actorPath: '/root/smoke', turnId: 'turn-smoke', state: 'accepted' as const },
        };
      },
      async interrupt() {},
      async output() {
        return {
          actorPath: '/root/smoke',
          turnId: 'turn-smoke',
          state: 'completed' as const,
          output: 'done',
          artifacts: [],
          progress: [],
        };
      },
      async events() { return []; },
      async wait() { return undefined; },
    },
    status: {
      async snapshot() {
        return {
          ...runtime.identity,
          sessions: [],
          runs: [],
          pendingPermissions: [],
          workflows: [],
        };
      },
      async preflight() {
        return {
          runtimeId: runtime.identity.runtimeId,
          clientCount: 0,
          activeRuns: [],
          queuedRuns: [],
          activeWorkflows: [],
          activeAgentTurns: [],
          pendingPermissions: [],
          pendingUserInputs: [],
          blockers: [],
          canStop: true,
        };
      },
    },
    diagnostics: {
      async latestContextBudget() {
        return null;
      },
      async latestToolExposure() {
        return null;
      },
    },
    async close() {},
    emit(event) {
      eventLog.push(event);
      for (const entry of listeners) {
        if (entry.filter.sessionId && entry.filter.sessionId !== event.sessionId) continue;
        entry.listener(event);
      }
    },
  };

  return runtime;
}

function createTestUserInputs(): KodaXRuntime['userInputs'] {
  return {
    async listPending() { return []; },
    async respond(requestId) {
      return { requestId, accepted: false, status: 'already_resolved' };
    },
    async dismiss(requestId) {
      return { requestId, accepted: false, status: 'already_resolved' };
    },
  };
}

function createTestCredentialService(): KodaXRuntime['credentials'] {
  return {
    async register(input) { return { id: 'credential-test', ...input }; },
    async resume() { throw new Error('Missing credential lease.'); },
    async revoke() { return false; },
  };
}

function createTestHostToolService(): KodaXRuntime['hostTools'] {
  return {
    async register(tools) { return { id: 'host-tools-test', tools }; },
    async resume() { throw new Error('Missing host tool lease.'); },
    async revoke() { return false; },
    async getInvocation() { return undefined; },
  };
}

function createTestObservation(sessionId: string) {
  return {
    snapshot: {
      runtimeId: 'runtime-test',
      cursor: 0,
      transcriptRevision: 'sha256:test',
      session: { id: sessionId, title: 'Test Session' },
      transcript: null,
      settings: { revision: 0, value: {} },
      runs: [],
      pendingPermissions: [],
      live: {
        assistantTextByRun: {},
        thinkingTextByRun: {},
        activeTools: [],
        pendingUserInputs: [],
        managedTasks: [],
      },
    },
    close() {},
  };
}

function eventMatchesReplayFilter(
  event: RuntimeEvent,
  filter: RuntimeEventReplayFilter | undefined,
): boolean {
  if (!filter) return true;
  if (filter.sessionId !== undefined && event.sessionId !== filter.sessionId) return false;
  if (filter.runId !== undefined && event.runId !== filter.runId) return false;
  if (filter.type !== undefined) {
    const types = Array.isArray(filter.type) ? filter.type : [filter.type];
    if (!types.includes(event.type)) return false;
  }
  if (filter.sinceSeq !== undefined && event.seq <= filter.sinceSeq) return false;
  return true;
}
