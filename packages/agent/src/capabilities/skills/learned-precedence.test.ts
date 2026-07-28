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
      learnedArea: { rootDir, expectedScope: scope },
    });
    await registry.discover();
    expect(registry.get('verify-release')?.source).toBe('project');

    await writeFile(join(rootDir, artifact.relativePath), 'tampered', 'utf8');
    const learnedOnly = new SkillRegistry(undefined, {
      projectPaths: [],
      userPaths: [],
      pluginPaths: [],
      builtinPath: join(rootDir, 'builtin'),
      learnedArea: { rootDir, expectedScope: scope },
    });
    await learnedOnly.discover();
    expect(learnedOnly.has('verify-release')).toBe(false);
    expect(await store.readCapability('lc_verify_release')).toMatchObject({
      lifecycle: 'quarantined',
    });
  });
});
