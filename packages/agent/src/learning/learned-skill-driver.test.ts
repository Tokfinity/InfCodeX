import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createLearningCenterService } from './learning-center-service.js';
import { createLearnedSkillActionDriver } from './learned-skill-driver.js';
import {
  admitLearnedSkillBinding,
  commitLearnedSkillRevision,
  completeLearnedSkillOutcome,
  createLearnedCapabilityScope,
  invokeLearnedSkillCanary,
  quarantineLearnedSkillRevision,
  resolveProjectLearnedAreaRoot,
  type DeclarativeSkillSpec,
} from './learned-skill.js';
import { LearnedAreaStore } from './learned-area-store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  readonly rootDir: string;
  readonly userSkillsRoot: string;
  readonly store: LearnedAreaStore;
}> {
  const root = await mkdtemp(join(tmpdir(), 'kodax-learned-driver-'));
  roots.push(root);
  const rootDir = join(root, 'learned-project');
  const store = new LearnedAreaStore(rootDir);
  await store.initialize();
  return { rootDir, userSkillsRoot: join(root, 'user-skills'), store };
}

function spec(step: string): DeclarativeSkillSpec {
  return {
    name: 'verify-release',
    description: 'Use when validating this project before a release.',
    purpose: 'Verify release state from reproducible evidence.',
    triggers: ['A release candidate needs verification.'],
    steps: [step],
    verification: ['Require a passing check artifact.'],
    pitfalls: ['Do not treat model self-report as verification.'],
  };
}

describe('FEATURE_263 learned Skill action driver', () => {
  it('rolls the canonical record back to the exact previous immutable artifact', async () => {
    const area = await fixture();
    const initial = await commitLearnedSkillRevision(area.store, {
      scope: createLearnedCapabilityScope(area.rootDir, {
        tenantId: 'tenant-a',
        projectId: 'project-a',
      }),
      spec: spec('Run the release test suite.'),
      disposition: 'project_canary',
      operation: 'create',
      provenance: {
        jobId: 'job-1',
        inputHash: 'a'.repeat(64),
        decisionId: 'decision-1',
        actionId: 'action-1',
      },
    });
    const service = createLearningCenterService({
      rootDir: area.rootDir,
      clientIdentity: 'user-a',
      actionDrivers: [createLearnedSkillActionDriver({
        learnedAreaRoot: area.rootDir,
        learnedAreaKind: 'project',
        userSkillsRoot: area.userSkillsRoot,
      })],
    });
    await service.trust(initial.slug);
    const trusted = await service.get(initial.slug);
    const patched = await commitLearnedSkillRevision(area.store, {
      scope: initial.scope,
      spec: spec('Run tests and inspect the exact release diff.'),
      disposition: 'project_canary',
      operation: 'patch',
      targetCapabilityId: initial.capabilityId,
      expectedRevision: initial.artifact.contentRevision,
      expectedFingerprint: initial.artifact.fingerprint,
      provenance: {
        jobId: 'job-2',
        inputHash: 'b'.repeat(64),
        decisionId: 'decision-2',
        actionId: 'action-2',
      },
    });

    expect(patched.artifact.contentRevision).toBe(2);
    expect(patched.previousGoodArtifact).toEqual(trusted.artifact);
    await service.rollback(initial.slug);

    expect(await service.get(initial.slug)).toMatchObject({
      lifecycle: 'active_learned',
      lastAction: 'rollback',
      artifact: {
        contentRevision: 1,
        fingerprint: initial.artifact.fingerprint,
      },
      previousGoodArtifact: {
        contentRevision: 1,
        fingerprint: initial.artifact.fingerprint,
      },
    });

    await service.rollback(initial.slug);
    expect(await service.get(initial.slug)).toMatchObject({
      lifecycle: 'active_learned',
      lastAction: 'rollback',
      artifact: {
        contentRevision: 1,
        fingerprint: initial.artifact.fingerprint,
      },
      previousGoodArtifact: {
        contentRevision: 1,
        fingerprint: initial.artifact.fingerprint,
      },
    });
  });

  it('preserves the real previous-good artifact across canary activation and explicit trust', async () => {
    const area = await fixture();
    const scope = createLearnedCapabilityScope(area.rootDir, {
      tenantId: 'tenant-a',
      projectId: 'project-a',
    });
    const initial = await commitLearnedSkillRevision(area.store, {
      scope,
      spec: spec('Run the release test suite.'),
      disposition: 'project_canary',
      operation: 'create',
      provenance: {
        jobId: 'job-1',
        inputHash: 'a'.repeat(64),
        decisionId: 'decision-1',
        actionId: 'action-1',
      },
    });
    const service = createLearningCenterService({
      rootDir: area.rootDir,
      clientIdentity: 'user-a',
      actionDrivers: [createLearnedSkillActionDriver({
        learnedAreaRoot: area.rootDir,
        learnedAreaKind: 'project',
        userSkillsRoot: area.userSkillsRoot,
      })],
    });
    await service.trust(initial.capabilityId);

    const canary = await commitLearnedSkillRevision(area.store, {
      scope,
      spec: spec('Run tests and inspect the exact release diff.'),
      disposition: 'project_canary',
      operation: 'patch',
      targetCapabilityId: initial.capabilityId,
      expectedRevision: initial.artifact.contentRevision,
      expectedFingerprint: initial.artifact.fingerprint,
      provenance: {
        jobId: 'job-2',
        inputHash: 'b'.repeat(64),
        decisionId: 'decision-2',
        actionId: 'action-2',
      },
    });
    await admitLearnedSkillBinding(area.store, initial.capabilityId, {
      bindingId: 'binding-a',
      ownerSessionRef: 'session-a',
    });
    await invokeLearnedSkillCanary(area.store, initial.capabilityId, {
      bindingId: 'binding-a',
      invocationId: 'invocation-a',
    });
    await completeLearnedSkillOutcome(area.store, initial.capabilityId, {
      invocationId: 'invocation-a',
      outcome: 'verified_success',
      evidenceRefs: ['check:passed'],
    });
    expect(await area.store.readCapability(initial.capabilityId)).toMatchObject({
      previousGoodArtifact: { fingerprint: initial.artifact.fingerprint },
    });
    await quarantineLearnedSkillRevision(area.store, initial.capabilityId, {
      expectedRevision: canary.artifact.contentRevision,
      expectedFingerprint: canary.artifact.fingerprint,
      reason: 'verified regression',
    });
    await service.rollback(initial.capabilityId);
    expect(await service.get(initial.capabilityId)).toMatchObject({
      artifact: { fingerprint: initial.artifact.fingerprint },
    });

    const trustedPatch = await commitLearnedSkillRevision(area.store, {
      scope,
      spec: spec('Run tests, inspect the diff, and validate the package.'),
      disposition: 'project_canary',
      operation: 'patch',
      targetCapabilityId: initial.capabilityId,
      expectedRevision: initial.artifact.contentRevision,
      expectedFingerprint: initial.artifact.fingerprint,
      provenance: {
        jobId: 'job-3',
        inputHash: 'c'.repeat(64),
        decisionId: 'decision-3',
        actionId: 'action-3',
      },
    });
    await service.trust(initial.capabilityId);
    expect(await area.store.readCapability(initial.capabilityId)).toMatchObject({
      previousGoodArtifact: { fingerprint: initial.artifact.fingerprint },
    });
    await quarantineLearnedSkillRevision(area.store, initial.capabilityId, {
      expectedRevision: trustedPatch.artifact.contentRevision,
      expectedFingerprint: trustedPatch.artifact.fingerprint,
      reason: 'explicitly trusted revision regressed',
    });
    await service.rollback(initial.capabilityId);
    expect(await service.get(initial.capabilityId)).toMatchObject({
      artifact: { fingerprint: initial.artifact.fingerprint },
    });
  });

  it('promotes only the exact fingerprint to a non-overwriting user Skill', async () => {
    const area = await fixture();
    const created = await commitLearnedSkillRevision(area.store, {
      scope: createLearnedCapabilityScope(area.rootDir, {
        tenantId: 'tenant-a',
        projectId: 'project-a',
      }),
      spec: spec('Run the release test suite.'),
      disposition: 'ready',
      operation: 'create',
      provenance: {
        jobId: 'job-1',
        inputHash: 'a'.repeat(64),
        decisionId: 'decision-1',
        actionId: 'action-1',
      },
    });
    const service = createLearningCenterService({
      rootDir: area.rootDir,
      clientIdentity: 'user-a',
      actionDrivers: [createLearnedSkillActionDriver({
        learnedAreaRoot: area.rootDir,
        learnedAreaKind: 'project',
        userSkillsRoot: area.userSkillsRoot,
      })],
    });

    await service.promote(created.slug, 'user');

    expect(await service.get(created.slug)).toMatchObject({ lifecycle: 'promoted_user' });
    expect(await readFile(join(area.userSkillsRoot, created.slug, 'SKILL.md'), 'utf8'))
      .toContain('Run the release test suite.');
  });

  it('exposes project records through the global Learning Center owner', async () => {
    const configHome = await mkdtemp(join(tmpdir(), 'kodax-global-learning-'));
    roots.push(configHome);
    const globalRoot = join(configHome, 'learned');
    const projectRoot = resolveProjectLearnedAreaRoot(configHome, {
      tenantId: 'tenant-a',
      projectId: 'project-a',
    });
    const projectStore = new LearnedAreaStore(projectRoot);
    await projectStore.initialize();
    const created = await commitLearnedSkillRevision(projectStore, {
      scope: createLearnedCapabilityScope(configHome, {
        tenantId: 'tenant-a',
        projectId: 'project-a',
      }),
      spec: spec('Run the release test suite.'),
      disposition: 'ready',
      operation: 'create',
      provenance: {
        jobId: 'job-global',
        inputHash: 'c'.repeat(64),
        decisionId: 'decision-global',
        actionId: 'action-global',
      },
    });
    const service = createLearningCenterService({
      rootDir: globalRoot,
      clientIdentity: 'user-a',
      actionDrivers: [createLearnedSkillActionDriver({
        learnedAreaRoot: globalRoot,
        learnedAreaKind: 'global',
        userSkillsRoot: join(configHome, 'skills'),
      })],
    });
    await service.initialize();

    expect((await service.list()).items).toContainEqual(expect.objectContaining({
      capabilityId: created.capabilityId,
      slug: created.slug,
    }));
    await expect(service.disable(created.slug, {
      authority: 'explicit_user',
      expectedRevision: created.revision + 1,
      expectedFingerprint: created.artifact.fingerprint,
    })).rejects.toThrow(/expected revision or fingerprint changed/i);
    await service.promote(created.slug, 'user');
    expect(await projectStore.readCapability(created.capabilityId)).toMatchObject({
      lifecycle: 'promoted_user',
    });
  });

  it('requires capabilityId when the same slug exists in multiple projects', async () => {
    const configHome = await mkdtemp(join(tmpdir(), 'kodax-global-ambiguous-learning-'));
    roots.push(configHome);
    const globalRoot = join(configHome, 'learned');
    const createProjectRecord = async (projectId: string, actionId: string) => {
      const projectRoot = resolveProjectLearnedAreaRoot(configHome, {
        tenantId: 'tenant-a',
        projectId,
      });
      const projectStore = new LearnedAreaStore(projectRoot);
      await projectStore.initialize();
      return {
        projectStore,
        record: await commitLearnedSkillRevision(projectStore, {
          scope: createLearnedCapabilityScope(configHome, {
            tenantId: 'tenant-a',
            projectId,
          }),
          spec: spec('Run the release test suite.'),
          disposition: 'ready',
          operation: 'create',
          provenance: {
            jobId: `job-${projectId}`,
            inputHash: actionId.repeat(64).slice(0, 64),
            decisionId: `decision-${projectId}`,
            actionId,
          },
        }),
      };
    };
    const first = await createProjectRecord('project-a', 'a');
    const second = await createProjectRecord('project-b', 'b');
    const service = createLearningCenterService({
      rootDir: globalRoot,
      clientIdentity: 'user-a',
      actionDrivers: [createLearnedSkillActionDriver({
        learnedAreaRoot: globalRoot,
        learnedAreaKind: 'global',
        userSkillsRoot: join(configHome, 'skills'),
      })],
    });
    await service.initialize();

    await expect(service.get('verify-release')).rejects.toMatchObject({
      code: 'ambiguous_name',
    });
    expect((await service.get(second.record.capabilityId)).capabilityId)
      .toBe(second.record.capabilityId);
    await service.disable(second.record.capabilityId);
    expect(await second.projectStore.readCapability(second.record.capabilityId))
      .toMatchObject({ lifecycle: 'archived' });
    expect(await first.projectStore.readCapability(first.record.capabilityId))
      .toMatchObject({ lifecycle: 'ready' });
  });
});
