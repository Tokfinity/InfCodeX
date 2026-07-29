import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModelAlias } from '../../harness/aliases.js';
import { MODEL_ALIASES } from '../../harness/aliases.js';

const runOneShotMock = vi.hoisted(() => vi.fn());

vi.mock('../../harness/harness.js', () => ({ runOneShot: runOneShotMock }));

import {
  buildFeature277RunManifest,
  runFeature277Pilot,
} from './runner.js';

describe('FEATURE_277 paid runner safety', () => {
  let rawRoot: string | undefined;
  const previousAllow = process.env.KODAX_F277_ALLOW_GENERATION;
  const previousAuthorization = process.env.KODAX_F277_AUTHORIZATION;

  afterEach(async () => {
    if (rawRoot !== undefined) await rm(rawRoot, { recursive: true, force: true });
    rawRoot = undefined;
    restore('KODAX_F277_ALLOW_GENERATION', previousAllow);
    restore('KODAX_F277_AUTHORIZATION', previousAuthorization);
    runOneShotMock.mockReset();
  });

  it('freezes production prompt, rendered cases, aliases, pricing, and scorer', () => {
    const manifest = buildFeature277RunManifest(
      path.join(os.tmpdir(), 'f277-manifest-test'),
    );

    expect(manifest.gitCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(manifest.exactBytes.classifierPromptSourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.exactBytes.renderedCasePromptsSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.exactBytes.scorerSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.authorization).toBe('pending-explicit-owner-approval');
  });

  it('runs four pilot calls, writes blinded evidence, and resumes', async () => {
    rawRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-f277-runner-'));
    process.env.KODAX_F277_ALLOW_GENERATION = '1';
    process.env.KODAX_F277_AUTHORIZATION = 'Zero-cost fake-provider unit test.';
    runOneShotMock.mockImplementation(async (
      alias: ModelAlias,
      input: { readonly userMessage: string },
    ) => {
      const confirm = input.userMessage.includes('collector.example');
      return {
        alias,
        target: MODEL_ALIASES[alias],
        text: confirm
          ? '<block>yes</block><reason>credential exfiltration conflicts with user intent</reason>'
          : '<block>no</block><reason>requested project edit is authorized</reason>',
        toolCalls: [],
        usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
        durationMs: 1,
      };
    });

    const first = await runFeature277Pilot({ allowGeneration: true, rawRoot });
    expect(first).toMatchObject({
      complete: true,
      expectedCalls: 4,
      externalCallsThisRun: 4,
    });
    expect(runOneShotMock).toHaveBeenCalledTimes(4);

    runOneShotMock.mockClear();
    const resumed = await runFeature277Pilot({ allowGeneration: true, rawRoot });
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
    expect(evidence).not.toContain('"expected"');
    expect(reveal).toContain('"allow"');
    expect(reveal).toContain('"confirm"');
  });
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
