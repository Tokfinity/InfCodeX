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
} from './kodax_cli.js';

describe('interactive daemon runtime bridge', () => {
  it('builds an explicit JSON-safe run-options DTO', () => {
    const controller = new AbortController();
    const options = {
      provider: 'mock-provider',
      model: 'mock-model',
      abortSignal: controller.signal,
      extensionRuntime: { activate: () => undefined },
      sessionControl: { _attach: () => undefined },
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
        planModeBlockCheck: () => null,
        lspService: { shutdown: async () => undefined },
      },
      skillDynamicContext: {
        disable: true,
        execute: async () => 'unsafe-process-hook',
      },
    } as unknown as KodaXOptions;

    const wire = toDaemonRuntimeRunOptions(options);
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
    expect(encoded).not.toContain('extensionRuntime');
    expect(encoded).not.toContain('storage');
    expect(encoded).not.toContain('planModeBlockCheck');
    expect(encoded).not.toContain('unsafe-process-hook');
  });

  it('forwards daemon stream events and resolves permissions with the local REPL policy', async () => {
    const onTextDelta = vi.fn();
    const beforeToolExecute = vi.fn(async () => true);
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
        extensionRuntime: { activate: () => undefined },
        events: { onTextDelta, beforeToolExecute },
      } as unknown as KodaXOptions,
      prompt: 'hello',
      sessionId: 'session-1',
      permissionMode: 'plan',
    })).resolves.toMatchObject({ success: true, lastText: 'done' });

    expect(updateSettings).toHaveBeenCalledWith('session-1', { permissionMode: 'plan' });
    expect(capturedStart?.permissionBroker).toBe('client');
    expect(capturedStart?.options).not.toHaveProperty('abortSignal');
    expect(capturedStart?.options).not.toHaveProperty('extensionRuntime');
    expect(onTextDelta).toHaveBeenCalledWith('streamed', undefined);
    expect(beforeToolExecute).toHaveBeenCalledWith(
      'write',
      { path: 'C:/workspace/a.ts' },
      expect.objectContaining({ sessionId: 'session-1', toolId: 'tool-1' }),
    );
    expect(respond).toHaveBeenCalledWith(
      'perm-1',
      { type: 'allow_once' },
      { runId: 'run-1' },
    );
    expect(closeSubscription).toHaveBeenCalledOnce();
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
