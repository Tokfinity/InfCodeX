import {
  validateDeclarativeSkillSpec,
  type DeclarativeSkillSpec,
} from '../learning/learned-skill.js';
import type { ExactInvokedSkillSnapshot } from '../learning/learned-skill-usage.js';
import type { KodaXMemoryOutcomeDigest } from '../types.js';
import type {
  MemoryReviewDraftAction,
  MemoryReviewModelInput,
  MemoryReviewPlan,
  MemoryReviewTrigger,
} from './types.js';
import { sanitizePromptSafeMemoryClaim } from './prompt-safety.js';
import { EpisodeReviewFailure } from './review-inbox.js';

const HASH_RE = /^[a-f0-9]{64}$/;
const AUTHORITY_RISK_CODES = new Set([
  'credential_access',
  'role_override',
  'cross_project',
  'global_mutation',
  'bypass_permissions',
  'destructive_default',
  'network_default',
]);

export interface LearningReviewVerifierFact {
  readonly ref: string;
  readonly verdict: 'passed' | 'failed' | 'inconclusive';
}

export type { ExactInvokedSkillSnapshot } from '../learning/learned-skill-usage.js';

export interface LearningReviewQualification {
  readonly reusableMethodEvidence: boolean;
  readonly explicitSkillPreservation: boolean;
  readonly independentEpisodeCount: number;
  readonly verifiedOutcome: boolean;
  readonly exactSkillInvoked: boolean;
}

export interface LearningReviewEvidencePacket {
  readonly outcomeDigest: KodaXMemoryOutcomeDigest;
  readonly exactInvokedSkill: ExactInvokedSkillSnapshot | null;
  readonly verifierFacts: readonly LearningReviewVerifierFact[];
  readonly priorDigests: readonly KodaXMemoryOutcomeDigest[];
  readonly qualification: LearningReviewQualification;
}

export interface UnifiedLearningReviewModelInput {
  readonly cacheDomain: 'learning-review';
  readonly memory: MemoryReviewModelInput;
  readonly evidence: LearningReviewEvidencePacket;
}

export type LearnedSkillDecisionDisposition =
  | 'discard'
  | 'ready'
  | 'project_canary';

export interface NormalizedLearnedSkillDecision {
  readonly disposition: LearnedSkillDecisionDisposition;
  readonly reasonCodes: readonly string[];
  readonly operation?: 'create' | 'patch';
  readonly spec?: DeclarativeSkillSpec;
  readonly targetCapabilityId?: string;
  readonly expectedFingerprint?: string;
  readonly expectedRevision?: number;
  readonly quarantineExactInvokedRevision?: true;
}

export interface UnifiedLearningReviewResult {
  readonly memoryPlan: MemoryReviewPlan;
  readonly capabilityDecision?: NormalizedLearnedSkillDecision;
}

export type UnifiedLearningReviewRunner = (
  input: UnifiedLearningReviewModelInput,
  signal?: AbortSignal,
) => Promise<unknown>;

export function sanitizeUnifiedLearningReviewInput(
  input: UnifiedLearningReviewModelInput,
): UnifiedLearningReviewModelInput {
  const exactInvokedSkill = input.evidence.exactInvokedSkill === null
    || sanitizePromptSafeMemoryClaim(
      input.evidence.exactInvokedSkill.content,
      input.evidence.exactInvokedSkill.content.length,
    ) === undefined
    ? null
    : input.evidence.exactInvokedSkill;
  return {
    cacheDomain: 'learning-review',
    memory: {
      ...input.memory,
      userFeedback: safeReviewText(input.memory.userFeedback, 'unsafe feedback'),
      ...(input.memory.task === undefined
        ? {}
        : { task: safeReviewText(input.memory.task, 'unsafe task') }),
      sourceRefs: safeReviewRefs(input.memory.sourceRefs),
      candidateRefs: input.memory.candidateRefs
        .filter((candidate) => candidate.ref.visibility === 'prompt_safe')
        .map((candidate) => {
          const {
            storageUri: _storageUri,
            scopeId: _scopeId,
            applicability: _applicability,
            claimKey,
            title,
            sourceRefs,
            relatedRefs,
            ...safeRef
          } = candidate.ref;
          const safeSnippet = candidate.bodySnippet === undefined
            ? undefined
            : sanitizePromptSafeMemoryClaim(candidate.bodySnippet, 512);
          const safeTitle = title === undefined
            ? undefined
            : sanitizePromptSafeMemoryClaim(title, 160);
          const safeClaimKey = claimKey === undefined
            ? undefined
            : sanitizePromptSafeMemoryClaim(claimKey, 160);
          return {
            ref: {
              ...safeRef,
              id: safeReviewText(candidate.ref.id, 'unsafe ref'),
              sourceRefs: safeReviewRefs(sourceRefs),
              relatedRefs: safeReviewRefs(relatedRefs),
              ...(safeTitle === undefined ? {} : { title: safeTitle }),
              ...(safeClaimKey === undefined ? {} : { claimKey: safeClaimKey }),
            },
            ...(safeSnippet === undefined ? {} : { bodySnippet: safeSnippet }),
            ...(candidate.bodyFingerprint === undefined
              ? {}
              : { bodyFingerprint: candidate.bodyFingerprint }),
            warnings: [],
          };
        }),
      warnings: ['provider evidence omits local paths, source warnings, and unsafe text'],
    },
    evidence: {
      outcomeDigest: sanitizeOutcomeDigest(input.evidence.outcomeDigest),
      exactInvokedSkill,
      verifierFacts: input.evidence.verifierFacts.map((fact) => ({
        ...fact,
        ref: safeReviewText(fact.ref, 'unsafe verifier ref'),
      })),
      priorDigests: input.evidence.priorDigests.map(sanitizeOutcomeDigest),
      qualification: {
        ...input.evidence.qualification,
        exactSkillInvoked: exactInvokedSkill !== null
          && input.evidence.qualification.exactSkillInvoked,
      },
    },
  };
}

function sanitizeOutcomeDigest(
  digest: KodaXMemoryOutcomeDigest,
): KodaXMemoryOutcomeDigest {
  const { lesson, preconditions, memoryIntent, ...required } = digest;
  const safeLesson = lesson === undefined
    ? undefined
    : sanitizePromptSafeMemoryClaim(lesson, 512);
  const safePreconditions = preconditions === undefined
    ? undefined
    : sanitizePromptSafeMemoryClaim(preconditions, 512);
  const safeCandidateStatement = memoryIntent === undefined
    ? undefined
    : sanitizePromptSafeMemoryClaim(memoryIntent.candidateStatement, 512);
  const safeUserQuote = memoryIntent === undefined
    ? undefined
    : sanitizePromptSafeMemoryClaim(memoryIntent.userQuote, 512);
  const hasAuthoritativeEvidence = memoryIntent !== undefined
    && digest.evidence?.some((evidence) => (
      evidence.ref === memoryIntent.evidenceRef
      && evidence.grade === 'authoritative'
      && evidence.source === 'user'
    )) === true;
  return {
    ...required,
    objective: safeReviewText(digest.objective, 'unsafe objective'),
    approach: safeReviewText(digest.approach, 'unsafe approach'),
    summary: safeReviewText(digest.summary, 'unsafe summary'),
    evidenceRefs: safeReviewRefs(digest.evidenceRefs),
    ...(digest.evidence === undefined
      ? {}
      : {
          evidence: digest.evidence.map((item) => ({
            ...item,
            ref: safeReviewText(item.ref, 'unsafe evidence ref'),
          })),
        }),
    ...(safeLesson === undefined ? {} : { lesson: safeLesson }),
    ...(safePreconditions === undefined ? {} : { preconditions: safePreconditions }),
    ...(!hasAuthoritativeEvidence
      || safeCandidateStatement === undefined
      || safeUserQuote === undefined
      ? {}
      : {
          memoryIntent: {
            operation: memoryIntent.operation,
            evidenceRef: safeReviewText(memoryIntent.evidenceRef, 'unsafe intent ref'),
            candidateStatement: safeCandidateStatement,
            userQuote: safeUserQuote,
          },
        }),
  };
}

function safeReviewRefs(refs: readonly string[]): readonly string[] {
  return refs
    .map((ref) => sanitizePromptSafeMemoryClaim(ref, 256))
    .filter((ref): ref is string => ref !== undefined);
}

function safeReviewText(value: string, omission: string): string {
  return sanitizePromptSafeMemoryClaim(value, 1_024) ?? `[omitted: ${omission}]`;
}

export function isUnifiedLearningReviewModelInput(
  value: unknown,
): value is UnifiedLearningReviewModelInput {
  if (!isRecord(value)
    || value.cacheDomain !== 'learning-review'
    || !isRecord(value.memory)
    || !isRecord(value.evidence)) return false;
  const memory = value.memory;
  const evidence = value.evidence;
  const digest = evidence.outcomeDigest;
  const qualification = evidence.qualification;
  return isMemoryReviewTrigger(memory.trigger)
    && typeof memory.userFeedback === 'string'
    && isStringArray(memory.sourceRefs)
    && Array.isArray(memory.candidateRefs)
    && isStringArray(memory.warnings)
    && isRecord(digest)
    && typeof digest.reviewKey === 'string'
    && typeof digest.sessionId === 'string'
    && typeof digest.branchId === 'string'
    && (digest.outcome === 'succeeded'
      || digest.outcome === 'failed'
      || (digest.outcome === 'cancelled' && isIntentOnlyCancelledDigest(digest)))
    && isStringArray(digest.evidenceRefs)
    && Array.isArray(evidence.verifierFacts)
    && Array.isArray(evidence.priorDigests)
    && evidence.priorDigests.length <= 2
    && isRecord(qualification)
    && typeof qualification.reusableMethodEvidence === 'boolean'
    && typeof qualification.explicitSkillPreservation === 'boolean'
    && Number.isSafeInteger(qualification.independentEpisodeCount)
    && typeof qualification.verifiedOutcome === 'boolean'
    && typeof qualification.exactSkillInvoked === 'boolean';
}

function isIntentOnlyCancelledDigest(digest: Record<string, unknown>): boolean {
  const intent = digest.memoryIntent;
  const evidence = digest.evidence;
  const evidenceRefs = digest.evidenceRefs;
  if (!isRecord(intent)
    || (intent.operation !== 'remember' && intent.operation !== 'correct')
    || typeof intent.evidenceRef !== 'string'
    || typeof intent.candidateStatement !== 'string'
    || typeof intent.userQuote !== 'string'
    || !Array.isArray(evidence)
    || evidence.length !== 1
    || !Array.isArray(evidenceRefs)
    || evidenceRefs.length !== 1) return false;
  const boundEvidence = evidence[0];
  return isRecord(boundEvidence)
    && boundEvidence.ref === intent.evidenceRef
    && boundEvidence.grade === 'authoritative'
    && boundEvidence.source === 'user'
    && evidenceRefs[0] === intent.evidenceRef
    && digest.objective === intent.candidateStatement
    && digest.approach === 'episode completion'
    && digest.actionSignature === undefined
    && digest.preconditions === undefined
    && digest.lesson === undefined
    && digest.memoryInfluence === undefined;
}

export function normalizeUnifiedLearningReview(
  input: UnifiedLearningReviewModelInput,
  raw: unknown,
): UnifiedLearningReviewResult {
  const record = isRecord(raw) ? raw : {};
  if (!isMemoryReviewPlan(record.memoryPlan)) {
    throw new EpisodeReviewFailure(
      'malformed_response',
      'unified reviewer returned an invalid Memory plan',
    );
  }
  const memoryPlan = bindMemoryPlanToInput(
    record.memoryPlan,
    input.memory,
    input.evidence.outcomeDigest,
  );
  const capabilityDecision = normalizeCapabilityDecision(
    record.capabilityDecision,
    input.evidence,
  );
  return {
    memoryPlan,
    ...(capabilityDecision === undefined ? {} : { capabilityDecision }),
  };
}

function normalizeCapabilityDecision(
  value: unknown,
  evidence: LearningReviewEvidencePacket,
): NormalizedLearnedSkillDecision | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)
    || !['discard', 'ready', 'project_canary'].includes(String(value.disposition))
    || !Array.isArray(value.reasonCodes)
    || !value.reasonCodes.every((code) => typeof code === 'string')) {
    return { disposition: 'ready', reasonCodes: ['invalid_capability_decision'] };
  }
  const reasonCodes = [...new Set(value.reasonCodes as string[])];
  const quarantine = exactQuarantineFields(evidence, reasonCodes);
  if (value.disposition === 'discard') {
    return { disposition: 'discard', reasonCodes, ...quarantine };
  }
  const spec = parseDeclarativeSkillSpec(value.spec);
  if (spec === undefined) {
    return {
      disposition: 'ready',
      reasonCodes: unique([...reasonCodes, 'invalid_skill_spec']),
      ...quarantine,
    };
  }
  try {
    validateDeclarativeSkillSpec(spec);
  } catch {
    return {
      disposition: 'ready',
      reasonCodes: unique([...reasonCodes, 'unsafe_skill_spec']),
      ...quarantine,
    };
  }
  const operation = value.operation === 'create' || value.operation === 'patch'
    ? value.operation
    : undefined;
  if (value.disposition === 'ready') {
    return {
      disposition: 'ready',
      reasonCodes,
      ...(operation === undefined ? {} : { operation }),
      spec,
      ...quarantine,
    };
  }
  const gateReasons: string[] = [];
  const patch = operation === 'patch';
  if (value.requestedScope !== 'project') gateReasons.push('project_scope_required');
  if (value.semanticDisposition !== 'allow'
    || reasonCodes.some((code) => AUTHORITY_RISK_CODES.has(code))) {
    gateReasons.push('semantic_authority_risk');
  }
  const qualification = evidence.qualification;
  const qualifiedCreateEvidence = qualification.reusableMethodEvidence
    && qualification.verifiedOutcome
    && evidence.outcomeDigest.outcome === 'succeeded'
    && evidence.verifierFacts.some((fact) => fact.verdict === 'passed')
    && (qualification.explicitSkillPreservation
      || qualification.independentEpisodeCount >= 2);
  const qualifiedPatchEvidence = patch
    && qualification.exactSkillInvoked
    && qualification.verifiedOutcome
    && evidence.verifierFacts.some((fact) => fact.verdict === 'failed')
    && reasonCodes.includes('rule_level_contradiction')
    && !reasonCodes.includes('environment_failure');
  if (patch ? !qualifiedPatchEvidence : !qualifiedCreateEvidence) {
    gateReasons.push('insufficient_independent_verified_evidence');
  }
  if (operation === undefined) gateReasons.push('invalid_skill_operation');
  const targetCapabilityId = typeof value.targetCapabilityId === 'string'
    ? value.targetCapabilityId
    : undefined;
  const expectedFingerprint = typeof value.expectedFingerprint === 'string'
    ? value.expectedFingerprint
    : undefined;
  const expectedRevision = Number.isSafeInteger(value.expectedRevision)
    ? value.expectedRevision as number
    : undefined;
  if (patch && !matchesExactInvokedRevision(
    evidence,
    targetCapabilityId,
    expectedFingerprint,
    expectedRevision,
  )) {
    gateReasons.push('exact_invoked_revision_required');
  }
  if (gateReasons.length > 0) {
    return {
      disposition: 'ready',
      reasonCodes: unique([...reasonCodes, ...gateReasons]),
      ...(operation === undefined ? {} : { operation }),
      spec,
      ...(targetCapabilityId === undefined ? {} : { targetCapabilityId }),
      ...(expectedFingerprint === undefined ? {} : { expectedFingerprint }),
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
      ...quarantine,
    };
  }
  return {
    disposition: 'project_canary',
    reasonCodes,
    operation,
    spec,
    ...(targetCapabilityId === undefined ? {} : { targetCapabilityId }),
    ...(expectedFingerprint === undefined ? {} : { expectedFingerprint }),
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    ...quarantine,
  };
}

function exactQuarantineFields(
  evidence: LearningReviewEvidencePacket,
  reasonCodes: readonly string[],
): Pick<
  NormalizedLearnedSkillDecision,
  | 'quarantineExactInvokedRevision'
  | 'targetCapabilityId'
  | 'expectedFingerprint'
  | 'expectedRevision'
> {
  const invoked = evidence.exactInvokedSkill;
  const qualified = invoked !== null
    && evidence.qualification.exactSkillInvoked
    && evidence.qualification.verifiedOutcome
    && evidence.verifierFacts.some((fact) => fact.verdict === 'failed')
    && reasonCodes.includes('rule_level_contradiction')
    && !reasonCodes.includes('environment_failure')
    && HASH_RE.test(invoked.fingerprint);
  return !qualified || invoked === null
    ? {}
    : {
        quarantineExactInvokedRevision: true,
        targetCapabilityId: invoked.capabilityId,
        expectedFingerprint: invoked.fingerprint,
        expectedRevision: invoked.revision,
      };
}

function matchesExactInvokedRevision(
  evidence: LearningReviewEvidencePacket,
  capabilityId: string | undefined,
  fingerprint: string | undefined,
  revision: number | undefined,
): boolean {
  const invoked = evidence.exactInvokedSkill;
  return evidence.qualification.exactSkillInvoked
    && invoked !== null
    && invoked.capabilityId === capabilityId
    && invoked.fingerprint === fingerprint
    && invoked.revision === revision
    && HASH_RE.test(invoked.fingerprint);
}

function parseDeclarativeSkillSpec(value: unknown): DeclarativeSkillSpec | undefined {
  if (!isRecord(value)
    || typeof value.name !== 'string'
    || typeof value.description !== 'string'
    || typeof value.purpose !== 'string'
    || !isStringArray(value.triggers)
    || !isStringArray(value.steps)
    || !isStringArray(value.verification)
    || !isStringArray(value.pitfalls)) return undefined;
  return {
    name: value.name,
    description: value.description,
    purpose: value.purpose,
    triggers: value.triggers,
    steps: value.steps,
    verification: value.verification,
    pitfalls: value.pitfalls,
  };
}

function isMemoryReviewPlan(value: unknown): value is MemoryReviewPlan {
  return isRecord(value)
    && isMemoryReviewTrigger(value.trigger)
    && typeof value.createdAt === 'string'
    && isStringArray(value.sourceRefs)
    && Array.isArray(value.candidateRefs)
    && Array.isArray(value.actions)
    && value.actions.every(isMemoryReviewAction)
    && isStringArray(value.warnings);
}

function isMemoryReviewAction(value: unknown): value is MemoryReviewDraftAction {
  if (!isRecord(value)) return false;
  const mutatesMemory = value.action === 'write_memdir' || value.action === 'patch_memdir';
  return [
    'no_op',
    'link_refs',
    'write_memdir',
    'patch_memdir',
    'handoff_to_skill_loop',
    'quarantine',
    'archive',
    'conflict_report',
  ].includes(String(value.action))
    && isStringArray(value.targetRefIds)
    && typeof value.summary === 'string'
    && typeof value.rationale === 'string'
    && ['low', 'medium', 'high'].includes(String(value.confidence))
    && ['low', 'medium', 'high'].includes(String(value.risk))
    && value.requiresApproval === true
    && optionalString(value.proposedBody)
    && (!mutatesMemory
      || (typeof value.proposedBody === 'string' && value.proposedBody.trim().length > 0))
    && optionalEnum(value.claimKind, ['fact', 'policy', 'preference', 'procedure', 'episode'])
    && optionalString(value.claimKey)
    && optionalString(value.actionSignature)
    && optionalString(value.preconditions)
    && (value.counterexamples === undefined || isStringArray(value.counterexamples))
    && optionalEnum(value.relationship, ['same_claim', 'condition_refinement', 'conflict']);
}

function isMemoryReviewTrigger(value: unknown): value is MemoryReviewTrigger {
  return [
    'explicit_remember',
    'explicit_forget',
    'user_correction',
    'proposal_rejected',
    'conflict_detected',
    'episode_completed',
  ].includes(String(value));
}

function bindMemoryPlanToInput(
  plan: MemoryReviewPlan,
  input: MemoryReviewModelInput,
  digest: KodaXMemoryOutcomeDigest,
): MemoryReviewPlan {
  return {
    ...plan,
    trigger: input.trigger,
    sourceRefs: input.sourceRefs,
    candidateRefs: input.candidateRefs,
    episodeDigest: digest,
  };
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function optionalEnum(value: unknown, allowed: readonly string[]): boolean {
  return value === undefined || (typeof value === 'string' && allowed.includes(value));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
