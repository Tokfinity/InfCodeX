import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createReferenceAgentExecutorFactory } from '@kodax-ai/agent';
import type { ExternalAgentRegistration } from '@kodax-ai/agent';
import { createKodaXRuntime } from './sdk-runtime.js';
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

describe('FEATURE_258 Embedded Runtime agent services', () => {
  it('provides redacted registration, shared catalog and durable task services', async () => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-runtime-agents-'));
    const runtime = await createKodaXRuntime({
      homeDir,
      requirements: { externalAgents: true },
      externalAgents: externalAgentOptions(),
    });
    const summary = await runtime.admin.agentRegistrations.upsert(registration());
    expect(summary.credentialConfigured).toBe(false);
    expect(JSON.stringify(summary)).not.toContain('private.invalid');

    const listed = await runtime.agents.listDispatchable({ actorId: 'runtime-host' });
    expect(listed.map((entry) => entry.descriptor.agentId)).toEqual([
      'external:runtime-reference',
      'native:kodax-child',
    ]);
    expect((await runtime.agents.preflight({
      agentId: 'external:runtime-reference',
      query: { actorId: 'runtime-host', readOnly: true },
    })).ok).toBe(true);

    const started = await runtime.agentTasks.start({
      agentId: 'external:runtime-reference',
      objective: 'Run reference',
      context: { actorId: 'runtime-host', parentTaskId: 'parent-1' },
    });
    const completed = await runtime.agentTasks.wait(started.taskId, 1_000);
    expect(completed).toMatchObject({ state: 'completed', output: 'runtime-ok' });
    expect((await runtime.agentTasks.events(started.taskId, 0)).length).toBeGreaterThan(0);
    await runtime.close();

    const reopened = await createKodaXRuntime({
      homeDir,
      externalAgents: externalAgentOptions(),
    });
    expect(await reopened.admin.agentRegistrations.list()).toHaveLength(1);
    expect(await reopened.agentTasks.get(started.taskId)).toMatchObject({
      state: 'completed',
      output: 'runtime-ok',
    });
    await reopened.close();
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
    const dispatcher = createRuntimeDaemonDispatcher({ runtime: host });
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

    await daemon.admin.agentRegistrations.upsert(registration());
    expect(daemon.agents.enabled).toBe(true);
    expect((await daemon.agents.listDispatchable({ actorId: 'daemon-host' }))
      .map((entry) => entry.descriptor.agentId)).toContain('external:runtime-reference');
    const started = await daemon.agentTasks.start({
      agentId: 'external:runtime-reference',
      objective: 'Run through daemon',
      context: { actorId: 'daemon-host', parentTaskId: 'daemon-parent' },
    });
    expect(await daemon.agentTasks.wait(started.taskId, 1_000)).toMatchObject({
      state: 'completed',
      output: 'runtime-ok',
      parentTaskId: 'daemon-parent',
    });
    expect(await daemon.agentTasks.events(started.taskId)).not.toHaveLength(0);

    dispatcher.close();
    await daemon.close();
    await host.close();
  });
});
