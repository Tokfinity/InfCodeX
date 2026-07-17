import { createHash } from 'node:crypto';

import { readLearningProposalStore } from './store.js';
import type { StoredLearningProposal } from './types.js';
import type { LearnedCapabilityCarrier, LearnedCapabilityRecord } from './center-types.js';
import { slugifyLearnedCapabilityName } from './center-types.js';

export interface LearningProposalProjection {
  readonly records: readonly LearnedCapabilityRecord[];
  readonly warnings: readonly string[];
}

export async function projectLearningProposals(filePath: string): Promise<LearningProposalProjection> {
  const result = await readLearningProposalStore(filePath);
  return {
    records: makeProjectedLearningSlugsUnique(
      result.proposals.map((stored) => projectProposal(stored, filePath)),
    ),
    warnings: result.warnings,
  };
}

export function makeProjectedLearningSlugsUnique(
  records: readonly LearnedCapabilityRecord[],
  reservedSlugs: readonly string[] = [],
): readonly LearnedCapabilityRecord[] {
  const used = new Set(reservedSlugs);
  return records.map((record) => {
    const slug = nextAvailableSlug(record.slug, record.capabilityId, used);
    used.add(slug);
    return slug === record.slug ? record : { ...record, slug };
  });
}

function nextAvailableSlug(base: string, capabilityId: string, used: ReadonlySet<string>): string {
  if (!used.has(base)) return base;
  const suffix = capabilityId.replace(/^lc_/, '').slice(-8);
  const stem = base.slice(0, Math.max(1, 64 - suffix.length - 1)).replace(/-+$/g, '');
  const candidate = `${stem}-${suffix}`;
  if (!used.has(candidate)) return candidate;
  for (let index = 2; index < 10_000; index += 1) {
    const numbered = `${candidate.slice(0, 64 - String(index).length - 1)}-${index}`;
    if (!used.has(numbered)) return numbered;
  }
  throw new Error(`unable to allocate a unique learned capability slug for ${capabilityId}`);
}

function projectProposal(stored: StoredLearningProposal, filePath: string): LearnedCapabilityRecord {
  const displayName = proposalDisplayName(stored);
  return {
    schemaVersion: 1,
    capabilityId: `lc_${createHash('sha256')
      .update(filePath)
      .update('\0')
      .update(stored.proposalId)
      .digest('hex')
      .slice(0, 20)}`,
    displayName,
    slug: slugifyLearnedCapabilityName(displayName),
    carrier: proposalCarrier(stored),
    lifecycle: stored.status === 'pending'
      ? 'ready'
      : stored.status === 'approved' ? 'promoted_user' : 'rejected',
    revision: 1,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    source: {
      kind: 'f224_proposal',
      proposalId: stored.proposalId,
    },
  };
}

function proposalDisplayName(stored: StoredLearningProposal): string {
  if ('skillName' in stored.proposal) return stored.proposal.skillName;
  if ('title' in stored.proposal) return stored.proposal.title;
  if ('memoryKind' in stored.proposal) return `Memory ${stored.proposal.memoryKind}`;
  return `Workflow handoff ${stored.proposalId.slice(0, 8)}`;
}

function proposalCarrier(stored: StoredLearningProposal): LearnedCapabilityCarrier {
  return stored.proposal.destination === 'workflow_handoff' ? 'workflow_handoff' : 'skill';
}
