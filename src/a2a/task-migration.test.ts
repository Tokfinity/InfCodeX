import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  A2A_PRINCIPAL_KEY_SCHEME,
  legacyA2APrincipalKey,
  realmA2APrincipalKey,
} from './principal-key.js';
import { migrateA2ALegacyTaskOwners } from './task-migration.js';
import { A2AFileTaskStore } from './task-store.js';

const roots: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-a2a-task-migration-'));
  roots.push(root);
  return root;
}

function record(taskId: string, principalKey: string): Readonly<Record<string, unknown>> {
  const timestamp = '2026-07-16T00:00:00.000Z';
  const message = {
    messageId: `message-${taskId}`,
    taskId,
    contextId: `context-${taskId}`,
    role: 'ROLE_USER',
    parts: [{ text: taskId }],
  };
  return {
    taskId,
    contextId: `context-${taskId}`,
    principalKey,
    runtimeIdentity: 'legacy-runtime',
    sessionId: `session-${taskId}`,
    messageDigests: { [message.messageId]: `digest-${taskId}` },
    runIds: [],
    task: {
      id: taskId,
      contextId: `context-${taskId}`,
      status: { state: 'TASK_STATE_COMPLETED', timestamp },
      history: [message],
    },
    history: [message],
    createdAt: timestamp,
    updatedAt: timestamp,
    eventSeq: 1,
    runtimeEventCount: 0,
    runtimeEventBytes: 0,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('A2A legacy task owner migration', () => {
  it('dry-runs byte-preservingly, then atomically rekeys exact legacy owners', () => {
    const root = temporaryRoot();
    const file = path.join(root, 'tasks.json');
    const mapping = {
      subject: 'configured-client',
      securityRealm: 'bearer-env:KODAX_A2A_TOKEN',
    } as const;
    const legacyKey = legacyA2APrincipalKey(mapping);
    const currentKey = realmA2APrincipalKey(mapping);
    const original = `${JSON.stringify([
      record('legacy', legacyKey),
      record('current-unversioned', currentKey),
      record('unmapped', legacyA2APrincipalKey({ subject: 'other-client' })),
    ], null, 2)}\n`;
    fs.writeFileSync(file, original, { encoding: 'utf8', mode: 0o600 });

    const planned = migrateA2ALegacyTaskOwners({ dataDir: root, mappings: [mapping], apply: false });
    expect(planned).toMatchObject({
      applied: false,
      matchedLegacyTaskCount: 1,
      matchedCurrentTaskCount: 1,
      unmatchedUnversionedTaskCount: 1,
    });
    expect(fs.readFileSync(file, 'utf8')).toBe(original);

    const applied = migrateA2ALegacyTaskOwners({ dataDir: root, mappings: [mapping], apply: true });
    expect(applied).toMatchObject({
      applied: true,
      matchedLegacyTaskCount: 1,
      matchedCurrentTaskCount: 1,
      unmatchedUnversionedTaskCount: 1,
    });
    const migrated = JSON.parse(fs.readFileSync(file, 'utf8')) as Array<Record<string, unknown>>;
    expect(migrated.find((item) => item.taskId === 'legacy')).toMatchObject({
      principalKey: currentKey,
      principalKeyScheme: A2A_PRINCIPAL_KEY_SCHEME,
    });
    expect(migrated.find((item) => item.taskId === 'current-unversioned')).toMatchObject({
      principalKey: currentKey,
      principalKeyScheme: A2A_PRINCIPAL_KEY_SCHEME,
    });
    expect(migrated.find((item) => item.taskId === 'unmapped')).not.toHaveProperty('principalKeyScheme');

    expect(migrateA2ALegacyTaskOwners({ dataDir: root, mappings: [mapping], apply: true }))
      .toMatchObject({ matchedLegacyTaskCount: 0, matchedCurrentTaskCount: 0 });
  });

  it('rejects ambiguous legacy-owner claims and a live task-store owner', () => {
    const root = temporaryRoot();
    fs.writeFileSync(path.join(root, 'tasks.json'), '[]\n', 'utf8');
    expect(() => migrateA2ALegacyTaskOwners({
      dataDir: ' ', mappings: [{ subject: 'shared', securityRealm: 'test:realm' }], apply: false,
    })).toThrow(/dataDir/i);
    expect(() => migrateA2ALegacyTaskOwners({
      dataDir: root,
      mappings: [
        { subject: 'shared', securityRealm: 'oauth2-jwt:https://issuer-a.example' },
        { subject: 'shared', securityRealm: 'oauth2-jwt:https://issuer-b.example' },
      ],
      apply: false,
    })).toThrow(/ambiguous/i);

    const owner = new A2AFileTaskStore(root);
    try {
      expect(() => migrateA2ALegacyTaskOwners({
        dataDir: root,
        mappings: [{ subject: 'shared', securityRealm: 'oauth2-jwt:https://issuer-a.example' }],
        apply: true,
      })).toThrow(/already owned/i);
    } finally {
      owner.close();
    }
  });
});
