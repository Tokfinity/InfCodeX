import { createHash } from 'node:crypto';

export type ReviewSeverity = 'critical' | 'high' | 'medium' | 'low';
export type SpecVerdict = 'compliant' | 'issues' | 'not-verifiable';
export type QualityVerdict = 'approved' | 'needs-fixes';

export interface RawScopedReviewResult {
  readonly specVerdict: SpecVerdict;
  readonly qualityVerdict: QualityVerdict;
  readonly findings: readonly {
    readonly severity: ReviewSeverity;
    readonly location: string;
    readonly claim: string;
    readonly evidence: string;
    readonly suggestedFix?: string;
  }[];
  readonly unverifiedRequirements: readonly string[];
}

export interface ScopedReviewResult {
  readonly specVerdict: SpecVerdict;
  readonly qualityVerdict: QualityVerdict;
  readonly findings: readonly {
    readonly findingId: string;
    readonly severity: ReviewSeverity;
    readonly location: string;
    readonly claim: string;
    readonly evidence: string;
    readonly suggestedFix?: string;
  }[];
  readonly unverifiedRequirements: readonly string[];
}

export interface MergedScopedReviewResult {
  readonly specVerdict: SpecVerdict;
  readonly qualityVerdict: QualityVerdict;
  readonly findings: readonly {
    readonly findingId: string;
    readonly severity: ReviewSeverity;
    readonly location: string;
    readonly claim: string;
    readonly evidence: readonly string[];
    readonly suggestedFixes: readonly string[];
  }[];
  readonly unverifiedRequirements: readonly string[];
}

export interface FindingVerificationResult {
  readonly findings: readonly {
    readonly findingId: string;
    readonly disposition: 'confirmed' | 'refuted' | 'unresolved';
    readonly evidence: string;
    readonly effectiveSeverity?: ReviewSeverity;
    readonly severityReason?: string;
  }[];
}

export interface VerifiedScopedReviewResult {
  readonly actionable: readonly {
    readonly findingId: string;
    readonly disposition: 'confirmed' | 'unresolved';
    readonly severity: ReviewSeverity;
    readonly location: string;
    readonly claim: string;
    readonly evidence: readonly string[];
    readonly verificationEvidence: string;
    readonly suggestedFixes: readonly string[];
    readonly severityReason?: string;
  }[];
  readonly audit: FindingVerificationResult;
  readonly unqualifiedApprovalAllowed: boolean;
}

export const SCOPED_REVIEW_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['specVerdict', 'qualityVerdict', 'findings', 'unverifiedRequirements'],
  properties: {
    specVerdict: { enum: ['compliant', 'issues', 'not-verifiable'] },
    qualityVerdict: { enum: ['approved', 'needs-fixes'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'location', 'claim', 'evidence'],
        properties: {
          severity: { enum: ['critical', 'high', 'medium', 'low'] },
          location: { type: 'string' },
          claim: { type: 'string' },
          evidence: { type: 'string' },
          suggestedFix: { type: 'string' },
        },
      },
    },
    unverifiedRequirements: { type: 'array', items: { type: 'string' } },
  },
} as const;

export const FINDING_VERIFICATION_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['findingId', 'disposition', 'evidence'],
        properties: {
          findingId: { type: 'string' },
          disposition: { enum: ['confirmed', 'refuted', 'unresolved'] },
          evidence: { type: 'string' },
          effectiveSeverity: { enum: ['critical', 'high', 'medium', 'low'] },
          severityReason: { type: 'string' },
        },
      },
    },
  },
} as const;

function normalizeText(value: string): string {
  return value.normalize('NFC').replace(/\r\n?/g, '\n').trim().replace(/[\t\n\f\r ]+/g, ' ');
}

function normalizeLocation(value: string): string {
  return normalizeText(value).replace(/\\/g, '/');
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values.map(normalizeText).filter(Boolean))].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  );
}

function findingId(packetHash: string, location: string, claim: string): string {
  return createHash('sha256')
    .update(`${packetHash}\0${normalizeLocation(location)}\0${normalizeText(claim)}`, 'utf8')
    .digest('hex');
}

export function normalizeScopedReviewResult(
  packetHash: string,
  requirementsPresent: boolean,
  result: RawScopedReviewResult,
): ScopedReviewResult {
  if (!requirementsPresent && result.specVerdict !== 'not-verifiable') {
    throw new Error('review result must use specVerdict "not-verifiable" when requirements are absent');
  }
  return {
    specVerdict: result.specVerdict,
    qualityVerdict: result.qualityVerdict,
    findings: result.findings.map((item) => {
      const location = normalizeLocation(item.location);
      const claim = normalizeText(item.claim);
      const evidence = normalizeText(item.evidence);
      return {
        findingId: findingId(packetHash, location, claim),
        severity: item.severity,
        location,
        claim,
        evidence,
        ...(item.suggestedFix ? { suggestedFix: normalizeText(item.suggestedFix) } : {}),
      };
    }).sort((left, right) => left.findingId < right.findingId ? -1 : left.findingId > right.findingId ? 1 : 0),
    unverifiedRequirements: uniqueSorted(result.unverifiedRequirements),
  };
}

const severityRank: Record<ReviewSeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

function maxSeverity(values: readonly ReviewSeverity[]): ReviewSeverity {
  return values.reduce((current, next) => severityRank[next] > severityRank[current] ? next : current, 'low');
}

export function mergeScopedReviewResults(results: readonly ScopedReviewResult[]): MergedScopedReviewResult {
  if (results.length === 0) throw new Error('at least one primary review result is required');
  const byId = new Map<string, ScopedReviewResult['findings'][number][]>();
  for (const result of results) {
    for (const finding of result.findings) {
      byId.set(finding.findingId, [...(byId.get(finding.findingId) ?? []), finding]);
    }
  }
  const findings = [...byId.entries()].map(([id, variants]) => ({
    findingId: id,
    severity: maxSeverity(variants.map((item) => item.severity)),
    location: variants[0]!.location,
    claim: variants[0]!.claim,
    evidence: uniqueSorted(variants.map((item) => item.evidence)),
    suggestedFixes: uniqueSorted(variants.flatMap((item) => item.suggestedFix ? [item.suggestedFix] : [])),
  })).sort((left, right) => left.findingId < right.findingId ? -1 : left.findingId > right.findingId ? 1 : 0);
  const specVerdict: SpecVerdict = results.some((item) => item.specVerdict === 'issues')
    ? 'issues'
    : results.some((item) => item.specVerdict === 'not-verifiable') ? 'not-verifiable' : 'compliant';
  return {
    specVerdict,
    qualityVerdict: results.some((item) => item.qualityVerdict === 'needs-fixes') ? 'needs-fixes' : 'approved',
    findings,
    unverifiedRequirements: uniqueSorted(results.flatMap((item) => item.unverifiedRequirements)),
  };
}

export function applyFindingVerification(
  review: MergedScopedReviewResult,
  verification: FindingVerificationResult,
): VerifiedScopedReviewResult {
  const expected = new Set(review.findings.map((item) => item.findingId));
  const seen = new Set<string>();
  for (const item of verification.findings) {
    if (!expected.has(item.findingId) || seen.has(item.findingId)) {
      throw new Error('verifier must return every input findingId exactly once');
    }
    if (item.effectiveSeverity !== undefined && !item.severityReason?.trim()) {
      throw new Error('effectiveSeverity requires severityReason');
    }
    seen.add(item.findingId);
  }
  if (seen.size !== expected.size) throw new Error('verifier must return every input findingId exactly once');

  const verificationById = new Map(verification.findings.map((item) => [item.findingId, item]));
  const actionable = review.findings.flatMap((finding) => {
    const verdict = verificationById.get(finding.findingId)!;
    if (verdict.disposition === 'refuted') return [];
    return [{
      ...finding,
      disposition: verdict.disposition,
      severity: verdict.effectiveSeverity ?? finding.severity,
      verificationEvidence: normalizeText(verdict.evidence),
      ...(verdict.severityReason ? { severityReason: normalizeText(verdict.severityReason) } : {}),
    }];
  });
  return {
    actionable,
    audit: verification,
    unqualifiedApprovalAllowed:
      actionable.length === 0 &&
      review.unverifiedRequirements.length === 0 &&
      review.specVerdict === 'compliant' &&
      review.qualityVerdict === 'approved',
  };
}
