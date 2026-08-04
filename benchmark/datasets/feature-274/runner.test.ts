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
    expect(manifest.baselineCommit).toBe('2b5f75eb1b2b59977e9e207a89ea6df476b7364d');
    expect(manifest.candidatePromptCommit).toBe('25d5521e3eadc20ff1da2bd69d171736724bbcba');
    expect(manifest.exactBytes.baselineSystemPromptSha256)
      .toBe('e6619f99d6bfd9f773400884c6c303dd719f56e0823e8bf9e8f1d43cba9f0be7');
    expect(manifest.exactBytes.candidateSystemPromptSha256)
      .toBe('d86691a3731c84f1113f7ddd79d66505cc635dab6816506998660932c32b3d00');
    expect(manifest.exactBytes.promptByteDelta).toBe(2_425);
    expect(manifest.exactBytes.baselineToolsSha256)
      .toBe('a10e33b12c579d3b8020afec79a01e60a53995371a430348d367eb36c21eb188');
    expect(manifest.exactBytes.candidateToolsSha256)
      .toBe('2065c0b2321bd1b6c2ce4f1f4e3fc983c00b2c8a7eb7f187a10c64f2bb6e2adc');
    expect(manifest.exactBytes.baselineExplicitWorkflowToolsSha256)
      .toBe('b5ba23fdfd994bcd9c6ddbf2162c6f6668d342fbb31d8de9573cc5d52770cc36');
    expect(manifest.exactBytes.candidateExplicitWorkflowToolsSha256)
      .toBe('f615fd9c456ebb6689226225ce454c6bf0acef7f35db8bcddbc24587af43e53a');
    expect(manifest.exactBytes.verifierSystemPromptSha256)
      .toBe('c17200f7880e15f04251acaa1f331c621a5759685b054f76ef9417c4bf244103');
    expect(manifest.exactBytes.verifierToolSha256)
      .toBe('aebb9536fd70264b05863f935988098d5f8338e6d2e096278acd376f96757aec');
    expect(manifest.exactBytes.layer3LlmInputsSha256)
      .toBe('b93d220b5f317f6f4412904bc69c66a423c22860434da144793cab5b8a63ee59');
    expect(manifest.exactBytes.scorerSha256)
      .toBe('bafb9069e9162d2401fa7f1dc27680f28b13e5a9bfaca67c0019ad7f98699496');
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
    const systemPrompts = runOneShotMock.mock.calls.map((call) => (
      call[1] as { readonly systemPrompt: string }
    ).systemPrompt);
    expect(new Set(systemPrompts)).toHaveLength(2);
    expect(systemPrompts.filter((prompt) => (
      prompt.includes('ADAPTIVE COLLABORATION PATTERNS')
    ))).toHaveLength(4);
    expect(systemPrompts.every((prompt) => (
      !prompt.includes('PARALLEL-FIRST COLLABORATION')
    ))).toBe(true);

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
