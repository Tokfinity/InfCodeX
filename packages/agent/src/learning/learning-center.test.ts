import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LearningCapabilityError,
  createLearningCenterService,
  getLearnedExtensionToolName,
  isLearnedExtensionCommandAllowed,
  projectLearningProposals,
  slugifyLearnedCapabilityName,
  type LearnedCapabilityRecord,
  type LearningActionDriver,
} from './index.js';
import { LearnedAreaStore } from './learned-area-store.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createArea(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kodax-learning-center-'));
  tempDirs.push(root);
  return root;
}

function candidate(
  overrides: Partial<LearnedCapabilityRecord> = {},
): LearnedCapabilityRecord {
  return {
    schemaVersion: 1,
    capabilityId: 'lc_release_notes',
    displayName: 'Normalize release notes',
    slug: 'normalize-release-notes',
    carrier: 'skill',
    lifecycle: 'ready',
    revision: 1,
    createdAt: '2026-07-17T00:00:00.000Z',
    updatedAt: '2026-07-17T00:00:00.000Z',
    source: { kind: 'learning_controller' },
    ...overrides,
  };
}

describe('Learning Center identity and lifecycle', () => {
  it('creates stable human-readable slugs and rejects empty names', () => {
    expect(slugifyLearnedCapabilityName('  Normalize release notes  ')).toBe('normalize-release-notes');
    expect(slugifyLearnedCapabilityName('Résumé / Review')).toBe('resume-review');
    expect(() => slugifyLearnedCapabilityName('---')).toThrow(/name/i);
  });

  it('persists state before its deterministic event and recovers a missing event', async () => {
    const rootDir = await createArea();
    const service = createLearningCenterService({
      rootDir,
      clientIdentity: 'cli-a',
      now: () => '2026-07-17T00:00:00.000Z',
    });

    await service.record(candidate());
    const eventPath = join(rootDir, 'events', 'lc_release_notes-r1-ready.json');
    await expect(readFile(eventPath, 'utf8')).resolves.toContain('"kind": "ready"');

    await unlink(eventPath);
    const restarted = createLearningCenterService({ rootDir, clientIdentity: 'cli-a' });
    await restarted.initialize();
    await expect(readFile(eventPath, 'utf8')).resolves.toContain('"capabilityRevision": 1');
  });

  it('keeps notification state client-local and separate from lifecycle', async () => {
    const rootDir = await createArea();
    const clientA = createLearningCenterService({ rootDir, clientIdentity: 'cli-a' });
    const clientB = createLearningCenterService({ rootDir, clientIdentity: 'ide-b' });
    await clientA.record(candidate());

    expect(await clientA.getSnapshot()).toMatchObject({ ready: 1, newlyActive: 0, attention: 0 });
    expect(await clientB.getSnapshot()).toMatchObject({ ready: 1, newlyActive: 0, attention: 0 });

    await clientA.acknowledge('normalize-release-notes');
    expect((await clientA.get('normalize-release-notes')).lifecycle).toBe('ready');
    expect((await clientA.getSnapshot()).ready).toBe(0);
    expect((await clientB.getSnapshot()).ready).toBe(1);
  });

  it('broadcasts owner events to other client facades without sharing cursors', async () => {
    const rootDir = await createArea();
    const clientA = createLearningCenterService({ rootDir, clientIdentity: 'cli-a' });
    const clientB = createLearningCenterService({ rootDir, clientIdentity: 'ide-b' });
    await Promise.all([clientA.initialize(), clientB.initialize()]);
    const iterator = clientB.subscribe()[Symbol.asyncIterator]();
    const nextEvent = iterator.next();
    await clientA.record(candidate());
    await expect(nextEvent).resolves.toMatchObject({
      done: false,
      value: { eventId: 'lc_release_notes-r1-ready' },
    });
    await iterator.return?.();
  });

  it('rechecks the durable cursor after registering a subscriber waiter', async () => {
    const rootDir = await createArea();
    const service = createLearningCenterService({ rootDir, clientIdentity: 'cli-a' });
    await service.initialize();
    const original = LearnedAreaStore.prototype.listEvents;
    let releaseFirstRead: (() => void) | undefined;
    let firstReadEntered: (() => void) | undefined;
    let reads = 0;
    const firstReadStarted = new Promise<void>((resolve) => { firstReadEntered = resolve; });
    const spy = vi.spyOn(LearnedAreaStore.prototype, 'listEvents').mockImplementation(async function () {
      reads += 1;
      const events = await original.call(this);
      if (reads === 1) {
        firstReadEntered?.();
        await new Promise<void>((resolve) => { releaseFirstRead = resolve; });
      }
      return events;
    });
    const iterator = service.subscribe()[Symbol.asyncIterator]();
    const nextEvent = iterator.next();
    await firstReadStarted;

    await service.record(candidate());
    releaseFirstRead?.();
    const outcome = await Promise.race([
      nextEvent.then((result) => ({ kind: 'event' as const, result })),
      new Promise<{ readonly kind: 'timeout' }>((resolve) => {
        setTimeout(() => resolve({ kind: 'timeout' }), 100);
      }),
    ]);
    if (outcome.kind === 'timeout') {
      await service.record(candidate({
        lifecycle: 'archived', revision: 2, updatedAt: '2026-07-17T00:01:00.000Z',
      }));
      await nextEvent;
    }
    await iterator.return?.();
    spy.mockRestore();

    expect(outcome).toMatchObject({
      kind: 'event',
      result: { done: false, value: { eventId: 'lc_release_notes-r1-ready' } },
    });
  });

  it('cancels a pending subscriber waiter when the iterator is returned', async () => {
    const rootDir = await createArea();
    const service = createLearningCenterService({ rootDir, clientIdentity: 'cli-a' });
    await service.initialize();
    const iterator = service.subscribe()[Symbol.asyncIterator]();
    const pending = iterator.next();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    const returned = await Promise.race([
      iterator.return?.().then(() => 'returned' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 100)),
    ]);

    expect(returned).toBe('returned');
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
  });

  it('serializes concurrent subscriber reads without delivering one event twice', async () => {
    const rootDir = await createArea();
    const service = createLearningCenterService({ rootDir, clientIdentity: 'cli-a' });
    await service.initialize();
    const iterator = service.subscribe()[Symbol.asyncIterator]();
    const first = iterator.next();
    const second = iterator.next();

    await service.record(candidate());
    await expect(first).resolves.toMatchObject({
      done: false,
      value: { eventId: 'lc_release_notes-r1-ready' },
    });
    await service.record(candidate({
      lifecycle: 'archived', revision: 2, updatedAt: '2026-07-17T00:01:00.000Z',
    }));

    await expect(second).resolves.toMatchObject({
      done: false,
      value: { eventId: 'lc_release_notes-r2-archived' },
    });
    await iterator.return?.();
  });

  it('refuses invalid lifecycle transitions without writing a new revision', async () => {
    const rootDir = await createArea();
    const service = createLearningCenterService({ rootDir, clientIdentity: 'cli-a' });
    await service.record(candidate({ lifecycle: 'rejected' }));

    await expect(service.disable('normalize-release-notes')).rejects.toMatchObject({
      code: 'invalid_transition',
    });
    expect((await service.get('normalize-release-notes')).revision).toBe(1);
  });

  it('serializes concurrent owner revisions and keeps a monotonic event cursor', async () => {
    const rootDir = await createArea();
    const clientA = createLearningCenterService({ rootDir, clientIdentity: 'cli-a' });
    const clientB = createLearningCenterService({ rootDir, clientIdentity: 'ide-b' });
    await clientA.record(candidate());
    const nextA = candidate({
      lifecycle: 'archived', revision: 2, updatedAt: '2026-07-17T00:01:00.000Z',
    });
    const nextB = candidate({
      lifecycle: 'rejected', revision: 2, updatedAt: '2026-07-17T00:01:00.000Z',
    });

    const writes = await Promise.allSettled([clientA.record(nextA), clientB.record(nextB)]);

    expect(writes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(writes.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await clientA.events()).map((event) => event.sequence)).toEqual([1, 2]);
    expect((await clientA.events(1)).map((event) => event.sequence)).toEqual([2]);
    expect((await clientA.getSnapshot()).revision).toBe(2);
  });

  it('resolves names and slugs while reporting ambiguous display names', async () => {
    const rootDir = await createArea();
    const service = createLearningCenterService({ rootDir, clientIdentity: 'cli-a' });
    await service.record(candidate());
    await service.record(candidate({
      capabilityId: 'lc_release_notes_2',
      slug: 'normalize-release-notes-2',
    }));

    await expect(service.get('Normalize release notes')).rejects.toMatchObject({ code: 'ambiguous_name' });
    expect((await service.get('normalize-release-notes-2')).capabilityId).toBe('lc_release_notes_2');
  });

  it('rejects duplicate stored slugs before they become ambiguous', async () => {
    const rootDir = await createArea();
    const service = createLearningCenterService({ rootDir, clientIdentity: 'cli-a' });
    await service.record(candidate());

    await expect(service.record(candidate({
      capabilityId: 'lc_release_notes_2',
    }))).rejects.toMatchObject({ code: 'invalid_record' });
  });

  it('fails unsupported carrier actions explicitly', async () => {
    const rootDir = await createArea();
    const service = createLearningCenterService({ rootDir, clientIdentity: 'cli-a' });
    await service.record(candidate());

    await expect(service.trust('normalize-release-notes')).rejects.toEqual(
      expect.objectContaining<Partial<LearningCapabilityError>>({ code: 'unsupported_action' }),
    );
    await expect(service.rollback('normalize-release-notes')).rejects.toMatchObject({
      code: 'unsupported_action',
    });
  });

  it('records rollback as attention without pretending it is a new activation', async () => {
    const rootDir = await createArea();
    const rollbackDriver: LearningActionDriver = {
      carrier: 'skill',
      actions: ['rollback'],
      async execute(_action, current) {
        return {
          ...current,
          revision: current.revision + 1,
          updatedAt: '2026-07-17T00:01:00.000Z',
          lastAction: 'rollback',
          previousGoodRevision: current.revision - 1,
        };
      },
    };
    const service = createLearningCenterService({
      rootDir,
      clientIdentity: 'cli-a',
      actionDrivers: [rollbackDriver],
    });
    await service.record(candidate({ lifecycle: 'active_learned' }));

    await service.rollback('normalize-release-notes');

    expect(await service.get('normalize-release-notes')).toMatchObject({
      lifecycle: 'active_learned',
      lastAction: 'rollback',
      revision: 2,
    });
    expect((await service.events()).at(-1)).toMatchObject({ kind: 'attention' });
    expect(await service.getSnapshot()).toMatchObject({ newlyActive: 0, attention: 1 });
  });
});

describe('Learning Center compatibility and policy', () => {
  it('projects F224 proposals without changing the proposal file', async () => {
    const rootDir = await createArea();
    const proposalPath = join(rootDir, 'proposals.json');
    const original = JSON.stringify({
      version: 1,
      proposals: [{
        proposalId: 'proposal_1',
        status: 'pending',
        createdAt: '2026-07-17T00:00:00.000Z',
        updatedAt: '2026-07-17T00:00:00.000Z',
        proposal: {
          proposalId: 'proposal_1',
          destination: 'skill_create',
          origin: 'background_learning',
          userLabel: 'method_guide',
          skillName: 'release-helper',
          whyDurable: 'Repeated release work.',
          trigger: 'Preparing a release.',
          changeSummary: 'Add release checks.',
          sourceTraceIds: ['trace_1'],
          confidence: 0.9,
        },
      }],
    }, null, 2);
    await writeFile(proposalPath, original, 'utf8');

    const projected = await projectLearningProposals(proposalPath);
    expect(projected.records).toHaveLength(1);
    expect(projected.records[0]).toMatchObject({
      displayName: 'release-helper',
      lifecycle: 'ready',
      source: { kind: 'f224_proposal', proposalId: 'proposal_1' },
    });
    expect(await readFile(proposalPath, 'utf8')).toBe(original);
  });

  it('gives projected F224 proposals collision-safe slugs', async () => {
    const rootDir = await createArea();
    const proposalPath = join(rootDir, 'proposals.json');
    const proposal = (proposalId: string) => ({
      proposalId,
      status: 'pending',
      createdAt: '2026-07-17T00:00:00.000Z',
      updatedAt: '2026-07-17T00:00:00.000Z',
      proposal: {
        proposalId, destination: 'skill_create', origin: 'background_learning',
        userLabel: 'method_guide', skillName: 'release-helper', whyDurable: 'Repeated release work.',
        trigger: 'Preparing a release.', changeSummary: 'Add release checks.',
        sourceTraceIds: ['trace_1'], confidence: 0.9,
      },
    });
    await writeFile(proposalPath, JSON.stringify({
      version: 1,
      proposals: [proposal('proposal_1'), proposal('proposal_2')],
    }), 'utf8');

    const projected = await projectLearningProposals(proposalPath);
    expect(new Set(projected.records.map((record) => record.slug)).size).toBe(2);
    expect(projected.records[0]?.slug).toBe('release-helper');
    expect(projected.records[1]?.slug).toMatch(/^release-helper-/);
  });

  it('routes a projected F224 rejection back through its owner store', async () => {
    const rootDir = await createArea();
    const proposalPath = join(rootDir, 'proposals.json');
    await writeFile(proposalPath, JSON.stringify({
      version: 1,
      proposals: [{
        proposalId: 'proposal_1',
        status: 'pending',
        createdAt: '2026-07-17T00:00:00.000Z',
        updatedAt: '2026-07-17T00:00:00.000Z',
        proposal: {
          proposalId: 'proposal_1', destination: 'skill_create', origin: 'background_learning',
          userLabel: 'method_guide', skillName: 'release-helper', whyDurable: 'Repeated release work.',
          trigger: 'Preparing a release.', changeSummary: 'Add release checks.',
          sourceTraceIds: ['trace_1'], confidence: 0.9,
        },
      }],
    }), 'utf8');
    const service = createLearningCenterService({
      rootDir: join(rootDir, 'learned'),
      clientIdentity: 'cli-a',
      proposalStores: [proposalPath],
    });

    await service.reject('release-helper');
    const proposalDocument = JSON.parse(await readFile(proposalPath, 'utf8')) as {
      proposals: Array<{ status: string }>;
    };
    expect(proposalDocument.proposals[0]?.status).toBe('rejected');
    expect((await service.get('release-helper')).lifecycle).toBe('rejected');
  });

  it('reserves deferred learned Extension tools and forbids slash commands', async () => {
    expect(getLearnedExtensionToolName('release-helper', 'normalize')).toBe(
      'learned.release-helper.normalize',
    );
    expect(isLearnedExtensionCommandAllowed('/release-helper')).toBe(false);
    expect(() => getLearnedExtensionToolName('../escape', 'run')).toThrow(/slug/i);
  });

  it('stores one capability per file', async () => {
    const rootDir = await createArea();
    await mkdir(join(rootDir, 'skills'), { recursive: true });
    const service = createLearningCenterService({ rootDir, clientIdentity: 'cli-a' });
    await service.record(candidate());

    const raw = await readFile(join(rootDir, 'capabilities', 'lc_release_notes.json'), 'utf8');
    expect(JSON.parse(raw)).toMatchObject({ capabilityId: 'lc_release_notes' });
  });
});
