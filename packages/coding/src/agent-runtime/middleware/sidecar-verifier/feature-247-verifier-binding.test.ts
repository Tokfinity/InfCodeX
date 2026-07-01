/**
 * FEATURE_247 (R3) — Partner profile verifier binding.
 *
 * The profile/task verification standard is rendered into the verifier user
 * message (gated ⇒ default coding verifier prompt byte-identical), and sidecar
 * message events carry session + profile attribution.
 */

import { describe, expect, it } from 'vitest';

import {
  buildVerifierContext,
  renderVerificationCriteria,
} from './verifier-context-builder.js';
import { buildVerifierUserMessage } from './verifier-prompts.js';
import { buildSidecarMessageEvent } from './verifier-recorder-bridge.js';
import type { SidecarVerifierVerdict } from './verifier.js';

describe('FEATURE_247 R3: renderVerificationCriteria', () => {
  it('returns undefined for an absent or content-free contract', () => {
    expect(renderVerificationCriteria(undefined)).toBeUndefined();
    expect(renderVerificationCriteria({})).toBeUndefined();
  });

  it('renders summary, rubricFamily, instructions, criteria and required evidence', () => {
    const out = renderVerificationCriteria({
      summary: 'Answer only from the provided sources',
      rubricFamily: 'partner-research',
      instructions: ['Cite every claim'],
      criteria: [
        { id: 'c1', label: 'Citations', description: 'each claim has a source', threshold: 1, weight: 1 },
      ],
      requiredEvidence: ['source urls'],
    });
    expect(out).toContain('Answer only from the provided sources');
    expect(out).toContain('partner-research');
    expect(out).toContain('Cite every claim');
    expect(out).toContain('Citations');
    expect(out).toContain('source urls');
  });
});

describe('FEATURE_247 R3: verifier context + user message injection (gated)', () => {
  const base = { transcript: [], lastAssistantText: 'x' } as const;

  it('injects additionalCriteria only when a verification contract is supplied', () => {
    expect(buildVerifierContext(base).additionalCriteria).toBeUndefined();
    const withC = buildVerifierContext({ ...base, verification: { summary: 'STANDARD_X' } });
    expect(withC.additionalCriteria).toContain('STANDARD_X');
  });

  it('is byte-identical without criteria and adds a gated section with them', () => {
    const inputs = {
      currentTurnUserQueries: ['q'],
      recentTranscript: [],
      fileEditSummary: [],
      lastAssistantText: 'a',
    };
    const without = buildVerifierUserMessage(inputs);
    expect(without).not.toContain('ADDITIONAL VERIFICATION CRITERIA');
    // undefined criteria ⇒ exactly the same prompt (no default-path drift).
    expect(buildVerifierUserMessage({ ...inputs, additionalCriteria: undefined })).toBe(without);

    const withC = buildVerifierUserMessage({ ...inputs, additionalCriteria: 'PARTNER_STD' });
    expect(withC).toContain('ADDITIONAL VERIFICATION CRITERIA');
    expect(withC).toContain('PARTNER_STD');
  });
});

describe('FEATURE_247 R3: sidecar event attribution', () => {
  const verdict = { verdict: 'revise', reason: 'add citations' } as SidecarVerifierVerdict;

  it('attaches sessionId + agentProfile when provided', () => {
    const ev = buildSidecarMessageEvent(verdict, undefined, {
      sessionId: 'sess-9',
      agentProfile: { surface: 'partner', id: 'p1' },
    });
    expect(ev?.sessionId).toBe('sess-9');
    expect(ev?.agentProfile?.surface).toBe('partner');
  });

  it('omits attribution fields when none is provided (default path unchanged)', () => {
    const ev = buildSidecarMessageEvent(verdict);
    expect(ev?.sessionId).toBeUndefined();
    expect(ev?.agentProfile).toBeUndefined();
  });
});
