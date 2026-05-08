#!/usr/bin/env node
// FEATURE_147 Phase 4.4 — root @kodax-ai/cli publish helper.
//
// Why a separate script (not folded into release-npm.mjs):
//   The root package.json differs structurally from the 9 sub-packages:
//   - "name": "kodax"  (unscoped — must be temporarily set to "@kodax-ai/cli")
//   - "private": true   (npm refuses to publish — must be temporarily removed)
//   - no "publishConfig" (scoped npm requires { access: "public" })
//   - no "files" allowlist (without it npm would tarball the whole monorepo)
//   Conflating these structural rewrites with sub-package publish flow risks
//   bricking the root package.json on script crash. This helper isolates the
//   risk to one well-tested code path with a finally{} restore guarantee.
//
// Usage:
//   node scripts/publish-root-cli.mjs --dry-run    # safe preview, restores after
//   node scripts/publish-root-cli.mjs              # real publish + restore
//   node scripts/publish-root-cli.mjs --otp=123456 # pass OTP if 2FA required
//
// Idempotent in failure mode: try/finally restores the original package.json
// even if `npm publish` throws. The pristine bytes are captured BEFORE any
// mutation; restore writes them back verbatim.

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const rootPkgPath = path.join(repoRoot, 'package.json');

const argv = process.argv.slice(2);
const isDryRun = argv.includes('--dry-run');
const otpArg = argv.find((a) => a.startsWith('--otp='));
const otp = otpArg ? otpArg.split('=')[1] : null;

function log(msg) {
  console.log(`[root-publish] ${msg}`);
}

function logError(msg) {
  console.error(`[root-publish] ERROR ${msg}`);
}

// Files that ship in the root tarball. Everything else (packages/, tests/,
// benchmark/, docs/, clients/, src/, node_modules) is excluded by virtue of
// not being in this allowlist.
const TARBALL_FILES = [
  'dist',
  'scripts/kodax-bin.cjs',
  'scripts/production-env.cjs',
  'README.md',
  'README_CN.md',
  'LICENSE',
  'CHANGELOG.md',
];

function rewriteRootPackageJson(version) {
  const rawBytes = readFileSync(rootPkgPath, 'utf8');
  const pkg = JSON.parse(rawBytes);

  // 1. Rename to scoped publish target
  pkg.name = '@kodax-ai/cli';

  // 2. Remove private flag (npm refuses to publish private packages)
  delete pkg.private;

  // 3. Add publishConfig for scoped public access
  pkg.publishConfig = { access: 'public' };

  // 4. Pin tarball file allowlist (avoid shipping the whole monorepo)
  pkg.files = TARBALL_FILES;

  // 5. Normalize bin paths — strip leading "./" prefix.
  //    npm 11 publish-time validation rejects bin paths starting with "./"
  //    and silently removes the entry (the warning "bin[kodax] script name
  //    scripts/kodax-bin.cjs was invalid and removed"). Without this fix,
  //    `npm install -g @kodax-ai/cli` would NOT install the `kodax` command.
  //    Root has private:true locally so this validation never fired before
  //    Phase 4.4 publish.
  if (pkg.bin && typeof pkg.bin === 'object') {
    for (const [name, p] of Object.entries(pkg.bin)) {
      if (typeof p === 'string' && p.startsWith('./')) {
        pkg.bin[name] = p.substring(2);
      }
    }
  } else if (typeof pkg.bin === 'string' && pkg.bin.startsWith('./')) {
    pkg.bin = pkg.bin.substring(2);
  }

  // 6. Substitute internal workspace deps "*" → "^<version>"
  for (const depKey of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    if (!pkg[depKey]) continue;
    for (const [name, spec] of Object.entries(pkg[depKey])) {
      if (!name.startsWith('@kodax-ai/')) continue;
      if (typeof spec === 'string' && spec === '*') {
        pkg[depKey][name] = `^${version}`;
      }
    }
  }

  writeFileSync(rootPkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  return rawBytes; // pristine bytes for restore
}

function restoreRootPackageJson(rawBytes) {
  writeFileSync(rootPkgPath, rawBytes, 'utf8');
}

function main() {
  const pkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'));
  const version = pkg.version;

  if (pkg.name !== 'kodax' && pkg.name !== '@kodax-ai/cli') {
    logError(`unexpected root package name: "${pkg.name}". Expected "kodax" or "@kodax-ai/cli". Aborting.`);
    process.exit(1);
  }

  log(`Root version: ${version}`);
  log(`Mode: ${isDryRun ? 'DRY RUN' : 'REAL PUBLISH (irreversible)'}`);
  log('');

  log('-- rewriting root package.json (name → @kodax-ai/cli, drop private, add publishConfig + files, substitute deps)');
  const pristineBytes = rewriteRootPackageJson(version);

  try {
    const args = ['publish'];
    if (isDryRun) args.push('--dry-run');
    if (otp) args.push(`--otp=${otp}`);
    log(`-- npm ${args.join(' ')} (cwd=${repoRoot})`);
    const result = spawnSync('npm', args, {
      cwd: repoRoot,
      stdio: 'inherit',
      env: process.env,
      shell: process.platform === 'win32',
    });
    if (result.status !== 0) {
      throw new Error(`npm publish exited with code ${result.status}`);
    }
    log(`-- ✓ npm publish succeeded`);
  } finally {
    log('-- restoring root package.json (pristine bytes)');
    restoreRootPackageJson(pristineBytes);
  }

  log('');
  if (isDryRun) {
    log('Dry run complete. Nothing was actually published.');
  } else {
    log(`Published @kodax-ai/cli@${version}.`);
    log(`Verify visibility: npm view @kodax-ai/cli@${version} version --registry=https://registry.npmjs.org/`);
    log('(Registry propagation can take 30-120s for first-version-after-placeholder.)');
  }
}

try {
  main();
} catch (err) {
  logError(err.stack || err.message);
  process.exit(1);
}
