import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  LearnedAreaStore,
  SkillRegistry,
  commitLearnedSkillRevision,
  createLearnedCapabilityScope,
  resolveProjectLearnedAreaRoot,
} from '@kodax-ai/agent';
import { afterEach, describe, expect, it } from 'vitest';

import { prepareCodingLearnedSkillBinding } from './learned-skill-runtime.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('FEATURE_263 coding root learned Skill binding', () => {
  it('fails closed without blocking the foreground when the Learned Area contains invalid JSON', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kodax-coding-learned-invalid-'));
    roots.push(root);
    const configHome = join(root, '.kodax');
    const projectRoot = join(root, 'project');
    const identity = {
      configHome,
      tenantId: `local:${configHome}`,
      agentId: 'coding-agent',
      projectId: `local:${projectRoot}`,
      sessionId: 'session-invalid',
    } as const;
    const store = new LearnedAreaStore(resolveProjectLearnedAreaRoot(configHome, identity));
    await store.initialize();
    await writeFile(join(store.paths.capabilities, 'broken.json'), '{not-json', 'utf8');

    await expect(prepareCodingLearnedSkillBinding({
      provider: 'test',
      context: { configHome, executionCwd: projectRoot },
    }, identity, 'session-invalid')).resolves.toBeUndefined();
  });

  it('fails closed without blocking the foreground when legacy migration cannot read its records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kodax-coding-learned-migration-'));
    roots.push(root);
    const configHome = join(root, '.kodax');
    const projectRoot = join(root, 'project');
    const identity = {
      configHome,
      tenantId: `local:${configHome}`,
      agentId: 'coding-agent',
      projectId: `local:${projectRoot}`,
      sessionId: 'session-migration',
    } as const;
    const legacyCapabilities = join(configHome, 'learned', 'capabilities');
    await mkdir(legacyCapabilities, { recursive: true });
    await writeFile(join(legacyCapabilities, 'broken.json'), '{not-json', 'utf8');

    await expect(prepareCodingLearnedSkillBinding({
      provider: 'test',
      context: { configHome, executionCwd: projectRoot },
    }, identity, 'session-migration')).resolves.toBeUndefined();
  });

  it('discovers the project canary, admits exact invocation, and releases the root reservation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kodax-coding-learned-'));
    roots.push(root);
    const configHome = join(root, '.kodax');
    const projectRoot = join(root, 'project');
    const identity = {
      configHome,
      tenantId: `local:${configHome}`,
      agentId: 'coding-agent',
      projectId: `local:${projectRoot}`,
      sessionId: 'session-a',
    } as const;
    const store = new LearnedAreaStore(resolveProjectLearnedAreaRoot(configHome, identity));
    await store.initialize();
    const record = await commitLearnedSkillRevision(store, {
      scope: createLearnedCapabilityScope(configHome, identity),
      spec: {
        name: 'verify-release',
        description: 'Use when validating this project before a release.',
        purpose: 'Verify release state from reproducible evidence.',
        triggers: ['A release candidate needs verification.'],
        steps: ['Run the release test suite.'],
        verification: ['Require a passing check artifact.'],
        pitfalls: ['Do not treat self-report as verification.'],
      },
      disposition: 'project_canary',
      operation: 'create',
      provenance: {
        jobId: 'job-1',
        inputHash: 'a'.repeat(64),
        decisionId: 'decision-1',
        actionId: 'action-1',
      },
    });
    const first = await prepareCodingLearnedSkillBinding({
      provider: 'test',
      context: { configHome, executionCwd: projectRoot },
    }, identity, 'session-a');
    const second = await prepareCodingLearnedSkillBinding({
      provider: 'test',
      context: { configHome, executionCwd: projectRoot },
    }, { ...identity, sessionId: 'session-b' }, 'session-b');

    expect(first?.context.skillRegistry?.get('verify-release')).toMatchObject({
      source: 'learned',
    });
    expect(first?.context.learnedSkillBindingId).toMatch(/^root_/);
    expect(second?.context.skillRegistry?.has('verify-release')).toBe(false);
    await first?.context.admitLearnedSkillInvocation?.({
      sessionId: 'child-session',
      capabilityId: record.capabilityId,
      revision: record.artifact.contentRevision,
      fingerprint: record.artifact.fingerprint,
    });
    await first?.context.completeLearnedSkillOutcomes?.({
      sessionId: 'child-session',
      outcome: 'verified_success',
      evidenceRefs: ['artifact:check-1'],
    });
    await first?.release();
    await second?.release();

    const completed = await store.readCapability(record.capabilityId);
    expect(completed).toMatchObject({
      lifecycle: 'active_learned',
      canary: { verifiedSuccesses: 1 },
    });
    expect(completed?.schemaVersion === 2 && 'binding' in completed.canary).toBe(false);
  });

  it('adds learned Skills to a Runtime-pinned formal registry after a managed workspace is known', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kodax-coding-learned-overlay-'));
    roots.push(root);
    const configHome = join(root, '.kodax');
    const projectRoot = join(root, 'managed-project');
    const identity = {
      configHome,
      tenantId: `local:${configHome}`,
      agentId: 'runtime-agent',
      projectId: `local:${projectRoot}`,
      sessionId: 'session-managed',
    } as const;
    const store = new LearnedAreaStore(resolveProjectLearnedAreaRoot(configHome, identity));
    await store.initialize();
    await commitLearnedSkillRevision(store, {
      scope: createLearnedCapabilityScope(configHome, identity),
      spec: {
        name: 'verify-release',
        description: 'Use when validating this project before a release.',
        purpose: 'Verify release state from reproducible evidence.',
        triggers: ['A release candidate needs verification.'],
        steps: ['Run the release test suite.'],
        verification: ['Require a passing check artifact.'],
        pitfalls: ['Do not treat self-report as verification.'],
      },
      disposition: 'project_canary',
      operation: 'create',
      provenance: {
        jobId: 'job-managed',
        inputHash: 'b'.repeat(64),
        decisionId: 'decision-managed',
        actionId: 'action-managed',
      },
    });
    const formalRoot = join(root, 'formal-skills');
    await mkdir(join(formalRoot, 'formal-review'), { recursive: true });
    await writeFile(join(formalRoot, 'formal-review', 'SKILL.md'), [
      '---',
      'name: formal-review',
      'description: Review formal release policy.',
      '---',
      '',
      'Follow the formal policy.',
    ].join('\n'), 'utf8');
    const formalRegistry = new SkillRegistry(projectRoot, {
      projectPaths: [formalRoot],
      userPaths: [],
      pluginPaths: [],
      builtinPath: join(root, 'no-builtin-skills'),
    });
    await formalRegistry.discover();
    const hiddenFormalRoot = join(projectRoot, '.kodax', 'skills', 'hidden-formal');
    await mkdir(hiddenFormalRoot, { recursive: true });
    await writeFile(join(hiddenFormalRoot, 'SKILL.md'), [
      '---',
      'name: hidden-formal',
      'description: Formal Skill excluded from the pinned run selection.',
      '---',
      '',
      'Remain protected even when not selected for this run.',
    ].join('\n'), 'utf8');

    const binding = await prepareCodingLearnedSkillBinding({
      provider: 'test',
      context: {
        configHome,
        executionCwd: projectRoot,
        skillRegistry: formalRegistry,
        skillsPrompt: 'FORMAL SKILL CONTRACT',
      },
    }, identity, 'session-managed');

    expect(binding?.context.skillRegistry?.has('formal-review')).toBe(true);
    expect(binding?.context.skillRegistry?.get('verify-release')).toMatchObject({
      source: 'learned',
    });
    expect(binding?.context.skillsPrompt).toContain('FORMAL SKILL CONTRACT');
    expect(binding?.context.skillsPrompt).toContain('verify-release');
    expect(binding?.context.protectedFormalSkillNames).toEqual(
      expect.arrayContaining(['formal-review', 'hidden-formal']),
    );
    await binding?.release();
  });
});
