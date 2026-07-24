import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface WorkflowStep {
  readonly name?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly id?: string;
  readonly if?: string;
  readonly with?: Readonly<Record<string, unknown>>;
}

interface ReleaseWorkflow {
  readonly jobs?: {
    readonly build?: {
      readonly steps?: readonly WorkflowStep[];
    };
    readonly 'packaged-electron-daemon'?: {
      readonly steps?: readonly WorkflowStep[];
    };
  };
}

describe('GitHub release workflow', () => {
  it('publishes the exact Sidecar-audited npm tarball', () => {
    const source = readFileSync(resolve('scripts/release.mjs'), 'utf8');

    expect(source).toContain("import { auditSidecarTarball } from './audit-sidecar-tarball.mjs'");
    expect(source).toContain('auditSidecarTarball(tarballPath)');
    expect(source).toContain("'publish',");
    expect(source).toContain('tarballPath,');
  });

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

  it('builds once before the Windows Electron gate and binary packaging', () => {
    const source = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
    const workflow = parse(source) as ReleaseWorkflow;
    const steps = workflow.jobs?.build?.steps ?? [];

    expect(steps.find((step) => step.name === 'Build')?.run).toBe('npm run build');
    expect(steps.find((step) => step.name === 'Packaged Electron daemon release gate')?.run)
      .toBe('npm run test:electron-daemon:built');
    expect(steps.find((step) => step.name?.startsWith('Build binary'))?.run)
      .toContain('--skip-tsc');
  });

  it('caches the packaged Electron smoke toolchain in CI and releases', () => {
    const release = parse(
      readFileSync(resolve('.github/workflows/release.yml'), 'utf8'),
    ) as ReleaseWorkflow;
    const ci = parse(
      readFileSync(resolve('.github/workflows/ci.yml'), 'utf8'),
    ) as ReleaseWorkflow;
    for (const steps of [
      release.jobs?.build?.steps ?? [],
      ci.jobs?.['packaged-electron-daemon']?.steps ?? [],
    ]) {
      const cache = steps.find((step) => step.name === 'Cache packaged Electron smoke toolchain');
      const install = steps.find((step) => step.name === 'Install packaged Electron smoke toolchain');
      const ensureBinary = steps.find((step) => step.name === 'Ensure packaged Electron binary');
      expect(cache).toMatchObject({
        uses: 'actions/cache@v5',
        id: 'electron-smoke-cache',
        with: { path: '.electron-smoke/node_modules' },
      });
      expect(install?.if).toContain("steps.electron-smoke-cache.outputs.cache-hit != 'true'");
      expect(ensureBinary?.run).toBe('node .electron-smoke/node_modules/electron/install.js');
    }
  });
});
