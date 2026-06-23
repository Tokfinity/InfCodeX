import os from 'os';
import path from 'path';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { setAgentConfigHome } from '@kodax-ai/agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  discoverExtensionsInDirectory,
  getDefaultExtensionDirectory,
  resolveExtensionEntrypoint,
} from './discovery.js';

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

  it('uses the configured KodaX home for the default extension directory', () => {
    expect(getDefaultExtensionDirectory()).toBe(path.join(tempDir, 'extensions'));
  });

  it('treats a missing default extension directory as empty', async () => {
    await expect(discoverExtensionsInDirectory(path.join(tempDir, 'missing'))).resolves.toEqual([]);
  });
});
