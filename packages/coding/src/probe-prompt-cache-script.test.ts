import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('prompt-cache probe wire fixture', () => {
  it('uses the canonical KodaX tool schema field consumed by providers', () => {
    const source = readFileSync(
      join(process.cwd(), 'scripts', 'probe-prompt-cache.mjs'),
      'utf8',
    );

    expect(source).toContain('input_schema:');
    expect(source).not.toContain('inputSchema:');
    expect(source).toContain('--confirm-cost');
  });
});
