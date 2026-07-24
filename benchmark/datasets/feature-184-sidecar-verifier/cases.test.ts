import { describe, expect, it } from 'vitest';

import {
  OPTIONAL_FOLLOWUP_REGRESSION_CASES,
  OPTIONAL_FOLLOWUP_REGRESSION_CASE_IDS,
  buildTreatmentUserMessage,
} from './cases.js';

describe('Sidecar optional follow-up regression cases', () => {
  it('keeps English and Chinese accept/blocked contrast cases paired', () => {
    const cases = OPTIONAL_FOLLOWUP_REGRESSION_CASES;

    expect(cases.map((candidate) => candidate.id))
      .toEqual(OPTIONAL_FOLLOWUP_REGRESSION_CASE_IDS);
    expect(cases.map((candidate) => [
      candidate.id,
      candidate.expectedVerdict,
    ])).toEqual([
      ['E_accept_optional_followup_en', 'accept'],
      ['F_accept_optional_followup_zh', 'accept'],
      ['G_blocked_required_clarification_en', 'blocked'],
      ['H_blocked_required_clarification_zh', 'blocked'],
    ]);
    for (const candidate of cases) {
      const message = buildTreatmentUserMessage(candidate);
      expect(message).toContain(candidate.userQuery);
      expect(message).toContain(candidate.lastAssistantText);
    }
    const completedCases = cases.filter(
      ({ expectedVerdict }) => expectedVerdict === 'accept',
    );
    for (const candidate of completedCases) {
      const bullets = candidate.lastAssistantText
        .split('\n')
        .filter((line) => line.startsWith('- '));
      expect(bullets).toHaveLength(3);
    }
  });
});
