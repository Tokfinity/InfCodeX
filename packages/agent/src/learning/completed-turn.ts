import type {
  DiscardedLearningReport,
  LearningCandidate,
  LearningIntakeRecordResult,
  SkillWriteOrigin,
  StoredLearningApplyPlan,
} from './types.js';
import { recordProceduralLearning } from './intake.js';

export interface CompletedTurnLearningCandidate {
  readonly proposalId?: string;
  readonly sourceRefs?: readonly string[];
  readonly candidate: LearningCandidate;
  readonly applyPlan?: StoredLearningApplyPlan;
}

export interface CompletedTurnLearningInput {
  readonly storePath: string;
  readonly sessionId: string;
  readonly completedTurn: boolean;
  readonly userMessage: string;
  readonly assistantMessage: string;
  readonly sourceRefs?: readonly string[];
  readonly origin?: SkillWriteOrigin;
  readonly candidates: readonly CompletedTurnLearningCandidate[];
  readonly now?: () => string;
}

export interface CompletedTurnLearningRecordResult {
  readonly stored: readonly Extract<LearningIntakeRecordResult, { readonly stored: true }>[];
  readonly skipped: readonly Extract<LearningIntakeRecordResult, { readonly stored: false }>[];
}

function safeIdPart(value: string): string {
  const cleaned = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'turn';
}

function discardTurn(proposalId: string, reason: string): Extract<LearningIntakeRecordResult, { readonly stored: false }> {
  const result: DiscardedLearningReport = {
    destination: 'discard',
    proposalId,
    reason,
  };
  return { stored: false, result };
}

function hasUsableTurnEvidence(input: CompletedTurnLearningInput): boolean {
  return input.completedTurn
    && input.userMessage.trim().length > 0
    && input.assistantMessage.trim().length > 0;
}

export async function recordCompletedTurnLearning(
  input: CompletedTurnLearningInput,
): Promise<CompletedTurnLearningRecordResult> {
  const stored: Extract<LearningIntakeRecordResult, { readonly stored: true }>[] = [];
  const skipped: Extract<LearningIntakeRecordResult, { readonly stored: false }>[] = [];
  const prefix = safeIdPart(input.sessionId);

  if (!hasUsableTurnEvidence(input)) {
    for (let index = 0; index < input.candidates.length; index += 1) {
      const proposalId = input.candidates[index]?.proposalId ?? `${prefix}-${index}`;
      skipped.push(discardTurn(proposalId, 'learning requires a completed turn with user and assistant evidence'));
    }
    return { stored, skipped };
  }

  for (let index = 0; index < input.candidates.length; index += 1) {
    const candidate = input.candidates[index]!;
    const result = await recordProceduralLearning({
      storePath: input.storePath,
      learning: {
        proposalId: candidate.proposalId ?? `${prefix}-${index}`,
        origin: input.origin ?? 'background_learning',
        completedTurn: true,
        sourceRefs: candidate.sourceRefs ?? input.sourceRefs ?? [`session:${input.sessionId}`],
        candidate: candidate.candidate,
      },
      ...(candidate.applyPlan !== undefined ? { applyPlan: candidate.applyPlan } : {}),
      ...(input.now !== undefined ? { now: input.now } : {}),
    });
    if (result.stored) {
      stored.push(result);
    } else {
      skipped.push(result);
    }
  }

  return { stored, skipped };
}
