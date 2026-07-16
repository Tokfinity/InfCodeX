import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  AgentTaskEvent,
  AgentTaskSnapshot,
  ExternalAgentRegistration,
} from '@kodax-ai/agent';
import { createRuntimeAgentExecutorPlaneStore } from './runtime-agent-store.js';

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe('FEATURE_258 Runtime agent store', () => {
  it('durably round-trips registrations, snapshots and append-only events', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-agent-store-'));
    const store = createRuntimeAgentExecutorPlaneStore(tempDir);
    const registration: ExternalAgentRegistration = {
      agentId: 'external:durable',
      displayName: 'Durable',
      enabled: true,
      executorId: 'reference-http',
      protocol: 'http',
      configurationRevision: 'rev-1',
      endpointIdentityHash: 'sha256:endpoint',
      credentialRef: 'credential:durable',
      capabilities: {
        streaming: 'supported',
        durableTasks: 'supported',
        inputRequired: 'supported',
        cancellation: 'supported',
        artifacts: 'supported',
      },
      effects: { remote: 'read', workspace: 'proposal' },
    };
    const task: AgentTaskSnapshot = {
      taskId: '../task/with:path',
      route: 'external',
      agentId: registration.agentId,
      objective: 'test',
      state: 'working',
      cancellation: 'none',
      registration: {
        agentId: registration.agentId,
        origin: 'external',
        executorId: registration.executorId,
        protocol: registration.protocol,
        configurationRevision: registration.configurationRevision,
        endpointIdentityHash: registration.endpointIdentityHash,
        capabilities: registration.capabilities,
        effects: registration.effects,
      },
      idempotencyKey: 'idem-1',
      dispatchAttempt: 1,
      createdAt: '2026-07-10T00:00:00.000Z',
      updatedAt: '2026-07-10T00:00:01.000Z',
      remoteTaskId: 'remote-1',
    };
    const event: AgentTaskEvent = {
      taskId: task.taskId,
      seq: 1,
      timestamp: task.updatedAt,
      type: 'state',
      state: 'working',
      cancellation: 'none',
    };

    await store.saveRegistrations([registration]);
    await store.saveTask(task);
    await store.appendEvent(event);

    const reopened = createRuntimeAgentExecutorPlaneStore(tempDir);
    expect(await reopened.loadRegistrations()).toEqual([registration]);
    expect(await reopened.loadTasks()).toEqual([task]);
    expect(await reopened.loadEvents(task.taskId)).toEqual([event]);
    const taskDirectory = createHash('sha256').update(task.taskId).digest('hex');
    expect(fs.readFileSync(
      path.join(tempDir, 'tasks', taskDirectory, 'events.jsonl'),
      'utf8',
    ).trim().split(/\r?\n/)).toHaveLength(1);
    expect(fs.existsSync(path.join(tempDir, 'snapshot.json'))).toBe(false);
  });
});
