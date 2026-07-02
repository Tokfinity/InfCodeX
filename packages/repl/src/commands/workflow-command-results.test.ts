import { describe, expect, it } from 'vitest';

import { detectWorkflowLocale, inferWorkflowLocaleFromParts } from './workflow-command-results.js';

// Presence detection is INTENTIONAL here. It feeds short `/workflow` queries and
// joined rerun parts (rawArgs + name + description + source) where the Chinese
// request/description is diluted by ASCII code and workflow names. A CJK-dominance
// variant was tried and reverted because it flipped short Chinese queries and
// Chinese-authored rerun capsules to English. These tests lock presence so that
// regression is not reintroduced.
describe('detectWorkflowLocale — presence detection (intentional)', () => {
  it('is English when there is no CJK', () => {
    expect(detectWorkflowLocale('Reviewed 3 files, found 2 bugs, all fixed.')).toBe('en');
    expect(detectWorkflowLocale('run the build')).toBe('en');
  });

  it('is Chinese for a short mixed-language query', () => {
    expect(detectWorkflowLocale('跑一下workflow')).toBe('zh');
    expect(detectWorkflowLocale('检查bug')).toBe('zh');
  });

  it('is Chinese when a Chinese description is diluted by ASCII code/names (rerun parts)', () => {
    const joined = inferWorkflowLocaleFromParts(
      'rerun run-zh-audit',
      'feature-217-regression-audit',
      '仔细审查 feature 217 的代码改动，只做问题探查',
      'async function run() { return "完成"; }',
    );
    expect(joined).toBe('zh');
  });

  it('inferWorkflowLocaleFromParts ignores undefined and joins the rest', () => {
    expect(inferWorkflowLocaleFromParts('all english summary', undefined, 'agent-name')).toBe('en');
    expect(inferWorkflowLocaleFromParts('中文摘要', undefined)).toBe('zh');
  });
});
