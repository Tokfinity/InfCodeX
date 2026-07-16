/**
 * Hermetic shape tests for FEATURE_149 batched-drain dataset.
 * Zero LLM cost. Locks dataset invariants the eval relies on.
 */
import { describe, expect, it } from 'vitest';

import {
  CASES,
  buildJudges,
  buildPromptVariants,
  type CaseId,
} from './cases.js';

const ALL_CASE_IDS: readonly CaseId[] = [
  'two_independent_lookups',
  'three_mixed_tasks',
  'redirect_correction',
  'four_questions',
];

describe('FEATURE_149 batched-drain dataset shape', () => {
  it('exports exactly 4 cases', () => {
    expect(CASES.length).toBe(4);
    const ids = CASES.map((c) => c.id).sort();
    expect(ids).toEqual([...ALL_CASE_IDS].sort());
  });

  it('every case has a description and a behaviour spec', () => {
    for (const c of CASES) {
      expect(c.description.length).toBeGreaterThan(20);
      expect(c.behaviour.length).toBeGreaterThan(20);
    }
  });
});

describe('FEATURE_149 batched-drain variants', () => {
  for (const caseId of ALL_CASE_IDS) {
    describe(caseId, () => {
      it('has exactly one variant labelled v0.7.38', () => {
        const variants = buildPromptVariants(caseId);
        expect(variants.length).toBe(1);
        expect(variants[0]?.id).toBe('v0.7.38');
      });

      it('user message contains the production batch separator (\\n\\n---\\n\\n)', () => {
        const [variant] = buildPromptVariants(caseId);
        // Every batched case must use the same separator the runtime
        // joins with — otherwise we'd be testing a different shape than
        // production sends.
        expect(variant?.userMessage).toContain('\n\n---\n\n');
      });

      it('system + user prompts are non-empty and well-formed', () => {
        const [variant] = buildPromptVariants(caseId);
        expect(variant?.systemPrompt.length).toBeGreaterThan(50);
        expect(variant?.userMessage.length).toBeGreaterThan(40);
      });
    });
  }
});

describe('FEATURE_149 batched-drain — case-specific variant content', () => {
  it('two-lookups case batches a npm question and a cargo question', () => {
    const [variant] = buildPromptVariants('two_independent_lookups');
    expect(variant?.userMessage).toMatch(/npm workspaces/i);
    expect(variant?.userMessage).toMatch(/cargo/i);
  });

  it('three-mixed-tasks case mentions HTTP, UTF-8, and Promise topics', () => {
    const [variant] = buildPromptVariants('three_mixed_tasks');
    expect(variant?.userMessage).toMatch(/HTTP/i);
    expect(variant?.userMessage).toMatch(/UTF-?8/i);
    expect(variant?.userMessage).toMatch(/Promise/i);
  });

  it('redirect case has a clear "scratch that" override after the first sub-task', () => {
    const [variant] = buildPromptVariants('redirect_correction');
    expect(variant?.userMessage).toMatch(/scratch that|ignore the previous/i);
    expect(variant?.userMessage).toMatch(/ISO 8601/i);
  });

  it('four-questions case asks four TS-domain questions', () => {
    const [variant] = buildPromptVariants('four_questions');
    expect(variant?.userMessage).toMatch(/readonly/i);
    expect(variant?.userMessage).toMatch(/interface/i);
    expect(variant?.userMessage).toMatch(/optional|\?:/i);
    expect(variant?.userMessage).toMatch(/as const/i);
  });
});

describe('FEATURE_149 batched-drain judges', () => {
  for (const caseId of ALL_CASE_IDS) {
    it(`${caseId} returns at least one judge`, () => {
      const judges = buildJudges(caseId);
      expect(judges.length).toBeGreaterThanOrEqual(1);
    });
  }

  it('two-lookups judges accept a response that addresses both lookups', () => {
    const judges = buildJudges('two_independent_lookups');
    const sample =
      'In an npm workspace the package list is in `package.json` under '
      + 'the `workspaces` field. In a Cargo workspace, the `Cargo.toml` '
      + 'at the workspace root has a `[workspace]` table listing members.';
    for (const j of judges) {
      const r = j.judge(sample);
      expect(r.passed, `${j.name} reason=${r.reason}`).toBe(true);
    }
  });

  it('two-lookups judges reject a response that only answers npm', () => {
    const judges = buildJudges('two_independent_lookups');
    const sample = 'In an npm workspace the package list is in `package.json`.';
    const allPassed = judges.every((j) => j.judge(sample).passed);
    expect(allPassed).toBe(false);
  });

  it('three-mixed judges accept a response covering 2/3 sub-tasks', () => {
    const judges = buildJudges('three_mixed_tasks');
    const sample =
      'Common 4xx HTTP codes: 400 Bad Request, 404 Not Found, 429 Too Many '
      + 'Requests. Promise.all rejects on the first failure; '
      + 'Promise.allSettled waits for all and returns each result whether '
      + 'fulfilled or rejected.';
    // Bytes question intentionally absent — should still pass (≥2/3).
    for (const j of judges) {
      const r = j.judge(sample);
      expect(r.passed, `${j.name} reason=${r.reason}`).toBe(true);
    }
  });

  it('three-mixed judges reject a response covering only 1/3 sub-tasks', () => {
    const judges = buildJudges('three_mixed_tasks');
    const sample =
      'Common 4xx HTTP codes include 400 Bad Request and 404 Not Found.';
    const allPassed = judges.every((j) => j.judge(sample).passed);
    expect(allPassed).toBe(false);
  });

  it('redirect judges accept a response that follows the date redirect', () => {
    const judges = buildJudges('redirect_correction');
    const sample = "`date -u +%Y-%m-%dT%H:%M:%SZ` prints ISO 8601 UTC time.";
    for (const j of judges) {
      const r = j.judge(sample);
      expect(r.passed, `${j.name} reason=${r.reason}`).toBe(true);
    }
  });

  it('redirect judges reject a response that ignores the redirect and counts files', () => {
    const judges = buildJudges('redirect_correction');
    const sample = '`find /tmp -type f | wc -l`';
    const allPassed = judges.every((j) => j.judge(sample).passed);
    expect(allPassed).toBe(false);
  });

  it('four-questions judges accept a response that answers 3/4 questions', () => {
    const judges = buildJudges('four_questions');
    const sample = [
      '`readonly` marks a field immutable after construction; it cannot be reassigned outside the constructor.',
      '`interface` declarations can merge across files and extend other interfaces; `type` aliases support unions and primitives but cannot merge.',
      '`?:` marks the property optional — it may be undefined or absent.',
      // Skip "as const" intentionally; should still pass since 3/4 hit.
    ].join('\n');
    for (const j of judges) {
      const r = j.judge(sample);
      expect(r.passed, `${j.name} reason=${r.reason}`).toBe(true);
    }
  });

  it('four-questions judges reject a response that answers only 2/4 questions', () => {
    const judges = buildJudges('four_questions');
    const sample = [
      '`readonly` makes the field immutable.',
      '`interface` and `type` are similar but type can express unions.',
    ].join('\n');
    const allPassed = judges.every((j) => j.judge(sample).passed);
    expect(allPassed).toBe(false);
  });
});
