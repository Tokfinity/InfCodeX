import type { KodaXMemoryOutcomeDigest } from '../types.js';
import type {
  MemoryContextIdentity,
  MemoryController,
  MemoryPack,
  MemoryVisibility,
} from '../memory-control/index.js';

export type MemoryEvidenceGrade =
  | 'authoritative'
  | 'verified'
  | 'corroborated'
  | 'observed'
  | 'inferred';

export interface MemoryEvidenceRef {
  readonly ref: string;
  readonly requestedGrade: MemoryEvidenceGrade;
  readonly source: 'user' | 'host' | 'tool' | 'environment' | 'agent';
  readonly observedAt: string;
}

export type MemorySourcePolicy = (evidence: MemoryEvidenceRef) => MemoryEvidenceGrade;

export type MemoryObservationKind = 'constraint' | 'fact' | 'outcome' | 'correction';

export interface MemoryObservation {
  readonly id: string;
  readonly sequence: number;
  readonly kind: MemoryObservationKind;
  readonly summary: string;
  readonly evidence: readonly MemoryEvidenceRef[];
  readonly visibility: MemoryVisibility;
  readonly claimKey?: string;
  readonly actionSignature?: string;
  readonly occurredAt: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface MemoryRecallInput {
  readonly decisionRevision: string;
  readonly objective: string;
  readonly decisionContext: string;
  readonly decisionIntent: string;
  readonly actionSignature?: string;
  readonly throughSequence: number;
}

export interface MemoryQueryInput {
  readonly decisionRevision: string;
  readonly need: string;
  readonly actionSignature?: string;
  readonly throughSequence: number;
}

export interface MemoryReminder {
  readonly content: string;
  readonly evidenceRefs: readonly string[];
}

export interface MemoryRecallCandidate {
  readonly refId: string;
  readonly claim: string;
  readonly claimKind?: string;
  readonly source?: 'current' | 'session' | 'durable';
  readonly evidenceRefs?: readonly string[];
}

export interface MemoryRecallRunnerInput {
  readonly objective: string;
  readonly decisionContext: string;
  readonly decisionIntent: string;
  readonly triggers?: readonly MemoryInterventionTrigger[];
  readonly candidates: readonly MemoryRecallCandidate[];
  readonly signal: AbortSignal;
}

export type MemoryRecallRunner = (
  input: MemoryRecallRunnerInput,
) => Promise<{ readonly selectedRefIds: readonly string[] }>;

export type MemorySelectionMode =
  | 'task_hint'
  | 'exact'
  /** @deprecated Retained for source compatibility; F275 no longer emits this mode. */
  | 'semantic_prefetch'
  | 'semantic_intervention'
  | 'deliberate_query';

export type MemoryInterventionTrigger =
  | 'tool_failure'
  | 'verification_failure'
  | 'context_compacted';

export interface MemoryInterventionInput extends MemoryRecallInput {
  readonly triggers: readonly MemoryInterventionTrigger[];
  readonly currentCandidates: readonly MemoryRecallCandidate[];
}

export interface MemoryDecisionReceipt {
  readonly id: string;
  readonly decisionEpoch: string;
  readonly decisionRevision: string;
  readonly policyVersion: string;
  readonly candidateSetFingerprint: string;
  /** Candidate identities offered to deterministic or semantic selection. */
  readonly candidateIds: readonly string[];
  /** Candidate identities selected after validating the runner output. */
  readonly selectedCandidateIds: readonly string[];
  /** Source evidence exposed to the Action LLM after deterministic rendering. */
  readonly injectedEvidenceRefs: readonly string[];
  readonly triggers?: readonly MemoryInterventionTrigger[];
  /** @deprecated Use candidateIds. */
  readonly candidateRefs: readonly string[];
  /** @deprecated Use selectedCandidateIds. */
  readonly selectedRefs: readonly string[];
  /** @deprecated Use injectedEvidenceRefs. */
  readonly injectedRefs: readonly string[];
  readonly selectionModes: readonly MemorySelectionMode[];
  readonly actionSignature?: string;
  readonly throughSequence: number;
}

export type MemoryAgentTraceEvent =
  | {
      readonly type:
        | 'recall.intervention.failed'
        | 'recall.intervention.discarded'
        /** @deprecated Retained for source compatibility; F275 no longer emits prefetch events. */
        | 'recall.prefetch.completed'
        /** @deprecated Retained for source compatibility; F275 no longer emits prefetch events. */
        | 'recall.prefetch.failed'
        /** @deprecated Retained for source compatibility; F275 no longer emits prefetch events. */
        | 'recall.prefetch.discarded'
        | 'query.failed'
        | 'review.timed_out';
      readonly key: string;
      readonly detail?: string;
    }
  | {
      readonly type: 'memory.decision';
      readonly receipt: MemoryDecisionReceipt;
    };

export interface MemorySessionInput {
  readonly identity: MemoryContextIdentity;
  readonly objective: string;
}

export interface MemoryEpisodeOutcome {
  readonly status: 'succeeded' | 'failed' | 'cancelled';
  readonly summary: string;
  readonly evidence: readonly MemoryEvidenceRef[];
}

export type PersistedOutcomeDigest = KodaXMemoryOutcomeDigest;

export interface MemorySession {
  observe(observation: MemoryObservation): void;
  recall(input: MemoryRecallInput): MemoryReminder | undefined;
  intervene(input: MemoryInterventionInput): Promise<MemoryReminder | undefined>;
  query(input: MemoryQueryInput): Promise<MemoryReminder | undefined>;
  rewind(input: { readonly throughSequence: number }): void;
  complete(outcome: MemoryEpisodeOutcome): Promise<void>;
  close(options?: { readonly drain?: boolean }): Promise<void>;
}

export interface MemoryAgent {
  startSession(input: MemorySessionInput): Promise<MemorySession>;
}

export interface CreateMemoryAgentOptions {
  readonly controlPlane: MemoryController;
  readonly initialMemoryPack?: MemoryPack;
  readonly now?: () => string;
  readonly persistOutcomeDigest?: (digest: PersistedOutcomeDigest) => Promise<void>;
  readonly reviewEpisode?: (digest: PersistedOutcomeDigest, signal: AbortSignal) => Promise<void>;
  readonly reviewTimeoutMs?: number;
  readonly recallRunner?: MemoryRecallRunner;
  readonly onTrace?: (event: MemoryAgentTraceEvent) => void;
  readonly sourcePolicy?: MemorySourcePolicy;
}

export interface MemorySessionState {
  readonly input: MemorySessionInput;
  readonly memoryPack: MemoryPack;
}
