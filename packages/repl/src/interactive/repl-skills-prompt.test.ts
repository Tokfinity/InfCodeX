import os from 'os';
import path from 'path';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { resetSkillRegistry } from '@kodax-ai/agent';
import { buildClassicCliSkillsPrompt } from './repl.js';

const tempDirs: string[] = [];

describe('classic REPL skills prompt', () => {
  afterEach(async () => {
    resetSkillRegistry();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('discovers skills before rendering the startup prompt snippet', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-repl-skills-prompt-'));
    tempDirs.push(root);
    const skillDir = path.join(root, '.kodax', 'skills', 'prompt-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, 'SKILL.md'),
      `---
name: prompt-skill
description: Test skill visible to classic REPL
---

Use this skill in tests.
`,
      'utf8',
    );

    const prompt = await buildClassicCliSkillsPrompt(root);

    expect(prompt).toContain('## Available Skills');
    expect(prompt).toContain('prompt-skill');
    expect(prompt).toContain('BLOCKING REQUIREMENT');
  });
});
