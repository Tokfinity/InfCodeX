import { createHash } from 'node:crypto';
import { readdir, readFile, rename, rm, writeFile, mkdir } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import {
  initializeSkillRegistry,
  type SkillMetadata,
} from '../capabilities/skills/index.js';
import {
  matchesMemoryApplicability,
  MEMORY_POLICY_VERSION,
  memoryApplicabilityFingerprint,
  parseMemoryFile,
  resolveMemoryRoot,
  resolveScopedMemoryRoot,
  type MemoryApplicability,
  type MemoryContextIdentity,
  type MemoryType,
} from '../memory/index.js';
import {
  readLearningProposalStore,
  resolveLearningProposalStore,
  updateLearningProposalStatus,
  upsertLearningProposal,
} from '../learning/store.js';
import type {
  MemoryLearningHandoff,
  ReasoningLearningHandoff,
  StoredLearningProposal,
} from '../learning/types.js';
import type {
  KodaXSessionArtifactLedgerEntry,
  KodaXSessionEntry,
  KodaXSessionLineage,
} from '../types.js';
import type {
  MemoryActionProposal,
  MemoryApplyPreview,
  MemoryApplyResult,
  MemoryApproval,
  MemoryAutoCuratorInput,
  MemoryAutoCuratorResult,
  MemoryBodySnapshot,
  MemoryController,
  MemoryEpisodeReviewResult,
  MemoryCuratorInput,
  MemoryEvent,
  MemoryGovernanceFinding,
  MemoryGovernanceReport,
  MemoryItemRef,
  MemoryLifecycleOperationResult,
  MemoryPack,
  MemoryPackHint,
  MemoryPackInput,
  MemoryRefFilter,
  MemoryRejectResult,
  MemoryReviewCandidateRef,
  MemoryReviewDraftAction,
  MemoryReviewInput,
  MemoryReviewPlan,
  MemoryReviewPersistenceDecision,
  MemoryReviewRunner,
  MemoryScope,
  MemorySourceAdapter,
  MemoryVisibility,
} from './types.js';
import { sanitizePromptSafeMemoryClaim } from './prompt-safety.js';
import {
  archiveManagedMemoryRef,
  forgetManagedMemoryRef,
  resolveManagedLifecycle,
} from './lifecycle.js';

const MISSING_FINGERPRINT = 'missing';
const AUTO_CURATOR_STATE_VERSION = 1;
const DEFAULT_AUTO_CURATOR_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_AUTO_CURATOR_MIN_REFS = 2;
const AUTO_CURATOR_REPORT_CAP = 200;

export interface CreateMemoryControlPlaneOptions {
  readonly cwd: string;
  readonly identity?: MemoryContextIdentity;
  readonly learningStorePath?: string;
  readonly memoryRoot?: string;
  readonly projectDocs?: readonly string[];
  readonly extraRefs?: readonly MemoryItemRef[];
  readonly sessionId?: string;
  readonly sessionLineage?: KodaXSessionLineage;
  readonly artifactLedger?: readonly KodaXSessionArtifactLedgerEntry[];
  readonly now?: () => string;
  readonly onEvent?: (event: MemoryEvent) => void;
  readonly discoverSkills?: boolean;
  readonly memoryReviewer?: MemoryReviewRunner;
}

interface ReadTextResult {
  readonly exists: boolean;
  readonly content: string;
}

interface PersistedReviewPlan {
  readonly proposalIds: readonly string[];
  readonly decisions: readonly MemoryReviewPersistenceDecision[];
}

interface ReviewMemoryPlacement {
  readonly memoryKind: MemoryLearningHandoff['memoryKind'];
  readonly applicability?: MemoryApplicability;
  readonly requestedLifecycle: 'active' | 'provisional';
}

interface MemdirWritePlan {
  readonly targetPath: string;
  readonly entrypointPath: string;
  readonly content: string;
  readonly indexLine: string;
}

interface AutoCuratorState {
  readonly version: 1;
  readonly lastCheckedAt?: string;
  readonly lastRunAt?: string;
  readonly lastInventoryFingerprint?: string;
  readonly lastReportPath?: string;
}

interface ReviewCandidateSelection {
  readonly candidateRefs: readonly MemoryReviewCandidateRef[];
  readonly warnings: readonly string[];
}

export function createMemoryControlPlane(options: CreateMemoryControlPlaneOptions): MemoryController {
  return new MemoryControlPlane(options);
}

export class MemoryControlPlane implements MemoryController {
  private readonly cwd: string;
  private readonly learningStorePath: string;
  private readonly memoryRoot: string;
  private readonly now: () => string;
  private readonly onEvent?: (event: MemoryEvent) => void;
  private readonly projectDocs: readonly string[];
  private readonly extraRefs: readonly MemoryItemRef[];
  private readonly sessionId: string;
  private readonly sessionLineage?: KodaXSessionLineage;
  private readonly artifactLedger: readonly KodaXSessionArtifactLedgerEntry[];
  private readonly discoverSkills: boolean;
  private readonly memoryReviewer?: MemoryReviewRunner;
  private readonly identity?: MemoryContextIdentity;
  private readonly applicability?: MemoryApplicability;
  private readonly scopedRoots: readonly {
    readonly root: string;
    readonly scope: Extract<MemoryScope, 'project' | 'workspace' | 'agent' | 'user'>;
    readonly applicability: MemoryApplicability;
  }[];

  constructor(options: CreateMemoryControlPlaneOptions) {
    this.cwd = options.cwd;
    this.learningStorePath = options.learningStorePath ?? resolveLearningProposalStore(options.cwd);
    this.identity = options.identity;
    this.applicability = options.identity?.projectId !== undefined
      ? { tenantId: options.identity.tenantId, projectId: options.identity.projectId }
      : undefined;
    this.memoryRoot = options.memoryRoot
      ?? (options.identity?.projectId !== undefined
        ? resolveScopedMemoryRoot(options.identity, 'project')
        : resolveMemoryRoot(options.cwd));
    this.scopedRoots = options.memoryRoot !== undefined || options.identity === undefined
      ? []
      : buildScopedRoots(options.identity);
    this.now = options.now ?? (() => new Date().toISOString());
    this.onEvent = options.onEvent;
    this.projectDocs = options.projectDocs ?? defaultProjectDocs(options.cwd);
    this.extraRefs = options.extraRefs ?? [];
    this.sessionId = options.sessionId ?? 'current';
    this.sessionLineage = options.sessionLineage;
    this.artifactLedger = options.artifactLedger ?? [];
    this.discoverSkills = options.discoverSkills ?? true;
    this.memoryReviewer = options.memoryReviewer;
  }

  async listInbox(): Promise<readonly MemoryActionProposal[]> {
    const store = await readLearningProposalStore(this.learningStorePath);
    if (store.warnings.length > 0) return [];
    const proposals: MemoryActionProposal[] = [];
    for (const entry of store.proposals) {
      if (entry.status !== 'pending') continue;
      const proposal = await this.projectLearningProposal(entry);
      if (proposal !== undefined) proposals.push(proposal);
    }
    return proposals;
  }

  async showProposal(id: string): Promise<MemoryActionProposal | undefined> {
    const store = await readLearningProposalStore(this.learningStorePath);
    if (store.warnings.length > 0) return undefined;
    const entry = store.proposals.find((proposal) => memoryProposalId(proposal.proposalId) === id);
    return entry === undefined ? undefined : this.projectLearningProposal(entry);
  }

  async approveProposal(
    id: string,
    expectedFingerprints: Readonly<Record<string, string>>,
  ): Promise<MemoryApplyResult> {
    const proposal = await this.showProposal(id);
    if (proposal === undefined) {
      return skippedApply(id, 'memory proposal not found');
    }
    if (expectedFingerprints === undefined) {
      return skippedApply(id, 'approval requires fingerprints from a shown proposal preview');
    }
    const approval: MemoryApproval = {
      proposalId: proposal.id,
      approvedBy: 'user',
      approvedAt: this.now(),
      expectedFingerprints,
    };
    const adapter = this.adapterForProposal(proposal);
    const result = await adapter.applyProposal(proposal, approval);
    if (result.applied) this.emit({ type: 'proposal.approved', proposalId: id });
    return result;
  }

  async rejectProposal(id: string, reason?: string): Promise<MemoryRejectResult> {
    const proposalId = parseMemoryProposalId(id);
    if (proposalId === undefined) {
      return {
        proposalId: id,
        rejected: false,
        skippedReason: `invalid memory proposal id: ${id}`,
        warnings: [],
      };
    }
    const proposal = await this.showProposal(id);
    if (proposal === undefined) {
      return {
        proposalId: id,
        rejected: false,
        skippedReason: 'memory proposal not found',
        warnings: [],
      };
    }
    await updateLearningProposalStatus(
      this.learningStorePath,
      proposalId,
      'rejected',
      reason !== undefined && reason.trim().length > 0 ? { rejectedReason: reason } : {},
    );
    this.emit({ type: 'proposal.rejected', proposalId: id });
    const trimmedReason = reason?.trim();
    let review: MemoryReviewPlan | undefined;
    let warnings: readonly string[] = [];
    if (trimmedReason !== undefined && trimmedReason.length > 0) {
      try {
        review = await this.reviewMemoryFeedback({
          trigger: 'proposal_rejected',
          userFeedback: trimmedReason,
          sourceRefs: proposal.sourceRefs.map((ref) => ref.id),
          candidateRefIds: [
            ...proposal.targetRefs.map((ref) => ref.id),
            ...proposal.sourceRefs.map((ref) => ref.id),
          ],
        });
        warnings = review.warnings;
      } catch (error) {
        warnings = [`memory feedback review failed: ${errorMessage(error)}`];
      }
    }
    return {
      proposalId: id,
      rejected: true,
      ...(review !== undefined ? { review } : {}),
      warnings,
    };
  }

  async listRefs(filter: MemoryRefFilter = {}): Promise<readonly MemoryItemRef[]> {
    const refs: MemoryItemRef[] = [];
    refs.push(...await this.listLearningRefs());
    for (const adapter of this.memdirAdapters()) refs.push(...await adapter.listRefs(filter));
    refs.push(...this.listSessionTraceRefs());
    refs.push(...this.listArtifactLedgerRefs());
    refs.push(...await this.listProjectDocRefs());
    refs.push(...await this.listSkillRefs());
    refs.push(...this.extraRefs);
    return refs.filter((ref) => matchesFilter(ref, filter));
  }

  async readRef(ref: MemoryItemRef): Promise<MemoryBodySnapshot> {
    if (ref.kind === 'learning_proposal' || ref.kind === 'reasoning_report') {
      return this.readLearningRef(ref);
    }
    if (ref.kind === 'memdir') {
      return this.memdirAdapter().readRef(ref);
    }
    if (ref.kind === 'session_trace') {
      return this.readSessionTraceRef(ref);
    }
    if (ref.kind === 'artifact_ledger') {
      return this.readArtifactLedgerRef(ref);
    }
    return readStorageBackedRef(ref, this.now);
  }

  async archiveRef(id: string): Promise<MemoryLifecycleOperationResult> {
    const ref = (await this.listRefs()).find((candidate) => candidate.id === id);
    if (ref?.kind !== 'memdir') return lifecycleNotFound(id, 'archive');
    await archiveManagedMemoryRef(this.memoryRootForRef(ref), ref, this.now());
    return {
      refId: id,
      operation: 'archive',
      acknowledged: true,
      residualSourceRefs: ref.sourceRefs,
      warnings: [],
    };
  }

  async forgetRef(id: string): Promise<MemoryLifecycleOperationResult> {
    return this.removeManagedRef(id, 'forget');
  }

  async purgeRef(id: string): Promise<MemoryLifecycleOperationResult> {
    return this.removeManagedRef(id, 'purge');
  }

  private async removeManagedRef(
    id: string,
    operation: 'forget' | 'purge',
  ): Promise<MemoryLifecycleOperationResult> {
    const ref = (await this.listRefs()).find((candidate) => candidate.id === id);
    if (ref?.kind !== 'memdir') return lifecycleNotFound(id, operation);
    await forgetManagedMemoryRef(this.memoryRootForRef(ref), ref, this.now());
    return {
      refId: id,
      operation,
      acknowledged: true,
      residualSourceRefs: ref.sourceRefs,
      warnings: operation === 'purge' && ref.sourceRefs.length > 0
        ? ['source carriers follow their independent retention lifecycle']
        : [],
    };
  }

  async runCurator(input: MemoryCuratorInput = {}): Promise<MemoryGovernanceReport> {
    const refs = await this.listRefs({
      includePrivate: input.includePrivate,
      includeSensitive: input.includeSensitive,
    });
    const report = this.buildGovernanceReport(refs);
    this.emit({ type: 'curator.completed', reportId: report.reportId });
    return report;
  }

  async maybeRunAutoCurator(input: MemoryAutoCuratorInput = {}): Promise<MemoryAutoCuratorResult> {
    if (input.enabled === false) {
      return { ran: false, skippedReason: 'disabled' };
    }
    const now = this.now();
    const intervalMs = Math.max(0, input.intervalMs ?? DEFAULT_AUTO_CURATOR_INTERVAL_MS);
    const minRefs = Math.max(1, input.minRefs ?? DEFAULT_AUTO_CURATOR_MIN_REFS);
    const statePath = autoCuratorStatePath(this.memoryRoot);
    const state = await readAutoCuratorState(statePath);
    const lastCheckedAt = state?.lastCheckedAt ?? state?.lastRunAt;
    const nextEligibleAt = lastCheckedAt === undefined ? undefined : addMs(lastCheckedAt, intervalMs);
    if (nextEligibleAt !== undefined && compareIso(nextEligibleAt, now) > 0) {
      return { ran: false, skippedReason: 'not_due', nextEligibleAt };
    }

    const refs = (await this.listRefs({
      includePrivate: input.includePrivate,
      includeSensitive: input.includeSensitive,
    })).filter(isAutoCuratorCandidate);
    if (refs.length < minRefs) {
      return { ran: false, skippedReason: 'insufficient_refs' };
    }

    const report = this.buildGovernanceReport(refs);
    const reportPath = autoCuratorReportPath(this.memoryRoot, report);
    await writeFileAtomic(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    await pruneAutoCuratorReports(this.memoryRoot, AUTO_CURATOR_REPORT_CAP);
    await writeAutoCuratorState(statePath, {
      version: AUTO_CURATOR_STATE_VERSION,
      lastCheckedAt: now,
      lastRunAt: now,
      lastInventoryFingerprint: fingerprint(memoryInventoryPayload(refs)),
      lastReportPath: reportPath,
    });
    this.emit({ type: 'curator.completed', reportId: report.reportId });
    return {
      ran: true,
      report,
      reportPath,
      nextEligibleAt: addMs(now, intervalMs),
    };
  }

  async buildMemoryPack(input: MemoryPackInput): Promise<MemoryPack> {
    const generatedAt = this.now();
    const rankingText = memoryPackRankingText(input);
    const taskFingerprint = fingerprint(rankingText);
    if (input.ignoreMemory === true || shouldIgnoreMemory(input.task)) {
      return {
        generatedAt,
        taskFingerprint,
        memoryRevision: fingerprint('suppressed'),
        candidates: [],
        promptHints: [],
        hints: [],
        omitted: ['memory intentionally suppressed by request'],
        traceMetadata: {
          selectedRefIds: [],
          omittedRefIds: [],
          taskFingerprint,
          suppressed: true,
        },
      };
    }
    const refs = await this.listRefs({
      includePrivate: input.includePrivate,
      includeSensitive: input.includeSensitive,
    });
    const eligible = refs
      .filter((ref) => isPackEligible(ref, input))
      .sort((left, right) => (
        structuredMatchScore(right, input) - structuredMatchScore(left, input)
        || scoreRef(right, rankingText) - scoreRef(left, rankingText)
        || left.id.localeCompare(right.id)
      ));
    const maxCandidates = Math.max(0, input.maxCandidates ?? 12);
    const maxHints = Math.min(maxCandidates, Math.max(0, input.maxHints ?? 5));
    const selectedCandidates = eligible.slice(0, maxCandidates);
    const candidates = await this.buildPackHints(selectedCandidates, {
      ...input,
      includeSnippets: false,
    });
    const promptHints = await this.buildPackHints(selectedCandidates.slice(0, maxHints), input);
    this.emit({ type: 'pack.selected', refIds: promptHints.map((hint) => hint.ref.id) });
    return {
      generatedAt,
      taskFingerprint,
      memoryRevision: fingerprint(memoryInventoryPayload(eligible)),
      candidates,
      promptHints,
      hints: promptHints,
      omitted: eligible.slice(maxCandidates).map((ref) => ref.id),
      traceMetadata: {
        selectedRefIds: promptHints.map((hint) => hint.ref.id),
        omittedRefIds: eligible.slice(maxCandidates).map((ref) => ref.id),
        taskFingerprint,
        suppressed: false,
      },
    };
  }

  async reviewMemoryFeedback(input: MemoryReviewInput): Promise<MemoryReviewPlan> {
    const createdAt = this.now();
    const sourceRefs = input.sourceRefs ?? [];
    const selection = await this.selectReviewCandidateRefs(input);
    const modelInput = {
      trigger: input.trigger,
      userFeedback: input.userFeedback ?? input.episodeDigest?.summary ?? '',
      ...(input.task !== undefined ? { task: input.task } : {}),
      sourceRefs,
      candidateRefs: selection.candidateRefs,
      warnings: selection.warnings,
    };

    if (this.memoryReviewer === undefined) {
      const plan: MemoryReviewPlan = {
        trigger: input.trigger,
        createdAt,
        sourceRefs,
        candidateRefs: selection.candidateRefs,
        actions: [],
        warnings: [
          ...selection.warnings,
          'memory reviewer unavailable; semantic memory review was not run',
        ],
        ...(input.episodeDigest !== undefined ? { episodeDigest: input.episodeDigest } : {}),
      };
      this.emit({ type: 'review.completed', trigger: input.trigger, actionCount: 0 });
      return plan;
    }

    const reviewed = await this.memoryReviewer(modelInput);
    const plan: MemoryReviewPlan = input.episodeDigest === undefined
      ? reviewed
      : { ...reviewed, episodeDigest: input.episodeDigest };
    this.emit({ type: 'review.completed', trigger: input.trigger, actionCount: plan.actions.length });
    return plan;
  }

  async persistReviewPlan(plan: MemoryReviewPlan): Promise<readonly string[]> {
    return (await this.persistReviewPlanWithDecisions(plan)).proposalIds;
  }

  private async persistReviewPlanWithDecisions(plan: MemoryReviewPlan): Promise<PersistedReviewPlan> {
    const proposalIds: string[] = [];
    const decisions: MemoryReviewPersistenceDecision[] = [];
    const existingRefs = await this.listRefs({ includePrivate: true });
    const storedProposals = (await readLearningProposalStore(this.learningStorePath)).proposals;
    for (let actionIndex = 0; actionIndex < plan.actions.length; actionIndex += 1) {
      const action = plan.actions[actionIndex]!;
      const consultation = await this.consultReviewAction(plan, action, actionIndex, existingRefs);
      if (consultation.kind === 'conflict'
        || consultation.kind === 'no_action'
        || consultation.kind === 'reject'
        || consultation.kind === 'quarantine') {
        decisions.push(consultation);
        continue;
      }
      const existingRef = consultation.existingRefId === undefined
        ? undefined
        : existingRefs.find((ref) => ref.id === consultation.existingRefId);
      const body = consultation.kind === 'evidence_update' && existingRef !== undefined
        ? extractClaimBody((await this.readRef(existingRef)).body)
        : action.proposedBody?.trim();
      if (body === undefined || body.length === 0) {
        decisions.push({
          actionIndex,
          kind: 'reject',
          reason: 'memory proposal body is empty',
          ...(consultation.existingRefId !== undefined
            ? { existingRefId: consultation.existingRefId }
            : {}),
        });
        continue;
      }
      const proposalId = `memory-review-${fingerprint([
        plan.trigger,
        ...plan.sourceRefs,
        consultation.kind,
        consultation.existingRefId ?? '',
        action.summary,
        body,
      ].join('\0')).slice(0, 24)}`;
      const digest = plan.episodeDigest;
      const sourceRefs = uniqueStrings([
        ...(existingRef?.sourceRefs ?? []),
        ...(digest?.evidenceRefs ?? plan.sourceRefs),
      ]);
      const placement = this.resolveReviewMemoryPlacement(
        plan,
        action,
        existingRef,
        storedProposals,
      );
      const handoff: MemoryLearningHandoff = {
        destination: 'memdir_handoff',
        proposalId,
        origin: 'background_learning',
        userLabel: 'context_note',
        memoryKind: placement.memoryKind,
        body,
        metadata: {
          writeOrigin: 'background_learning',
          executionContext: 'primary',
          sessionId: digest?.sessionId ?? 'memory-review',
          sourceRefs,
          completedTurn: true,
          persistenceKind: consultation.kind,
          ...(action.claimKind !== undefined ? { claimKind: action.claimKind } : {}),
          ...(action.claimKey !== undefined ? { claimKey: action.claimKey } : {}),
          ...(action.actionSignature !== undefined ? { actionSignature: action.actionSignature } : {}),
          ...(action.preconditions !== undefined ? { preconditions: action.preconditions } : {}),
          ...(placement.applicability !== undefined
            ? { applicability: placement.applicability }
            : {}),
          requestedLifecycle: placement.requestedLifecycle,
          ...(digest !== undefined ? {
            episodeOutcome: digest.outcome,
            verifiedEvidence: hasVerifiedDigestEvidence(digest),
            ...(this.identity?.projectId !== undefined
              ? { evidenceProjectId: this.identity.projectId }
              : {}),
          } : {}),
          ...(existingRef !== undefined ? {
            targetRefId: existingRef.id,
            ...(existingRef.storageUri !== undefined ? { targetStorageUri: existingRef.storageUri } : {}),
          } : {}),
        },
      };
      await upsertLearningProposal(this.learningStorePath, handoff, { now: this.now });
      proposalIds.push(proposalId);
      decisions.push({ ...consultation, proposalId });
      this.emit({ type: 'proposal.created', proposalId: memoryProposalId(proposalId) });
    }
    return { proposalIds, decisions };
  }

  private resolveReviewMemoryPlacement(
    plan: MemoryReviewPlan,
    action: MemoryReviewDraftAction,
    existingRef: MemoryItemRef | undefined,
    proposals: readonly StoredLearningProposal[],
  ): ReviewMemoryPlacement {
    if (action.claimKind === 'preference'
      && (plan.trigger === 'explicit_remember' || plan.trigger === 'user_correction')
      && this.identity?.userId !== undefined) {
      return {
        memoryKind: 'user',
        applicability: { tenantId: this.identity.tenantId, userId: this.identity.userId },
        requestedLifecycle: 'active',
      };
    }
    if (action.claimKind !== 'procedure' || action.claimKey === undefined || this.identity === undefined) {
      return this.projectPlacement(action.claimKind);
    }
    const digest = plan.episodeDigest;
    const currentVerified = digest !== undefined && hasVerifiedDigestEvidence(digest);
    const history = procedurePromotionHistory(
      action.claimKey,
      proposals,
      currentVerified && digest?.outcome === 'succeeded' ? this.identity.projectId : undefined,
      currentVerified && digest?.outcome === 'failed',
    );
    const agentScoped = existingRef?.scope === 'agent' || history.projects.size >= 2;
    if (!agentScoped) return this.projectPlacement('procedure');
    const active = history.successes >= 3 && history.projects.size >= 2 && !history.hasCounterexample;
    return {
      memoryKind: 'semantic_memory',
      applicability: { tenantId: this.identity.tenantId, agentId: this.identity.agentId },
      requestedLifecycle: active ? 'active' : 'provisional',
    };
  }

  private projectPlacement(claimKind: MemoryReviewDraftAction['claimKind']): ReviewMemoryPlacement {
    if (this.identity?.projectId === undefined) {
      return { memoryKind: 'project', requestedLifecycle: 'active' };
    }
    return {
      memoryKind: 'project',
      applicability: {
        tenantId: this.identity.tenantId,
        ...(claimKind === 'procedure' ? { agentId: this.identity.agentId } : {}),
        projectId: this.identity.projectId,
      },
      requestedLifecycle: 'active',
    };
  }

  async reviewEpisode(
    digest: import('../types.js').KodaXMemoryOutcomeDigest,
    signal?: AbortSignal,
  ): Promise<MemoryEpisodeReviewResult> {
    const plan = await this.reviewMemoryFeedback({
      trigger: 'episode_completed',
      episodeDigest: digest,
      userFeedback: digest.summary,
      task: digest.objective,
      sourceRefs: digest.evidenceRefs,
    });
    if (isAborted(signal)) return cancelledEpisodeReview(plan, 'episode review timed out');
    const persisted = await this.persistReviewPlanWithDecisions(plan);
    const proposalIds = persisted.proposalIds;
    const appliedProposalIds: string[] = [];
    const warnings = [...plan.warnings];
    for (const decision of persisted.decisions) {
      if (isAborted(signal)) {
        warnings.push('episode review timed out before governed apply');
        break;
      }
      const proposalId = decision.proposalId;
      if (proposalId === undefined) continue;
      const action = plan.actions[decision.actionIndex];
      if (action === undefined || !isEligibleEpisodePromotion(action, digest)) continue;
      const result = await this.applyHostEligibleProposal(
        memoryProposalId(proposalId),
        `${MEMORY_POLICY_VERSION}:episode-promotion`,
        'verified low-risk episode memory',
      );
      if (result.applied) appliedProposalIds.push(proposalId);
      else if (result.skippedReason !== undefined) warnings.push(result.skippedReason);
    }
    return { plan, proposalIds, appliedProposalIds, decisions: persisted.decisions, warnings };
  }

  private async consultReviewAction(
    plan: MemoryReviewPlan,
    action: MemoryReviewDraftAction,
    actionIndex: number,
    existingRefs: readonly MemoryItemRef[],
  ): Promise<MemoryReviewPersistenceDecision> {
    if (action.action === 'conflict_report' || action.relationship === 'conflict') {
      return { actionIndex, kind: 'conflict', reason: 'review reported an unresolved contradiction' };
    }
    if (action.action === 'quarantine' || isRestrictedMemoryBody(action.proposedBody ?? '')) {
      return { actionIndex, kind: 'quarantine', reason: 'memory content is restricted or explicitly quarantined' };
    }
    if ((action.action !== 'write_memdir' && action.action !== 'patch_memdir')
      || action.proposedBody === undefined
      || action.proposedBody.trim().length === 0) {
      return { actionIndex, kind: 'reject', reason: 'review action is not a supported durable-memory mutation' };
    }
    const existing = findCompatibleReviewRef(action, plan, existingRefs);
    if (existing === undefined) {
      return action.action === 'patch_memdir'
        ? { actionIndex, kind: 'reject', reason: 'patch target is missing or governance-incompatible' }
        : { actionIndex, kind: 'create', reason: 'no compatible governed claim exists' };
    }
    if (existing.lifecycle === 'quarantined') {
      return {
        actionIndex,
        kind: 'quarantine',
        existingRefId: existing.id,
        reason: 'compatible claim is quarantined',
      };
    }
    if (existing.lifecycle === 'archived' || existing.authority === 'proposal_only') {
      return {
        actionIndex,
        kind: 'reject',
        existingRefId: existing.id,
        reason: 'compatible claim is not eligible for governed update',
      };
    }
    const snapshot = await this.readRef(existing);
    const sameClaim = action.relationship === 'same_claim'
      || normalizeClaimBody(snapshot.body) === normalizeClaimBody(action.proposedBody);
    const incomingEvidence = plan.episodeDigest?.evidenceRefs ?? plan.sourceRefs;
    const hasNewEvidence = incomingEvidence.some((ref) => !existing.sourceRefs.includes(ref));
    if (sameClaim && !hasNewEvidence) {
      return {
        actionIndex,
        kind: 'no_action',
        existingRefId: existing.id,
        reason: 'compatible claim and evidence already exist',
      };
    }
    return {
      actionIndex,
      kind: sameClaim && action.relationship !== 'condition_refinement'
        ? 'evidence_update'
        : 'condition_refinement',
      existingRefId: existing.id,
      reason: sameClaim
        ? 'compatible claim has new independent evidence'
        : 'compatible claim receives a reviewed condition refinement',
    };
  }

  private async applyHostEligibleProposal(
    id: string,
    policyId: string,
    policyReason: string,
  ): Promise<MemoryApplyResult> {
    const proposal = await this.showProposal(id);
    if (proposal === undefined) return skippedApply(id, 'memory proposal not found');
    const result = await this.adapterForProposal(proposal).applyProposal(proposal, {
      proposalId: proposal.id,
      approvedBy: 'host',
      approvedAt: this.now(),
      expectedFingerprints: proposal.expectedFingerprints,
      policyId,
      policyReason,
    });
    if (result.applied) this.emit({ type: 'proposal.approved', proposalId: id });
    return result;
  }

  private async projectLearningProposal(entry: StoredLearningProposal): Promise<MemoryActionProposal | undefined> {
    if (entry.proposal.destination === 'memdir_handoff') {
      return this.projectMemdirHandoff(entry, entry.proposal);
    }
    if (entry.proposal.destination === 'reasoning_handoff') {
      return this.projectReasoningHandoff(entry, entry.proposal);
    }
    return undefined;
  }

  private async projectMemdirHandoff(
    entry: StoredLearningProposal,
    handoff: MemoryLearningHandoff,
  ): Promise<MemoryActionProposal> {
    const targetRoot = this.memoryRootForHandoff(handoff);
    const descriptor = this.scopedRoots.find((candidate) => candidate.root === targetRoot);
    const plan = buildMemdirWritePlan(targetRoot, handoff, entry.proposalId);
    const targetRef = await buildMemdirTargetRef(plan.targetPath, handoff, entry, descriptor);
    const indexRef = await buildEntrypointRef(plan.entrypointPath, descriptor);
    const sourceRef = learningRefFromEntry(entry);
    const beforeFingerprints = {
      [targetRef.id]: targetRef.bodyFingerprint ?? MISSING_FINGERPRINT,
      [indexRef.id]: indexRef.bodyFingerprint ?? MISSING_FINGERPRINT,
    };
    const preview: MemoryApplyPreview = {
      summary: `${handoff.metadata.persistenceKind === 'evidence_update'
        || handoff.metadata.persistenceKind === 'condition_refinement' ? 'Update' : 'Write'} ${handoff.memoryKind} memory from learning proposal ${entry.proposalId}.`,
      changedRefs: [targetRef, indexRef],
      changedPaths: [plan.targetPath, plan.entrypointPath],
      beforeFingerprints,
      afterFingerprints: {
        [targetRef.id]: fingerprint(plan.content),
      },
      diff: plan.content,
      warnings: [],
    };
    return {
      id: memoryProposalId(entry.proposalId),
      action: handoff.metadata.persistenceKind === 'evidence_update'
        || handoff.metadata.persistenceKind === 'condition_refinement'
        ? 'patch_memdir'
        : 'write_memdir',
      targetRefs: [targetRef, indexRef],
      sourceRefs: [sourceRef],
      expectedFingerprints: beforeFingerprints,
      rationale: `F224 classified this as ${handoff.memoryKind} memory.`,
      risk: 'medium',
      preview,
      requiresApproval: true,
      createdAt: entry.createdAt,
    };
  }

  private projectReasoningHandoff(
    entry: StoredLearningProposal,
    handoff: ReasoningLearningHandoff,
  ): MemoryActionProposal {
    const reasoningRef = reasoningRefFromEntry(entry);
    const sourceRef = learningRefFromEntry(entry);
    const preview: MemoryApplyPreview = {
      summary: `Record reasoning report handoff: ${handoff.title}`,
      changedRefs: [],
      changedPaths: [],
      beforeFingerprints: { [reasoningRef.id]: reasoningRef.bodyFingerprint ?? fingerprint(handoff.body) },
      warnings: ['No stable reasoning-strategy carrier exists yet; approval records the handoff only.'],
    };
    return {
      id: memoryProposalId(entry.proposalId),
      action: 'no_op',
      targetRefs: [reasoningRef],
      sourceRefs: [sourceRef],
      expectedFingerprints: preview.beforeFingerprints,
      rationale: 'Reasoning handoff stays as a report until a stable carrier exists.',
      risk: 'low',
      preview,
      requiresApproval: true,
      createdAt: entry.createdAt,
    };
  }

  private async listLearningRefs(): Promise<readonly MemoryItemRef[]> {
    const store = await readLearningProposalStore(this.learningStorePath);
    if (store.warnings.length > 0) return [];
    const refs: MemoryItemRef[] = [];
    for (const entry of store.proposals) {
      if (entry.proposal.destination === 'memdir_handoff' || entry.proposal.destination === 'reasoning_handoff') {
        refs.push(learningRefFromEntry(entry));
      }
      if (entry.proposal.destination === 'reasoning_handoff') {
        refs.push(reasoningRefFromEntry(entry));
      }
    }
    return refs;
  }

  private async readLearningRef(ref: MemoryItemRef): Promise<MemoryBodySnapshot> {
    const proposalId = ref.kind === 'reasoning_report'
      ? ref.id.replace(/^reasoning_report:/, '')
      : ref.id.replace(/^learning_proposal:/, '');
    const store = await readLearningProposalStore(this.learningStorePath);
    const entry = store.proposals.find((proposal) => proposal.proposalId === proposalId);
    if (entry === undefined) {
      return {
        ref,
        body: '',
        bodyFingerprint: fingerprint(''),
        readAt: this.now(),
        warnings: [`learning proposal not found: ${proposalId}`],
      };
    }
    const body = learningBody(entry);
    return {
      ref: { ...ref, bodyFingerprint: fingerprint(body) },
      body,
      bodyFingerprint: fingerprint(body),
      readAt: this.now(),
      warnings: store.warnings,
    };
  }

  private async listProjectDocRefs(): Promise<readonly MemoryItemRef[]> {
    const refs: MemoryItemRef[] = [];
    for (const docPath of this.projectDocs) {
      const read = await readTextIfExists(docPath);
      if (!read.exists) continue;
      refs.push({
        kind: 'project_doc',
        id: `project_doc:${relative(this.cwd, docPath).replace(/\\/g, '/')}`,
        scope: 'project',
        title: basename(docPath),
        owner: 'project',
        lifecycle: 'readonly',
        authority: 'read_only',
        visibility: 'prompt_safe',
        sourceRefs: [],
        relatedRefs: [],
        bodyFingerprint: fingerprint(read.content),
        storageUri: docPath,
      });
    }
    return refs;
  }

  private listSessionTraceRefs(): readonly MemoryItemRef[] {
    if (this.sessionLineage === undefined) return [];
    return this.sessionLineage.entries.map((entry) => sessionTraceRefFromEntry(this.sessionId, entry));
  }

  private listArtifactLedgerRefs(): readonly MemoryItemRef[] {
    return this.artifactLedger.map((entry) => artifactLedgerRefFromEntry(this.sessionId, entry));
  }

  private readSessionTraceRef(ref: MemoryItemRef): MemoryBodySnapshot {
    const entryId = parseScopedMemoryRefId(ref.id, 'session_trace', this.sessionId);
    const entry = this.sessionLineage?.entries.find((candidate) => candidate.id === entryId);
    const body = entry === undefined ? '' : stringifyJson(entry);
    return {
      ref: { ...ref, bodyFingerprint: fingerprint(body) },
      body,
      bodyFingerprint: fingerprint(body),
      readAt: this.now(),
      warnings: entry === undefined ? [`session trace entry not found: ${ref.id}`] : [],
    };
  }

  private readArtifactLedgerRef(ref: MemoryItemRef): MemoryBodySnapshot {
    const entryId = parseScopedMemoryRefId(ref.id, 'artifact_ledger', this.sessionId);
    const entry = this.artifactLedger.find((candidate) => candidate.id === entryId);
    const body = entry === undefined ? '' : stringifyJson(entry);
    return {
      ref: { ...ref, bodyFingerprint: fingerprint(body) },
      body,
      bodyFingerprint: fingerprint(body),
      readAt: this.now(),
      warnings: entry === undefined ? [`artifact ledger entry not found: ${ref.id}`] : [],
    };
  }

  private async listSkillRefs(): Promise<readonly MemoryItemRef[]> {
    if (!this.discoverSkills) return [];
    let skills: readonly SkillMetadata[];
    try {
      const registry = await initializeSkillRegistry(this.cwd);
      skills = registry.list();
    } catch {
      return [];
    }
    return skills.map((skill) => ({
      kind: 'skill',
      id: `skill:${skill.name}`,
      scope: skill.source === 'builtin' ? 'builtin' : skill.source === 'user' ? 'user' : 'project',
      title: skill.name,
      owner: skill.source === 'builtin' ? 'kodax' : skill.source === 'user' ? 'user' : 'project',
      lifecycle: skill.source === 'builtin' ? 'readonly' : 'active',
      authority: 'read_only',
      visibility: 'prompt_safe',
      sourceRefs: [],
      relatedRefs: [],
      storageUri: join(skill.path, 'SKILL.md'),
    } satisfies MemoryItemRef));
  }

  private async buildPackHints(
    refs: readonly MemoryItemRef[],
    input: MemoryPackInput,
  ): Promise<readonly MemoryPackHint[]> {
    const hints: MemoryPackHint[] = [];
    for (const ref of refs) {
      const snapshot = input.includeSnippets === true ? await this.readRef(ref) : undefined;
      const hook = sanitizePromptSafeMemoryClaim(ref.title ?? ref.id, 240) ?? ref.id;
      const rawSnippet = snapshot === undefined || snapshot.body.trim().length === 0
        ? undefined
        : input.purpose === 'deliberate_query' || input.purpose === 'intervention'
          ? promptSafeClaimSnippet(snapshot.body)
          : firstSnippet(snapshot.body);
      const bodySnippet = rawSnippet === undefined
        ? undefined
        : sanitizePromptSafeMemoryClaim(rawSnippet, 512);
      hints.push({
        ref,
        hook,
        reason: packReason(ref, memoryPackRankingText(input)),
        ...(bodySnippet !== undefined && snapshot !== undefined
          ? {
              bodySnippet,
              bodyFingerprint: snapshot.bodyFingerprint,
            }
          : ref.bodyFingerprint !== undefined ? { bodyFingerprint: ref.bodyFingerprint } : {}),
      });
    }
    return hints;
  }

  private async selectReviewCandidateRefs(input: MemoryReviewInput): Promise<ReviewCandidateSelection> {
    const maxRefs = Math.max(0, input.maxRefs ?? 6);
    if (maxRefs === 0) return { candidateRefs: [], warnings: [] };

    const refs = await this.listRefs({
      includePrivate: input.includePrivate,
      includeSensitive: input.includeSensitive,
    });
    const warnings: string[] = [];
    const selected = input.candidateRefIds !== undefined && input.candidateRefIds.length > 0
      ? selectRefsById(refs, input.candidateRefIds, maxRefs, warnings)
      : refs
          .filter(isReviewCandidateEligible)
          .sort((left, right) => scoreRef(right, reviewTask(input)) - scoreRef(left, reviewTask(input)))
          .slice(0, maxRefs);

    const candidateRefs: MemoryReviewCandidateRef[] = [];
    for (const ref of selected) {
      candidateRefs.push(await this.readReviewCandidateRef(ref));
    }
    return { candidateRefs, warnings };
  }

  private async readReviewCandidateRef(ref: MemoryItemRef): Promise<MemoryReviewCandidateRef> {
    try {
      const snapshot = await this.readRef(ref);
      return {
        ref: snapshot.ref,
        ...(snapshot.body.trim().length > 0 ? { bodySnippet: firstSnippet(snapshot.body) } : {}),
        bodyFingerprint: snapshot.bodyFingerprint,
        warnings: snapshot.warnings,
      };
    } catch (error) {
      return {
        ref,
        ...(ref.bodyFingerprint !== undefined ? { bodyFingerprint: ref.bodyFingerprint } : {}),
        warnings: [`failed to read memory ref: ${errorMessage(error)}`],
      };
    }
  }

  private adapterForProposal(proposal: MemoryActionProposal): MemorySourceAdapter {
    if (proposal.action === 'write_memdir' || proposal.action === 'patch_memdir') {
      return this.memdirAdapter();
    }
    return new LearningHandoffAdapter(this.learningStorePath, this.now);
  }

  private memdirAdapter(): MemdirMemoryAdapter {
    return this.memdirAdapters()[0]
      ?? new MemdirMemoryAdapter(this.memoryRoot, this.learningStorePath, this.now);
  }

  private memdirAdapters(): readonly MemdirMemoryAdapter[] {
    if (this.scopedRoots.length === 0) {
      return [new MemdirMemoryAdapter(
        this.memoryRoot,
        this.learningStorePath,
        this.now,
        this.applicability,
        'project',
      )];
    }
    return this.scopedRoots.map((entry) => new MemdirMemoryAdapter(
      entry.root,
      this.learningStorePath,
      this.now,
      entry.applicability,
      entry.scope,
    ));
  }

  private memoryRootForHandoff(handoff: MemoryLearningHandoff): string {
    const targetScope = handoff.memoryKind === 'user'
      ? 'user'
      : handoff.memoryKind === 'semantic_memory'
        ? 'agent'
        : 'project';
    return this.scopedRoots.find((entry) => entry.scope === targetScope)?.root ?? this.memoryRoot;
  }

  private memoryRootForRef(ref: MemoryItemRef): string {
    const storage = ref.storageUri === undefined ? undefined : resolve(ref.storageUri);
    return this.scopedRoots.find((entry) =>
      storage?.startsWith(`${resolve(entry.root)}${sep}`))?.root ?? this.memoryRoot;
  }

  private emit(event: MemoryEvent): void {
    this.onEvent?.(event);
  }

  private buildGovernanceReport(refs: readonly MemoryItemRef[]): MemoryGovernanceReport {
    const generatedAt = this.now();
    const findings = buildGovernanceFindings(refs);
    const reportId = `memory-governance:${fingerprint(`${generatedAt}:${findings.length}`).slice(0, 12)}`;
    return {
      reportId,
      generatedAt,
      findings: findings.length > 0
        ? findings
        : [{
            kind: 'no_op',
            severity: 'info',
            refIds: [],
            summary: 'No memory governance findings.',
            suggestedAction: 'no_op',
          }],
      warnings: [],
    };
  }
}

class LearningHandoffAdapter implements MemorySourceAdapter {
  readonly kind = 'learning_proposal' as const;

  constructor(
    private readonly learningStorePath: string,
    private readonly now: () => string,
  ) {}

  async listRefs(filter: MemoryRefFilter = {}): Promise<readonly MemoryItemRef[]> {
    const store = await readLearningProposalStore(this.learningStorePath);
    if (store.warnings.length > 0) return [];
    return store.proposals
      .filter((entry) => entry.proposal.destination === 'memdir_handoff' || entry.proposal.destination === 'reasoning_handoff')
      .map(learningRefFromEntry)
      .filter((ref) => matchesFilter(ref, filter));
  }

  async readRef(ref: MemoryItemRef): Promise<MemoryBodySnapshot> {
    return readStorageBackedRef(ref, this.now);
  }

  async previewProposal(proposal: MemoryActionProposal): Promise<MemoryApplyPreview> {
    return proposal.preview;
  }

  async applyProposal(
    proposal: MemoryActionProposal,
    approval: MemoryApproval,
  ): Promise<MemoryApplyResult> {
    const proposalId = parseMemoryProposalId(proposal.id);
    if (proposalId === undefined) return skippedApply(proposal.id, 'invalid memory proposal id');
    if (!fingerprintsMatch(proposal.expectedFingerprints, approval.expectedFingerprints)) {
      return skippedApply(proposal.id, 'approval fingerprints do not match proposal preview');
    }
    const updated = await updateLearningProposalStatus(
      this.learningStorePath,
      proposalId,
      'approved',
      {
        appliedChangedPaths: [],
        approvedBy: approval.approvedBy,
        approvedAt: approval.approvedAt,
        approvalPolicyId: approval.policyId,
        approvalPolicyReason: approval.policyReason,
        approvalExpectedFingerprints: approval.expectedFingerprints,
        approvalResultingFingerprints: approval.expectedFingerprints,
        now: this.now,
      },
    );
    return {
      proposalId: proposal.id,
      applied: true,
      changedRefs: proposal.targetRefs,
      changedPaths: [],
      warnings: updated.status === 'approved' ? [] : ['proposal status did not become approved'],
    };
  }
}

class MemdirMemoryAdapter implements MemorySourceAdapter {
  readonly kind = 'memdir' as const;

  constructor(
    private readonly memoryRoot: string,
    private readonly learningStorePath: string,
    private readonly now: () => string,
    private readonly applicability?: MemoryApplicability,
    private readonly scope: Extract<MemoryScope, 'project' | 'workspace' | 'agent' | 'user'> = 'project',
  ) {}

  async listRefs(filter: MemoryRefFilter = {}): Promise<readonly MemoryItemRef[]> {
    const refs: MemoryItemRef[] = [];
    const proposalStore = this.applicability === undefined
      ? undefined
      : await readLearningProposalStore(this.learningStorePath);
    let entries: readonly { readonly name: string; readonly isFile: () => boolean }[];
    try {
      entries = await readdir(this.memoryRoot, { withFileTypes: true });
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === 'MEMORY.md') continue;
      const filePath = join(this.memoryRoot, entry.name);
      const read = await readTextIfExists(filePath);
      if (!read.exists) continue;
      const ref = memdirRefFromFile(filePath, read.content);
      const lifecycle = await resolveManagedLifecycle(this.memoryRoot, ref);
      if (lifecycle === 'forgotten') continue;
      const governedRef = lifecycle === ref.lifecycle ? ref : { ...ref, lifecycle };
      if (this.applicability === undefined) {
        refs.push(governedRef);
        continue;
      }
      const scopedRef = decorateScopedRef(governedRef, this.scope, this.applicability);
      const receipt = findApplyReceipt(proposalStore?.proposals ?? [], scopedRef, read.content);
      const receiptMetadata = receipt?.proposal.destination === 'memdir_handoff'
        ? receipt.proposal.metadata
        : undefined;
      const governedScopedRef = receiptMetadata?.applicability === undefined
        ? scopedRef
        : decorateScopedRef(governedRef, this.scope, receiptMetadata.applicability);
      refs.push(receipt === undefined
        ? { ...scopedRef, lifecycle: 'provisional', authority: 'proposal_only' }
        : {
            ...governedScopedRef,
            lifecycle: governedScopedRef.lifecycle === 'archived'
              ? 'archived'
              : receiptMetadata?.requestedLifecycle ?? 'active',
            sourceRefs: receipt.proposal.destination === 'memdir_handoff'
              ? receipt.proposal.metadata.sourceRefs
              : governedScopedRef.sourceRefs,
            ...(receipt.proposal.destination === 'memdir_handoff'
              && receipt.proposal.metadata.claimKind !== undefined
              ? { claimKind: receipt.proposal.metadata.claimKind }
              : {}),
            ...(receipt.proposal.destination === 'memdir_handoff'
              && receipt.proposal.metadata.claimKey !== undefined
              ? { claimKey: receipt.proposal.metadata.claimKey }
              : {}),
            ...(receipt.proposal.destination === 'memdir_handoff'
              && receipt.proposal.metadata.actionSignature !== undefined
              ? { actionSignature: receipt.proposal.metadata.actionSignature }
              : {}),
            applyReceiptRef: `learning_proposal:${receipt.proposalId}`,
            expectedFingerprint: receipt.approvalExpectedFingerprints?.[governedScopedRef.id],
            resultingFingerprint: receipt.approvalResultingFingerprints?.[governedScopedRef.id],
          });
    }
    return refs.filter((ref) => matchesFilter(ref, filter));
  }

  async readRef(ref: MemoryItemRef): Promise<MemoryBodySnapshot> {
    return readStorageBackedRef(ref, this.now);
  }

  async previewProposal(proposal: MemoryActionProposal): Promise<MemoryApplyPreview> {
    return proposal.preview;
  }

  async applyProposal(
    proposal: MemoryActionProposal,
    approval: MemoryApproval,
  ): Promise<MemoryApplyResult> {
    const proposalId = parseMemoryProposalId(proposal.id);
    if (proposalId === undefined) return skippedApply(proposal.id, 'invalid memory proposal id');
    const target = proposal.targetRefs.find((ref) => ref.kind === 'memdir' && ref.storageUri !== undefined);
    const indexRef = proposal.targetRefs.find((ref) =>
      ref.storageUri !== undefined && basename(ref.storageUri) === 'MEMORY.md');
    if (target?.storageUri === undefined || indexRef?.storageUri === undefined) {
      return skippedApply(proposal.id, 'memory proposal has no memdir target');
    }
    const expectedTargetFingerprint = approval.expectedFingerprints[target.id];
    const expectedIndexFingerprint = approval.expectedFingerprints[indexRef.id];
    if (expectedTargetFingerprint === undefined || expectedIndexFingerprint === undefined) {
      return skippedApply(proposal.id, 'approval fingerprints do not cover proposal preview');
    }
    const mutableRefs = [target, indexRef];
    const protectedRef = mutableRefs.find((ref) => isProtectedFromMutation(ref));
    if (protectedRef !== undefined) {
      return skippedApply(proposal.id, `${protectedRef.id} is not mutable by memory governance`);
    }
    const currentTarget = await readTextIfExists(target.storageUri);
    const currentIndex = await readTextIfExists(indexRef.storageUri);
    const content = proposal.preview.diff ?? '';
    const indexLine = indexLineFromContent(target.storageUri, content);
    const targetAlreadyApplied = currentTarget.exists && currentTarget.content === content;
    const resultingIndexContent = upsertIndexLine(currentIndex.content, target.storageUri, indexLine);
    const indexAlreadyApplied = currentIndex.exists && currentIndex.content === resultingIndexContent;
    if (fingerprintOrMissing(currentTarget) !== expectedTargetFingerprint && !targetAlreadyApplied) {
      return skippedApply(proposal.id, 'target memory changed after preview');
    }
    if (
      fingerprintOrMissing(currentIndex) !== expectedIndexFingerprint
      && !targetAlreadyApplied
      && !indexAlreadyApplied
    ) {
      return skippedApply(proposal.id, 'MEMORY.md changed after preview');
    }
    const changedPaths: string[] = [];
    const warnings: string[] = [];
    if (!targetAlreadyApplied) {
      await writeFileAtomic(target.storageUri, content);
      changedPaths.push(target.storageUri);
    } else {
      warnings.push('target memory already matched proposal content; completing approval');
    }
    if (!indexAlreadyApplied) {
      await writeFileAtomic(indexRef.storageUri, resultingIndexContent);
      changedPaths.push(indexRef.storageUri);
    } else {
      warnings.push('MEMORY.md already contained the proposal index line; completing approval');
    }
    await updateLearningProposalStatus(
      this.learningStorePath,
      proposalId,
      'approved',
      {
        appliedAt: this.now(),
        appliedChangedPaths: [target.storageUri, indexRef.storageUri],
        approvedBy: approval.approvedBy,
        approvedAt: approval.approvedAt,
        approvalPolicyId: approval.policyId,
        approvalPolicyReason: approval.policyReason,
        approvalExpectedFingerprints: approval.expectedFingerprints,
        approvalResultingFingerprints: {
          [target.id]: fingerprint(content),
          [indexRef.id]: fingerprint(resultingIndexContent),
        },
        now: this.now,
      },
    );
    return {
      proposalId: proposal.id,
      applied: true,
      changedRefs: proposal.targetRefs,
      changedPaths,
      warnings,
    };
  }
}

function defaultProjectDocs(cwd: string): readonly string[] {
  return [
    'README.md',
    'AGENTS.md',
    join('docs', 'PRD.md'),
    join('docs', 'ADR.md'),
    join('docs', 'HLD.md'),
    join('docs', 'DD.md'),
    join('docs', 'FEATURE_LIST.md'),
  ].map((item) => resolve(cwd, item));
}

function buildScopedRoots(identity: MemoryContextIdentity): readonly {
  readonly root: string;
  readonly scope: Extract<MemoryScope, 'project' | 'workspace' | 'agent' | 'user'>;
  readonly applicability: MemoryApplicability;
}[] {
  const roots: Array<{
    root: string;
    scope: Extract<MemoryScope, 'project' | 'workspace' | 'agent' | 'user'>;
    applicability: MemoryApplicability;
  }> = [];
  if (identity.projectId !== undefined) roots.push({
    root: resolveScopedMemoryRoot(identity, 'project'),
    scope: 'project',
    applicability: { tenantId: identity.tenantId, projectId: identity.projectId },
  });
  if (identity.workspaceId !== undefined) roots.push({
    root: resolveScopedMemoryRoot(identity, 'workspace'),
    scope: 'workspace',
    applicability: { tenantId: identity.tenantId, workspaceId: identity.workspaceId },
  });
  roots.push({
    root: resolveScopedMemoryRoot(identity, 'agent'),
    scope: 'agent',
    applicability: { tenantId: identity.tenantId, agentId: identity.agentId },
  });
  if (identity.userId !== undefined) roots.push({
    root: resolveScopedMemoryRoot(identity, 'user'),
    scope: 'user',
    applicability: { tenantId: identity.tenantId, userId: identity.userId },
  });
  return roots;
}

function memoryProposalId(proposalId: string): string {
  return `memory:${proposalId}`;
}

function parseMemoryProposalId(id: string): string | undefined {
  return id.startsWith('memory:') ? id.slice('memory:'.length) : undefined;
}

function fingerprint(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function fingerprintOrMissing(read: ReadTextResult): string {
  return read.exists ? fingerprint(read.content) : MISSING_FINGERPRINT;
}

function lifecycleFromStatus(entry: StoredLearningProposal): MemoryItemRef['lifecycle'] {
  if (entry.status === 'pending') return 'pending';
  if (entry.status === 'approved') return 'trusted';
  return 'archived';
}

function learningRefFromEntry(entry: StoredLearningProposal): MemoryItemRef {
  const body = learningBody(entry);
  return {
    kind: 'learning_proposal',
    id: `learning_proposal:${entry.proposalId}`,
    scope: 'project',
    title: learningTitle(entry),
    owner: 'project',
    lifecycle: lifecycleFromStatus(entry),
    authority: 'proposal_only',
    visibility: 'prompt_safe',
    sourceRefs: learningSourceRefs(entry),
    relatedRefs: [],
    bodyFingerprint: fingerprint(body),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

function reasoningRefFromEntry(entry: StoredLearningProposal): MemoryItemRef {
  const title = entry.proposal.destination === 'reasoning_handoff'
    ? entry.proposal.title
    : entry.proposalId;
  const body = learningBody(entry);
  return {
    kind: 'reasoning_report',
    id: `reasoning_report:${entry.proposalId}`,
    scope: 'project',
    title,
    owner: 'project',
    lifecycle: lifecycleFromStatus(entry),
    authority: 'proposal_only',
    visibility: 'prompt_safe',
    sourceRefs: learningSourceRefs(entry),
    relatedRefs: [`learning_proposal:${entry.proposalId}`],
    bodyFingerprint: fingerprint(body),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

function sessionTraceRefFromEntry(sessionId: string, entry: KodaXSessionEntry): MemoryItemRef {
  const body = stringifyJson(entry);
  return {
    kind: 'session_trace',
    id: `session_trace:${sessionId}:${entry.id}`,
    scope: 'session',
    title: `Session ${entry.type}: ${entry.id}`,
    owner: 'project',
    lifecycle: 'provisional',
    authority: 'read_only',
    visibility: 'private',
    sourceRefs: [],
    relatedRefs: entry.parentId === null ? [] : [`session_trace:${sessionId}:${entry.parentId}`],
    version: '2',
    bodyFingerprint: fingerprint(body),
    createdAt: entry.timestamp,
    updatedAt: entry.timestamp,
  };
}

function artifactLedgerRefFromEntry(
  sessionId: string,
  entry: KodaXSessionArtifactLedgerEntry,
): MemoryItemRef {
  const body = stringifyJson(entry);
  return {
    kind: 'artifact_ledger',
    id: `artifact_ledger:${sessionId}:${entry.id}`,
    scope: 'session',
    title: entry.summary ?? entry.displayTarget ?? entry.target,
    owner: 'project',
    lifecycle: 'provisional',
    authority: 'read_only',
    visibility: 'prompt_safe',
    sourceRefs: entry.sessionEntryId === undefined
      ? []
      : [`session_trace:${sessionId}:${entry.sessionEntryId}`],
    relatedRefs: [],
    bodyFingerprint: fingerprint(body),
    createdAt: entry.timestamp,
    updatedAt: entry.timestamp,
  };
}

function parseScopedMemoryRefId(
  id: string,
  kind: 'session_trace' | 'artifact_ledger',
  sessionId: string,
): string {
  const prefix = `${kind}:${sessionId}:`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : '';
}

function learningTitle(entry: StoredLearningProposal): string {
  const proposal = entry.proposal;
  if (proposal.destination === 'memdir_handoff') return `${proposal.memoryKind} memory handoff`;
  if (proposal.destination === 'reasoning_handoff') return proposal.title;
  return proposal.proposalId;
}

function learningSourceRefs(entry: StoredLearningProposal): readonly string[] {
  const proposal = entry.proposal;
  if (proposal.destination === 'memdir_handoff') return proposal.metadata.sourceRefs;
  if (proposal.destination === 'reasoning_handoff') return proposal.sourceTraceIds;
  return [];
}

function learningBody(entry: StoredLearningProposal): string {
  const proposal = entry.proposal;
  if (proposal.destination === 'memdir_handoff') return proposal.body;
  if (proposal.destination === 'reasoning_handoff') return proposal.body;
  return JSON.stringify(proposal, null, 2);
}

function buildMemdirWritePlan(memoryRoot: string, handoff: MemoryLearningHandoff, proposalId: string): MemdirWritePlan {
  const memoryType = memoryTypeForHandoff(handoff.memoryKind);
  const title = titleFromBody(handoff.body, `${handoff.memoryKind} memory`);
  const description = firstSentence(handoff.body) || title;
  const filename = handoff.metadata.targetStorageUri === undefined
    ? `${memoryType}_${slugify(title)}_${slugify(proposalId)}.md`
    : basename(handoff.metadata.targetStorageUri);
  const targetPath = handoff.metadata.targetStorageUri ?? join(memoryRoot, filename);
  const content = [
    '---',
    `name: ${quoteScalar(title)}`,
    `description: ${quoteScalar(description)}`,
    `type: ${memoryType}`,
    '---',
    '',
    handoff.body.trim(),
    '',
  ].join('\n');
  return {
    targetPath,
    entrypointPath: join(memoryRoot, 'MEMORY.md'),
    content,
    indexLine: `- [${title}](${filename}) - ${description}`,
  };
}

async function buildMemdirTargetRef(
  targetPath: string,
  handoff: MemoryLearningHandoff,
  entry: StoredLearningProposal,
  descriptor?: {
    readonly scope: Extract<MemoryScope, 'project' | 'workspace' | 'agent' | 'user'>;
    readonly applicability: MemoryApplicability;
  },
): Promise<MemoryItemRef> {
  const read = await readTextIfExists(targetPath);
  const ref: MemoryItemRef = {
    kind: 'memdir',
    id: `memdir:${basename(targetPath)}`,
    scope: handoff.memoryKind === 'user' ? 'user' : 'project',
    title: titleFromBody(handoff.body, `${handoff.memoryKind} memory`),
    owner: handoff.memoryKind === 'user' ? 'user' : 'project',
    lifecycle: read.exists ? 'active' : 'pending',
    authority: 'approved_write',
    visibility: 'prompt_safe',
    sourceRefs: [`learning_proposal:${entry.proposalId}`, ...handoff.metadata.sourceRefs],
    relatedRefs: [],
    ...(handoff.metadata.claimKind !== undefined ? { claimKind: handoff.metadata.claimKind } : {}),
    ...(handoff.metadata.claimKey !== undefined ? { claimKey: handoff.metadata.claimKey } : {}),
    ...(handoff.metadata.actionSignature !== undefined
      ? { actionSignature: handoff.metadata.actionSignature }
      : {}),
    bodyFingerprint: read.exists ? fingerprint(read.content) : MISSING_FINGERPRINT,
    storageUri: targetPath,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
  return descriptor === undefined
    ? ref
    : decorateScopedRef(
        ref,
        descriptor.scope,
        handoff.metadata.applicability ?? descriptor.applicability,
      );
}

async function buildEntrypointRef(
  entrypointPath: string,
  descriptor?: {
    readonly scope: Extract<MemoryScope, 'project' | 'workspace' | 'agent' | 'user'>;
    readonly applicability: MemoryApplicability;
  },
): Promise<MemoryItemRef> {
  const read = await readTextIfExists(entrypointPath);
  const ref: MemoryItemRef = {
    kind: 'memdir',
    id: 'memdir:MEMORY.md',
    scope: 'project',
    title: 'MEMORY.md',
    owner: 'project',
    lifecycle: read.exists ? 'active' : 'pending',
    authority: 'approved_write',
    visibility: 'prompt_safe',
    sourceRefs: [],
    relatedRefs: [],
    bodyFingerprint: read.exists ? fingerprint(read.content) : MISSING_FINGERPRINT,
    storageUri: entrypointPath,
  };
  return descriptor === undefined
    ? ref
    : decorateScopedRef(ref, descriptor.scope, descriptor.applicability);
}

function memdirRefFromFile(filePath: string, content: string): MemoryItemRef {
  const parsed = parseMemoryFile(content);
  const filename = basename(filePath);
  const memoryType = parsed.frontmatter.type;
  return {
    kind: 'memdir',
    id: `memdir:${filename}`,
    scope: memoryType === 'user' ? 'user' : 'project',
    title: parsed.frontmatter.name ?? filename,
    owner: memoryType === 'user' ? 'user' : 'project',
    lifecycle: 'active',
    authority: filename === 'MEMORY.md' ? 'read_only' : 'approved_write',
    visibility: 'prompt_safe',
    sourceRefs: [],
    relatedRefs: [],
    bodyFingerprint: fingerprint(content),
    storageUri: filePath,
  };
}

function decorateScopedRef(
  ref: MemoryItemRef,
  scope: Extract<MemoryScope, 'project' | 'workspace' | 'agent' | 'user'>,
  applicability: MemoryApplicability,
): MemoryItemRef {
  const scopeId = memoryApplicabilityFingerprint(applicability);
  const filename = ref.storageUri === undefined ? ref.id : basename(ref.storageUri);
  return {
    ...ref,
    id: `memdir:${scope}:${scopeId}:${filename}`,
    scope,
    scopeId,
    applicability,
  };
}

function findApplyReceipt(
  proposals: readonly StoredLearningProposal[],
  ref: MemoryItemRef,
  content: string,
): StoredLearningProposal | undefined {
  if (ref.storageUri === undefined) return undefined;
  const storageUri = ref.storageUri;
  const bodyFingerprint = fingerprint(content);
  for (let index = proposals.length - 1; index >= 0; index -= 1) {
    const proposal = proposals[index]!;
    if (proposal.status === 'approved'
      && proposal.appliedChangedPaths?.includes(storageUri) === true
      && Object.values(proposal.approvalResultingFingerprints ?? {}).includes(bodyFingerprint)) {
      return proposal;
    }
  }
  return undefined;
}

function memoryTypeForHandoff(kind: MemoryLearningHandoff['memoryKind']): MemoryType {
  if (kind === 'user' || kind === 'feedback' || kind === 'project' || kind === 'reference') return kind;
  return 'project';
}

function titleFromBody(body: string, fallback: string): string {
  const first = body.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0);
  if (first === undefined) return fallback;
  return first.replace(/^#+\s*/, '').slice(0, 80) || fallback;
}

function firstSentence(body: string): string | undefined {
  const compact = body.replace(/\s+/g, ' ').trim();
  if (compact.length === 0) return undefined;
  const sentenceEnd = compact.search(/[.!?。！？]/);
  const value = sentenceEnd >= 0 ? compact.slice(0, sentenceEnd + 1) : compact;
  return value.slice(0, 160);
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return slug.length > 0 ? slug : 'memory';
}

function quoteScalar(value: string): string {
  return JSON.stringify(value.replace(/\r?\n/g, ' '));
}

function indexLineFromContent(filePath: string, content: string): string {
  const parsed = parseMemoryFile(content);
  const title = parsed.frontmatter.name ?? basename(filePath, '.md');
  const description = parsed.frontmatter.description ?? title;
  return `- [${title}](${basename(filePath)}) - ${description}`;
}

function upsertIndexLine(current: string, targetPath: string, line: string): string {
  const trimmed = current.trimEnd();
  if (indexContainsLine(trimmed, line)) return `${trimmed}\n`;
  const targetFilename = basename(targetPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const existingPattern = new RegExp(`^.*\\(${targetFilename}\\).*$`, 'm');
  if (existingPattern.test(trimmed)) return `${trimmed.replace(existingPattern, line)}\n`;
  return trimmed.length > 0 ? `${line}\n${trimmed}\n` : `${line}\n`;
}

function indexContainsLine(content: string, line: string): boolean {
  return content.trimEnd().split(/\r?\n/).includes(line);
}

async function readTextIfExists(filePath: string): Promise<ReadTextResult> {
  try {
    return { exists: true, content: await readFile(filePath, 'utf8') };
  } catch (error) {
    if (isMissingFile(error)) return { exists: false, content: '' };
    throw error;
  }
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = join(dirname(filePath), `.${basename(filePath)}.kodax-${process.pid}-${Date.now().toString(36)}.tmp`);
  try {
    await writeFile(tempPath, content, 'utf8');
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

function autoCuratorStatePath(memoryRoot: string): string {
  return join(memoryRoot, '.governance', 'auto-curate-state.json');
}

function autoCuratorReportPath(memoryRoot: string, report: MemoryGovernanceReport): string {
  const stamp = sanitizePathSegment(report.generatedAt);
  const reportId = sanitizePathSegment(report.reportId);
  return join(memoryRoot, '.governance', 'reports', `${stamp}-${reportId}.json`);
}

async function pruneAutoCuratorReports(memoryRoot: string, cap: number): Promise<void> {
  if (cap <= 0) return;
  const reportDir = join(memoryRoot, '.governance', 'reports');
  let entries: readonly { readonly name: string; readonly isFile: () => boolean }[];
  try {
    entries = await readdir(reportDir, { withFileTypes: true });
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
  const reports = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left));
  for (const staleName of reports.slice(cap)) {
    await rm(join(reportDir, staleName), { force: true });
  }
}

async function readAutoCuratorState(filePath: string): Promise<AutoCuratorState | undefined> {
  const read = await readTextIfExists(filePath);
  if (!read.exists) return undefined;
  try {
    const parsed: unknown = JSON.parse(read.content);
    return isAutoCuratorState(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function writeAutoCuratorState(filePath: string, state: AutoCuratorState): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

function isAutoCuratorState(value: unknown): value is AutoCuratorState {
  if (!isReadonlyRecord(value)) return false;
  return value.version === AUTO_CURATOR_STATE_VERSION
    && optionalStringField(value.lastCheckedAt)
    && optionalStringField(value.lastRunAt)
    && optionalStringField(value.lastInventoryFingerprint)
    && optionalStringField(value.lastReportPath);
}

function isReadonlyRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalStringField(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function addMs(isoTime: string, ms: number): string {
  const parsed = Date.parse(isoTime);
  const base = Number.isFinite(parsed) ? parsed : Date.now();
  return new Date(base + ms).toISOString();
}

function compareIso(left: string, right: string): number {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return 0;
  return leftTime - rightTime;
}

function isAutoCuratorCandidate(ref: MemoryItemRef): boolean {
  return ref.kind === 'memdir'
    || ref.kind === 'learning_proposal'
    || ref.kind === 'reasoning_report';
}

function memoryInventoryPayload(refs: readonly MemoryItemRef[]): string {
  return refs
    .map((ref) => [
      ref.id,
      ref.kind,
      ref.scope,
      ref.lifecycle,
      ref.authority,
      ref.visibility,
      ref.bodyFingerprint ?? '',
      ref.storageUri ?? '',
      ref.updatedAt ?? '',
      ref.title ?? '',
    ].join('\t'))
    .sort()
    .join('\n');
}

function sanitizePathSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return sanitized.length > 0 ? sanitized : 'report';
}

async function readStorageBackedRef(
  ref: MemoryItemRef,
  now: () => string,
): Promise<MemoryBodySnapshot> {
  if (ref.storageUri === undefined) {
    return {
      ref,
      body: '',
      bodyFingerprint: fingerprint(''),
      readAt: now(),
      warnings: ['memory ref has no storageUri'],
    };
  }
  const read = await readTextIfExists(ref.storageUri);
  if (!read.exists) {
    return {
      ref,
      body: '',
      bodyFingerprint: fingerprint(''),
      readAt: now(),
      warnings: [`memory ref storage does not exist: ${ref.storageUri}`],
    };
  }
  const parsed = ref.kind === 'memdir' ? parseMemoryFile(read.content) : undefined;
  return {
    ref: { ...ref, bodyFingerprint: fingerprint(read.content) },
    body: read.content,
    bodyFingerprint: fingerprint(read.content),
    ...(parsed !== undefined ? { frontmatter: frontmatterRecord(parsed.frontmatter) } : {}),
    readAt: now(),
    warnings: [],
  };
}

function frontmatterRecord(frontmatter: {
  readonly name: string | undefined;
  readonly description: string | undefined;
  readonly type: string | undefined;
}): Readonly<Record<string, string>> {
  const fields: Record<string, string> = {};
  if (frontmatter.name !== undefined) fields.name = frontmatter.name;
  if (frontmatter.description !== undefined) fields.description = frontmatter.description;
  if (frontmatter.type !== undefined) fields.type = frontmatter.type;
  return fields;
}

function matchesFilter(ref: MemoryItemRef, filter: MemoryRefFilter): boolean {
  if (filter.kinds !== undefined && !filter.kinds.includes(ref.kind)) return false;
  if (filter.scopes !== undefined && !filter.scopes.includes(ref.scope)) return false;
  if (filter.lifecycles !== undefined && !filter.lifecycles.includes(ref.lifecycle)) return false;
  if (ref.visibility === 'private' && filter.includePrivate !== true) return false;
  if (ref.visibility === 'sensitive' && filter.includeSensitive !== true) return false;
  if (filter.query !== undefined && !refMatchesQuery(ref, filter.query)) return false;
  return true;
}

function refMatchesQuery(ref: MemoryItemRef, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return [
    ref.id,
    ref.title ?? '',
    ref.kind,
    ref.scope,
    ref.owner,
    ...ref.sourceRefs,
    ...ref.relatedRefs,
  ].some((value) => value.toLowerCase().includes(needle));
}

function buildGovernanceFindings(refs: readonly MemoryItemRef[]): readonly MemoryGovernanceFinding[] {
  const findings: MemoryGovernanceFinding[] = [];
  findings.push(...duplicateFingerprintFindings(refs));
  findings.push(...conflictTitleFindings(refs));
  findings.push(...orphanedRefFindings(refs));
  for (const ref of refs) {
    if (ref.lifecycle === 'stale') {
      findings.push({
        kind: 'stale',
        severity: 'warning',
        refIds: [ref.id],
        summary: `${ref.id} is stale and excluded from normal memory packs.`,
        suggestedAction: 'archive',
      });
    }
    if (ref.lifecycle === 'quarantined') {
      findings.push({
        kind: 'quarantined',
        severity: 'warning',
        refIds: [ref.id],
        summary: `${ref.id} is quarantined and requires manual review.`,
        suggestedAction: 'conflict_report',
      });
    }
  }
  return findings;
}

function duplicateFingerprintFindings(refs: readonly MemoryItemRef[]): readonly MemoryGovernanceFinding[] {
  const groups = new Map<string, string[]>();
  for (const ref of refs) {
    if (ref.bodyFingerprint === undefined || ref.lifecycle === 'archived') continue;
    const group = groups.get(ref.bodyFingerprint) ?? [];
    group.push(ref.id);
    groups.set(ref.bodyFingerprint, group);
  }
  return Array.from(groups.entries())
    .filter(([, ids]) => ids.length > 1)
    .map(([fingerprintValue, ids]) => ({
      kind: 'duplicate',
      severity: 'warning',
      refIds: ids,
      summary: `Multiple refs share ${fingerprintValue}.`,
      suggestedAction: 'conflict_report',
    }));
}

function conflictTitleFindings(refs: readonly MemoryItemRef[]): readonly MemoryGovernanceFinding[] {
  const groups = new Map<string, MemoryItemRef[]>();
  for (const ref of refs) {
    const title = normalizeConflictTitle(ref.title);
    if (title === undefined || ref.bodyFingerprint === undefined || ref.lifecycle === 'archived') continue;
    const group = groups.get(title) ?? [];
    group.push(ref);
    groups.set(title, group);
  }
  return Array.from(groups.entries())
    .flatMap(([title, group]) => {
      const fingerprints = new Set(group.map((ref) => ref.bodyFingerprint));
      if (group.length < 2 || fingerprints.size <= 1) return [];
      return [{
        kind: 'conflict',
        severity: 'warning',
        refIds: group.map((ref) => ref.id),
        summary: `Multiple refs use the title "${title}" with different fingerprints.`,
        suggestedAction: 'conflict_report',
      } satisfies MemoryGovernanceFinding];
    });
}

function orphanedRefFindings(refs: readonly MemoryItemRef[]): readonly MemoryGovernanceFinding[] {
  const ids = new Set(refs.map((ref) => ref.id));
  return refs.flatMap((ref) => {
    const missing = ref.relatedRefs.filter((id) => isMemoryControlledRefId(id) && !ids.has(id));
    if (missing.length === 0) return [];
    return [{
      kind: 'orphaned',
      severity: 'warning',
      refIds: [ref.id, ...missing],
      summary: `${ref.id} points to missing memory ref(s): ${missing.join(', ')}.`,
      suggestedAction: 'conflict_report',
    } satisfies MemoryGovernanceFinding];
  });
}

function normalizeConflictTitle(title: string | undefined): string | undefined {
  const normalized = title?.trim().toLowerCase().replace(/\s+/g, ' ');
  return normalized !== undefined && normalized.length > 0 ? normalized : undefined;
}

function isMemoryControlledRefId(id: string): boolean {
  return /^(learning_proposal|reasoning_report|memdir|session_trace|artifact_ledger|skill|project_doc|self_manual|workflow_run|working_context):/.test(id);
}

function isProtectedFromMutation(ref: MemoryItemRef): boolean {
  return ref.authority === 'read_only' || ref.scope === 'builtin' || ref.pinned === true;
}

function isPackEligible(ref: MemoryItemRef, input: MemoryPackInput): boolean {
  if (ref.applicability !== undefined) {
    if (input.identity === undefined) return false;
    if (!matchesMemoryApplicability(input.identity, ref.applicability)) return false;
  }
  if (ref.visibility === 'private' && input.includePrivate !== true) return false;
  if (ref.visibility === 'sensitive' && input.includeSensitive !== true) return false;
  if (ref.authority === 'proposal_only') return false;
  return ref.lifecycle === 'trusted' || ref.lifecycle === 'active' || ref.lifecycle === 'readonly';
}

function isReviewCandidateEligible(ref: MemoryItemRef): boolean {
  if (ref.kind !== 'memdir' && ref.kind !== 'learning_proposal' && ref.kind !== 'reasoning_report') {
    return false;
  }
  return ref.lifecycle !== 'archived' && ref.lifecycle !== 'quarantined';
}

function isEligibleEpisodePromotion(
  action: MemoryReviewDraftAction,
  digest: import('../types.js').KodaXMemoryOutcomeDigest,
): boolean {
  if (action.confidence !== 'high' || action.risk !== 'low') return false;
  if (digest.visibility !== 'prompt_safe' || digest.evidenceRefs.length === 0) return false;
  if (!hasVerifiedDigestEvidence(digest)) return false;
  if (action.claimKind === 'procedure' && digest.outcome !== 'succeeded') return false;
  const body = action.proposedBody ?? '';
  if (body.length === 0) return false;
  return !/(?:api[_-]?key|authorization:\s*bearer|private key|password|secret|token\s*[:=])/i.test(body);
}

function findCompatibleReviewRef(
  action: MemoryReviewDraftAction,
  plan: MemoryReviewPlan,
  refs: readonly MemoryItemRef[],
): MemoryItemRef | undefined {
  const targetIds = new Set(action.targetRefIds);
  const direct = refs.find((ref) => targetIds.has(ref.id));
  if (direct !== undefined) return isGovernanceCompatibleReviewRef(direct, action) ? direct : undefined;
  if (targetIds.size > 0) return undefined;

  if (action.claimKey !== undefined) {
    const byClaimKey = refs.find((ref) =>
      ref.claimKey === action.claimKey && isGovernanceCompatibleReviewRef(ref, action));
    if (byClaimKey !== undefined) return byClaimKey;
  }

  const candidateIds = new Set(plan.candidateRefs.map((candidate) => candidate.ref.id));
  return refs.find((ref) => candidateIds.has(ref.id) && isGovernanceCompatibleReviewRef(ref, action));
}

function isGovernanceCompatibleReviewRef(
  ref: MemoryItemRef,
  action: MemoryReviewDraftAction,
): boolean {
  if (ref.kind !== 'memdir' || ref.visibility !== 'prompt_safe') return false;
  if (action.claimKind !== undefined && ref.claimKind !== undefined && ref.claimKind !== action.claimKind) {
    return false;
  }
  return true;
}

function normalizeClaimBody(body: string): string {
  return parseMemoryFile(body).body
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function procedurePromotionHistory(
  claimKey: string,
  proposals: readonly StoredLearningProposal[],
  currentProjectId: string | undefined,
  currentCounterexample: boolean,
): { readonly successes: number; readonly projects: Set<string>; readonly hasCounterexample: boolean } {
  let successes = currentProjectId === undefined ? 0 : 1;
  let hasCounterexample = currentCounterexample;
  const projects = new Set<string>();
  if (currentProjectId !== undefined) projects.add(currentProjectId);
  for (const entry of proposals) {
    if (entry.status === 'rejected' || entry.proposal.destination !== 'memdir_handoff') continue;
    const metadata = entry.proposal.metadata;
    if (metadata.claimKind !== 'procedure'
      || metadata.claimKey !== claimKey
      || metadata.verifiedEvidence !== true) continue;
    const projectId = metadata.evidenceProjectId ?? metadata.applicability?.projectId;
    if (metadata.episodeOutcome === 'succeeded') {
      successes += 1;
      if (projectId !== undefined) projects.add(projectId);
    } else if (metadata.episodeOutcome === 'failed') {
      hasCounterexample = true;
    }
  }
  return { successes, projects, hasCounterexample };
}

function hasVerifiedDigestEvidence(
  digest: import('../types.js').KodaXMemoryOutcomeDigest,
): boolean {
  return digest.evidence?.some((evidence) =>
    (evidence.grade === 'authoritative' || evidence.grade === 'verified')
    && (evidence.source === 'user' || evidence.source === 'host' || evidence.source === 'environment')) === true;
}

function extractClaimBody(body: string): string {
  return parseMemoryFile(body).body.trim();
}

function isRestrictedMemoryBody(body: string): boolean {
  return /(?:api[_-]?key|authorization:\s*bearer|private key|password|secret|token\s*[:=])/i.test(body)
    || /(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|prior|system|developer)\s+instructions?/i.test(body)
    || /<\/?(?:system|developer|assistant|tool|prompt)(?:\s|>)/i.test(body);
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function selectRefsById(
  refs: readonly MemoryItemRef[],
  refIds: readonly string[],
  maxRefs: number,
  warnings: string[],
): readonly MemoryItemRef[] {
  const byId = new Map(refs.map((ref) => [ref.id, ref]));
  const selected: MemoryItemRef[] = [];
  for (const refId of refIds.slice(0, maxRefs)) {
    const ref = byId.get(refId);
    if (ref === undefined) {
      warnings.push(`memory review candidate not found: ${refId}`);
    } else {
      selected.push(ref);
    }
  }
  return selected;
}

function reviewTask(input: MemoryReviewInput): string {
  return [input.task, input.userFeedback]
    .filter((value): value is string => value !== undefined && value.trim().length > 0)
    .join('\n');
}

function shouldIgnoreMemory(task: string): boolean {
  return /\b(ignore|do not use|don't use|without)\s+(project\s+)?memory\b/i.test(task);
}

function memoryPackRankingText(input: MemoryPackInput): string {
  return [input.task, input.decisionIntent, input.actionSignature]
    .filter((value): value is string => value !== undefined && value.trim().length > 0)
    .join('\n');
}

function scoreRef(ref: MemoryItemRef, task: string): number {
  const taskLower = task.toLowerCase();
  const title = ref.title?.toLowerCase() ?? '';
  let score = 0;
  if (ref.pinned === true) score += 50;
  if (ref.scope === 'project') score += 20;
  if (ref.scope === 'user') score += 10;
  if (ref.lifecycle === 'trusted' || ref.lifecycle === 'readonly') score += 10;
  if (title.length > 0 && taskLower.includes(title)) score += 30;
  for (const token of title.split(/[^a-z0-9]+/).filter((entry) => entry.length >= 3)) {
    if (taskLower.includes(token)) score += 3;
  }
  return score;
}

function structuredMatchScore(ref: MemoryItemRef, input: MemoryPackInput): number {
  if (
    input.actionSignature !== undefined
    && ref.actionSignature !== undefined
    && ref.actionSignature === input.actionSignature
  ) {
    return 2;
  }
  if (
    input.decisionIntent !== undefined
    && ref.claimKey !== undefined
    && ref.claimKey === input.decisionIntent
  ) {
    return 1;
  }
  return 0;
}

function packReason(ref: MemoryItemRef, task: string): string {
  const title = ref.title ?? ref.id;
  return task.toLowerCase().includes(title.toLowerCase())
    ? 'Exact task/title overlap.'
    : `${ref.scope} ${ref.kind} is eligible for deterministic recall.`;
}

function firstSnippet(body: string): string {
  const compact = body.replace(/\s+/g, ' ').trim();
  return compact.slice(0, 240);
}

function promptSafeClaimSnippet(raw: string): string {
  const body = parseMemoryFile(raw).body;
  return body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/^\s{0,3}(?:#{1,6}|[-*+]\s+|>\s*)/gm, '')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 512);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringifyJson(value: KodaXSessionEntry | KodaXSessionArtifactLedgerEntry): string {
  return JSON.stringify(value, null, 2);
}

function fingerprintsMatch(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

function skippedApply(proposalId: string, skippedReason: string): MemoryApplyResult {
  return {
    proposalId,
    applied: false,
    changedRefs: [],
    changedPaths: [],
    skippedReason,
    warnings: [],
  };
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function cancelledEpisodeReview(
  plan: MemoryReviewPlan,
  warning: string,
): MemoryEpisodeReviewResult {
  return {
    plan,
    proposalIds: [],
    appliedProposalIds: [],
    decisions: [],
    warnings: [...plan.warnings, warning],
  };
}

function lifecycleNotFound(
  refId: string,
  operation: MemoryLifecycleOperationResult['operation'],
): MemoryLifecycleOperationResult {
  return {
    refId,
    operation,
    acknowledged: false,
    residualSourceRefs: [],
    warnings: ['managed memory ref not found'],
  };
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
