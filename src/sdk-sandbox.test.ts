import { describe, expect, it } from 'vitest';

import {
  KODAX_ASRT_VERSION,
  getKodaXSandboxCapability,
  getKodaXSandboxSetupGuidance,
  runKodaXSandboxed,
} from './sdk-sandbox.js';

describe('@kodax-ai/kodax/sandbox public surface', () => {
  it('exposes generic containment independently from Auto[LLM]', () => {
    const capability = getKodaXSandboxCapability();
    expect(capability).toMatchObject({
      version: 2,
      asrtVersion: KODAX_ASRT_VERSION,
      genericCommandExecution: true,
      ordinaryCallsTriggerSetup: false,
      unavailableBehavior: 'structured-no-execution',
      permissionFallback: 'normal-permission-policy',
    });
    expect(capability.controls).toEqual([
      'filesystem',
      'network',
      'environment',
      'timeout',
      'output',
    ]);
    expect(runKodaXSandboxed).toBeTypeOf('function');
    expect(getKodaXSandboxSetupGuidance).toBeTypeOf('function');
  });
});
