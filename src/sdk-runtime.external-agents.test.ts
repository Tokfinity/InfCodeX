import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createReferenceAgentExecutorFactory } from '@kodax-ai/agent';
import type {
  AgentExecutorFactory,
  AgentTaskState,
  ExternalAgentRegistration,
} from '@kodax-ai/agent';
import { createKodaXRuntime, type KodaXRuntime } from './sdk-runtime.js';
import { createRuntimeDaemonClient } from './runtime-daemon/client.js';
import {
  createRuntimeDaemonRequest,
  isRuntimeDaemonSuccessResponse,
  type RuntimeDaemonMethod,
} from './runtime-daemon/protocol.js';
import { createRuntimeDaemonDispatcher } from './runtime-daemon/server.js';

let homeDir: string | undefined;

afterEach(() => {
  if (homeDir) fs.rmSync(homeDir, { recursive: true, force: true });
  homeDir = undefined;
});

function registration(): ExternalAgentRegistration {
  return {
    agentId: 'external:runtime-reference',
    displayName: 'Runtime Reference',
    enabled: true,
    executorId: 'reference-http',
    protocol: 'http',
    configurationRevision: 'rev-1',
    endpointIdentityHash: 'sha256:runtime-reference',
    executorConfig: { output: 'runtime-ok', privateEndpoint: 'https://private.invalid' },
    capabilities: {
      streaming: 'supported',
      durableTasks: 'supported',
      inputRequired: 'supported',
      cancellation: 'supported',
      artifacts: 'supported',
    },
    effects: { remote: 'read', workspace: 'proposal' },
  };
}

function externalAgentOptions() {
  return {
    factories: [createReferenceAgentExecutorFactory({
      executorId: 'reference-http',
      protocol: 'http' as const,
    })],
    policy: async () => ({ allowed: true }),
    defaultContext: { actorId: 'runtime-host' },
  };
}

function deferredExternalAgentFixture() {
  let state: AgentTaskState = 'unknown';
  let finish: (() => void) | undefined;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  const factory: AgentExecutorFactory = {
    executorId: 'deferred-http',
    protocol: 'http',
    async create() {
      return {
        async start(input) {
          return { idempotencyKey: input.idempotencyKey ?? 'deferred-task' };
        },
        async *events() {
          yield { state: 'unknown' as const };
          await finished;
          state = 'completed';
          yield { state, output: 'deferred-complete' };
        },
        async get() { return { state }; },
        async sendInput() {},
        async cancel() {
          state = 'canceled';
          finish?.();
          return { state };
        },
        async reconcile() { return { state }; },
        async dispose() { finish?.(); },
      };
    },
  };
  const deferredRegistration: ExternalAgentRegistration = {
    ...registration(),
    agentId: 'external:deferred-runtime',
    displayName: 'Deferred Runtime',
    executorId: factory.executorId,
    protocol: factory.protocol,
    configurationRevision: 'deferred-rev-1',
    endpointIdentityHash: 'sha256:deferred-runtime',
  };
  return {
    registration: deferredRegistration,
    options: {
      factories: [factory],
      policy: async () => ({ allowed: true }),
      defaultContext: { actorId: 'runtime-host' },
    },
    finish() { finish?.(); },
  };
}

async function assertRuntimeAgentServiceConformance(
  runtime: KodaXRuntime,
  actorId: string,
  parentTaskId: string,
): Promise<{ readonly taskId: string; readonly registrationJson: string }> {
  const summary = await runtime.admin.agentRegistrations.upsert(registration());
  expect(summary.credentialConfigured).toBe(false);
  const listed = await runtime.agents.listDispatchable({ actorId });
  expect(listed.map((entry) => entry.descriptor.agentId)).toEqual(expect.arrayContaining([
    'external:runtime-reference',
    'native:kodax-child',
  ]));
  expect((await runtime.agents.preflight({
    agentId: 'external:runtime-reference',
    query: { actorId, readOnly: true },
  })).ok).toBe(true);

  const started = await runtime.agentTasks.start({
    agentId: 'external:runtime-reference',
    objective: 'Run reference conformance',
    context: { actorId, parentTaskId },
  });
  expect(await runtime.agentTasks.wait(started.taskId, 1_000)).toMatchObject({
    state: 'completed',
    output: 'runtime-ok',
    parentTaskId,
  });
  expect(await runtime.agentTasks.events(started.taskId, 0)).not.toHaveLength(0);
  return { taskId: started.taskId, registrationJson: JSON.stringify(summary) };
}

describe('FEATURE_258 Embedded Runtime agent services', () => {
  it('blocks stop preflight while an external AgentTask is active or unknown', async () => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-runtime-agent-preflight-'));
    const fixture = deferredExternalAgentFixture();
    const runtime = await createKodaXRuntime({
      homeDir,
      externalAgents: fixture.options,
    });
    try {
      await runtime.admin.agentRegistrations.upsert(fixture.registration);
      const started = await runtime.agentTasks.start({
        agentId: fixture.registration.agentId,
        objective: 'Remain active during stop preflight',
        context: { actorId: 'runtime-host' },
      });
      await waitForAgentTaskState(runtime, started.taskId, 'unknown');

      await expect(runtime.status.preflight()).resolves.toMatchObject({
        activeWorkflows: [],
        activeAgentTasks: [expect.objectContaining({
          taskId: started.taskId,
          state: 'unknown',
        })],
        blockers: expect.arrayContaining(['active_agent_tasks']),
        canStop: false,
      });

      fixture.finish();
      await expect(runtime.agentTasks.wait(started.taskId, 1_000)).resolves.toMatchObject({
        state: 'completed',
      });
      const settled = await runtime.status.preflight();
      expect(settled.activeAgentTasks).toEqual([]);
      expect(settled.blockers).not.toContain('active_agent_tasks');
    } finally {
      fixture.finish();
      await runtime.close();
    }
  });

  it('provides redacted registration, shared catalog and durable task services', async () => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-runtime-agents-'));
    const runtime = await createKodaXRuntime({
      homeDir,
      requirements: { externalAgents: true },
      externalAgents: externalAgentOptions(),
    });
    const result = await assertRuntimeAgentServiceConformance(runtime, 'runtime-host', 'parent-1');
    expect(result.registrationJson).not.toContain('private.invalid');
    await runtime.close();

    const reopened = await createKodaXRuntime({
      homeDir,
      externalAgents: externalAgentOptions(),
    });
    expect(await reopened.admin.agentRegistrations.list()).toHaveLength(1);
    expect(await reopened.agentTasks.get(result.taskId)).toMatchObject({
      state: 'completed',
      output: 'runtime-ok',
    });
    await reopened.close();
  });

  it('installs executor factories inside a public in-process daemon host', async () => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-runtime-hosted-agents-'));
    const profile = `external-agent-${process.pid}-${Date.now()}`;
    const runtime = await createKodaXRuntime({
      mode: 'daemon',
      homeDir,
      profile,
      capabilities: { configAdmin: true },
      requirements: { externalAgents: true },
      externalAgents: externalAgentOptions(),
    });
    expect(runtime.identity).toMatchObject({ mode: 'daemon', isolation: 'inline' });
    expect(runtime.agents.enabled).toBe(true);
    await assertRuntimeAgentServiceConformance(runtime, 'daemon-sdk-host', 'daemon-sdk-parent');
    await expect(createKodaXRuntime({
      mode: 'daemon',
      homeDir,
      profile,
      capabilities: { configAdmin: true },
      externalAgents: externalAgentOptions(),
    })).rejects.toThrow(/already-running daemon profile/i);
    await runtime.close();
  });

  it('fails closed when the executor plane is not enabled', async () => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-runtime-no-agents-'));
    await expect(createKodaXRuntime({
      homeDir,
      requirements: { externalAgents: true },
    })).rejects.toThrow(/required externalAgents capability/i);
    const runtime = await createKodaXRuntime({ homeDir });
    expect((await runtime.agents.listDispatchable({ actorId: 'runtime-host' }))
      .map((entry) => entry.descriptor.agentId)).toEqual(['native:kodax-child']);
    await expect(runtime.agentTasks.start({
      agentId: 'external:missing',
      objective: 'No plane',
      context: { actorId: 'runtime-host' },
    })).rejects.toThrow(/not enabled/i);
    const dispatcher = createRuntimeDaemonDispatcher({ runtime });
    const initialized = await dispatcher.handle(createRuntimeDaemonRequest(
      'disabled-init',
      'initialize',
      { profile: 'default' },
    ));
    expect(isRuntimeDaemonSuccessResponse(initialized)).toBe(true);
    const listed = await dispatcher.handle(createRuntimeDaemonRequest(
      'disabled-list',
      'agents.listDispatchable',
      { actorId: 'runtime-host' },
    ));
    expect(isRuntimeDaemonSuccessResponse(listed)).toBe(true);
    if (isRuntimeDaemonSuccessResponse(listed)) {
      expect(listed.result).toEqual([
        expect.objectContaining({ descriptor: expect.objectContaining({ agentId: 'native:kodax-child' }) }),
      ]);
    }
    dispatcher.close();
    await runtime.close();
  });

  it('exposes the same services through the daemon client facade', async () => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-runtime-daemon-agents-'));
    const host = await createKodaXRuntime({
      homeDir,
      externalAgents: externalAgentOptions(),
    });
    const dispatcher = createRuntimeDaemonDispatcher({
      runtime: host,
      allowAgentRegistrationAdmin: true,
    });
    let requestSequence = 0;
    const request = async (method: RuntimeDaemonMethod, params?: unknown): Promise<unknown> => {
      requestSequence += 1;
      const response = await dispatcher.handle(createRuntimeDaemonRequest(
        `agent-daemon-${requestSequence}`,
        method,
        params,
      ));
      if (!isRuntimeDaemonSuccessResponse(response)) {
        throw new Error(`${response.error.code}: ${response.error.message}`);
      }
      return response.result;
    };

    const initialized = await request('initialize', {
      profile: 'default',
      capabilities: { configAdmin: true },
    });
    expect(initialized).toMatchObject({ capabilities: { externalAgents: true } });
    const daemon = createRuntimeDaemonClient({
      identity: host.identity,
      capabilities: { externalAgents: true },
      transport: {
        request,
        subscribe() { return { close() {} }; },
      },
    });

    expect(daemon.agents.enabled).toBe(true);
    await assertRuntimeAgentServiceConformance(daemon, 'daemon-host', 'daemon-parent');

    dispatcher.close();
    await daemon.close();
    await host.close();
  });
});

async function waitForAgentTaskState(
  runtime: KodaXRuntime,
  taskId: string,
  expected: AgentTaskState,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() <= deadline) {
    if ((await runtime.agentTasks.get(taskId)).state === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for AgentTask ${taskId} state ${expected}.`);
}
