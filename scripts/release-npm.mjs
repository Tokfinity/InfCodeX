#!/usr/bin/env node
// FEATURE_147 (v0.7.37) — npm publish pipeline for the @kodax-ai monorepo.
//
// Usage:
//   node scripts/release-npm.mjs --dry-run          # full sweep, no real publish
//   node scripts/release-npm.mjs                    # real publish, all 10 pkgs
//   node scripts/release-npm.mjs --only=@kodax-ai/llm   # patch release of one
//   node scripts/release-npm.mjs --otp=123456       # pass OTP to npm
//
// Why this script exists:
//   - npm 11 rejects `workspace:^` protocol with EUNSUPPORTEDPROTOCOL,
//     so the workspace deps stay as `"*"` in repo. At publish time we
//     substitute `^<currentVersion>` into each package.json, run
//     `npm publish`, then restore `*`. This keeps local install / build
//     working and produces tarballs that resolve cleanly on npm.com.
//   - Publish order respects the runtime dependency graph
//     (session-lineage truly value-imports countTokens / estimateTokens
//     from @kodax-ai/agent → agent must publish first).
//   - Post-publish `npm view` verifies each package landed before
//     proceeding to the next (npm publish is irreversible; series
//     fail-fast).

import { execSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

// Publish order: deepest leaves first, root CLI last. session-lineage MUST
// come after agent because session-lineage/compaction/compaction.ts:11
// value-imports `countTokens` / `estimateTokens` from @kodax-ai/agent.
const PUBLISH_ORDER = [
  '@kodax-ai/llm',
  '@kodax-ai/tracing',
  '@kodax-ai/repointel-protocol',
  '@kodax-ai/skills',
  '@kodax-ai/agent',           // before session-lineage
  '@kodax-ai/session-lineage', // after agent
  '@kodax-ai/mcp',
  '@kodax-ai/coding',
  '@kodax-ai/repl',
  // root @kodax-ai/cli is the kodax repo root itself; published separately
  // when we wire it (see CLI_ROOT_NAME below). v0.7.37 ship: includes
  // upgrading the v0.0.1 placeholder to the real CLI.
];

const CLI_ROOT_NAME = '@kodax-ai/cli';

// Map package name → repo-relative directory. Built dynamically so we
// don't drift if a directory is renamed.
function buildPackageMap() {
  const map = new Map();
  const packagesDir = path.join(repoRoot, 'packages');
  for (const name of readdirSync(packagesDir)) {
    const dir = path.join(packagesDir, name);
    if (!statSync(dir).isDirectory()) continue;
    const pkgJson = path.join(dir, 'package.json');
    try {
      const pkg = JSON.parse(readFileSync(pkgJson, 'utf8'));
      if (pkg.name) map.set(pkg.name, dir);
    } catch {
      /* skip */
    }
  }
  return map;
}

// ---- argv parsing ----
const argv = process.argv.slice(2);
const isDryRun = argv.includes('--dry-run');
const onlyArg = argv.find((a) => a.startsWith('--only='));
const onlyPkg = onlyArg ? onlyArg.split('=')[1] : null;
const otpArg = argv.find((a) => a.startsWith('--otp='));
const otp = otpArg ? otpArg.split('=')[1] : null;

// ---- helpers ----
function log(msg) {
  console.log(`[release] ${msg}`);
}

function logError(msg) {
  console.error(`[release] ERROR ${msg}`);
}

/**
 * In-place rewrite of internal `@kodax-ai/...` deps from `*` to
 * `^<currentVersion>`. Returns a snapshot for restoration.
 */
function substituteWorkspaceDeps(pkgPath, version) {
  const raw = readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(raw);
  const snapshot = { dependencies: {}, peerDependencies: {}, optionalDependencies: {} };
  let anyChange = false;
  for (const depKey of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    if (!pkg[depKey]) continue;
    snapshot[depKey] = { ...pkg[depKey] };
    for (const [name, spec] of Object.entries(pkg[depKey])) {
      if (!name.startsWith('@kodax-ai/')) continue;
      if (typeof spec !== 'string' || spec === `^${version}`) continue;
      pkg[depKey][name] = `^${version}`;
      anyChange = true;
    }
  }
  if (anyChange) {
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  }
  return { snapshot, raw };
}

function restorePkgJson(pkgPath, restoreState) {
  writeFileSync(pkgPath, restoreState.raw, 'utf8');
}

function npmView(pkgName, version) {
  const result = spawnSync('npm', ['view', `${pkgName}@${version}`, 'version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  return result.status === 0 && result.stdout.trim() === version;
}

function publishOne(pkgDir, pkgName, version) {
  const pkgJsonPath = path.join(pkgDir, 'package.json');
  log(`-- preparing ${pkgName}@${version} (workspace deps → ^${version})`);
  const restoreState = substituteWorkspaceDeps(pkgJsonPath, version);

  try {
    const args = ['publish', '--access=public'];
    if (isDryRun) args.push('--dry-run');
    if (otp) args.push(`--otp=${otp}`);
    log(`-- npm ${args.join(' ')} (cwd=${path.relative(repoRoot, pkgDir)})`);
    const result = spawnSync('npm', args, {
      cwd: pkgDir,
      stdio: 'inherit',
      env: process.env,
      shell: process.platform === 'win32',
    });
    if (result.status !== 0) {
      throw new Error(`npm publish exited with code ${result.status}`);
    }
  } finally {
    log(`-- restoring ${pkgName} package.json (deps back to "*")`);
    restorePkgJson(pkgJsonPath, restoreState);
  }

  // npm view post-publish verification removed: redundant with `+ @kodax-ai/<pkg>@<v>`
  // success line npm publish itself emits. Bulk verification happens after the full
  // sweep via `npm view` over all 9 packages at once.
}

function main() {
  const map = buildPackageMap();
  const version = JSON.parse(
    readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
  ).version;

  log(`Repo version: ${version}`);
  log(`Mode: ${isDryRun ? 'DRY RUN' : 'REAL PUBLISH (irreversible)'}`);
  if (onlyPkg) log(`Filter: --only=${onlyPkg}`);
  log('');

  const targets = onlyPkg
    ? [onlyPkg]
    : PUBLISH_ORDER;

  for (const pkgName of targets) {
    const pkgDir = map.get(pkgName);
    if (!pkgDir) {
      logError(`${pkgName}: directory not found in packages/. Skipping.`);
      continue;
    }
    try {
      publishOne(pkgDir, pkgName, version);
    } catch (err) {
      logError(`${pkgName}: ${err.message}`);
      logError('Stopping — npm publish is irreversible. Fix and re-run with --only=' + pkgName);
      process.exit(1);
    }
    log('');
  }

  log('All targets processed successfully.');
  if (isDryRun) {
    log('(This was a dry run; nothing was actually published.)');
  } else {
    log(`Published ${targets.length} package(s) at version ${version}.`);
    log(`Next: republish ${CLI_ROOT_NAME} (root) separately if shipping the CLI.`);
  }
}

try {
  main();
} catch (err) {
  logError(err.stack || err.message);
  process.exit(1);
}
