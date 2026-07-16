#!/usr/bin/env node
// FEATURE_147 (v0.7.37) — exclude .test.ts(x) from each package's
// production tsc output, to keep the published tarballs lean.
//
// vitest runs from the source via tsx and is unaffected by tsc exclude.
// Idempotent: re-running adds nothing if exclude already covers tests.

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const packagesDir = path.join(repoRoot, 'packages');

const TEST_GLOBS = [
  '**/*.test.ts',
  '**/*.test.tsx',
  '**/__tests__/**',
];

function patchTsconfig(file) {
  const raw = readFileSync(file, 'utf8');
  const cfg = JSON.parse(raw);
  const before = JSON.stringify(cfg);
  cfg.exclude = cfg.exclude ?? [];
  for (const glob of TEST_GLOBS) {
    if (!cfg.exclude.includes(glob)) cfg.exclude.push(glob);
  }
  const after = JSON.stringify(cfg);
  if (before === after) {
    return { changed: false, file };
  }
  writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return { changed: true, file };
}

function main() {
  const results = [];
  for (const name of readdirSync(packagesDir)) {
    const dir = path.join(packagesDir, name);
    if (!statSync(dir).isDirectory()) continue;
    const tsconfig = path.join(dir, 'tsconfig.json');
    try {
      statSync(tsconfig);
    } catch {
      continue;
    }
    results.push(patchTsconfig(tsconfig));
  }
  for (const r of results) {
    console.log(`${r.changed ? 'patched' : '  noop '} ${path.relative(repoRoot, r.file)}`);
  }
  console.log(`\n${results.filter((r) => r.changed).length} of ${results.length} tsconfig.json files updated.`);
}

main();
