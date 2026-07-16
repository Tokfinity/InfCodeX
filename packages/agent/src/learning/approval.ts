import type { Dirent } from 'fs';
import { readdir, readFile, stat } from 'fs/promises';
import { isAbsolute, join, relative, resolve } from 'path';

import {
  applySkillLearningProposal,
} from './skill-learning-apply.js';
import {
  resolveSkillSnapshotLocation,
} from './skill-safe-apply.js';
import {
  readLearningProposalStore,
  updateLearningProposalStatus,
} from './store.js';
import type {
  SkillConsumerImpact,
  StoredLearningProposal,
} from './types.js';

export type StoredLearningApprovalResult =
  | {
      readonly status: 'approved_applied';
      readonly proposal: StoredLearningProposal;
      readonly changedPaths: readonly string[];
      readonly snapshotPath?: string;
    }
  | {
      readonly status: 'approved_already_applied';
      readonly proposal: StoredLearningProposal;
      readonly changedPaths: readonly string[];
      readonly snapshotPath?: string;
    }
  | {
      readonly status: 'approved_handoff';
      readonly proposal: StoredLearningProposal;
    }
  | {
      readonly status: 'blocked_not_pending';
      readonly reviewStatus: StoredLearningProposal['status'];
    }
  | {
      readonly status: 'blocked_missing_apply_plan';
    }
  | {
      readonly status: 'blocked_snapshot_conflict';
      readonly relativePath: string;
      readonly snapshotPath: string;
    }
  | {
      readonly status: 'blocked_consumer_impact';
      readonly impact: SkillConsumerImpact;
    };

export interface ApproveStoredLearningProposalOptions {
  readonly acknowledgeImpact?: boolean;
  readonly now?: () => string;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function normalizePlanRelativePath(relativePath: string): string | undefined {
  if (relativePath.includes('\0') || isAbsolute(relativePath)) return undefined;
  const normalized = relativePath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (
    segments.length === 0
    || segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    return undefined;
  }
  return segments.join('/');
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function resolvePlanTarget(
  skillRoot: string,
  relativePath: string,
): { readonly absolutePath: string; readonly normalizedRelativePath: string } | undefined {
  const normalizedRelativePath = normalizePlanRelativePath(relativePath);
  if (normalizedRelativePath === undefined) return undefined;
  const root = resolve(skillRoot);
  const absolutePath = resolve(root, ...normalizedRelativePath.split('/'));
  if (!isInside(root, absolutePath)) return undefined;
  return { absolutePath, normalizedRelativePath };
}

async function readUtf8IfExists(
  filePath: string,
): Promise<{ readonly exists: true; readonly content: string } | { readonly exists: false }> {
  try {
    return { exists: true, content: await readFile(filePath, 'utf8') };
  } catch (error) {
    if (isMissingFile(error)) return { exists: false };
    throw error;
  }
}

function plannedSkillChangedPaths(entry: StoredLearningProposal): readonly string[] {
  const plan = entry.applyPlan;
  if (plan?.kind !== 'skill') return [];
  return plan.changes.map((change) => normalizePlanRelativePath(change.relativePath) ?? change.relativePath);
}

async function skillFilesAlreadyMatchPlan(entry: StoredLearningProposal): Promise<boolean> {
  const plan = entry.applyPlan;
  if (plan?.kind !== 'skill' || plan.changes.length === 0) return false;

  for (const change of plan.changes) {
    if (change.kind !== 'write') return false;
    const target = resolvePlanTarget(plan.skillRoot, change.relativePath);
    if (target === undefined) return false;
    const current = await readUtf8IfExists(target.absolutePath);
    if (!current.exists || current.content !== change.content) return false;
  }

  return true;
}

async function findLatestSnapshotPath(entry: StoredLearningProposal): Promise<string | undefined> {
  const plan = entry.applyPlan;
  if (plan?.kind !== 'skill') return undefined;
  const location = await resolveSkillSnapshotLocation({
    proposalId: entry.proposalId,
    skillRoot: plan.skillRoot,
    ...(plan.snapshotRoot !== undefined ? { snapshotRoot: plan.snapshotRoot } : {}),
  });
  let entries: Dirent[];
  try {
    entries = await readdir(location.snapshotBase, { withFileTypes: true });
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }

  const candidates: { readonly path: string; readonly mtimeMs: number }[] = [];
  for (const entryDir of entries) {
    if (!entryDir.isDirectory() || !entryDir.name.startsWith(location.proposalPrefix)) continue;
    const candidatePath = join(location.snapshotBase, entryDir.name);
    const candidateStat = await stat(candidatePath);
    candidates.push({ path: candidatePath, mtimeMs: candidateStat.mtimeMs });
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0]?.path;
}

async function findSnapshotConflict(
  entry: StoredLearningProposal,
): Promise<{ readonly relativePath: string; readonly snapshotPath: string } | undefined> {
  const plan = entry.applyPlan;
  if (plan?.kind !== 'skill') return undefined;
  const snapshotPath = await findLatestSnapshotPath(entry);
  if (snapshotPath === undefined) return undefined;

  for (const change of plan.changes) {
    if (change.kind !== 'write') continue;
    const target = resolvePlanTarget(plan.skillRoot, change.relativePath);
    if (target === undefined) return undefined;
    const current = await readUtf8IfExists(target.absolutePath);
    if (current.exists && current.content === change.content) continue;

    const snapshotFile = join(snapshotPath, ...target.normalizedRelativePath.split('/'));
    const snapshot = await readUtf8IfExists(snapshotFile);
    if (!current.exists && !snapshot.exists) continue;
    if (current.exists && snapshot.exists && current.content === snapshot.content) continue;

    return {
      relativePath: target.normalizedRelativePath,
      snapshotPath,
    };
  }

  return undefined;
}

function getWorkflowConsumerImpact(entry: StoredLearningProposal): SkillConsumerImpact | undefined {
  if (entry.proposal.destination !== 'workflow_handoff') return undefined;
  return entry.proposal.consumerImpact;
}

function requiresConsumerImpactAck(entry: StoredLearningProposal): boolean {
  return getWorkflowConsumerImpact(entry)?.action === 'block_until_manual_review';
}

async function readCurrentStoredProposal(
  storePath: string,
  proposalId: string,
): Promise<StoredLearningProposal> {
  const read = await readLearningProposalStore(storePath);
  if (read.warnings.length > 0) {
    throw new Error(`refusing to approve corrupt learning proposal store: ${read.warnings.join('; ')}`);
  }
  const current = read.proposals.find((proposal) => proposal.proposalId === proposalId);
  if (current === undefined) {
    throw new Error(`learning proposal not found: ${proposalId}`);
  }
  return current;
}

async function markApproved(
  storePath: string,
  entry: StoredLearningProposal,
  options: {
    readonly appliedChangedPaths?: readonly string[];
    readonly appliedSnapshotPath?: string;
    readonly now?: () => string;
  } = {},
): Promise<StoredLearningProposal> {
  const now = options.now ?? (() => new Date().toISOString());
  const timestamp = now();
  const hasAppliedMetadata = options.appliedChangedPaths !== undefined || options.appliedSnapshotPath !== undefined;
  return updateLearningProposalStatus(storePath, entry.proposalId, 'approved', {
    now: () => timestamp,
    ...(hasAppliedMetadata ? { appliedAt: timestamp } : {}),
    ...(options.appliedChangedPaths !== undefined
      ? { appliedChangedPaths: options.appliedChangedPaths }
      : {}),
    ...(options.appliedSnapshotPath !== undefined
      ? { appliedSnapshotPath: options.appliedSnapshotPath }
      : {}),
  });
}

export async function approveStoredLearningProposal(
  storePath: string,
  entry: StoredLearningProposal,
  options: ApproveStoredLearningProposalOptions = {},
): Promise<StoredLearningApprovalResult> {
  const currentEntry = await readCurrentStoredProposal(storePath, entry.proposalId);
  if (currentEntry.status !== 'pending') {
    return { status: 'blocked_not_pending', reviewStatus: currentEntry.status };
  }
  entry = currentEntry;

  if (entry.applyPlan?.kind === 'skill') {
    if (await skillFilesAlreadyMatchPlan(entry)) {
      const snapshotPath = await findLatestSnapshotPath(entry);
      const changedPaths = plannedSkillChangedPaths(entry);
      const proposal = await markApproved(storePath, entry, {
        appliedChangedPaths: changedPaths,
        ...(snapshotPath !== undefined ? { appliedSnapshotPath: snapshotPath } : {}),
        now: options.now,
      });
      return {
        status: 'approved_already_applied',
        proposal,
        changedPaths,
        ...(snapshotPath !== undefined ? { snapshotPath } : {}),
      };
    }

    const conflict = await findSnapshotConflict(entry);
    if (conflict !== undefined) {
      return { status: 'blocked_snapshot_conflict', ...conflict };
    }

    const result = await applySkillLearningProposal({
      proposal: entry.proposal,
      governance: entry.applyPlan.governance,
      skillRoot: entry.applyPlan.skillRoot,
      changes: entry.applyPlan.changes,
      approved: true,
      ...(entry.applyPlan.snapshotRoot !== undefined ? { snapshotRoot: entry.applyPlan.snapshotRoot } : {}),
    });
    const proposal = await markApproved(storePath, entry, {
      appliedChangedPaths: result.changedPaths,
      ...(result.snapshotPath !== undefined ? { appliedSnapshotPath: result.snapshotPath } : {}),
      now: options.now,
    });
    return {
      status: 'approved_applied',
      proposal,
      changedPaths: result.changedPaths,
      ...(result.snapshotPath !== undefined ? { snapshotPath: result.snapshotPath } : {}),
    };
  }

  if (entry.proposal.destination === 'skill_patch' || entry.proposal.destination === 'skill_create') {
    return { status: 'blocked_missing_apply_plan' };
  }

  if (requiresConsumerImpactAck(entry) && options.acknowledgeImpact !== true) {
    const impact = getWorkflowConsumerImpact(entry);
    if (impact === undefined) return { status: 'blocked_missing_apply_plan' };
    return {
      status: 'blocked_consumer_impact',
      impact,
    };
  }

  return {
    status: 'approved_handoff',
    proposal: await markApproved(storePath, entry, { now: options.now }),
  };
}
