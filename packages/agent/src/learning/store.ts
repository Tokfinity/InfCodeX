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
    && typeof value.completedTurn === 'boolean';
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

  return {
    proposalId,
    status,
    proposal,
    ...(applyPlan !== undefined ? { applyPlan } : {}),
    createdAt,
    updatedAt,
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
  } = {},
): Promise<StoredLearningProposal> {
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

  await writeStoreDocument(filePath, proposals);
  return next;
}

export function resolveLearningProposalStore(cwd: string): string {
  const remote = tryGitRemote(cwd);
  const key = remote ? sanitizeProjectKey(remote) : `local-${hashCwd(cwd)}`;
  return getAgentConfigPath('projects', key, 'learning', 'proposals.json');
}

export async function updateLearningProposalStatus(
  filePath: string,
  proposalId: string,
  status: LearningProposalReviewStatus,
  options: {
    readonly rejectedReason?: string;
    readonly now?: () => string;
  } = {},
): Promise<StoredLearningProposal> {
  const read = await readLearningProposalStore(filePath);
  if (read.warnings.length > 0) {
    throw new Error(`refusing to write corrupt learning proposal store: ${read.warnings.join('; ')}`);
  }

  const existing = read.proposals.find((entry) => entry.proposalId === proposalId);
  if (!existing) {
    throw new Error(`learning proposal not found: ${proposalId}`);
  }

  const now = options.now ?? (() => new Date().toISOString());
  const next: StoredLearningProposal = {
    ...existing,
    status,
    updatedAt: now(),
    ...(status === 'rejected' && options.rejectedReason !== undefined
      ? { rejectedReason: options.rejectedReason }
      : { rejectedReason: undefined }),
  };

  await writeStoreDocument(
    filePath,
    read.proposals.map((entry) => entry.proposalId === proposalId ? next : entry),
  );

  return next;
}
