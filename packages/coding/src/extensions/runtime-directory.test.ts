import os from 'os';
import path from 'path';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { listPluginSkillPaths } from '@kodax-ai/agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeTool } from '../tools/index.js';
import type { KodaXToolExecutionContext } from '../types.js';
import { createExtensionRuntime, getActiveExtensionRuntime } from './index.js';

describe('KodaXExtensionRuntime directory packages', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-ext-dir-'));
  });

  afterEach(async () => {
    const runtime = getActiveExtensionRuntime();
    if (runtime) {
      await runtime.dispose();
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it('loads a package directory and resolves skill paths from the package root', async () => {
    const extensionDir = path.join(tempDir, 'pdf4agent');
    const skillDir = path.join(extensionDir, 'skills');
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(extensionDir, 'extension.mjs'),
      `export default function(api) {
        api.registerTool({
          name: 'package_echo',
          description: 'Echo text from a directory extension package',
          input_schema: {
            type: 'object',
            properties: {
              text: { type: 'string' }
            },
            required: ['text']
          },
          sideEffect: 'readonly',
          handler: async (input) => 'package:' + String(input.text)
        });
        api.registerSkillPath('./skills');
      }`,
      'utf8',
    );

    const runtime = createExtensionRuntime().activate();
    await runtime.loadExtension(extensionDir, { loadSource: 'discovery' });

    const ctx: KodaXToolExecutionContext = {
      backups: new Map(),
      executionCwd: tempDir,
      gitRoot: tempDir,
    };

    await expect(
      executeTool('package_echo', { text: 'hello' }, ctx),
    ).resolves.toBe('package:hello');
    expect(listPluginSkillPaths()).toContain(skillDir);
    expect(runtime.getDiagnostics().loadedExtensions).toEqual([
      expect.objectContaining({
        path: path.join(extensionDir, 'extension.mjs'),
        label: 'pdf4agent',
        loadSource: 'discovery',
      }),
    ]);
  });
});
