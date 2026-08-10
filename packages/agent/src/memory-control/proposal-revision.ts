import { createHash } from 'node:crypto';

import type { MemoryActionProposal } from './types.js';

/** Revision of the exact decision preview shown to a user. */
export function memoryProposalRevision(proposal: MemoryActionProposal): string {
  const fingerprints = Object.entries(proposal.expectedFingerprints)
    .sort(([left], [right]) => left.localeCompare(right));
  return createHash('sha256')
    .update(JSON.stringify({
      id: proposal.id,
      action: proposal.action,
      rationale: proposal.rationale,
      risk: proposal.risk,
      preview: {
        summary: proposal.preview.summary,
        changedPaths: proposal.preview.changedPaths,
        warnings: proposal.preview.warnings,
        diff: proposal.preview.diff ?? null,
      },
      fingerprints,
    }))
    .digest('hex')
    .slice(0, 16);
}
