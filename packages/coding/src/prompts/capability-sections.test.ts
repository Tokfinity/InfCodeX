/**
 * v0.7.35.1 FEATURE_142 Batch E — capability-sections unit tests.
 *
 * Verifies the 13 capability-context sections are emitted in the
 * documented order with the correct conditional inclusion behavior.
 * The byte-level equivalence with pre-Batch E SA output is enforced at
 * the integration level by `builder.test.ts` — this file pins the
 * unit-level contract (id ordering + conditional inclusion).
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { KodaXOptions } from '../types.js';

import { buildCapabilityContextSections } from './capability-sections.js';

async function createTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

interface FakeExtensionRuntime {
  readonly mcpContext: string | undefined;
}

function fakeExtensionRuntime(
  mcpContext: string | undefined,
): KodaXOptions['extensionRuntime'] {
  return {
    getCapabilityPromptContext: async (kind: string) =>
      kind === 'mcp' ? mcpContext : undefined,
  } as unknown as KodaXOptions['extensionRuntime'];
}

function ids(sections: ReadonlyArray<{ id: string }>): string[] {
  return sections.map((s) => s.id);
}

interface PartialContextOptions {
  executionCwd: string;
  gitRoot: string;
  repoIntelligenceContext?: string;
  promptOverlay?: string;
  skillsPrompt?: string;
}

interface MakeOptionsExtras {
  provider?: string;
  model?: string;
  extensionRuntime?: KodaXOptions['extensionRuntime'];
}

/**
 * Build a fixture KodaXOptions. `provider` defaults to undefined so
 * tests that exercise the "no runtime-fact" branch can omit it; pass
 * `{ provider: 'anthropic' }` explicitly to exercise the with-fact
 * branch.
 */
function makeOptions(
  ctx: PartialContextOptions,
  extras: MakeOptionsExtras = {},
): KodaXOptions {
  return {
    ...(extras.provider !== undefined ? { provider: extras.provider } : {}),
    ...(extras.model ? { model: extras.model } : {}),
    ...(extras.extensionRuntime ? { extensionRuntime: extras.extensionRuntime } : {}),
    context: ctx,
  } as unknown as KodaXOptions;
}

describe('buildCapabilityContextSections', () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanupDirs.splice(0).map((dir) =>
        fs.rm(dir, { recursive: true, force: true }),
      ),
    );
  });

  it('always emits base-system, environment-context, working-directory in canonical order (minimal options)', async () => {
    const cwd = await createTempDir('kodax-capsec-min-');
    cleanupDirs.push(cwd);

    const sections = await buildCapabilityContextSections(
      makeOptions({ executionCwd: cwd, gitRoot: cwd }),
      false, // not a new session — skip git/project snapshot
      cwd,
    );

    const sectionIds = ids(sections);
    // base-system MUST be first; environment-context + working-directory
    // are unconditional and follow in canonical order. Every other
    // section is conditional and absent in this fixture.
    expect(sectionIds[0]).toBe('base-system');
    expect(sectionIds).toContain('environment-context');
    expect(sectionIds).toContain('working-directory');
    // working-directory comes AFTER environment-context.
    expect(sectionIds.indexOf('environment-context'))
      .toBeLessThan(sectionIds.indexOf('working-directory'));
  });

  it('runtime-fact section is included only when provider or model is set', async () => {
    const cwd = await createTempDir('kodax-capsec-rf-');
    cleanupDirs.push(cwd);

    const without = await buildCapabilityContextSections(
      makeOptions({ executionCwd: cwd, gitRoot: cwd }),
      false,
      cwd,
    );
    expect(ids(without)).not.toContain('runtime-fact');

    const withProvider = await buildCapabilityContextSections(
      makeOptions(
        { executionCwd: cwd, gitRoot: cwd },
        { provider: 'anthropic' },
      ),
      false,
      cwd,
    );
    expect(ids(withProvider)).toContain('runtime-fact');
    const rf = withProvider.find((s) => s.id === 'runtime-fact');
    expect(rf?.content).toContain('provider=anthropic');
  });

  it('repo-intelligence-context, mcp-capability-context, prompt-overlay are conditional on context fields', async () => {
    const cwd = await createTempDir('kodax-capsec-cond-');
    cleanupDirs.push(cwd);

    const sections = await buildCapabilityContextSections(
      makeOptions(
        {
          executionCwd: cwd,
          gitRoot: cwd,
          repoIntelligenceContext: '## Repo intel\n- foo',
          promptOverlay: '## Overlay\n- bar',
          skillsPrompt: 'Use skill X',
        },
        { extensionRuntime: fakeExtensionRuntime('## MCP\n- minimax') },
      ),
      false,
      cwd,
    );

    const sectionIds = ids(sections);
    expect(sectionIds).toContain('repo-intelligence-context');
    expect(sectionIds).toContain('mcp-capability-context');
    expect(sectionIds).toContain('prompt-overlay');
    expect(sectionIds).toContain('skills-addendum');

    // Canonical order: repo-intel → mcp → overlay → project-agents → skills.
    expect(sectionIds.indexOf('repo-intelligence-context'))
      .toBeLessThan(sectionIds.indexOf('mcp-capability-context'));
    expect(sectionIds.indexOf('mcp-capability-context'))
      .toBeLessThan(sectionIds.indexOf('prompt-overlay'));
    expect(sectionIds.indexOf('prompt-overlay'))
      .toBeLessThan(sectionIds.indexOf('skills-addendum'));
  });

  it('project-agents is included when an AGENTS.md exists in the cwd', async () => {
    const cwd = await createTempDir('kodax-capsec-agents-');
    cleanupDirs.push(cwd);
    await fs.mkdir(path.join(cwd, '.kodax'), { recursive: true });
    await fs.writeFile(
      path.join(cwd, '.kodax', 'AGENTS.md'),
      '# Project rules\n- never use any',
      'utf8',
    );

    const sections = await buildCapabilityContextSections(
      makeOptions({ executionCwd: cwd, gitRoot: cwd }),
      false,
      cwd,
    );

    expect(ids(sections)).toContain('project-agents');
    const projectAgents = sections.find((s) => s.id === 'project-agents');
    expect(projectAgents?.content).toContain('never use any');
  });

  it('isNewSession=true triggers project-snapshot (best-effort, with cwd as project root)', async () => {
    const cwd = await createTempDir('kodax-capsec-new-');
    cleanupDirs.push(cwd);

    const sections = await buildCapabilityContextSections(
      makeOptions({ executionCwd: cwd, gitRoot: cwd }),
      true, // new session
      cwd,
    );

    // project-snapshot is best-effort; getProjectSnapshot always returns
    // at least `Project: <basename>`. Section presence is sufficient.
    expect(ids(sections)).toContain('project-snapshot');
  });

  it('working-directory section content reports the executionCwd verbatim', async () => {
    const cwd = await createTempDir('kodax-capsec-wd-');
    cleanupDirs.push(cwd);

    const sections = await buildCapabilityContextSections(
      makeOptions({ executionCwd: cwd, gitRoot: cwd }),
      false,
      cwd,
    );

    const wd = sections.find((s) => s.id === 'working-directory');
    expect(wd?.content).toBe(`Working Directory: ${cwd}`);
  });
});
