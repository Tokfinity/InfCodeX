#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';

const PROJECT_ROOT = process.cwd();
const TMP_PREFIX = 'infcodex-release-';
const PROJECT_TMP_DIR = path.join(PROJECT_ROOT, 'tmp');
await fs.mkdir(PROJECT_TMP_DIR, { recursive: true });

function run(command, cwd = PROJECT_ROOT) {
  execSync(command, {
    cwd,
    stdio: 'inherit',
  });
}

function replaceBranding(text) {
  const replaced = text
    .replaceAll('KodaX', 'InfCodeX')
    .replaceAll('kodax', 'infcodex');
  // Keep internal package scopes untouched (runtime imports must stay @kodax/*).
  return replaced.replaceAll('@infcodex/', '@kodax/');
}

async function buildWorkspacePackageMap(workspaceRoot) {
  const map = new Map();
  const rootPackagePath = path.join(workspaceRoot, 'package.json');
  const rootPackage = JSON.parse(await fs.readFile(rootPackagePath, 'utf8'));
  if (typeof rootPackage.name === 'string') {
    map.set(rootPackage.name, workspaceRoot);
  }

  const packagesDir = path.join(workspaceRoot, 'packages');
  let packageEntries = [];
  try {
    packageEntries = await fs.readdir(packagesDir, { withFileTypes: true });
  } catch {
    return map;
  }

  for (const entry of packageEntries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const pkgPath = path.join(packagesDir, entry.name, 'package.json');
    try {
      const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
      if (typeof pkg.name === 'string') {
        map.set(pkg.name, path.join(packagesDir, entry.name));
      }
    } catch {
      // Ignore non-package directories.
    }
  }

  return map;
}

function rewriteDependencyField(targetPackageDir, deps, packageMap) {
  if (!deps || typeof deps !== 'object') {
    return;
  }
  for (const depName of Object.keys(deps)) {
    const depDir = packageMap.get(depName);
    if (!depDir) {
      continue;
    }
    const rel = path.relative(targetPackageDir, depDir).split(path.sep).join('/');
    deps[depName] = `file:${rel.startsWith('.') ? rel : `./${rel}`}`;
  }
}

async function rewriteWorkspaceDependencies(workspaceRoot) {
  const packageMap = await buildWorkspacePackageMap(workspaceRoot);
  const packageJsonPaths = [path.join(workspaceRoot, 'package.json')];
  const packagesDir = path.join(workspaceRoot, 'packages');
  try {
    const entries = await fs.readdir(packagesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        packageJsonPaths.push(path.join(packagesDir, entry.name, 'package.json'));
      }
    }
  } catch {
    // Ignore if packages directory does not exist.
  }

  for (const packageJsonPath of packageJsonPaths) {
    let pkg;
    try {
      pkg = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
    } catch {
      continue;
    }
    const pkgDir = path.dirname(packageJsonPath);
    rewriteDependencyField(pkgDir, pkg.dependencies, packageMap);
    rewriteDependencyField(pkgDir, pkg.devDependencies, packageMap);
    rewriteDependencyField(pkgDir, pkg.optionalDependencies, packageMap);
    await fs.writeFile(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  }
}

async function rewriteTextFilesRecursively(targetDir) {
  let entries;
  try {
    entries = await fs.readdir(targetDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await rewriteTextFilesRecursively(fullPath);
      continue;
    }

    if (!/\.(?:md|txt)$/.test(entry.name)) {
      continue;
    }

    const before = await fs.readFile(fullPath, 'utf8');
    const after = replaceBranding(before);
    if (after !== before) {
      await fs.writeFile(fullPath, after, 'utf8');
    }
  }
}

async function main() {
  // Keep only one release workspace so wildcard install paths do not pick stale tarballs.
  const existing = await fs.readdir(PROJECT_TMP_DIR, { withFileTypes: true });
  for (const entry of existing) {
    if (entry.isDirectory() && entry.name.startsWith(TMP_PREFIX)) {
      await fs.rm(path.join(PROJECT_TMP_DIR, entry.name), { recursive: true, force: true });
    }
  }

  const tempRoot = await fs.mkdtemp(path.join(PROJECT_TMP_DIR, TMP_PREFIX));
  const workdir = path.join(tempRoot, 'workspace');

  console.log(`[release-infcodex] temp workspace: ${workdir}`);
  await fs.mkdir(workdir, { recursive: true });

  run(
    `rsync -a --delete --exclude ".git" --exclude "node_modules" --exclude ".cursor" --exclude "tmp" "${PROJECT_ROOT}/" "${workdir}/"`,
    PROJECT_ROOT,
  );

  run('npm ci', workdir);
  run('npm run build', workdir);

  const packageJsonPath = path.join(workdir, 'package.json');
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
  packageJson.name = 'infcodex';
  packageJson.bin = { infcodex: './dist/kodax_cli.js' };
  await fs.writeFile(`${packageJsonPath}`, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
  await rewriteWorkspaceDependencies(workdir);
  await fs.rm(path.join(workdir, 'package-lock.json'), { force: true });
  await fs.writeFile(
    path.join(workdir, '.npmignore'),
    [
      'node_modules',
      '.git',
      '.cursor',
      'tmp',
      '',
    ].join('\n'),
    'utf8',
  );

  await rewriteTextFilesRecursively(path.join(workdir, 'docs'));

  // Skip prepack here because we already built the temporary workspace above.
  run('npm pack --ignore-scripts', workdir);
  console.log(`[release-infcodex] done. artifact directory: ${workdir}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[release-infcodex] failed: ${message}`);
  process.exit(1);
});
