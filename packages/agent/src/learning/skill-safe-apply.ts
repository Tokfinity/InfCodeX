import {
  copyFile,
  lstat,
  mkdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'path';

import type {
  SkillMutationApplyInput,
  SkillMutationApplyResult,
  SkillMutationChange,
} from './types.js';

export const MAX_SKILL_MD_BYTES = 64 * 1024;
export const MAX_SKILL_SUPPORT_FILE_BYTES = 256 * 1024;

const ALLOWED_SUPPORT_DIRS = new Set([
  'references',
  'templates',
  'scripts',
  'assets',
]);

interface ValidatedSkillChange {
  readonly change: SkillMutationChange;
  readonly absolutePath: string;
  readonly normalizedRelativePath: string;
}

interface SkillRootResolution {
  readonly root: string;
  readonly existed: boolean;
}

interface ValidatedSkillMutationPlan {
  readonly root: string;
  readonly rootExisted: boolean;
  readonly changes: readonly ValidatedSkillChange[];
}

async function resolveSkillRootForValidation(input: SkillMutationApplyInput): Promise<SkillRootResolution> {
  try {
    return {
      root: await realpath(input.skillRoot),
      existed: true,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || input.createSkillRoot !== true) {
      throw error;
    }
    return {
      root: resolve(input.skillRoot),
      existed: false,
    };
  }
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function sanitizeProposalId(proposalId: string): string {
  return proposalId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 96) || 'proposal';
}

function normalizeRelativePath(relativePath: string): string {
  if (relativePath.includes('\0')) {
    throw new Error('skill proposal path contains a null byte');
  }
  if (isAbsolute(relativePath)) {
    throw new Error('skill proposal path resolves outside skill root');
  }

  const normalized = relativePath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (
    segments.length === 0
    || segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new Error('skill proposal path resolves outside skill root');
  }
  return segments.join('/');
}

function assertSupportedPath(change: SkillMutationChange, normalizedRelativePath: string): void {
  if (normalizedRelativePath === 'SKILL.md') return;

  const [top, second] = normalizedRelativePath.split('/');
  if (!top || !ALLOWED_SUPPORT_DIRS.has(top)) {
    throw new Error('skill proposal support directory must be references, templates, scripts, or assets');
  }

  if (!second && change.kind === 'write') {
    throw new Error('skill proposal support directory writes must target a file');
  }
}

function assertContentSize(change: SkillMutationChange, normalizedRelativePath: string): void {
  if (change.kind !== 'write') return;

  const bytes = Buffer.byteLength(change.content, 'utf8');
  const limit = normalizedRelativePath === 'SKILL.md'
    ? MAX_SKILL_MD_BYTES
    : MAX_SKILL_SUPPORT_FILE_BYTES;
  if (bytes > limit) {
    throw new Error(`skill proposal file is too large: ${normalizedRelativePath}`);
  }
}

async function assertExistingTargetSafe(
  change: SkillMutationChange,
  absolutePath: string,
): Promise<void> {
  let targetStat: Awaited<ReturnType<typeof lstat>>;
  try {
    targetStat = await lstat(absolutePath);
  } catch {
    if (change.kind === 'delete') {
      throw new Error(`skill proposal delete target does not exist: ${change.relativePath}`);
    }
    return;
  }

  if (targetStat.isSymbolicLink()) {
    throw new Error('skill proposal refuses to mutate symlink targets');
  }
  if (targetStat.isDirectory()) {
    throw new Error('F224 skill proposal apply supports file deletes and file writes only');
  }
}

async function assertExistingAncestorsSafe(root: string, normalizedRelativePath: string): Promise<void> {
  const segments = normalizedRelativePath.split('/').slice(0, -1);
  let current = root;

  for (const segment of segments) {
    current = join(current, segment);
    let ancestorStat: Awaited<ReturnType<typeof lstat>>;
    try {
      ancestorStat = await lstat(current);
    } catch {
      return;
    }
    if (ancestorStat.isSymbolicLink()) {
      throw new Error('skill proposal refuses paths through symlink directories');
    }
    if (!ancestorStat.isDirectory()) {
      throw new Error('skill proposal parent path is not a directory');
    }
  }
}

async function validateSkillMutationPlan(
  input: SkillMutationApplyInput,
): Promise<ValidatedSkillMutationPlan> {
  if (input.changes.length === 0) {
    throw new Error('skill proposal must contain at least one change');
  }

  const rootResolution = await resolveSkillRootForValidation(input);
  const root = rootResolution.root;
  const validated: ValidatedSkillChange[] = [];

  for (const change of input.changes) {
    if (change.kind === 'delete') {
      throw new Error('skill proposal delete is outside the F224 learning loop');
    }

    const normalizedRelativePath = normalizeRelativePath(change.relativePath);
    assertSupportedPath(change, normalizedRelativePath);
    assertContentSize(change, normalizedRelativePath);

    const absolutePath = resolve(root, ...normalizedRelativePath.split('/'));
    if (!isInside(root, absolutePath)) {
      throw new Error('skill proposal path resolves outside skill root');
    }

    if (rootResolution.existed) {
      await assertExistingAncestorsSafe(root, normalizedRelativePath);
      await assertExistingTargetSafe(change, absolutePath);
    }

    validated.push({
      change,
      absolutePath,
      normalizedRelativePath,
    });
  }

  return {
    root,
    rootExisted: rootResolution.existed,
    changes: validated,
  };
}

function needsSnapshot(changes: readonly SkillMutationChange[]): boolean {
  return changes.length > 1 || changes.some((change) => change.kind === 'delete');
}

async function createSnapshot(
  input: SkillMutationApplyInput,
  root: string,
  changes: readonly ValidatedSkillChange[],
): Promise<string | undefined> {
  if (!needsSnapshot(input.changes)) return undefined;

  const snapshotBase = resolve(input.snapshotRoot ?? join(dirname(root), '.kodax-learning-snapshots'));
  const snapshotPath = join(
    snapshotBase,
    `${sanitizeProposalId(input.proposalId)}-${Date.now().toString(36)}`,
  );
  await mkdir(snapshotPath, { recursive: true });

  for (const item of changes) {
    try {
      await lstat(item.absolutePath);
    } catch {
      continue;
    }
    const target = join(snapshotPath, item.normalizedRelativePath);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(item.absolutePath, target);
  }

  await writeFile(
    join(snapshotPath, 'manifest.json'),
    `${JSON.stringify({
      proposalId: input.proposalId,
      createdAt: new Date().toISOString(),
      changedPaths: changes.map((change) => change.normalizedRelativePath),
    }, null, 2)}\n`,
    'utf8',
  );

  return snapshotPath;
}

async function atomicWriteFile(
  root: string,
  absolutePath: string,
  content: string,
  ordinal: number,
): Promise<void> {
  const dir = dirname(absolutePath);
  await mkdir(dir, { recursive: true });
  const realDir = await realpath(dir);
  if (!isInside(root, realDir)) {
    throw new Error('skill proposal parent directory resolves outside skill root');
  }
  const tempPath = join(
    dir,
    `.${basename(absolutePath)}.kodax-${process.pid}-${Date.now().toString(36)}-${ordinal}.tmp`,
  );
  try {
    await writeFile(tempPath, content, 'utf8');
    await rename(tempPath, absolutePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

async function applyValidatedChanges(root: string, changes: readonly ValidatedSkillChange[]): Promise<void> {
  for (const [index, item] of changes.entries()) {
    if (item.change.kind === 'write') {
      await atomicWriteFile(root, item.absolutePath, item.change.content, index);
      continue;
    }
    throw new Error('skill proposal delete is outside the F224 learning loop');
  }
}

export async function applySkillMutationProposal(
  input: SkillMutationApplyInput,
): Promise<SkillMutationApplyResult> {
  const initialPlan = await validateSkillMutationPlan(input);
  const changedPaths = initialPlan.changes.map((change) => change.normalizedRelativePath);

  if (input.dryRun) {
    return {
      proposalId: input.proposalId,
      validated: true,
      applied: false,
      changedPaths,
    };
  }

  if (!input.approved) {
    throw new Error('skill proposal apply requires explicit approval');
  }

  if (!initialPlan.rootExisted && input.createSkillRoot === true) {
    await mkdir(input.skillRoot, { recursive: true });
  }

  const finalPlan = await validateSkillMutationPlan(input);
  const snapshotPath = await createSnapshot(input, finalPlan.root, finalPlan.changes);
  await applyValidatedChanges(finalPlan.root, finalPlan.changes);

  return {
    proposalId: input.proposalId,
    validated: true,
    applied: true,
    changedPaths: finalPlan.changes.map((change) => change.normalizedRelativePath),
    ...(snapshotPath !== undefined ? { snapshotPath } : {}),
  };
}
