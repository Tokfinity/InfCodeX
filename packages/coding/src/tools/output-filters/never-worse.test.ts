import { describe, expect, it } from 'vitest';
import { neverWorse } from './never-worse.js';

describe('neverWorse', () => {
  it('keeps filtered output when it is smaller', () => {
    expect(neverWorse('raw output with extra words', 'raw output')).toBe('raw output');
  });

  it('falls back to raw output when filtered output is larger', () => {
    expect(neverWorse('ok', 'ok with extra explanation')).toBe('ok');
  });

  it('keeps raw output on ties because a rewrite without token savings is not an optimization', () => {
    expect(neverWorse('a', 'b')).toBe('a');
  });
});
