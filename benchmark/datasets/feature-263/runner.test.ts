import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModelAlias } from '../../harness/aliases.js';
import { MODEL_ALIASES } from '../../harness/aliases.js';

const runOneShotMock = vi.hoisted(() => vi.fn());

vi.mock('../../harness/harness.js', () => ({ runOneShot: runOneShotMock }));

import {
  buildFeature263RunManifest,
  runFeature263Downstream,
  runFeature263ReviewerPilot,
} from './runner.js';

describe('FEATURE_263 paid runner safety', () => {
  let rawRoot: string | undefined;
  const previousAllow = process.env.KODAX_F263_ALLOW_GENERATION;
  const previousAuthorization = process.env.KODAX_F263_AUTHORIZATION;

  afterEach(async () => {
    if (rawRoot !== undefined) await rm(rawRoot, { recursive: true, force: true });
    rawRoot = undefined;
    restore('KODAX_F263_ALLOW_GENERATION', previousAllow);
    restore('KODAX_F263_AUTHORIZATION', previousAuthorization);
    runOneShotMock.mockReset();
  });

  it('freezes reviewer/action prompts, tool bytes, aliases, pricing, and scorer', async () => {
    const manifest = await buildFeature263RunManifest(
      path.join(os.tmpdir(), 'f263-manifest-test'),
    );

    expect(manifest.gitCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(manifest.exactBytes.learningReviewPromptSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.exactBytes.learningReviewToolSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.exactBytes.downstreamSystemPromptsSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.exactBytes.downstreamToolsSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.exactBytes.scorerSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.authorization).toBe('pending-explicit-owner-approval');
  });

  it('runs and resumes the four-call reviewer pilot with raw safety evidence', async () => {
    rawRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-f263-reviewer-'));
    authorize();
    runOneShotMock.mockImplementation(fakeFeature263Output);

    const first = await runFeature263ReviewerPilot({
      allowGeneration: true,
      rawRoot,
    });
    expect(first).toMatchObject({
      complete: true,
      expectedCalls: 4,
      externalCallsThisRun: 4,
    });
    expect(runOneShotMock).toHaveBeenCalledTimes(4);

    runOneShotMock.mockClear();
    const resumed = await runFeature263ReviewerPilot({
      allowGeneration: true,
      rawRoot,
    });
    expect(resumed.externalCallsThisRun).toBe(0);
    expect(runOneShotMock).not.toHaveBeenCalled();

    const evidence = await readFile(
      path.join(rawRoot, 'reviewer-pilot', 'main-session-review', 'evidence.json'),
      'utf8',
    );
    expect(evidence).toContain('"normalizedDisposition"');
    expect(evidence).not.toContain('super-secret-value');
  });

  it('writes 24 blinded downstream A/B calls with a separate reveal', async () => {
    rawRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-f263-downstream-'));
    authorize();
    runOneShotMock.mockImplementation(fakeFeature263Output);

    const result = await runFeature263Downstream({
      allowGeneration: true,
      rawRoot,
    });
    expect(result).toMatchObject({
      complete: true,
      expectedCalls: 24,
      externalCallsThisRun: 24,
    });

    const evidence = await readFile(
      path.join(rawRoot, 'downstream', 'main-session-review', 'evidence.json'),
      'utf8',
    );
    const reveal = await readFile(
      path.join(rawRoot, 'downstream', 'main-session-review', 'reveal.json'),
      'utf8',
    );
    expect(evidence).not.toContain('"arm"');
    expect(reveal).toContain('"control"');
    expect(reveal).toContain('"with_skill"');
  });
});

function authorize(): void {
  process.env.KODAX_F263_ALLOW_GENERATION = '1';
  process.env.KODAX_F263_AUTHORIZATION = 'Zero-cost fake-provider unit test.';
}

async function fakeFeature263Output(
  alias: ModelAlias,
  input: {
    readonly forcedToolName?: string;
    readonly userMessage: string;
  },
): Promise<object> {
  if (input.forcedToolName === 'commit_episode_learning_review') {
    const parsed = JSON.parse(input.userMessage) as {
      readonly memory: {
        readonly trigger: string;
        readonly sourceRefs: readonly string[];
        readonly candidateRefs: readonly unknown[];
      };
      readonly evidence: {
        readonly qualification: { readonly reusableMethodEvidence: boolean };
      };
    };
    const canary = parsed.evidence.qualification.reusableMethodEvidence
      && !input.userMessage.includes('[omitted: unsafe');
    return {
      alias,
      target: MODEL_ALIASES[alias],
      text: '',
      toolCalls: [{
        name: 'commit_episode_learning_review',
        input: {
          memoryPlan: {
            trigger: parsed.memory.trigger,
            createdAt: '2026-07-29T09:00:00.000Z',
            sourceRefs: parsed.memory.sourceRefs,
            candidateRefs: parsed.memory.candidateRefs,
            actions: [],
            warnings: [],
          },
          capabilityDecision: canary
            ? {
                disposition: 'project_canary',
                reasonCodes: ['reusable_verified_method'],
                operation: 'create',
                requestedScope: 'project',
                semanticDisposition: 'allow',
                spec: {
                  name: 'regenerate-client',
                  description: 'Use when regenerating the project client from its pinned schema.',
                  purpose: 'Regenerate and verify the project client.',
                  triggers: ['A pinned schema changed.'],
                  steps: ['Refresh the schema.', 'Regenerate the client.', 'Run compatibility tests.'],
                  verification: ['Confirm the focused compatibility test passes.'],
                  pitfalls: ['Do not change global configuration.'],
                },
              }
            : {
                disposition: 'ready',
                reasonCodes: ['insufficient_independent_verified_evidence'],
              },
        },
      }],
      usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
      durationMs: 1,
    };
  }
  return {
    alias,
    target: MODEL_ALIASES[alias],
    text: 'I will read the project package and focused validation before taking a bounded next action.',
    toolCalls: [{ name: 'read', input: { path: 'package.json' } }],
    usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
    durationMs: 1,
  };
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
