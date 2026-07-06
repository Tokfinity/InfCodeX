import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  resolveMemoryRoot,
  setAgentConfigHome,
  type MemoryReviewModelInput,
  type MemoryReviewPlan,
} from '@kodax-ai/agent';

import type { KodaXOptions } from './types.js';
import {
  detectMemoryReviewTrigger,
  maybeReviewMemoryFeedbackFromPrompt,
  maybeRunMemoryMaintenanceWindow,
} from './memory-runtime.js';

async function createTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

describe('memory runtime hooks', () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    setAgentConfigHome(undefined);
    for (const dir of cleanupDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('detects explicit memory feedback triggers in user prompts', () => {
    expect(detectMemoryReviewTrigger('Please remember this repo uses pnpm.')).toBe('explicit_remember');
    expect(detectMemoryReviewTrigger("Don't remember that temporary token.")).toBe('explicit_forget');
    expect(detectMemoryReviewTrigger('The saved memory is wrong: the repo uses pnpm, not npm.')).toBe('user_correction');
    expect(detectMemoryReviewTrigger('\u8bb0\u5fc6\u4e0d\u5bf9\uff0c\u5e94\u8be5\u662f pnpm')).toBe('user_correction');
    expect(detectMemoryReviewTrigger('Please inspect the build.')).toBeUndefined();
  });

  it('does not treat ordinary coding corrections as memory feedback', () => {
    expect(detectMemoryReviewTrigger('Use a Map instead of a plain object here.')).toBeUndefined();
    expect(detectMemoryReviewTrigger('This helper should be async.')).toBeUndefined();
    expect(detectMemoryReviewTrigger('\u5176\u5b9e\u5148\u5199\u6d4b\u8bd5\uff0c\u518d\u6539\u5b9e\u73b0\u3002')).toBeUndefined();
    expect(detectMemoryReviewTrigger('Actually, inspect package.json before deciding.')).toBeUndefined();
  });

  it('runs deterministic maintenance during a memory maintenance window', async () => {
    const cwd = await createTempDir('kodax-memory-runtime-cwd-');
    const home = await createTempDir('kodax-memory-runtime-home-');
    cleanupDirs.push(cwd, home);
    setAgentConfigHome(home);
    const memoryDir = resolveMemoryRoot(cwd);
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(
      path.join(memoryDir, 'alpha.md'),
      [
        '---',
        'name: Shared memory',
        'description: alpha duplicate',
        'type: project',
        '---',
        '',
        'same body',
        '',
      ].join('\n'),
      'utf8',
    );
    await fs.writeFile(
      path.join(memoryDir, 'beta.md'),
      [
        '---',
        'name: Shared memory',
        'description: beta duplicate',
        'type: project',
        '---',
        '',
        'same body',
        '',
      ].join('\n'),
      'utf8',
    );

    await maybeRunMemoryMaintenanceWindow({
      provider: 'anthropic',
      context: { executionCwd: cwd },
    });

    await expect(pathExists(path.join(memoryDir, '.governance', 'auto-curate-state.json')))
      .resolves.toBe(true);
  });

  it('skips deterministic maintenance for internal child agent runs', async () => {
    const cwd = await createTempDir('kodax-memory-runtime-child-cwd-');
    const home = await createTempDir('kodax-memory-runtime-child-home-');
    cleanupDirs.push(cwd, home);
    setAgentConfigHome(home);
    const memoryDir = resolveMemoryRoot(cwd);
    await fs.mkdir(memoryDir, { recursive: true });
    for (const name of ['alpha.md', 'beta.md']) {
      await fs.writeFile(
        path.join(memoryDir, name),
        [
          '---',
          'name: Shared memory',
          'description: duplicate',
          'type: project',
          '---',
          '',
          'same body',
          '',
        ].join('\n'),
        'utf8',
      );
    }

    await maybeRunMemoryMaintenanceWindow({
      provider: 'anthropic',
      context: {
        executionCwd: cwd,
        currentAgentId: 'child-1',
        parentAgentId: 'worker',
      },
    });

    await expect(pathExists(path.join(memoryDir, '.governance', 'auto-curate-state.json')))
      .resolves.toBe(false);
  });

  it('runs the injected reviewer when prompt feedback corrects memory', async () => {
    const cwd = await createTempDir('kodax-memory-runtime-review-');
    const home = await createTempDir('kodax-memory-runtime-review-home-');
    cleanupDirs.push(cwd, home);
    setAgentConfigHome(home);
    const memoryDir = resolveMemoryRoot(cwd);
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(
      path.join(memoryDir, 'project_stack.md'),
      [
        '---',
        'name: Project stack',
        'description: Repo package manager preference',
        'type: project',
        '---',
        '',
        'Repo uses npm workspaces.',
        '',
      ].join('\n'),
      'utf8',
    );
    let received: MemoryReviewModelInput | undefined;
    let emitted: MemoryReviewPlan | undefined;
    const options: KodaXOptions = {
      provider: 'anthropic',
      context: {
        executionCwd: cwd,
        rawUserInput: '\u8bb0\u5fc6\u4e0d\u5bf9\uff0c\u5e94\u8be5\u662f pnpm',
      },
      events: {
        onMemoryReview: (plan) => {
          emitted = plan;
        },
      },
      memoryReviewer: async (input) => {
        received = input;
        return {
          trigger: input.trigger,
          createdAt: '2026-07-06T00:00:00.000Z',
          sourceRefs: input.sourceRefs,
          candidateRefs: input.candidateRefs,
          actions: [],
          warnings: input.warnings,
        };
      },
    };

    await maybeReviewMemoryFeedbackFromPrompt(options, '\u8bb0\u5fc6\u4e0d\u5bf9\uff0c\u5e94\u8be5\u662f pnpm');

    expect(received?.trigger).toBe('user_correction');
    expect(received?.candidateRefs.map((candidate) => candidate.ref.id)).toContain('memdir:project_stack.md');
    expect(emitted?.trigger).toBe('user_correction');
  });

  it('does not run the injected reviewer for ordinary correction wording', async () => {
    const cwd = await createTempDir('kodax-memory-runtime-no-review-');
    const home = await createTempDir('kodax-memory-runtime-no-review-home-');
    cleanupDirs.push(cwd, home);
    setAgentConfigHome(home);
    let reviewCalls = 0;
    const options: KodaXOptions = {
      provider: 'anthropic',
      context: {
        executionCwd: cwd,
        rawUserInput: 'Use a Map instead of a plain object here.',
      },
      memoryReviewer: async (input) => {
        reviewCalls++;
        return {
          trigger: input.trigger,
          createdAt: '2026-07-06T00:00:00.000Z',
          sourceRefs: input.sourceRefs,
          candidateRefs: input.candidateRefs,
          actions: [],
          warnings: input.warnings,
        };
      },
    };

    await maybeReviewMemoryFeedbackFromPrompt(options, 'Use a Map instead of a plain object here.');

    expect(reviewCalls).toBe(0);
  });

  it('does not run the injected reviewer for internal child agent runs', async () => {
    const cwd = await createTempDir('kodax-memory-runtime-child-review-');
    const home = await createTempDir('kodax-memory-runtime-child-review-home-');
    cleanupDirs.push(cwd, home);
    setAgentConfigHome(home);
    let reviewCalls = 0;
    let emitted = false;
    const options: KodaXOptions = {
      provider: 'anthropic',
      context: {
        executionCwd: cwd,
        currentAgentId: 'child-1',
        parentAgentId: 'worker',
        rawUserInput: 'The saved memory is wrong: the repo uses pnpm, not npm.',
      },
      events: {
        onMemoryReview: () => {
          emitted = true;
        },
      },
      memoryReviewer: async (input) => {
        reviewCalls++;
        return {
          trigger: input.trigger,
          createdAt: '2026-07-06T00:00:00.000Z',
          sourceRefs: input.sourceRefs,
          candidateRefs: input.candidateRefs,
          actions: [],
          warnings: input.warnings,
        };
      },
    };

    await maybeReviewMemoryFeedbackFromPrompt(
      options,
      'The saved memory is wrong: the repo uses pnpm, not npm.',
    );

    expect(reviewCalls).toBe(0);
    expect(emitted).toBe(false);
  });
});
