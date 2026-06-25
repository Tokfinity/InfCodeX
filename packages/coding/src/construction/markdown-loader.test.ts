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
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  _resetAgentResolverForTesting,
  listConstructedAgents,
  listConstructedAgentsWithSource,
  resolveConstructedAgent,
  resolveConstructedAgentSource,
} from './agent-resolver.js';
import { discoverMarkdownAgents, loadAgentsFromMarkdown } from './markdown-loader.js';

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

  it('passes effort field through to the registered agent', async () => {
    await writeUserAgent(
      'with-effort.md',
      [
        '---',
        'name: with-effort',
        'description: tests effort passthrough',
        'effort: high',
        '---',
        'body',
      ].join('\n'),
    );
    const result = await load();
    expect(result.loaded).toBe(1);
    const agent = resolveConstructedAgent('with-effort');
    expect(agent?.effort).toBe('high');
  });

  it('normalizes effort field before registering the agent', async () => {
    await writeUserAgent(
      'with-normalized-effort.md',
      [
        '---',
        'name: with-normalized-effort',
        'description: tests effort normalization',
        'effort: " High "',
        '---',
        'body',
      ].join('\n'),
    );
    const result = await load();
    expect(result.loaded).toBe(1);
    const agent = resolveConstructedAgent('with-normalized-effort');
    expect(agent?.effort).toBe('high');
  });

  it('reports invalid effort frontmatter before admission', async () => {
    await writeUserAgent(
      'bad-effort.md',
      [
        '---',
        'name: bad-effort',
        'description: tests effort validation',
        'effort: high now',
        '---',
        'body',
      ].join('\n'),
    );
    const result = await load();
    expect(result.loaded).toBe(0);
    expect(result.failed[0]?.reason).toContain('frontmatter "effort" is invalid');
  });
});

/**
 * FEATURE_197 (v0.7.43) — read-only discovery API. Mirrors the
 * loader's parse + filter semantics but performs zero admission /
 * registration so SDK consumers can list available agents without
 * mutating the in-memory registry.
 */
describe('discoverMarkdownAgents', () => {
  async function discover() {
    return discoverMarkdownAgents({ cwd: projectCwd, configHome: userHome });
  }

  it('returns empty result when both directories are empty', async () => {
    const result = await discover();
    expect(result.agents).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it('returns empty result when directories do not exist', async () => {
    const result = await discoverMarkdownAgents({
      cwd: join(tmpdir(), 'definitely-not-a-real-dir-' + Date.now()),
      configHome: join(tmpdir(), 'also-not-real-' + Date.now()),
    });
    expect(result.agents).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it('discovers a minimal well-formed user agent and returns an absolute path', async () => {
    await writeUserAgent(
      'db-reviewer.md',
      [
        '---',
        'name: db-reviewer',
        'description: Reviews DB migrations for safety',
        '---',
        'You are a migration reviewer.',
      ].join('\n'),
    );
    const result = await discover();

    expect(result.failed).toEqual([]);
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]).toMatchObject({
      name: 'db-reviewer',
      description: 'Reviews DB migrations for safety',
      source: 'markdown:user',
    });
    expect(result.agents[0].path).toContain('db-reviewer.md');
    // API contract: `DiscoveredMarkdownAgent.path` is always absolute.
    expect(isAbsolute(result.agents[0].path)).toBe(true);
  });

  it('does NOT register or mutate the agent registry (read-only contract)', async () => {
    // Establish a non-zero baseline so the post-discover assertion is
    // not trivially `0 === 0`. We load one agent via the side-effect
    // loader so the registry has real state to protect.
    await writeUserAgent(
      'seed.md',
      [
        '---',
        'name: seed',
        'description: pre-existing registry entry',
        '---',
        'seed body',
      ].join('\n'),
    );
    const loadResult = await load();
    expect(loadResult.loaded).toBe(1);
    expect(resolveConstructedAgent('seed')).toBeDefined();
    const baselineCount = listConstructedAgents().length;
    expect(baselineCount).toBeGreaterThan(0);

    // Now add a distinct agent file and discover. Discover MUST NOT
    // register `target` into the registry, and MUST NOT touch the
    // existing `seed` entry.
    await writeUserAgent(
      'target.md',
      [
        '---',
        'name: target',
        'description: discover but do not register me',
        '---',
        'target body',
      ].join('\n'),
    );
    const discoverResult = await discover();

    // Discover sees both files (seed already exists + target new).
    expect(discoverResult.agents.map((a) => a.name).sort()).toEqual(['seed', 'target']);

    // Registry count unchanged from the load-only baseline.
    expect(listConstructedAgents().length).toBe(baselineCount);
    // target was NOT registered.
    expect(resolveConstructedAgent('target')).toBeUndefined();
    // seed is still the original registration (not re-registered).
    expect(resolveConstructedAgent('seed')).toBeDefined();
  });

  it('tags project agents with source markdown:project', async () => {
    await writeProjectAgent(
      'fixer.md',
      [
        '---',
        'name: fixer',
        'description: Fixes things',
        '---',
        'body',
      ].join('\n'),
    );
    const result = await discover();
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]).toMatchObject({
      name: 'fixer',
      source: 'markdown:project',
    });
  });

  it('project shadows user when names collide (last-write-wins, parity with loader)', async () => {
    await writeUserAgent(
      'reviewer.md',
      [
        '---',
        'name: reviewer',
        'description: USER description',
        '---',
        'user body',
      ].join('\n'),
    );
    await writeProjectAgent(
      'reviewer.md',
      [
        '---',
        'name: reviewer',
        'description: PROJECT description',
        '---',
        'project body',
      ].join('\n'),
    );
    const result = await discover();
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]).toMatchObject({
      name: 'reviewer',
      description: 'PROJECT description',
      source: 'markdown:project',
    });
  });

  it('reports description missing as a failure (not a silent skip)', async () => {
    await writeUserAgent(
      'no-desc.md',
      [
        '---',
        'name: no-desc',
        '---',
        'body',
      ].join('\n'),
    );
    const result = await discover();
    expect(result.agents).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].reason).toMatch(/description/);
  });

  it('silently skips files without frontmatter (reference doc convention)', async () => {
    await writeUserAgent('readme-like.md', '# Some doc, no frontmatter\n\nbody');
    const result = await discover();
    expect(result.agents).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it('silently skips files with frontmatter but no name', async () => {
    await writeUserAgent(
      'no-name.md',
      [
        '---',
        'description: missing name field',
        '---',
        'body',
      ].join('\n'),
    );
    const result = await discover();
    expect(result.agents).toEqual([]);
    expect(result.failed).toEqual([]);
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
    const result = await discover();
    expect(result.agents).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].reason).toMatch(/body/);
  });

  it('exposes raw tool names without the builtin: prefix (yaml array form)', async () => {
    await writeUserAgent(
      'with-tools.md',
      [
        '---',
        'name: with-tools',
        'description: tool advertisement',
        'tools: [read, grep, write]',
        '---',
        'body',
      ].join('\n'),
    );
    const result = await discover();
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].tools).toEqual(['read', 'grep', 'write']);
  });

  it('exposes raw tool names from comma-separated string form', async () => {
    await writeUserAgent(
      'with-tools-csv.md',
      [
        '---',
        'name: with-tools-csv',
        'description: csv tool form',
        'tools: "read, grep"',
        '---',
        'body',
      ].join('\n'),
    );
    const result = await discover();
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].tools).toEqual(['read', 'grep']);
  });

  it('exposes model alias from frontmatter', async () => {
    await writeUserAgent(
      'with-model.md',
      [
        '---',
        'name: with-model',
        'description: model alias passthrough',
        'model: claude-sonnet-4-6',
        '---',
        'body',
      ].join('\n'),
    );
    const result = await discover();
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].model).toBe('claude-sonnet-4-6');
  });

  it('exposes effort from frontmatter', async () => {
    await writeUserAgent(
      'with-effort.md',
      [
        '---',
        'name: with-effort',
        'description: effort passthrough',
        'effort: xhigh',
        '---',
        'body',
      ].join('\n'),
    );
    const result = await discover();
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].effort).toBe('xhigh');
  });

  it('does NOT validate admission (returns agents loader would later reject)', async () => {
    // Reference an unknown tool — loader would reject this at admission,
    // but discover should still surface it for UI preview. Discovery's
    // purpose is "what's on disk", not "what will load successfully".
    await writeUserAgent(
      'bad-tool.md',
      [
        '---',
        'name: bad-tool',
        'description: references a tool that does not exist',
        'tools: [definitely-not-a-real-tool]',
        '---',
        'body',
      ].join('\n'),
    );
    const result = await discover();
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].name).toBe('bad-tool');
    expect(result.agents[0].tools).toEqual(['definitely-not-a-real-tool']);
  });

  it('accumulates failures across multiple bad files', async () => {
    await writeUserAgent(
      'bad1.md',
      ['---', 'name: bad1', '---', 'body'].join('\n'),
    );
    await writeProjectAgent(
      'bad2.md',
      ['---', 'name: bad2', 'description: ""', '---', 'body'].join('\n'),
    );
    const result = await discover();
    expect(result.agents).toEqual([]);
    expect(result.failed).toHaveLength(2);
    expect(result.failed.every((f) => /description/.test(f.reason))).toBe(true);
  });

  it('agrees with loader on which files are well-formed (round-trip parity)', async () => {
    // Both well-formed and both ill-formed files in the mix.
    await writeUserAgent(
      'good1.md',
      ['---', 'name: good1', 'description: ok', '---', 'body'].join('\n'),
    );
    await writeUserAgent(
      'bad.md',
      ['---', 'name: bad', '---', 'body'].join('\n'),
    );
    await writeProjectAgent(
      'good2.md',
      ['---', 'name: good2', 'description: ok', '---', 'body'].join('\n'),
    );

    const discovered = await discover();
    const loaded = await load();

    // Same well-formed count
    expect(discovered.agents.length).toBe(loaded.loaded);
    // Same failure paths (set equality)
    expect(new Set(discovered.failed.map((f) => f.path))).toEqual(
      new Set(loaded.failed.map((f) => f.path)),
    );
    // Discovered names match registered names
    expect(new Set(discovered.agents.map((a) => a.name))).toEqual(
      new Set(listConstructedAgentsWithSource().map((e) => e.agent.name)),
    );
  });
});
