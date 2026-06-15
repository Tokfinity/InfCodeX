/**
 * FEATURE_217 (v0.7.49) Phase G — generated workflow prompt + parser tests.
 */

import { describe, expect, it } from 'vitest';

import {
  buildWorkflowGenerationUserPrompt,
  DEFAULT_WORKFLOW_GENERATION_TIMEOUT_MS,
  generateWorkflow,
  resolveWorkflowGenerationTimeoutMs,
  validateGeneratedWorkflowSource,
} from './generator.js';

describe('buildWorkflowGenerationUserPrompt', () => {
  it('names the allowed WorkflowApi surface and pattern ids', () => {
    const prompt = buildWorkflowGenerationUserPrompt('rank 80 resumes');
    expect(prompt).toContain('wf.spawnAgent');
    expect(prompt).toContain('wf.parallel');
    expect(prompt).toContain('wf.runAgent/wf.wait return');
    expect(prompt).toContain('Never use a non-existent .output field');
    expect(prompt).toContain('Artifact-only or empty returns are invalid');
    expect(prompt).toContain('always wait or stop each handle');
    expect(prompt).toContain('lifetime total cap');
    expect(prompt).toContain('plannedAgents is the best estimate of how many child agents');
    expect(prompt).toContain('Do not set tokenBudget unless the user explicitly asks');
    expect(prompt).toContain('fan-out-and-synthesize');
    expect(prompt).toContain('loop-until-done');
    expect(prompt).toContain('rank 80 resumes');
  });

  it('asks generated workflows to preserve the request language in user-facing text', () => {
    const prompt = buildWorkflowGenerationUserPrompt('请用 workflow 检查 UI 回归');
    expect(prompt).toContain('Use the same natural language as the task request');
    expect(prompt).toContain('child agent prompts');
    expect(prompt).toContain('synthesis rubric');
  });

  it('does not ask child agents to emit workflow handoff marker blocks', () => {
    const prompt = buildWorkflowGenerationUserPrompt('review feature 217');
    expect(prompt).not.toContain('[workflow handoff]');
    expect(prompt).not.toContain('[/workflow handoff]');
    expect(prompt).toContain('KodaX derives child-agent transcript digests after each child finishes');
  });
});

describe('validateGeneratedWorkflowSource', () => {
  it('accepts a restricted run function', () => {
    const source = 'async function run(wf, args) { return { result: args }; }';
    expect(validateGeneratedWorkflowSource(source)).toBe(source);
  });

  it('accepts displayable returns that do not use whitelisted identifier names', () => {
    // Regression: an investigation workflow may return custom-named values.
    // These are displayable and must not be rejected by the build-time lint.
    const sources = [
      'async function run(wf) { const a = await wf.runAgent({ name: "a", prompt: "x" }); return a.finalText; }',
      'async function run(wf) { return { findings: [], recommendations: [] }; }',
      'async function run(wf) { const r = await wf.synthesize({ inputs: [], rubric: "x" }); return r.text; }',
      'async function run(wf) { return await wf.synthesize({ inputs: [], rubric: "x" }); }',
    ];
    for (const source of sources) {
      expect(validateGeneratedWorkflowSource(source)).toBe(source);
    }
  });

  it('rejects direct Node escape surfaces before VM execution', () => {
    expect(() =>
      validateGeneratedWorkflowSource('async function run() { return process.cwd(); }'),
    ).toThrow(/forbidden generated workflow token: process/);
    expect(() =>
      validateGeneratedWorkflowSource('async function run() { return require("fs"); }'),
    ).toThrow(/forbidden generated workflow token: require/);
  });

  it('rejects workflow API result misuse that would hide final output', () => {
    expect(() =>
      validateGeneratedWorkflowSource('async function run(wf) { const r = await wf.runAgent({ name: "a", prompt: "x" }); return { synthesis: r.output }; }'),
    ).toThrow(/finalText\/text/);
    expect(() =>
      validateGeneratedWorkflowSource('async function run(wf) { wf.artifact("report", { text: "x" }); return { synthesis: "x" }; }'),
    ).toThrow(/await wf\.artifact/);
    expect(() =>
      validateGeneratedWorkflowSource('async function run(wf) { await wf.runAgent({ name: "a", prompt: "x" }); }'),
    ).toThrow(/return displayable final text/);
    expect(() =>
      validateGeneratedWorkflowSource('async function run(wf) { await wf.phase("synthesize", async () => { return { synthesis: "hidden" }; }); }'),
    ).toThrow(/outer run function/);
    expect(() =>
      validateGeneratedWorkflowSource('async function run(wf) { return await wf.phase("synthesize", async () => { await wf.runAgent({ name: "a", prompt: "x" }); }); }'),
    ).toThrow(/outer run function/);
  });
});

describe('resolveWorkflowGenerationTimeoutMs', () => {
  it('uses a workflow-specific default timeout', () => {
    expect(resolveWorkflowGenerationTimeoutMs({})).toBe(DEFAULT_WORKFLOW_GENERATION_TIMEOUT_MS);
  });

  it('accepts a positive integer override from env', () => {
    expect(resolveWorkflowGenerationTimeoutMs({ KODAX_WORKFLOW_GENERATION_TIMEOUT_MS: '45000' })).toBe(45000);
  });

  it('falls back to the default for invalid env values', () => {
    expect(resolveWorkflowGenerationTimeoutMs({ KODAX_WORKFLOW_GENERATION_TIMEOUT_MS: '0' })).toBe(DEFAULT_WORKFLOW_GENERATION_TIMEOUT_MS);
    expect(resolveWorkflowGenerationTimeoutMs({ KODAX_WORKFLOW_GENERATION_TIMEOUT_MS: 'nope' })).toBe(DEFAULT_WORKFLOW_GENERATION_TIMEOUT_MS);
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
              plannedAgents: 4,
              maxAgents: 4,
              maxConcurrency: 3,
              tokenBudget: 10000,
              mayUseWorktree: false,
              patterns: ['fan-out-and-synthesize', 'adversarial-verification'],
            },
            source: 'async function run(wf, args) { return { synthesis: String(args.request || ""), runId: wf.runId }; }',
          }),
          '```',
        ].join('\n'),
    });

    expect(result.kind).toBe('generated');
    if (result.kind !== 'generated') return;
    expect(result.manifest.name).toBe('hypothesis-tournament');
    expect(result.manifest.plannedAgents).toBe(4);
    expect(result.module.meta.plannedAgents).toBe(4);
    expect(result.scriptSnapshot.manifest.patterns).toEqual([
      'fan-out-and-synthesize',
      'adversarial-verification',
    ]);
    expect(result.approvalSummary).toContain('read-only investigators');
    const output = await result.module.run({ runId: 'run-1' } as never, { request: 'Q' });
    expect(output).toEqual({ synthesis: 'Q', runId: 'run-1' });
  });

  it('canonicalizes common generated phases shapes before manifest validation', async () => {
    const objectPhaseResult = await generateWorkflow({
      request: 'Create a workflow to compare three optimization hypotheses.',
      generateText: async () => JSON.stringify({
        action: 'generate',
        manifest: {
          name: 'optimization-hypotheses',
          description: 'Compare optimization hypotheses.',
          phases: [
            { name: 'hypothesize' },
            { title: 'verify' },
            { phase: 'synthesize' },
          ],
          readOnly: true,
          maxAgents: 4,
          maxConcurrency: 3,
          patterns: ['fan-out-and-synthesize'],
        },
        source: 'async function run(wf, args) { return { synthesis: String(args.request || "") }; }',
      }),
    });

    expect(objectPhaseResult.kind).toBe('generated');
    if (objectPhaseResult.kind !== 'generated') return;
    expect(objectPhaseResult.manifest.phases).toEqual(['hypothesize', 'verify', 'synthesize']);

    const stringPhaseResult = await generateWorkflow({
      request: 'Create a workflow to compare three optimization hypotheses.',
      generateText: async () => JSON.stringify({
        action: 'generate',
        manifest: {
          name: 'optimization-hypotheses',
          description: 'Compare optimization hypotheses.',
          phases: 'hypothesize -> verify -> synthesize',
          readOnly: true,
          maxAgents: 4,
          maxConcurrency: 3,
          patterns: ['fan-out-and-synthesize'],
        },
        source: 'async function run(wf, args) { return { synthesis: String(args.request || "") }; }',
      }),
    });

    expect(stringPhaseResult.kind).toBe('generated');
    if (stringPhaseResult.kind !== 'generated') return;
    expect(stringPhaseResult.manifest.phases).toEqual(['hypothesize', 'verify', 'synthesize']);
  });

  it('reserves enough maxAgents capacity for generated multi-phase fan-out scripts', async () => {
    const result = await generateWorkflow({
      request: 'Audit a large feature with several parallel reviewers and synthesize.',
      generateText: async () => JSON.stringify({
        action: 'generate',
        manifest: {
          name: 'feature-audit',
          description: 'Audit a feature with fan-out reviewers.',
          phases: ['inventory', 'fan-out', 'cross-check', 'synthesize'],
          readOnly: true,
          maxAgents: 8,
          maxConcurrency: 4,
          patterns: ['fan-out-and-synthesize'],
        },
        source: [
          'async function run(wf, args) {',
          '  await wf.phase("inventory", async () => { await wf.runAgent({ name: "inventory", prompt: String(args.request), readOnly: true }); });',
          '  await wf.phase("fan-out", async () => { await wf.parallel([1,2,3,4,5].map((n) => () => wf.runAgent({ name: "auditor-" + n, prompt: "audit", readOnly: true })), { concurrency: 4 }); });',
          '  await wf.phase("cross-check", async () => { await wf.parallel([1,2,3].map((n) => () => wf.runAgent({ name: "cross-" + n, prompt: "check", readOnly: true })), { concurrency: 3 }); });',
          '  const synthesis = await wf.phase("synthesize", async () => wf.synthesize({ inputs: "all", rubric: "summarize" }));',
          '  await wf.artifact("final-report", { summary: synthesis.text });',
          '  return { synthesis: synthesis.text };',
          '}',
        ].join('\n'),
      }),
    });

    expect(result.kind).toBe('generated');
    if (result.kind !== 'generated') return;
    expect(result.manifest.maxAgents).toBe(18);
    expect(result.module.meta.maxAgents).toBe(18);
    expect(result.scriptSnapshot.manifest.maxAgents).toBe(18);
  });

  it('strips unsolicited token budgets from generated workflows', async () => {
    const result = await generateWorkflow({
      request: 'Audit a large feature with several parallel reviewers and synthesize.',
      generateText: async () => JSON.stringify({
        action: 'generate',
        manifest: {
          name: 'feature-audit',
          description: 'Audit a feature with fan-out reviewers.',
          phases: ['fan-out', 'synthesize'],
          readOnly: true,
          maxAgents: 4,
          maxConcurrency: 2,
          tokenBudget: 200_000,
          patterns: ['fan-out-and-synthesize'],
        },
        source: 'async function run(wf, args) { return { synthesis: String(args.request || "") }; }',
      }),
    });

    expect(result.kind).toBe('generated');
    if (result.kind !== 'generated') return;
    expect(result.manifest.tokenBudget).toBeUndefined();
    expect(result.module.meta.tokenBudget).toBeUndefined();
    expect(result.scriptSnapshot.manifest.tokenBudget).toBeUndefined();
  });

  it('keeps token budgets when the request explicitly asks for one', async () => {
    const result = await generateWorkflow({
      request: 'Audit a large feature with several reviewers. Use a 200k token budget.',
      generateText: async () => JSON.stringify({
        action: 'generate',
        manifest: {
          name: 'budgeted-feature-audit',
          description: 'Audit a feature with a requested token budget.',
          phases: ['fan-out', 'synthesize'],
          readOnly: true,
          maxAgents: 4,
          maxConcurrency: 2,
          tokenBudget: 200_000,
          patterns: ['fan-out-and-synthesize'],
        },
        source: 'async function run(wf, args) { return { synthesis: String(args.request || "") }; }',
      }),
    });

    expect(result.kind).toBe('generated');
    if (result.kind !== 'generated') return;
    expect(result.manifest.tokenBudget).toBe(200_000);
    expect(result.module.meta.tokenBudget).toBe(200_000);
    expect(result.scriptSnapshot.manifest.tokenBudget).toBe(200_000);
  });

  it('repairs a manifest validation error once before failing the builder', async () => {
    const calls: string[] = [];
    const result = await generateWorkflow({
      request: 'Create a workflow to compare three optimization hypotheses.',
      generateText: async ({ prompt }) => {
        calls.push(prompt);
        if (calls.length === 1) {
          return JSON.stringify({
            action: 'generate',
            manifest: {
              name: 'optimization-hypotheses',
              description: 'Compare optimization hypotheses.',
              phases: ['hypothesize', 'verify', 'synthesize'],
              readOnly: 'true',
              maxAgents: 4,
              maxConcurrency: 3,
              patterns: ['fan-out-and-synthesize'],
            },
            source: 'async function run(wf, args) { return { synthesis: String(args.request || "") }; }',
          });
        }
        return JSON.stringify({
          action: 'generate',
          manifest: {
            name: 'optimization-hypotheses',
            description: 'Compare optimization hypotheses.',
            phases: ['hypothesize', 'verify', 'synthesize'],
            readOnly: true,
            maxAgents: 4,
            maxConcurrency: 3,
            patterns: ['fan-out-and-synthesize'],
          },
          source: 'async function run(wf, args) { return { synthesis: String(args.request || "") }; }',
        });
      },
    });

    expect(result.kind).toBe('generated');
    if (result.kind !== 'generated') return;
    expect(result.manifest.phases).toEqual(['hypothesize', 'verify', 'synthesize']);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('Validation error: workflow manifest readOnly must be a boolean');
    expect(calls[1]).toContain('Return corrected JSON only');
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
