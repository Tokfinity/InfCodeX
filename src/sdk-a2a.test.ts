import { describe, expect, it } from 'vitest';

import * as a2aSdk from './sdk-a2a.js';

describe('@kodax-ai/kodax/a2a public surface', () => {
  it('keeps raw persistent config mutations behind the owner-fenced CLI boundary', () => {
    const rawMutations = [
      'migrateA2AIntegrationV1',
      'removeA2AOutboundAgent',
      'setA2AOutboundAgentEnabled',
      'setA2AServerConfig',
      'upsertA2AOutboundAgent',
    ] as const;

    for (const name of rawMutations) {
      expect(Object.hasOwn(a2aSdk, name), name).toBe(false);
    }
    expect(a2aSdk.readA2AIntegration).toBeTypeOf('function');
    expect(a2aSdk.inspectA2AIntegration).toBeTypeOf('function');
  });
});
