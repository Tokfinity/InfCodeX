import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface WorkflowStep {
  readonly name?: string;
  readonly run?: string;
}

interface ReleaseWorkflow {
  readonly jobs?: {
    readonly build?: {
      readonly steps?: readonly WorkflowStep[];
    };
  };
}

describe('GitHub release workflow', () => {
  it('packages every runtime sidecar with the standalone binary', () => {
    const source = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
    const workflow = parse(source) as ReleaseWorkflow;
    const packageScript = workflow.jobs?.build?.steps
      ?.find((step) => step.name === 'Package archive')
      ?.run;

    expect(packageScript).toBeTypeOf('string');
    for (const required of [
      'provider-capabilities.json',
      'semantic-worker.js',
      'runtime-worker.js',
      'constructed-handler-worker.js',
    ]) {
      expect(packageScript).toContain(required);
    }
  });
});
