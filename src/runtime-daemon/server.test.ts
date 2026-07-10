import { describe, expect, it } from 'vitest';

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

describe('runtime daemon dispatcher', () => {
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
      const dispatcher = createRuntimeDaemonDispatcher({ runtime: makeRuntime() });
      if (!isInitializeMethod(method)) {
        await initializeDispatcher(dispatcher);
      }

      const response = await dispatcher.handle(createRuntimeDaemonRequest(
        `req-${method.replace(/[^a-zA-Z0-9]/g, '-')}`,
        method,
        METHOD_SMOKE_PARAMS[method],
      ));
      dispatcher.close();

      expect(
        isRuntimeDaemonSuccessResponse(response),
        `${method} should be implemented by runtime daemon dispatcher`,
      ).toBe(true);
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
  capabilities: RuntimeClientCapabilities = { contextDiagnostics: true, permissionPrompts: true },
): Promise<void> {
  const initialized = await dispatcher.handle(createRuntimeDaemonRequest('req-init', 'initialize', {
    profile: 'default',
    clientInfo: { name: 'vitest' },
    capabilities,
  }));
  expect(isRuntimeDaemonSuccessResponse(initialized)).toBe(true);
}

function isInitializeMethod(method: RuntimeDaemonMethod): boolean {
  return method === 'initialize' || method === 'runtime.initialize';
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
  'session.create': { sessionId: 'session-smoke', title: 'Smoke Session' },
  'session.load': { sessionId: 'session-1' },
  'session.list': { limit: 5 },
  'session.transcript': { sessionId: 'session-1' },
  'session.fork': { sessionId: 'session-1' },
  'session.notice.append': { sessionId: 'session-1', notice: 'smoke' },
  'session.rewind': { sessionId: 'session-1', entryId: 'entry-1' },
  'session.active_entry.set': { sessionId: 'session-1', entryId: 'entry-1' },
  'session.activeEntry.set': { sessionId: 'session-1', entryId: 'entry-1' },
  'session.compact': { sessionId: 'session-1' },
  'session.archive': { sessionId: 'session-1' },
  'session.unarchive': { sessionId: 'session-1' },
  'session.delete': { sessionId: 'session-1' },
  'session.settings.get': { sessionId: 'session-1' },
  'session.settings.update': { sessionId: 'session-1', patch: { model: 'mock-model' } },
  'run.start': { sessionId: 'session-1', prompt: 'hello daemon' },
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
  'permission.request': { runId: 'run-1', toolName: 'read', input: {} },
  'permission.respond': { requestId: 'perm-1', runId: 'run-1', decision: { type: 'allow_once' } },
  'workflow.list': { sessionId: 'session-1' },
  'workflow.get': { runId: 'run-1' },
  'workflow.subscribe': { filter: { sessionId: 'session-1' } },
  'workflow.unsubscribe': { subscriptionId: 'workflow-sub-missing' },
  'workflow.pause': { runId: 'run-1' },
  'workflow.resume': { runId: 'run-1' },
  'workflow.stop': { runId: 'run-1' },
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
      async fork() {
        return { id: 'fork-1', title: 'Forked Session' };
      },
      async getSettings() {
        return {};
      },
      async updateSettings(_sessionId, patch) {
        return Object.fromEntries(
          Object.entries(patch).filter((entry): entry is [string, string | boolean] => (
            entry[1] !== null && entry[1] !== undefined
          )),
        );
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
          createdAt: '2026-07-09T00:00:00.000Z',
        };
      },
      async get(artifactId) {
        return artifactId === 'art-1'
          ? {
              id: 'art-1',
              kind: 'file',
              path: '/tmp/file.txt',
              createdAt: '2026-07-09T00:00:00.000Z',
            }
          : undefined;
      },
      async delete() {
        return true;
      },
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
