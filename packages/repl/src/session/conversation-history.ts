import {
  forkSessionLineage,
  getSessionLineagePath,
} from '@kodax-ai/agent';
import type {
  KodaXMessage,
  KodaXSessionCompactionEntry,
  KodaXSessionEntry,
  KodaXSessionLineage,
  KodaXSessionMessageEntry,
} from '@kodax-ai/agent';

export type SessionConversationHistoryStatus =
  | 'resolved'
  | 'partial'
  | 'ambiguous';

export type SessionConversationHistoryIssueCode =
  | 'active_entry_missing'
  | 'compaction_boundary_invalid'
  | 'compaction_predecessor_ambiguous'
  | 'compaction_predecessor_missing'
  | 'legacy_overlap_ambiguous'
  | 'lineage_path_incomplete'
  | 'lineage_unavailable'
  | 'logical_identity_conflict';

export interface SessionConversationHistoryIssue {
  readonly code: SessionConversationHistoryIssueCode;
  readonly message: string;
  /** Number of diagnostics of this code represented by this bounded summary. */
  readonly occurrenceCount: number;
  /** Total evidence references before `entryIds` was bounded. */
  readonly entryCount: number;
  readonly entryIds: readonly string[];
}

/**
 * One SDK-resolved conversation item. `auditEntryIds` names every proven
 * physical copy represented by it; raw bodies remain in the audit API.
 */
export interface SessionConversationHistoryEntry {
  readonly boundaryId?: string;
  readonly auditEntryIds: readonly string[];
  readonly message: KodaXMessage;
}

export interface SessionConversationHistoryData {
  readonly sourceRevision: string;
  readonly status: SessionConversationHistoryStatus;
  readonly entries: readonly SessionConversationHistoryEntry[];
  readonly issues: readonly SessionConversationHistoryIssue[];
}

interface ThreadPath {
  readonly entries: readonly KodaXSessionEntry[];
  readonly complete: boolean;
}

interface ConversationEpoch {
  readonly root: KodaXSessionEntry;
  readonly messages: readonly KodaXSessionMessageEntry[];
}

interface CompactionPredecessorCandidate {
  readonly leaf: KodaXSessionEntry;
  readonly path: ThreadPath;
}

interface MutableConversationEntry {
  readonly index: number;
  readonly source: KodaXSessionMessageEntry;
  readonly auditEntryIds: string[];
}

type PendingConversationHistoryIssue = Omit<
  SessionConversationHistoryIssue,
  'occurrenceCount' | 'entryCount'
>;

const MAX_CONVERSATION_ISSUE_ENTRY_IDS = 16;
const MAX_CONVERSATION_ISSUE_EVIDENCE_BYTES = 4 * 1024;
const MAX_CONVERSATION_ISSUE_MESSAGE_LENGTH = 512;

function isThreadEntry(entry: KodaXSessionEntry): boolean {
  return entry.type === 'message'
    || entry.type === 'compaction'
    || entry.type === 'branch_summary';
}

function threadPath(
  targetId: string,
  entriesById: ReadonlyMap<string, KodaXSessionEntry>,
  checkpoint?: () => void,
): ThreadPath {
  const reversed: KodaXSessionEntry[] = [];
  const visited = new Set<string>();
  let current = entriesById.get(targetId);
  let complete = current !== undefined;
  let visitedCount = 0;
  while (current !== undefined) {
    if (visitedCount % 256 === 0) checkpoint?.();
    visitedCount += 1;
    if (visited.has(current.id)) {
      complete = false;
      break;
    }
    visited.add(current.id);
    reversed.push(current);
    if (current.parentId === null) break;
    const parent = entriesById.get(current.parentId);
    if (parent === undefined) complete = false;
    current = parent;
  }
  return { entries: reversed.reverse(), complete };
}

function hasExplicitProvenance(entry: KodaXSessionMessageEntry): boolean {
  return explicitProvenanceKeys(entry).length > 0;
}

function explicitProvenanceKeys(entry: KodaXSessionMessageEntry): string[] {
  return [...new Set([
    ...(entry.logicalId !== undefined && entry.logicalId !== entry.id
      ? [entry.logicalId]
      : []),
    ...(entry.sourceEntryId !== undefined && entry.sourceEntryId !== entry.id
      ? [entry.sourceEntryId]
      : []),
  ])];
}

function provenanceMatches(
  prior: KodaXSessionMessageEntry,
  copy: KodaXSessionMessageEntry,
): boolean {
  const priorKeys = new Set([prior.id, prior.logicalId, prior.sourceEntryId]);
  return explicitProvenanceKeys(copy).every((key) => priorKeys.has(key));
}

function retainedSuffixMatches(
  prior: readonly KodaXSessionMessageEntry[],
  current: readonly KodaXSessionMessageEntry[],
  checkpoint?: () => void,
): boolean {
  const firstExplicitIndex = current.findIndex(hasExplicitProvenance);
  if (firstExplicitIndex < 0) {
    return prefixSuffixOverlapLengths(
      prior.slice(-current.length)
        .map((entry) => messageFingerprint(entry.message)),
      current.map((entry) => messageFingerprint(entry.message)),
      checkpoint,
    ).length > 0;
  }
  const minStart = Math.max(0, prior.length - current.length);
  return prior.some((entry, priorIndex) => {
    if (priorIndex % 256 === 0) checkpoint?.();
    const start = priorIndex - firstExplicitIndex;
    if (
      start < minStart
      || !provenanceMatches(entry, current[firstExplicitIndex]!)
    ) {
      return false;
    }
    return prior.slice(start).every((candidate, index) => {
      const copy = current[index]!;
      return hasExplicitProvenance(copy)
        ? provenanceMatches(candidate, copy)
        : messagesEqual(candidate.message, copy.message);
    });
  });
}

function compactionPredecessorCandidates(
  priorEntries: readonly KodaXSessionEntry[],
  root: KodaXSessionCompactionEntry,
  currentMessages: readonly KodaXSessionMessageEntry[],
  issues: PendingConversationHistoryIssue[],
  checkpoint?: () => void,
): CompactionPredecessorCandidate[] {
  const priorThreadEntries = priorEntries.filter(isThreadEntry);
  const entriesById = new Map(priorThreadEntries.map((entry) => [entry.id, entry]));
  const appendIndex = new Map(
    priorThreadEntries.map((entry, index) => [entry.id, index]),
  );
  const parents = new Set(priorThreadEntries.flatMap((entry) =>
    entry.parentId === null ? [] : [entry.parentId]));
  const candidates = priorThreadEntries
    .filter((entry) => !parents.has(entry.id))
    .map((leaf) => ({ leaf, path: threadPath(leaf.id, entriesById, checkpoint) }));
  const incomplete = candidates.filter((candidate) => !candidate.path.complete);
  if (incomplete.length > 0) {
    issues.push({
      code: 'lineage_path_incomplete',
      message: `A candidate predecessor path for compaction ${root.id} is incomplete.`,
      entryIds: [root.id, ...incomplete.map((candidate) => candidate.leaf.id)],
    });
    return [];
  }
  const outOfOrder = candidates.filter((candidate) =>
    !isAppendOrderedPriorPath(candidate.path, priorThreadEntries.length, appendIndex));
  if (outOfOrder.length > 0) {
    issues.push({
      code: 'lineage_path_incomplete',
      message: `A candidate predecessor path for compaction ${root.id} is not append ordered.`,
      entryIds: [root.id, ...outOfOrder.map((candidate) => candidate.leaf.id)],
    });
    return [];
  }
  if (root.firstKeptEntryId === undefined) return candidates;
  if (currentMessages[0]?.id !== root.firstKeptEntryId) {
    issues.push({
      code: 'compaction_boundary_invalid',
      message: `Compaction ${root.id} does not identify its first retained message.`,
      entryIds: [root.id, root.firstKeptEntryId],
    });
    return [];
  }

  const matches = candidates.filter((candidate) => {
    const messages = candidate.path.entries.filter(
      (entry): entry is KodaXSessionMessageEntry => entry.type === 'message',
    );
    return retainedSuffixMatches(messages, currentMessages, checkpoint);
  });
  if (matches.length === 0 && candidates.length > 0) {
    issues.push({
      code: 'compaction_boundary_invalid',
      message: `Compaction ${root.id} retained suffix conflicts with every predecessor branch.`,
      entryIds: [root.id, ...currentMessages.map((entry) => entry.id)],
    });
  }
  return matches;
}

function resolveCompactionPredecessor(
  priorEntries: readonly KodaXSessionEntry[],
  root: KodaXSessionCompactionEntry,
  currentMessages: readonly KodaXSessionMessageEntry[],
  issues: PendingConversationHistoryIssue[],
  checkpoint?: () => void,
): KodaXSessionEntry | undefined {
  const candidates = compactionPredecessorCandidates(
    priorEntries,
    root,
    currentMessages,
    issues,
    checkpoint,
  );
  const unique = [...new Map(candidates.map((candidate) => [
    candidate.leaf.id,
    candidate.leaf,
  ])).values()];
  if (unique.length === 1) return unique[0];
  issues.push({
    code: unique.length === 0
      ? 'compaction_predecessor_missing'
      : 'compaction_predecessor_ambiguous',
    message: unique.length === 0
      ? `No topology-proven predecessor was retained for compaction ${root.id}.`
      : `Compaction ${root.id} has multiple possible predecessor branches.`,
    entryIds: [root.id, ...unique.map((entry) => entry.id)],
  });
  return undefined;
}

function leadingExplicitRetainedCopies(
  root: KodaXSessionCompactionEntry,
  currentMessages: readonly KodaXSessionMessageEntry[],
): readonly KodaXSessionMessageEntry[] {
  if (currentMessages[0]?.id !== root.firstKeptEntryId) return [];
  const firstNonExplicit = currentMessages.findIndex(
    (entry) => !hasExplicitProvenance(entry),
  );
  const prefixLength = firstNonExplicit < 0
    ? currentMessages.length
    : firstNonExplicit;
  if (
    prefixLength === 0
    || currentMessages.slice(prefixLength).some(hasExplicitProvenance)
  ) {
    return [];
  }
  return currentMessages.slice(0, prefixLength);
}

function isAppendOrderedPriorPath(
  path: ThreadPath,
  rootIndex: number,
  appendIndex: ReadonlyMap<string, number>,
): boolean {
  let previousIndex = -1;
  for (const entry of path.entries) {
    const index = appendIndex.get(entry.id);
    if (
      index === undefined
      || index >= rootIndex
      || index <= previousIndex
    ) {
      return false;
    }
    previousIndex = index;
  }
  return true;
}

function explicitCompactionPredecessorCandidates(
  root: KodaXSessionCompactionEntry,
  currentMessages: readonly KodaXSessionMessageEntry[],
  rootIndex: number,
  entriesById: ReadonlyMap<string, KodaXSessionEntry>,
  appendIndex: ReadonlyMap<string, number>,
  messagesByIdentity: ReadonlyMap<string, readonly KodaXSessionMessageEntry[]>,
  checkpoint?: () => void,
): KodaXSessionMessageEntry[] {
  const retainedCopies = leadingExplicitRetainedCopies(root, currentMessages);
  const lastCopy = retainedCopies.at(-1);
  const lookupKey = lastCopy === undefined
    ? undefined
    : explicitProvenanceKeys(lastCopy)[0];
  if (lastCopy === undefined || lookupKey === undefined) return [];
  const matches: KodaXSessionMessageEntry[] = [];
  for (const candidate of messagesByIdentity.get(lookupKey) ?? []) {
    checkpoint?.();
    if ((appendIndex.get(candidate.id) ?? Number.MAX_SAFE_INTEGER) >= rootIndex) {
      continue;
    }
    const path = threadPath(candidate.id, entriesById, checkpoint);
    const priorMessages = path.entries.filter(
      (entry): entry is KodaXSessionMessageEntry => entry.type === 'message',
    );
    const suffix = priorMessages.slice(-retainedCopies.length);
    if (
      path.complete
      && isAppendOrderedPriorPath(path, rootIndex, appendIndex)
      && suffix.length === retainedCopies.length
      && suffix.every((entry, index) => {
        const copy = retainedCopies[index]!;
        return provenanceMatches(entry, copy)
          && messagesEqual(entry.message, copy.message);
      })
    ) {
      matches.push(candidate);
    }
  }
  return [...new Map(matches.map((entry) => [entry.id, entry])).values()];
}

function indexMessagesByIdentity(
  entries: readonly KodaXSessionEntry[],
): ReadonlyMap<string, readonly KodaXSessionMessageEntry[]> {
  const result = new Map<string, KodaXSessionMessageEntry[]>();
  for (const entry of entries) {
    if (entry.type !== 'message') continue;
    for (const key of new Set([entry.id, entry.logicalId, entry.sourceEntryId])) {
      if (key === undefined) continue;
      const matches = result.get(key) ?? [];
      matches.push(entry);
      result.set(key, matches);
    }
  }
  return result;
}

function conversationEpochs(
  lineage: KodaXSessionLineage,
  issues: PendingConversationHistoryIssue[],
  checkpoint?: () => void,
): ConversationEpoch[] {
  const threadEntries = lineage.entries.filter(isThreadEntry);
  if (
    lineage.activeEntryId === null
    && threadEntries.some((entry) => entry.type === 'message')
  ) {
    issues.push({
      code: 'active_entry_missing',
      message: 'Conversation lineage contains messages but has no active entry.',
      entryIds: threadEntries
        .filter((entry) => entry.type === 'message')
        .map((entry) => entry.id),
    });
    return [];
  }
  const entriesById = new Map(threadEntries.map((entry) => [entry.id, entry]));
  const appendIndex = new Map(lineage.entries.map((entry, index) => [entry.id, index]));
  const messagesByIdentity = indexMessagesByIdentity(threadEntries);
  const priorEpochStartByCompactionId = new Map<string, number>();
  let epochStart = 0;
  for (let index = 0; index < lineage.entries.length; index += 1) {
    const entry = lineage.entries[index]!;
    if (entry.type === 'compaction' && entry.parentId === null) {
      priorEpochStartByCompactionId.set(entry.id, epochStart);
      epochStart = index;
    }
  }
  const epochs: ConversationEpoch[] = [];
  const visitedRoots = new Set<string>();
  let path = lineage.activeEntryId === null
    ? { entries: [], complete: true }
    : threadPath(lineage.activeEntryId, entriesById, checkpoint);

  while (path.entries.length > 0) {
    const root = path.entries[0]!;
    if (visitedRoots.has(root.id)) {
      path = { entries: [], complete: false };
      break;
    }
    visitedRoots.add(root.id);
    const currentMessages = path.entries.filter(
      (entry): entry is KodaXSessionMessageEntry => entry.type === 'message',
    );
    epochs.push({
      root,
      messages: currentMessages,
    });
    if (root.type !== 'compaction' || root.reason === 'rewind') break;
    const rootIndex = appendIndex.get(root.id) ?? 0;
    const priorEpochStart = priorEpochStartByCompactionId.get(root.id) ?? 0;
    const predecessorIssues: PendingConversationHistoryIssue[] = [];
    let predecessor = resolveCompactionPredecessor(
      lineage.entries.slice(priorEpochStart, rootIndex),
      root,
      currentMessages,
      predecessorIssues,
      checkpoint,
    );
    if (predecessor === undefined) {
      const explicitCandidates = explicitCompactionPredecessorCandidates(
        root,
        currentMessages,
        rootIndex,
        entriesById,
        appendIndex,
        messagesByIdentity,
        checkpoint,
      );
      if (explicitCandidates.length === 1) {
        [predecessor] = explicitCandidates;
      } else {
        issues.push(...predecessorIssues);
        if (explicitCandidates.length > 1) {
          issues.push({
            code: 'compaction_predecessor_ambiguous',
            message: `Compaction ${root.id} provenance identifies multiple predecessor copies.`,
            entryIds: [root.id, ...explicitCandidates.map((entry) => entry.id)],
          });
        }
      }
    }
    if (predecessor === undefined) {
      break;
    }
    path = threadPath(predecessor.id, entriesById, checkpoint);
  }

  if (!path.complete) {
    issues.push({
      code: 'lineage_path_incomplete',
      message: 'Conversation lineage contains a missing parent or parent cycle.',
      entryIds: path.entries.map((entry) => entry.id),
    });
  }
  return epochs.reverse();
}

function messageFingerprint(message: KodaXMessage): string {
  return JSON.stringify([
    message.role,
    message.content,
    message._synthetic === true,
    message._source,
    message._taskResult,
    message._taskResults,
  ]);
}

/** All non-empty suffix lengths of `prior` that equal a prefix of `current`. */
function prefixSuffixOverlapLengths(
  prior: readonly string[],
  current: readonly string[],
  checkpoint?: () => void,
): number[] {
  if (prior.length === 0 || current.length === 0) return [];
  const relevantPrior = prior.slice(Math.max(0, prior.length - current.length));
  const values: Array<string | undefined> = [
    ...current,
    undefined,
    ...relevantPrior,
  ];
  const prefixLengths = new Array<number>(values.length).fill(0);
  for (let index = 1; index < values.length; index += 1) {
    if (index % 256 === 0) checkpoint?.();
    let length = prefixLengths[index - 1]!;
    while (length > 0 && values[index] !== values[length]) {
      length = prefixLengths[length - 1]!;
    }
    if (values[index] === values[length]) length += 1;
    prefixLengths[index] = Math.min(length, current.length);
  }
  const overlaps: number[] = [];
  let length = prefixLengths.at(-1) ?? 0;
  while (length > 0) {
    overlaps.push(length);
    length = prefixLengths[length - 1] ?? 0;
  }
  return overlaps;
}

function messagesEqual(left: KodaXMessage, right: KodaXMessage): boolean {
  return left === right || messageFingerprint(left) === messageFingerprint(right);
}

function logicalIdentity(entry: KodaXSessionMessageEntry): string {
  return entry.logicalId ?? entry.id;
}

function explicitPriorGroups(
  entry: KodaXSessionMessageEntry,
  groupsByIdentity: ReadonlyMap<string, MutableConversationEntry>,
): readonly MutableConversationEntry[] {
  return explicitPriorGroupResolution(entry, groupsByIdentity).groups;
}

function explicitPriorGroupResolution(
  entry: KodaXSessionMessageEntry,
  groupsByIdentity: ReadonlyMap<string, MutableConversationEntry>,
): {
  readonly keys: readonly string[];
  readonly groups: readonly MutableConversationEntry[];
  readonly unresolvedKeys: readonly string[];
} {
  const keys = explicitProvenanceKeys(entry);
  const unresolvedKeys = keys.filter((key) => !groupsByIdentity.has(key));
  const groups = [...new Set(keys.flatMap((key) => {
    const group = groupsByIdentity.get(key);
    return group === undefined ? [] : [group];
  }))];
  return { keys, groups, unresolvedKeys };
}

function registerEntryIdentities(
  entry: KodaXSessionMessageEntry,
  group: MutableConversationEntry,
  groupsByIdentity: Map<string, MutableConversationEntry>,
): void {
  for (const key of [entry.id, logicalIdentity(entry), entry.sourceEntryId]) {
    if (key !== undefined && !groupsByIdentity.has(key)) {
      groupsByIdentity.set(key, group);
    }
  }
}

function provenLegacyOverlap(
  root: KodaXSessionCompactionEntry,
  messages: readonly KodaXSessionMessageEntry[],
  prior: readonly MutableConversationEntry[],
  groupsByIdentity: ReadonlyMap<string, MutableConversationEntry>,
  issues: PendingConversationHistoryIssue[],
  checkpoint?: () => void,
): ReadonlyMap<string, MutableConversationEntry> {
  const mappings = new Map<string, MutableConversationEntry>();
  const firstKeptId = root.firstKeptEntryId;
  if (firstKeptId === undefined || prior.length === 0 || messages.length === 0) {
    return mappings;
  }
  const firstKeptIndex = messages.findIndex((entry) => entry.id === firstKeptId);
  if (firstKeptIndex !== 0) {
    issues.push({
      code: 'compaction_boundary_invalid',
      message: `Compaction ${root.id} does not identify the first retained message.`,
      entryIds: [root.id, firstKeptId],
    });
    return mappings;
  }
  const overlapLengths = prefixSuffixOverlapLengths(
    prior.slice(-messages.length)
      .map((group) => messageFingerprint(group.source.message)),
    messages.map((entry) => messageFingerprint(entry.message)),
    checkpoint,
  );
  let provenanceConflict = false;
  const explicit = messages.flatMap((entry, index) => {
    const resolution = explicitPriorGroupResolution(entry, groupsByIdentity);
    return resolution.keys.length === 0 ? [] : [{ index, resolution }];
  });
  const firstExplicit = explicit[0];
  const shortLengths = firstExplicit === undefined
    ? overlapLengths
    : overlapLengths.filter((length) => length <= firstExplicit.index);
  let longLength: number | undefined;
  if (firstExplicit !== undefined) {
    const { index, resolution } = firstExplicit;
    const groupIndex = resolution.groups.length === 1
      ? resolution.groups[0]!.index
      : -1;
    const expectedLength = prior.length + index - groupIndex;
    longLength = resolution.unresolvedKeys.length === 0
      && resolution.groups.length === 1
      && groupIndex >= 0
      && overlapLengths.includes(expectedLength)
      && expectedLength > index
      ? expectedLength
      : undefined;
    if (
      longLength === undefined
      && overlapLengths.some((length) => length > index)
    ) {
      provenanceConflict = true;
    }
  }
  for (const item of explicit.slice(1)) {
    if (longLength === undefined || longLength <= item.index) continue;
    const { resolution } = item;
    const groupIndex = resolution.groups.length === 1
      ? resolution.groups[0]!.index
      : -1;
    if (
      resolution.unresolvedKeys.length > 0
      || resolution.groups.length !== 1
      || groupIndex < 0
      || prior.length + item.index - groupIndex !== longLength
    ) {
      provenanceConflict = true;
      longLength = undefined;
    }
  }
  const candidateLengths = [
    ...shortLengths,
    ...(longLength === undefined ? [] : [longLength]),
  ];
  const candidates = candidateLengths.map((length) => prior.length - length);
  const explicitGroups = explicitPriorGroups(messages[0]!, groupsByIdentity);
  if (
    candidates.length === 0
    && explicitGroups.length === 1
    && !messagesEqual(explicitGroups[0]!.source.message, messages[0]!.message)
  ) {
    return mappings;
  }
  if (provenanceConflict) {
    issues.push({
      code: 'logical_identity_conflict',
      message: `Compaction ${root.id} contains provenance keys that name different history records.`,
      entryIds: [root.id, ...messages.map((entry) => entry.id)],
    });
  }
  if (candidates.length !== 1) {
    issues.push({
      code: 'compaction_boundary_invalid',
      message: `Compaction ${root.id} has no unique retained suffix.`,
      entryIds: [root.id, ...messages.map((entry) => entry.id)],
    });
    return mappings;
  }
  const start = candidates[0]!;
  for (let index = start; index < prior.length; index += 1) {
    mappings.set(messages[index - start]!.id, prior[index]!);
  }
  return mappings;
}

function longestUnprovenOverlap(
  messages: readonly KodaXSessionMessageEntry[],
  prior: readonly MutableConversationEntry[],
  groupsByIdentity: ReadonlyMap<string, MutableConversationEntry>,
  checkpoint?: () => void,
): KodaXSessionMessageEntry[] {
  const [length = 0] = prefixSuffixOverlapLengths(
    prior.slice(-messages.length)
      .map((group) => messageFingerprint(group.source.message)),
    messages.map((entry) => messageFingerprint(entry.message)),
    checkpoint,
  );
  return messages.slice(0, length).filter((entry) =>
    explicitPriorGroups(entry, groupsByIdentity).length === 0);
}

function appendConversationMessage(
  entry: KodaXSessionMessageEntry,
  topologyMappings: ReadonlyMap<string, MutableConversationEntry>,
  groups: MutableConversationEntry[],
  groupsByIdentity: Map<string, MutableConversationEntry>,
  issues: PendingConversationHistoryIssue[],
): void {
  const topologyGroup = topologyMappings.get(entry.id);
  if (topologyGroup !== undefined) {
    const resolution = explicitPriorGroupResolution(entry, groupsByIdentity);
    if (
      resolution.unresolvedKeys.length > 0
      || resolution.groups.length > 1
      || (resolution.groups.length === 1 && resolution.groups[0] !== topologyGroup)
    ) {
      issues.push({
        code: 'logical_identity_conflict',
        message: `Transcript provenance for ${entry.id} does not identify its topology-proven record.`,
        entryIds: [topologyGroup.source.id, entry.id],
      });
      const group = {
        index: groups.length,
        source: entry,
        auditEntryIds: [entry.id],
      };
      groups.push(group);
      registerEntryIdentities(entry, group, groupsByIdentity);
      return;
    } else {
      topologyGroup.auditEntryIds.push(entry.id);
      registerEntryIdentities(entry, topologyGroup, groupsByIdentity);
      return;
    }
  }
  const resolution = explicitPriorGroupResolution(entry, groupsByIdentity);
  const priorGroups = resolution.groups;
  const priorGroup = resolution.keys.length > 0
    && resolution.unresolvedKeys.length === 0
    && priorGroups.length === 1
    ? priorGroups[0]
    : undefined;
  if (priorGroup !== undefined && messagesEqual(priorGroup.source.message, entry.message)) {
    priorGroup.auditEntryIds.push(entry.id);
    registerEntryIdentities(entry, priorGroup, groupsByIdentity);
    return;
  }
  if (
    priorGroups.length > 0
    && (
      resolution.unresolvedKeys.length > 0
      || priorGroups.length !== 1
      || priorGroup === undefined
      || !messagesEqual(priorGroup.source.message, entry.message)
    )
  ) {
    issues.push({
      code: 'logical_identity_conflict',
      message: `Transcript provenance for ${entry.id} is conflicting or has a different payload.`,
      entryIds: [...priorGroups.map((group) => group.source.id), entry.id],
    });
  }
  const group = {
    index: groups.length,
    source: entry,
    auditEntryIds: [entry.id],
  };
  groups.push(group);
  registerEntryIdentities(entry, group, groupsByIdentity);
}

function historyStatus(
  issues: readonly PendingConversationHistoryIssue[],
): SessionConversationHistoryStatus {
  if (issues.some((issue) => issue.code === 'legacy_overlap_ambiguous'
    || issue.code === 'compaction_boundary_invalid'
    || issue.code === 'compaction_predecessor_ambiguous'
    || issue.code === 'logical_identity_conflict')) {
    return 'ambiguous';
  }
  return issues.length > 0 ? 'partial' : 'resolved';
}

function summarizeConversationIssues(
  issues: readonly PendingConversationHistoryIssue[],
): SessionConversationHistoryIssue[] {
  const byCode = new Map<SessionConversationHistoryIssueCode, {
    message: string;
    occurrenceCount: number;
    entryCount: number;
    entryIds: string[];
    evidenceBytes: number;
  }>();
  for (const issue of issues) {
    const current = byCode.get(issue.code) ?? {
      message: issue.message,
      occurrenceCount: 0,
      entryCount: 0,
      entryIds: [],
      evidenceBytes: 0,
    };
    current.occurrenceCount += 1;
    current.entryCount += issue.entryIds.length;
    for (const entryId of issue.entryIds) {
      if (
        current.entryIds.length < MAX_CONVERSATION_ISSUE_ENTRY_IDS
        && !current.entryIds.includes(entryId)
        && current.evidenceBytes + Buffer.byteLength(entryId, 'utf8')
          <= MAX_CONVERSATION_ISSUE_EVIDENCE_BYTES
      ) {
        current.entryIds.push(entryId);
        current.evidenceBytes += Buffer.byteLength(entryId, 'utf8');
      }
    }
    byCode.set(issue.code, current);
  }
  return [...byCode.entries()].map(([code, summary]) => ({
    code,
    message: summary.message.length <= MAX_CONVERSATION_ISSUE_MESSAGE_LENGTH
      ? summary.message
      : `${summary.message.slice(0, MAX_CONVERSATION_ISSUE_MESSAGE_LENGTH - 1)}…`,
    occurrenceCount: summary.occurrenceCount,
    entryCount: summary.entryCount,
    entryIds: summary.entryIds,
  }));
}

export function buildSessionConversationHistory(
  lineage: KodaXSessionLineage,
  sourceRevision: string,
  checkpoint?: () => void,
): SessionConversationHistoryData {
  const issues: PendingConversationHistoryIssue[] = [];
  checkpoint?.();
  const epochs = conversationEpochs(lineage, issues, checkpoint);
  const unreliableTopology = issues.some((issue) =>
    issue.code === 'active_entry_missing'
    || issue.code === 'compaction_boundary_invalid'
    || issue.code === 'compaction_predecessor_ambiguous'
    || issue.code === 'compaction_predecessor_missing'
    || issue.code === 'lineage_path_incomplete');
  const groups: MutableConversationEntry[] = unreliableTopology
    ? lineage.entries
        .filter((entry): entry is KodaXSessionMessageEntry => entry.type === 'message')
        .map((source, index) => ({
          index,
          source,
          auditEntryIds: [source.id],
        }))
    : [];
  const groupsByIdentity = new Map<string, MutableConversationEntry>();
  if (unreliableTopology) {
    for (const group of groups) {
      registerEntryIdentities(group.source, group, groupsByIdentity);
    }
  }
  for (const epoch of epochs) {
    if (unreliableTopology) break;
    const root = epoch.root;
    const topologyMappings = root.type === 'compaction' && root.reason !== 'rewind'
      ? provenLegacyOverlap(
          root,
          epoch.messages,
          groups,
          groupsByIdentity,
          issues,
          checkpoint,
        )
      : new Map<string, MutableConversationEntry>();
    if (root.type === 'compaction' && root.firstKeptEntryId === undefined) {
      const overlap = longestUnprovenOverlap(
        epoch.messages,
        groups,
        groupsByIdentity,
        checkpoint,
      );
      if (overlap.length > 0) {
        issues.push({
          code: 'legacy_overlap_ambiguous',
          message: `Legacy compaction ${root.id} overlaps earlier history without durable provenance.`,
          entryIds: overlap.map((entry) => entry.id),
        });
      }
    }
    for (let index = 0; index < epoch.messages.length; index += 1) {
      if (index % 256 === 0) checkpoint?.();
      const entry = epoch.messages[index]!;
      appendConversationMessage(
        entry,
        topologyMappings,
        groups,
        groupsByIdentity,
        issues,
      );
    }
  }

  const entries = groups.map((group): SessionConversationHistoryEntry => ({
    boundaryId: group.source.id,
    auditEntryIds: group.auditEntryIds,
    message: group.source.message,
  }));
  return {
    sourceRevision,
    status: historyStatus(issues),
    entries,
    issues: summarizeConversationIssues(issues),
  };
}

/**
 * Fork a revision-fenced conversation boundary without expanding the model's
 * compacted active context. A short, disconnected provenance seed preserves
 * the proven pre-compaction conversation for ordinary-history projection.
 */
export function forkSessionConversationLineage(
  lineage: KodaXSessionLineage,
  targetId: string,
  sourceRevision: string,
): KodaXSessionLineage | null {
  const targetLineage: KodaXSessionLineage = {
    ...lineage,
    activeEntryId: targetId,
  };
  const activePath = getSessionLineagePath(targetLineage, targetId);
  if (activePath.at(-1)?.id !== targetId) return null;
  const initialFork = forkSessionLineage(targetLineage, targetId);
  if (initialFork === null) return null;
  const forkPath = getSessionLineagePath(initialFork);
  if (forkPath.length !== activePath.length) return null;
  const forkIdBySourceId = new Map(activePath.map((entry, index) => [
    entry.id,
    forkPath[index]!.id,
  ]));
  const forked: KodaXSessionLineage = {
    ...initialFork,
    entries: initialFork.entries.map((entry, index) => {
      const source = activePath[index];
      return entry.type === 'compaction'
        && source?.type === 'compaction'
        && source.firstKeptEntryId !== undefined
        ? {
            ...entry,
            firstKeptEntryId: forkIdBySourceId.get(source.firstKeptEntryId),
          }
        : entry;
    }),
  };
  const root = activePath[0];
  if (root?.type !== 'compaction' || root.reason === 'rewind') return forked;

  const history = buildSessionConversationHistory(targetLineage, sourceRevision);
  if (history.status !== 'resolved' || root.firstKeptEntryId === undefined) {
    return null;
  }
  const activeMessages = activePath.filter(
    (entry): entry is KodaXSessionMessageEntry => entry.type === 'message',
  );
  const firstKeptIndex = activeMessages.findIndex(
    (entry) => entry.id === root.firstKeptEntryId,
  );
  if (firstKeptIndex < 0) return null;
  const activeMessageIds = new Set(activeMessages.map((entry) => entry.id));
  const historyIndexByAuditId = new Map<string, number>();
  for (let index = 0; index < history.entries.length; index += 1) {
    for (const auditEntryId of history.entries[index]!.auditEntryIds) {
      historyIndexByAuditId.set(auditEntryId, index);
    }
  }
  let retainedHistoryEnd = -1;
  for (const message of activeMessages.slice(firstKeptIndex)) {
    const historyIndex = historyIndexByAuditId.get(message.id);
    if (historyIndex === undefined) return null;
    const hasEarlierPhysicalCopy = history.entries[historyIndex]!.auditEntryIds
      .some((entryId) => !activeMessageIds.has(entryId));
    if (!hasEarlierPhysicalCopy) break;
    if (retainedHistoryEnd >= 0 && historyIndex !== retainedHistoryEnd + 1) {
      return null;
    }
    retainedHistoryEnd = historyIndex;
  }
  if (retainedHistoryEnd < 0) return null;

  const entriesById = new Map(lineage.entries.map((entry) => [entry.id, entry]));
  let parentId: string | null = null;
  const seedEntries: KodaXSessionMessageEntry[] = [];
  for (const item of history.entries.slice(0, retainedHistoryEnd + 1)) {
    const activeCopyId = item.auditEntryIds.find((entryId) =>
      activeMessageIds.has(entryId));
    const sourceId = activeCopyId ?? item.boundaryId;
    const source = sourceId === undefined ? undefined : entriesById.get(sourceId);
    if (source?.type !== 'message') return null;
    const seeded: KodaXSessionMessageEntry = { ...source, parentId };
    seedEntries.push(seeded);
    parentId = seeded.id;
  }
  const seedTip = seedEntries.at(-1);
  if (seedTip === undefined) return null;
  const seed = forkSessionLineage({
    version: 2,
    activeEntryId: seedTip.id,
    entries: seedEntries,
  });
  if (seed === null) return null;
  return {
    version: 2,
    activeEntryId: forked.activeEntryId,
    entries: [...seed.entries, ...forked.entries],
  };
}

export function buildLineageUnavailableConversationHistory(
  messages: readonly KodaXMessage[],
  sourceRevision: string,
  checkpoint?: () => void,
): SessionConversationHistoryData {
  const issue: PendingConversationHistoryIssue = {
    code: 'lineage_unavailable',
    message: 'This legacy Session has messages but no lineage identity metadata.',
    entryIds: [],
  };
  const entries: SessionConversationHistoryEntry[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (index % 256 === 0) checkpoint?.();
    entries.push({ auditEntryIds: [], message: messages[index]! });
  }
  return {
    sourceRevision,
    status: 'partial',
    entries,
    issues: summarizeConversationIssues([issue]),
  };
}
