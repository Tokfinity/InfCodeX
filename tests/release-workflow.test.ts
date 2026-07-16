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

  it('writes bounded release notes to a file before publishing', () => {
    const workflowSource = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');

    expect(workflowSource).toContain('git fetch --force --tags origin');
    expect(workflowSource).toContain('notes_file="dist/release/RELEASE_NOTES.md"');
    expect(workflowSource).toContain('git log --max-count=100');
    expect(workflowSource).toContain('body_path: dist/release/RELEASE_NOTES.md');
    expect(workflowSource).not.toContain('body: ${{ steps.notes.outputs.body }}');
  });

  it('publishes InfCodeX-branded archives and executables', () => {
    const workflowSource = readFileSync(resolve('.github/workflows/release.yml'), 'utf8');
    const workflow = parse(workflowSource) as ReleaseWorkflow;
    const packageScript = workflow.jobs?.build?.steps
      ?.find((step) => step.name === 'Package archive')
      ?.run;
    const buildScript = readFileSync(resolve('scripts/build-binary.mjs'), 'utf8');
    const cliSource = readFileSync(resolve('src/kodax_cli.ts'), 'utf8');
    const releaseDoc = readFileSync(resolve('docs/release.md'), 'utf8');

    expect(packageScript).toBeTypeOf('string');
    expect(packageScript).toContain('archive_base="infcodex-v${version}-${target}"');
    expect(packageScript).toContain('infcodex.exe');
    expect(packageScript).toContain('tar -czf "$archive_file" infcodex');
    expect(workflowSource).toContain('name: infcodex-${{ matrix.target }}');
    expect(workflowSource).toContain(String.raw`run \`./infcodex\` (or \`infcodex.exe\` on Windows)`);
    expect(buildScript).toContain('const binaryName = `infcodex${spec.ext}`;');
    expect(buildScript).toContain('InfCodeX binary build');
    expect(cliSource).toContain(".name('infcodex')");
    expect(cliSource).toContain('Usage: infcodex [options] [prompt]');
    expect(cliSource).toContain('compdef _infcodex infcodex');
    expect(cliSource).toContain('complete -c infcodex');
    expect(cliSource).toContain('Run InfCodeX as a stdio ACP server');
    expect(cliSource).toContain('# InfCodeX bash completion');
    expect(cliSource).toContain('infcodex skill init');
    expect(cliSource).not.toContain('KodaX runtime daemon');
    expect(releaseDoc).toContain('xattr -d com.apple.quarantine infcodex');
    expect(releaseDoc).toContain('reports `infcodex 0.0.0`');
  });
});
