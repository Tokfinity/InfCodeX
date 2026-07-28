import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { LearnedAreaStore } from './learned-area-store.js';
import {
  admitLearnedSkillBinding,
  commitLearnedSkillRevision,
  completeLearnedSkillOutcome,
  createLearnedCapabilityScope,
  releaseLearnedSkillBinding,
  type DeclarativeSkillSpec,
} from './learned-skill.js';
import {
  admitAndRecordLearnedSkillInvocation,
  completeLearnedSkillSessionOutcomes,
  exactInvokedSkillSnapshotForSession,
  listLearnedSkillUsageReceipts,
  reconcileLearnedSkillBindingOutcomes,
  recordLearnedSkillOffered,
} from './learned-skill-usage.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  readonly store: LearnedAreaStore;
  readonly capabilityId: string;
  readonly revision: number;
  readonly fingerprint: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'kodax-skill-usage-'));
  roots.push(root);
  const store = new LearnedAreaStore(root);
  await store.initialize();
  const spec: DeclarativeSkillSpec = {
    name: 'verify-release',
    description: 'Use when validating this project before a release.',
    purpose: 'Verify release state from reproducible evidence.',
    triggers: ['A release candidate needs verification.'],
    steps: ['Run the release test suite.'],
    verification: ['Require a passing check artifact.'],
    pitfalls: ['Do not treat self-report as verification.'],
  };
  const record = await commitLearnedSkillRevision(store, {
    scope: createLearnedCapabilityScope(root, {
      tenantId: 'tenant-a',
      projectId: 'project-a',
    }),
    spec,
    disposition: 'project_canary',
    operation: 'create',
    provenance: {
      jobId: 'job-1',
      inputHash: 'a'.repeat(64),
      decisionId: 'decision-1',
      actionId: 'action-1',
    },
  });
  await admitLearnedSkillBinding(store, record.capabilityId, {
    bindingId: 'binding-a',
    ownerSessionRef: 'owner-a',
  });
  return {
    store,
    capabilityId: record.capabilityId,
    revision: record.artifact.contentRevision,
    fingerprint: record.artifact.fingerprint,
  };
}

async function findUsageReceiptFile(
  store: LearnedAreaStore,
  kind: string,
): Promise<{ readonly path: string; readonly value: Record<string, unknown> }> {
  for (const sessionDir of await readdir(join(store.paths.root, 'usage'))) {
    const root = join(store.paths.root, 'usage', sessionDir);
    for (const file of await readdir(root)) {
      const filePath = join(root, file);
      const value: unknown = JSON.parse(await readFile(filePath, 'utf8'));
      if (typeof value === 'object'
        && value !== null
        && 'kind' in value
        && value.kind === kind) {
        return { path: filePath, value: { ...value } };
      }
    }
  }
  throw new Error(`expected ${kind} usage receipt`);
}

describe('FEATURE_263 exact learned Skill usage attribution', () => {
  it('keeps offered separate from invocation and snapshots only exact invoked content', async () => {
    const item = await fixture();
    await recordLearnedSkillOffered(item.store, {
      sessionId: 'session-a',
      bindingId: 'binding-a',
      capabilityId: item.capabilityId,
      revision: item.revision,
      fingerprint: item.fingerprint,
    });

    expect(await exactInvokedSkillSnapshotForSession(item.store, 'session-a')).toBeNull();

    const invoked = await admitAndRecordLearnedSkillInvocation(item.store, {
      sessionId: 'session-a',
      ownerSessionRef: 'owner-a',
      bindingId: 'binding-a',
      capabilityId: item.capabilityId,
      expectedRevision: item.revision,
      expectedFingerprint: item.fingerprint,
      invocationId: 'invoke-a',
    });
    expect(invoked.kind).toBe('invoked');
    expect(await exactInvokedSkillSnapshotForSession(item.store, 'session-a')).toMatchObject({
      capabilityId: item.capabilityId,
      revision: 1,
      fingerprint: item.fingerprint,
      invocationId: 'invoke-a',
    });
  });

  it('rejects an invocation receipt when the content revision no longer matches', async () => {
    const item = await fixture();
    await admitAndRecordLearnedSkillInvocation(item.store, {
      sessionId: 'session-a',
      ownerSessionRef: 'owner-a',
      bindingId: 'binding-a',
      capabilityId: item.capabilityId,
      expectedRevision: item.revision,
      expectedFingerprint: item.fingerprint,
      invocationId: 'invoke-a',
    });
    const current = await item.store.readCapability(item.capabilityId);
    if (current?.schemaVersion !== 2) throw new Error('expected v2 learned Skill fixture');
    await item.store.writeCapability({
      ...current,
      artifact: {
        ...current.artifact,
        contentRevision: current.artifact.contentRevision + 1,
      },
    });

    await expect(exactInvokedSkillSnapshotForSession(item.store, 'session-a'))
      .resolves.toBeNull();
  });

  it('permits all three exact content-revision invocations and promotes only from verified evidence', async () => {
    const item = await fixture();
    for (let index = 1; index <= 3; index += 1) {
      await admitAndRecordLearnedSkillInvocation(item.store, {
        sessionId: 'session-a',
        ownerSessionRef: 'owner-a',
        bindingId: 'binding-a',
        capabilityId: item.capabilityId,
        expectedRevision: item.revision,
        expectedFingerprint: item.fingerprint,
        invocationId: `invoke-${index}`,
      });
    }
    await completeLearnedSkillSessionOutcomes(item.store, {
      sessionId: 'session-a',
      outcome: 'verified_success',
      evidenceRefs: ['artifact:check-1'],
    });

    expect(await item.store.readCapability(item.capabilityId)).toMatchObject({
      lifecycle: 'active_learned',
      canary: { invocationCount: 3, verifiedSuccesses: 3 },
    });
    expect((await listLearnedSkillUsageReceipts(item.store, 'session-a'))
      .filter((receipt) => receipt.kind === 'outcome')).toHaveLength(3);
  });

  it('attributes snapshots and outcomes to the exact root binding within one session', async () => {
    const item = await fixture();
    await admitAndRecordLearnedSkillInvocation(item.store, {
      sessionId: 'session-a',
      ownerSessionRef: 'owner-a',
      bindingId: 'binding-a',
      capabilityId: item.capabilityId,
      expectedRevision: item.revision,
      expectedFingerprint: item.fingerprint,
      invocationId: 'invoke-a',
    });
    await completeLearnedSkillSessionOutcomes(item.store, {
      sessionId: 'session-a',
      bindingId: 'binding-a',
      outcome: 'verified_success',
      evidenceRefs: ['artifact:check-a'],
    });
    await releaseLearnedSkillBinding(item.store, item.capabilityId, 'binding-a');
    await admitLearnedSkillBinding(item.store, item.capabilityId, {
      bindingId: 'binding-b',
      ownerSessionRef: 'owner-b',
    });
    await admitAndRecordLearnedSkillInvocation(item.store, {
      sessionId: 'session-a',
      ownerSessionRef: 'owner-b',
      bindingId: 'binding-b',
      capabilityId: item.capabilityId,
      expectedRevision: item.revision,
      expectedFingerprint: item.fingerprint,
      invocationId: 'invoke-b',
    });

    await expect(exactInvokedSkillSnapshotForSession(item.store, 'session-a', {
      bindingId: 'binding-a',
    })).resolves.toMatchObject({ invocationId: 'invoke-a' });
    await expect(exactInvokedSkillSnapshotForSession(item.store, 'session-a', {
      bindingId: 'binding-b',
    })).resolves.toMatchObject({ invocationId: 'invoke-b' });

    await completeLearnedSkillSessionOutcomes(item.store, {
      sessionId: 'session-a',
      bindingId: 'binding-b',
      outcome: 'credible_negative',
      evidenceRefs: ['artifact:check-b'],
    });
    const outcomes = (await listLearnedSkillUsageReceipts(item.store, 'session-a'))
      .filter((receipt) => receipt.kind === 'outcome');
    expect(outcomes).toMatchObject([
      { invocationId: 'invoke-a', outcome: 'verified_success' },
      { invocationId: 'invoke-b', outcome: 'credible_negative' },
    ]);
  });

  it('keeps a release-recovered inconclusive outcome stable on delivery retry', async () => {
    const item = await fixture();
    await admitAndRecordLearnedSkillInvocation(item.store, {
      sessionId: 'session-a',
      ownerSessionRef: 'owner-a',
      bindingId: 'binding-a',
      capabilityId: item.capabilityId,
      expectedRevision: item.revision,
      expectedFingerprint: item.fingerprint,
      invocationId: 'invoke-a',
    });
    await releaseLearnedSkillBinding(item.store, item.capabilityId, 'binding-a');

    await completeLearnedSkillSessionOutcomes(item.store, {
      sessionId: 'session-a',
      bindingId: 'binding-a',
      outcome: 'verified_success',
      evidenceRefs: ['artifact:late-retry'],
    });

    expect(await item.store.readCapability(item.capabilityId)).toMatchObject({
      lifecycle: 'testing',
      canary: {
        verifiedSuccesses: 0,
        invocations: [{ invocationId: 'invoke-a', status: 'inconclusive' }],
      },
    });
    expect((await listLearnedSkillUsageReceipts(item.store, 'session-a'))
      .filter((receipt) => receipt.kind === 'outcome')).toMatchObject([
      { invocationId: 'invoke-a', outcome: 'inconclusive' },
    ]);
  });

  it('uses the canonical evidence and completion time for a late outcome delivery retry', async () => {
    const item = await fixture();
    await admitAndRecordLearnedSkillInvocation(item.store, {
      sessionId: 'session-a',
      ownerSessionRef: 'owner-a',
      bindingId: 'binding-a',
      capabilityId: item.capabilityId,
      expectedRevision: item.revision,
      expectedFingerprint: item.fingerprint,
      invocationId: 'invoke-a',
    });
    await completeLearnedSkillOutcome(item.store, item.capabilityId, {
      invocationId: 'invoke-a',
      outcome: 'verified_success',
      evidenceRefs: ['artifact:canonical'],
      now: '2026-07-27T01:00:00.000Z',
    });

    await completeLearnedSkillSessionOutcomes(item.store, {
      sessionId: 'session-a',
      bindingId: 'binding-a',
      outcome: 'credible_negative',
      evidenceRefs: ['artifact:late-retry'],
      now: '2026-07-27T02:00:00.000Z',
    });

    expect((await listLearnedSkillUsageReceipts(item.store, 'session-a'))
      .filter((receipt) => receipt.kind === 'outcome')).toMatchObject([{
      invocationId: 'invoke-a',
      outcome: 'verified_success',
      evidenceRefs: ['artifact:canonical'],
      createdAt: '2026-07-27T01:00:00.000Z',
    }]);
  });

  it('recovers the previous binding outcome after its lease expires', async () => {
    const item = await fixture();
    const invokedAt = new Date();
    await admitAndRecordLearnedSkillInvocation(item.store, {
      sessionId: 'session-a',
      ownerSessionRef: 'owner-a',
      bindingId: 'binding-a',
      capabilityId: item.capabilityId,
      expectedRevision: item.revision,
      expectedFingerprint: item.fingerprint,
      invocationId: 'invoke-a',
      now: invokedAt,
    });
    await admitLearnedSkillBinding(item.store, item.capabilityId, {
      bindingId: 'binding-b',
      ownerSessionRef: 'owner-b',
      now: new Date(invokedAt.getTime() + 10 * 60_000),
    });

    await reconcileLearnedSkillBindingOutcomes(item.store, {
      sessionId: 'session-b',
      bindingId: 'binding-b',
      now: new Date(invokedAt.getTime() + 10 * 60_000).toISOString(),
    });

    expect((await listLearnedSkillUsageReceipts(item.store, 'session-a'))
      .filter((receipt) => receipt.kind === 'outcome')).toMatchObject([{
      invocationId: 'invoke-a',
      outcome: 'inconclusive',
      evidenceRefs: ['host:learned-skill-binding-expired'],
    }]);
  });

  it('does not settle a pending invocation owned by another live binding', async () => {
    const item = await fixture();
    await admitAndRecordLearnedSkillInvocation(item.store, {
      sessionId: 'session-a',
      ownerSessionRef: 'owner-a',
      bindingId: 'binding-a',
      capabilityId: item.capabilityId,
      expectedRevision: item.revision,
      expectedFingerprint: item.fingerprint,
      invocationId: 'invoke-a',
    });

    await reconcileLearnedSkillBindingOutcomes(item.store, {
      sessionId: 'session-b',
      bindingId: 'binding-b',
    });

    expect(await item.store.readCapability(item.capabilityId)).toMatchObject({
      canary: { invocations: [{ invocationId: 'invoke-a', status: 'pending' }] },
    });
    expect((await listLearnedSkillUsageReceipts(item.store, 'session-a'))
      .filter((receipt) => receipt.kind === 'outcome')).toEqual([]);
  });

  it('backfills an expired binding without settling the replacement binding', async () => {
    const item = await fixture();
    const invokedAt = new Date();
    await admitAndRecordLearnedSkillInvocation(item.store, {
      sessionId: 'session-a',
      ownerSessionRef: 'owner-a',
      bindingId: 'binding-a',
      capabilityId: item.capabilityId,
      expectedRevision: item.revision,
      expectedFingerprint: item.fingerprint,
      invocationId: 'invoke-a',
      now: invokedAt,
    });
    const replacementAt = new Date(invokedAt.getTime() + 10 * 60_000);
    await admitLearnedSkillBinding(item.store, item.capabilityId, {
      bindingId: 'binding-b',
      ownerSessionRef: 'owner-b',
      now: replacementAt,
    });
    await admitAndRecordLearnedSkillInvocation(item.store, {
      sessionId: 'session-b',
      ownerSessionRef: 'owner-b',
      bindingId: 'binding-b',
      capabilityId: item.capabilityId,
      expectedRevision: item.revision,
      expectedFingerprint: item.fingerprint,
      invocationId: 'invoke-b',
      now: replacementAt,
    });

    await reconcileLearnedSkillBindingOutcomes(item.store, {
      sessionId: 'session-a',
      bindingId: 'binding-a',
      now: replacementAt.toISOString(),
    });

    expect(await item.store.readCapability(item.capabilityId)).toMatchObject({
      canary: {
        invocations: [
          { invocationId: 'invoke-a', status: 'inconclusive' },
          { invocationId: 'invoke-b', status: 'pending' },
        ],
      },
    });
    expect((await listLearnedSkillUsageReceipts(item.store, 'session-b'))
      .filter((receipt) => receipt.kind === 'outcome')).toEqual([]);
  });

  it('reconciles one binding when an unrelated usage receipt is corrupt', async () => {
    const item = await fixture();
    await admitAndRecordLearnedSkillInvocation(item.store, {
      sessionId: 'session-a',
      ownerSessionRef: 'owner-a',
      bindingId: 'binding-a',
      capabilityId: item.capabilityId,
      expectedRevision: item.revision,
      expectedFingerprint: item.fingerprint,
      invocationId: 'invoke-a',
    });
    const usageRoot = join(item.store.paths.root, 'usage');
    const [sessionDir] = await readdir(usageRoot);
    if (sessionDir === undefined) throw new Error('expected usage session directory');
    const corruptPath = join(usageRoot, sessionDir, 'corrupt.json');
    await writeFile(corruptPath, '{', 'utf8');

    await expect(completeLearnedSkillSessionOutcomes(item.store, {
      sessionId: 'session-a',
      bindingId: 'binding-a',
      outcome: 'verified_success',
      evidenceRefs: ['artifact:check-a'],
    })).rejects.toThrow();

    await reconcileLearnedSkillBindingOutcomes(item.store, {
      sessionId: 'session-a',
      bindingId: 'binding-a',
    });
    await releaseLearnedSkillBinding(item.store, item.capabilityId, 'binding-a');
    await rm(corruptPath);

    expect(await item.store.readCapability(item.capabilityId)).toMatchObject({
      canary: {
        invocations: [{
          invocationId: 'invoke-a',
          status: 'inconclusive',
          evidenceRefs: ['host:learned-skill-binding-release'],
        }],
      },
    });
    expect((await listLearnedSkillUsageReceipts(item.store, 'session-a'))
      .filter((receipt) => receipt.kind === 'outcome')).toMatchObject([{
      invocationId: 'invoke-a',
      outcome: 'inconclusive',
      evidenceRefs: ['host:learned-skill-binding-release'],
    }]);
  });

  it('recovers an active learned invocation when a sibling receipt is corrupt', async () => {
    const item = await fixture();
    for (let index = 1; index <= 3; index += 1) {
      await admitAndRecordLearnedSkillInvocation(item.store, {
        sessionId: 'session-a',
        ownerSessionRef: 'owner-a',
        bindingId: 'binding-a',
        capabilityId: item.capabilityId,
        expectedRevision: item.revision,
        expectedFingerprint: item.fingerprint,
        invocationId: `canary-${index}`,
      });
    }
    await completeLearnedSkillSessionOutcomes(item.store, {
      sessionId: 'session-a',
      bindingId: 'binding-a',
      outcome: 'verified_success',
      evidenceRefs: ['artifact:canary-check'],
    });
    await admitAndRecordLearnedSkillInvocation(item.store, {
      sessionId: 'session-b',
      ownerSessionRef: 'owner-b',
      bindingId: 'binding-b',
      capabilityId: item.capabilityId,
      expectedRevision: item.revision,
      expectedFingerprint: item.fingerprint,
      invocationId: 'active-invoke',
    });
    const usageRoot = join(item.store.paths.root, 'usage');
    const sessionDirs = await readdir(usageRoot);
    const receiptsBySession = await Promise.all(sessionDirs.map(async (name) => ({
      name,
      bodies: await Promise.all((await readdir(join(usageRoot, name))).map(
        (file) => readFile(join(usageRoot, name, file), 'utf8'),
      )),
    })));
    const sessionBDir = receiptsBySession.find((entry) => (
      entry.bodies.some((body) => body.includes('"invocationId": "active-invoke"'))
    ))?.name;
    if (sessionBDir === undefined) throw new Error('expected active invocation receipt');
    const corruptPath = join(usageRoot, sessionBDir, 'corrupt.json');
    await writeFile(corruptPath, '{', 'utf8');

    await expect(completeLearnedSkillSessionOutcomes(item.store, {
      sessionId: 'session-b',
      bindingId: 'binding-b',
      outcome: 'verified_success',
      evidenceRefs: ['artifact:active-check'],
    })).rejects.toThrow();
    await reconcileLearnedSkillBindingOutcomes(item.store, {
      sessionId: 'session-b',
      bindingId: 'binding-b',
    });
    await rm(corruptPath);

    expect((await listLearnedSkillUsageReceipts(item.store, 'session-b'))
      .filter((receipt) => receipt.kind === 'outcome')).toMatchObject([{
      invocationId: 'active-invoke',
      outcome: 'inconclusive',
      evidenceRefs: ['host:learned-skill-binding-release'],
    }]);
  });

  it('rejects a target invocation receipt whose immutable identity is not derived', async () => {
    const item = await fixture();
    for (let index = 1; index <= 3; index += 1) {
      await admitAndRecordLearnedSkillInvocation(item.store, {
        sessionId: 'session-a',
        ownerSessionRef: 'owner-a',
        bindingId: 'binding-a',
        capabilityId: item.capabilityId,
        expectedRevision: item.revision,
        expectedFingerprint: item.fingerprint,
        invocationId: `canary-${index}`,
      });
    }
    await completeLearnedSkillSessionOutcomes(item.store, {
      sessionId: 'session-a',
      bindingId: 'binding-a',
      outcome: 'verified_success',
      evidenceRefs: ['artifact:canary-check'],
    });
    const offered = await recordLearnedSkillOffered(item.store, {
      sessionId: 'session-forged',
      bindingId: 'binding-forged',
      capabilityId: item.capabilityId,
      revision: item.revision,
      fingerprint: item.fingerprint,
    });
    const forgedPath = join(
      item.store.paths.root,
      'usage',
      offered.sessionHash,
      'not-derived.json',
    );
    await writeFile(forgedPath, `${JSON.stringify({
      version: 1,
      kind: 'invoked',
      receiptId: 'not-derived',
      sessionHash: offered.sessionHash,
      bindingId: 'binding-forged',
      invocationId: 'never-happened',
      capabilityId: item.capabilityId,
      revision: item.revision,
      fingerprint: item.fingerprint,
      createdAt: new Date().toISOString(),
    })}\n`, 'utf8');

    await expect(reconcileLearnedSkillBindingOutcomes(item.store, {
      sessionId: 'session-forged',
      bindingId: 'binding-forged',
    })).rejects.toThrow('invocation receipt identity is invalid');
  });

  it('rejects an exact outcome receipt whose immutable canonical identity drifted', async () => {
    const item = await fixture();
    await admitAndRecordLearnedSkillInvocation(item.store, {
      sessionId: 'session-a',
      ownerSessionRef: 'owner-a',
      bindingId: 'binding-a',
      capabilityId: item.capabilityId,
      expectedRevision: item.revision,
      expectedFingerprint: item.fingerprint,
      invocationId: 'invoke-a',
    });
    await completeLearnedSkillSessionOutcomes(item.store, {
      sessionId: 'session-a',
      bindingId: 'binding-a',
      outcome: 'inconclusive',
      evidenceRefs: ['artifact:canonical'],
      now: '2026-07-27T01:00:00.000Z',
    });
    const outcome = await findUsageReceiptFile(item.store, 'outcome');
    await writeFile(outcome.path, `${JSON.stringify({
      ...outcome.value,
      invocationId: 'wrong-invocation',
      capabilityId: 'wrong-capability',
    })}\n`, 'utf8');

    await expect(reconcileLearnedSkillBindingOutcomes(item.store, {
      sessionId: 'session-a',
      bindingId: 'binding-a',
    })).rejects.toThrow('outcome receipt drifted from canonical invocation');
  });

  it('rejects an exact terminal outcome receipt whose canonical completion time drifted', async () => {
    const item = await fixture();
    await admitAndRecordLearnedSkillInvocation(item.store, {
      sessionId: 'session-a',
      ownerSessionRef: 'owner-a',
      bindingId: 'binding-a',
      capabilityId: item.capabilityId,
      expectedRevision: item.revision,
      expectedFingerprint: item.fingerprint,
      invocationId: 'invoke-a',
    });
    await completeLearnedSkillSessionOutcomes(item.store, {
      sessionId: 'session-a',
      bindingId: 'binding-a',
      outcome: 'inconclusive',
      evidenceRefs: ['artifact:canonical'],
      now: '2026-07-27T01:00:00.000Z',
    });
    const outcome = await findUsageReceiptFile(item.store, 'outcome');
    await writeFile(outcome.path, `${JSON.stringify({
      ...outcome.value,
      createdAt: '2026-07-27T02:00:00.000Z',
    })}\n`, 'utf8');

    await expect(reconcileLearnedSkillBindingOutcomes(item.store, {
      sessionId: 'session-a',
      bindingId: 'binding-a',
    })).rejects.toThrow('outcome receipt drifted from canonical invocation');
  });

  it('fails closed when a terminal canonical invocation lost its completion time', async () => {
    const item = await fixture();
    await admitAndRecordLearnedSkillInvocation(item.store, {
      sessionId: 'session-a',
      ownerSessionRef: 'owner-a',
      bindingId: 'binding-a',
      capabilityId: item.capabilityId,
      expectedRevision: item.revision,
      expectedFingerprint: item.fingerprint,
      invocationId: 'invoke-a',
    });
    await completeLearnedSkillSessionOutcomes(item.store, {
      sessionId: 'session-a',
      bindingId: 'binding-a',
      outcome: 'inconclusive',
      evidenceRefs: ['artifact:canonical'],
      now: '2026-07-27T01:00:00.000Z',
    });
    const record = await item.store.readCapability(item.capabilityId);
    if (record?.schemaVersion !== 2) throw new Error('expected learned capability v2');
    const capabilityPath = join(
      item.store.paths.root,
      'projects',
      record.scope.tenantHash,
      record.scope.projectHash,
      'capabilities',
      `${record.capabilityId}.json`,
    );
    const withoutCompletion = JSON.stringify(record).replace(
      /,"completedAt":"[^"]+"/,
      '',
    );
    await writeFile(capabilityPath, `${withoutCompletion}\n`, 'utf8');

    await expect(reconcileLearnedSkillBindingOutcomes(item.store, {
      sessionId: 'session-a',
      bindingId: 'binding-a',
    })).rejects.toThrow('invalid capability record');
  });

  it('does not invent an outcome receipt time when canonical completion time is missing', async () => {
    const item = await fixture();
    await admitAndRecordLearnedSkillInvocation(item.store, {
      sessionId: 'session-a',
      ownerSessionRef: 'owner-a',
      bindingId: 'binding-a',
      capabilityId: item.capabilityId,
      expectedRevision: item.revision,
      expectedFingerprint: item.fingerprint,
      invocationId: 'invoke-a',
    });
    await completeLearnedSkillSessionOutcomes(item.store, {
      sessionId: 'session-a',
      bindingId: 'binding-a',
      outcome: 'inconclusive',
      evidenceRefs: ['artifact:canonical'],
      now: '2026-07-27T01:00:00.000Z',
    });
    const outcome = await findUsageReceiptFile(item.store, 'outcome');
    await rm(outcome.path);
    const record = await item.store.readCapability(item.capabilityId);
    if (record?.schemaVersion !== 2) throw new Error('expected learned capability v2');
    const capabilityPath = join(
      item.store.paths.root,
      'projects',
      record.scope.tenantHash,
      record.scope.projectHash,
      'capabilities',
      `${record.capabilityId}.json`,
    );
    const withoutCompletion = JSON.stringify(record).replace(
      /,"completedAt":"[^"]+"/,
      '',
    );
    await writeFile(capabilityPath, `${withoutCompletion}\n`, 'utf8');

    await expect(reconcileLearnedSkillBindingOutcomes(item.store, {
      sessionId: 'session-a',
      bindingId: 'binding-a',
      now: '2026-07-27T03:00:00.000Z',
    })).rejects.toThrow('invalid capability record');
    await expect(findUsageReceiptFile(item.store, 'outcome')).rejects.toThrow(
      'expected outcome usage receipt',
    );
  });
});
