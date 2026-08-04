import { describe, expect, it, vi } from 'vitest';

import type { KodaXOptions, KodaXResult } from '@kodax-ai/coding';
import type {
  KodaXRuntime,
  RuntimeEvent,
  RuntimeStartRunInput,
} from './sdk-runtime.js';
import {
  createInteractiveRuntimeRunner,
  createReplRuntimeAutoModeControl,
  toDaemonRuntimeRunOptions,
  toRuntimeOwnedInteractiveOptions,
} from './kodax_cli.js';

describe('interactive daemon runtime bridge', () => {
  it('synchronizes Auto settings once without resetting a later session engine choice', async () => {
    const updateSettings = vi.fn(async () => ({ permissionMode: 'auto' }));
    const runtime = {
      sessions: {
        load: vi.fn(async () => ({ id: 'session-1' })),
        getSettings: vi.fn(async () => ({ permissionMode: 'auto' })),
        updateSettings,
        getAutoModeStats: vi.fn(async () => ({
          engine: 'llm' as const,
          denials: {},
          breaker: {},
        })),
      },
    } as unknown as KodaXRuntime;
    const control = createReplRuntimeAutoModeControl(runtime);

    await control.syncSettings?.('session-1', 'auto', { engine: 'llm' });
    await control.setEngine('session-1', 'rules');
    await control.syncSettings?.('session-1', 'auto', { engine: 'llm' });

    expect(updateSettings).toHaveBeenNthCalledWith(1, 'session-1', {
      permissionMode: 'auto',
      autoModeEngine: 'llm',
      autoModeClassifierModel: null,
      autoModeTimeoutMs: null,
      autoModeSpeculativeWindowMs: null,
    });
    expect(updateSettings).toHaveBeenNthCalledWith(2, 'session-1', {
      autoModeEngine: 'rules',
    });
    expect(updateSettings).toHaveBeenNthCalledWith(3, 'session-1', {
      permissionMode: 'auto',
      autoModeClassifierModel: null,
      autoModeTimeoutMs: null,
      autoModeSpeculativeWindowMs: null,
    });
  });

  it('preserves a persisted Auto engine when a fresh REPL control synchronizes', async () => {
    const updateSettings = vi.fn(async () => ({
      permissionMode: 'auto',
      autoModeEngine: 'rules' as const,
    }));
    const runtime = {
      sessions: {
        load: vi.fn(async () => ({ id: 'session-1' })),
        getSettings: vi.fn(async () => ({
          permissionMode: 'auto',
          autoModeEngine: 'rules' as const,
        })),
        updateSettings,
        getAutoModeStats: vi.fn(async () => ({
          engine: 'rules' as const,
          denials: {},
          breaker: {},
        })),
      },
    } as unknown as KodaXRuntime;

    const control = createReplRuntimeAutoModeControl(runtime);
    await control.syncSettings?.('session-1', 'auto', { engine: 'llm' });

    expect(updateSettings).toHaveBeenCalledWith('session-1', {
      permissionMode: 'auto',
      autoModeClassifierModel: null,
      autoModeTimeoutMs: null,
      autoModeSpeculativeWindowMs: null,
    });
  });

  it('does not persist a new REPL session while synchronizing startup settings', async () => {
    const create = vi.fn(async () => ({ id: 'new-session' }));
    const getSettings = vi.fn(async () => ({ permissionMode: 'auto' }));
    const updateSettings = vi.fn(async () => ({ permissionMode: 'auto' }));
    const runtime = {
      sessions: {
        load: vi.fn(async () => {
          throw new Error('Session not found: new-session');
        }),
        create,
        getSettings,
        updateSettings,
        getAutoModeStats: vi.fn(async () => ({
          engine: 'llm' as const,
          denials: {},
          breaker: {},
        })),
      },
    } as unknown as KodaXRuntime;

    const control = createReplRuntimeAutoModeControl(runtime);
    const stats = await control.syncSettings?.('new-session', 'auto', {
      engine: 'llm',
    });

    expect(stats).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
    expect(getSettings).not.toHaveBeenCalled();
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('serializes rapid permission-mode changes so the last shortcut wins', async () => {
    let persistedMode = 'accept-edits';
    let releaseFirstUpdate: (() => void) | undefined;
    const firstUpdateBlocked = new Promise<void>((resolve) => {
      releaseFirstUpdate = resolve;
    });
    let updateCount = 0;
    const updateSettings = vi.fn(async (_sessionId: string, patch: { permissionMode?: string }) => {
      updateCount += 1;
      if (updateCount === 1) await firstUpdateBlocked;
      if (patch.permissionMode !== undefined) persistedMode = patch.permissionMode;
      return { permissionMode: persistedMode };
    });
    const runtime = {
      sessions: {
        load: vi.fn(async () => ({ id: 'session-1' })),
        getSettings: vi.fn(async () => ({ permissionMode: persistedMode })),
        updateSettings,
        getAutoModeStats: vi.fn(async () => ({
          engine: 'llm' as const,
          denials: {},
          breaker: {},
        })),
      },
    } as unknown as KodaXRuntime;
    const control = createReplRuntimeAutoModeControl(runtime);

    const first = control.syncSettings?.('session-1', 'plan', { engine: 'llm' });
    const second = control.syncSettings?.('session-1', 'auto', { engine: 'llm' });
    await vi.waitFor(() => expect(updateSettings).toHaveBeenCalled());
    await Promise.resolve();
    expect(updateSettings).toHaveBeenCalledTimes(1);
    releaseFirstUpdate?.();
    await Promise.all([first, second]);

    expect(persistedMode).toBe('auto');
  });

  it('builds an explicit JSON-safe run-options DTO for bridged callbacks', () => {
    const controller = new AbortController();
    const options = {
      provider: 'mock-provider',
      model: 'mock-model',
      abortSignal: controller.signal,
      events: {
        workflowCorrelation: { runId: 'workflow-1' },
        onTextDelta: () => undefined,
        beforeToolExecute: async () => true,
      },
      session: {
        id: 'session-1',
        storage: { load: async () => null },
        initialMessages: [{ role: 'user', content: 'hello' }],
      },
      context: {
        executionCwd: 'C:/workspace',
        configHome: 'C:/attacker-controlled-home',
        memoryIdentity: {
          configHome: 'C:/attacker-controlled-home',
          tenantId: 'attacker-tenant',
          agentId: 'attacker-agent',
          projectId: 'attacker-project',
          sessionId: 'attacker-session',
        },
        shellExecution: {
          version: 1,
          shell: { kind: 'pwsh', profile: 'none' },
          environment: { inherit: 'filtered' },
        },
      },
      skillDynamicContext: {
        disable: true,
      },
      sandbox: { envPass: ['GH_TOKEN'] },
    } as unknown as KodaXOptions;

    const wire = toDaemonRuntimeRunOptions(toRuntimeOwnedInteractiveOptions(
      options,
      { omitLegacyBeforeToolExecute: true },
    ));
    const encoded = JSON.stringify(wire);

    expect(wire).toMatchObject({
      provider: 'mock-provider',
      model: 'mock-model',
      session: {
        id: 'session-1',
        initialMessages: [{ role: 'user', content: 'hello' }],
      },
      context: {
        executionCwd: 'C:/workspace',
        shellExecution: {
          version: 1,
          shell: { kind: 'pwsh', profile: 'none' },
          environment: { inherit: 'filtered' },
        },
      },
      events: { workflowCorrelation: { runId: 'workflow-1' } },
      skillDynamicContext: { disable: true },
      sandbox: { envPass: ['GH_TOKEN'] },
    });
    expect(encoded).not.toContain('abortSignal');
    expect(encoded).not.toContain('storage');
    expect(encoded).not.toContain('attacker-controlled');
    expect(wire.context).not.toHaveProperty('configHome');
    expect(wire.context).not.toHaveProperty('memoryIdentity');
  });

  it('rejects host-only bindings that the daemon cannot reproduce', () => {
    expect(() => toDaemonRuntimeRunOptions({
      provider: 'mock-provider',
      extensionRuntime: { activate: () => undefined },
    } as unknown as KodaXOptions)).toThrow(/extensionRuntime.*cannot cross/i);

    expect(() => toDaemonRuntimeRunOptions({
      provider: 'mock-provider',
      context: { planModeBlockCheck: () => null },
    } as unknown as KodaXOptions)).toThrow(/context\.planModeBlockCheck.*cannot cross/i);

    expect(() => toDaemonRuntimeRunOptions({
      provider: 'mock-provider',
      memoryRecallRunner: async () => ({ selectedRefIds: [] }),
    } as unknown as KodaXOptions)).toThrow(/memoryRecallRunner.*cannot cross/i);
  });

  it('forwards daemon stream events and returns the selected Runtime-issued grant', async () => {
    const onTextDelta = vi.fn();
    const onPromptCacheDiagnostics = vi.fn();
    const legacyBeforeToolExecute = vi.fn(async () => true);
    const requestPermission = vi.fn(async () => ({
      type: 'allow_always' as const,
      suggestionId: 'grant-persistent-1',
    }));
    const updateSettings = vi.fn(async () => ({ permissionMode: 'plan' }));
    const respond = vi.fn(async () => true);
    const closeSubscription = vi.fn();
    let eventListener: ((event: RuntimeEvent) => void) | undefined;
    let capturedStart: RuntimeStartRunInput | undefined;
    const start = vi.fn(async (input: RuntimeStartRunInput) => {
      capturedStart = input;
      eventListener?.(runtimeEvent('tool.started', {
        tool: { id: 'tool-1', name: 'write', input: { path: 'C:/workspace/a.ts' } },
      }));
      eventListener?.(runtimeEvent('assistant.delta', { text: 'streamed' }));
      eventListener?.(runtimeEvent('provider.cache.diagnostics', {
        phase: 'response',
        requestId: 'cache-request-1',
        requestedAt: '2026-07-10T00:00:00.000Z',
        completedAt: '2026-07-10T00:00:01.000Z',
        provider: 'zai',
        model: 'glm-5.2',
        wireModel: 'glm-5.2',
        attempt: 1,
        systemPromptHash: 'system-hash',
        toolSchemaHash: 'tool-hash',
        messagePrefixHash: 'prefix-hash',
        messagePrefixCount: 2,
        requestMessagesHash: 'messages-hash',
        messageCount: 3,
        toolCount: 4,
        cachedReadTokens: 19_328,
      }));
      eventListener?.(runtimeEvent('permission.requested', {
        id: 'perm-1',
        toolCallId: 'tool-1',
        toolName: 'write',
        inputPreview: '{"path":"wrong-fallback"}',
        reason: 'Runtime classification requires confirmation.',
        risk: 'medium',
        executionCwd: 'C:/workspace',
        grantSuggestions: [{
          id: 'grant-persistent-1',
          kind: 'persistent',
          label: 'Always allow write for C:/workspace/a.ts',
        }],
      }));
      return {
        runId: 'run-1',
        sessionId: 'session-1',
        result: Promise.resolve({
          runId: 'run-1',
          sessionId: 'session-1',
          phase: 'completed' as const,
          result: successfulResult(),
        }),
      };
    });
    const runtime = {
      identity: {
        runtimeId: 'runtime-1',
        mode: 'daemon',
        profile: 'default',
        startedAt: '2026-07-10T00:00:00.000Z',
        version: 'test',
      },
      sessions: {
        load: vi.fn(async () => ({ id: 'session-1' })),
        getSettings: vi.fn(async () => ({ permissionMode: 'plan' })),
        updateSettings,
      },
      runs: { start },
      events: {
        subscribe: vi.fn((_filter, listener: (event: RuntimeEvent) => void) => {
          eventListener = listener;
          return { close: closeSubscription };
        }),
      },
      permissions: { respond },
    } as unknown as KodaXRuntime;
    const runner = createInteractiveRuntimeRunner(runtime);

    await expect(runner({
      options: {
        provider: 'mock-provider',
        abortSignal: new AbortController().signal,
        events: {
          onTextDelta,
          onPromptCacheDiagnostics,
          beforeToolExecute: legacyBeforeToolExecute,
        },
      } as unknown as KodaXOptions,
      prompt: 'hello',
      sessionId: 'session-1',
      permissionMode: 'plan',
      autoModeSettings: {
        engine: 'llm',
        classifierModel: 'qwen-token-plan:qwen3.7-plus',
        timeoutMs: 20_000,
        speculativeWindowMs: 1_200,
      },
      requestPermission,
      legacyPermissionHook: true,
    })).resolves.toMatchObject({ success: true, lastText: 'done' });

    expect(updateSettings).toHaveBeenCalledWith('session-1', {
      permissionMode: 'plan',
      autoModeEngine: 'llm',
      autoModeClassifierModel: 'qwen-token-plan:qwen3.7-plus',
      autoModeTimeoutMs: 20_000,
      autoModeSpeculativeWindowMs: 1_200,
    });
    expect(capturedStart?.permissionBroker).toBe('client');
    expect(capturedStart?.options).not.toHaveProperty('abortSignal');
    expect(onTextDelta).toHaveBeenCalledWith('streamed', undefined);
    expect(onPromptCacheDiagnostics).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'cache-request-1',
      cachedReadTokens: 19_328,
    }));
    expect(legacyBeforeToolExecute).not.toHaveBeenCalled();
    expect(requestPermission).toHaveBeenCalledWith(expect.objectContaining({
      id: 'perm-1',
      toolName: 'write',
      toolCallId: 'tool-1',
      input: { path: 'C:/workspace/a.ts' },
      reason: 'Runtime classification requires confirmation.',
      risk: 'medium',
      executionCwd: 'C:/workspace',
      grantSuggestions: [{
        id: 'grant-persistent-1',
        kind: 'persistent',
        label: 'Always allow write for C:/workspace/a.ts',
      }],
    }));
    expect(respond).toHaveBeenCalledWith(
      'perm-1',
      { type: 'allow_always', suggestionId: 'grant-persistent-1' },
      { runId: 'run-1' },
    );
    expect(closeSubscription).toHaveBeenCalledOnce();
  });

  it('does not report a run as finished while an earlier permission event is unresolved', async () => {
    let eventListener: ((event: RuntimeEvent) => void) | undefined;
    let resolvePermission: ((decision: { type: 'allow_once' }) => void) | undefined;
    const requestPermission = vi.fn(() => new Promise<{ type: 'allow_once' }>((resolve) => {
      resolvePermission = resolve;
    }));
    const respond = vi.fn(async () => true);
    const runtime = {
      identity: {
        runtimeId: 'runtime-ordering',
        mode: 'daemon',
        profile: 'default',
        startedAt: '2026-07-20T00:00:00.000Z',
        version: 'test',
      },
      sessions: {
        load: vi.fn(async () => ({ id: 'session-1' })),
        updateSettings: vi.fn(async () => ({ permissionMode: 'auto' })),
      },
      runs: {
        start: vi.fn(async () => {
          eventListener?.(runtimeEvent('permission.requested', {
            id: 'permission-before-terminal',
            toolCallId: 'tool-1',
            toolName: 'bash',
            inputPreview: '{"command":"git log -1"}',
          }));
          return {
            runId: 'run-1',
            sessionId: 'session-1',
            result: Promise.resolve({
              runId: 'run-1',
              sessionId: 'session-1',
              phase: 'completed' as const,
              result: successfulResult(),
            }),
          };
        }),
      },
      events: {
        subscribe: vi.fn((_filter, listener: (event: RuntimeEvent) => void) => {
          eventListener = listener;
          return { close: vi.fn() };
        }),
      },
      permissions: { respond },
    } as unknown as KodaXRuntime;
    let settled = false;

    const run = createInteractiveRuntimeRunner(runtime)({
      options: {} as KodaXOptions,
      prompt: 'review',
      sessionId: 'session-1',
      permissionMode: 'auto',
      requestPermission,
    }).then((result) => {
      settled = true;
      return result;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(requestPermission).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    resolvePermission?.({ type: 'allow_once' });
    await expect(run).resolves.toMatchObject({ success: true });
    expect(respond).toHaveBeenCalledWith(
      'permission-before-terminal',
      { type: 'allow_once' },
      { runId: 'run-1' },
    );
  });

  it('keeps embedded Runtime as the sole Auto owner and still bridges permission prompts', async () => {
    const autoGuardrail = { kind: 'tool' as const, name: 'auto-mode' };
    const customGuardrail = { kind: 'tool' as const, name: 'custom-policy' };
    const legacyBeforeToolExecute = vi.fn(async () => true);
    const requestPermission = vi.fn(async () => ({ type: 'allow_once' as const }));
    const respond = vi.fn(async () => true);
    let eventListener: ((event: RuntimeEvent) => void) | undefined;
    let capturedStart: RuntimeStartRunInput | undefined;
    const runtime = {
      identity: {
        runtimeId: 'runtime-embedded',
        mode: 'embedded',
        profile: 'default',
        startedAt: '2026-07-10T00:00:00.000Z',
        version: 'test',
      },
      sessions: {
        load: vi.fn(async () => ({ id: 'session-1' })),
        updateSettings: vi.fn(async () => ({ permissionMode: 'auto' })),
      },
      runs: {
        start: vi.fn(async (input: RuntimeStartRunInput) => {
          capturedStart = input;
          eventListener?.(runtimeEvent('permission.requested', {
            id: 'perm-embedded',
            toolCallId: 'tool-embedded',
            toolName: 'read',
            inputPreview: '{"path":"README.md"}',
            grantSuggestions: [{ id: 'session-1', kind: 'session', label: 'This session' }],
          }));
          return {
            runId: 'run-1',
            sessionId: 'session-1',
            result: Promise.resolve({
              runId: 'run-1',
              sessionId: 'session-1',
              phase: 'completed' as const,
              result: successfulResult(),
            }),
          };
        }),
      },
      events: {
        subscribe: vi.fn((_filter, listener: (event: RuntimeEvent) => void) => {
          eventListener = listener;
          return { close: vi.fn() };
        }),
      },
      permissions: { respond },
    } as unknown as KodaXRuntime;

    await createInteractiveRuntimeRunner(runtime)({
      options: {
        events: { beforeToolExecute: legacyBeforeToolExecute },
        guardrails: [autoGuardrail, customGuardrail],
      } as unknown as KodaXOptions,
      prompt: 'inspect',
      sessionId: 'session-1',
      permissionMode: 'auto',
      requestPermission,
      legacyPermissionHook: true,
    });

    expect(capturedStart?.permissionBroker).toBe('client');
    expect(capturedStart?.options?.guardrails).toEqual([customGuardrail]);
    expect(capturedStart?.options?.events).not.toHaveProperty('beforeToolExecute');
    expect(legacyBeforeToolExecute).not.toHaveBeenCalled();
    expect(requestPermission).toHaveBeenCalledWith(expect.objectContaining({
      id: 'perm-embedded',
      input: { path: 'README.md' },
    }));
    expect(respond).toHaveBeenCalledWith(
      'perm-embedded',
      { type: 'allow_once' },
      { runId: 'run-1' },
    );
  });

  it('preserves custom host policy hooks unless the REPL marks its legacy permission hook', () => {
    const beforeToolExecute = vi.fn(async () => true);
    const onTextDelta = vi.fn();
    const customGuardrail = { kind: 'tool' as const, name: 'custom-policy' };
    const preserved = toRuntimeOwnedInteractiveOptions({
      guardrails: [{ kind: 'tool', name: 'auto-mode' }, customGuardrail],
      events: { beforeToolExecute, onTextDelta },
    } as unknown as KodaXOptions);

    expect(preserved.guardrails).toEqual([customGuardrail]);
    expect(preserved.events?.beforeToolExecute).toBe(beforeToolExecute);
    expect(preserved.events?.onTextDelta).toBe(onTextDelta);

    const sanitized = toRuntimeOwnedInteractiveOptions(
      {
        guardrails: [{ kind: 'tool', name: 'auto-mode' }, customGuardrail],
        events: { beforeToolExecute, onTextDelta },
      } as unknown as KodaXOptions,
      { omitLegacyBeforeToolExecute: true },
    );
    expect(sanitized.guardrails).toEqual([customGuardrail]);
    expect(sanitized.events?.beforeToolExecute).toBeUndefined();
    expect(sanitized.events?.onTextDelta).toBe(onTextDelta);
  });

  it('rejects a custom beforeToolExecute policy that cannot cross the daemon boundary', () => {
    expect(() => toDaemonRuntimeRunOptions({
      events: { beforeToolExecute: async () => true },
    } as unknown as KodaXOptions)).toThrow(/events\.beforeToolExecute.*cannot cross/i);
  });

  it('transport-sanitizes run options for a Worker-hosted embedded runtime', async () => {
    let capturedOptions: unknown;
    let eventListener: ((event: RuntimeEvent) => void) | undefined;
    const runtime = {
      identity: {
        runtimeId: 'runtime-worker-a2a',
        mode: 'embedded',
        isolation: 'worker',
        profile: 'default',
        startedAt: '2026-07-20T00:00:00.000Z',
        version: 'test',
      },
      sessions: {
        load: vi.fn(async () => ({ id: 'session-1' })),
        updateSettings: vi.fn(async () => ({ permissionMode: 'plan' })),
      },
      runs: {
        start: vi.fn(async (input: RuntimeStartRunInput) => {
          capturedOptions = input.options;
          return {
            runId: 'run-1',
            sessionId: 'session-1',
            result: Promise.resolve({
              runId: 'run-1',
              sessionId: 'session-1',
              phase: 'completed' as const,
              result: successfulResult(),
            }),
          };
        }),
      },
      events: {
        subscribe: vi.fn((_filter, listener: (event: RuntimeEvent) => void) => {
          eventListener = listener;
          return { close: vi.fn() };
        }),
      },
      permissions: { respond: vi.fn(async () => true) },
    } as unknown as KodaXRuntime;

    await createInteractiveRuntimeRunner(runtime)({
      options: {
        provider: 'mock-provider',
        extensionRuntime: { activate: async () => undefined },
        events: {
          beforeToolExecute: async () => true,
          onTextDelta: () => undefined,
          workflowCorrelation: { runId: 'workflow-1' },
        },
        session: {
          id: 'session-1',
          storage: { load: async () => null },
          initialMessages: [{ role: 'user', content: 'hello' }],
        },
        context: {
          executionCwd: 'C:/workspace',
          memoryIdentity: {
            configHome: 'C:/host-home',
            tenantId: 'host-tenant',
            agentId: 'host-agent',
            projectId: 'host-project',
            sessionId: 'host-session',
          },
        },
      } as unknown as KodaXOptions,
      prompt: 'inspect',
      sessionId: 'session-1',
    });

    expect(capturedOptions).toMatchObject({
      provider: 'mock-provider',
      session: { id: 'session-1' },
      context: { executionCwd: 'C:/workspace' },
      events: { workflowCorrelation: { runId: 'workflow-1' } },
    });
    // Host-only bindings are stripped before the Worker transport boundary.
    const serialized = JSON.stringify(capturedOptions);
    expect(serialized).not.toContain('beforeToolExecute');
    expect(serialized).not.toContain('onTextDelta');
    expect(serialized).not.toContain('storage');
    expect(serialized).not.toContain('memoryIdentity');
    expect((capturedOptions as { extensionRuntime?: unknown }).extensionRuntime)
      .toBeUndefined();
    expect((capturedOptions as { session?: unknown }).session)
      .not.toHaveProperty('storage');
    expect((capturedOptions as { context?: unknown }).context)
      .not.toHaveProperty('memoryIdentity');
  });

  it('keeps run options intact for an inline embedded runtime', async () => {
    let capturedOptions: unknown;
    const runtime = {
      identity: {
        runtimeId: 'runtime-inline',
        mode: 'embedded',
        isolation: 'inline',
        profile: 'default',
        startedAt: '2026-07-20T00:00:00.000Z',
        version: 'test',
      },
      sessions: {
        load: vi.fn(async () => ({ id: 'session-1' })),
        updateSettings: vi.fn(async () => ({ permissionMode: 'plan' })),
      },
      runs: {
        start: vi.fn(async (input: RuntimeStartRunInput) => {
          capturedOptions = input.options;
          return {
            runId: 'run-1',
            sessionId: 'session-1',
            result: Promise.resolve({
              runId: 'run-1',
              sessionId: 'session-1',
              phase: 'completed' as const,
              result: successfulResult(),
            }),
          };
        }),
      },
      events: {
        subscribe: vi.fn(() => ({ close: vi.fn() })),
      },
      permissions: { respond: vi.fn(async () => true) },
    } as unknown as KodaXRuntime;

    const beforeToolExecute = vi.fn(async () => true);
    const extensionRuntime = { activate: async () => undefined };
    await createInteractiveRuntimeRunner(runtime)({
      options: {
        provider: 'mock-provider',
        extensionRuntime,
        events: { beforeToolExecute },
      } as unknown as KodaXOptions,
      prompt: 'inspect',
      sessionId: 'session-1',
    });

    expect(capturedOptions).toMatchObject({
      provider: 'mock-provider',
      extensionRuntime,
    });
    expect((capturedOptions as { events?: { beforeToolExecute?: unknown } }).events?.beforeToolExecute)
      .toBe(beforeToolExecute);
  });
});

function runtimeEvent(type: RuntimeEvent['type'], payload: unknown): RuntimeEvent {
  return {
    id: `event-${type}`,
    seq: 1,
    time: '2026-07-10T00:00:00.000Z',
    sessionId: 'session-1',
    runId: 'run-1',
    type,
    payload,
  };
}

function successfulResult(): KodaXResult {
  return {
    success: true,
    lastText: 'done',
    messages: [],
    sessionId: 'session-1',
  };
}
