export type MemoryRefKind =
  | 'working_context'
  | 'session_trace'
  | 'artifact_ledger'
  | 'learning_proposal'
  | 'memdir'
  | 'skill'
  | 'workflow_run'
  | 'reasoning_report'
  | 'self_manual'
  | 'project_doc';

export type MemoryScope = 'turn' | 'session' | 'project' | 'user' | 'builtin';

export type MemoryLifecycle =
  | 'pending'
  | 'active'
  | 'provisional'
  | 'trusted'
  | 'stale'
  | 'quarantined'
  | 'archived'
  | 'readonly';

export type MemoryAuthority =
  | 'read_only'
  | 'proposal_only'
  | 'approved_write';

export type MemoryVisibility =
  | 'prompt_safe'
  | 'private'
  | 'sensitive';

export interface MemoryItemRef {
  readonly kind: MemoryRefKind;
  readonly id: string;
  readonly scope: MemoryScope;
  readonly title?: string;
  readonly owner: 'user' | 'project' | 'kodax' | 'external';
  readonly lifecycle: MemoryLifecycle;
  readonly authority: MemoryAuthority;
  readonly visibility: MemoryVisibility;
  readonly sourceRefs: readonly string[];
  readonly relatedRefs: readonly string[];
  readonly version?: string;
  readonly bodyFingerprint?: string;
  readonly storageUri?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly lastUsedAt?: string;
  readonly pinned?: boolean;
}

export interface MemoryRefFilter {
  readonly kinds?: readonly MemoryRefKind[];
  readonly scopes?: readonly MemoryScope[];
  readonly lifecycles?: readonly MemoryLifecycle[];
  readonly includePrivate?: boolean;
  readonly includeSensitive?: boolean;
  readonly query?: string;
}

export interface MemoryBodySnapshot {
  readonly ref: MemoryItemRef;
  readonly body: string;
  readonly bodyFingerprint: string;
  readonly frontmatter?: Readonly<Record<string, string>>;
  readonly readAt: string;
  readonly warnings: readonly string[];
}

export type MemoryProposalAction =
  | 'no_op'
  | 'link_refs'
  | 'write_memdir'
  | 'patch_memdir'
  | 'handoff_to_skill_loop'
  | 'quarantine'
  | 'archive'
  | 'conflict_report';

export interface MemoryApplyPreview {
  readonly summary: string;
  readonly changedRefs: readonly MemoryItemRef[];
  readonly changedPaths: readonly string[];
  readonly beforeFingerprints: Readonly<Record<string, string>>;
  readonly afterFingerprints?: Readonly<Record<string, string>>;
  readonly diff?: string;
  readonly warnings: readonly string[];
}

export interface MemoryActionProposal {
  readonly id: string;
  readonly action: MemoryProposalAction;
  readonly targetRefs: readonly MemoryItemRef[];
  readonly sourceRefs: readonly MemoryItemRef[];
  readonly expectedFingerprints: Readonly<Record<string, string>>;
  readonly rationale: string;
  readonly risk: 'low' | 'medium' | 'high';
  readonly preview: MemoryApplyPreview;
  readonly requiresApproval: true;
  readonly createdAt: string;
}

export interface MemoryApproval {
  readonly proposalId: string;
  readonly approvedBy: 'user' | 'host';
  readonly approvedAt: string;
  readonly expectedFingerprints: Readonly<Record<string, string>>;
}

export interface MemoryApplyResult {
  readonly proposalId: string;
  readonly applied: boolean;
  readonly changedRefs: readonly MemoryItemRef[];
  readonly changedPaths: readonly string[];
  readonly skippedReason?: string;
  readonly warnings: readonly string[];
}

export interface MemorySourceAdapter {
  readonly kind: MemoryRefKind;
  listRefs(filter?: MemoryRefFilter): Promise<readonly MemoryItemRef[]>;
  readRef(ref: MemoryItemRef): Promise<MemoryBodySnapshot>;
  previewProposal(proposal: MemoryActionProposal): Promise<MemoryApplyPreview>;
  applyProposal(
    proposal: MemoryActionProposal,
    approval: MemoryApproval,
  ): Promise<MemoryApplyResult>;
}

export interface MemoryCuratorInput {
  readonly includePrivate?: boolean;
  readonly includeSensitive?: boolean;
}

export interface MemoryAutoCuratorInput extends MemoryCuratorInput {
  readonly enabled?: boolean;
  readonly intervalMs?: number;
  readonly minRefs?: number;
}

export type MemoryAutoCuratorSkipReason =
  | 'disabled'
  | 'not_due'
  | 'insufficient_refs';

export interface MemoryAutoCuratorResult {
  readonly ran: boolean;
  readonly skippedReason?: MemoryAutoCuratorSkipReason;
  readonly report?: MemoryGovernanceReport;
  readonly reportPath?: string;
  readonly nextEligibleAt?: string;
}

export type MemoryGovernanceFindingKind =
  | 'duplicate'
  | 'conflict'
  | 'stale'
  | 'quarantined'
  | 'orphaned'
  | 'no_op';

export interface MemoryGovernanceFinding {
  readonly kind: MemoryGovernanceFindingKind;
  readonly severity: 'info' | 'warning' | 'error';
  readonly refIds: readonly string[];
  readonly summary: string;
  readonly suggestedAction: MemoryProposalAction;
}

export interface MemoryGovernanceReport {
  readonly reportId: string;
  readonly generatedAt: string;
  readonly findings: readonly MemoryGovernanceFinding[];
  readonly warnings: readonly string[];
}

export interface MemoryPackInput {
  readonly task: string;
  readonly maxHints?: number;
  readonly includePrivate?: boolean;
  readonly includeSensitive?: boolean;
  readonly includeSnippets?: boolean;
  readonly ignoreMemory?: boolean;
}

export interface MemoryPackHint {
  readonly ref: MemoryItemRef;
  readonly hook: string;
  readonly reason: string;
  readonly bodySnippet?: string;
  readonly bodyFingerprint?: string;
}

export interface MemoryPack {
  readonly generatedAt: string;
  readonly taskFingerprint: string;
  readonly hints: readonly MemoryPackHint[];
  readonly omitted: readonly string[];
  readonly traceMetadata: MemoryPackTraceMetadata;
}

export interface MemoryPackTraceMetadata {
  readonly selectedRefIds: readonly string[];
  readonly omittedRefIds: readonly string[];
  readonly taskFingerprint: string;
  readonly suppressed: boolean;
}

export interface MemoryController {
  listInbox(): Promise<readonly MemoryActionProposal[]>;
  showProposal(id: string): Promise<MemoryActionProposal | undefined>;
  approveProposal(
    id: string,
    expectedFingerprints?: Readonly<Record<string, string>>,
  ): Promise<MemoryApplyResult>;
  rejectProposal(id: string, reason?: string): Promise<void>;
  listRefs(filter?: MemoryRefFilter): Promise<readonly MemoryItemRef[]>;
  readRef(ref: MemoryItemRef): Promise<MemoryBodySnapshot>;
  runCurator(input?: MemoryCuratorInput): Promise<MemoryGovernanceReport>;
  maybeRunAutoCurator(input?: MemoryAutoCuratorInput): Promise<MemoryAutoCuratorResult>;
  buildMemoryPack(input: MemoryPackInput): Promise<MemoryPack>;
}

export type MemoryEvent =
  | { readonly type: 'proposal.created'; readonly proposalId: string }
  | { readonly type: 'proposal.approved'; readonly proposalId: string }
  | { readonly type: 'proposal.rejected'; readonly proposalId: string }
  | { readonly type: 'curator.completed'; readonly reportId: string }
  | { readonly type: 'pack.selected'; readonly refIds: readonly string[] };
