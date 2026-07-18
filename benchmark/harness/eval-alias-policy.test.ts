import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LEGACY_ROUTES = /zhipu\/glm51|mmx\/m27|zhipu-coding[^\n]*glm-5\.1|minimax-coding[^\n]*MiniMax-M2\.7/;

function sourceFiles(root: string, accepts: (name: string) => boolean): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === '_archive') continue;
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(absolute, accepts));
    else if (accepts(entry.name)) files.push(absolute);
  }
  return files;
}

describe('current eval alias policy', () => {
  it('keeps legacy Zhipu and MiniMax routes out of active eval sources', () => {
    const files = [
      ...sourceFiles(path.join(REPO_ROOT, 'tests'), (name) => name.endsWith('.eval.ts')),
      ...sourceFiles(path.join(REPO_ROOT, 'benchmark/datasets'), (name) => name.endsWith('.ts')),
    ];
    const violations = files
      .filter((file) => LEGACY_ROUTES.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(REPO_ROOT, file));

    expect(violations).toEqual([]);
  });
});
