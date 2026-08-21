import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { resetSkillRegistry } from '@kodax-ai/agent';
import { prepareCliSkillInvocation } from './kodax_cli.js';

const tempDirs: string[] = [];

afterEach(async () => {
  resetSkillRegistry();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('prepareCliSkillInvocation', () => {
  it('routes a middle explicit-only Skill through the structured CLI invocation path', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-cli-skill-'));
    tempDirs.push(root);
    const skillDir = path.join(root, '.kodax', 'skills', 'cli-helper');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: cli-helper',
        'description: Explicit CLI helper',
        'disable-model-invocation: true',
        'allowed-tools: read',
        '---',
        '',
        'Handle $ARGUMENTS.',
      ].join('\n'),
      'utf8',
    );

    const prepared = await prepareCliSkillInvocation(
      'please use /cli-helper inspect src',
      {
        provider: 'mock-provider',
        context: { gitRoot: root, executionCwd: root },
      },
    );

    expect(prepared).toMatchObject({
      mode: 'inline',
      options: {
        context: {
          skillInvocation: {
            name: 'cli-helper',
            arguments: 'inspect src',
          },
        },
      },
    });
    const expandedContent = prepared?.options?.context?.skillInvocation?.expandedContent ?? '';
    expect(prepared?.prompt).not.toContain('Handle inspect src.');
    expect(expandedContent).toContain('Handle inspect src.');
    expect(`${prepared?.prompt ?? ''}\n${expandedContent}`.match(/Handle inspect src\./g))
      .toHaveLength(1);
    await prepared?.finalize();
  });
});
