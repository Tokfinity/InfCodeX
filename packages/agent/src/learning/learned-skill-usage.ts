import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import { LearningCapabilityError } from './center-types.js';
import { emitKodaXDiagnostic } from '../diagnostics.js';
import { LearnedAreaStore } from './learned-area-store.js';
import {
  admitLearnedSkillBinding,
  completeLearnedSkillOutcome,
  invokeLearnedSkillCanary,
  isLearnedCapabilityRecordV2,
  type LearnedSkillCanaryOutcome,
} from './learned-skill.js';

export interface LearnedSkillOfferedReceipt {
  readonly version: 1;
  readonly kind: 'offered';
  readonly receiptId: string;
  readonly sessionHash: string;
  readonly bindingId: string;
  readonly capabilityId: string;
  readonly revision: number;
  readonly fingerprint: string;
  readonly createdAt: string;
}

export interface LearnedSkillInvokedReceipt {
  readonly version: 1;
  readonly kind: 'invoked';
  readonly receiptId: string;
  readonly sessionHash: string;
  readonly bindingId: string;
  readonly invocationId: string;
  readonly capabilityId: string;
  readonly revision: number;
  readonly fingerprint: string;
  readonly createdAt: string;
}

export interface LearnedSkillOutcomeReceipt {
  readonly version: 1;
  readonly kind: 'outcome';
  readonly receiptId: string;
  readonly sessionHash: string;
  readonly invocationId: string;
  readonly capabilityId: string;
  readonly outcome: LearnedSkillCanaryOutcome;
  readonly evidenceRefs: readonly string[];
  readonly createdAt: string;
}

export type LearnedSkillUsageReceipt =
  | LearnedSkillOfferedReceipt
  | LearnedSkillInvokedReceipt
  | LearnedSkillOutcomeReceipt;

export interface ExactInvokedSkillSnapshot {
  readonly capabilityId: string;
  readonly name: string;
  readonly fingerprint: string;
  readonly revision: number;
  readonly invocationId: string;
  readonly content: string;
}

export async function recordLearnedSkillOffered(
  store: LearnedAreaStore,
  input: {
    readonly sessionId: string;
    readonly bindingId: string;
    readonly capabilityId: string;
    readonly revision: number;
    readonly fingerprint: string;
    readonly now?: string;
  },
): Promise<LearnedSkillOfferedReceipt> {
  const sessionHash = usageHash('session', input.sessionId);
  const receipt: LearnedSkillOfferedReceipt = {
    version: 1,
    kind: 'offered',
    receiptId: usageHash(
      'offered',
      `${sessionHash}\0${input.bindingId}\0${input.capabilityId}\0${input.revision}`,
    ),
    sessionHash,
    bindingId: input.bindingId,
    capabilityId: input.capabilityId,
    revision: input.revision,
    fingerprint: input.fingerprint,
    createdAt: input.now ?? new Date().toISOString(),
  };
  await writeImmutableReceipt(store, receipt);
  return receipt;
}

export async function admitAndRecordLearnedSkillInvocation(
  store: LearnedAreaStore,
  input: {
    readonly sessionId: string;
    readonly bindingId: string;
    readonly ownerSessionRef: string;
    readonly capabilityId: string;
    readonly expectedRevision: number;
    readonly expectedFingerprint: string;
    readonly invocationId?: string;
    readonly now?: Date;
  },
): Promise<LearnedSkillInvokedReceipt> {
  const now = input.now ?? new Date();
  const invocationId = input.invocationId ?? randomUUID();
  const sessionHash = usageHash('session', input.sessionId);
  const before = await store.readCapability(input.capabilityId);
  if (before === undefined
    || !isLearnedCapabilityRecordV2(before)
    || before.artifact.contentRevision !== input.expectedRevision
    || before.artifact.fingerprint !== input.expectedFingerprint) {
    throw new LearningCapabilityError(
      'invalid_record',
      'learned Skill invocation expected revision or fingerprint changed',
    );
  }
  if (before.lifecycle === 'testing') {
    const renewed = await admitLearnedSkillBinding(store, input.capabilityId, {
      bindingId: input.bindingId,
      ownerSessionRef: input.ownerSessionRef,
      now,
    });
    if (renewed === undefined) {
      throw new LearningCapabilityError(
        'action_failed',
        'learned Skill canary binding is owned by another root',
      );
    }
    await invokeLearnedSkillCanary(store, input.capabilityId, {
      bindingId: input.bindingId,
      invocationId,
      usageSessionHash: sessionHash,
      artifactRevision: input.expectedRevision,
      artifactFingerprint: input.expectedFingerprint,
      now,
    });
  } else if (before.lifecycle !== 'active_learned') {
    throw new LearningCapabilityError(
      'invalid_transition',
      'learned Skill revision is not active or in admitted testing',
    );
  }
  const record = await store.readCapability(input.capabilityId);
  if (record === undefined || !isLearnedCapabilityRecordV2(record)) {
    throw new LearningCapabilityError('capability_not_found', 'learned Skill record disappeared');
  }
  const receipt: LearnedSkillInvokedReceipt = {
    version: 1,
    kind: 'invoked',
    receiptId: usageHash('invoked', `${sessionHash}\0${invocationId}`),
    sessionHash,
    bindingId: input.bindingId,
    invocationId,
    capabilityId: record.capabilityId,
    revision: input.expectedRevision,
    fingerprint: input.expectedFingerprint,
    createdAt: now.toISOString(),
  };
  await writeImmutableReceipt(store, receipt);
  return receipt;
}

export async function completeLearnedSkillSessionOutcomes(
  store: LearnedAreaStore,
  input: {
    readonly sessionId: string;
    /** Restricts completion to invocations from one root-run binding. */
    readonly bindingId?: string;
    readonly outcome: LearnedSkillCanaryOutcome;
    readonly evidenceRefs: readonly string[];
    readonly now?: string;
  },
): Promise<readonly LearnedSkillOutcomeReceipt[]> {
  if (input.evidenceRefs.length === 0) return [];
  const receipts = await listLearnedSkillUsageReceipts(store, input.sessionId);
  const completedIds = new Set(receipts
    .filter((item): item is LearnedSkillOutcomeReceipt => item.kind === 'outcome')
    .map((item) => item.invocationId));
  const invokedReceipts = receipts.filter(
    (item): item is LearnedSkillInvokedReceipt => (
      item.kind === 'invoked'
      && (input.bindingId === undefined || item.bindingId === input.bindingId)
    ),
  );
  const ambiguousAttribution = new Set(
    invokedReceipts.map((item) => item.capabilityId),
  ).size > 1;
  const effectiveOutcome = ambiguousAttribution ? 'inconclusive' : input.outcome;
  const outcomes: LearnedSkillOutcomeReceipt[] = [];
  for (const invoked of invokedReceipts) {
    if (completedIds.has(invoked.invocationId)) continue;
    const capability = await store.readCapability(invoked.capabilityId);
    const existingInvocation = capability !== undefined
      && isLearnedCapabilityRecordV2(capability)
      ? capability.canary.invocations.find((item) => item.invocationId === invoked.invocationId)
      : undefined;
    let receiptOutcome = existingInvocation !== undefined
      && existingInvocation.status !== 'pending'
      ? existingInvocation.status
      : effectiveOutcome;
    let receiptEvidenceRefs = existingInvocation !== undefined
      && existingInvocation.status !== 'pending'
      ? existingInvocation.evidenceRefs
      : input.evidenceRefs;
    let receiptCreatedAt = existingInvocation !== undefined
      && existingInvocation.status !== 'pending'
      ? existingInvocation.completedAt ?? input.now ?? new Date().toISOString()
      : input.now ?? new Date().toISOString();
    if (capability !== undefined
      && isLearnedCapabilityRecordV2(capability)
      && existingInvocation?.status === 'pending') {
      const completed = await completeLearnedSkillOutcome(store, invoked.capabilityId, {
        invocationId: invoked.invocationId,
        outcome: effectiveOutcome,
        evidenceRefs: input.evidenceRefs,
        now: input.now,
      });
      const settled = completed.canary.invocations
        .find((item) => item.invocationId === invoked.invocationId);
      if (settled !== undefined && settled.status !== 'pending') {
        receiptOutcome = settled.status;
        receiptEvidenceRefs = settled.evidenceRefs;
        receiptCreatedAt = settled.completedAt ?? receiptCreatedAt;
      }
    }
    const receipt: LearnedSkillOutcomeReceipt = {
      version: 1,
      kind: 'outcome',
      receiptId: usageHash('outcome', `${invoked.sessionHash}\0${invoked.invocationId}`),
      sessionHash: invoked.sessionHash,
      invocationId: invoked.invocationId,
      capabilityId: invoked.capabilityId,
      outcome: receiptOutcome,
      evidenceRefs: [...receiptEvidenceRefs],
      createdAt: receiptCreatedAt,
    };
    await writeImmutableReceipt(store, receipt);
    outcomes.push(receipt);
  }
  return outcomes;
}

/** Repairs current-binding and stale-canary outcome delivery fail closed. */
export async function reconcileLearnedSkillBindingOutcomes(
  store: LearnedAreaStore,
  input: {
    readonly sessionId: string;
    readonly bindingId: string;
    readonly now?: string;
  },
): Promise<readonly LearnedSkillOutcomeReceipt[]> {
  const sessionHash = usageHash('session', input.sessionId);
  const now = input.now ?? new Date().toISOString();
  const outcomes: LearnedSkillOutcomeReceipt[] = [];
  const records = (await store.listCapabilities())
    .filter(isLearnedCapabilityRecordV2);
  const candidates = new Map<string, {
    readonly invoked: LearnedSkillInvokedReceipt;
    readonly capability: (typeof records)[number];
    readonly canonicalInvocationId?: string;
  }>();
  for (const invoked of await listValidBindingInvocations(
    store,
    sessionHash,
    input.bindingId,
  )) {
    const capability = records.find((record) => record.capabilityId === invoked.capabilityId);
    if (capability === undefined) continue;
    const canonical = capability.canary.invocations.find(
      (invocation) => invocation.invocationId === invoked.invocationId
        && invocation.bindingId === invoked.bindingId,
    );
    if (canonical === undefined
      && (capability.lifecycle !== 'active_learned'
        || capability.artifact.contentRevision !== invoked.revision
        || capability.artifact.fingerprint !== invoked.fingerprint)) {
      throw new LearningCapabilityError(
        'store_integrity_error',
        'learned Skill invocation receipt does not match a current artifact',
      );
    }
    candidates.set(`${invoked.sessionHash}\0${invoked.invocationId}`, {
      invoked,
      capability,
      ...(canonical === undefined ? {} : { canonicalInvocationId: invoked.invocationId }),
    });
  }
  for (const record of records) {
    for (const invocation of record.canary.invocations) {
      if (invocation.bindingId !== input.bindingId && invocation.status === 'pending') continue;
      const invocationSessionHash = invocation.usageSessionHash
        ?? (invocation.bindingId === input.bindingId ? sessionHash : undefined);
      if (invocationSessionHash === undefined) continue;
      const invokedReceiptId = usageHash(
        'invoked',
        `${invocationSessionHash}\0${invocation.invocationId}`,
      );
      const existingInvoked = await readUsageReceipt(
        store,
        invocationSessionHash,
        invokedReceiptId,
      );
      if (existingInvoked !== undefined && existingInvoked.kind !== 'invoked') {
        throw new LearningCapabilityError(
          'store_integrity_error',
          'learned Skill invocation receipt identity was reused',
        );
      }
      if (existingInvoked?.kind === 'invoked'
        && (existingInvoked.invocationId !== invocation.invocationId
          || existingInvoked.bindingId !== invocation.bindingId
          || existingInvoked.capabilityId !== record.capabilityId
          || existingInvoked.revision
            !== (invocation.artifactRevision ?? record.artifact.contentRevision)
          || existingInvoked.fingerprint
            !== (invocation.artifactFingerprint ?? record.artifact.fingerprint))) {
        throw new LearningCapabilityError(
          'store_integrity_error',
          'learned Skill invocation receipt drifted from canonical invocation',
        );
      }
      const invoked: LearnedSkillInvokedReceipt = existingInvoked ?? {
        version: 1,
        kind: 'invoked',
        receiptId: invokedReceiptId,
        sessionHash: invocationSessionHash,
        bindingId: invocation.bindingId,
        invocationId: invocation.invocationId,
        capabilityId: record.capabilityId,
        revision: invocation.artifactRevision ?? record.artifact.contentRevision,
        fingerprint: invocation.artifactFingerprint ?? record.artifact.fingerprint,
        createdAt: invocation.invokedAt,
      };
      if (existingInvoked === undefined) await writeImmutableReceipt(store, invoked);
      candidates.set(`${invoked.sessionHash}\0${invoked.invocationId}`, {
        invoked,
        capability: record,
        canonicalInvocationId: invocation.invocationId,
      });
    }
  }
  for (const candidate of candidates.values()) {
    const { invoked } = candidate;
    const outcomeReceiptId = usageHash(
      'outcome',
      `${invoked.sessionHash}\0${invoked.invocationId}`,
    );
    const existing = await readUsageReceipt(store, invoked.sessionHash, outcomeReceiptId);
    const canonical = candidate.canonicalInvocationId === undefined
      ? undefined
      : candidate.capability.canary.invocations.find(
          (invocation) => invocation.invocationId === candidate.canonicalInvocationId,
        );
    if (existing !== undefined) {
      if (existing.kind !== 'outcome') {
        throw new LearningCapabilityError(
          'store_integrity_error',
          'learned Skill outcome receipt identity was reused',
        );
      }
      const identityDrifted = existing.invocationId !== invoked.invocationId
        || existing.capabilityId !== invoked.capabilityId;
      const canonicalCompletionMissing = canonical !== undefined
        && canonical.status !== 'pending'
        && canonical.completedAt === undefined;
      const canonicalDrifted = canonical !== undefined
        && (canonical.status === 'pending'
          || existing.outcome !== canonical.status
          || JSON.stringify(existing.evidenceRefs) !== JSON.stringify(canonical.evidenceRefs)
          || existing.createdAt !== canonical.completedAt);
      if (identityDrifted || canonicalCompletionMissing || canonicalDrifted) {
        throw new LearningCapabilityError(
          'store_integrity_error',
          'learned Skill outcome receipt drifted from canonical invocation',
        );
      }
      continue;
    }
    const settledRecord = canonical?.status === 'pending'
      ? await completeLearnedSkillOutcome(store, candidate.capability.capabilityId, {
          invocationId: invoked.invocationId,
          outcome: 'inconclusive',
          evidenceRefs: ['host:learned-skill-binding-release'],
          now,
        })
      : candidate.capability;
    const settled = canonical === undefined
      ? undefined
      : settledRecord.canary.invocations
        .find((invocation) => invocation.invocationId === invoked.invocationId);
    if (settled?.status === 'pending') {
      throw new LearningCapabilityError(
        'store_integrity_error',
        'learned Skill canary invocation did not settle during reconciliation',
      );
    }
    if (settled !== undefined && settled.completedAt === undefined) {
      throw new LearningCapabilityError(
        'store_integrity_error',
        'learned Skill terminal invocation has no canonical completion time',
      );
    }
    const receipt: LearnedSkillOutcomeReceipt = {
      version: 1,
      kind: 'outcome',
      receiptId: outcomeReceiptId,
      sessionHash: invoked.sessionHash,
      invocationId: invoked.invocationId,
      capabilityId: invoked.capabilityId,
      outcome: settled?.status ?? 'inconclusive',
      evidenceRefs: settled !== undefined && settled.evidenceRefs.length > 0
        ? settled.evidenceRefs
        : ['host:learned-skill-binding-release'],
      createdAt: settled?.completedAt ?? now,
    };
    await writeImmutableReceipt(store, receipt);
    outcomes.push(receipt);
  }
  return outcomes;
}

async function listValidBindingInvocations(
  store: LearnedAreaStore,
  sessionHash: string,
  bindingId: string,
): Promise<readonly LearnedSkillInvokedReceipt[]> {
  const root = usageSessionRoot(store, sessionHash);
  let files: readonly string[];
  try {
    files = (await readdir(root)).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if (isFileError(error, 'ENOENT')) return [];
    throw error;
  }
  const receipts: LearnedSkillInvokedReceipt[] = [];
  for (const name of files) {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(join(root, name), 'utf8'));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      emitKodaXDiagnostic({
        source: 'learning.skill-usage',
        level: 'warn',
        message: 'Invalid unrelated usage receipt was skipped during binding recovery.',
        detail: { filePath: join(root, name) },
      });
      continue;
    }
    if (!isUsageReceipt(value)) {
      if (isRecord(value) && value.kind === 'invoked' && value.bindingId === bindingId) {
        throw new LearningCapabilityError(
          'store_integrity_error',
          'invalid target learned Skill invocation receipt',
        );
      }
      emitInvalidSiblingReceipt(root, name);
      continue;
    }
    if (value.kind !== 'invoked' || value.bindingId !== bindingId) continue;
    const derivedReceiptId = usageHash(
      'invoked',
      `${sessionHash}\0${value.invocationId}`,
    );
    if (value.sessionHash !== sessionHash
      || value.receiptId !== derivedReceiptId
      || name !== `${derivedReceiptId}.json`) {
      throw new LearningCapabilityError(
        'store_integrity_error',
        'target learned Skill invocation receipt identity is invalid',
      );
    }
    receipts.push(value);
  }
  return receipts;
}

function emitInvalidSiblingReceipt(root: string, name: string): void {
  emitKodaXDiagnostic({
    source: 'learning.skill-usage',
    level: 'warn',
    message: 'Invalid unrelated usage receipt was skipped during binding recovery.',
    detail: { filePath: join(root, name) },
  });
}

export async function listLearnedSkillUsageReceipts(
  store: LearnedAreaStore,
  sessionId: string,
): Promise<readonly LearnedSkillUsageReceipt[]> {
  const root = usageSessionRoot(store, usageHash('session', sessionId));
  let files: readonly string[];
  try {
    files = (await readdir(root)).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if (isFileError(error, 'ENOENT')) return [];
    throw error;
  }
  const receipts: LearnedSkillUsageReceipt[] = [];
  for (const name of files) {
    const value: unknown = JSON.parse(await readFile(join(root, name), 'utf8'));
    if (!isUsageReceipt(value)) {
      throw new LearningCapabilityError('store_integrity_error', 'invalid learned Skill usage receipt');
    }
    receipts.push(value);
  }
  return receipts.sort((left, right) => (
    left.createdAt.localeCompare(right.createdAt)
    || left.receiptId.localeCompare(right.receiptId)
  ));
}

export async function exactInvokedSkillSnapshotForSession(
  store: LearnedAreaStore,
  sessionId: string,
  options: { readonly bindingId?: string } = {},
): Promise<ExactInvokedSkillSnapshot | null> {
  const invoked = (await listLearnedSkillUsageReceipts(store, sessionId))
    .filter((item): item is LearnedSkillInvokedReceipt => (
      item.kind === 'invoked'
      && (options.bindingId === undefined || item.bindingId === options.bindingId)
    ));
  const exact = invoked.at(-1);
  if (exact === undefined) return null;
  if (invoked.some((item) => item.capabilityId !== exact.capabilityId)) return null;
  const record = await store.readCapability(exact.capabilityId);
  if (record === undefined
    || !isLearnedCapabilityRecordV2(record)
    || record.artifact.fingerprint !== exact.fingerprint
    || record.artifact.contentRevision !== exact.revision) return null;
  const artifactPath = resolve(store.paths.root, ...record.artifact.relativePath.split('/'));
  assertInside(artifactPath, store.paths.root);
  const content = await readFile(artifactPath, 'utf8');
  const actual = createHash('sha256').update(content, 'utf8').digest('hex');
  if (actual !== record.artifact.fingerprint) return null;
  return {
    capabilityId: record.capabilityId,
    name: record.slug,
    fingerprint: exact.fingerprint,
    revision: exact.revision,
    invocationId: exact.invocationId,
    content,
  };
}

async function writeImmutableReceipt(
  store: LearnedAreaStore,
  receipt: LearnedSkillUsageReceipt,
): Promise<void> {
  const filePath = join(
    usageSessionRoot(store, receipt.sessionHash),
    `${receipt.receiptId}.json`,
  );
  await mkdir(dirname(filePath), { recursive: true });
  const body = `${JSON.stringify(receipt, null, 2)}\n`;
  try {
    const handle = await open(filePath, 'wx');
    try {
      await handle.writeFile(body, 'utf8');
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!isFileError(error, 'EEXIST')) throw error;
    const existing: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    if (!isUsageReceipt(existing)
      || JSON.stringify({ ...existing, createdAt: '' })
        !== JSON.stringify({ ...receipt, createdAt: '' })) {
      throw new LearningCapabilityError('store_integrity_error', 'learned Skill usage receipt drifted');
    }
  }
}

async function readUsageReceipt(
  store: LearnedAreaStore,
  sessionHash: string,
  receiptId: string,
): Promise<LearnedSkillUsageReceipt | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(
      join(usageSessionRoot(store, sessionHash), `${receiptId}.json`),
      'utf8',
    ));
    if (!isUsageReceipt(value)
      || value.receiptId !== receiptId
      || value.sessionHash !== sessionHash) {
      throw new LearningCapabilityError(
        'store_integrity_error',
        'invalid learned Skill usage receipt',
      );
    }
    return value;
  } catch (error) {
    if (isFileError(error, 'ENOENT')) return undefined;
    throw error;
  }
}

function usageSessionRoot(store: LearnedAreaStore, sessionHash: string): string {
  return join(store.paths.root, 'usage', sessionHash);
}

function usageHash(kind: string, value: string): string {
  return createHash('sha256').update(`${kind}\0${value}`, 'utf8').digest('hex');
}

function isUsageReceipt(value: unknown): value is LearnedSkillUsageReceipt {
  if (!isRecord(value)
    || value.version !== 1
    || !['offered', 'invoked', 'outcome'].includes(String(value.kind))
    || typeof value.receiptId !== 'string'
    || typeof value.sessionHash !== 'string'
    || typeof value.capabilityId !== 'string'
    || typeof value.createdAt !== 'string') return false;
  if (value.kind === 'offered') {
    return typeof value.bindingId === 'string'
      && Number.isSafeInteger(value.revision)
      && typeof value.fingerprint === 'string';
  }
  if (value.kind === 'invoked') {
    return typeof value.bindingId === 'string'
      && typeof value.invocationId === 'string'
      && Number.isSafeInteger(value.revision)
      && typeof value.fingerprint === 'string';
  }
  return typeof value.invocationId === 'string'
    && ['verified_success', 'credible_negative', 'inconclusive'].includes(String(value.outcome))
    && Array.isArray(value.evidenceRefs)
    && value.evidenceRefs.every((ref) => typeof ref === 'string');
}

function assertInside(target: string, rootDir: string): void {
  const root = comparable(rootDir);
  const candidate = comparable(target);
  if (candidate !== root && !candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) {
    throw new LearningCapabilityError('store_integrity_error', 'learned Skill artifact escaped its owner');
  }
}

function comparable(value: string): string {
  const normalized = resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFileError(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
