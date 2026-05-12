#!/usr/bin/env node
// FEATURE_150 (v0.7.37) — single-bundle npm release for @kodax-ai/kodax.
//
// Replaces:
//   - scripts/release-npm.mjs        (multi-package publish — deleted)
//   - scripts/publish-root-cli.mjs   (root-cli structural rewrite — folded in)
//
// Why one script now: ADR-022 — npm distribution is a single bundle. There
// is no longer a multi-package dependency-order publish to orchestrate.
//
// Usage:
//   node scripts/release.mjs --dry-run    # full sweep, no real publish
//   node scripts/release.mjs              # real publish (irreversible)
//   node scripts/release.mjs --otp=123456 # pass OTP for npm 2FA
//   node scripts/release.mjs --skip-build # assume dist/ is already built (advanced)
//
// Steps:
//   1. Verify git is clean (no uncommitted changes).
//   2. Build sub-package dist/ via `npm run build:packages` (esbuild needs them).
//   3. Build root bundle via `npm run build:bundle`.
//   4. Rewrite root package.json: name → @kodax-ai/kodax, drop private,
//      add publishConfig, normalize bin paths, inject SDK subpath exports
//      (ADR-024). Capture pristine bytes for restore.
//   5. Run `npm publish` (or --dry-run).
//   6. Restore pristine package.json bytes (try/finally guarantees this).
//
// Idempotent failure mode: pristine bytes are captured BEFORE any mutation;
// restore writes them back verbatim even if npm publish throws.

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const rootPkgPath = path.join(repoRoot, 'package.json');

// ---- argv ----
const argv = process.argv.slice(2);
const isDryRun = argv.includes('--dry-run');
const skipBuild = argv.includes('--skip-build');
const otpArg = argv.find((a) => a.startsWith('--otp='));
const otp = otpArg ? otpArg.split('=')[1] : null;

function log(msg) {
  console.log(`[release] ${msg}`);
}

function logError(msg) {
  console.error(`[release] ERROR ${msg}`);
}

function runCmd(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
    shell: process.platform === 'win32',
    ...opts,
  });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited with code ${result.status}`);
  }
}

function gitIsClean() {
  const result = spawnSync('git', ['status', '--porcelain'], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  return result.status === 0 && result.stdout.trim() === '';
}

// ---- root package.json rewrite ------------------------------------------

function rewriteRootPackageJson() {
  const rawBytes = readFileSync(rootPkgPath, 'utf8');
  const pkg = JSON.parse(rawBytes);

  // 1. Switch publish identity: monorepo internal name "kodax" → public scope
  pkg.name = '@kodax-ai/kodax';

  // 2. Remove private flag (npm refuses to publish private packages)
  delete pkg.private;

  // 3. Ensure publishConfig for scoped public access
  pkg.publishConfig = { access: 'public' };

  // 4. Normalize bin paths — strip leading "./" prefix.
  //    npm 11 publish-time validation rejects bin paths starting with "./"
  //    and silently removes the entry. See FEATURE_147 v0.7.37 first-attempt
  //    sweep retro for the original bug encounter.
  if (pkg.bin && typeof pkg.bin === 'object') {
    for (const [name, p] of Object.entries(pkg.bin)) {
      if (typeof p === 'string' && p.startsWith('./')) {
        pkg.bin[name] = p.substring(2);
      }
    }
  } else if (typeof pkg.bin === 'string' && pkg.bin.startsWith('./')) {
    pkg.bin = pkg.bin.substring(2);
  }

  // 5. files allowlist must be present (otherwise npm tarballs the whole monorepo).
  //    This is checked, not synthesized — keep package.json source-of-truth.
  if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
    throw new Error('root package.json#files is missing or empty — refuse to publish (would tarball the whole monorepo)');
  }

  // 6. ADR-024: SDK subpath exports. Root '.' stays as authored. The 5
  //    subpaths point at the multi-entry bundle output from build-bundle.mjs.
  //    No `types` condition for subpaths — root build does not emit
  //    dist/sdk-*.d.ts, matching v0.7.38 baseline (root dist/index.d.ts is
  //    also not actually shipped today; .d.ts generation is a separate
  //    concern to address when SDK typing surfaces are stabilized).
  pkg.exports = {
    ...(pkg.exports || {}),
    './agent': { import: './dist/sdk-agent.js' },
    './llm': { import: './dist/sdk-llm.js' },
    './coding': { import: './dist/sdk-coding.js' },
    './repl': { import: './dist/sdk-repl.js' },
    './skills': { import: './dist/sdk-skills.js' },
    './package.json': './package.json',
  };

  writeFileSync(rootPkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  return rawBytes; // for restore
}

function restoreRootPackageJson(rawBytes) {
  writeFileSync(rootPkgPath, rawBytes, 'utf8');
}

// ---- main ----------------------------------------------------------------

function main() {
  // Sanity: git clean (uncommitted changes risk shipping unexpected dist).
  // Hard fail for real publish; warn-only for dry-run (so operators can
  // still validate the pipeline mid-edit, but get a visible reminder).
  if (!gitIsClean()) {
    if (isDryRun) {
      log('WARNING: git working tree is not clean. Dry-run will proceed but real publish would refuse.');
    } else {
      logError('git working tree is not clean. Commit or stash first, then retry.');
      process.exit(1);
    }
  }

  const pkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'));
  const version = pkg.version;

  log(`Version: ${version}`);
  log(`Mode: ${isDryRun ? 'DRY RUN' : 'REAL PUBLISH (irreversible)'}`);
  log('');

  // Step 1 + 2: build sub-packages and bundle.
  if (!skipBuild) {
    log('-- npm run build:packages (compile sub-packages dist/)');
    runCmd('npm', ['run', 'build:packages']);

    log('-- npm run build:bundle (esbuild bundle)');
    runCmd('npm', ['run', 'build:bundle']);
  } else {
    log('-- --skip-build: assuming dist/ is already current');
  }

  // Step 3: rewrite root package.json
  log('-- rewriting root package.json (name → @kodax-ai/kodax, drop private, normalize bin, inject subpath exports)');
  const pristineBytes = rewriteRootPackageJson();

  // Step 4: publish, then restore (try/finally guarantees restore)
  try {
    // Force official npm registry — repo .npmrc pins npmmirror for fast
    // dev installs, but publish must always go to registry.npmjs.org.
    const args = ['publish', '--registry=https://registry.npmjs.org/'];
    if (isDryRun) args.push('--dry-run');
    if (otp) args.push(`--otp=${otp}`);
    log(`-- npm ${args.join(' ')}`);
    runCmd('npm', args);
    log('-- ✓ npm publish succeeded');
  } finally {
    log('-- restoring root package.json (pristine bytes)');
    restoreRootPackageJson(pristineBytes);
  }

  log('');
  if (isDryRun) {
    log('Dry run complete. Nothing was actually published.');
  } else {
    log(`Published @kodax-ai/kodax@${version}.`);
    log(`Verify: npm view @kodax-ai/kodax@${version} version --registry=https://registry.npmjs.org/`);
    log('(Registry propagation can take 30-120s.)');
  }
}

try {
  main();
} catch (err) {
  logError(err.stack || err.message);
  process.exit(1);
}
