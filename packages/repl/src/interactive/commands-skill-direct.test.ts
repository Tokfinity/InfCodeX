import os from 'os';
import path from 'path';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSkillRegistry } from '@kodax-ai/agent';
import { executeCommand, getCommandRegistry, parseCommand, type CommandCallbacks } from './commands.js';

const tempDirs: string[] = [];

async function writeProjectSkill(root: string, name: string, body: string, dirName = name): Promise<void> {
  const skillDir = path.join(root, '.kodax', 'skills', dirName);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, 'SKILL.md'),
    `---
name: ${name}
description: ${body}
---

# ${name}

${body}
`,
    'utf8',
  );
}

function buildContext(gitRoot: string) {
  return {
    sessionId: 'session-direct-skill',
    gitRoot,
    messages: [],
  };
}

describe('direct skill slash invocation', () => {
  beforeEach(() => {
    resetSkillRegistry();
    const registry = getCommandRegistry();
    registry.clear();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    resetSkillRegistry();
    const registry = getCommandRegistry();
    registry.clear();
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('invokes /<skill-name> when no command uses that name', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-direct-skill-'));
    tempDirs.push(root);
    await writeProjectSkill(root, 'code-review-local', 'Review local code changes.');

    vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await executeCommand(
      { command: 'code-review-local', args: ['src/'] },
      buildContext(root) as never,
      {} as CommandCallbacks,
      {} as never,
    );

    expect(result).toMatchObject({
      invocation: {
        source: 'skill',
        displayName: 'code-review-local',
        skillInvocation: {
          name: 'code-review-local',
          arguments: 'src/',
        },
      },
    });
  });

  it('keeps built-in commands ahead of same-named skills', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-direct-skill-collision-'));
    tempDirs.push(root);
    await writeProjectSkill(root, 'help', 'This skill must not shadow the built-in help command.');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await executeCommand(
      { command: 'help', args: [] },
      buildContext(root) as never,
      {} as CommandCallbacks,
      {} as never,
    );

    const output = logSpy.mock.calls.flat().join('\n');
    expect(result).toBe(true);
    expect(output).toContain('Available Commands');
    expect(output).not.toContain('Invoking skill: help');
  });

  it('invokes namespaced /<skill-name> skills after command lookup misses', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-direct-skill-namespace-'));
    tempDirs.push(root);
    await writeProjectSkill(root, 'github:yeet', 'Publish local changes.', 'github-yeet');

    vi.spyOn(console, 'log').mockImplementation(() => {});
    const parsed = parseCommand('/github:yeet --draft');

    expect(parsed).toEqual({
      command: 'github',
      args: ['yeet', '--draft'],
    });

    const result = await executeCommand(
      parsed!,
      buildContext(root) as never,
      {} as CommandCallbacks,
      {} as never,
    );

    expect(result).toMatchObject({
      invocation: {
        source: 'skill',
        displayName: 'github:yeet',
        skillInvocation: {
          name: 'github:yeet',
          arguments: '--draft',
        },
      },
    });
  });
});
