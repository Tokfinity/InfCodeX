import { describe, expect, it } from 'vitest';
import { filterJsonOutput } from './json-output.js';

describe('json output filter', () => {
  it('summarizes large JSON arrays without using untyped data', () => {
    const stdout = JSON.stringify(Array.from({ length: 120 }, (_, index) => ({
      id: index,
      name: `item-${index}`,
      nested: { ok: true },
    })), null, 2);

    const result = filterJsonOutput({
      command: 'aws ec2 describe-instances',
      stdout,
      stderr: '',
      lossiness: 'none',
    });

    expect(result.lossiness).toBe('whole');
    expect(result.stdout).toContain('[json output summarized]');
    expect(result.stdout).toContain('array length=120');
    expect(result.stdout).toContain('object keys=3');
    expect(result.stdout).not.toContain('item-119');
  });
});
