import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { basename, dirname, join } from 'path';

import {
  getAgentConfigPath,
} from '../runtime/agent-home.js';
import {
  hashCwd,
  sanitizeProjectKey,
  tryGitRemote,
} from '../memory/paths.js';
import type {
  LearningProposalReviewStatus,
  LearningProposalStoreReadResult,
  ReviewableLearningProposal,
  SkillGovernanceAction,
  SkillWriteOrigin,
  StoredLearningApplyPlan,
  StoredLearningProposal,
} from './types.js';
import { withLearningFileLock } from './store-lock.js';

const STORE_VERSION = 1;

interface StoreDocument {
  readonly version: 1;
  readonly proposals: readonly StoredLearningProposal[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isReviewStatus(value: unknown): value is LearningProposalReviewStatus {
  return value === 'pending' || value === 'approved' || value === 'rejected';
}

function isSkillWriteOrigin(value: unknown): value is SkillWriteOrigin {
  return value === 'foreground_user'
    || value === 'assistant_tool'
    || value === 'background_learning';
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function isSkillGovernanceAction(value: unknown): value is SkillGovernanceAction {
  return value === 'record_usage'
    || value === 'create'
    || value === 'patch'
    || value === 'archive'
    || value === 'quarantine'
    || value === 'delete'
    || value === 'consolidate'
    || value === 'direct_mutation';
}

function isWorkflowSuggestedAction(value: unknown): boolean {
  return value === 'save_from_run'
    || value === 'revise_capsule'
    || value === 'add_skill_reference'
    || value === 'report_only';
}

function isLearningRisk(value: unknown): boolean {
  return value === 'low' || value === 'medium' || value === 'high';
}

function isMemoryKind(value: unknown): boolean {
  return value === 'user'
    || value === 'feedback'
    || value === 'project'
    || value === 'reference'
    || value === 'semantic_memory';
}

function isMemoryWriteOrigin(value: unknown): boolean {
  return value === 'foreground_user'
    || value === 'assistant_tool'
    || value === 'background_learning'
    || value === 'external_provider';
}

function isMemoryExecutionContext(value: unknown): boolean {
  return value === 'primary'
    || value === 'subagent'
    || value === 'workflow_child'
    || value === 'cron'
    || value === 'flush'
    || value === 'compression';
}

function isConsumerImpact(value: unknown): boolean {
  return isRecord(value)
    && isStringArray(value.workflowCapsules)
    && isStringArray(value.savedWorkflows)
    && isStringArray(value.constructedAgents)
    && isStringArray(value.promptReferences)
    && (
      value.action === 'none'
      || value.action === 'rewrite_proposal'
      || value.action === 'block_until_manual_review'
    );
}

function isMemoryMetadata(value: unknown): boolean {
  return isRecord(value)
    && isMemoryWriteOrigin(value.writeOrigin)
    && isMemoryExecutionContext(value.executionContext)
    && typeof value.sessionId === 'string'
    && (value.parentSessionId === undefined || typeof value.parentSessionId === 'string')
    && (value.platform === undefined || typeof value.platform === 'string')
    && (value.sourceTool === undefined || typeof value.sourceTool === 'string')
    && isStringArray(value.sourceRefs)
    && typeof value.completedTurn === 'boolean'
    && (value.claimKind === undefined || isMemoryClaimKind(value.claimKind))
    && (value.claimKey === undefined || typeof value.claimKey === 'string')
    && (value.actionSignature === undefined || typeof value.actionSignature === 'string')
    && (value.persistenceKind === undefined
      || value.persistenceKind === 'create'
      || value.persistenceKind === 'evidence_update'
      || value.persistenceKind === 'condition_refinement')
    && (value.targetRefId === undefined || typeof value.targetRefId === 'string')
    && (value.targetStorageUri === undefined || typeof value.targetStorageUri === 'string')
    && (value.preconditions === undefined || typeof value.preconditions === 'string')
    && (value.applicability === undefined || isMemoryApplicability(value.applicability))
    && (value.requestedLifecycle === undefined
      || value.requestedLifecycle === 'active'
      || value.requestedLifecycle === 'provisional')
    && (value.episodeOutcome === undefined
      || value.episodeOutcome === 'succeeded'
      || value.episodeOutcome === 'failed'
      || value.episodeOutcome === 'cancelled')
    && (value.verifiedEvidence === undefined || typeof value.verifiedEvidence === 'boolean')
    && (value.evidenceProjectId === undefined || typeof value.evidenceProjectId === 'string');
}

function isMemoryClaimKind(value: unknown): boolean {
  return value === 'fact'
    || value === 'policy'
    || value === 'preference'
    || value === 'procedure'
    || value === 'episode';
}

function isMemoryApplicability(value: unknown): boolean {
  if (!isRecord(value) || typeof value.tenantId !== 'string') return false;
  return ['workspaceId', 'userId', 'agentId', 'projectId', 'sessionId']
    .every((field) => value[field] === undefined || typeof value[field] === 'string');
}

function isReviewableProposal(value: unknown): value is ReviewableLearningProposal {
  if (!isRecord(value)) return false;
  const destination = value.destination;
  if (typeof value.proposalId !== 'string' || !isSkillWriteOrigin(value.origin)) return false;

  if (destination === 'skill_patch' || destination === 'skill_create') {
    return value.userLabel === 'method_guide'
      && typeof value.skillName === 'string'
      && typeof value.whyDurable === 'string'
      && typeof value.trigger === 'string'
      && typeof value.changeSummary === 'string'
      && isStringArray(value.sourceTraceIds)
      && typeof value.confidence === 'number';
  }

  if (destination === 'workflow_handoff') {
    return value.userLabel === 'runnable_workflow'
      && isStringArray(value.evidenceRunIds)
      && isStringArray(value.sourceTraceIds)
      && isWorkflowSuggestedAction(value.suggestedAction)
      && typeof value.whyWorkflowNotSkill === 'string'
      && isStringArray(value.requiredWorkflowEvidence)
      && isLearningRisk(value.risk)
      && isConsumerImpact(value.consumerImpact)
      && value.appliedByF224 === false;
  }

  if (destination === 'memdir_handoff') {
    return value.userLabel === 'context_note'
      && isMemoryKind(value.memoryKind)
      && typeof value.body === 'string'
      && isMemoryMetadata(value.metadata);
  }

  if (destination === 'reasoning_handoff') {
    return value.userLabel === 'reasoning_report'
      && typeof value.title === 'string'
      && typeof value.body === 'string'
      && isStringArray(value.sourceTraceIds);
  }

  return false;
}

function isSkillMutationChange(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === 'write') {
    return typeof value.relativePath === 'string' && typeof value.content === 'string';
  }
  if (value.kind === 'delete') {
    return typeof value.relativePath === 'string';
  }
  return false;
}

function isStoredLearningApplyPlan(value: unknown): value is StoredLearningApplyPlan {
  if (!isRecord(value)) return false;
  if (value.kind !== 'skill') return false;
  if (typeof value.skillRoot !== 'string' || value.skillRoot.length === 0) return false;
  if (!Array.isArray(value.changes) || !value.changes.every(isSkillMutationChange)) return false;
  const governance = value.governance;
  if (!isRecord(governance)) return false;
  if (!isSkillGovernanceAction(governance.action)) return false;
  if (governance.source !== 'project' && governance.source !== 'user' && governance.source !== 'plugin'
    && governance.source !== 'builtin' && governance.source !== 'external') return false;
  if (governance.ownership !== 'system' && governance.ownership !== 'human'
    && governance.ownership !== 'background_created') return false;
  if (!isSkillWriteOrigin(governance.origin)) return false;
  if (governance.pinned !== undefined && typeof governance.pinned !== 'boolean') return false;
  if (value.snapshotRoot !== undefined && typeof value.snapshotRoot !== 'string') return false;
  return true;
}

function parseStoredProposal(value: unknown, index: number, warnings: string[]): StoredLearningProposal | undefined {
  if (!isRecord(value)) {
    warnings.push(`proposal entry ${index} is not an object`);
    return undefined;
  }

  const proposalId = value.proposalId;
  const status = value.status;
  const proposal = value.proposal;
  const applyPlan = value.applyPlan;
  const createdAt = value.createdAt;
  const updatedAt = value.updatedAt;
  const appliedAt = value.appliedAt;
  const appliedChangedPaths = value.appliedChangedPaths;
  const appliedSnapshotPath = value.appliedSnapshotPath;
  const approvedBy = value.approvedBy;
  const approvedAt = value.approvedAt;
  const approvalPolicyId = value.approvalPolicyId;
  const approvalPolicyReason = value.approvalPolicyReason;
  const approvalExpectedFingerprints = value.approvalExpectedFingerprints;
  const approvalResultingFingerprints = value.approvalResultingFingerprints;
  const rejectedReason = value.rejectedReason;

  if (typeof proposalId !== 'string' || proposalId.length === 0) {
    warnings.push(`proposal entry ${index} has no proposalId`);
    return undefined;
  }
  if (!isReviewStatus(status)) {
    warnings.push(`proposal entry ${proposalId} has invalid status`);
    return undefined;
  }
  if (!isReviewableProposal(proposal)) {
    warnings.push(`proposal entry ${proposalId} has invalid proposal payload`);
    return undefined;
  }
  if (proposal.proposalId !== proposalId) {
    warnings.push(`proposal entry ${proposalId} has mismatched proposal payload id`);
    return undefined;
  }
  if (typeof createdAt !== 'string' || typeof updatedAt !== 'string') {
    warnings.push(`proposal entry ${proposalId} has invalid timestamps`);
    return undefined;
  }
  if (applyPlan !== undefined && !isStoredLearningApplyPlan(applyPlan)) {
    warnings.push(`proposal entry ${proposalId} has invalid apply plan`);
    return undefined;
  }
  if (appliedAt !== undefined && typeof appliedAt !== 'string') {
    warnings.push(`proposal entry ${proposalId} has invalid appliedAt`);
    return undefined;
  }
  if (appliedChangedPaths !== undefined && !isStringArray(appliedChangedPaths)) {
    warnings.push(`proposal entry ${proposalId} has invalid applied changed paths`);
    return undefined;
  }
  if (approvedBy !== undefined && approvedBy !== 'user' && approvedBy !== 'host') {
    warnings.push(`proposal entry ${proposalId} has invalid approvedBy`);
    return undefined;
  }
  if (approvedAt !== undefined && typeof approvedAt !== 'string') {
    warnings.push(`proposal entry ${proposalId} has invalid approvedAt`);
    return undefined;
  }
  if (approvalPolicyId !== undefined && typeof approvalPolicyId !== 'string') {
    warnings.push(`proposal entry ${proposalId} has invalid approvalPolicyId`);
    return undefined;
  }
  if (approvalPolicyReason !== undefined && typeof approvalPolicyReason !== 'string') {
    warnings.push(`proposal entry ${proposalId} has invalid approvalPolicyReason`);
    return undefined;
  }
  if (approvalExpectedFingerprints !== undefined && !isStringRecord(approvalExpectedFingerprints)) {
    warnings.push(`proposal entry ${proposalId} has invalid approvalExpectedFingerprints`);
    return undefined;
  }
  if (approvalResultingFingerprints !== undefined && !isStringRecord(approvalResultingFingerprints)) {
    warnings.push(`proposal entry ${proposalId} has invalid approvalResultingFingerprints`);
    return undefined;
  }
  if (appliedSnapshotPath !== undefined && typeof appliedSnapshotPath !== 'string') {
    warnings.push(`proposal entry ${proposalId} has invalid applied snapshot path`);
    return undefined;
  }

  return {
    proposalId,
    status,
    proposal,
    ...(applyPlan !== undefined ? { applyPlan } : {}),
    createdAt,
    updatedAt,
    ...(typeof appliedAt === 'string' ? { appliedAt } : {}),
    ...(isStringArray(appliedChangedPaths) ? { appliedChangedPaths } : {}),
    ...(approvedBy === 'user' || approvedBy === 'host' ? { approvedBy } : {}),
    ...(typeof approvedAt === 'string' ? { approvedAt } : {}),
    ...(typeof approvalPolicyId === 'string' ? { approvalPolicyId } : {}),
    ...(typeof approvalPolicyReason === 'string' ? { approvalPolicyReason } : {}),
    ...(isStringRecord(approvalExpectedFingerprints) ? { approvalExpectedFingerprints } : {}),
    ...(isStringRecord(approvalResultingFingerprints) ? { approvalResultingFingerprints } : {}),
    ...(typeof appliedSnapshotPath === 'string' ? { appliedSnapshotPath } : {}),
    ...(typeof rejectedReason === 'string' ? { rejectedReason } : {}),
  };
}

function parseStoreDocument(raw: string): LearningProposalStoreReadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      proposals: [],
      warnings: [`learning proposal store is not valid JSON: ${message}`],
    };
  }

  if (!isRecord(parsed)) {
    return {
      proposals: [],
      warnings: ['learning proposal store root is not an object'],
    };
  }

  if (parsed.version !== STORE_VERSION) {
    return {
      proposals: [],
      warnings: ['learning proposal store version is unsupported'],
    };
  }

  if (!Array.isArray(parsed.proposals)) {
    return {
      proposals: [],
      warnings: ['learning proposal store has no proposals array'],
    };
  }

  const warnings: string[] = [];
  const proposalEntries: readonly unknown[] = parsed.proposals;
  const proposals = proposalEntries
    .map((entry, index) => parseStoredProposal(entry, index, warnings))
    .filter((entry): entry is StoredLearningProposal => entry !== undefined);

  return { proposals, warnings };
}

async function writeStoreDocument(filePath: string, proposals: readonly StoredLearningProposal[]): Promise<void> {
  const document: StoreDocument = {
    version: STORE_VERSION,
    proposals,
  };
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tempPath = join(
    dir,
    `.${basename(filePath)}.kodax-${process.pid}-${Date.now().toString(36)}.tmp`,
  );
  try {
    await writeFile(tempPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

export async function readLearningProposalStore(
  filePath: string,
): Promise<LearningProposalStoreReadResult> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { proposals: [], warnings: [] };
    }
    throw error;
  }
  return parseStoreDocument(raw);
}

export async function upsertLearningProposal(
  filePath: string,
  proposal: ReviewableLearningProposal,
  options: {
    readonly now?: () => string;
    readonly applyPlan?: StoredLearningApplyPlan;
    readonly revalidateAuthority?: () => Promise<void>;
  } = {},
): Promise<StoredLearningProposal> {
  return withStoreWriteLock(filePath, async () => {
    await options.revalidateAuthority?.();
    const read = await readLearningProposalStore(filePath);
    if (read.warnings.length > 0) {
      throw new Error(`refusing to write corrupt learning proposal store: ${read.warnings.join('; ')}`);
    }

    const now = options.now ?? (() => new Date().toISOString());
    const timestamp = now();
    const existing = read.proposals.find((entry) => entry.proposalId === proposal.proposalId);
    const next: StoredLearningProposal = existing
      ? {
          ...existing,
          proposal,
          ...(options.applyPlan !== undefined ? { applyPlan: options.applyPlan } : {}),
          updatedAt: timestamp,
        }
      : {
          proposalId: proposal.proposalId,
          status: 'pending',
          proposal,
          ...(options.applyPlan !== undefined ? { applyPlan: options.applyPlan } : {}),
          createdAt: timestamp,
          updatedAt: timestamp,
        };

    const proposals = existing
      ? read.proposals.map((entry) => entry.proposalId === proposal.proposalId ? next : entry)
      : [...read.proposals, next];

    await options.revalidateAuthority?.();
    await writeStoreDocument(filePath, proposals);
    return next;
  });
}

export function resolveLearningProposalStore(cwd: string, configHome?: string): string {
  const remote = tryGitRemote(cwd);
  const key = remote ? sanitizeProjectKey(remote) : `local-${hashCwd(cwd)}`;
  return configHome === undefined
    ? getAgentConfigPath('projects', key, 'learning', 'proposals.json')
    : join(configHome, 'projects', key, 'learning', 'proposals.json');
}

export async function updateLearningProposalStatus(
  filePath: string,
  proposalId: string,
  status: LearningProposalReviewStatus,
  options: {
    readonly rejectedReason?: string;
    readonly appliedAt?: string;
    readonly appliedChangedPaths?: readonly string[];
    readonly appliedSnapshotPath?: string;
    readonly approvedBy?: 'user' | 'host';
    readonly approvedAt?: string;
    readonly approvalPolicyId?: string;
    readonly approvalPolicyReason?: string;
    readonly approvalExpectedFingerprints?: Readonly<Record<string, string>>;
    readonly approvalResultingFingerprints?: Readonly<Record<string, string>>;
    readonly now?: () => string;
    readonly revalidateAuthority?: () => Promise<void>;
  } = {},
): Promise<StoredLearningProposal> {
  return withStoreWriteLock(filePath, async () => {
    await options.revalidateAuthority?.();
    const read = await readLearningProposalStore(filePath);
    if (read.warnings.length > 0) {
      throw new Error(`refusing to write corrupt learning proposal store: ${read.warnings.join('; ')}`);
    }

    const existing = read.proposals.find((entry) => entry.proposalId === proposalId);
    if (!existing) throw new Error(`learning proposal not found: ${proposalId}`);

    const now = options.now ?? (() => new Date().toISOString());
    const next: StoredLearningProposal = {
      ...existing,
      status,
      updatedAt: now(),
      ...(status === 'approved' && options.appliedAt !== undefined
        ? { appliedAt: options.appliedAt }
        : {}),
      ...(status === 'approved' && options.appliedChangedPaths !== undefined
        ? { appliedChangedPaths: options.appliedChangedPaths }
        : {}),
      ...(status === 'approved' && options.appliedSnapshotPath !== undefined
        ? { appliedSnapshotPath: options.appliedSnapshotPath }
        : {}),
      ...(status === 'approved' && options.approvedBy !== undefined ? { approvedBy: options.approvedBy } : {}),
      ...(status === 'approved' && options.approvedAt !== undefined ? { approvedAt: options.approvedAt } : {}),
      ...(status === 'approved' && options.approvalPolicyId !== undefined
        ? { approvalPolicyId: options.approvalPolicyId }
        : {}),
      ...(status === 'approved' && options.approvalPolicyReason !== undefined
        ? { approvalPolicyReason: options.approvalPolicyReason }
        : {}),
      ...(status === 'approved' && options.approvalExpectedFingerprints !== undefined
        ? { approvalExpectedFingerprints: options.approvalExpectedFingerprints }
        : {}),
      ...(status === 'approved' && options.approvalResultingFingerprints !== undefined
        ? { approvalResultingFingerprints: options.approvalResultingFingerprints }
        : {}),
      ...(status === 'rejected' && options.rejectedReason !== undefined
        ? { rejectedReason: options.rejectedReason }
        : { rejectedReason: undefined }),
    };

    await options.revalidateAuthority?.();
    await writeStoreDocument(
      filePath,
      read.proposals.map((entry) => entry.proposalId === proposalId ? next : entry),
    );
    return next;
  });
}

async function withStoreWriteLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(dirname(filePath), { recursive: true });
  return withLearningFileLock(`${filePath}.lock`, operation);
}

function isFileError(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
