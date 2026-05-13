import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ENVELOPE_AGGREGATE_LIMIT_BYTES,
  createEnvelopeAggregateBudgetEnforcer,
} from './envelope-budget.js';
import { TOOL_OUTPUT_DIR_ENV } from './truncate.js';

describe('createEnvelopeAggregateBudgetEnforcer', () => {
  let tempDir = '';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-envelope-budget-'));
    process.env[TOOL_OUTPUT_DIR_ENV] = tempDir;
  });

  afterEach(async () => {
    delete process.env[TOOL_OUTPUT_DIR_ENV];
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  const ctx = () => ({
    backups: new Map(),
    executionCwd: process.cwd(),
  });

  it('passes fragments through verbatim when total ≤ ENVELOPE_AGGREGATE_LIMIT_BYTES', async () => {
    const enforce = createEnvelopeAggregateBudgetEnforcer(ctx());
    const fragments = ['a'.repeat(10_000), 'b'.repeat(20_000), 'c'.repeat(5_000)];
    const result = await enforce(fragments);
    expect(result.length).toBe(3);
    expect(result[0]).toBe(fragments[0]);
    expect(result[1]).toBe(fragments[1]);
    expect(result[2]).toBe(fragments[2]);
  });

  it('force-spills the largest fragments first until total ≤ limit', async () => {
    const enforce = createEnvelopeAggregateBudgetEnforcer(ctx());
    // 5 fragments × 56_000 bytes (7 chars × 8000 reps) = 280_000 > 200_000 limit
    const fragments = Array.from({ length: 5 }, (_, i) => `frag-${i}-`.repeat(8_000));
    const result = await enforce(fragments);
    expect(result.length).toBe(5);
    // At least one fragment must have been spilled (preview marker present)
    const spilled = result.filter((f) => f.includes('Full output saved to:'));
    expect(spilled.length).toBeGreaterThanOrEqual(1);
    // After spillover the total must be at or below the limit
    const total = result.reduce((sum, f) => sum + f.length, 0);
    expect(total).toBeLessThanOrEqual(ENVELOPE_AGGREGATE_LIMIT_BYTES);
  });

  it('preserves fragment order (preview replaces fragment at its original index)', async () => {
    const enforce = createEnvelopeAggregateBudgetEnforcer(ctx());
    // Three fragments; the middle one is the largest, should be spilled.
    const small1 = 'small-1-'.repeat(100); // ~800 bytes
    const huge = 'X'.repeat(220_000); // > limit single-handedly
    const small2 = 'small-2-'.repeat(100); // ~800 bytes
    const fragments = [small1, huge, small2];
    const result = await enforce(fragments);
    expect(result.length).toBe(3);
    expect(result[0]).toBe(small1);
    expect(result[2]).toBe(small2);
    // Middle slot was the largest — got spilled.
    expect(result[1]).toContain('Full output saved to:');
    expect(result[1].length).toBeLessThan(huge.length);
  });

  it('produces a saved file on disk when spillover triggers', async () => {
    const enforce = createEnvelopeAggregateBudgetEnforcer(ctx());
    const fragments = [
      'A'.repeat(150_000),
      'B'.repeat(60_000),
      'C'.repeat(10_000),
    ];
    const result = await enforce(fragments);
    const spilledFragment = result.find((f) => f.includes('Full output saved to:'));
    expect(spilledFragment).toBeDefined();
    const match = spilledFragment!.match(/Full output saved to: ([^\s.]+(?:\.txt)?)/);
    expect(match).not.toBeNull();
    const filePath = match![1];
    const onDisk = await fs.readFile(filePath, 'utf-8');
    // The on-disk file must contain the ORIGINAL full content of the
    // spilled fragment.
    expect(onDisk.length).toBeGreaterThan(100_000);
  });

  it('handles the empty fragments array gracefully', async () => {
    const enforce = createEnvelopeAggregateBudgetEnforcer(ctx());
    const result = await enforce([]);
    expect(result.length).toBe(0);
  });

  it('handles a single fragment under limit (no-op fast path)', async () => {
    const enforce = createEnvelopeAggregateBudgetEnforcer(ctx());
    const single = ['hello world'];
    const result = await enforce(single);
    expect(result).toEqual(single);
  });

  it('handles a single oversized fragment (forces spill to fit budget)', async () => {
    const enforce = createEnvelopeAggregateBudgetEnforcer(ctx());
    const huge = 'X'.repeat(300_000);
    const result = await enforce([huge]);
    expect(result.length).toBe(1);
    expect(result[0]).toContain('Full output saved to:');
    expect(result[0].length).toBeLessThan(huge.length);
  });
});
