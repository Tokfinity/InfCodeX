import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModelAlias } from '../../harness/aliases.js';
import { MODEL_ALIASES } from '../../harness/aliases.js';

const runOneShotMock = vi.hoisted(() => vi.fn());

vi.mock('../../harness/harness.js', () => ({ runOneShot: runOneShotMock }));

import {
  buildFeature274RunManifest,
  runFeature274Pilot,
} from './runner.js';

describe('FEATURE_274 paid runner safety', () => {
  let rawRoot: string | undefined;
  const previousAllow = process.env.KODAX_F274_ALLOW_GENERATION;
  const previousAuthorization = process.env.KODAX_F274_AUTHORIZATION;

  afterEach(async () => {
    if (rawRoot !== undefined) await rm(rawRoot, { recursive: true, force: true });
    rawRoot = undefined;
    restore('KODAX_F274_ALLOW_GENERATION', previousAllow);
    restore('KODAX_F274_AUTHORIZATION', previousAuthorization);
    runOneShotMock.mockReset();
  });

  it('freezes exact bytes and keeps static prompt growth within the registered cap', () => {
    const manifest = buildFeature274RunManifest(path.join(os.tmpdir(), 'f274-manifest-test'));
    expect(manifest.gitCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(manifest.exactBytes.promptByteDelta).toBeGreaterThan(0);
    expect(manifest.exactBytes.promptByteDelta).toBeLessThanOrEqual(3_000);
    expect(manifest.exactBytes.scorerSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('runs the eight-call pilot once and resumes without another provider call', async () => {
    rawRoot = await mkdtemp(path.join(os.tmpdir(), 'kodax-f274-runner-'));
    process.env.KODAX_F274_ALLOW_GENERATION = '1';
    process.env.KODAX_F274_AUTHORIZATION = 'Zero-cost fake-provider unit test.';
    runOneShotMock.mockImplementation(async (
      alias: ModelAlias,
      input: { readonly systemPrompt: string; readonly userMessage: string },
    ) => ({
      alias,
      target: MODEL_ALIASES[alias],
      text: 'Controlled fake response.',
      toolCalls: fakePolicyCalls(input.systemPrompt, input.userMessage),
      usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
      durationMs: 1,
    }));

    const first = await runFeature274Pilot({ allowGeneration: true, rawRoot });
    expect(first).toMatchObject({
      complete: true,
      expectedCalls: 8,
      externalCallsThisRun: 8,
    });
    expect(runOneShotMock).toHaveBeenCalledTimes(8);

    const experiment = JSON.parse(await readFile(
      path.join(rawRoot, 'experiment.json'),
      'utf8',
    )) as {
      readonly exactPayloads: {
        readonly candidateTools: ReadonlyArray<{ readonly name: string }>;
      };
    };
    const candidateToolNames = experiment.exactPayloads.candidateTools.map((tool) => tool.name);
    expect(candidateToolNames).toEqual(['read', 'edit', 'bash', 'spawn_agent']);
    expect(candidateToolNames).not.toContain('send_message');

    runOneShotMock.mockClear();
    const resumed = await runFeature274Pilot({ allowGeneration: true, rawRoot });
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
    expect(evidence).not.toContain('"arm":"baseline"');
    expect(evidence).not.toContain('"arm":"candidate"');
    expect(reveal).toContain('baseline');
    expect(reveal).toContain('candidate');
  });
});

function fakePolicyCalls(
  systemPrompt: string,
  userMessage: string,
): ReadonlyArray<{ readonly name: string; readonly input: unknown }> {
  const candidate = systemPrompt.includes('ADAPTIVE COLLABORATION PATTERNS');
  if (userMessage.includes('reusable Workflow')) {
    return [{
      name: 'run_workflow',
      input: {
        manifest: {
          patterns: ['fan-out-and-synthesize'],
        },
      },
    }];
  }
  if (!candidate) return [];
  if (userMessage.includes('CLI, SDK, and daemon')) {
    return ['cli', 'sdk'].map((scope) => ({
      name: 'spawn_agent',
      input: {
        task_name: scope,
        objective: `Review ${scope}`,
        quality_strategy: {
          schemaVersion: 1,
          stageId: 'coverage',
          pattern: 'fan-out-and-synthesize',
          role: 'investigator',
          laneRelation: 'coverage',
        },
      },
    }));
  }
  if (userMessage.includes('auth-boundary patch')) {
    return [{
      name: 'spawn_agent',
      input: {
        task_name: 'challenger',
        objective: 'Challenge the terminal candidate.',
        quality_strategy: {
          schemaVersion: 1,
          stageId: 'challenge',
          pattern: 'adversarial-verification',
          role: 'challenger',
          laneRelation: 'opposition',
          targetEvidenceRefs: ['agent-turn:/root/candidate#turn=turn-1'],
        },
      },
    }];
  }
  return [];
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
