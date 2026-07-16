import {
  applyFindingVerification,
  mergeScopedReviewResults,
  normalizeScopedReviewResult,
  type FindingVerificationResult,
} from './scoped-review.js';

describe('scoped review contracts', () => {
  const packetHash = 'a'.repeat(64);

  it('assigns stable IDs after exact normalization without lowercasing', () => {
    const first = normalizeScopedReviewResult(packetHash, true, {
      specVerdict: 'issues',
      qualityVerdict: 'needs-fixes',
      findings: [{
        severity: 'medium',
        location: 'packages\\a.ts : 10 ',
        claim: 'Broken   API\r\n boundary',
        evidence: ' failing test ',
      }],
      unverifiedRequirements: [],
    });
    const second = normalizeScopedReviewResult(packetHash, true, {
      specVerdict: 'issues',
      qualityVerdict: 'needs-fixes',
      findings: [{
        severity: 'medium',
        location: 'packages/a.ts : 10',
        claim: 'Broken API boundary',
        evidence: 'other evidence',
      }],
      unverifiedRequirements: [],
    });
    expect(first.findings[0]?.findingId).toBe(second.findings[0]?.findingId);
    expect(first.findings[0]?.claim).toBe('Broken API boundary');
    expect(first.findings[0]?.location).toBe('packages/a.ts : 10');
  });

  it('rejects an unqualified compliant spec verdict when requirements are absent', () => {
    expect(() => normalizeScopedReviewResult(packetHash, false, {
      specVerdict: 'compliant',
      qualityVerdict: 'approved',
      findings: [],
      unverifiedRequirements: [],
    })).toThrow(/not-verifiable/);
  });

  it('does not allow unqualified approval while a spec or quality verdict remains adverse', () => {
    const review = mergeScopedReviewResults([normalizeScopedReviewResult(packetHash, true, {
      specVerdict: 'not-verifiable',
      qualityVerdict: 'approved',
      findings: [],
      unverifiedRequirements: [],
    })]);
    expect(applyFindingVerification(review, { findings: [] }).unqualifiedApprovalAllowed).toBe(false);
  });

  it('merges multiple primaries conservatively before verification', () => {
    const low = normalizeScopedReviewResult(packetHash, true, {
      specVerdict: 'not-verifiable',
      qualityVerdict: 'approved',
      findings: [{
        severity: 'low',
        location: 'a.ts:1',
        claim: 'same claim',
        evidence: 'evidence B',
        suggestedFix: 'fix B',
      }],
      unverifiedRequirements: ['Req B'],
    });
    const high = normalizeScopedReviewResult(packetHash, true, {
      specVerdict: 'issues',
      qualityVerdict: 'needs-fixes',
      findings: [{
        severity: 'high',
        location: 'a.ts:1',
        claim: 'same claim',
        evidence: 'evidence A',
        suggestedFix: 'fix A',
      }],
      unverifiedRequirements: ['Req A'],
    });

    const merged = mergeScopedReviewResults([low, high]);
    expect(merged.specVerdict).toBe('issues');
    expect(merged.qualityVerdict).toBe('needs-fixes');
    expect(merged.findings[0]).toMatchObject({
      severity: 'high',
      evidence: ['evidence A', 'evidence B'],
      suggestedFixes: ['fix A', 'fix B'],
    });
    expect(merged.unverifiedRequirements).toEqual(['Req A', 'Req B']);
  });

  it('requires one verifier disposition per finding and preserves unresolved audit state', () => {
    const primary = normalizeScopedReviewResult(packetHash, true, {
      specVerdict: 'issues',
      qualityVerdict: 'needs-fixes',
      findings: [
        { severity: 'high', location: 'a.ts:1', claim: 'A', evidence: 'EA' },
        { severity: 'medium', location: 'b.ts:2', claim: 'B', evidence: 'EB' },
      ],
      unverifiedRequirements: [],
    });
    const merged = mergeScopedReviewResults([primary]);
    const verification: FindingVerificationResult = {
      findings: [
        {
          findingId: merged.findings[0]!.findingId,
          disposition: 'confirmed',
          evidence: 'confirmed',
          effectiveSeverity: 'critical',
          severityReason: 'trust boundary',
        },
        {
          findingId: merged.findings[1]!.findingId,
          disposition: 'unresolved',
          evidence: 'cannot reproduce deterministically',
        },
      ],
    };
    const result = applyFindingVerification(merged, verification);
    expect(result.actionable.map((item) => item.disposition)).toEqual(['confirmed', 'unresolved']);
    expect(result.actionable[0]?.severity).toBe('critical');
    expect(result).toMatchObject({
      specVerdict: 'issues',
      qualityVerdict: 'needs-fixes',
      unverifiedRequirements: [],
    });
    expect(result.unqualifiedApprovalAllowed).toBe(false);

    expect(() => applyFindingVerification(merged, { findings: [verification.findings[0]!] }))
      .toThrow(/exactly once/);
  });

  it('ignores an unreasoned severity override instead of failing the review', () => {
    const primary = normalizeScopedReviewResult(packetHash, true, {
      specVerdict: 'issues',
      qualityVerdict: 'needs-fixes',
      findings: [{ severity: 'high', location: 'a.ts:1', claim: 'A', evidence: 'EA' }],
      unverifiedRequirements: [],
    });
    const merged = mergeScopedReviewResults([primary]);
    const result = applyFindingVerification(merged, {
      findings: [{
        findingId: merged.findings[0]!.findingId,
        disposition: 'confirmed',
        evidence: 'confirmed without a severity rationale',
        effectiveSeverity: 'low',
      }],
    });

    expect(result.actionable[0]?.severity).toBe('high');
    expect(result.actionable[0]?.severityReason).toBeUndefined();
  });
});
