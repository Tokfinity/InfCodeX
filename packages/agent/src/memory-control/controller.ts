import { createHash } from 'node:crypto';
import { readdir, readFile, rename, rm, writeFile, mkdir } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';

import {
  initializeSkillRegistry,
  type SkillMetadata,
} from '../capabilities/skills/index.js';
import {
  parseMemoryFile,
  resolveMemoryRoot,
  type MemoryType,
} from '../memory/index.js';
import {
  readLearningProposalStore,
  resolveLearningProposalStore,
  updateLearningProposalStatus,
} from '../learning/store.js';
import type {
  MemoryLearningHandoff,
  ReasoningLearningHandoff,
  StoredLearningProposal,
} from '../learning/types.js';
import type {
  KodaXSessionArtifactLedgerEntry,
  KodaXSessionEntry,
  KodaXSessionLineage,
} from '../types.js';
import type {
  MemoryActionProposal,
  MemoryApplyPreview,
  MemoryApplyResult,
  MemoryApproval,
  MemoryBodySnapshot,
  MemoryController,
  MemoryCuratorInput,
  MemoryEvent,
  MemoryGovernanceFinding,
  MemoryGovernanceReport,
  MemoryItemRef,
  MemoryPack,
  MemoryPackHint,
  MemoryPackInput,
  MemoryRefFilter,
  MemorySourceAdapter,
  MemoryVisibility,
} from './types.js';

const MISSING_FINGERPRINT = 'missing';

export interface CreateMemoryControlPlaneOptions {
  readonly cwd: string;
  readonly learningStorePath?: string;
  readonly memoryRoot?: string;
  readonly projectDocs?: readonly string[];
  readonly extraRefs?: readonly MemoryItemRef[];
  readonly sessionId?: string;
  readonly sessionLineage?: KodaXSessionLineage;
  readonly artifactLedger?: readonly KodaXSessionArtifactLedgerEntry[];
  readonly now?: () => string;
  readonly onEvent?: (event: MemoryEvent) => void;
  readonly discoverSkills?: boolean;
}

interface ReadTextResult {
  readonly exists: boolean;
  readonly content: string;
}

interface MemdirWritePlan {
  readonly targetPath: string;
  readonly entrypointPath: string;
  readonly content: string;
  readonly indexLine: string;
}

export function createMemoryControlPlane(options: CreateMemoryControlPlaneOptions): MemoryController {
  return new MemoryControlPlane(options);
}

export class MemoryControlPlane implements MemoryController {
  private readonly cwd: string;
  private readonly learningStorePath: string;
  private readonly memoryRoot: string;
  private readonly now: () => string;
  private readonly onEvent?: (event: MemoryEvent) => void;
  private readonly projectDocs: readonly string[];
  private readonly extraRefs: readonly MemoryItemRef[];
  private readonly sessionId: string;
  private readonly sessionLineage?: KodaXSessionLineage;
  private readonly artifactLedger: readonly KodaXSessionArtifactLedgerEntry[];
  private readonly discoverSkills: boolean;

  constructor(options: CreateMemoryControlPlaneOptions) {
    this.cwd = options.cwd;
    this.learningStorePath = options.learningStorePath ?? resolveLearningProposalStore(options.cwd);
    this.memoryRoot = options.memoryRoot ?? resolveMemoryRoot(options.cwd);
    this.now = options.now ?? (() => new Date().toISOString());
    this.onEvent = options.onEvent;
    this.projectDocs = options.projectDocs ?? defaultProjectDocs(options.cwd);
    this.extraRefs = options.extraRefs ?? [];
    this.sessionId = options.sessionId ?? 'current';
    this.sessionLineage = options.sessionLineage;
    this.artifactLedger = options.artifactLedger ?? [];
    this.discoverSkills = options.discoverSkills ?? true;
  }

  async listInbox(): Promise<readonly MemoryActionProposal[]> {
    const store = await readLearningProposalStore(this.learningStorePath);
    if (store.warnings.length > 0) return [];
    const proposals: MemoryActionProposal[] = [];
    for (const entry of store.proposals) {
      if (entry.status !== 'pending') continue;
      const proposal = await this.projectLearningProposal(entry);
      if (proposal !== undefined) proposals.push(proposal);
    }
    return proposals;
  }

  async showProposal(id: string): Promise<MemoryActionProposal | undefined> {
    const store = await readLearningProposalStore(this.learningStorePath);
    if (store.warnings.length > 0) return undefined;
    const entry = store.proposals.find((proposal) => memoryProposalId(proposal.proposalId) === id);
    return entry === undefined ? undefined : this.projectLearningProposal(entry);
  }

  async approveProposal(
    id: string,
    expectedFingerprints?: Readonly<Record<string, string>>,
  ): Promise<MemoryApplyResult> {
    const proposal = await this.showProposal(id);
    if (proposal === undefined) {
      return skippedApply(id, 'memory proposal not found');
    }
    const approval: MemoryApproval = {
      proposalId: proposal.id,
      approvedBy: 'user',
      approvedAt: this.now(),
      expectedFingerprints: expectedFingerprints ?? proposal.expectedFingerprints,
    };
    const adapter = this.adapterForProposal(proposal);
    const result = await adapter.applyProposal(proposal, approval);
    if (result.applied) this.emit({ type: 'proposal.approved', proposalId: id });
    return result;
  }

  async rejectProposal(id: string, reason?: string): Promise<void> {
    const proposalId = parseMemoryProposalId(id);
    if (proposalId === undefined) {
      throw new Error(`invalid memory proposal id: ${id}`);
    }
    await updateLearningProposalStatus(
      this.learningStorePath,
      proposalId,
      'rejected',
      reason !== undefined && reason.trim().length > 0 ? { rejectedReason: reason } : {},
    );
    this.emit({ type: 'proposal.rejected', proposalId: id });
  }

  async listRefs(filter: MemoryRefFilter = {}): Promise<readonly MemoryItemRef[]> {
    const refs: MemoryItemRef[] = [];
    refs.push(...await this.listLearningRefs());
    refs.push(...await this.memdirAdapter().listRefs(filter));
    refs.push(...this.listSessionTraceRefs());
    refs.push(...this.listArtifactLedgerRefs());
    refs.push(...await this.listProjectDocRefs());
    refs.push(...await this.listSkillRefs());
    refs.push(...this.extraRefs);
    return refs.filter((ref) => matchesFilter(ref, filter));
  }

  async readRef(ref: MemoryItemRef): Promise<MemoryBodySnapshot> {
    if (ref.kind === 'learning_proposal' || ref.kind === 'reasoning_report') {
      return this.readLearningRef(ref);
    }
    if (ref.kind === 'memdir') {
      return this.memdirAdapter().readRef(ref);
    }
    if (ref.kind === 'session_trace') {
      return this.readSessionTraceRef(ref);
    }
    if (ref.kind === 'artifact_ledger') {
      return this.readArtifactLedgerRef(ref);
    }
    return readStorageBackedRef(ref, this.now);
  }

  async runCurator(input: MemoryCuratorInput = {}): Promise<MemoryGovernanceReport> {
    const refs = await this.listRefs({
      includePrivate: input.includePrivate,
      includeSensitive: input.includeSensitive,
    });
    const findings = buildGovernanceFindings(refs);
    const reportId = `memory-governance:${fingerprint(`${this.now()}:${findings.length}`).slice(0, 12)}`;
    const report: MemoryGovernanceReport = {
      reportId,
      generatedAt: this.now(),
      findings: findings.length > 0
        ? findings
        : [{
            kind: 'no_op',
            severity: 'info',
            refIds: [],
            summary: 'No memory governance findings.',
            suggestedAction: 'no_op',
          }],
      warnings: [],
    };
    this.emit({ type: 'curator.completed', reportId });
    return report;
  }

  async buildMemoryPack(input: MemoryPackInput): Promise<MemoryPack> {
    const generatedAt = this.now();
    const taskFingerprint = fingerprint(input.task);
    if (input.ignoreMemory === true || shouldIgnoreMemory(input.task)) {
      return {
        generatedAt,
        taskFingerprint,
        hints: [],
        omitted: ['memory intentionally suppressed by request'],
        traceMetadata: {
          selectedRefIds: [],
          omittedRefIds: [],
          taskFingerprint,
          suppressed: true,
        },
      };
    }
    const refs = await this.listRefs({
      includePrivate: input.includePrivate,
      includeSensitive: input.includeSensitive,
    });
    const eligible = refs
      .filter((ref) => isPackEligible(ref, input))
      .sort((left, right) => scoreRef(right, input.task) - scoreRef(left, input.task));
    const maxHints = Math.max(0, input.maxHints ?? 8);
    const selected = eligible.slice(0, maxHints);
    const hints = await this.buildPackHints(selected, input);
    this.emit({ type: 'pack.selected', refIds: hints.map((hint) => hint.ref.id) });
    return {
      generatedAt,
      taskFingerprint,
      hints,
      omitted: eligible.slice(maxHints).map((ref) => ref.id),
      traceMetadata: {
        selectedRefIds: hints.map((hint) => hint.ref.id),
        omittedRefIds: eligible.slice(maxHints).map((ref) => ref.id),
        taskFingerprint,
        suppressed: false,
      },
    };
  }

  private async projectLearningProposal(entry: StoredLearningProposal): Promise<MemoryActionProposal | undefined> {
    if (entry.proposal.destination === 'memdir_handoff') {
      return this.projectMemdirHandoff(entry, entry.proposal);
    }
    if (entry.proposal.destination === 'reasoning_handoff') {
      return this.projectReasoningHandoff(entry, entry.proposal);
    }
    return undefined;
  }

  private async projectMemdirHandoff(
    entry: StoredLearningProposal,
    handoff: MemoryLearningHandoff,
  ): Promise<MemoryActionProposal> {
    const plan = buildMemdirWritePlan(this.memoryRoot, handoff, entry.proposalId);
    const targetRef = await buildMemdirTargetRef(plan.targetPath, handoff, entry);
    const indexRef = await buildEntrypointRef(plan.entrypointPath);
    const sourceRef = learningRefFromEntry(entry);
    const beforeFingerprints = {
      [targetRef.id]: targetRef.bodyFingerprint ?? MISSING_FINGERPRINT,
      [indexRef.id]: indexRef.bodyFingerprint ?? MISSING_FINGERPRINT,
    };
    const preview: MemoryApplyPreview = {
      summary: `Write ${handoff.memoryKind} memory from learning proposal ${entry.proposalId}.`,
      changedRefs: [targetRef, indexRef],
      changedPaths: [plan.targetPath, plan.entrypointPath],
      beforeFingerprints,
      afterFingerprints: {
        [targetRef.id]: fingerprint(plan.content),
      },
      diff: plan.content,
      warnings: [],
    };
    return {
      id: memoryProposalId(entry.proposalId),
      action: 'write_memdir',
      targetRefs: [targetRef, indexRef],
      sourceRefs: [sourceRef],
      expectedFingerprints: beforeFingerprints,
      rationale: `F224 classified this as ${handoff.memoryKind} memory.`,
      risk: 'medium',
      preview,
      requiresApproval: true,
      createdAt: entry.createdAt,
    };
  }

  private projectReasoningHandoff(
    entry: StoredLearningProposal,
    handoff: ReasoningLearningHandoff,
  ): MemoryActionProposal {
    const reasoningRef = reasoningRefFromEntry(entry);
    const sourceRef = learningRefFromEntry(entry);
    const preview: MemoryApplyPreview = {
      summary: `Record reasoning report handoff: ${handoff.title}`,
      changedRefs: [],
      changedPaths: [],
      beforeFingerprints: { [reasoningRef.id]: reasoningRef.bodyFingerprint ?? fingerprint(handoff.body) },
      warnings: ['No stable reasoning-strategy carrier exists yet; approval records the handoff only.'],
    };
    return {
      id: memoryProposalId(entry.proposalId),
      action: 'no_op',
      targetRefs: [reasoningRef],
      sourceRefs: [sourceRef],
      expectedFingerprints: preview.beforeFingerprints,
      rationale: 'Reasoning handoff stays as a report until a stable carrier exists.',
      risk: 'low',
      preview,
      requiresApproval: true,
      createdAt: entry.createdAt,
    };
  }

  private async listLearningRefs(): Promise<readonly MemoryItemRef[]> {
    const store = await readLearningProposalStore(this.learningStorePath);
    if (store.warnings.length > 0) return [];
    const refs: MemoryItemRef[] = [];
    for (const entry of store.proposals) {
      if (entry.proposal.destination === 'memdir_handoff' || entry.proposal.destination === 'reasoning_handoff') {
        refs.push(learningRefFromEntry(entry));
      }
      if (entry.proposal.destination === 'reasoning_handoff') {
        refs.push(reasoningRefFromEntry(entry));
      }
    }
    return refs;
  }

  private async readLearningRef(ref: MemoryItemRef): Promise<MemoryBodySnapshot> {
    const proposalId = ref.kind === 'reasoning_report'
      ? ref.id.replace(/^reasoning_report:/, '')
      : ref.id.replace(/^learning_proposal:/, '');
    const store = await readLearningProposalStore(this.learningStorePath);
    const entry = store.proposals.find((proposal) => proposal.proposalId === proposalId);
    if (entry === undefined) {
      return {
        ref,
        body: '',
        bodyFingerprint: fingerprint(''),
        readAt: this.now(),
        warnings: [`learning proposal not found: ${proposalId}`],
      };
    }
    const body = learningBody(entry);
    return {
      ref: { ...ref, bodyFingerprint: fingerprint(body) },
      body,
      bodyFingerprint: fingerprint(body),
      readAt: this.now(),
      warnings: store.warnings,
    };
  }

  private async listProjectDocRefs(): Promise<readonly MemoryItemRef[]> {
    const refs: MemoryItemRef[] = [];
    for (const docPath of this.projectDocs) {
      const read = await readTextIfExists(docPath);
      if (!read.exists) continue;
      refs.push({
        kind: 'project_doc',
        id: `project_doc:${relative(this.cwd, docPath).replace(/\\/g, '/')}`,
        scope: 'project',
        title: basename(docPath),
        owner: 'project',
        lifecycle: 'readonly',
        authority: 'read_only',
        visibility: 'prompt_safe',
        sourceRefs: [],
        relatedRefs: [],
        bodyFingerprint: fingerprint(read.content),
        storageUri: docPath,
      });
    }
    return refs;
  }

  private listSessionTraceRefs(): readonly MemoryItemRef[] {
    if (this.sessionLineage === undefined) return [];
    return this.sessionLineage.entries.map((entry) => sessionTraceRefFromEntry(this.sessionId, entry));
  }

  private listArtifactLedgerRefs(): readonly MemoryItemRef[] {
    return this.artifactLedger.map((entry) => artifactLedgerRefFromEntry(this.sessionId, entry));
  }

  private readSessionTraceRef(ref: MemoryItemRef): MemoryBodySnapshot {
    const entryId = parseScopedMemoryRefId(ref.id, 'session_trace', this.sessionId);
    const entry = this.sessionLineage?.entries.find((candidate) => candidate.id === entryId);
    const body = entry === undefined ? '' : stringifyJson(entry);
    return {
      ref: { ...ref, bodyFingerprint: fingerprint(body) },
      body,
      bodyFingerprint: fingerprint(body),
      readAt: this.now(),
      warnings: entry === undefined ? [`session trace entry not found: ${ref.id}`] : [],
    };
  }

  private readArtifactLedgerRef(ref: MemoryItemRef): MemoryBodySnapshot {
    const entryId = parseScopedMemoryRefId(ref.id, 'artifact_ledger', this.sessionId);
    const entry = this.artifactLedger.find((candidate) => candidate.id === entryId);
    const body = entry === undefined ? '' : stringifyJson(entry);
    return {
      ref: { ...ref, bodyFingerprint: fingerprint(body) },
      body,
      bodyFingerprint: fingerprint(body),
      readAt: this.now(),
      warnings: entry === undefined ? [`artifact ledger entry not found: ${ref.id}`] : [],
    };
  }

  private async listSkillRefs(): Promise<readonly MemoryItemRef[]> {
    if (!this.discoverSkills) return [];
    let skills: readonly SkillMetadata[];
    try {
      const registry = await initializeSkillRegistry(this.cwd);
      skills = registry.list();
    } catch {
      return [];
    }
    return skills.map((skill) => ({
      kind: 'skill',
      id: `skill:${skill.name}`,
      scope: skill.source === 'builtin' ? 'builtin' : skill.source === 'user' ? 'user' : 'project',
      title: skill.name,
      owner: skill.source === 'builtin' ? 'kodax' : skill.source === 'user' ? 'user' : 'project',
      lifecycle: skill.source === 'builtin' ? 'readonly' : 'active',
      authority: 'read_only',
      visibility: 'prompt_safe',
      sourceRefs: [],
      relatedRefs: [],
      storageUri: join(skill.path, 'SKILL.md'),
    } satisfies MemoryItemRef));
  }

  private async buildPackHints(
    refs: readonly MemoryItemRef[],
    input: MemoryPackInput,
  ): Promise<readonly MemoryPackHint[]> {
    const hints: MemoryPackHint[] = [];
    for (const ref of refs) {
      const snapshot = input.includeSnippets === true ? await this.readRef(ref) : undefined;
      hints.push({
        ref,
        hook: ref.title ?? ref.id,
        reason: packReason(ref, input.task),
        ...(snapshot !== undefined && snapshot.body.trim().length > 0
          ? {
              bodySnippet: firstSnippet(snapshot.body),
              bodyFingerprint: snapshot.bodyFingerprint,
            }
          : ref.bodyFingerprint !== undefined ? { bodyFingerprint: ref.bodyFingerprint } : {}),
      });
    }
    return hints;
  }

  private adapterForProposal(proposal: MemoryActionProposal): MemorySourceAdapter {
    if (proposal.action === 'write_memdir' || proposal.action === 'patch_memdir') {
      return this.memdirAdapter();
    }
    return new LearningHandoffAdapter(this.learningStorePath, this.now);
  }

  private memdirAdapter(): MemdirMemoryAdapter {
    return new MemdirMemoryAdapter(this.memoryRoot, this.learningStorePath, this.now);
  }

  private emit(event: MemoryEvent): void {
    this.onEvent?.(event);
  }
}

class LearningHandoffAdapter implements MemorySourceAdapter {
  readonly kind = 'learning_proposal' as const;

  constructor(
    private readonly learningStorePath: string,
    private readonly now: () => string,
  ) {}

  async listRefs(filter: MemoryRefFilter = {}): Promise<readonly MemoryItemRef[]> {
    const store = await readLearningProposalStore(this.learningStorePath);
    if (store.warnings.length > 0) return [];
    return store.proposals
      .filter((entry) => entry.proposal.destination === 'memdir_handoff' || entry.proposal.destination === 'reasoning_handoff')
      .map(learningRefFromEntry)
      .filter((ref) => matchesFilter(ref, filter));
  }

  async readRef(ref: MemoryItemRef): Promise<MemoryBodySnapshot> {
    return readStorageBackedRef(ref, this.now);
  }

  async previewProposal(proposal: MemoryActionProposal): Promise<MemoryApplyPreview> {
    return proposal.preview;
  }

  async applyProposal(
    proposal: MemoryActionProposal,
    approval: MemoryApproval,
  ): Promise<MemoryApplyResult> {
    const proposalId = parseMemoryProposalId(proposal.id);
    if (proposalId === undefined) return skippedApply(proposal.id, 'invalid memory proposal id');
    if (!fingerprintsMatch(proposal.expectedFingerprints, approval.expectedFingerprints)) {
      return skippedApply(proposal.id, 'approval fingerprints do not match proposal preview');
    }
    const updated = await updateLearningProposalStatus(
      this.learningStorePath,
      proposalId,
      'approved',
      { appliedChangedPaths: [], now: this.now },
    );
    return {
      proposalId: proposal.id,
      applied: true,
      changedRefs: proposal.targetRefs,
      changedPaths: [],
      warnings: updated.status === 'approved' ? [] : ['proposal status did not become approved'],
    };
  }
}

class MemdirMemoryAdapter implements MemorySourceAdapter {
  readonly kind = 'memdir' as const;

  constructor(
    private readonly memoryRoot: string,
    private readonly learningStorePath: string,
    private readonly now: () => string,
  ) {}

  async listRefs(filter: MemoryRefFilter = {}): Promise<readonly MemoryItemRef[]> {
    const refs: MemoryItemRef[] = [];
    let entries: readonly { readonly name: string; readonly isFile: () => boolean }[];
    try {
      entries = await readdir(this.memoryRoot, { withFileTypes: true });
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const filePath = join(this.memoryRoot, entry.name);
      const read = await readTextIfExists(filePath);
      if (!read.exists) continue;
      refs.push(memdirRefFromFile(filePath, read.content));
    }
    return refs.filter((ref) => matchesFilter(ref, filter));
  }

  async readRef(ref: MemoryItemRef): Promise<MemoryBodySnapshot> {
    return readStorageBackedRef(ref, this.now);
  }

  async previewProposal(proposal: MemoryActionProposal): Promise<MemoryApplyPreview> {
    return proposal.preview;
  }

  async applyProposal(
    proposal: MemoryActionProposal,
    approval: MemoryApproval,
  ): Promise<MemoryApplyResult> {
    const proposalId = parseMemoryProposalId(proposal.id);
    if (proposalId === undefined) return skippedApply(proposal.id, 'invalid memory proposal id');
    if (!fingerprintsMatch(proposal.expectedFingerprints, approval.expectedFingerprints)) {
      return skippedApply(proposal.id, 'approval fingerprints do not match proposal preview');
    }
    const target = proposal.targetRefs.find((ref) => ref.kind === 'memdir' && ref.storageUri !== undefined);
    const indexRef = proposal.targetRefs.find((ref) => ref.id === 'memdir:MEMORY.md' && ref.storageUri !== undefined);
    if (target?.storageUri === undefined || indexRef?.storageUri === undefined) {
      return skippedApply(proposal.id, 'memory proposal has no memdir target');
    }
    const mutableRefs = [target, indexRef];
    const protectedRef = mutableRefs.find((ref) => isProtectedFromMutation(ref));
    if (protectedRef !== undefined) {
      return skippedApply(proposal.id, `${protectedRef.id} is not mutable by memory governance`);
    }
    const currentTarget = await readTextIfExists(target.storageUri);
    const currentIndex = await readTextIfExists(indexRef.storageUri);
    if (fingerprintOrMissing(currentTarget) !== proposal.expectedFingerprints[target.id]) {
      return skippedApply(proposal.id, 'target memory changed after preview');
    }
    if (fingerprintOrMissing(currentIndex) !== proposal.expectedFingerprints[indexRef.id]) {
      return skippedApply(proposal.id, 'MEMORY.md changed after preview');
    }
    const content = proposal.preview.diff ?? '';
    const indexLine = indexLineFromContent(target.storageUri, content);
    await writeFileAtomic(target.storageUri, content);
    await writeFileAtomic(indexRef.storageUri, prependIndexLine(currentIndex.content, indexLine));
    await updateLearningProposalStatus(
      this.learningStorePath,
      proposalId,
      'approved',
      {
        appliedAt: this.now(),
        appliedChangedPaths: [target.storageUri, indexRef.storageUri],
        now: this.now,
      },
    );
    return {
      proposalId: proposal.id,
      applied: true,
      changedRefs: proposal.targetRefs,
      changedPaths: [target.storageUri, indexRef.storageUri],
      warnings: [],
    };
  }
}

function defaultProjectDocs(cwd: string): readonly string[] {
  return [
    'README.md',
    'AGENTS.md',
    join('docs', 'PRD.md'),
    join('docs', 'ADR.md'),
    join('docs', 'HLD.md'),
    join('docs', 'DD.md'),
    join('docs', 'FEATURE_LIST.md'),
  ].map((item) => resolve(cwd, item));
}

function memoryProposalId(proposalId: string): string {
  return `memory:${proposalId}`;
}

function parseMemoryProposalId(id: string): string | undefined {
  return id.startsWith('memory:') ? id.slice('memory:'.length) : undefined;
}

function fingerprint(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function fingerprintOrMissing(read: ReadTextResult): string {
  return read.exists ? fingerprint(read.content) : MISSING_FINGERPRINT;
}

function lifecycleFromStatus(entry: StoredLearningProposal): MemoryItemRef['lifecycle'] {
  if (entry.status === 'pending') return 'pending';
  if (entry.status === 'approved') return 'trusted';
  return 'archived';
}

function learningRefFromEntry(entry: StoredLearningProposal): MemoryItemRef {
  const body = learningBody(entry);
  return {
    kind: 'learning_proposal',
    id: `learning_proposal:${entry.proposalId}`,
    scope: 'project',
    title: learningTitle(entry),
    owner: 'project',
    lifecycle: lifecycleFromStatus(entry),
    authority: 'proposal_only',
    visibility: 'prompt_safe',
    sourceRefs: learningSourceRefs(entry),
    relatedRefs: [],
    bodyFingerprint: fingerprint(body),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

function reasoningRefFromEntry(entry: StoredLearningProposal): MemoryItemRef {
  const title = entry.proposal.destination === 'reasoning_handoff'
    ? entry.proposal.title
    : entry.proposalId;
  const body = learningBody(entry);
  return {
    kind: 'reasoning_report',
    id: `reasoning_report:${entry.proposalId}`,
    scope: 'project',
    title,
    owner: 'project',
    lifecycle: lifecycleFromStatus(entry),
    authority: 'proposal_only',
    visibility: 'prompt_safe',
    sourceRefs: learningSourceRefs(entry),
    relatedRefs: [`learning_proposal:${entry.proposalId}`],
    bodyFingerprint: fingerprint(body),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

function sessionTraceRefFromEntry(sessionId: string, entry: KodaXSessionEntry): MemoryItemRef {
  const body = stringifyJson(entry);
  return {
    kind: 'session_trace',
    id: `session_trace:${sessionId}:${entry.id}`,
    scope: 'session',
    title: `Session ${entry.type}: ${entry.id}`,
    owner: 'project',
    lifecycle: 'provisional',
    authority: 'read_only',
    visibility: 'private',
    sourceRefs: [],
    relatedRefs: entry.parentId === null ? [] : [`session_trace:${sessionId}:${entry.parentId}`],
    version: '2',
    bodyFingerprint: fingerprint(body),
    createdAt: entry.timestamp,
    updatedAt: entry.timestamp,
  };
}

function artifactLedgerRefFromEntry(
  sessionId: string,
  entry: KodaXSessionArtifactLedgerEntry,
): MemoryItemRef {
  const body = stringifyJson(entry);
  return {
    kind: 'artifact_ledger',
    id: `artifact_ledger:${sessionId}:${entry.id}`,
    scope: 'session',
    title: entry.summary ?? entry.displayTarget ?? entry.target,
    owner: 'project',
    lifecycle: 'provisional',
    authority: 'read_only',
    visibility: 'prompt_safe',
    sourceRefs: entry.sessionEntryId === undefined
      ? []
      : [`session_trace:${sessionId}:${entry.sessionEntryId}`],
    relatedRefs: [],
    bodyFingerprint: fingerprint(body),
    createdAt: entry.timestamp,
    updatedAt: entry.timestamp,
  };
}

function parseScopedMemoryRefId(
  id: string,
  kind: 'session_trace' | 'artifact_ledger',
  sessionId: string,
): string {
  const prefix = `${kind}:${sessionId}:`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : '';
}

function learningTitle(entry: StoredLearningProposal): string {
  const proposal = entry.proposal;
  if (proposal.destination === 'memdir_handoff') return `${proposal.memoryKind} memory handoff`;
  if (proposal.destination === 'reasoning_handoff') return proposal.title;
  return proposal.proposalId;
}

function learningSourceRefs(entry: StoredLearningProposal): readonly string[] {
  const proposal = entry.proposal;
  if (proposal.destination === 'memdir_handoff') return proposal.metadata.sourceRefs;
  if (proposal.destination === 'reasoning_handoff') return proposal.sourceTraceIds;
  return [];
}

function learningBody(entry: StoredLearningProposal): string {
  const proposal = entry.proposal;
  if (proposal.destination === 'memdir_handoff') return proposal.body;
  if (proposal.destination === 'reasoning_handoff') return proposal.body;
  return JSON.stringify(proposal, null, 2);
}

function buildMemdirWritePlan(memoryRoot: string, handoff: MemoryLearningHandoff, proposalId: string): MemdirWritePlan {
  const memoryType = memoryTypeForHandoff(handoff.memoryKind);
  const title = titleFromBody(handoff.body, `${handoff.memoryKind} memory`);
  const description = firstSentence(handoff.body) || title;
  const filename = `${memoryType}_${slugify(title)}_${slugify(proposalId)}.md`;
  const targetPath = join(memoryRoot, filename);
  const content = [
    '---',
    `name: ${quoteScalar(title)}`,
    `description: ${quoteScalar(description)}`,
    `type: ${memoryType}`,
    '---',
    '',
    handoff.body.trim(),
    '',
  ].join('\n');
  return {
    targetPath,
    entrypointPath: join(memoryRoot, 'MEMORY.md'),
    content,
    indexLine: `- [${title}](${filename}) - ${description}`,
  };
}

async function buildMemdirTargetRef(
  targetPath: string,
  handoff: MemoryLearningHandoff,
  entry: StoredLearningProposal,
): Promise<MemoryItemRef> {
  const read = await readTextIfExists(targetPath);
  return {
    kind: 'memdir',
    id: `memdir:${basename(targetPath)}`,
    scope: handoff.memoryKind === 'user' ? 'user' : 'project',
    title: titleFromBody(handoff.body, `${handoff.memoryKind} memory`),
    owner: handoff.memoryKind === 'user' ? 'user' : 'project',
    lifecycle: read.exists ? 'active' : 'pending',
    authority: 'approved_write',
    visibility: 'prompt_safe',
    sourceRefs: [`learning_proposal:${entry.proposalId}`, ...handoff.metadata.sourceRefs],
    relatedRefs: [],
    bodyFingerprint: read.exists ? fingerprint(read.content) : MISSING_FINGERPRINT,
    storageUri: targetPath,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

async function buildEntrypointRef(entrypointPath: string): Promise<MemoryItemRef> {
  const read = await readTextIfExists(entrypointPath);
  return {
    kind: 'memdir',
    id: 'memdir:MEMORY.md',
    scope: 'project',
    title: 'MEMORY.md',
    owner: 'project',
    lifecycle: read.exists ? 'active' : 'pending',
    authority: 'approved_write',
    visibility: 'prompt_safe',
    sourceRefs: [],
    relatedRefs: [],
    bodyFingerprint: read.exists ? fingerprint(read.content) : MISSING_FINGERPRINT,
    storageUri: entrypointPath,
  };
}

function memdirRefFromFile(filePath: string, content: string): MemoryItemRef {
  const parsed = parseMemoryFile(content);
  const filename = basename(filePath);
  const memoryType = parsed.frontmatter.type;
  return {
    kind: 'memdir',
    id: `memdir:${filename}`,
    scope: memoryType === 'user' ? 'user' : 'project',
    title: parsed.frontmatter.name ?? filename,
    owner: memoryType === 'user' ? 'user' : 'project',
    lifecycle: 'active',
    authority: filename === 'MEMORY.md' ? 'read_only' : 'approved_write',
    visibility: 'prompt_safe',
    sourceRefs: [],
    relatedRefs: [],
    bodyFingerprint: fingerprint(content),
    storageUri: filePath,
  };
}

function memoryTypeForHandoff(kind: MemoryLearningHandoff['memoryKind']): MemoryType {
  if (kind === 'user' || kind === 'feedback' || kind === 'project' || kind === 'reference') return kind;
  return 'project';
}

function titleFromBody(body: string, fallback: string): string {
  const first = body.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0);
  if (first === undefined) return fallback;
  return first.replace(/^#+\s*/, '').slice(0, 80) || fallback;
}

function firstSentence(body: string): string | undefined {
  const compact = body.replace(/\s+/g, ' ').trim();
  if (compact.length === 0) return undefined;
  const sentenceEnd = compact.search(/[.!?。！？]/);
  const value = sentenceEnd >= 0 ? compact.slice(0, sentenceEnd + 1) : compact;
  return value.slice(0, 160);
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return slug.length > 0 ? slug : 'memory';
}

function quoteScalar(value: string): string {
  return JSON.stringify(value.replace(/\r?\n/g, ' '));
}

function indexLineFromContent(filePath: string, content: string): string {
  const parsed = parseMemoryFile(content);
  const title = parsed.frontmatter.name ?? basename(filePath, '.md');
  const description = parsed.frontmatter.description ?? title;
  return `- [${title}](${basename(filePath)}) - ${description}`;
}

function prependIndexLine(current: string, line: string): string {
  const trimmed = current.trimEnd();
  if (trimmed.split(/\r?\n/).includes(line)) return `${trimmed}\n`;
  return trimmed.length > 0 ? `${line}\n${trimmed}\n` : `${line}\n`;
}

async function readTextIfExists(filePath: string): Promise<ReadTextResult> {
  try {
    return { exists: true, content: await readFile(filePath, 'utf8') };
  } catch (error) {
    if (isMissingFile(error)) return { exists: false, content: '' };
    throw error;
  }
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = join(dirname(filePath), `.${basename(filePath)}.kodax-${process.pid}-${Date.now().toString(36)}.tmp`);
  try {
    await writeFile(tempPath, content, 'utf8');
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

async function readStorageBackedRef(
  ref: MemoryItemRef,
  now: () => string,
): Promise<MemoryBodySnapshot> {
  if (ref.storageUri === undefined) {
    return {
      ref,
      body: '',
      bodyFingerprint: fingerprint(''),
      readAt: now(),
      warnings: ['memory ref has no storageUri'],
    };
  }
  const read = await readTextIfExists(ref.storageUri);
  if (!read.exists) {
    return {
      ref,
      body: '',
      bodyFingerprint: fingerprint(''),
      readAt: now(),
      warnings: [`memory ref storage does not exist: ${ref.storageUri}`],
    };
  }
  const parsed = ref.kind === 'memdir' ? parseMemoryFile(read.content) : undefined;
  return {
    ref: { ...ref, bodyFingerprint: fingerprint(read.content) },
    body: read.content,
    bodyFingerprint: fingerprint(read.content),
    ...(parsed !== undefined ? { frontmatter: frontmatterRecord(parsed.frontmatter) } : {}),
    readAt: now(),
    warnings: [],
  };
}

function frontmatterRecord(frontmatter: {
  readonly name: string | undefined;
  readonly description: string | undefined;
  readonly type: string | undefined;
}): Readonly<Record<string, string>> {
  const fields: Record<string, string> = {};
  if (frontmatter.name !== undefined) fields.name = frontmatter.name;
  if (frontmatter.description !== undefined) fields.description = frontmatter.description;
  if (frontmatter.type !== undefined) fields.type = frontmatter.type;
  return fields;
}

function matchesFilter(ref: MemoryItemRef, filter: MemoryRefFilter): boolean {
  if (filter.kinds !== undefined && !filter.kinds.includes(ref.kind)) return false;
  if (filter.scopes !== undefined && !filter.scopes.includes(ref.scope)) return false;
  if (filter.lifecycles !== undefined && !filter.lifecycles.includes(ref.lifecycle)) return false;
  if (ref.visibility === 'private' && filter.includePrivate !== true) return false;
  if (ref.visibility === 'sensitive' && filter.includeSensitive !== true) return false;
  if (filter.query !== undefined && !refMatchesQuery(ref, filter.query)) return false;
  return true;
}

function refMatchesQuery(ref: MemoryItemRef, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return [
    ref.id,
    ref.title ?? '',
    ref.kind,
    ref.scope,
    ref.owner,
    ...ref.sourceRefs,
    ...ref.relatedRefs,
  ].some((value) => value.toLowerCase().includes(needle));
}

function buildGovernanceFindings(refs: readonly MemoryItemRef[]): readonly MemoryGovernanceFinding[] {
  const findings: MemoryGovernanceFinding[] = [];
  findings.push(...duplicateFingerprintFindings(refs));
  findings.push(...conflictTitleFindings(refs));
  findings.push(...orphanedRefFindings(refs));
  for (const ref of refs) {
    if (ref.lifecycle === 'stale') {
      findings.push({
        kind: 'stale',
        severity: 'warning',
        refIds: [ref.id],
        summary: `${ref.id} is stale and excluded from normal memory packs.`,
        suggestedAction: 'archive',
      });
    }
    if (ref.lifecycle === 'quarantined') {
      findings.push({
        kind: 'quarantined',
        severity: 'warning',
        refIds: [ref.id],
        summary: `${ref.id} is quarantined and requires manual review.`,
        suggestedAction: 'conflict_report',
      });
    }
  }
  return findings;
}

function duplicateFingerprintFindings(refs: readonly MemoryItemRef[]): readonly MemoryGovernanceFinding[] {
  const groups = new Map<string, string[]>();
  for (const ref of refs) {
    if (ref.bodyFingerprint === undefined || ref.lifecycle === 'archived') continue;
    const group = groups.get(ref.bodyFingerprint) ?? [];
    group.push(ref.id);
    groups.set(ref.bodyFingerprint, group);
  }
  return Array.from(groups.entries())
    .filter(([, ids]) => ids.length > 1)
    .map(([fingerprintValue, ids]) => ({
      kind: 'duplicate',
      severity: 'warning',
      refIds: ids,
      summary: `Multiple refs share ${fingerprintValue}.`,
      suggestedAction: 'conflict_report',
    }));
}

function conflictTitleFindings(refs: readonly MemoryItemRef[]): readonly MemoryGovernanceFinding[] {
  const groups = new Map<string, MemoryItemRef[]>();
  for (const ref of refs) {
    const title = normalizeConflictTitle(ref.title);
    if (title === undefined || ref.bodyFingerprint === undefined || ref.lifecycle === 'archived') continue;
    const group = groups.get(title) ?? [];
    group.push(ref);
    groups.set(title, group);
  }
  return Array.from(groups.entries())
    .flatMap(([title, group]) => {
      const fingerprints = new Set(group.map((ref) => ref.bodyFingerprint));
      if (group.length < 2 || fingerprints.size <= 1) return [];
      return [{
        kind: 'conflict',
        severity: 'warning',
        refIds: group.map((ref) => ref.id),
        summary: `Multiple refs use the title "${title}" with different fingerprints.`,
        suggestedAction: 'conflict_report',
      } satisfies MemoryGovernanceFinding];
    });
}

function orphanedRefFindings(refs: readonly MemoryItemRef[]): readonly MemoryGovernanceFinding[] {
  const ids = new Set(refs.map((ref) => ref.id));
  return refs.flatMap((ref) => {
    const missing = ref.relatedRefs.filter((id) => isMemoryControlledRefId(id) && !ids.has(id));
    if (missing.length === 0) return [];
    return [{
      kind: 'orphaned',
      severity: 'warning',
      refIds: [ref.id, ...missing],
      summary: `${ref.id} points to missing memory ref(s): ${missing.join(', ')}.`,
      suggestedAction: 'conflict_report',
    } satisfies MemoryGovernanceFinding];
  });
}

function normalizeConflictTitle(title: string | undefined): string | undefined {
  const normalized = title?.trim().toLowerCase().replace(/\s+/g, ' ');
  return normalized !== undefined && normalized.length > 0 ? normalized : undefined;
}

function isMemoryControlledRefId(id: string): boolean {
  return /^(learning_proposal|reasoning_report|memdir|session_trace|artifact_ledger|skill|project_doc|self_manual|workflow_run|working_context):/.test(id);
}

function isProtectedFromMutation(ref: MemoryItemRef): boolean {
  return ref.authority === 'read_only' || ref.scope === 'builtin' || ref.pinned === true;
}

function isPackEligible(ref: MemoryItemRef, input: MemoryPackInput): boolean {
  if (ref.visibility === 'private' && input.includePrivate !== true) return false;
  if (ref.visibility === 'sensitive' && input.includeSensitive !== true) return false;
  if (ref.authority === 'proposal_only') return false;
  return ref.lifecycle === 'trusted' || ref.lifecycle === 'active' || ref.lifecycle === 'readonly';
}

function shouldIgnoreMemory(task: string): boolean {
  return /\b(ignore|do not use|don't use|without)\s+(project\s+)?memory\b/i.test(task);
}

function scoreRef(ref: MemoryItemRef, task: string): number {
  const taskLower = task.toLowerCase();
  const title = ref.title?.toLowerCase() ?? '';
  let score = 0;
  if (ref.pinned === true) score += 50;
  if (ref.scope === 'project') score += 20;
  if (ref.scope === 'user') score += 10;
  if (ref.lifecycle === 'trusted' || ref.lifecycle === 'readonly') score += 10;
  if (title.length > 0 && taskLower.includes(title)) score += 30;
  for (const token of title.split(/[^a-z0-9]+/).filter((entry) => entry.length >= 3)) {
    if (taskLower.includes(token)) score += 3;
  }
  return score;
}

function packReason(ref: MemoryItemRef, task: string): string {
  const title = ref.title ?? ref.id;
  return task.toLowerCase().includes(title.toLowerCase())
    ? 'Exact task/title overlap.'
    : `${ref.scope} ${ref.kind} is eligible for deterministic recall.`;
}

function firstSnippet(body: string): string {
  const compact = body.replace(/\s+/g, ' ').trim();
  return compact.slice(0, 240);
}

function stringifyJson(value: KodaXSessionEntry | KodaXSessionArtifactLedgerEntry): string {
  return JSON.stringify(value, null, 2);
}

function fingerprintsMatch(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

function skippedApply(proposalId: string, skippedReason: string): MemoryApplyResult {
  return {
    proposalId,
    applied: false,
    changedRefs: [],
    changedPaths: [],
    skippedReason,
    warnings: [],
  };
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
