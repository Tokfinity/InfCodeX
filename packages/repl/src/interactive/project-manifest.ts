import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { ProjectIdentity } from './project-key.js';

function comparableRoot(value: string): string {
  const normalized = path.resolve(value).replace(/\\/g, '/');
  return process.platform === 'win32' || process.platform === 'darwin'
    ? normalized.toLowerCase()
    : normalized;
}

async function existingCanonicalRoot(manifestPath: string): Promise<string | undefined> {
  let content: string;
  try {
    content = await fs.readFile(manifestPath, 'utf8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const parsed: unknown = JSON.parse(content);
  if (
    parsed === null
    || typeof parsed !== 'object'
    || typeof (parsed as Record<string, unknown>).canonicalRoot !== 'string'
  ) {
    throw new Error(`Invalid project identity manifest at ${manifestPath}`);
  }
  return comparableRoot((parsed as Record<string, string>).canonicalRoot);
}

export async function projectManifestMatches(
  projectDir: string,
  canonicalRoot: string,
): Promise<boolean> {
  try {
    return await existingCanonicalRoot(path.join(projectDir, 'project.json'))
      === comparableRoot(canonicalRoot);
  } catch {
    return false;
  }
}

export async function projectManifestExists(projectDir: string): Promise<boolean> {
  return await existingCanonicalRoot(path.join(projectDir, 'project.json')) !== undefined;
}

/** Publish a fully-written identity without overwriting or exposing partial JSON. */
export async function publishProjectManifest(
  projectDir: string,
  identity: ProjectIdentity,
): Promise<void> {
  if (identity.canonicalRoot === null) return;
  await fs.mkdir(projectDir, { recursive: true });
  const manifestPath = path.join(projectDir, 'project.json');
  const expectedRoot = comparableRoot(identity.canonicalRoot);
  const existingRoot = await existingCanonicalRoot(manifestPath);
  if (existingRoot !== undefined) {
    if (existingRoot !== expectedRoot) {
      throw new Error(`Conflicting project identity at ${manifestPath}`);
    }
    return;
  }

  const tempPath = path.join(projectDir, `.project.${process.pid}.${randomUUID()}.tmp`);
  const handle = await fs.open(tempPath, 'wx');
  try {
    await handle.writeFile(JSON.stringify({
      canonicalRoot: identity.canonicalRoot,
      displayName: identity.displayName,
      lastUsed: new Date().toISOString(),
    }) + '\n', 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.link(tempPath, manifestPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const concurrentRoot = await existingCanonicalRoot(manifestPath);
    if (concurrentRoot !== expectedRoot) {
      throw new Error(`Conflicting project identity at ${manifestPath}`);
    }
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}
