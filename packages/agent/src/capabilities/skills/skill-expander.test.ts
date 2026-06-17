import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { expandSkillForLLM } from './skill-expander.js';
import { loadFullSkill } from './skill-loader.js';
import { createTempDir, removeTempDir } from './test-utils/temp-dir.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => removeTempDir(dir)));
});

function displayPath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

describe('expandSkillForLLM', () => {
  it('includes the skill root and support file paths for user skills', async () => {
    const rootDir = await createTempDir('kodax-skill-expander-');
    tempDirs.push(rootDir);
    const skillDir = join(rootDir, 'agents-skills', 'design-skill');

    await mkdir(join(skillDir, 'references'), { recursive: true });
    await mkdir(join(skillDir, 'assets'), { recursive: true });
    await mkdir(join(skillDir, 'scripts'), { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      `---
name: design-skill
description: Test design skill
---

Read references/animation-best-practices.md and use assets/animations.jsx.
`,
      'utf8',
    );
    await writeFile(
      join(skillDir, 'references', 'animation-best-practices.md'),
      '# Animation best practices',
      'utf8',
    );
    await writeFile(join(skillDir, 'assets', 'animations.jsx'), 'export const Stage = {};', 'utf8');
    await writeFile(join(skillDir, 'scripts', 'render.mjs'), 'export {};', 'utf8');

    const skill = await loadFullSkill(skillDir, 'user');
    if (!skill) {
      throw new Error('Expected test skill to load');
    }

    const expanded = await expandSkillForLLM(skill, '', {
      workingDirectory: rootDir,
      projectRoot: rootDir,
    });

    expect(expanded.content).toContain(`Skill root: ${displayPath(skillDir)}`);
    expect(expanded.content).toContain('Support roots:');
    expect(expanded.content).toContain(
      `references/animation-best-practices.md: ${displayPath(join(skillDir, 'references', 'animation-best-practices.md'))}`,
    );
    expect(expanded.content).toContain(
      `assets/animations.jsx: ${displayPath(join(skillDir, 'assets', 'animations.jsx'))}`,
    );
    expect(expanded.content).toContain(
      `scripts/render.mjs: ${displayPath(join(skillDir, 'scripts', 'render.mjs'))}`,
    );
  });

  it('keeps project work paths separate from project skill support paths', async () => {
    const rootDir = await createTempDir('kodax-project-skill-expander-');
    tempDirs.push(rootDir);
    const skillDir = join(rootDir, '.kodax', 'skills', 'project-skill');

    await mkdir(join(skillDir, 'references'), { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      `---
name: project-skill
description: Test project skill
---

Read references/project-patterns.md before editing src/index.ts.
`,
      'utf8',
    );
    await writeFile(
      join(skillDir, 'references', 'project-patterns.md'),
      '# Project patterns',
      'utf8',
    );

    const skill = await loadFullSkill(skillDir, 'project');
    if (!skill) {
      throw new Error('Expected test skill to load');
    }

    const expanded = await expandSkillForLLM(skill, '', {
      workingDirectory: rootDir,
      projectRoot: rootDir,
    });

    expect(expanded.content).toContain(
      'Project work paths are relative to the project root; skill support files are relative to the skill root above.',
    );
    expect(expanded.content).not.toContain('References are relative to the project root.');
    expect(expanded.content).toContain(
      `references/project-patterns.md: ${displayPath(join(skillDir, 'references', 'project-patterns.md'))}`,
    );
  });
});
