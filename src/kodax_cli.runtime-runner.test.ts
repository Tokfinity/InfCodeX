import { describe, expect, it, vi } from 'vitest';

import type { KodaXOptions, KodaXResult } from '@kodax-ai/coding';
import type {
  KodaXRuntime,
  RuntimeEvent,
  RuntimeStartRunInput,
} from './sdk-runtime.js';
import {
  createInteractiveRuntimeRunner,
  toDaemonRuntimeRunOptions,
  toRuntimeOwnedInteractiveOptions,
} from './kodax_cli.js';

describe('interactive daemon runtime bridge', () => {
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
      context: { executionCwd: 'C:/workspace' },
      skillDynamicContext: {
        disable: true,
      },
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
      context: { executionCwd: 'C:/workspace' },
      events: { workflowCorrelation: { runId: 'workflow-1' } },
      skillDynamicContext: { disable: true },
    });
    expect(encoded).not.toContain('abortSignal');
    expect(encoded).not.toContain('storage');
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
  });

  it('forwards daemon stream events and returns the selected Runtime-issued grant', async () => {
    const onTextDelta = vi.fn();
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
        events: { onTextDelta, beforeToolExecute: legacyBeforeToolExecute },
      } as unknown as KodaXOptions,
      prompt: 'hello',
      sessionId: 'session-1',
      permissionMode: 'plan',
      requestPermission,
      legacyPermissionHook: true,
    })).resolves.toMatchObject({ success: true, lastText: 'done' });

    expect(updateSettings).toHaveBeenCalledWith('session-1', { permissionMode: 'plan' });
    expect(capturedStart?.permissionBroker).toBe('client');
    expect(capturedStart?.options).not.toHaveProperty('abortSignal');
    expect(onTextDelta).toHaveBeenCalledWith('streamed', undefined);
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
