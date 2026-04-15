#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';

const PROJECT_ROOT = process.cwd();
const TMP_PREFIX = 'infcodex-release-';
const PROJECT_TMP_DIR = path.join(PROJECT_ROOT, 'tmp');
const ROOT_NPMRC = path.join(PROJECT_ROOT, '.npmrc');
await fs.mkdir(PROJECT_TMP_DIR, { recursive: true });

function run(command, cwd = PROJECT_ROOT) {
  execSync(command, {
    cwd,
    stdio: 'inherit',
    env: {
      ...process.env,
      npm_config_userconfig: ROOT_NPMRC,
    },
  });
}

function replaceBranding(text) {
  const replaceWord = (source, from, to) =>
    source.replace(new RegExp(`(^|[^A-Za-z0-9_])${from}(?=[^A-Za-z0-9_]|$)`, 'g'), `$1${to}`);

  const logoReplacements = [
    {
      from: [
        '██╗  ██╗  ██████╗  ██████╗   █████╗  ██╗  ██╗',
        '██║ ██╔╝ ██╔═══██╗ ██╔══██╗ ██╔══██╗ ╚██╗██╔╝',
        '█████╔╝  ██║   ██║ ██║  ██║ ███████║  ╚███╔╝',
        '██╔═██╗  ██║   ██║ ██║  ██║ ██╔══██║  ██╔██╗',
        '██║  ██╗ ╚██████╔╝ ██████╔╝ ██║  ██║ ██╔╝ ██╗',
        '╚═╝  ╚═╝  ╚═════╝  ╚═════╝  ╚═╝  ╚═╝ ╚═╝  ╚═╝',
      ].join('\n'),
      to: [
        '██╗ ███╗   ██╗ ███████╗  ██████╗  ██████╗  ██████╗  ██████╗  ██╗  ██╗',
        '██║ ████╗  ██║ ██╔════╝ ██╔════╝ ██╔═══██╗ ██╔══██╗ ██╔════╝ ╚██╗██╔╝',
        '██║ ██╔██╗ ██║ █████╗   ██║      ██║   ██║ ██║  ██║ █████╗    ╚███╔╝',
        '██║ ██║╚██╗██║ ██╔══╝   ██║      ██║   ██║ ██║  ██║ ██╔══╝    ██╔██╗',
        '██║ ██║ ╚████║ ██║      ╚██████╗ ╚██████╔╝ ██████╔╝ ███████╗ ██╔╝ ██╗',
        '╚═╝ ╚═╝  ╚═══╝ ╚═╝       ╚═════╝  ╚═════╝  ╚═════╝  ╚══════╝ ╚═╝  ╚═╝',
      ].join('\n'),
    },
  ];

  let replaced = text;
  replaced = replaceWord(replaced, 'KodaX', 'InfCodeX');
  replaced = replaceWord(replaced, 'kodax', 'infcodex');

  for (const { from, to } of logoReplacements) {
    replaced = replaced
      .replaceAll(from, to)
      .replaceAll(`  ${from.replaceAll('\n', '\n  ')}`, `  ${to.replaceAll('\n', '\n  ')}`);
  }

  // Keep runtime config/control directories compatible with existing KodaX installs.
  // InfCodeX should still read ~/.kodax/config.json and project .kodax paths.
  replaced = replaced
    .replaceAll('~/.infcodex', '~/.kodax')
    .replaceAll('/.infcodex/', '/.kodax/')
    .replaceAll('.infcodex/', '.kodax/')
    .replaceAll("'.infcodex'", "'.kodax'")
    .replaceAll('".infcodex"', '".kodax"');

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

async function ensureRootHasWorkspaceDependencies(workspaceRoot) {
  const packageMap = await buildWorkspacePackageMap(workspaceRoot);
  const rootPackagePath = path.join(workspaceRoot, 'package.json');
  const rootPackage = JSON.parse(await fs.readFile(rootPackagePath, 'utf8'));
  const rootDependencies =
    rootPackage.dependencies && typeof rootPackage.dependencies === 'object'
      ? rootPackage.dependencies
      : {};

  for (const [packageName, packageDir] of packageMap.entries()) {
    if (packageDir === workspaceRoot || packageName === rootPackage.name) {
      continue;
    }
    if (packageName in rootDependencies) {
      continue;
    }
    const rel = path.relative(workspaceRoot, packageDir).split(path.sep).join('/');
    if (!rel || rel === '.') {
      continue;
    }
    rootDependencies[packageName] = `file:${rel.startsWith('.') ? rel : `./${rel}`}`;
  }

  for (const [packageName, packageDir] of packageMap.entries()) {
    if (packageDir === workspaceRoot || packageName === rootPackage.name) {
      continue;
    }
    const packageJsonPath = path.join(packageDir, 'package.json');
    let pkg;
    try {
      pkg = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
    } catch {
      continue;
    }
    const deps = pkg?.dependencies;
    if (!deps || typeof deps !== 'object') {
      continue;
    }
    for (const [depName, depVersion] of Object.entries(deps)) {
      if (packageMap.has(depName)) {
        continue;
      }
      if (depName in rootDependencies) {
        continue;
      }
      if (typeof depVersion !== 'string' || depVersion.trim() === '') {
        continue;
      }
      rootDependencies[depName] = depVersion;
    }
  }

  rootPackage.dependencies = rootDependencies;
  await fs.writeFile(rootPackagePath, `${JSON.stringify(rootPackage, null, 2)}\n`, 'utf8');
}

async function rewriteTextFilesRecursively(targetDir, filePattern = /\.(?:md|txt)$/) {
  let rewriteCount = 0;
  let entries;
  try {
    entries = await fs.readdir(targetDir, { withFileTypes: true });
  } catch {
    return rewriteCount;
  }

  for (const entry of entries) {
    const fullPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      rewriteCount += await rewriteTextFilesRecursively(fullPath, filePattern);
      continue;
    }

    if (!filePattern.test(entry.name)) {
      continue;
    }

    const before = await fs.readFile(fullPath, 'utf8');
    const after = replaceBranding(before);
    if (after !== before) {
      await fs.writeFile(fullPath, after, 'utf8');
      rewriteCount += 1;
    }
  }

  return rewriteCount;
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
  await ensureRootHasWorkspaceDependencies(workdir);
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
  await rewriteTextFilesRecursively(path.join(workdir, 'dist'), /\.(?:js|mjs|cjs|d\.ts|map)$/);
  await rewriteTextFilesRecursively(path.join(workdir, 'src'), /\.(?:ts|tsx|js|mjs|cjs)$/);
  await rewriteTextFilesRecursively(path.join(workdir, 'packages'), /\.(?:ts|tsx|js|mjs|cjs|md|txt)$/);

  // Skip prepack here because we already built the temporary workspace above.
  run('npm pack --ignore-scripts', workdir);
  console.log(`[release-infcodex] done. artifact directory: ${workdir}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[release-infcodex] failed: ${message}`);
  process.exit(1);
});
