import {
  triageProceduralLearning,
} from './triage.js';
import {
  upsertLearningProposal,
} from './store.js';
import type {
  LearningIntakeRecordResult,
  ProceduralLearningInput,
  StoredLearningApplyPlan,
} from './types.js';

export interface RecordProceduralLearningInput {
  readonly storePath: string;
  readonly learning: ProceduralLearningInput;
  readonly applyPlan?: StoredLearningApplyPlan;
  readonly now?: () => string;
}

function ensureApplyPlanMatchesResult(input: RecordProceduralLearningInput): void {
  if (!input.applyPlan) return;
  const destination = input.learning.candidate.kind;
  if (destination !== 'skill_patch' && destination !== 'skill_create') {
    throw new Error('learning apply plans can only be attached to skill proposals');
  }
}

export async function recordProceduralLearning(
  input: RecordProceduralLearningInput,
): Promise<LearningIntakeRecordResult> {
  ensureApplyPlanMatchesResult(input);
  const result = triageProceduralLearning(input.learning);
  if (result.destination === 'discard' || result.destination === 'trace_only') {
    return {
      stored: false,
      result,
    };
  }

  const proposal = await upsertLearningProposal(input.storePath, result, {
    ...(input.now !== undefined ? { now: input.now } : {}),
    ...(input.applyPlan !== undefined ? { applyPlan: input.applyPlan } : {}),
  });
  return {
    stored: true,
    result,
    proposal,
  };
}
