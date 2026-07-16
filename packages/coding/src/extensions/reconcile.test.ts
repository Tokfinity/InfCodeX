import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createExtensionRuntime } from './runtime.js';

const roots: string[] = [];

async function extension(root: string, name: string, tool: string): Promise<string> {
  const file = path.join(root, `${name}.mjs`);
  await writeFile(file, `export default function(api) {
    api.registerTool({
      name: '${tool}', description: '${tool}',
      input_schema: { type: 'object', properties: {} },
      handler: async () => '${tool}'
    });
  }`, 'utf8');
  return file;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('Extension configuration reconciliation', () => {
  it('applies valid entries, retains a failed entry, and removes omitted entries independently', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-extension-reconcile-'));
    roots.push(root);
    const retained = await extension(root, 'retained', 'retained_tool');
    const removed = await extension(root, 'removed', 'removed_tool');
    const added = await extension(root, 'added', 'added_tool');
    const runtime = createExtensionRuntime();
    try {
      await runtime.reconcileExtensions([retained, removed], { loadSource: 'config' });
      await writeFile(retained, 'export default function() { throw new Error("broken candidate"); }', 'utf8');

      const result = await runtime.reconcileExtensions([retained, added], { loadSource: 'config' });

      expect(result).toEqual({ applied: 1, retained: 1, removed: 1 });
      expect(runtime.getDiagnostics().loadedExtensions.map((entry) => entry.path).sort())
        .toEqual([path.resolve(added), path.resolve(retained)].sort());
      expect(runtime.getDiagnostics().failures.at(-1))
        .toEqual(expect.objectContaining({ target: path.resolve(retained), stage: 'reload' }));
    } finally {
      await runtime.dispose();
    }
  });
});
