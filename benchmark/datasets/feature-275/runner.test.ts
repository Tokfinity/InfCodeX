import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModelAlias } from '../../harness/aliases.js';
import { MODEL_ALIASES } from '../../harness/aliases.js';

const runOneShotMock = vi.hoisted(() => vi.fn());

vi.mock('../../harness/harness.js', () => ({ runOneShot: runOneShotMock }));

import {
  buildFeature275RunManifest,
  runFeature275Pilot,
} from './runner.js';

describe('FEATURE_275 paid runner safety', () => {
  let rawRoot: string | undefined;
  const previousAllow = process.env.KODAX_F275_ALLOW_GENERATION;
  const previousAuthorization = process.env.KODAX_F275_AUTHORIZATION;

  afterEach(async () => {
    if (rawRoot !== undefined) await rm(rawRoot, { recursive: true, force: true });
    rawRoot = undefined;
    restore('KODAX_F275_ALLOW_GENERATION', previousAllow);
    restore('KODAX_F275_AUTHORIZATION', previousAuthorization);
    runOneShotMock.mockReset();
  });

  it('freezes action, selector, policy, alias, and scorer identities', () => {
    const manifest = buildFeature275RunManifest(path.join(os.tmpdir(), 'f275-manifest-test'));
    expect(manifest.gitCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(manifest.exactBytes.selectorPolicySha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(manifest.exactBytes.actionSystemPromptSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.exactBytes.scorerSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('runs 16 physical pilot calls, writes blinded A/B/C evidence, and resumes', async () => {
    rawRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-f275-runner-'));
    process.env.KODAX_F275_ALLOW_GENERATION = '1';
    process.env.KODAX_F275_AUTHORIZATION = 'Zero-cost fake-provider unit test.';
    runOneShotMock.mockImplementation(async (
      alias: ModelAlias,
      input: {
        readonly systemPrompt: string;
        readonly userMessage: string;
        readonly ephemeralSuffix?: { readonly content: string };
      },
    ) => {
      const selector = input.systemPrompt.includes('Select only memory candidate IDs');
      const postCompaction = input.userMessage.includes('Runtime bridge')
        || input.userMessage.includes('continue-runtime-integration');
      return {
        alias,
        target: MODEL_ALIASES[alias],
        text: selector
          ? ''
          : postCompaction && input.ephemeralSuffix?.content.includes('compatibility')
            ? 'ACTION: Update the Runtime bridge while preserving SDK and daemon protocol compatibility, then run focused integration tests.\nRATIONALE: The open integration step and compatibility constraint are both explicit.'
            : postCompaction
              ? 'ACTION: Inspect the Runtime bridge.\nRATIONALE: Continue the open work.'
              : 'ACTION: Read the current version from package.json.\nRATIONALE: The workspace file is authoritative.',
        toolCalls: selector
          ? [{
              name: 'select_memory_candidates',
              input: { selectedRefIds: postCompaction ? ['candidate:1'] : [] },
            }]
          : [],
        usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
        durationMs: 1,
      };
    });

    const first = await runFeature275Pilot({ allowGeneration: true, rawRoot });
    expect(first).toMatchObject({
      complete: true,
      expectedCalls: 16,
      externalCallsThisRun: 16,
    });
    expect(runOneShotMock).toHaveBeenCalledTimes(16);

    runOneShotMock.mockClear();
    const resumed = await runFeature275Pilot({ allowGeneration: true, rawRoot });
    expect(resumed.externalCallsThisRun).toBe(0);
    expect(runOneShotMock).not.toHaveBeenCalled();

    const evidence = await readFile(
      path.join(rawRoot, 'pilot', 'main-session-review', 'evidence.json'),
      'utf8',
    );
    const reveal = await readFile(
      path.join(rawRoot, 'pilot', 'main-session-review', 'reveal.json'),
      'utf8',
    );
    expect(evidence).not.toContain('"arm"');
    expect(reveal).toContain('"A"');
    expect(reveal).toContain('"B"');
    expect(reveal).toContain('"C"');
  });
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
