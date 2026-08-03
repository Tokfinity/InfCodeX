/**
 * Hermetic self-test for the auto-mode classifier dataset shape.
 * Does NOT call any LLM — that lives in tests/auto-mode-classifier.eval.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  AUTO_MODE_CLASSIFIER_CASES,
  MUST_ASK_CASES,
  MUST_ALLOW_CASES,
} from './cases.js';

describe('auto-mode-classifier dataset shape', () => {
  it('all case ids are unique', () => {
    const ids = AUTO_MODE_CLASSIFIER_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every case is either ask or allow (no legacy block state)', () => {
    for (const c of AUTO_MODE_CLASSIFIER_CASES) {
      expect(['ask', 'allow']).toContain(c.expected);
    }
  });

  it('every case has at least one tag', () => {
    for (const c of AUTO_MODE_CLASSIFIER_CASES) {
      expect(c.tags.length).toBeGreaterThan(0);
    }
  });

  it('ask / allow accessors partition the dataset cleanly', () => {
    expect(MUST_ASK_CASES.length + MUST_ALLOW_CASES.length).toBe(
      AUTO_MODE_CLASSIFIER_CASES.length,
    );
  });

  it('covers both ask classes and every historical Tier-0 pattern', () => {
    const ids = new Map(AUTO_MODE_CLASSIFIER_CASES.map((c) => [c.id, c]));
    for (const id of [
      'ask-credential-read',
      'ask-rm-rf-root',
      'ask-mkfs-device',
      'ask-dd-device',
      'ask-fork-bomb',
      'ask-kodax-security-config-write',
    ]) {
      expect(ids.get(id)?.expected, id).toBe('ask');
    }
  });

  it('covers injected transcript data for both ask and allow decisions', () => {
    const injected = AUTO_MODE_CLASSIFIER_CASES.filter((c) => c.tags.includes('prompt-inject'));
    expect(injected.some((c) => c.expected === 'ask')).toBe(true);
    expect(injected.some((c) => c.expected === 'allow')).toBe(true);
  });

  it('keeps command categories that are not ask hazards on the allow side', () => {
    const ids = new Map(AUTO_MODE_CLASSIFIER_CASES.map((c) => [c.id, c]));
    for (const id of [
      'allow-remote-install-script',
      'allow-force-push',
      'allow-intent-mismatched-package',
      'allow-global-package-reinstall',
    ]) {
      expect(ids.get(id)?.expected, id).toBe('allow');
    }
  });

  it('coverage: legit-work has multiple allow cases (false-positive guardrail)', () => {
    const legit = AUTO_MODE_CLASSIFIER_CASES.filter(
      (c) => c.expected === 'allow' && c.tags.includes('legit-work'),
    );
    expect(legit.length).toBeGreaterThanOrEqual(3);
  });

  it('action strings are non-empty', () => {
    for (const c of AUTO_MODE_CLASSIFIER_CASES) {
      expect(c.action.length).toBeGreaterThan(0);
    }
  });

  it('reasonPattern is a real RegExp when provided', () => {
    for (const c of AUTO_MODE_CLASSIFIER_CASES) {
      if (c.reasonPattern !== undefined) {
        expect(c.reasonPattern).toBeInstanceOf(RegExp);
      }
    }
  });
});
