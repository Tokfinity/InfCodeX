import { createHash } from 'node:crypto';

import {
  sanitizePromptSafeMemoryClaim,
  type MemoryPackHint,
} from '../memory-control/index.js';
import type {
  CreateMemoryAgentOptions,
  MemoryAgent,
  MemoryDecisionReceipt,
  MemoryEpisodeOutcome,
  MemoryInterventionInput,
  MemoryObservation,
  MemoryQueryInput,
  MemoryRecallCandidate,
  MemoryRecallInput,
  MemoryReminder,
  MemorySelectionMode,
  MemorySourcePolicy,
  MemorySession,
  MemorySessionInput,
  PersistedOutcomeDigest,
} from './types.js';
import { MEMORY_POLICY_VERSION } from './policy.js';
import { renderMemoryEvidenceEnvelope } from './reminder-envelope.js';

export function createMemoryAgent(options: CreateMemoryAgentOptions): MemoryAgent {
  return new DefaultMemoryAgent(options);
}

class DefaultMemoryAgent implements MemoryAgent {
  constructor(private readonly options: CreateMemoryAgentOptions) {}

  async startSession(input: MemorySessionInput): Promise<MemorySession> {
    const memoryPack = this.options.initialMemoryPack
      ?? await this.options.controlPlane.buildMemoryPack({
        task: input.objective,
        identity: input.identity,
        maxCandidates: 12,
        maxHints: 5,
      });
    return new DefaultMemorySession(
      input,
      memoryPack.memoryRevision,
      memoryPack.candidates,
      this.options,
    );
  }
}

class DefaultMemorySession implements MemorySession {
  private readonly observations = new Map<string, MemoryObservation>();
  private readonly consumedReminderKeys = new Set<string>();
  private readonly interventionEpochs = new Set<string>();
  private lastSequence = 0;
  private closed = false;
  private completion?: Promise<void>;
  private activeIntervention = false;
  private interventionRunnerCalls = 0;
  private readonly queryByEpoch = new Map<
    string,
    { readonly key: string; readonly result: Promise<MemoryReminder | undefined> }
  >();
  private readonly injectedReceiptIds: string[] = [];

  constructor(
    private readonly input: MemorySessionInput,
    private readonly memoryRevision: string,
    private readonly candidates: readonly MemoryPackHint[],
    private readonly options: CreateMemoryAgentOptions,
  ) {}

  observe(observation: MemoryObservation): void {
    this.assertOpen();
    if (isRestrictedMemoryContent(observation.summary)) return;
    const normalized = freezeObservation(observation, this.options.sourcePolicy);
    const existing = this.observations.get(observation.id);
    if (existing !== undefined) {
      if (existing.sequence === normalized.sequence && stableObservation(existing) === stableObservation(normalized)) {
        return;
      }
      throw new Error(`conflicting duplicate memory observation: ${observation.id}`);
    }
    if (!Number.isSafeInteger(observation.sequence) || observation.sequence <= this.lastSequence) {
      throw new Error(`memory observation sequence must be strictly monotonic after ${this.lastSequence}`);
    }
    if (observation.summary.trim().length === 0) {
      throw new Error('memory observation summary must not be empty');
    }
    this.observations.set(observation.id, normalized);
    this.lastSequence = observation.sequence;
  }

  recall(input: MemoryRecallInput): MemoryReminder | undefined {
    this.assertOpen();
    const observations = [...this.observations.values()]
      .filter((observation) => observation.sequence <= input.throughSequence)
      .filter(isAutomaticObservation)
      .filter((observation) => exactObservationMatch(observation, input))
      .sort((left, right) => right.sequence - left.sequence)
      .map(observationCandidate);
    const candidateHints = this.candidates
      .filter(isGovernedHint)
      .filter((candidate) => exactCandidateMatch(candidate, input))
      .map(durableCandidate);
    const candidates = uniqueCandidates([...observations, ...candidateHints]).slice(0, 3);
    if (candidates.length === 0) {
      this.emitDecisionReceipt(input, [], [], [], []);
      return undefined;
    }

    const selectedCandidateIds = candidates.map((candidate) => candidate.refId);
    const evidenceRefs = unique(candidates.flatMap((candidate) => candidate.evidenceRefs ?? []));
    const key = digest(
      `${selectedCandidateIds.join('\0')}\0${input.actionSignature ?? input.decisionIntent}`,
    );
    if (this.consumedReminderKeys.has(key)) {
      this.emitDecisionReceipt(input, candidates, selectedCandidateIds, [], ['exact']);
      return undefined;
    }
    this.consumedReminderKeys.add(key);
    const reminder = buildSafeReminder(
      candidates.map((candidate) => candidate.claim),
      evidenceRefs,
    );
    this.emitDecisionReceipt(
      input,
      candidates,
      selectedCandidateIds,
      reminder?.evidenceRefs ?? [],
      ['exact'],
    );
    return reminder;
  }

  async intervene(input: MemoryInterventionInput): Promise<MemoryReminder | undefined> {
    this.assertOpen();
    if (input.triggers.length === 0 || input.signal?.aborted) return undefined;
    const epoch = interventionEpoch(input);
    if (this.interventionEpochs.has(epoch) || this.activeIntervention) return undefined;
    this.interventionEpochs.add(epoch);
    this.activeIntervention = true;
    const sequenceAtStart = this.lastSequence;
    try {
      const candidates = await this.buildInterventionCandidates(input);
      if (input.signal?.aborted) return undefined;
      if (this.lastSequence !== sequenceAtStart || input.throughSequence !== sequenceAtStart) {
        this.options.onTrace?.({
          type: 'recall.intervention.discarded',
          key: epoch,
          detail: 'state_revision_changed',
        });
        return undefined;
      }
      if (candidates.length === 0) {
        this.emitDecisionReceipt(input, [], [], [], [], input.triggers);
        return undefined;
      }

      const pinnedIds = unique([
        ...(input.triggers.includes('context_compacted')
          ? candidates
            .filter((candidate) => candidate.source === 'current')
            .filter((candidate) => candidate.claimKind === 'objective')
            .slice(0, 1)
            .map((candidate) => candidate.refId)
          : []),
        ...candidates
          .filter((candidate) => candidate.source !== 'current')
          .filter((candidate) => candidateMatchesInput(candidate, input))
          .map((candidate) => candidate.refId),
      ]).slice(0, 3);
      const semanticIds = pinnedIds.length >= 3
        ? []
        : await this.selectInterventionCandidates(input, candidates, epoch);
      if (input.signal?.aborted) return undefined;
      if (this.lastSequence !== sequenceAtStart) {
        this.options.onTrace?.({
          type: 'recall.intervention.discarded',
          key: epoch,
          detail: 'state_revision_changed',
        });
        return undefined;
      }
      const selectedCandidateIds = unique([...pinnedIds, ...semanticIds]).slice(0, 3);
      const selected = selectedCandidateIds
        .map((id) => candidates.find((candidate) => candidate.refId === id))
        .filter((candidate): candidate is ResolvedMemoryCandidate => candidate !== undefined);
      const evidenceRefs = unique(selected.flatMap((candidate) => candidate.evidenceRefs ?? []));
      const modes: MemorySelectionMode[] = [
        ...(pinnedIds.length > 0 ? ['exact' as const] : []),
        ...(semanticIds.length > 0 ? ['semantic_intervention' as const] : []),
      ];
      if (selected.length === 0) {
        this.emitDecisionReceipt(input, candidates, [], [], modes, input.triggers);
        return undefined;
      }

      const reminderKey = digest([
        epoch,
        ...selectedCandidateIds,
      ].join('\0'));
      if (this.consumedReminderKeys.has(reminderKey)) {
        this.emitDecisionReceipt(
          input,
          candidates,
          selectedCandidateIds,
          [],
          modes,
          input.triggers,
        );
        return undefined;
      }
      this.consumedReminderKeys.add(reminderKey);
      const reminder = buildSafeReminder(
        selected.map((candidate) => candidate.claim),
        evidenceRefs,
      );
      this.emitDecisionReceipt(
        input,
        candidates,
        selectedCandidateIds,
        reminder?.evidenceRefs ?? [],
        modes,
        input.triggers,
      );
      return reminder;
    } finally {
      this.activeIntervention = false;
    }
  }

  query(input: MemoryQueryInput): Promise<MemoryReminder | undefined> {
    this.assertOpen();
    const epoch = decisionEpoch(input.decisionRevision, input.throughSequence);
    const need = normalizeQueryNeed(input.need);
    const key = digest([
      epoch,
      this.memoryRevision,
      need ?? '',
      input.actionSignature ?? '',
      MEMORY_POLICY_VERSION,
    ].join('\0'));
    const existing = this.queryByEpoch.get(epoch);
    if (existing !== undefined) return existing.key === key ? existing.result : Promise.resolve(undefined);
    const result = need === undefined
      ? Promise.resolve(undefined)
      : this.queryOnce(input, need);
    this.queryByEpoch.set(epoch, { key, result });
    if (need === undefined) this.emitDecisionReceipt(input, [], [], [], ['deliberate_query']);
    return result;
  }

  rewind(input: { readonly throughSequence: number }): void {
    this.assertOpen();
    if (!Number.isSafeInteger(input.throughSequence) || input.throughSequence < 0) {
      throw new Error('rewind sequence must be a non-negative safe integer');
    }
    for (const [id, observation] of this.observations) {
      if (observation.sequence > input.throughSequence) this.observations.delete(id);
    }
    this.lastSequence = input.throughSequence;
    this.consumedReminderKeys.clear();
    this.interventionEpochs.clear();
    this.queryByEpoch.clear();
    while (this.injectedReceiptIds.length > 0) this.injectedReceiptIds.pop();
  }

  complete(outcome: MemoryEpisodeOutcome): Promise<void> {
    this.assertOpen();
    if (this.completion !== undefined) return this.completion;
    this.completion = this.completeOnce(outcome);
    return this.completion;
  }

  async close(options: { readonly drain?: boolean } = {}): Promise<void> {
    if (options.drain !== false && this.completion !== undefined) await this.completion;
    this.closed = true;
  }

  private async completeOnce(outcome: MemoryEpisodeOutcome): Promise<void> {
    if (outcome.status === 'cancelled') return;
    if (isRestrictedMemoryContent(outcome.summary)) return;
    const digestValue = buildOutcomeDigest(
      this.input,
      [...this.observations.values()],
      {
        ...outcome,
        status: outcome.status,
        evidence: outcome.evidence.map((evidence) =>
          applySourcePolicy(evidence, this.options.sourcePolicy)),
      },
      this.options.now?.() ?? new Date().toISOString(),
      this.injectedReceiptIds,
    );
    await this.options.persistOutcomeDigest?.(digestValue);
    await this.reviewWithTimeout(digestValue);
  }

  private async reviewWithTimeout(digestValue: PersistedOutcomeDigest): Promise<void> {
    const review = this.options.reviewEpisode;
    if (review === undefined) return;
    const controller = new AbortController();
    const timeoutMs = Math.max(1, this.options.reviewTimeoutMs ?? 30_000);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      review(digestValue, controller.signal).then(() => false),
      new Promise<true>((resolve) => {
        timeout = setTimeout(() => {
          controller.abort();
          resolve(true);
        }, timeoutMs);
      }),
    ]);
    if (timeout !== undefined) clearTimeout(timeout);
    if (timedOut) {
      this.options.onTrace?.({
        type: 'review.timed_out',
        key: digestValue.reviewKey,
        detail: `${timeoutMs}ms`,
      });
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('memory session is closed');
  }

  private async buildInterventionCandidates(
    input: MemoryInterventionInput,
  ): Promise<readonly ResolvedMemoryCandidate[]> {
    const current = input.currentCandidates
      .map(currentCandidate)
      .filter((candidate): candidate is ResolvedMemoryCandidate => candidate !== undefined);
    const observations = prioritizeExactCandidates(
      [...this.observations.values()]
      .filter((observation) => observation.sequence <= input.throughSequence)
      .filter(isAutomaticObservation)
      .sort((left, right) => right.sequence - left.sequence)
      .map(observationCandidate),
      input,
    );
    let durable: readonly ResolvedMemoryCandidate[] = [];
    try {
      const freshPack = await this.options.controlPlane.buildMemoryPack({
        task: this.input.objective,
        identity: this.input.identity,
        decisionIntent: input.decisionIntent,
        ...(input.actionSignature !== undefined
          ? { actionSignature: input.actionSignature }
          : {}),
        maxCandidates: 12,
        maxHints: 12,
        includeSnippets: true,
        purpose: 'intervention',
      });
      durable = prioritizeExactCandidates(
        freshPack.promptHints
          .filter(isGovernedHint)
          .map(durableCandidate),
        input,
      );
    } catch (error) {
      this.options.onTrace?.({
        type: 'recall.intervention.failed',
        key: interventionEpoch(input),
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    return admitInterventionCandidates(current, observations, durable);
  }

  private async selectInterventionCandidates(
    input: MemoryInterventionInput,
    candidates: readonly ResolvedMemoryCandidate[],
    epoch: string,
  ): Promise<readonly string[]> {
    const runner = this.options.recallRunner;
    if (runner === undefined || this.interventionRunnerCalls >= 3) return [];
    this.interventionRunnerCalls += 1;
    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort(input.signal?.reason);
    input.signal?.addEventListener('abort', forwardAbort, { once: true });
    if (input.signal?.aborted) forwardAbort();
    const aliased = candidates.map((candidate, index) => ({
      alias: `candidate:${index + 1}`,
      candidate: {
        ...candidate,
        refId: `candidate:${index + 1}`,
        evidenceRefs: [],
      },
    }));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        runner({
          objective: promptSafeSelectorText(input.objective),
          decisionContext: promptSafeSelectorText(input.decisionContext, 2_048),
          decisionIntent: promptSafeSelectorText(input.decisionIntent),
          triggers: input.triggers,
          candidates: aliased.map(({ candidate }) => candidate),
          signal: controller.signal,
        }),
        new Promise<{ readonly selectedRefIds: readonly string[] }>((resolve) => {
          timeout = setTimeout(() => {
            controller.abort();
            resolve({ selectedRefIds: [] });
          }, 5_000);
        }),
      ]);
      const originalByAlias = new Map(
        aliased.map(({ alias }, index) => [alias, candidates[index]!.refId]),
      );
      return unique(result.selectedRefIds
        .map((id) => originalByAlias.get(id))
        .filter((id): id is string => id !== undefined))
        .slice(0, 3);
    } catch (error) {
      this.options.onTrace?.({
        type: 'recall.intervention.failed',
        key: epoch,
        detail: error instanceof Error ? error.message : String(error),
      });
      return [];
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      input.signal?.removeEventListener('abort', forwardAbort);
    }
  }

  private async queryOnce(
    input: MemoryQueryInput,
    need: string,
  ): Promise<MemoryReminder | undefined> {
    try {
      const pack = await this.options.controlPlane.buildMemoryPack({
        task: this.input.objective,
        identity: this.input.identity,
        decisionIntent: need,
        ...(input.actionSignature !== undefined ? { actionSignature: input.actionSignature } : {}),
        maxCandidates: 3,
        maxHints: 3,
        includeSnippets: true,
        purpose: 'deliberate_query',
      });
      const selected = pack.promptHints
        .filter(isGovernedQueryHint)
        .map((hint) => ({
          hint,
          claim: sanitizePromptSafeMemoryClaim(hint.bodySnippet ?? ''),
        }))
        .filter((entry): entry is { readonly hint: MemoryPackHint; readonly claim: string } =>
          entry.claim !== undefined)
        .slice(0, 3);
      const selectedRefs = selected.map(({ hint }) => hint.ref.id);
      const reminder = buildSafeReminder(
        selected.map(({ claim }) => claim),
        selectedRefs,
      );
      const content = reminder?.content ?? '';
      const injectedRefs = reminder?.evidenceRefs ?? [];
      const candidates = pack.candidates.map(durableCandidate);
      this.emitDecisionReceipt(
        input,
        candidates,
        selectedRefs,
        injectedRefs,
        ['deliberate_query'],
      );
      return reminder;
    } catch (error) {
      this.emitDecisionReceipt(input, [], [], [], ['deliberate_query']);
      this.options.onTrace?.({
        type: 'query.failed',
        key: decisionEpoch(input.decisionRevision, input.throughSequence),
        detail: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private emitDecisionReceipt(
    input: Pick<MemoryRecallInput, 'decisionRevision' | 'actionSignature' | 'throughSequence'>,
    candidates: readonly ResolvedMemoryCandidate[],
    selectedCandidateIds: readonly string[],
    injectedEvidenceRefs: readonly string[],
    selectionModes: readonly MemorySelectionMode[],
    triggers?: readonly MemoryInterventionInput['triggers'][number][],
  ): void {
    const epoch = decisionEpoch(input.decisionRevision, input.throughSequence);
    const candidateIds = candidates.map((candidate) => candidate.refId);
    const selectedIdSet = new Set(selectedCandidateIds);
    const legacySelectedRefs = unique(candidates
      .filter((candidate) => selectedIdSet.has(candidate.refId))
      .flatMap((candidate) => candidate.evidenceRefs)
      .filter(isSafeEvidenceRef));
    const candidateSetFingerprint = digest(candidates
      .map((candidate) => [
        candidate.refId,
        candidate.source ?? '',
        candidate.claim,
        ...(candidate.evidenceRefs ?? []),
      ].join('\0'))
      .join('\n'));
    const receipt: MemoryDecisionReceipt = {
      id: `memory-decision:${digest([
        epoch,
        MEMORY_POLICY_VERSION,
        candidateSetFingerprint,
        selectedCandidateIds.join(','),
        injectedEvidenceRefs.join(','),
        selectionModes.join(','),
        triggers?.join(',') ?? '',
      ].join('\0')).slice(0, 24)}`,
      decisionEpoch: epoch,
      decisionRevision: input.decisionRevision,
      policyVersion: MEMORY_POLICY_VERSION,
      candidateSetFingerprint,
      candidateIds: [...candidateIds],
      selectedCandidateIds: [...selectedCandidateIds],
      injectedEvidenceRefs: [...injectedEvidenceRefs],
      ...(triggers !== undefined && triggers.length > 0 ? { triggers: [...triggers] } : {}),
      candidateRefs: [...candidateIds],
      selectedRefs: [...legacySelectedRefs],
      injectedRefs: [...injectedEvidenceRefs],
      selectionModes: [...selectionModes],
      ...(input.actionSignature !== undefined ? { actionSignature: input.actionSignature } : {}),
      throughSequence: input.throughSequence,
    };
    if (injectedEvidenceRefs.length > 0 && !this.injectedReceiptIds.includes(receipt.id)) {
      this.injectedReceiptIds.push(receipt.id);
    }
    this.options.onTrace?.({ type: 'memory.decision', receipt });
  }
}

function exactObservationMatch(observation: MemoryObservation, input: MemoryRecallInput): boolean {
  if (observation.actionSignature !== undefined && input.actionSignature !== undefined) {
    return observation.actionSignature === input.actionSignature;
  }
  return observation.claimKey !== undefined && observation.claimKey === input.decisionIntent;
}

function exactCandidateMatch(candidate: MemoryPackHint, input: MemoryRecallInput): boolean {
  if (candidate.ref.actionSignature !== undefined && input.actionSignature !== undefined) {
    return candidate.ref.actionSignature === input.actionSignature;
  }
  return candidate.ref.claimKey !== undefined && candidate.ref.claimKey === input.decisionIntent;
}

interface ResolvedMemoryCandidate extends MemoryRecallCandidate {
  readonly source: 'current' | 'session' | 'durable';
  readonly evidenceRefs: readonly string[];
  readonly actionSignature?: string;
  readonly claimKey?: string;
}

function currentCandidate(
  candidate: MemoryRecallCandidate,
): ResolvedMemoryCandidate | undefined {
  const claim = sanitizePromptSafeMemoryClaim(candidate.claim);
  if (claim === undefined) return undefined;
  return {
    ...candidate,
    claim,
    source: 'current',
    evidenceRefs: unique(candidate.evidenceRefs ?? [candidate.refId]),
  };
}

function observationCandidate(observation: MemoryObservation): ResolvedMemoryCandidate {
  const claim = sanitizePromptSafeMemoryClaim(observation.summary)
    ?? `Prior observation is available at ${observation.evidence[0]?.ref ?? observation.id}.`;
  return {
    refId: `observation:${observation.id}`,
    claim,
    claimKind: observation.kind,
    source: 'session',
    evidenceRefs: unique(observation.evidence.map((evidence) => evidence.ref)),
    ...(observation.actionSignature !== undefined
      ? { actionSignature: observation.actionSignature }
      : {}),
    ...(observation.claimKey !== undefined ? { claimKey: observation.claimKey } : {}),
  };
}

function durableCandidate(candidate: MemoryPackHint): ResolvedMemoryCandidate {
  const claim = sanitizePromptSafeMemoryClaim(candidate.bodySnippet ?? candidate.hook)
    ?? `Governed memory is available at ${candidate.ref.id}.`;
  return {
    refId: candidate.ref.id,
    claim,
    ...(candidate.ref.claimKind !== undefined ? { claimKind: candidate.ref.claimKind } : {}),
    source: 'durable',
    evidenceRefs: [candidate.ref.id],
    ...(candidate.ref.actionSignature !== undefined
      ? { actionSignature: candidate.ref.actionSignature }
      : {}),
    ...(candidate.ref.claimKey !== undefined ? { claimKey: candidate.ref.claimKey } : {}),
  };
}

function isAutomaticObservation(observation: MemoryObservation): boolean {
  if (observation.visibility !== 'prompt_safe') return false;
  if (sanitizePromptSafeMemoryClaim(observation.summary) === undefined) return false;
  return observation.evidence.some((evidence) => evidence.source !== 'agent');
}

function isGovernedHint(hint: MemoryPackHint): boolean {
  return isGovernedQueryHint(hint)
    && sanitizePromptSafeMemoryClaim(hint.bodySnippet ?? hint.hook) !== undefined;
}

function candidateMatchesInput(
  candidate: ResolvedMemoryCandidate,
  input: MemoryRecallInput,
): boolean {
  if (candidate.actionSignature !== undefined && input.actionSignature !== undefined) {
    return candidate.actionSignature === input.actionSignature;
  }
  return candidate.claimKey !== undefined && candidate.claimKey === input.decisionIntent;
}

function prioritizeExactCandidates(
  candidates: readonly ResolvedMemoryCandidate[],
  input: MemoryRecallInput,
): readonly ResolvedMemoryCandidate[] {
  return [
    ...candidates.filter((candidate) => candidateMatchesInput(candidate, input)),
    ...candidates.filter((candidate) => !candidateMatchesInput(candidate, input)),
  ];
}

function admitInterventionCandidates(
  current: readonly ResolvedMemoryCandidate[],
  session: readonly ResolvedMemoryCandidate[],
  durable: readonly ResolvedMemoryCandidate[],
): readonly ResolvedMemoryCandidate[] {
  const objective = current.filter((candidate) => candidate.claimKind === 'objective').slice(0, 1);
  const currentTodo = current.filter((candidate) => candidate.claimKind === 'todo');
  const admitted = uniqueCandidates([
    ...objective,
    ...currentTodo.slice(0, 3),
    ...session.slice(0, 4),
    ...durable.slice(0, 4),
  ]);
  const remaining = uniqueCandidates([
    ...currentTodo.slice(3),
    ...session.slice(4),
    ...durable.slice(4),
  ]);
  return uniqueCandidates([...admitted, ...remaining]).slice(0, 12);
}

function uniqueCandidates(
  candidates: readonly ResolvedMemoryCandidate[],
): readonly ResolvedMemoryCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.refId)) return false;
    seen.add(candidate.refId);
    return true;
  });
}

function buildOutcomeDigest(
  input: MemorySessionInput,
  observations: readonly MemoryObservation[],
  outcome: MemoryEpisodeOutcome & { readonly status: 'succeeded' | 'failed' },
  createdAt: string,
  injectedReceiptIds: readonly string[],
): PersistedOutcomeDigest {
  const latestOutcome = [...observations].reverse().find((observation) => observation.kind === 'outcome');
  const sequence = observations.at(-1)?.sequence ?? 0;
  const reviewKey = digest([
    input.identity.sessionId,
    String(sequence),
    outcome.status,
    outcome.summary,
  ].join('\0'));
  return {
    id: `memory-outcome:${reviewKey.slice(0, 24)}`,
    reviewKey,
    sessionId: input.identity.sessionId,
    branchId: input.identity.sessionId,
    sequence,
    objective: input.objective,
    ...(latestOutcome?.actionSignature !== undefined
      ? { actionSignature: latestOutcome.actionSignature }
      : {}),
    approach: latestOutcome?.summary ?? 'episode completion',
    outcome: outcome.status,
    summary: outcome.summary.trim(),
    evidenceRefs: unique(outcome.evidence.map((evidence) => evidence.ref)),
    evidence: outcome.evidence.map((evidence) => ({
      ref: evidence.ref,
      grade: evidence.requestedGrade,
      source: evidence.source,
      observedAt: evidence.observedAt,
    })),
    ...(injectedReceiptIds.length > 0 ? {
      memoryInfluence: unique(injectedReceiptIds).map((decisionReceiptRef) => ({
        decisionReceiptRef,
        grade: 'exposed' as const,
      })),
    } : {}),
    visibility: latestOutcome?.visibility ?? 'prompt_safe',
    createdAt,
  };
}

function normalizeQueryNeed(value: string): string | undefined {
  const need = value.replace(/\s+/g, ' ').trim();
  if (need.length === 0 || estimateMemoryTokens(need) > 512 || isRestrictedMemoryContent(need)) {
    return undefined;
  }
  if (/^(?:list|show|dump|enumerate)\s+(?:all|every)\s+(?:the\s+)?memor(?:y|ies)\b/i.test(need)) {
    return undefined;
  }
  if (/\b(?:all|every)\s+(?:project|workspace|tenant|user|agent)(?:s|'s)?\b/i.test(need)) {
    return undefined;
  }
  return need;
}

function estimateMemoryTokens(value: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const char of value) {
    if (char.codePointAt(0)! <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / 4) + nonAscii;
}

function isGovernedQueryHint(hint: MemoryPackHint): boolean {
  return hint.ref.visibility === 'prompt_safe'
    && hint.ref.authority !== 'proposal_only'
    && (hint.ref.lifecycle === 'active'
      || hint.ref.lifecycle === 'trusted'
      || hint.ref.lifecycle === 'readonly');
}

function buildSafeReminder(
  claims: readonly string[],
  evidenceRefs: readonly string[],
): MemoryReminder | undefined {
  const normalizedClaims = claims
    .map((claim) => sanitizePromptSafeMemoryClaim(claim, 512))
    .filter((claim): claim is string => claim !== undefined);
  const content = normalizedClaims.join('\n').slice(0, 2_048);
  if (
    normalizedClaims.length !== claims.length
    || sanitizePromptSafeMemoryClaim(content, 2_048) === undefined
    || estimateMemoryTokens(content) > 512
  ) {
    return undefined;
  }
  const reminder = {
    content,
    evidenceRefs: unique(evidenceRefs.filter(isSafeEvidenceRef)).slice(0, 3),
  };
  return renderMemoryEvidenceEnvelope(reminder.content, reminder.evidenceRefs) === undefined
    ? undefined
    : reminder;
}

function promptSafeSelectorText(value: string, maxChars = 512): string {
  return sanitizePromptSafeMemoryClaim(value, maxChars) ?? '[withheld by prompt-safety policy]';
}

function isSafeEvidenceRef(value: string): boolean {
  return value.length > 0
    && value.length <= 256
    && !/[\r\n\u0000-\u001f\u007f]/.test(value)
    && sanitizePromptSafeMemoryClaim(value, 256) === value;
}

function decisionEpoch(decisionRevision: string, throughSequence: number): string {
  return digest(`${decisionRevision}\0${throughSequence}`).slice(0, 24);
}

function interventionEpoch(input: MemoryInterventionInput): string {
  return digest([
    decisionEpoch(input.decisionRevision, input.throughSequence),
    ...input.triggers,
  ].join('\0')).slice(0, 24);
}

function freezeObservation(
  observation: MemoryObservation,
  sourcePolicy: MemorySourcePolicy | undefined,
): MemoryObservation {
  return Object.freeze({
    ...observation,
    evidence: Object.freeze(observation.evidence.map((evidence) =>
      Object.freeze(applySourcePolicy(evidence, sourcePolicy)))),
    ...(observation.metadata !== undefined ? { metadata: Object.freeze({ ...observation.metadata }) } : {}),
  });
}

function applySourcePolicy(
  evidence: MemoryObservation['evidence'][number],
  sourcePolicy: MemorySourcePolicy | undefined,
): MemoryObservation['evidence'][number] {
  const granted = sourcePolicy?.(evidence) ?? 'inferred';
  return {
    ...evidence,
    requestedGrade: lowerEvidenceGrade(evidence.requestedGrade, granted),
  };
}

function lowerEvidenceGrade(
  requested: MemoryObservation['evidence'][number]['requestedGrade'],
  granted: MemoryObservation['evidence'][number]['requestedGrade'],
): MemoryObservation['evidence'][number]['requestedGrade'] {
  const order = ['inferred', 'observed', 'corroborated', 'verified', 'authoritative'] as const;
  return order[Math.min(order.indexOf(requested), order.indexOf(granted))] ?? 'inferred';
}

function stableObservation(observation: MemoryObservation): string {
  return JSON.stringify(observation);
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isRestrictedMemoryContent(value: string): boolean {
  return /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|authorization:\s*bearer\s+\S+|(?:api[_-]?key|password|secret|token)\s*[:=]\s*\S+)/i.test(value);
}
