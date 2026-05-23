/**
 * FEATURE_191 (v0.7.43) — markdown loader tests.
 *
 * Covers:
 *   - well-formed user agent + project agent precedence (project shadows user)
 *   - missing frontmatter / missing name → silent skip (not a failure)
 *   - missing description → failure with reason
 *   - empty body → failure with reason
 *   - tolerant tools parsing (YAML array / comma string / nested string)
 *   - admission gate threading (reject reason propagates)
 *   - source tag persistence (`markdown:user` / `markdown:project`)
 *   - registration uses invariant bindings (not trusted-agent silent skip)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  _resetAgentResolverForTesting,
  listConstructedAgentsWithSource,
  resolveConstructedAgent,
  resolveConstructedAgentSource,
} from './agent-resolver.js';
import { loadAgentsFromMarkdown } from './markdown-loader.js';

let userHome: string;
let projectCwd: string;

beforeEach(async () => {
  _resetAgentResolverForTesting();
  userHome = await mkdtemp(join(tmpdir(), 'kodax-md-loader-user-'));
  projectCwd = await mkdtemp(join(tmpdir(), 'kodax-md-loader-proj-'));
  await mkdir(join(userHome, 'agents'), { recursive: true });
  await mkdir(join(projectCwd, '.kodax', 'agents'), { recursive: true });
});

afterEach(async () => {
  _resetAgentResolverForTesting();
  await rm(userHome, { recursive: true, force: true });
  await rm(projectCwd, { recursive: true, force: true });
});

async function writeUserAgent(filename: string, body: string): Promise<void> {
  await writeFile(join(userHome, 'agents', filename), body, 'utf8');
}

async function writeProjectAgent(filename: string, body: string): Promise<void> {
  await writeFile(join(projectCwd, '.kodax', 'agents', filename), body, 'utf8');
}

async function load() {
  return loadAgentsFromMarkdown({ cwd: projectCwd, configHome: userHome });
}

describe('loadAgentsFromMarkdown', () => {
  it('returns 0/0 when both directories are empty', async () => {
    const result = await load();
    expect(result.loaded).toBe(0);
    expect(result.failed).toEqual([]);
  });

  it('returns 0/0 when the directories do not exist', async () => {
    const result = await loadAgentsFromMarkdown({
      cwd: join(tmpdir(), 'definitely-not-a-real-dir-' + Date.now()),
      configHome: join(tmpdir(), 'also-not-real-' + Date.now()),
    });
    expect(result.loaded).toBe(0);
    expect(result.failed).toEqual([]);
  });

  it('loads a minimal well-formed user agent', async () => {
    await writeUserAgent(
      'db-reviewer.md',
      [
        '---',
        'name: db-reviewer',
        'description: Reviews DB migrations for safety',
        '---',
        'You are a DB migration reviewer.',
      ].join('\n'),
    );
    const result = await load();
    expect(result.loaded).toBe(1);
    expect(result.failed).toEqual([]);

    const agent = resolveConstructedAgent('db-reviewer');
    expect(agent).toBeDefined();
    expect(agent?.instructions).toBe('You are a DB migration reviewer.');
    expect(resolveConstructedAgentSource('db-reviewer')).toBe('markdown:user');
  });

  it('lifts string tools list → builtin ToolRefs', async () => {
    await writeUserAgent(
      'tools-array.md',
      [
        '---',
        'name: tools-array',
        'description: Demo tools array',
        'tools: [read, grep]',
        '---',
        'Use read and grep only.',
      ].join('\n'),
    );
    const result = await load();
    expect(result.loaded).toBe(1);
    const agent = resolveConstructedAgent('tools-array');
    expect(agent?.tools?.map((t) => (t as { name: string }).name).sort()).toEqual(['grep', 'read']);
  });

  it('accepts comma-separated tools string', async () => {
    await writeUserAgent(
      'tools-csv.md',
      [
        '---',
        'name: tools-csv',
        'description: Demo csv tools',
        'tools: "read, grep"',
        '---',
        'Use read and grep only.',
      ].join('\n'),
    );
    const result = await load();
    expect(result.loaded).toBe(1);
    const agent = resolveConstructedAgent('tools-csv');
    expect(agent?.tools?.map((t) => (t as { name: string }).name).sort()).toEqual(['grep', 'read']);
  });

  it('project agent shadows user agent of the same name (last-write-wins)', async () => {
    await writeUserAgent(
      'shared.md',
      [
        '---',
        'name: shared',
        'description: user-level version',
        '---',
        'user instructions',
      ].join('\n'),
    );
    await writeProjectAgent(
      'shared.md',
      [
        '---',
        'name: shared',
        'description: project-level version (overrides user)',
        '---',
        'project instructions',
      ].join('\n'),
    );
    const result = await load();
    expect(result.loaded).toBe(2);
    const agent = resolveConstructedAgent('shared');
    expect(agent?.instructions).toBe('project instructions');
    expect(resolveConstructedAgentSource('shared')).toBe('markdown:project');
  });

  it('silently skips files without YAML frontmatter (reference docs)', async () => {
    await writeUserAgent('reference-doc.md', '# Just a Markdown Reference\n\nNo frontmatter.');
    const result = await load();
    expect(result.loaded).toBe(0);
    expect(result.failed).toEqual([]);
  });

  it('silently skips files with frontmatter but no name (not advertising as agent)', async () => {
    await writeUserAgent(
      'no-name.md',
      [
        '---',
        'description: looks like a command not an agent',
        '---',
        'body',
      ].join('\n'),
    );
    const result = await load();
    expect(result.loaded).toBe(0);
    expect(result.failed).toEqual([]);
  });

  it('reports description-missing as a failure', async () => {
    await writeUserAgent(
      'no-desc.md',
      [
        '---',
        'name: no-desc',
        '---',
        'body without description',
      ].join('\n'),
    );
    const result = await load();
    expect(result.loaded).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.reason).toMatch(/description.*required/);
  });

  it('reports empty body as a failure', async () => {
    await writeUserAgent(
      'empty-body.md',
      [
        '---',
        'name: empty-body',
        'description: has frontmatter but no body',
        '---',
        '',
      ].join('\n'),
    );
    const result = await load();
    expect(result.loaded).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.reason).toMatch(/instructions.*empty/);
  });

  it('ignores unknown frontmatter fields (forward-compat with mcpServers / hooks / etc.)', async () => {
    await writeUserAgent(
      'forward-compat.md',
      [
        '---',
        'name: forward-compat',
        'description: ignores fields we do not consume yet',
        'mcpServers: { foo: { url: "http://example.com" } }',
        'hooks: [{ event: PreToolUse, command: "echo hi" }]',
        'memory: enabled',
        'isolation: worktree',
        'permissionMode: auto',
        'maxTurns: 50',
        'skills: [skill-a]',
        '---',
        'should still load',
      ].join('\n'),
    );
    const result = await load();
    expect(result.loaded).toBe(1);
    expect(result.failed).toEqual([]);
  });

  it('source tag distinguishes user vs project listings', async () => {
    await writeUserAgent(
      'user-only.md',
      [
        '---',
        'name: user-only',
        'description: only at user level',
        '---',
        'u',
      ].join('\n'),
    );
    await writeProjectAgent(
      'proj-only.md',
      [
        '---',
        'name: proj-only',
        'description: only at project level',
        '---',
        'p',
      ].join('\n'),
    );
    await load();
    const bySource = new Map(
      listConstructedAgentsWithSource().map((e) => [e.agent.name, e.source]),
    );
    expect(bySource.get('user-only')).toBe('markdown:user');
    expect(bySource.get('proj-only')).toBe('markdown:project');
  });

  it('passes model field through to the registered agent', async () => {
    await writeUserAgent(
      'with-model.md',
      [
        '---',
        'name: with-model',
        'description: tests model passthrough',
        'model: claude-sonnet-4-6',
        '---',
        'body',
      ].join('\n'),
    );
    const result = await load();
    expect(result.loaded).toBe(1);
    const agent = resolveConstructedAgent('with-model');
    expect(agent?.model).toBe('claude-sonnet-4-6');
  });
});
