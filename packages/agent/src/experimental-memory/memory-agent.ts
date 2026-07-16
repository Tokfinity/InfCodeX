import { createHash } from 'node:crypto';

import type { MemoryPackHint } from '../memory-control/index.js';
import type {
  CreateMemoryAgentOptions,
  MemoryAgent,
  MemoryDecisionReceipt,
  MemoryEpisodeOutcome,
  MemoryObservation,
  MemoryQueryInput,
  MemoryRecallInput,
  MemoryReminder,
  MemorySelectionMode,
  MemorySourcePolicy,
  MemorySession,
  MemorySessionInput,
  PersistedOutcomeDigest,
} from './types.js';
import { MEMORY_POLICY_VERSION } from './policy.js';

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
  private lastSequence = 0;
  private closed = false;
  private completion?: Promise<void>;
  private prefetchGeneration = 0;
  private prefetch?: { readonly key: string; readonly controller: AbortController };
  private readyPrefetch?: { readonly key: string; readonly refIds: readonly string[] };
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
      .filter((observation) => exactObservationMatch(observation, input))
      .sort((left, right) => right.sequence - left.sequence)
      .slice(0, 3);
    const candidateHints = this.candidates
      .filter((candidate) => exactCandidateMatch(candidate, input))
      .slice(0, Math.max(0, 3 - observations.length));
    const prefetchKey = this.prefetchKey(input);
    const semanticHints = this.consumeReadyPrefetch(prefetchKey)
      .filter((candidate) => !candidateHints.some((hint) => hint.ref.id === candidate.ref.id))
      .slice(0, Math.max(0, 3 - observations.length - candidateHints.length));
    const selectedRefs = unique([
      ...observations.flatMap((observation) => observation.evidence.map((evidence) => evidence.ref)),
      ...candidateHints.map((candidate) => candidate.ref.id),
      ...semanticHints.map((candidate) => candidate.ref.id),
    ]);
    const selectionModes = uniqueModes([
      ...(observations.length > 0 || candidateHints.length > 0 ? ['exact' as const] : []),
      ...(semanticHints.length > 0 ? ['semantic_prefetch' as const] : []),
    ]);
    if (observations.length === 0 && candidateHints.length === 0 && semanticHints.length === 0) {
      this.startPrefetch(prefetchKey, input);
      this.emitDecisionReceipt(input, [], [], selectionModes);
      return undefined;
    }

    const content = [
      ...observations.map((observation) => observation.summary.trim()),
      ...candidateHints.map((candidate) => candidate.bodySnippet ?? candidate.hook),
      ...semanticHints.map((candidate) => candidate.bodySnippet ?? candidate.hook),
    ].join('\n');
    const key = digest(`${selectedRefs.join('\0')}\0${input.actionSignature ?? input.decisionIntent}`);
    if (this.consumedReminderKeys.has(key)) {
      this.emitDecisionReceipt(input, selectedRefs, [], selectionModes);
      return undefined;
    }
    this.consumedReminderKeys.add(key);
    this.emitDecisionReceipt(input, selectedRefs, selectedRefs, selectionModes);
    return { content, evidenceRefs: selectedRefs };
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
    if (need === undefined) this.emitDecisionReceipt(input, [], [], ['deliberate_query']);
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
    this.queryByEpoch.clear();
    while (this.injectedReceiptIds.length > 0) this.injectedReceiptIds.pop();
    this.cancelPrefetch('rewind');
  }

  complete(outcome: MemoryEpisodeOutcome): Promise<void> {
    this.assertOpen();
    if (this.completion !== undefined) return this.completion;
    this.completion = this.completeOnce(outcome);
    return this.completion;
  }

  async close(options: { readonly drain?: boolean } = {}): Promise<void> {
    this.cancelPrefetch('close');
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

  private prefetchKey(input: MemoryRecallInput): string {
    return digest([
      input.decisionRevision,
      input.decisionIntent,
      input.actionSignature ?? '',
      String(input.throughSequence),
      this.memoryRevision,
      this.candidates.map((candidate) => candidate.ref.id).join(','),
    ].join('\0'));
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
        .filter((hint) => hint.bodySnippet !== undefined && hint.bodySnippet.trim().length > 0)
        .slice(0, 3);
      const selectedRefs = selected.map((hint) => hint.ref.id);
      const content = boundedQueryContent(selected.map((hint) => hint.bodySnippet ?? ''));
      const injectedRefs = content.length === 0 ? [] : selectedRefs;
      this.emitDecisionReceipt(
        input,
        selectedRefs,
        injectedRefs,
        ['deliberate_query'],
        pack.candidates.map((candidate) => candidate.ref.id),
      );
      return content.length === 0 ? undefined : { content, evidenceRefs: selectedRefs };
    } catch (error) {
      this.emitDecisionReceipt(input, [], [], ['deliberate_query']);
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
    selectedRefs: readonly string[],
    injectedRefs: readonly string[],
    selectionModes: readonly MemorySelectionMode[],
    candidateRefs = this.candidates.map((candidate) => candidate.ref.id),
  ): void {
    const epoch = decisionEpoch(input.decisionRevision, input.throughSequence);
    const candidateSetFingerprint = digest(candidateRefs.join('\0'));
    const receipt: MemoryDecisionReceipt = {
      id: `memory-decision:${digest([
        epoch,
        MEMORY_POLICY_VERSION,
        candidateSetFingerprint,
        selectedRefs.join(','),
        injectedRefs.join(','),
        selectionModes.join(','),
      ].join('\0')).slice(0, 24)}`,
      decisionEpoch: epoch,
      decisionRevision: input.decisionRevision,
      policyVersion: MEMORY_POLICY_VERSION,
      candidateSetFingerprint,
      candidateRefs: [...candidateRefs],
      selectedRefs: [...selectedRefs],
      injectedRefs: [...injectedRefs],
      selectionModes: [...selectionModes],
      ...(input.actionSignature !== undefined ? { actionSignature: input.actionSignature } : {}),
      throughSequence: input.throughSequence,
    };
    if (injectedRefs.length > 0 && !this.injectedReceiptIds.includes(receipt.id)) {
      this.injectedReceiptIds.push(receipt.id);
    }
    this.options.onTrace?.({ type: 'memory.decision', receipt });
  }

  private consumeReadyPrefetch(key: string): readonly MemoryPackHint[] {
    if (this.readyPrefetch?.key !== key) return [];
    const selected = new Set(this.readyPrefetch.refIds);
    this.readyPrefetch = undefined;
    return this.candidates.filter((candidate) => selected.has(candidate.ref.id));
  }

  private startPrefetch(key: string, input: MemoryRecallInput): void {
    const runner = this.options.recallRunner;
    if (runner === undefined || this.candidates.length === 0 || this.prefetch?.key === key) return;
    this.cancelPrefetch('superseded');
    const controller = new AbortController();
    const generation = ++this.prefetchGeneration;
    this.prefetch = { key, controller };
    const allowedRefs = new Set(this.candidates.map((candidate) => candidate.ref.id));
    void runner({
      objective: input.objective,
      decisionContext: input.decisionContext,
      decisionIntent: input.decisionIntent,
      candidates: this.candidates.map((candidate) => ({
        refId: candidate.ref.id,
        claim: candidate.bodySnippet ?? candidate.hook,
        ...(candidate.ref.claimKind !== undefined ? { claimKind: candidate.ref.claimKind } : {}),
      })),
      signal: controller.signal,
    }).then((result) => {
      if (controller.signal.aborted || generation !== this.prefetchGeneration || this.prefetch?.key !== key) {
        this.options.onTrace?.({ type: 'recall.prefetch.discarded', key });
        return;
      }
      this.readyPrefetch = {
        key,
        refIds: unique(result.selectedRefIds.filter((refId) => allowedRefs.has(refId))),
      };
      this.prefetch = undefined;
      this.options.onTrace?.({ type: 'recall.prefetch.completed', key });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (generation === this.prefetchGeneration) this.prefetch = undefined;
      this.options.onTrace?.({
        type: 'recall.prefetch.failed',
        key,
        detail: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private cancelPrefetch(detail: string): void {
    if (this.prefetch === undefined) return;
    const key = this.prefetch.key;
    this.prefetch.controller.abort();
    this.prefetch = undefined;
    this.prefetchGeneration += 1;
    this.options.onTrace?.({ type: 'recall.prefetch.discarded', key, detail });
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

function boundedQueryContent(values: readonly string[]): string {
  const safe = values
    .map((value) => value
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .replace(/<\/?[^>]+>/g, '')
      .replace(/[<>]/g, '')
      .replace(/\s+/g, ' ')
      .trim())
    .filter((value) => value.length > 0);
  let content = safe.join('\n');
  while (estimateMemoryTokens(content) > 512 && safe.length > 1) {
    safe.pop();
    content = safe.join('\n');
  }
  return estimateMemoryTokens(content) <= 512 ? content : '';
}

function decisionEpoch(decisionRevision: string, throughSequence: number): string {
  return digest(`${decisionRevision}\0${throughSequence}`).slice(0, 24);
}

function uniqueModes(values: readonly MemorySelectionMode[]): readonly MemorySelectionMode[] {
  return [...new Set(values)];
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
