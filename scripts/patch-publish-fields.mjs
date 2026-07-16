#!/usr/bin/env node
// FEATURE_147 (v0.7.37) Phase 4.2 — patch publish-only fields into all
// packages /<pkg>/package.json files in one shot:
//
//   - `files: ["dist", "README.md", "LICENSE"]` — keep tarballs lean
//   - `publishConfig: { access: "public" }` — scoped packages default to
//     restricted unless this is set
//   - rewrite all internal `@kodax-ai/...` deps from "*" (workspace
//     wildcard, fine locally but resolves to nothing on npm.com) to
//     "workspace:^" (npm 9+ expands at publish time to ^<version>)
//
// Idempotent. Safe to re-run.

import { readFileSync, writeFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const packagesDir = path.join(repoRoot, 'packages');

const FILES_FIELD = ['dist', 'README.md', 'LICENSE'];
const PUBLISH_CONFIG = { access: 'public' };

function patchOne(pkgJsonPath) {
  const raw = readFileSync(pkgJsonPath, 'utf8');
  const pkg = JSON.parse(raw);

  const before = JSON.stringify(pkg);

  // 1. files
  if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
    pkg.files = FILES_FIELD;
  } else {
    // Merge: keep whatever the package already declared, plus our additions
    const merged = new Set([...pkg.files, ...FILES_FIELD]);
    pkg.files = [...merged];
  }

  // 2. publishConfig
  pkg.publishConfig = { ...PUBLISH_CONFIG, ...(pkg.publishConfig || {}) };

  // 3. internal dep rewrites: dependencies / peerDependencies / optionalDependencies
  // FEATURE_147 v0.7.37 — npm 11 does NOT support `workspace:^` protocol
  // at install time (EUNSUPPORTEDPROTOCOL from npm-package-arg). Keep
  // `"*"` as the local spec so monorepo install works; the publish
  // script substitutes `^<currentVersion>` into the published tarball
  // and restores `*` afterwards.
  for (const depKey of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    if (!pkg[depKey]) continue;
    for (const [name, spec] of Object.entries(pkg[depKey])) {
      if (!name.startsWith('@kodax-ai/')) continue;
      // Normalize any non-`*` internal spec back to `*` so the local
      // workspace install path is uniform. Publish-time substitution
      // happens in scripts/release-npm.mjs.
      if (typeof spec === 'string' && spec !== '*') {
        pkg[depKey][name] = '*';
      }
    }
  }

  const after = JSON.stringify(pkg);
  if (before === after) {
    return { changed: false, path: pkgJsonPath };
  }

  writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  return { changed: true, path: pkgJsonPath };
}

function main() {
  const entries = readdirSync(packagesDir);
  const results = [];
  for (const name of entries) {
    const pkgDir = path.join(packagesDir, name);
    if (!statSync(pkgDir).isDirectory()) continue;
    const pkgJson = path.join(pkgDir, 'package.json');
    try {
      statSync(pkgJson);
    } catch {
      continue;
    }
    results.push(patchOne(pkgJson));
  }
  for (const r of results) {
    console.log(`${r.changed ? 'patched' : '  noop '} ${path.relative(repoRoot, r.path)}`);
  }
  console.log(`\n${results.filter((r) => r.changed).length} of ${results.length} package.json files updated.`);
}

main();
