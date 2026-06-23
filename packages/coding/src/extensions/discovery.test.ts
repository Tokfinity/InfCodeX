import os from 'os';
import path from 'path';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'fs/promises';
import { setAgentConfigHome } from '@kodax-ai/agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  dedupeExtensionPathsByEntrypoint,
  discoverDefaultExtensions,
  discoverExtensionsInDirectory,
  discoverExtensionsInDirectoryDetailed,
  excludeExtensionPathsByEntrypoint,
  getDefaultExtensionDirectory,
  resolveExtensionEntrypoint,
} from './discovery.js';

function isSymlinkPermissionError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && ((error as NodeJS.ErrnoException).code === 'EPERM'
      || (error as NodeJS.ErrnoException).code === 'EACCES');
}

describe('extension discovery', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-ext-discovery-'));
    setAgentConfigHome(tempDir);
  });

  afterEach(async () => {
    setAgentConfigHome(undefined);
    await rm(tempDir, { recursive: true, force: true });
  });

  it('resolves a directory extension package to its entry module', async () => {
    const extensionDir = path.join(tempDir, 'pdf4agent');
    await mkdir(extensionDir, { recursive: true });
    await writeFile(path.join(extensionDir, 'index.mjs'), 'export default function() {}', 'utf8');
    await writeFile(path.join(extensionDir, 'extension.mjs'), 'export default function() {}', 'utf8');

    await expect(resolveExtensionEntrypoint(extensionDir))
      .resolves
      .toBe(path.join(extensionDir, 'extension.mjs'));
  });

  it('skips entrypoint-shaped directories when resolving package entry', async () => {
    const extensionDir = path.join(tempDir, 'dir-entry');
    await mkdir(path.join(extensionDir, 'extension.mjs'), { recursive: true });
    await writeFile(path.join(extensionDir, 'index.mjs'), 'export default function() {}', 'utf8');

    await expect(resolveExtensionEntrypoint(extensionDir))
      .resolves
      .toBe(path.join(extensionDir, 'index.mjs'));
  });

  it('dedupes and excludes equivalent directory and entrypoint paths by resolved entrypoint', async () => {
    const extensionDir = path.join(tempDir, 'pdf4agent');
    const entrypoint = path.join(extensionDir, 'extension.mjs');
    await mkdir(extensionDir, { recursive: true });
    await writeFile(entrypoint, 'export default function() {}', 'utf8');

    await expect(dedupeExtensionPathsByEntrypoint([extensionDir, entrypoint]))
      .resolves
      .toEqual([extensionDir]);
    await expect(excludeExtensionPathsByEntrypoint([entrypoint], [extensionDir]))
      .resolves
      .toEqual([]);
  });

  it('dedupes symlinked package paths against their real entrypoint', async () => {
    const root = path.join(tempDir, 'extensions');
    const target = path.join(tempDir, 'linked-target');
    const entrypoint = path.join(target, 'extension.mjs');
    const link = path.join(root, 'linked-pdf4agent');
    await mkdir(target, { recursive: true });
    await mkdir(root, { recursive: true });
    await writeFile(entrypoint, 'export default function() {}', 'utf8');
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(dedupeExtensionPathsByEntrypoint([link, entrypoint]))
      .resolves
      .toEqual([link]);
    await expect(excludeExtensionPathsByEntrypoint([link], [entrypoint]))
      .resolves
      .toEqual([]);
  });

  it('discovers symlinked directory extension packages', async () => {
    const root = path.join(tempDir, 'extensions');
    const target = path.join(tempDir, 'linked-target');
    const link = path.join(root, 'linked-pdf4agent');
    await mkdir(target, { recursive: true });
    await mkdir(root, { recursive: true });
    await writeFile(path.join(target, 'extension.mjs'), 'export default function() {}', 'utf8');
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(discoverExtensionsInDirectory(root)).resolves.toEqual([
      path.join(link, 'extension.mjs'),
    ]);
  });

  it('discovers symlinked extension files when the filesystem allows file symlinks', async () => {
    const root = path.join(tempDir, 'extensions');
    const target = path.join(tempDir, 'target.mjs');
    const link = path.join(root, 'linked.mjs');
    await mkdir(root, { recursive: true });
    await writeFile(target, 'export default function() {}', 'utf8');
    try {
      await symlink(target, link, 'file');
    } catch (error) {
      if (isSymlinkPermissionError(error)) {
        return;
      }
      throw error;
    }

    await expect(discoverExtensionsInDirectory(root)).resolves.toEqual([link]);
  });

  it('discovers package directories and standalone modules in name order', async () => {
    const root = path.join(tempDir, 'extensions');
    await mkdir(path.join(root, 'alpha'), { recursive: true });
    await mkdir(path.join(root, 'ignored'), { recursive: true });
    await mkdir(path.join(root, 'zeta'), { recursive: true });
    await writeFile(path.join(root, 'alpha', 'extension.mjs'), 'export default function() {}', 'utf8');
    await writeFile(path.join(root, 'beta.mjs'), 'export default function() {}', 'utf8');
    await writeFile(path.join(root, 'zeta', 'index.ts'), 'export default function() {}', 'utf8');
    await writeFile(path.join(root, 'note.txt'), 'not an extension', 'utf8');

    await expect(discoverExtensionsInDirectory(root)).resolves.toEqual([
      path.join(root, 'alpha', 'extension.mjs'),
      path.join(root, 'beta.mjs'),
      path.join(root, 'zeta', 'index.ts'),
    ]);
  });

  it('reports skipped entries through detailed discovery', async () => {
    const root = path.join(tempDir, 'extensions');
    await mkdir(path.join(root, 'empty-package'), { recursive: true });
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, 'notes.py'), 'print("not an extension")', 'utf8');

    const result = await discoverExtensionsInDirectoryDetailed(root);

    expect(result.paths).toEqual([]);
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: path.join(root, 'empty-package'),
        reason: 'missing_entrypoint',
      }),
      expect.objectContaining({
        path: path.join(root, 'notes.py'),
        reason: 'unsupported_module',
      }),
    ]));
  });

  it('uses the configured KodaX home for the default extension directory', async () => {
    const extensionDir = path.join(tempDir, 'extensions', 'auto');
    const entrypoint = path.join(extensionDir, 'extension.mjs');
    await mkdir(extensionDir, { recursive: true });
    await writeFile(entrypoint, 'export default function() {}', 'utf8');

    expect(getDefaultExtensionDirectory()).toBe(path.join(tempDir, 'extensions'));
    await expect(discoverDefaultExtensions()).resolves.toEqual([entrypoint]);
  });

  it('treats a missing default extension directory as empty', async () => {
    await expect(discoverExtensionsInDirectory(path.join(tempDir, 'missing'))).resolves.toEqual([]);
  });
});
