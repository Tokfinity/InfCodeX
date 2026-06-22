import type {
  DiscardedLearningReport,
  ProceduralLearningInput,
  ProceduralLearningResult,
  SkillLearningProposal,
} from './types.js';

const DEFAULT_CONFIDENCE = 0.5;
const ACTIVE_SUGGESTION_CONFIDENCE_FLOOR = 0.3;

function discard(proposalId: string, reason: string): DiscardedLearningReport {
  return {
    destination: 'discard',
    proposalId,
    reason,
  };
}

function skillProposal(
  input: ProceduralLearningInput,
): SkillLearningProposal {
  const candidate = input.candidate;
  if (candidate.kind !== 'skill_patch' && candidate.kind !== 'skill_create') {
    throw new Error('skillProposal requires a skill learning candidate');
  }
  return {
    destination: candidate.kind,
    proposalId: input.proposalId,
    origin: input.origin,
    userLabel: 'method_guide',
    skillName: candidate.skillName,
    whyDurable: candidate.whyDurable,
    trigger: candidate.trigger,
    changeSummary: candidate.changeSummary,
    sourceTraceIds: input.sourceRefs,
    confidence: candidate.confidence ?? DEFAULT_CONFIDENCE,
  };
}

export function triageProceduralLearning(
  input: ProceduralLearningInput,
): ProceduralLearningResult {
  if (!input.completedTurn) {
    return discard(input.proposalId, 'procedural learning requires a completed turn');
  }

  const candidate = input.candidate;
  if ('confidence' in candidate && typeof candidate.confidence === 'number') {
    if (candidate.confidence < ACTIVE_SUGGESTION_CONFIDENCE_FLOOR) {
      return {
        destination: 'trace_only',
        proposalId: input.proposalId,
        userLabel: 'trace_only',
        reason: 'candidate confidence is too low for an active suggestion',
        sourceTraceIds: input.sourceRefs,
      };
    }
  }

  switch (candidate.kind) {
    case 'skill_patch':
    case 'skill_create':
      return skillProposal(input);
    case 'workflow_handoff':
      if (candidate.workflowStatus !== 'completed') {
        return discard(input.proposalId, 'workflow handoffs require a completed workflow run');
      }
      return {
        destination: 'workflow_handoff',
        proposalId: input.proposalId,
        origin: input.origin,
        userLabel: 'runnable_workflow',
        evidenceRunIds: [candidate.workflowRunId],
        sourceTraceIds: input.sourceRefs,
        suggestedAction: candidate.suggestedAction,
        whyWorkflowNotSkill: candidate.whyWorkflowNotSkill,
        requiredWorkflowEvidence: candidate.requiredWorkflowEvidence,
        risk: candidate.risk,
        consumerImpact: candidate.consumerImpact,
        appliedByF224: false,
      };
    case 'memdir_handoff':
      if (!candidate.metadata.completedTurn) {
        return discard(input.proposalId, 'memory handoffs require completed-turn metadata');
      }
      return {
        destination: 'memdir_handoff',
        proposalId: input.proposalId,
        origin: input.origin,
        userLabel: 'context_note',
        memoryKind: candidate.memoryKind,
        body: candidate.body,
        metadata: candidate.metadata,
      };
    case 'reasoning_handoff':
      return {
        destination: 'reasoning_handoff',
        proposalId: input.proposalId,
        origin: input.origin,
        userLabel: 'reasoning_report',
        title: candidate.title,
        body: candidate.body,
        sourceTraceIds: candidate.sourceRefs,
      };
    case 'trace_only':
      return {
        destination: 'trace_only',
        proposalId: input.proposalId,
        userLabel: 'trace_only',
        reason: candidate.reason,
        sourceTraceIds: input.sourceRefs,
      };
  }
}
