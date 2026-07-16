import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  createMemoryControlPlane,
  drainPendingEpisodeReviews,
  appendMemoryOutcomeDigest,
  appendMemoryReviewReceipt,
  createSessionLineage,
  getSessionLineagePath,
  getAgentConfigPath,
  tryGitRemote,
  type MemoryContextIdentity,
  type KodaXMemoryOutcomeDigest,
  type MemoryReviewTrigger,
  type EpisodeReviewDrainEligibility,
  type EpisodeReviewDrainResult,
  type KodaXSessionStorage,
  type MemoryController,
  type PendingEpisodeReview,
} from '@kodax-ai/agent';

import { emitResilienceDebug } from './agent-runtime/resilience-debug.js';
import { resolveExecutionCwd } from './runtime-paths.js';
import type { KodaXOptions } from './types.js';

const ENGLISH_FORGET_RE =
  /\b(forget|do not remember|don't remember|remove (?:this )?from memory|delete .{0,40}memory)\b/i;
const CHINESE_FORGET_RE =
  /(?:\u522b\u8bb0|\u4e0d\u8981\u8bb0\u4f4f|\u5fd8\u8bb0|\u5220\u9664.{0,12}\u8bb0\u5fc6|\u4e0d\u8981\u518d\u8bb0)/u;
const ENGLISH_REMEMBER_RE =
  /\b(remember this|please remember|save this to memory|add this to memory)\b/i;
const CHINESE_REMEMBER_RE =
  /(?:\u8bb0\u4f4f|\u4fdd\u5b58.{0,12}\u8bb0\u5fc6|\u52a0\u5165\u8bb0\u5fc6)/u;
const ENGLISH_MEMORY_ANCHOR_RE =
  /\b(memory|remembered|remember|stored|previously saved|memo(?:ry)? note)\b/i;
const ENGLISH_CORRECTION_MARKER_RE =
  /\b(wrong|incorrect|outdated|actually|correction|correcting|not .{1,80} but|instead|should be)\b/i;
const CHINESE_MEMORY_ANCHOR_RE =
  /(?:\u8bb0\u5fc6|\u8bb0\u4f4f\u7684|\u4e4b\u524d\u8bb0\u7684)/u;
const CHINESE_CORRECTION_MARKER_RE =
  /(?:\u4e0d\u662f.{0,24}\u800c\u662f|\u7ea0\u6b63|\u66f4\u6b63|\u5176\u5b9e|\u5e94\u8be5\u662f|\u4e0d\u5bf9)/u;

export async function maybeRunMemoryMaintenanceWindow(options: KodaXOptions): Promise<void> {
  if (isInternalAgentRun(options)) return;

  const cwd = resolveExecutionCwd(options.context);
  try {
    const result = await createMemoryControlPlane({
      cwd,
      ...(options.context?.memoryIdentity !== undefined
        ? { identity: options.context.memoryIdentity }
        : {}),
      projectDocs: [],
      discoverSkills: false,
    }).maybeRunAutoCurator();
    if (result.ran || result.skippedReason !== 'not_due') {
      emitResilienceDebug('[memory:maintenance]', {
        cwd,
        ran: result.ran,
        skippedReason: result.skippedReason ?? null,
        reportPath: result.reportPath ?? null,
        nextEligibleAt: result.nextEligibleAt ?? null,
      });
    }
  } catch (error) {
    emitResilienceDebug('[memory:maintenance:error]', {
      cwd,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function maybeReviewMemoryFeedbackFromPrompt(
  options: KodaXOptions,
  prompt: string,
): Promise<void> {
  if (isInternalAgentRun(options)) return;

  const reviewer = options.memoryReviewer;
  if (reviewer === undefined) return;

  const trigger = detectMemoryReviewTrigger(prompt);
  if (trigger === undefined) return;

  const cwd = resolveExecutionCwd(options.context);
  const task = options.context?.rawUserInput?.trim();
  try {
    const plan = await createMemoryControlPlane({
      cwd,
      ...(options.context?.memoryIdentity !== undefined
        ? { identity: options.context.memoryIdentity }
        : {}),
      projectDocs: [],
      discoverSkills: false,
      memoryReviewer: reviewer,
    }).reviewMemoryFeedback({
      trigger,
      userFeedback: prompt,
      ...(task !== undefined && task.length > 0 ? { task } : {}),
    });
    options.events?.onMemoryReview?.(plan);
    emitResilienceDebug('[memory:review]', {
      cwd,
      trigger,
      actions: plan.actions.length,
      candidates: plan.candidateRefs.map((candidate) => candidate.ref.id),
    });
  } catch (error) {
    emitResilienceDebug('[memory:review:error]', {
      cwd,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function detectMemoryReviewTrigger(prompt: string): MemoryReviewTrigger | undefined {
  const text = prompt.trim();
  if (text.length === 0) return undefined;
  if (ENGLISH_FORGET_RE.test(text) || CHINESE_FORGET_RE.test(text)) return 'explicit_forget';
  if (ENGLISH_REMEMBER_RE.test(text) || CHINESE_REMEMBER_RE.test(text)) return 'explicit_remember';
  if (isMemoryCorrection(text)) return 'user_correction';
  return undefined;
}

export function deriveCodingMemoryIdentity(
  options: KodaXOptions,
  cwd: string,
  sessionId: string,
): MemoryContextIdentity {
  const canonicalCwd = path.resolve(cwd).toLowerCase();
  const remote = tryGitRemote(cwd)?.trim();
  const projectId = remote === undefined
    ? `local:${canonicalCwd}`
    : canonicalMemoryProjectId(remote);
  const workspaceId = options.context?.repoRoutingSignals?.workspaceRoot
    ?? options.context?.gitRoot
    ?? canonicalCwd;
  return {
    tenantId: `local:${getAgentConfigPath()}`,
    workspaceId,
    agentId: options.context?.agentProfile?.id ?? 'kodax-coding',
    projectId,
    sessionId,
  };
}

export function canonicalMemoryProjectId(remoteUrl: string): string {
  const value = remoteUrl.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      if (parsed.hostname.length > 0 && parsed.pathname.length > 1) {
        return canonicalRemoteIdentity(
          `${parsed.hostname.toLowerCase()}${parsed.port.length > 0 ? `:${parsed.port}` : ''}`,
          parsed.pathname,
        );
      }
    } catch {
      // Invalid remotes remain scope-stable without persisting their raw bytes.
    }
  }
  const scp = value.match(/^(?:[^@/:]+@)?([^:/]+):(.+)$/);
  if (scp !== null) return canonicalRemoteIdentity(scp[1]!, scp[2]!);
  return `remote-hash:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function canonicalRemoteIdentity(host: string, repositoryPath: string): string {
  const repository = repositoryPath
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '');
  return `remote:${host.toLowerCase()}/${repository}`;
}

export async function persistMemoryOutcomeToSession(
  options: KodaXOptions,
  sessionId: string,
  digest: KodaXMemoryOutcomeDigest,
  persistence: { readonly emitEvent?: boolean } = {},
): Promise<void> {
  if (persistence.emitEvent !== false) options.events?.onMemoryOutcomeDigest?.(digest);
  if (options.session?.persistedByHost === true || options.session?.storage === undefined) return;
  const data = await options.session.storage.load(sessionId);
  if (data === null) return;
  const lineage = data.lineage ?? createSessionLineage(data.messages);
  await options.session.storage.save(sessionId, {
    ...data,
    lineage: appendMemoryOutcomeDigest(lineage, digest),
  });
}

export async function persistMemoryReviewReceiptToSession(
  options: KodaXOptions,
  sessionId: string,
  input: {
    readonly reviewKey: string;
    readonly proposalIds: readonly string[];
    readonly completedAt: string;
  },
): Promise<void> {
  options.events?.onMemoryReviewReceipt?.(input);
  if (options.session?.persistedByHost === true || options.session?.storage === undefined) return;
  const data = await options.session.storage.load(sessionId);
  if (data === null) return;
  const lineage = data.lineage ?? createSessionLineage(data.messages);
  await options.session.storage.save(sessionId, {
    ...data,
    lineage: appendMemoryReviewReceipt(lineage, input),
  });
}

export async function revalidatePendingEpisodeReview(
  storage: KodaXSessionStorage | undefined,
  entry: PendingEpisodeReview,
): Promise<EpisodeReviewDrainEligibility> {
  if (storage === undefined) return 'defer';
  const data = await storage.load(entry.ownerSessionRef);
  if (data === null) return 'discard';
  const lineage = data.lineage ?? createSessionLineage(data.messages);
  const digestEntry = lineage.entries.find((candidate) =>
    candidate.type === 'memory_outcome_digest'
    && candidate.digest.reviewKey === entry.reviewKey);
  if (digestEntry !== undefined) {
    const activePathIds = new Set(getSessionLineagePath(lineage).map((candidate) => candidate.id));
    return digestEntry.parentId === null || activePathIds.has(digestEntry.parentId)
      ? 'eligible'
      : 'discard';
  }
  const rewoundAfterDigest = lineage.entries.some((candidate) =>
    candidate.type === 'rewind_marker'
    && candidate.timestamp.localeCompare(entry.digest.createdAt) >= 0);
  return rewoundAfterDigest ? 'discard' : 'eligible';
}

export async function drainCodingMemoryReviewInbox(
  options: KodaXOptions,
  identity: MemoryContextIdentity,
  controller: MemoryController,
  currentSessionId: string,
): Promise<EpisodeReviewDrainResult | undefined> {
  if (isInternalAgentRun(options)
    || options.memoryReviewer === undefined
    || options.session?.storage === undefined) return undefined;
  const result = await drainPendingEpisodeReviews(identity, {
    maxEntries: 2,
    revalidate: async (entry) => entry.ownerSessionRef === currentSessionId
      ? 'defer'
      : revalidatePendingEpisodeReview(options.session?.storage, entry),
    review: async (entry) => reviewPendingEpisode(options, controller, entry),
  });
  if (result.reviewed > 0 || result.discarded > 0 || result.failed > 0) {
    emitResilienceDebug('[memory:review-inbox:drain]', { ...result });
  }
  return result;
}

async function reviewPendingEpisode(
  options: KodaXOptions,
  controller: MemoryController,
  entry: PendingEpisodeReview,
): Promise<readonly string[]> {
  await persistMemoryOutcomeToSession(
    options,
    entry.ownerSessionRef,
    entry.digest,
    { emitEvent: false },
  );
  const review = await reviewEpisodeWithTimeout(controller, entry.digest);
  const completedAt = new Date().toISOString();
  await persistMemoryReviewReceiptToSession(options, entry.ownerSessionRef, {
    reviewKey: entry.reviewKey,
    proposalIds: review.proposalIds,
    completedAt,
  });
  if (review.appliedProposalIds.length > 0) {
    options.events?.onMemoryNotice?.({
      episodeId: entry.digest.id,
      summaries: review.plan.actions.map((action) => action.summary).slice(0, 3),
      proposalIds: review.appliedProposalIds,
    });
  }
  return review.proposalIds;
}

async function reviewEpisodeWithTimeout(
  controller: MemoryController,
  digest: KodaXMemoryOutcomeDigest,
): ReturnType<MemoryController['reviewEpisode']> {
  const abort = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      controller.reviewEpisode(digest, abort.signal),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          abort.abort();
          reject(new Error('delayed memory review timed out after 30000ms'));
        }, 30_000);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function isMemoryCorrection(text: string): boolean {
  return (ENGLISH_MEMORY_ANCHOR_RE.test(text) && ENGLISH_CORRECTION_MARKER_RE.test(text))
    || (CHINESE_MEMORY_ANCHOR_RE.test(text) && CHINESE_CORRECTION_MARKER_RE.test(text));
}

function isInternalAgentRun(options: KodaXOptions): boolean {
  return options.context?.currentAgentId !== undefined
    || options.context?.parentAgentId !== undefined;
}
