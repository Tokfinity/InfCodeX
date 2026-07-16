import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createNestedWorkflowResolver, defaultSavedWorkflowDirs } from './nested-resolver.js';

describe('createNestedWorkflowResolver (FEATURE_246 Part E)', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('resolves a built-in workflow by name', async () => {
    const resolve = createNestedWorkflowResolver(process.cwd());
    const module = await resolve('parallel-investigation');
    expect(module?.meta.name).toBe('parallel-investigation');
    expect(typeof module?.run).toBe('function');
  });

  it('returns undefined for an unknown name', async () => {
    const resolve = createNestedWorkflowResolver(process.cwd());
    expect(await resolve('no-such-workflow')).toBeUndefined();
  });

  it('derives project + personal saved dirs from the cwd', () => {
    const dirs = defaultSavedWorkflowDirs('/proj');
    expect(dirs.project).toBe(join('/proj', '.kodax', 'workflows'));
    expect(dirs.personal?.endsWith(join('.kodax', 'workflows'))).toBe(true);
  });

  it('resolves a saved workflow capsule by name from the project dir', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kodax-nested-resolver-'));
    tmpDirs.push(root);
    const wfDir = join(root, '.kodax', 'workflows');
    mkdirSync(wfDir, { recursive: true });
    // A minimal saved workflow module (ESM default export { meta, run }).
    writeFileSync(
      join(wfDir, 'my-saved.mjs'),
      [
        'export default {',
        "  meta: { name: 'my-saved', description: 'saved test workflow' },",
        '  run: async () => ({ ok: true }),',
        '};',
        '',
      ].join('\n'),
      'utf8',
    );

    const resolve = createNestedWorkflowResolver(root);
    const module = await resolve('my-saved');
    expect(module?.meta.name).toBe('my-saved');
  });

  it('prefers a built-in over a saved capsule of the same name', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kodax-nested-resolver-'));
    tmpDirs.push(root);
    const wfDir = join(root, '.kodax', 'workflows');
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(
      join(wfDir, 'parallel-investigation.mjs'),
      "export default { meta: { name: 'parallel-investigation', description: 'shadow' }, run: async () => 'shadow' };\n",
      'utf8',
    );
    const resolve = createNestedWorkflowResolver(root);
    const module = await resolve('parallel-investigation');
    // The trusted built-in wins; the same-named saved capsule does not shadow it.
    expect(module?.meta.description).not.toBe('shadow');
  });
});
