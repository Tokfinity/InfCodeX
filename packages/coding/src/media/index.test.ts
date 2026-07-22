import { describe, expect, it } from 'vitest';

import * as canonicalMedia from '@kodax-ai/agent/media';
import * as codingMedia from './index.js';

describe('@kodax-ai/coding/media facade', () => {
  it('re-exports the canonical Agent media runtime without wrappers', () => {
    const canonicalExports: Record<string, unknown> = { ...canonicalMedia };
    const facadeExports: Record<string, unknown> = { ...codingMedia };

    expect(Object.keys(facadeExports).sort()).toEqual(Object.keys(canonicalExports).sort());
    for (const name of Object.keys(canonicalExports)) {
      expect(facadeExports[name]).toBe(canonicalExports[name]);
    }
  });
});
