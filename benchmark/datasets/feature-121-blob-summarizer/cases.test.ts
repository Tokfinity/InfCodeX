/**
 * Hermetic shape tests for FEATURE_121 v0.7.40 blob-summarizer dataset.
 * Zero LLM cost. Locks down dataset invariants the eval relies on —
 * mirrors `feature-121-envelope-spillover/cases.test.ts` and
 * `feature-120-child-steering/cases.test.ts`.
 *
 * What we pin:
 *   - exactly 2 cases (audit_report + grep_findings) with non-trivial
 *     ground-truth token sets
 *   - synthetic content is deterministic and ≥20 KB (under the 100 KB
 *     production threshold but representative of summarizer input)
 *   - all ground-truth tokens are present in their own synthetic content
 *     (sanity check — eval can't measure retention against tokens that
 *     never appeared in the input)
 *   - judges PASS on hand-crafted faithful summaries containing all
 *     tokens, FAIL on summaries that drop them, and FAIL on outputs
 *     wrapped in markdown fences
 *   - the variant uses the EXACT production prompt constants (compile-
 *     time guarantee via import — runtime check that it threads through)
 */
import { describe, expect, it } from 'vitest';

import {
  CASES,
  buildJudges,
  buildPromptVariants,
  __INTERNALS,
  type CaseId,
} from './cases.js';
import {
  SUMMARIZER_SYSTEM_PROMPT,
  buildSummarizerUserMessage,
  DEFAULT_SUMMARY_MAX_CHARS,
} from '../../../packages/coding/src/tools/blob-summarizer.js';

const ALL_CASE_IDS: readonly CaseId[] = ['audit_report', 'grep_findings'];

describe('FEATURE_121 blob-summarizer dataset shape', () => {
  it('exports exactly 2 cases', () => {
    expect(CASES.length).toBe(2);
    const ids = CASES.map((c) => c.id).sort();
    expect(ids).toEqual([...ALL_CASE_IDS].sort());
  });

  it('every case has description, behaviour, ground-truth tokens, and threshold', () => {
    for (const c of CASES) {
      expect(c.description.length).toBeGreaterThan(40);
      expect(c.behaviour.length).toBeGreaterThan(20);
      expect(c.groundTruthTokens.length).toBeGreaterThanOrEqual(10);
      expect(c.retentionThreshold).toBeGreaterThanOrEqual(0.5);
      expect(c.retentionThreshold).toBeLessThanOrEqual(1);
    }
  });

  it('ground-truth token sets are disjoint between cases (no accidental cross-contamination)', () => {
    const auditSet = new Set(__INTERNALS.AUDIT_GROUND_TRUTH_TOKENS);
    const grepSet = new Set(__INTERNALS.GREP_GROUND_TRUTH_TOKENS);
    const overlap = [...auditSet].filter((t) => grepSet.has(t));
    // Some structural overlap is fine (e.g. both could reference `ENOENT`),
    // but >2 tokens overlap would mean we're measuring retention of the
    // same content twice. Cap at 2.
    expect(overlap.length).toBeLessThanOrEqual(2);
  });
});

describe('FEATURE_121 blob-summarizer synthetic content', () => {
  for (const caseId of ALL_CASE_IDS) {
    describe(caseId, () => {
      it('content is ≥20 KB (representative of summarizer input volume)', () => {
        const content = __INTERNALS.buildContentForCase(caseId);
        const bytes = Buffer.byteLength(content, 'utf-8');
        expect(bytes).toBeGreaterThanOrEqual(20 * 1024);
        // Soft upper bound — keep eval prompts manageable for context-
        // limited models. 80 KB is well above the 8 KB summary target.
        expect(bytes).toBeLessThan(80 * 1024);
      });

      it('content is deterministic (re-build returns identical bytes)', () => {
        const a = __INTERNALS.buildContentForCase(caseId);
        const b = __INTERNALS.buildContentForCase(caseId);
        expect(a).toBe(b);
      });

      it('every ground-truth token appears in the synthetic content (sanity)', () => {
        const content = __INTERNALS.buildContentForCase(caseId);
        const spec = CASES.find((c) => c.id === caseId);
        expect(spec).toBeDefined();
        const missing = spec!.groundTruthTokens.filter((t) => !content.includes(t));
        expect(missing).toEqual([]);
      });
    });
  }
});

describe('FEATURE_121 blob-summarizer variants', () => {
  for (const caseId of ALL_CASE_IDS) {
    describe(caseId, () => {
      it('has exactly one variant labelled v0.7.40', () => {
        const variants = buildPromptVariants(caseId);
        expect(variants.length).toBe(1);
        expect(variants[0]?.id).toBe('v0.7.40');
      });

      it('systemPrompt is byte-identical to production SUMMARIZER_SYSTEM_PROMPT', () => {
        const [variant] = buildPromptVariants(caseId);
        expect(variant?.systemPrompt).toBe(SUMMARIZER_SYSTEM_PROMPT);
      });

      it('userMessage is byte-identical to buildSummarizerUserMessage(content, maxChars)', () => {
        const [variant] = buildPromptVariants(caseId);
        const expected = buildSummarizerUserMessage(
          __INTERNALS.buildContentForCase(caseId),
          DEFAULT_SUMMARY_MAX_CHARS,
        );
        expect(variant?.userMessage).toBe(expected);
      });
    });
  }
});

describe('FEATURE_121 blob-summarizer judges', () => {
  it('retention_audit_report PASSES on a summary containing every audit token', () => {
    const judges = buildJudges('audit_report');
    // Faithful summary — concatenates every ground-truth token verbatim.
    const sample = __INTERNALS.AUDIT_GROUND_TRUTH_TOKENS.join('\n');
    for (const j of judges) {
      expect(j.judge(sample).passed, `judge "${j.name}" should pass`).toBe(true);
    }
  });

  it('retention_audit_report FAILS when most tokens are missing', () => {
    const judges = buildJudges('audit_report');
    // Drop everything except the first 2 tokens — below 70% threshold.
    const sample = __INTERNALS.AUDIT_GROUND_TRUTH_TOKENS.slice(0, 2).join('\n');
    const retentionJudge = judges.find((j) => j.name === 'retention_audit_report');
    expect(retentionJudge).toBeDefined();
    const result = retentionJudge!.judge(sample);
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/missing:/);
  });

  it('retention_grep_findings PASSES on a summary containing every grep token', () => {
    const judges = buildJudges('grep_findings');
    const sample = __INTERNALS.GREP_GROUND_TRUTH_TOKENS.join('\n');
    for (const j of judges) {
      expect(j.judge(sample).passed, `judge "${j.name}" should pass`).toBe(true);
    }
  });

  it('no_preamble_or_fence FAILS on output starting with markdown fence', () => {
    const judges = buildJudges('audit_report');
    const noPreambleJudge = judges.find((j) => j.name === 'no_preamble_or_fence');
    expect(noPreambleJudge).toBeDefined();
    // All ground-truth tokens present, but wrapped in a fence.
    const sample =
      '```markdown\n' +
      __INTERNALS.AUDIT_GROUND_TRUTH_TOKENS.join('\n') +
      '\n```';
    expect(noPreambleJudge!.judge(sample).passed).toBe(false);
  });

  it('no_preamble_or_fence FAILS on output starting with "Here is the summary:"', () => {
    const judges = buildJudges('audit_report');
    const noPreambleJudge = judges.find((j) => j.name === 'no_preamble_or_fence');
    expect(noPreambleJudge).toBeDefined();
    const sample =
      'Here is the summary:\n' +
      __INTERNALS.AUDIT_GROUND_TRUTH_TOKENS.join('\n');
    expect(noPreambleJudge!.judge(sample).passed).toBe(false);
  });

  it('no_preamble_or_fence PASSES on output starting directly with content', () => {
    const judges = buildJudges('audit_report');
    const noPreambleJudge = judges.find((j) => j.name === 'no_preamble_or_fence');
    const sample =
      '# Audit findings (3 critical, 0 high)\n' +
      __INTERNALS.AUDIT_GROUND_TRUTH_TOKENS.join('\n');
    expect(noPreambleJudge!.judge(sample).passed).toBe(true);
  });

  it('no_preamble_or_fence does NOT trip on prose later mentioning fences', () => {
    // Anti-pattern 7 §1 defense: chain-of-thought-style mention of fences
    // mid-output must NOT trigger the structural detector. The regex is
    // anchored to the first non-whitespace block via `^\s*` so later
    // mentions of "```" are fine.
    const judges = buildJudges('audit_report');
    const noPreambleJudge = judges.find((j) => j.name === 'no_preamble_or_fence');
    const sample =
      '# Findings\n' +
      __INTERNALS.AUDIT_GROUND_TRUTH_TOKENS.join('\n') +
      '\nI deliberately did not wrap this in ``` fences because the system prompt forbids it.';
    expect(noPreambleJudge!.judge(sample).passed).toBe(true);
  });
});

describe('FEATURE_121 blob-summarizer preamble detector', () => {
  it('flags leading triple-backtick', () => {
    expect(__INTERNALS.PREAMBLE_OR_FENCE_REGEX.test('```')).toBe(true);
    expect(__INTERNALS.PREAMBLE_OR_FENCE_REGEX.test('  ```markdown\nhi')).toBe(true);
  });

  it('flags leading "Here is" / "Summary:"', () => {
    expect(__INTERNALS.PREAMBLE_OR_FENCE_REGEX.test('Here is your summary')).toBe(true);
    expect(__INTERNALS.PREAMBLE_OR_FENCE_REGEX.test('Summary: 3 findings')).toBe(true);
    expect(__INTERNALS.PREAMBLE_OR_FENCE_REGEX.test('The summary is below')).toBe(true);
  });

  it('does not flag mid-output mentions', () => {
    expect(__INTERNALS.PREAMBLE_OR_FENCE_REGEX.test('# Findings\n```bash\nfoo\n```')).toBe(false);
    expect(__INTERNALS.PREAMBLE_OR_FENCE_REGEX.test('1. First finding\n2. Summary: see above')).toBe(false);
  });
});
