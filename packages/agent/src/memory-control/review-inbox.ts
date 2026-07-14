import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  hashMemoryIdentityComponent,
  type MemoryContextIdentity,
} from '../memory/index.js';
import { getAgentConfigPath } from '../runtime/agent-home.js';
import type { KodaXMemoryOutcomeDigest } from '../types.js';

export interface PendingEpisodeReview {
  readonly version: 1;
  readonly reviewKey: string;
  readonly digest: KodaXMemoryOutcomeDigest;
  readonly ownerSessionRef: string;
  readonly ownerAgentHash: string;
  readonly ownerProjectHash?: string;
  readonly createdAt: string;
}

export interface EpisodeReviewReceipt {
  readonly version: 1;
  readonly reviewKey: string;
  readonly proposalIds: readonly string[];
  readonly completedAt: string;
}

export type EpisodeReviewDrainEligibility = 'eligible' | 'discard' | 'defer';

export interface EpisodeReviewDrainOptions {
  readonly maxEntries?: number;
  readonly revalidate: (
    entry: PendingEpisodeReview,
  ) => Promise<EpisodeReviewDrainEligibility>;
  readonly review: (entry: PendingEpisodeReview) => Promise<readonly string[]>;
}

export interface EpisodeReviewDrainResult {
  readonly reviewed: number;
  readonly discarded: number;
  readonly deferred: number;
  readonly failed: number;
  readonly failures: readonly {
    readonly reviewKey: string;
    readonly error: string;
  }[];
}

const REVIEW_CLAIM_STALE_MS = 5 * 60_000;

export async function persistPendingEpisodeReview(
  identity: MemoryContextIdentity,
  digest: KodaXMemoryOutcomeDigest,
): Promise<{ readonly path: string; readonly entry: PendingEpisodeReview }> {
  if (digest.sessionId !== identity.sessionId) {
    throw new Error('outcome digest session does not match review-inbox owner');
  }
  const entry: PendingEpisodeReview = {
    version: 1,
    reviewKey: digest.reviewKey,
    digest,
    ownerSessionRef: identity.sessionId,
    ownerAgentHash: hashMemoryIdentityComponent('agent', identity.agentId),
    ...(identity.projectId !== undefined
      ? { ownerProjectHash: hashMemoryIdentityComponent('project', identity.projectId) }
      : {}),
    createdAt: digest.createdAt,
  };
  const target = pendingPath(identity, digest.reviewKey);
  await writeJsonAtomic(target, entry);
  return { path: target, entry };
}

export async function listPendingEpisodeReviews(filter: {
  readonly tenantId: string;
  readonly agentId?: string;
  readonly projectId?: string;
}): Promise<readonly PendingEpisodeReview[]> {
  const tenantRoot = tenantInboxRoot(filter.tenantId);
  const expectedAgent = filter.agentId === undefined
    ? undefined
    : hashMemoryIdentityComponent('agent', filter.agentId);
  const expectedProject = filter.projectId === undefined
    ? undefined
    : hashMemoryIdentityComponent('project', filter.projectId);
  const sessionDirs = await readDirectories(tenantRoot);
  const entries: PendingEpisodeReview[] = [];
  for (const sessionDir of sessionDirs) {
    await recoverStaleClaims(tenantRoot, sessionDir);
    const pendingDir = path.join(tenantRoot, sessionDir, 'pending');
    for (const filename of await readJsonFiles(pendingDir)) {
      const entry = await readPending(path.join(pendingDir, filename));
      if (entry === undefined) continue;
      if (expectedAgent !== undefined && entry.ownerAgentHash !== expectedAgent) continue;
      if (expectedProject !== undefined && entry.ownerProjectHash !== expectedProject) continue;
      entries.push(entry);
    }
  }
  return entries.sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt)
    || left.reviewKey.localeCompare(right.reviewKey));
}

export async function completeEpisodeReview(
  identity: MemoryContextIdentity,
  reviewKey: string,
  proposalIds: readonly string[],
): Promise<{ readonly acknowledged: boolean; readonly receiptPath: string }> {
  const receiptPath = await writeEpisodeReviewReceipt(identity, reviewKey, proposalIds);
  await rm(pendingPath(identity, reviewKey), { force: true });
  return { acknowledged: true, receiptPath };
}

export async function rewindPendingEpisodeReviews(
  identity: MemoryContextIdentity,
  throughSequence: number,
): Promise<number> {
  const pendingDir = path.join(sessionInboxRoot(identity), 'pending');
  let removed = 0;
  for (const filename of await readJsonFiles(pendingDir)) {
    const filePath = path.join(pendingDir, filename);
    const entry = await readPending(filePath);
    if (entry !== undefined && entry.digest.sequence > throughSequence) {
      await rm(filePath, { force: true });
      removed += 1;
    }
  }
  return removed;
}

export async function drainPendingEpisodeReviews(
  identity: MemoryContextIdentity,
  options: EpisodeReviewDrainOptions,
): Promise<EpisodeReviewDrainResult> {
  const pending = await listPendingEpisodeReviews({
    tenantId: identity.tenantId,
    agentId: identity.agentId,
    ...(identity.projectId !== undefined ? { projectId: identity.projectId } : {}),
  });
  const owned = identity.projectId === undefined
    ? pending.filter((entry) => entry.ownerProjectHash === undefined)
    : pending;
  const maxEntries = Math.max(1, Math.min(8, options.maxEntries ?? 8));
  const result: {
    reviewed: number;
    discarded: number;
    deferred: number;
    failed: number;
    failures: Array<{ reviewKey: string; error: string }>;
  } = {
    reviewed: 0,
    discarded: 0,
    deferred: pending.length - owned.length,
    failed: 0,
    failures: [],
  };
  for (const entry of owned.slice(0, maxEntries)) {
    const ownerIdentity = { ...identity, sessionId: entry.ownerSessionRef };
    const claimPath = await claimPendingReview(ownerIdentity, entry.reviewKey);
    if (claimPath === undefined) continue;
    try {
      const eligibility = await options.revalidate(entry);
      if (eligibility === 'defer') {
        await restoreClaim(ownerIdentity, entry, claimPath);
        result.deferred += 1;
        continue;
      }
      if (eligibility === 'discard') {
        await rm(claimPath, { force: true });
        result.discarded += 1;
        continue;
      }
      const proposalIds = await options.review(entry);
      await writeEpisodeReviewReceipt(ownerIdentity, entry.reviewKey, proposalIds);
      await rm(claimPath, { force: true });
      result.reviewed += 1;
    } catch (error) {
      await restoreClaim(ownerIdentity, entry, claimPath);
      result.failed += 1;
      result.failures.push({
        reviewKey: entry.reviewKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  result.deferred += Math.max(0, owned.length - maxEntries);
  return result;
}

async function claimPendingReview(
  identity: MemoryContextIdentity,
  reviewKey: string,
): Promise<string | undefined> {
  const processingDir = path.join(sessionInboxRoot(identity), 'processing');
  await mkdir(processingDir, { recursive: true });
  const claimPath = path.join(processingDir, `${safeKey(reviewKey)}.${randomUUID()}.json`);
  try {
    await rename(pendingPath(identity, reviewKey), claimPath);
    return claimPath;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function restoreClaim(
  identity: MemoryContextIdentity,
  entry: PendingEpisodeReview,
  claimPath: string,
): Promise<void> {
  await writeJsonAtomic(pendingPath(identity, entry.reviewKey), entry);
  await rm(claimPath, { force: true });
}

async function recoverStaleClaims(tenantRoot: string, sessionDir: string): Promise<void> {
  const sessionRoot = path.join(tenantRoot, sessionDir);
  const processingDir = path.join(sessionRoot, 'processing');
  for (const filename of await readJsonFiles(processingDir)) {
    const claimPath = path.join(processingDir, filename);
    try {
      if (Date.now() - (await stat(claimPath)).mtimeMs <= REVIEW_CLAIM_STALE_MS) continue;
      const entry = await readPending(claimPath);
      if (entry === undefined) continue;
      await writeJsonAtomic(
        path.join(sessionRoot, 'pending', `${safeKey(entry.reviewKey)}.json`),
        entry,
      );
      await rm(claimPath, { force: true });
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

async function writeEpisodeReviewReceipt(
  identity: MemoryContextIdentity,
  reviewKey: string,
  proposalIds: readonly string[],
): Promise<string> {
  const receipt: EpisodeReviewReceipt = {
    version: 1,
    reviewKey,
    proposalIds: [...proposalIds],
    completedAt: new Date().toISOString(),
  };
  const receiptPath = path.join(sessionInboxRoot(identity), 'receipts', `${safeKey(reviewKey)}.json`);
  await writeJsonAtomic(receiptPath, receipt);
  return receiptPath;
}

function tenantInboxRoot(tenantId: string): string {
  return getAgentConfigPath(
    'memory-review-inbox',
    hashMemoryIdentityComponent('tenant', tenantId),
  );
}

function sessionInboxRoot(identity: MemoryContextIdentity): string {
  return path.join(
    tenantInboxRoot(identity.tenantId),
    hashMemoryIdentityComponent('session', identity.sessionId),
  );
}

function pendingPath(identity: MemoryContextIdentity, reviewKey: string): string {
  return path.join(sessionInboxRoot(identity), 'pending', `${safeKey(reviewKey)}.json`);
}

function safeKey(value: string): string {
  return hashMemoryIdentityComponent('review', value);
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

async function readDirectories(root: string): Promise<readonly string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

async function readJsonFiles(root: string): Promise<readonly string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

async function readPending(filePath: string): Promise<PendingEpisodeReview | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    if (!isRecord(value) || value.version !== 1 || typeof value.reviewKey !== 'string') return undefined;
    if (typeof value.ownerSessionRef !== 'string' || typeof value.ownerAgentHash !== 'string') return undefined;
    if (value.ownerProjectHash !== undefined && typeof value.ownerProjectHash !== 'string') return undefined;
    if (typeof value.createdAt !== 'string' || !isOutcomeDigest(value.digest)) return undefined;
    return value as unknown as PendingEpisodeReview;
  } catch (error) {
    if (isMissing(error) || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function isOutcomeDigest(value: unknown): value is KodaXMemoryOutcomeDigest {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && typeof value.reviewKey === 'string'
    && typeof value.sessionId === 'string'
    && typeof value.branchId === 'string'
    && Number.isSafeInteger(value.sequence)
    && typeof value.objective === 'string'
    && typeof value.approach === 'string'
    && (value.outcome === 'succeeded' || value.outcome === 'failed')
    && typeof value.summary === 'string'
    && (value.actionSignature === undefined || typeof value.actionSignature === 'string')
    && (value.preconditions === undefined || typeof value.preconditions === 'string')
    && (value.lesson === undefined || typeof value.lesson === 'string')
    && Array.isArray(value.evidenceRefs)
    && value.evidenceRefs.every((ref) => typeof ref === 'string')
    && (value.evidence === undefined
      || (Array.isArray(value.evidence) && value.evidence.every(isOutcomeEvidence)))
    && (value.memoryInfluence === undefined
      || (Array.isArray(value.memoryInfluence) && value.memoryInfluence.every(isMemoryInfluence)))
    && (value.visibility === 'prompt_safe' || value.visibility === 'private' || value.visibility === 'sensitive')
    && typeof value.createdAt === 'string';
}

function isOutcomeEvidence(value: unknown): boolean {
  return isRecord(value)
    && typeof value.ref === 'string'
    && (value.grade === 'authoritative' || value.grade === 'verified'
      || value.grade === 'corroborated' || value.grade === 'observed' || value.grade === 'inferred')
    && (value.source === 'user' || value.source === 'host' || value.source === 'tool'
      || value.source === 'environment' || value.source === 'agent')
    && typeof value.observedAt === 'string';
}

function isMemoryInfluence(value: unknown): boolean {
  return isRecord(value)
    && typeof value.decisionReceiptRef === 'string'
    && (value.grade === 'direct' || value.grade === 'supporting'
      || value.grade === 'exposed' || value.grade === 'unknown');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}
