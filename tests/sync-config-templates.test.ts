import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const tempRoots: string[] = [];
const copiedFiles = [
  'scripts/sync-config-templates.mjs',
  'config-templates/config.example.jsonc',
  'config-templates/integrations/mcp.example.jsonc',
  'config-templates/integrations/a2a.example.jsonc',
  'config-templates/integrations/extensions.example.jsonc',
  'config.example.jsonc',
  'packages/repl/src/common/generated-config-templates.ts',
] as const;

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('config template synchronization', () => {
  it('accepts a Windows CRLF checkout without reporting generated drift', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-config-sync-'));
    tempRoots.push(root);
    for (const relativePath of copiedFiles) {
      const target = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const source = fs.readFileSync(path.resolve(relativePath), 'utf8');
      fs.writeFileSync(target, source.replace(/\r\n?/g, '\n').replaceAll('\n', '\r\n'));
    }

    const result = spawnSync(
      process.execPath,
      [path.join(root, 'scripts/sync-config-templates.mjs'), '--check'],
      { cwd: root, encoding: 'utf8' },
    );

    expect(result.status, result.stderr).toBe(0);
  });
});
