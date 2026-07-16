import type { WorkflowEvent } from '@kodax-ai/agent';

export interface WorkflowPacketReadCost {
  readonly contentHash: string;
  readonly reason?: string;
}

export interface WorkflowCostReport {
  readonly totalModelTokens: number;
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly outputTokens: number;
  readonly digestTokens: number;
  readonly agentStarts: number;
  readonly childTurns: number;
  readonly agentStartsByRoleTier: Readonly<Record<string, number>>;
  readonly primaryReviewStarts: number;
  readonly duplicatePrimaryPacketReads: number;
  readonly verificationPacketReads: readonly WorkflowPacketReadCost[];
  readonly synthesisPacketReads: readonly WorkflowPacketReadCost[];
  readonly reviewWaves: number;
  readonly fixWaves: number;
  readonly rereviewWaves: number;
  readonly qualityGateOutcomes: readonly {
    readonly contentHash: string;
    readonly actionableFindings: number;
    readonly unresolvedFindings: number;
    readonly unqualifiedApprovalAllowed: boolean;
  }[];
  readonly tokenCoverage: {
    readonly ok: boolean;
    readonly missingTaskIds: readonly string[];
  };
  readonly excludedExternalTaskIds: readonly string[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function buildWorkflowCostReport(events: readonly WorkflowEvent[]): WorkflowCostReport {
  const spawned = new Map<string, Record<string, unknown>>();
  const completed = new Set<string>();
  const missingUsage: string[] = [];
  const excludedExternalTaskIds: string[] = [];
  const primaryHashes = new Set<string>();
  const verificationPacketReads: WorkflowPacketReadCost[] = [];
  const synthesisPacketReads: WorkflowPacketReadCost[] = [];
  let totalModelTokens = 0;
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let digestTokens = 0;
  let primaryReviewStarts = 0;
  let childTurns = 0;
  let duplicatePrimaryPacketReads = 0;
  const startsByRoleTier: Record<string, number> = {};
  const qualityGateOutcomes: WorkflowCostReport['qualityGateOutcomes'][number][] = [];

  for (const event of events) {
    const data = event.data ?? {};
    if (event.type === 'agent_spawned') {
      const taskId = typeof data.taskId === 'string' ? data.taskId : undefined;
      if (taskId) spawned.set(taskId, data);
      if (data.role === 'primary-review') primaryReviewStarts += 1;
      const role = typeof data.role === 'string' ? data.role : 'agent';
      const tier = typeof data.requestedTier === 'string' ? data.requestedTier : 'inherited';
      const key = `${role}/${tier}`;
      startsByRoleTier[key] = (startsByRoleTier[key] ?? 0) + 1;
      continue;
    }
    if (event.type === 'agent_completed' || event.type === 'agent_unverified' || event.type === 'agent_failed') {
      const taskId = typeof data.taskId === 'string' ? data.taskId : undefined;
      if (!taskId || completed.has(taskId)) continue;
      completed.add(taskId);
      const usage = record(data.usage);
      if (!usage || typeof usage.totalTokens !== 'number') {
        if (typeof spawned.get(taskId)?.externalTarget === 'string') {
          excludedExternalTaskIds.push(taskId);
        } else {
          missingUsage.push(taskId);
        }
      } else {
        totalModelTokens += finiteNumber(usage.totalTokens);
        inputTokens += finiteNumber(usage.inputTokens);
        cacheReadTokens += finiteNumber(usage.cacheReadTokens ?? usage.cachedReadTokens);
        outputTokens += finiteNumber(usage.outputTokens);
      }
      const digestUsage = record(data.digestUsage);
      digestTokens += finiteNumber(digestUsage?.totalTokens);
      inputTokens += finiteNumber(digestUsage?.inputTokens);
      outputTokens += finiteNumber(digestUsage?.outputTokens);
      cacheReadTokens += finiteNumber(digestUsage?.cacheReadTokens ?? digestUsage?.cachedReadTokens);
      childTurns += finiteNumber(data.iterations);
      continue;
    }
    if (event.type === 'agent_summary_updated') {
      const usage = record(data.usage);
      const summaryKind = data.summaryKind;
      if ((summaryKind === 'digest' || summaryKind === 'digest-failed') && usage) {
        const tokens = finiteNumber(usage.totalTokens);
        totalModelTokens += tokens;
        digestTokens += tokens;
        inputTokens += finiteNumber(usage.inputTokens);
        outputTokens += finiteNumber(usage.outputTokens);
        cacheReadTokens += finiteNumber(usage.cacheReadTokens ?? usage.cachedReadTokens);
      }
      continue;
    }
    if (event.type !== 'workflow_log') continue;
    const detail = record(data.data);
    if (detail?.kind === 'review_quality_gate' && typeof detail.contentHash === 'string') {
      qualityGateOutcomes.push({
        contentHash: detail.contentHash,
        actionableFindings: finiteNumber(detail.actionableFindings),
        unresolvedFindings: finiteNumber(detail.unresolvedFindings),
        unqualifiedApprovalAllowed: detail.unqualifiedApprovalAllowed === true,
      });
      continue;
    }
    if (detail?.kind !== 'review_packet_read' || typeof detail.contentHash !== 'string') continue;
    const read = {
      contentHash: detail.contentHash,
      ...(typeof detail.reason === 'string' ? { reason: detail.reason } : {}),
    };
    if (detail.role === 'primary') {
      if (primaryHashes.has(detail.contentHash)) duplicatePrimaryPacketReads += 1;
      primaryHashes.add(detail.contentHash);
    } else if (detail.role === 'verification') {
      verificationPacketReads.push(read);
    } else if (detail.role === 'synthesis') {
      synthesisPacketReads.push(read);
    }
  }

  for (const taskId of spawned.keys()) {
    if (!completed.has(taskId)) missingUsage.push(taskId);
  }
  const missingTaskIds = [...new Set(missingUsage)].sort();
  return {
    totalModelTokens,
    inputTokens,
    cacheReadTokens,
    outputTokens,
    digestTokens,
    agentStarts: spawned.size,
    childTurns,
    agentStartsByRoleTier: startsByRoleTier,
    primaryReviewStarts,
    duplicatePrimaryPacketReads,
    verificationPacketReads,
    synthesisPacketReads,
    reviewWaves: primaryReviewStarts > 0 ? 1 : 0,
    fixWaves: 0,
    rereviewWaves: 0,
    qualityGateOutcomes,
    tokenCoverage: { ok: missingTaskIds.length === 0, missingTaskIds },
    excludedExternalTaskIds: [...new Set(excludedExternalTaskIds)].sort(),
  };
}
