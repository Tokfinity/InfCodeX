import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildMcpReverseCapabilities, mcpRootsFromWorkspace } from './mcp-reverse.js';

const fileUri = (dir: string): string => pathToFileURL(path.resolve(dir)).href;

describe('mcpRootsFromWorkspace', () => {
  it('exposes the cwd as a single file:// root named after its basename', () => {
    const cwd = path.resolve(path.join('some', 'project'));
    expect(mcpRootsFromWorkspace({ cwd })).toEqual([{ uri: fileUri(cwd), name: 'project' }]);
  });

  it('adds the git root when it differs, cwd first', () => {
    const cwd = path.resolve(path.join('repo', 'packages', 'app'));
    const gitRoot = path.resolve('repo');
    expect(mcpRootsFromWorkspace({ cwd, gitRoot })).toEqual([
      { uri: fileUri(cwd), name: 'app' },
      { uri: fileUri(gitRoot), name: 'repo' },
    ]);
  });

  it('de-duplicates when cwd === gitRoot', () => {
    const cwd = path.resolve('repo');
    expect(mcpRootsFromWorkspace({ cwd, gitRoot: cwd })).toEqual([{ uri: fileUri(cwd), name: 'repo' }]);
  });

  it('includes extra roots, de-duplicated', () => {
    const cwd = path.resolve('a');
    const extra = path.resolve('b');
    const roots = mcpRootsFromWorkspace({ cwd, extraRoots: [extra, cwd] });
    expect(roots.map((r) => r.uri)).toEqual([fileUri(cwd), fileUri(extra)]);
  });
});

describe('buildMcpReverseCapabilities', () => {
  it('returns a listRoots handler resolving to the workspace roots', async () => {
    const cwd = path.resolve(path.join('x', 'proj'));
    const reverse = buildMcpReverseCapabilities({ cwd });
    expect(reverse?.listRoots).toBeDefined();
    expect(await reverse?.listRoots?.()).toEqual([{ uri: fileUri(cwd), name: 'proj' }]);
  });
});
