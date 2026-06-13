/**
 * FEATURE_217 (v0.7.49) Phase G — generated workflow prompt + parser tests.
 */

import { describe, expect, it } from 'vitest';

import {
  buildWorkflowGenerationUserPrompt,
  generateWorkflow,
  validateGeneratedWorkflowSource,
} from './generator.js';

describe('buildWorkflowGenerationUserPrompt', () => {
  it('names the allowed WorkflowApi surface and pattern ids', () => {
    const prompt = buildWorkflowGenerationUserPrompt('rank 80 resumes');
    expect(prompt).toContain('wf.spawnAgent');
    expect(prompt).toContain('wf.parallel');
    expect(prompt).toContain('always wait or stop each handle');
    expect(prompt).toContain('fan-out-and-synthesize');
    expect(prompt).toContain('loop-until-done');
    expect(prompt).toContain('rank 80 resumes');
  });
});

describe('validateGeneratedWorkflowSource', () => {
  it('accepts a restricted run function', () => {
    const source = 'async function run(wf, args) { return args; }';
    expect(validateGeneratedWorkflowSource(source)).toBe(source);
  });

  it('rejects direct Node escape surfaces before VM execution', () => {
    expect(() =>
      validateGeneratedWorkflowSource('async function run() { return process.cwd(); }'),
    ).toThrow(/forbidden generated workflow token: process/);
    expect(() =>
      validateGeneratedWorkflowSource('async function run() { return require("fs"); }'),
    ).toThrow(/forbidden generated workflow token: require/);
  });
});

describe('generateWorkflow', () => {
  it('returns a decline decision from structured model output', async () => {
    const result = await generateWorkflow({
      request: 'rename one variable',
      generateText: async () =>
        JSON.stringify({
          action: 'decline',
          reason: 'A single agent can handle this task.',
        }),
    });

    expect(result).toEqual({
      kind: 'declined',
      reason: 'A single agent can handle this task.',
      rawText: '{"action":"decline","reason":"A single agent can handle this task."}',
    });
  });

  it('parses fenced JSON, validates manifest/source, and returns a restricted module', async () => {
    const result = await generateWorkflow({
      request: 'Compare three competing root-cause hypotheses and verify each one.',
      generateText: async () =>
        [
          '```json',
          JSON.stringify({
            action: 'generate',
            approvalSummary: 'Runs three read-only investigators and one synthesis pass.',
            manifest: {
              name: 'hypothesis-tournament',
              description: 'Compare hypotheses with independent checks.',
              phases: ['investigate', 'synthesize'],
              readOnly: true,
              maxAgents: 4,
              maxConcurrency: 3,
              tokenBudget: 10000,
              mayUseWorktree: false,
              patterns: ['fan-out-and-synthesize', 'adversarial-verification'],
            },
            source: 'async function run(wf, args) { return { request: args.request, runId: wf.runId }; }',
          }),
          '```',
        ].join('\n'),
    });

    expect(result.kind).toBe('generated');
    if (result.kind !== 'generated') return;
    expect(result.manifest.name).toBe('hypothesis-tournament');
    expect(result.scriptSnapshot.manifest.patterns).toEqual([
      'fan-out-and-synthesize',
      'adversarial-verification',
    ]);
    expect(result.approvalSummary).toContain('read-only investigators');
    const output = await result.module.run({ runId: 'run-1' } as never, { request: 'Q' });
    expect(output).toEqual({ request: 'Q', runId: 'run-1' });
  });

  it('fails closed on invalid generated source', async () => {
    await expect(
      generateWorkflow({
        request: 'do a complex thing',
        generateText: async () =>
          JSON.stringify({
            action: 'generate',
            manifest: {
              name: 'bad',
              description: 'bad',
              phases: ['run'],
              readOnly: true,
              maxAgents: 1,
              maxConcurrency: 1,
              patterns: ['fan-out-and-synthesize'],
            },
            source: 'async function run() { return process.cwd(); }',
          }),
      }),
    ).rejects.toThrow(/forbidden generated workflow token: process/);
  });
});
