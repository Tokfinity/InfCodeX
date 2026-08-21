import os from 'os';
import path from 'path';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSkillRegistry, resetSkillRegistry } from '@kodax-ai/agent';
import { executeCommand, getCommandRegistry, parseCommand, type CommandCallbacks } from './commands.js';

const tempDirs: string[] = [];

async function writeProjectSkill(
  root: string,
  name: string,
  body: string,
  dirName = name,
  frontmatter = '',
): Promise<void> {
  const skillDir = path.join(root, '.kodax', 'skills', dirName);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    path.join(skillDir, 'SKILL.md'),
    `---
name: ${name}
description: ${body}
${frontmatter}
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

  it('keeps explicit slash invocation available for every enabled skill', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-explicit-skill-'));
    tempDirs.push(root);
    await writeProjectSkill(
      root,
      'explicit-skill',
      'Run only when the user names this skill.',
      'explicit-skill',
      'user-invocable: false\ndisable-model-invocation: true',
    );

    vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await executeCommand(
      { command: 'explicit-skill', args: ['inspect', 'src/'] },
      buildContext(root) as never,
      {} as CommandCallbacks,
      {} as never,
    );

    expect(result).toMatchObject({
      invocation: {
        source: 'skill',
        displayName: 'explicit-skill',
        disableModelInvocation: true,
        skillInvocation: {
          name: 'explicit-skill',
          arguments: 'inspect src/',
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

  it('requires /skill reload before newly added skills enter an initialized registry', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-skill-reload-command-'));
    tempDirs.push(root);
    await writeProjectSkill(root, 'existing-skill', 'Existing skill.');

    const registry = getSkillRegistry(root);
    await registry.discover();
    expect(registry.has('new-skill')).toBe(false);

    await writeProjectSkill(root, 'new-skill', 'New skill added after startup.');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const beforeReload = await executeCommand(
      { command: 'new-skill', args: [] },
      buildContext(root) as never,
      {} as CommandCallbacks,
      {} as never,
    );
    expect(beforeReload).toBe(false);
    expect(logSpy.mock.calls.flat().join('\n')).toContain('Unknown command');

    logSpy.mockClear();
    await executeCommand(
      { command: 'skill', args: ['reload'] },
      buildContext(root) as never,
      {} as CommandCallbacks,
      {} as never,
    );
    expect(logSpy.mock.calls.flat().join('\n')).toContain('Skills reloaded');

    const afterReload = await executeCommand(
      { command: 'new-skill', args: [] },
      buildContext(root) as never,
      {} as CommandCallbacks,
      {} as never,
    );

    expect(afterReload).toMatchObject({
      invocation: {
        source: 'skill',
        displayName: 'new-skill',
        skillInvocation: {
          name: 'new-skill',
        },
      },
    });
  });
});
