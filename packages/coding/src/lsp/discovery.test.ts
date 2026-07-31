import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findNearestRoot, resolveNodePackageBin, resolveTsserver, whichGlobal } from './discovery.js';

describe('findNearestRoot', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-lsp-root-'));
  });
  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    dir = '';
  });

  it('returns the directory holding the nearest marker', async () => {
    const nested = path.join(dir, 'a', 'b', 'c');
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(dir, 'a', 'tsconfig.json'), '{}', 'utf8');
    const found = findNearestRoot(path.join(nested, 'file.ts'), ['tsconfig.json'], dir);
    expect(found).toBe(path.join(dir, 'a'));
  });

  it('falls back to stopDir when no marker is found', async () => {
    const nested = path.join(dir, 'x', 'y');
    await fs.mkdir(nested, { recursive: true });
    const found = findNearestRoot(path.join(nested, 'file.ts'), ['tsconfig.json'], dir);
    expect(found).toBe(dir);
  });

  it('returns stopDir when the file is outside it', () => {
    const found = findNearestRoot('/somewhere/else/file.ts', ['tsconfig.json'], dir);
    expect(found).toBe(path.resolve(dir));
  });
});

describe('resolveNodePackageBin', () => {
  it('returns undefined for a package that is not installed', () => {
    expect(resolveNodePackageBin('definitely-not-a-real-lsp-xyz', process.cwd())).toBeUndefined();
  });

  it('marks project-local package bins as JavaScript children', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-lsp-package-'));
    try {
      const packageDir = path.join(root, 'node_modules', 'example-lsp');
      await fs.mkdir(packageDir, { recursive: true });
      await fs.writeFile(
        path.join(packageDir, 'package.json'),
        JSON.stringify({ name: 'example-lsp', bin: 'server.js' }),
        'utf8',
      );
      await fs.writeFile(path.join(packageDir, 'server.js'), '', 'utf8');

      expect(resolveNodePackageBin('example-lsp', root)).toMatchObject({
        command: process.execPath,
        args: [path.join(packageDir, 'server.js')],
        kind: 'javascript',
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('resolveTsserver', () => {
  const bogusRoot = path.join(os.tmpdir(), 'kodax-no-such-root');

  it('resolves a bundled typescript via the fallback module url', () => {
    // @kodax-ai/coding depends on typescript, so the fallback resolves even
    // when the (bogus) project root has none.
    const tsserver = resolveTsserver(bogusRoot, import.meta.url);
    expect(tsserver).toBeDefined();
    expect(tsserver).toMatch(/tsserver\.js$/);
  });

  it('returns undefined when neither project nor fallback has typescript', () => {
    expect(resolveTsserver(bogusRoot, undefined)).toBeUndefined();
  });
});

describe('whichGlobal', () => {
  it('returns undefined for a command that does not exist', () => {
    expect(whichGlobal('kodax-nonexistent-binary-xyz')).toBeUndefined();
  });
});
