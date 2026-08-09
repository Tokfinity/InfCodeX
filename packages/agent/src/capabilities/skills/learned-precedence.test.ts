import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  getSkillPathsFlat,
  type ResolvedSkillSource,
  type SkillPathsConfig,
  type SkillSource,
} from './types.js';
import {
  LearnedAreaStore,
  admitLearnedSkillBinding,
  createLearnedSkillRecord,
  stageLearnedSkillRevision,
  type DeclarativeSkillSpec,
  type LearnedCapabilityScope,
} from '../../learning/index.js';
import { SkillRegistry } from './skill-registry.js';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const scope: LearnedCapabilityScope = {
  configHomeHash: 'a'.repeat(64),
  tenantHash: 'b'.repeat(64),
  projectHash: 'c'.repeat(64),
};

const learnedSpec: DeclarativeSkillSpec = {
  name: 'verify-release',
  description: 'Use when verifying release candidates.',
  purpose: 'Verify a release.',
  triggers: ['A release candidate is ready.'],
  steps: ['Run release tests.'],
  verification: ['Confirm the tests passed.'],
  pitfalls: ['Do not accept partial output.'],
};

describe('learned Skill precedence', () => {
  it('fails fast when physical roots do not have one paired expected scope each', async () => {
    const primaryRootDir = await mkdtemp(join(tmpdir(), 'kodax-learned-invalid-pairing-'));
    const secondaryRootDir = await mkdtemp(join(tmpdir(), 'kodax-learned-invalid-pairing-'));
    tempRoots.push(primaryRootDir, secondaryRootDir);

    for (const learnedArea of [
      {
        rootDir: primaryRootDir,
        expectedScope: scope,
        expectedScopes: [] as unknown as [typeof scope, ...(typeof scope)[]],
      },
      {
        rootDir: primaryRootDir,
        additionalRootDirs: [secondaryRootDir],
        expectedScope: scope,
        expectedScopes: [scope],
      },
    ]) {
      const registry = new SkillRegistry(undefined, {
        projectPaths: [],
        userPaths: [],
        pluginPaths: [],
        builtinPath: join(primaryRootDir, 'builtin'),
        learnedArea,
      });
      await expect(registry.discover()).rejects.toThrow(/expected scope|physical root/i);
    }
  });

  it('keeps the legacy single expectedScope configuration source-compatible', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'kodax-learned-legacy-scope-'));
    tempRoots.push(rootDir);
    const artifact = await stageLearnedSkillRevision(rootDir, 'lc_legacy_scope', learnedSpec);
    const store = new LearnedAreaStore(rootDir);
    await store.initialize();
    const record = createLearnedSkillRecord({
      capabilityId: 'lc_legacy_scope',
      displayName: 'Verify release',
      scope,
      artifact,
      provenance: {
        jobId: 'job-legacy',
        inputHash: 'd'.repeat(64),
        decisionId: 'decision-legacy',
        actionId: 'action-legacy',
      },
      now: '2026-07-27T00:00:00.000Z',
    });
    await store.writeCapability({
      ...record,
      lifecycle: 'active_learned',
      canary: { ...record.canary, verifiedSuccesses: 1 },
    });

    const registry = new SkillRegistry(undefined, {
      projectPaths: [],
      userPaths: [],
      pluginPaths: [],
      builtinPath: join(rootDir, 'builtin'),
      learnedArea: { rootDir, expectedScope: scope },
    });
    await registry.discover();
    expect(registry.has('verify-release')).toBe(true);
  });

  it('keeps the legacy SkillSource union exhaustive while exposing learned discovery', () => {
    const labels: Record<SkillSource, string> = {
      project: 'project',
      user: 'user',
      plugin: 'plugin',
      builtin: 'builtin',
    };
    const learned: ResolvedSkillSource = 'learned';
    expect(labels.builtin).toBe('builtin');
    expect(learned).toBe('learned');
  });

  it('does not treat a loose learned directory as a discovery source', () => {
    const config: SkillPathsConfig = {
      projectPaths: ['project'],
      userPaths: ['user'],
      pluginPaths: ['plugin'],
      builtinPath: 'builtin',
      learnedPath: 'learned',
    };

    expect(getSkillPathsFlat(config)).toEqual([
      { path: 'project', source: 'project' },
      { path: 'user', source: 'user' },
      { path: 'plugin', source: 'plugin' },
      { path: 'builtin', source: 'builtin' },
    ]);
  });

  it('loads only a matching record-gated testing revision with its admitted binding', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'kodax-record-gated-skill-'));
    tempRoots.push(rootDir);
    const artifact = await stageLearnedSkillRevision(rootDir, 'lc_verify_release', learnedSpec);
    const store = new LearnedAreaStore(rootDir);
    await store.initialize();
    await store.writeCapability(createLearnedSkillRecord({
      capabilityId: 'lc_verify_release',
      displayName: 'Verify release',
      scope,
      artifact,
      provenance: {
        jobId: 'job-1',
        inputHash: 'd'.repeat(64),
        decisionId: 'decision-1',
        actionId: 'action-1',
      },
      now: '2026-07-27T00:00:00.000Z',
    }));
    const binding = await admitLearnedSkillBinding(store, 'lc_verify_release', {
      bindingId: 'binding-a',
      ownerSessionRef: 'owner-a',
      now: new Date('2026-07-27T00:01:00.000Z'),
      ttlMs: 60_000,
    });
    const withoutAdmission = new SkillRegistry(undefined, {
      projectPaths: [],
      userPaths: [],
      pluginPaths: [],
      builtinPath: join(rootDir, 'builtin'),
      learnedArea: {
        rootDir,
        expectedScope: scope,
        expectedScopes: [scope],
        now: '2026-07-27T00:01:01.000Z',
        testingBindings: {},
      },
    });
    await withoutAdmission.discover();
    expect(withoutAdmission.has('verify-release')).toBe(false);

    const admitted = new SkillRegistry(undefined, {
      projectPaths: [],
      userPaths: [],
      pluginPaths: [],
      builtinPath: join(rootDir, 'builtin'),
      learnedArea: {
        rootDir,
        expectedScope: scope,
        expectedScopes: [scope],
        now: '2026-07-27T00:01:01.000Z',
        testingBindings: { lc_verify_release: binding?.bindingId ?? '' },
      },
    });
    await admitted.discover();
    expect(admitted.get('verify-release')).toMatchObject({ source: 'learned' });
  });

  it('keeps a formal Skill on name collision and quarantines a tampered learned artifact', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'kodax-tampered-skill-'));
    tempRoots.push(rootDir);
    const artifact = await stageLearnedSkillRevision(rootDir, 'lc_verify_release', learnedSpec);
    const store = new LearnedAreaStore(rootDir);
    await store.initialize();
    const record = createLearnedSkillRecord({
      capabilityId: 'lc_verify_release',
      displayName: 'Verify release',
      scope,
      artifact,
      provenance: {
        jobId: 'job-1',
        inputHash: 'd'.repeat(64),
        decisionId: 'decision-1',
        actionId: 'action-1',
      },
      now: '2026-07-27T00:00:00.000Z',
    });
    await store.writeCapability({
      ...record,
      lifecycle: 'active_learned',
      canary: { ...record.canary, verifiedSuccesses: 1 },
    });
    const formalDir = join(rootDir, 'formal', 'verify-release');
    await mkdir(formalDir, { recursive: true });
    await writeFile(join(formalDir, 'SKILL.md'), [
      '---',
      'name: verify-release',
      'description: Formal release verification.',
      '---',
      '',
      'Formal.',
      '',
    ].join('\n'), 'utf8');
    const registry = new SkillRegistry(undefined, {
      projectPaths: [join(rootDir, 'formal')],
      userPaths: [],
      pluginPaths: [],
      builtinPath: join(rootDir, 'builtin'),
      learnedArea: { rootDir, expectedScope: scope, expectedScopes: [scope] },
    });
    await registry.discover();
    expect(registry.get('verify-release')?.source).toBe('project');

    await writeFile(join(rootDir, artifact.relativePath), 'tampered', 'utf8');
    const learnedOnly = new SkillRegistry(undefined, {
      projectPaths: [],
      userPaths: [],
      pluginPaths: [],
      builtinPath: join(rootDir, 'builtin'),
      learnedArea: { rootDir, expectedScope: scope, expectedScopes: [scope] },
    });
    await learnedOnly.discover();
    expect(learnedOnly.has('verify-release')).toBe(false);
    expect(await store.readCapability('lc_verify_release')).toMatchObject({
      lifecycle: 'quarantined',
    });
  });

  it('discovers a learned skill from a secondary physical Learned Area root', async () => {
    const primaryRootDir = await mkdtemp(join(tmpdir(), 'kodax-learned-primary-root-'));
    const secondaryRootDir = await mkdtemp(join(tmpdir(), 'kodax-learned-secondary-root-'));
    tempRoots.push(primaryRootDir, secondaryRootDir);

    // The record is written under the "remote" scope (as drain would do
    // when git remote is available).
    const remoteScope: LearnedCapabilityScope = {
      configHomeHash: 'a'.repeat(64),
      tenantHash: 'b'.repeat(64),
      projectHash: 'd'.repeat(64),
    };
    const localScope: LearnedCapabilityScope = {
      configHomeHash: 'a'.repeat(64),
      tenantHash: 'b'.repeat(64),
      projectHash: 'c'.repeat(64),
    };

    const artifact = await stageLearnedSkillRevision(secondaryRootDir, 'lc_multi_scope', learnedSpec);
    const store = new LearnedAreaStore(secondaryRootDir);
    await store.initialize();
    await store.writeCapability(createLearnedSkillRecord({
      capabilityId: 'lc_multi_scope',
      displayName: 'Verify release',
      scope: remoteScope,
      artifact,
      provenance: {
        jobId: 'job-multi',
        inputHash: 'e'.repeat(64),
        decisionId: 'decision-multi',
        actionId: 'action-multi',
      },
      now: '2026-07-27T00:00:00.000Z',
    }));
    await admitLearnedSkillBinding(store, 'lc_multi_scope', {
      bindingId: 'binding-multi',
      ownerSessionRef: 'owner-multi',
      now: new Date('2026-07-27T00:01:00.000Z'),
      ttlMs: 60_000,
    });

    // The matching record is physically absent from primaryRootDir.
    const registry = new SkillRegistry(undefined, {
      projectPaths: [],
      userPaths: [],
      pluginPaths: [],
      builtinPath: join(primaryRootDir, 'builtin'),
      learnedArea: {
        rootDir: primaryRootDir,
        additionalRootDirs: [secondaryRootDir],
        expectedScope: localScope,
        expectedScopes: [localScope, remoteScope],
        now: '2026-07-27T00:01:01.000Z',
        testingBindings: { lc_multi_scope: 'binding-multi' },
      },
    });
    await registry.discover();
    expect(registry.has('verify-release')).toBe(true);

    // Control: without the secondary root the record is not discoverable.
    const registryLocalOnly = new SkillRegistry(undefined, {
      projectPaths: [],
      userPaths: [],
      pluginPaths: [],
      builtinPath: join(primaryRootDir, 'builtin'),
      learnedArea: {
        rootDir: primaryRootDir,
        expectedScope: localScope,
        expectedScopes: [localScope],
        now: '2026-07-27T00:01:01.000Z',
        testingBindings: { lc_multi_scope: 'binding-multi' },
      },
    });
    await registryLocalOnly.discover();
    expect(registryLocalOnly.has('verify-release')).toBe(false);
  });
});
