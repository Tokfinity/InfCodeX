import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { globSync } from 'glob';

const PROJECT_ROOT = process.cwd();
const passthroughArgs = process.argv.slice(2);
const ALREADY_PUBLISHED_PATTERNS = [
  /\bEPUBLISHCONFLICT\b/i,
  /\bE409\b/i,
  /409\s+conflict/i,
  /cannot publish over the previously published versions/i,
  /previously published versions/i,
  /cannot modify pre-existing version/i,
  /package has already been published/i,
  /this package is already present/i,
  /package is already present/i,
];

function toWorkspacePackageJsonPattern(pattern) {
  return pattern.endsWith('package.json')
    ? pattern
    : `${pattern.replace(/\/+$/, '')}/package.json`;
}

function getWorkspacePackageDirs() {
  const packageJsonPath = path.join(PROJECT_ROOT, 'package.json');
  const rootPackage = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const workspacePatterns = Array.isArray(rootPackage.workspaces)
    ? rootPackage.workspaces
    : Array.isArray(rootPackage.workspaces?.packages)
      ? rootPackage.workspaces.packages
      : [];

  return [...new Set(
    workspacePatterns.flatMap((pattern) =>
      globSync(toWorkspacePackageJsonPattern(pattern), {
        cwd: PROJECT_ROOT,
        absolute: true,
        ignore: ['**/node_modules/**'],
      }).map((match) => path.dirname(match)),
    ),
  )].sort();
}

function getPackageDisplayName(packageDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
    return pkg.name ?? path.relative(PROJECT_ROOT, packageDir);
  } catch {
    return path.relative(PROJECT_ROOT, packageDir) || '.';
  }
}

function writeOutput(stream, content) {
  if (typeof content === 'string' && content.length > 0) {
    stream.write(content);
  }
}

function isAlreadyPublishedError(result) {
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return ALREADY_PUBLISHED_PATTERNS.some((pattern) => pattern.test(output));
}

function publishPackage(packageDir) {
  const displayName = getPackageDisplayName(packageDir);
  const relativeDir = path.relative(PROJECT_ROOT, packageDir) || '.';
  const args = ['publish', ...passthroughArgs];

  console.log(`\n[publish-all] Publishing ${displayName} (${relativeDir})`);
  const result = spawnSync('npm', args, {
    cwd: packageDir,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });

  writeOutput(process.stdout, result.stdout);
  writeOutput(process.stderr, result.stderr);

  if ((result.status ?? 1) === 0) {
    return;
  }

  if (isAlreadyPublishedError(result)) {
    console.warn(`[publish-all] Skipping already published package: ${displayName}`);
    return;
  }

  process.exit(result.status ?? 1);
}

for (const packageDir of getWorkspacePackageDirs()) {
  publishPackage(packageDir);
}

publishPackage(PROJECT_ROOT);
