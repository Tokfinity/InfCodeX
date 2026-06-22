import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resetSkillRegistry } from '@kodax-ai/agent';
import { toolSkill } from './skill.js';

// The skill tool reads the global singleton via `getSkillRegistry()`. To
// give the tool a deterministic registry under test we reach into the
// same module and replace the singleton's underlying maps. Importing the
// concrete `SkillRegistry` and constructing one tied to the temp dir is
// the supported way per skill-registry.test.ts.

async function writeSkillMd(
  rootDir: string,
  sourceDir: string,
  name: string,
  description: string,
  body: string,
  dirName = name,
): Promise<string> {
  const skillDir = path.join(rootDir, sourceDir, dirName);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
    'utf8',
  );
  return skillDir;
}

// The skill tool reaches the registry via getSkillRegistry() (singleton).
// We populate the singleton by constructing a SkillRegistry against a
// scratch project root and then publishing it into the module's
// singleton slot through the registry's public discover() — but the
// singleton slot is private. Instead, we set process.cwd() such that
// the SkillRegistry the global function returns ends up pointing at our
// scratch tree.

describe('toolSkill (claudecode-parity skill invocation)', () => {
  let tempDir = '';
  let originalCwd = '';

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'kodax-skill-tool-'));
    originalCwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    resetSkillRegistry();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('errors when called without a skill argument', async () => {
    const result = await toolSkill({}, {
      backups: new Map(),
      executionCwd: tempDir,
    });
    expect(typeof result).toBe('string');
    expect(result).toContain('[Tool Error]');
    expect(result).toContain('missing required argument `skill`');
  });

  it('discovers project skills when the registry was not prewarmed', async () => {
    await writeSkillMd(
      tempDir,
      path.join('.kodax', 'skills'),
      'kodax-test-auto-discover',
      'Auto discovered skill',
      'Auto discover body',
    );

    resetSkillRegistry();

    const result = await toolSkill({ skill: 'kodax-test-auto-discover' }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    expect(result).toContain('Auto discover body');
    expect(result).not.toContain('[Tool Error]');
  });

  it('errors when called with an empty skill name', async () => {
    const result = await toolSkill({ skill: '   ' }, {
      backups: new Map(),
      executionCwd: tempDir,
    });
    expect(result).toContain('[Tool Error]');
    expect(result).toContain('missing required argument `skill`');
  });

  // The remaining tests exercise the full skill-registry singleton path.
  // To keep them isolated from any installed global skills the developer
  // may have, we use a SkillRegistry instance directly (mirroring
  // skill-registry.test.ts) and call the toolSkill handler whose body
  // routes through the same registry. The singleton is reset by the
  // `projectRoot !== _instanceProjectRoot` reset rule in
  // getSkillRegistry — passing our scratch root forces a fresh
  // instance scoped to that directory.

  it('returns the expanded skill content when the skill exists', async () => {
    await writeSkillMd(
      tempDir,
      'project',
      'kodax-test-skill-found',
      'Test skill for tool',
      '# Body header\n\nDo X then Y.',
    );

    // Publish into the singleton by constructing + discovering against
    // the scratch root. The singleton's projectRoot must match what
    // toolSkill sees via getSkillRegistry().
    const { getSkillRegistry } = await import('@kodax-ai/agent');
    const registry = getSkillRegistry(tempDir, {
      projectPaths: [path.join(tempDir, 'project')],
      userPaths: [],
      pluginPaths: [],
      builtinPath: path.join(tempDir, 'builtin'),
    });
    await registry.discover();

    const result = await toolSkill({ skill: 'kodax-test-skill-found' }, {
      backups: new Map(),
      executionCwd: tempDir,
    });
    expect(typeof result).toBe('string');
    expect(result).toContain('<skill name="kodax-test-skill-found"');
    expect(result).toContain('Skill root:');
    expect(result).toContain('Body header');
    expect(result).toContain('Do X then Y.');
    expect(result).not.toContain('[Tool Error]');
  });

  it('returns support file locations for user skills', async () => {
    const skillDir = await writeSkillMd(
      tempDir,
      'user',
      'kodax-test-user-support',
      'User skill with resources',
      'Read references/guide.md and use scripts/check.mjs.',
    );
    await mkdir(path.join(skillDir, 'references'), { recursive: true });
    await mkdir(path.join(skillDir, 'scripts'), { recursive: true });
    await writeFile(path.join(skillDir, 'references', 'guide.md'), '# Guide', 'utf8');
    await writeFile(path.join(skillDir, 'scripts', 'check.mjs'), 'export {};', 'utf8');

    const { getSkillRegistry } = await import('@kodax-ai/agent');
    const registry = getSkillRegistry(tempDir, {
      projectPaths: [],
      userPaths: [path.join(tempDir, 'user')],
      pluginPaths: [],
      builtinPath: path.join(tempDir, 'builtin'),
    });
    await registry.discover();

    const result = await toolSkill({ skill: 'kodax-test-user-support' }, {
      backups: new Map(),
      executionCwd: tempDir,
    });

    expect(result).toContain(`Skill root: ${skillDir.replace(/\\/g, '/')}`);
    expect(result).toContain(
      `references/guide.md: ${path.join(skillDir, 'references', 'guide.md').replace(/\\/g, '/')}`,
    );
    expect(result).toContain(
      `scripts/check.mjs: ${path.join(skillDir, 'scripts', 'check.mjs').replace(/\\/g, '/')}`,
    );
  });

  it('tolerates a leading slash in the skill name', async () => {
    await writeSkillMd(
      tempDir,
      'project',
      'kodax-test-skill-slash',
      'Slash-tolerated skill',
      'Slash body',
    );
    const { getSkillRegistry } = await import('@kodax-ai/agent');
    const registry = getSkillRegistry(tempDir, {
      projectPaths: [path.join(tempDir, 'project')],
      userPaths: [],
      pluginPaths: [],
      builtinPath: path.join(tempDir, 'builtin'),
    });
    await registry.discover();

    const result = await toolSkill({ skill: '/kodax-test-skill-slash' }, {
      backups: new Map(),
      executionCwd: tempDir,
    });
    expect(result).toContain('Slash body');
    expect(result).not.toContain('[Tool Error]');
  });

  it('tolerates legacy slash skill tokens in the skill name', async () => {
    await writeSkillMd(
      tempDir,
      'project',
      'kodax-test-skill-legacy-token',
      'Legacy-token skill',
      'Legacy token body',
    );
    const { getSkillRegistry } = await import('@kodax-ai/agent');
    const registry = getSkillRegistry(tempDir, {
      projectPaths: [path.join(tempDir, 'project')],
      userPaths: [],
      pluginPaths: [],
      builtinPath: path.join(tempDir, 'builtin'),
    });
    await registry.discover();

    const result = await toolSkill({ skill: '/skill:kodax-test-skill-legacy-token' }, {
      backups: new Map(),
      executionCwd: tempDir,
    });
    expect(result).toContain('Legacy token body');
    expect(result).not.toContain('[Tool Error]');
  });

  it('tolerates legacy namespaced skill tokens in the skill name', async () => {
    await writeSkillMd(
      tempDir,
      'project',
      'github:yeet',
      'Namespaced-token skill',
      'Namespaced token body',
      'github-yeet',
    );
    const { getSkillRegistry } = await import('@kodax-ai/agent');
    const registry = getSkillRegistry(tempDir, {
      projectPaths: [path.join(tempDir, 'project')],
      userPaths: [],
      pluginPaths: [],
      builtinPath: path.join(tempDir, 'builtin'),
    });
    await registry.discover();

    const result = await toolSkill({ skill: '/skill:github:yeet' }, {
      backups: new Map(),
      executionCwd: tempDir,
    });
    expect(result).toContain('Namespaced token body');
    expect(result).not.toContain('[Tool Error]');
  });

  it('returns a helpful error listing available skills on unknown skill', async () => {
    await writeSkillMd(
      tempDir,
      'project',
      'kodax-test-known',
      'A known skill',
      'body',
    );
    const { getSkillRegistry } = await import('@kodax-ai/agent');
    const registry = getSkillRegistry(tempDir, {
      projectPaths: [path.join(tempDir, 'project')],
      userPaths: [],
      pluginPaths: [],
      builtinPath: path.join(tempDir, 'builtin'),
    });
    await registry.discover();

    const result = await toolSkill({ skill: 'does-not-exist' }, {
      backups: new Map(),
      executionCwd: tempDir,
    });
    expect(result).toContain('[Tool Error]');
    expect(result).toContain('unknown skill "does-not-exist"');
    expect(result).toContain('kodax-test-known');
  });
});
