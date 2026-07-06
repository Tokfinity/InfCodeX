/**
 * FEATURE_217 (v0.7.49) Phase G — generated workflow prompt + parser tests.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';
import { resetSkillRegistry } from '@kodax-ai/agent';

import {
  buildWorkflowGenerationSkillContext,
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
    expect(prompt).toContain('wf.snapshot(taskId)');
    expect(prompt).toContain('wf.runAgent/wf.wait return');
    expect(prompt).toContain('verification');
    expect(prompt).toContain('wf.snapshot returns');
    expect(prompt).not.toContain('wf.output(taskId)');
    expect(prompt).toContain('never use anyVariable.output');
    expect(prompt).toContain('Artifact-only or empty returns are invalid');
    expect(prompt).toContain('always wait or stop each handle');
    expect(prompt).toContain('lifetime total cap');
    expect(prompt).toContain('plannedAgents is the best estimate of how many child agents');
    expect(prompt).toContain('Do not set tokenBudget unless the user explicitly asks');
    expect(prompt).toContain('File-writing/implementation requests are not report-only workflows');
    expect(prompt).toContain('Prefer shared-cwd for write children');
    expect(prompt).toContain('Do not hardcode task IDs');
    expect(prompt).toContain('Correct fan-out result pattern');
    expect(prompt).toContain('reference child results as "task_id:" + result.taskId');
    expect(prompt).toContain('fan-out-and-synthesize');
    expect(prompt).toContain('loop-until-done');
    expect(prompt).toContain('Pattern selection guidance');
    expect(prompt).toContain('Do not collapse independent investigation');
    expect(prompt).toContain('rank 80 resumes');
  });

  it('includes a canonical source pattern with finalText/text result fields', () => {
    const prompt = buildWorkflowGenerationUserPrompt('audit workflow contracts');
    expect(prompt).toContain('Minimal source field-usage example');
    expect(prompt).toContain('first.finalText');
    expect(prompt).toContain('second.finalText');
    expect(prompt).toContain('const finalText = synthesis.text');
    expect(prompt).toContain('return { synthesis: finalText }');
  });

  it('teaches that a declared outputSchema arrives on result.structured, not the top-level result', () => {
    // Regression: an AMAW/embedder-generated reviewer panel declared outputSchema
    // correctly but read the fields off the top-level result (result.summary/
    // result.findings), which are undefined → an empty report. The prompt must
    // teach reading them off result.structured, matching the run_workflow tool
    // description (single source of truth for the wording).
    const prompt = buildWorkflowGenerationUserPrompt('review the diff from multiple angles');
    expect(prompt).toContain('outputSchema');
    expect(prompt).toContain('result.structured');
    expect(prompt).toContain('result.structured.findings');
    expect(prompt).toContain('not on the top-level result');
    // The structured worked example declares a schema and reads it back correctly.
    expect(prompt).toContain('Structured-output example');
    expect(prompt).toContain('reviewer.structured');
  });

  it('includes a canonical write-and-verify workflow pattern', () => {
    const prompt = buildWorkflowGenerationUserPrompt('落地 feature 文件并实现代码');
    expect(prompt).toContain('Canonical write-and-verify pattern');
    expect(prompt).toContain('readOnly: false');
    expect(prompt).toContain('requiresMutation: true');
    expect(prompt).toContain('requiredChangedPaths');
    expect(prompt).toContain('rejectPreparatoryFinalText: true');
    expect(prompt).toContain('Never put placeholder paths');
    expect(prompt).not.toContain('requiredChangedPaths: ["docs/features/vNEXT.md"');
    expect(prompt).not.toContain('minFinalTextChars: 80');
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

  it('includes expanded referenced skill instructions as authoritative workflow context', () => {
    const prompt = buildWorkflowGenerationUserPrompt(
      'Use /skill:feature-list-tracker to register the feature',
      '<skill name="feature-list-tracker">\nCreate/update docs/features/v{VERSION}.md\n</skill>',
    );
    expect(prompt).toContain('Referenced skill instructions (authoritative)');
    expect(prompt).toContain('Create/update docs/features/v{VERSION}.md');
    expect(prompt).toContain('Preserve skill-specific file layout, naming, and process requirements');
    expect(prompt).toContain('Do not replace concrete skill requirements with vague paths');
  });
});

describe('buildWorkflowGenerationSkillContext', () => {
  it('expands inline skill references from the workflow project root', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'kodax-workflow-skill-'));
    try {
      const skillDir = join(tempDir, '.kodax', 'skills', 'feature-list-tracker');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        [
          '---',
          'name: feature-list-tracker',
          'description: Track features with FEATURE_LIST.md.',
          '---',
          '',
          '# Feature List Tracker',
          '',
          'Create/update design document at `docs/features/v{VERSION}.md`.',
        ].join('\n'),
        'utf8',
      );

      const skillContext = await buildWorkflowGenerationSkillContext(
        'Create a workflow using /skill:feature-list-tracker',
        { context: { gitRoot: tempDir, executionCwd: tempDir } },
      );

      expect(skillContext).toContain('<skill name="feature-list-tracker"');
      expect(skillContext).toContain('Skill root:');
      expect(skillContext).toContain('docs/features/v{VERSION}.md');
    } finally {
      resetSkillRegistry();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('uses executionCwd as the project root fallback when gitRoot is null', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'kodax-workflow-skill-cwd-'));
    try {
      const skillDir = join(tempDir, '.kodax', 'skills', 'feature-list-tracker');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        [
          '---',
          'name: feature-list-tracker',
          'description: Track features with FEATURE_LIST.md.',
          '---',
          '',
          '# Feature List Tracker',
          '',
          'Use `docs/FEATURE_LIST.md` as the authoritative feature ledger.',
        ].join('\n'),
        'utf8',
      );

      const skillContext = await buildWorkflowGenerationSkillContext(
        'Create a workflow using /skill:feature-list-tracker',
        { context: { gitRoot: null, executionCwd: tempDir } },
      );

      expect(skillContext).toContain('<skill name="feature-list-tracker"');
      expect(skillContext).toContain('docs/FEATURE_LIST.md');
    } finally {
      resetSkillRegistry();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('expands bare slash skill references only when the registry knows the skill', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'kodax-workflow-bare-skill-'));
    try {
      const skillDir = join(tempDir, '.kodax', 'skills', 'feature-list-tracker');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(
        join(skillDir, 'SKILL.md'),
        [
          '---',
          'name: feature-list-tracker',
          'description: Track features with FEATURE_LIST.md.',
          '---',
          '',
          'Use `docs/features/v{VERSION}.md` as the design document.',
        ].join('\n'),
        'utf8',
      );

      const skillContext = await buildWorkflowGenerationSkillContext(
        'Create a workflow using /feature-list-tracker and ignore /kodax-test-not-a-skill-236.',
        { context: { gitRoot: tempDir, executionCwd: tempDir } },
      );

      expect(skillContext).toContain('<skill name="feature-list-tracker"');
      expect(skillContext).not.toContain('<skill name="kodax-test-not-a-skill-236"');
    } finally {
      resetSkillRegistry();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('fails closed for explicit unknown /skill references', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'kodax-workflow-missing-skill-'));
    try {
      await expect(
        buildWorkflowGenerationSkillContext(
          'Create a workflow using /skill:kodax-test-definitely-missing-236.',
          { context: { gitRoot: tempDir, executionCwd: tempDir } },
        ),
      ).rejects.toThrow('workflow generation referenced unknown skill "kodax-test-definitely-missing-236"');
    } finally {
      resetSkillRegistry();
      rmSync(tempDir, { recursive: true, force: true });
    }
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
      'async function run(wf) { return await wf.phase("synthesize", async () => { return await wf.synthesize({ inputs: [], rubric: "x" }); }); }',
      'async function run(wf) { const finalText = "done"; const ref = await wf.artifact("final-report", { report: finalText }); return { report: finalText, artifact: ref.name }; }',
      'async function run(wf) { const handle = await wf.spawnAgent({ name: "a", prompt: "x" }); const r = await wf.wait(`${handle.taskId}`); return { synthesis: r.finalText }; }',
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
    // Space process.cwd report: `globalThis["process"]` smuggles a stripped
    // string key past the `process` token check, then crashes cryptically at
    // runtime. Reject computed globalThis[...] access at generation instead.
    expect(() =>
      validateGeneratedWorkflowSource('async function run() { return globalThis["process"].cwd(); }'),
    ).toThrow(/forbidden generated workflow token: globalThis-index/);
    // Dot access to a determinism-guarded global stays allowed (bracket-only ban).
    expect(validateGeneratedWorkflowSource('async function run() { return globalThis.Math.max(1, 2); }')).toContain(
      'globalThis.Math',
    );
    // Space run-mr4qvtbw: `process.cwd()` hidden inside a template ${...}
    // interpolation. The stripper must scan interpolation code, not blank it.
    expect(() =>
      validateGeneratedWorkflowSource('async function run() { return `scope ${process.cwd()}`; }'),
    ).toThrow(/forbidden generated workflow token: process/);
  });

  it('scans template ${...} interpolations but still ignores template prose', () => {
    // Prose inside the template text (outside ${...}) is not code → allowed.
    const proseOk = 'async function run(wf) { return `We process events and require review of ${wf.runId}`; }';
    expect(validateGeneratedWorkflowSource(proseOk)).toBe(proseOk);
    // A forbidden token inside the interpolation itself is real code → rejected.
    expect(() =>
      validateGeneratedWorkflowSource('async function run() { return `x ${require("fs")}`; }'),
    ).toThrow(/forbidden generated workflow token: require/);
  });

  it('allows forbidden-token words inside prompts and rubrics', () => {
    const source = [
      'async function run(wf) {',
      '  const result = await wf.runAgent({',
      '    name: "process-reviewer",',
      '    prompt: "Review Workflow Process Events and output formatting.",',
      '    readOnly: true',
      '  });',
      '  const synthesis = await wf.synthesize({',
      '    inputs: [result.finalText],',
      '    rubric: "Explain process risks without using raw child output."',
      '  });',
      '  return { synthesis: synthesis.text };',
      '}',
    ].join('\n');

    expect(validateGeneratedWorkflowSource(source)).toBe(source);
  });

  it('rejects syntactically invalid generated JavaScript before launching a run', () => {
    const source = [
      'async function run(wf) {',
      '  const synthesis = await wf.synthesize({',
      '    inputs: [],',
      '    rubric: "line one',
      'line two"',
      '  });',
      '  return { synthesis: synthesis.text };',
      '}',
    ].join('\n');

    expect(() => validateGeneratedWorkflowSource(source)).toThrow(/invalid JavaScript syntax/);
  });

  it('appends an escape-the-quote hint when an unescaped apostrophe breaks a prompt string', () => {
    // The exact author mistake seen in dogfooding: a single-quoted prompt string
    // with an apostrophe inside ("...the refactor's impact") closes early and V8
    // reports a bare "Unexpected identifier". The retry hint must name the cause.
    const source =
      "async function run(wf) { await wf.runAgent({ name: 'a', prompt: 'review the refactor's impact' }); return { synthesis: 'x' }; }";
    expect(() => validateGeneratedWorkflowSource(source)).toThrow(/invalid JavaScript syntax/);
    expect(() => validateGeneratedWorkflowSource(source)).toThrow(/unescaped quote or apostrophe/);
  });

  it('rejects workflow API result misuse that would hide final output', () => {
    expect(() =>
      validateGeneratedWorkflowSource('async function run(wf) { const r = await wf.runAgent({ name: "a", prompt: "x" }); return { synthesis: r.output }; }'),
    ).toThrow(/finalText\/text/);
    expect(() =>
      validateGeneratedWorkflowSource('async function run(wf) { const snap = await wf.output("task-1"); return { status: snap.status }; }'),
    ).toThrow(/wf\.snapshot\(taskId\)/);
    expect(() =>
      validateGeneratedWorkflowSource('async function run(wf) { const r = await wf.wait("task-1"); return { synthesis: r.finalText }; }'),
    ).toThrow(/taskId variables/);
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
    expect(() =>
      validateGeneratedWorkflowSource('async function run(wf) { const ref = await wf.artifact("final-report", { report: "x" }); return ref; }'),
    ).toThrow(/return displayable final text/);
  });
});

describe('resolveWorkflowGenerationTimeoutMs', () => {
  it('uses a workflow-specific default timeout', () => {
    expect(resolveWorkflowGenerationTimeoutMs({})).toBe(DEFAULT_WORKFLOW_GENERATION_TIMEOUT_MS);
  });

  it('accepts a positive integer override from env', () => {
    expect(resolveWorkflowGenerationTimeoutMs({ KODAX_WORKFLOW_GENERATION_TIMEOUT_MS: '45000' })).toBe(45000);
  });

  it('accepts a positive seconds override from env', () => {
    expect(resolveWorkflowGenerationTimeoutMs({ KODAX_WORKFLOW_GENERATION_TIMEOUT_SEC: '300' })).toBe(300000);
  });

  it('prefers SDK workflow timeout config over env', () => {
    expect(resolveWorkflowGenerationTimeoutMs(
      { KODAX_WORKFLOW_GENERATION_TIMEOUT_SEC: '300' },
      { workflow: { generationTimeoutSec: 600 } },
    )).toBe(600000);
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
              patterns: ['fan-out-and-synthesize'],
            },
            source: 'async function run(wf, args) { return { synthesis: String(args.request || "Compare three competing root-cause hypotheses and verify each one."), runId: wf.runId }; }',
          }),
          '```',
        ].join('\n'),
    });

    expect(result.kind).toBe('generated');
    if (result.kind !== 'generated') return;
    expect(result.manifest.name).toBe('hypothesis-tournament');
    expect(result.manifest.plannedAgents).toBe(4);
    expect(result.module.meta.plannedAgents).toBe(4);
    expect(result.scriptSnapshot.manifest.patterns).toEqual(['fan-out-and-synthesize']);
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
        source: 'async function run(wf, args) { return { synthesis: String(args.request || "Compare three optimization hypotheses.") }; }',
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
        source: 'async function run(wf, args) { return { synthesis: String(args.request || "Compare three optimization hypotheses.") }; }',
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
          patterns: ['fan-out-and-synthesize', 'adversarial-verification'],
        },
        source: [
          'async function run(wf, args) {',
          '  await wf.phase("inventory", async () => { await wf.runAgent({ name: "inventory", prompt: String(args.request), readOnly: true }); });',
          '  const reviews = await wf.phase("fan-out", async () => wf.parallel([1,2,3,4,5].map((n) => () => wf.runAgent({ name: "auditor-" + n, prompt: "Audit feature area " + n + " for concrete bugs.", readOnly: true })), { concurrency: 4 }));',
          '  const verified = await wf.phase("cross-check", async () => wf.parallel(reviews.filter(Boolean).slice(0, 3).map((review, n) => () => wf.runAgent({ name: "adversarial-verifier-" + n, prompt: "Try to refute this audit finding before synthesis:\\n" + review.finalText, readOnly: true, evidenceRefs: ["task_id:" + review.taskId] })), { concurrency: 3 }));',
          '  const synthesis = await wf.phase("synthesize", async () => wf.synthesize({ inputs: verified.filter(Boolean).map((result) => result.finalText), rubric: "Summarize confirmed, refuted, and uncertain audit findings." }));',
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
        source: 'async function run(wf, args) { return { synthesis: String(args.request || "Audit a large feature with several parallel reviewers and synthesize.") }; }',
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
        source: 'async function run(wf, args) { return { synthesis: String(args.request || "Audit a large feature with several reviewers.") }; }',
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
            source: 'async function run(wf, args) { return { synthesis: String(args.request || "Compare three optimization hypotheses.") }; }',
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
          source: 'async function run(wf, args) { return { synthesis: String(args.request || "Compare three optimization hypotheses.") }; }',
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

  it('feeds source validation errors back for multiple repair attempts', async () => {
    const calls: string[] = [];
    const manifest = {
      name: 'source-repair-audit',
      description: 'Repair invalid generated source.',
      phases: ['inspect', 'synthesize'],
      readOnly: true,
      maxAgents: 3,
      maxConcurrency: 2,
      patterns: ['fan-out-and-synthesize'],
    };

    const result = await generateWorkflow({
      request: 'Create a workflow to audit source contracts.',
      generateText: async ({ prompt }) => {
        calls.push(prompt);
        const source = calls.length < 3
          ? 'async function run(wf) { const r = await wf.runAgent({ name: "a", prompt: "x" }); return { synthesis: r.output }; }'
          : 'async function run(wf) { const r = await wf.runAgent({ name: "a", prompt: "x" }); return { synthesis: r.finalText }; }';
        return JSON.stringify({
          action: 'generate',
          manifest,
          source,
        });
      },
    });

    expect(result.kind).toBe('generated');
    expect(calls).toHaveLength(3);
    expect(calls[1]).toContain('Repair attempt: 2 of 3');
    expect(calls[2]).toContain('Repair attempt: 3 of 3');
    expect(calls[2]).toContain('Validation error: workflow generation source must use finalText/text');
    expect(calls[2]).toContain('Replace result.output from wf.runAgent');
    expect(calls[2]).not.toContain('Replace wf.output(taskId) with wf.snapshot(taskId)');
  });

  it('only mentions the legacy wf.output alias in repair prompts when that call was used', async () => {
    const calls: string[] = [];
    const manifest = {
      name: 'snapshot-repair-audit',
      description: 'Repair legacy snapshot calls.',
      phases: ['inspect'],
      readOnly: true,
      maxAgents: 1,
      maxConcurrency: 1,
      patterns: ['classify-and-act'],
    };

    const result = await generateWorkflow({
      request: 'Create a workflow to inspect a running task snapshot.',
      generateText: async ({ prompt }) => {
        calls.push(prompt);
        const source = calls.length === 1
          ? 'async function run(wf) { const snap = await wf.output("task-1"); return { status: snap.status }; }'
          : [
              'async function run(wf) {',
              '  const handle = await wf.spawnAgent({ name: "reader", prompt: "Inspect the task.", readOnly: true });',
              '  const snap = await wf.snapshot(handle.taskId);',
              '  const result = await wf.wait(handle.taskId);',
              '  return { status: snap.status, synthesis: result.finalText };',
              '}',
            ].join('\n');
        return JSON.stringify({
          action: 'generate',
          manifest,
          source,
        });
      },
    });

    expect(result.kind).toBe('generated');
    expect(calls).toHaveLength(2);
    expect(calls[0]).not.toContain('wf.output(taskId)');
    expect(calls[1]).toContain('Validation error: workflow generation source must use wf.snapshot(taskId)');
    expect(calls[1]).toContain('Replace wf.output(taskId) with wf.snapshot(taskId)');
  });

  it('repairs generated source that used a multiline ordinary string literal', async () => {
    const calls: string[] = [];
    const manifest = {
      name: 'multiline-rubric-audit',
      description: 'Repair a multiline rubric string.',
      phases: ['synthesize'],
      readOnly: true,
      maxAgents: 1,
      maxConcurrency: 1,
      patterns: ['fan-out-and-synthesize'],
    };

    const result = await generateWorkflow({
      request: 'Create a workflow with a structured final report rubric.',
      generateText: async ({ prompt }) => {
        calls.push(prompt);
        const source = calls.length === 1
          ? [
              'async function run(wf) {',
              '  const synthesis = await wf.synthesize({',
              '    inputs: [],',
              '    rubric: "line one',
              'line two"',
              '  });',
              '  return { synthesis: synthesis.text };',
              '}',
            ].join('\n')
          : [
              'async function run(wf) {',
              '  const synthesis = await wf.synthesize({',
              '    inputs: [],',
              '    rubric: `line one',
              'line two`',
              '  });',
              '  return { synthesis: synthesis.text };',
              '}',
            ].join('\n');
        return JSON.stringify({
          action: 'generate',
          manifest,
          source,
        });
      },
    });

    expect(result.kind).toBe('generated');
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('Validation error: workflow generation source has invalid JavaScript syntax');
  });

  it('repairs generated source that fails safe smoke validation', async () => {
    const calls: string[] = [];
    const manifest = {
      name: 'smoke-repair-audit',
      description: 'Repair a harness that fails before child launch.',
      phases: ['inspect'],
      readOnly: true,
      maxAgents: 1,
      maxConcurrency: 1,
      patterns: ['classify-and-act'],
    };

    const result = await generateWorkflow({
      request: 'Create a workflow to inspect an implementation.',
      generateText: async ({ prompt }) => {
        calls.push(prompt);
        const source = calls.length === 1
          ? [
              'async function run(wf) {',
              '  const result = await wf.runAgent({ name: "reader" });',
              '  return { synthesis: result.finalText };',
              '}',
            ].join('\n')
          : [
              'async function run(wf) {',
              '  const result = await wf.runAgent({ name: "reader", prompt: "Inspect the implementation.", readOnly: true });',
              '  return { synthesis: result.finalText };',
              '}',
            ].join('\n');
        return JSON.stringify({
          action: 'generate',
          manifest,
          source,
        });
      },
    });

    expect(result.kind).toBe('generated');
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('Validation error: workflow generation source failed safe smoke validation');
    expect(calls[1]).toContain('wrong wf.* argument shapes');
  });

  it('repairs generated source that waits for agent names after runAgent fan-out', async () => {
    const calls: string[] = [];
    const manifest = {
      name: 'fanout-name-wait-repair',
      description: 'Repair a fan-out workflow that waited on agent names.',
      phases: ['investigate', 'synthesize'],
      readOnly: true,
      maxAgents: 3,
      maxConcurrency: 2,
      patterns: ['fan-out-and-synthesize'],
    };

    const result = await generateWorkflow({
      request: 'Create a workflow to compare two independent reports and synthesize.',
      generateText: async ({ prompt }) => {
        calls.push(prompt);
        const source = calls.length === 1
          ? [
              'async function run(wf) {',
              '  await wf.phase("investigate", async () => {',
              '    await wf.parallel([',
              '      () => wf.runAgent({ name: "reader-a", prompt: "Read A", readOnly: true }),',
              '      () => wf.runAgent({ name: "reader-b", prompt: "Read B", readOnly: true })',
              '    ], { concurrency: 2 });',
              '  });',
              '  const readerA = await wf.wait("reader-a");',
              '  return { synthesis: readerA.finalText };',
              '}',
            ].join('\n')
          : [
              'async function run(wf) {',
              '  const [readerA, readerB] = await wf.phase("investigate", async () => wf.parallel([',
              '    () => wf.runAgent({ name: "reader-a", prompt: "Read A", readOnly: true }),',
              '    () => wf.runAgent({ name: "reader-b", prompt: "Read B", readOnly: true })',
              '  ], { concurrency: 2 }));',
              '  const synthesis = await wf.synthesize({',
              '    inputs: [readerA.finalText, readerB.finalText],',
              '    rubric: "Synthesize the independent reports."',
              '  });',
              '  return { synthesis: synthesis.text };',
              '}',
            ].join('\n');
        return JSON.stringify({
          action: 'generate',
          manifest,
          source,
        });
      },
    });

    expect(result.kind).toBe('generated');
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('Validation error: workflow generation source must pass taskId variables');
    expect(calls[1]).toContain('Replace hardcoded wf.wait("...")');
    expect(calls[1]).toContain('Preserve the existing phase, fan-out, cross-review, and synthesis topology');
  });

  it('repairs generated source that passes agent names as evidenceRefs', async () => {
    const calls: string[] = [];
    const manifest = {
      name: 'evidence-ref-name-repair',
      description: 'Repair a workflow that used agent names as evidence refs.',
      phases: ['inspect', 'review'],
      readOnly: true,
      maxAgents: 2,
      maxConcurrency: 1,
      patterns: ['adversarial-verification'],
    };

    const result = await generateWorkflow({
      request: 'Create a workflow where a reviewer checks an earlier report.',
      generateText: async ({ prompt }) => {
        calls.push(prompt);
        const source = calls.length === 1
          ? [
              'async function run(wf) {',
              '  const baseline = await wf.runAgent({ name: "baseline", prompt: "Write the baseline report.", readOnly: true });',
              '  const reviewer = await wf.runAgent({',
              '    name: "adversarial-verifier",',
              '    prompt: "Try to refute the baseline report before synthesis.",',
              '    readOnly: true,',
              '    evidenceRefs: ["baseline"]',
              '  });',
              '  return { synthesis: reviewer.finalText, baseline: baseline.finalText };',
              '}',
            ].join('\n')
          : [
              'async function run(wf) {',
              '  const baseline = await wf.runAgent({ name: "baseline", prompt: "Write the baseline report.", readOnly: true });',
              '  const reviewer = await wf.runAgent({',
              '    name: "adversarial-verifier",',
              '    prompt: "Try to refute the baseline report before synthesis:\\n" + baseline.finalText,',
              '    readOnly: true,',
              '    evidenceRefs: ["task_id:" + baseline.taskId]',
              '  });',
              '  return { synthesis: reviewer.finalText, baseline: baseline.finalText };',
              '}',
            ].join('\n');
        return JSON.stringify({
          action: 'generate',
          manifest,
          source,
        });
      },
    });

    expect(result.kind).toBe('generated');
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('Validation error: workflow generation source failed safe smoke validation');
    expect(calls[1]).toContain('evidenceRefs contains agent name "baseline"');
    expect(calls[1]).toContain('reference child results as "task_id:" + result.taskId');
  });

  it('repairs generated source that assumes a fixed smoke result phrase', async () => {
    const calls: string[] = [];
    const manifest = {
      name: 'fixed-smoke-text-repair',
      description: 'Repair a workflow that depended on one smoke result wording.',
      phases: ['inspect', 'synthesize'],
      readOnly: true,
      maxAgents: 2,
      maxConcurrency: 1,
      patterns: ['fan-out-and-synthesize'],
    };

    const result = await generateWorkflow({
      request: 'Create a workflow that inspects release notes and synthesizes findings.',
      generateText: async ({ prompt }) => {
        calls.push(prompt);
        const source = calls.length === 1
          ? [
              'async function run(wf) {',
              '  const report = await wf.runAgent({ name: "release-reader", prompt: "Inspect release notes.", readOnly: true });',
              '  if (!report.finalText.includes("completed")) throw new Error("unexpected child result shape");',
              '  return { synthesis: report.finalText };',
              '}',
            ].join('\n')
          : [
              'async function run(wf) {',
              '  const report = await wf.runAgent({ name: "release-reader", prompt: "Inspect release notes.", readOnly: true });',
              '  const synthesis = await wf.synthesize({',
              '    inputs: [report.finalText],',
              '    rubric: "Summarize concrete release-note findings."',
              '  });',
              '  return { synthesis: synthesis.text };',
              '}',
            ].join('\n');
        return JSON.stringify({
          action: 'generate',
          manifest,
          source,
        });
      },
    });

    expect(result.kind).toBe('generated');
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('Validation error: workflow generation source failed safe smoke validation');
    expect(calls[1]).toContain('variant-results');
    expect(calls[1]).toContain('unexpected child result shape');
  });

  it('repairs generated source with a data-dependent agent-name wait branch', async () => {
    const calls: string[] = [];
    const manifest = {
      name: 'status-branch-name-wait-repair',
      description: 'Repair a workflow that waits on an agent name in a status branch.',
      phases: ['inspect', 'synthesize'],
      readOnly: true,
      maxAgents: 2,
      maxConcurrency: 1,
      patterns: ['adversarial-verification'],
    };

    const result = await generateWorkflow({
      request: 'Create a workflow that reviews a report and handles verification warnings.',
      generateText: async ({ prompt }) => {
        calls.push(prompt);
        const source = calls.length === 1
          ? [
              'async function run(wf) {',
              '  const report = await wf.runAgent({ name: "reporter", prompt: "Write report.", readOnly: true });',
              '  if (report.status !== "completed") {',
              '    const retryId = report.name;',
              '    const retry = await wf.wait(retryId);',
              '    return { synthesis: retry.finalText };',
              '  }',
              '  const verifier = await wf.runAgent({ name: "adversarial-verifier", prompt: "Try to refute this report before synthesis:\\n" + report.finalText, readOnly: true, evidenceRefs: ["task_id:" + report.taskId] });',
              '  return { synthesis: verifier.finalText };',
              '}',
            ].join('\n')
          : [
              'async function run(wf) {',
              '  const report = await wf.runAgent({ name: "reporter", prompt: "Write report.", readOnly: true });',
              '  const verifier = await wf.runAgent({ name: "adversarial-verifier", prompt: "Try to refute this report before synthesis:\\n" + report.finalText, readOnly: true, evidenceRefs: ["task_id:" + report.taskId] });',
              '  const synthesis = await wf.synthesize({',
              '    inputs: [report.finalText, verifier.finalText],',
              '    rubric: "Summarize the report, preserving any verification warnings."',
              '  });',
              '  return { synthesis: synthesis.text };',
              '}',
            ].join('\n');
        return JSON.stringify({
          action: 'generate',
          manifest,
          source,
        });
      },
    });

    expect(result.kind).toBe('generated');
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('Validation error: workflow generation source failed safe smoke validation');
    expect(calls[1]).toContain('unverified-success');
    expect(calls[1]).toContain('used an agent name');
  });

  it('repairs generated source whose runtime return is not displayable', async () => {
    const calls: string[] = [];
    const manifest = {
      name: 'empty-runtime-result-repair',
      description: 'Repair a workflow that returns an empty runtime result.',
      phases: ['synthesize'],
      readOnly: true,
      maxAgents: 1,
      maxConcurrency: 1,
      patterns: ['classify-and-act'],
    };

    const result = await generateWorkflow({
      request: 'Create a workflow that returns a final summary.',
      generateText: async ({ prompt }) => {
        calls.push(prompt);
        const source = calls.length === 1
          ? [
              'async function run() {',
              '  const finalText = "";',
              '  return { synthesis: finalText };',
              '}',
            ].join('\n')
          : [
              'async function run() {',
              '  return { synthesis: "Final summary placeholder replaced by generated workflow output." };',
              '}',
            ].join('\n');
        return JSON.stringify({
          action: 'generate',
          manifest,
          source,
        });
      },
    });

    expect(result.kind).toBe('generated');
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('Validation error: workflow generation source failed safe smoke validation');
    expect(calls[1]).toContain('run() returned no displayable result or artifact');
  });

  it('repairs generated source that crashes when rerun args omit request', async () => {
    const calls: string[] = [];
    const manifest = {
      name: 'empty-rerun-args-repair',
      description: 'Repair a workflow that assumes args.request is always present.',
      phases: ['inspect', 'synthesize'],
      readOnly: true,
      maxAgents: 2,
      maxConcurrency: 1,
      patterns: ['fan-out-and-synthesize'],
    };

    const result = await generateWorkflow({
      request: 'Create a reusable workflow for release audits.',
      generateText: async ({ prompt }) => {
        calls.push(prompt);
        const source = calls.length === 1
          ? [
              'async function run(wf, args) {',
              '  const request = args.request.trim();',
              '  const report = await wf.runAgent({ name: "release-auditor", prompt: request, readOnly: true });',
              '  return { synthesis: report.finalText };',
              '}',
            ].join('\n')
          : [
              'async function run(wf, args) {',
              '  const request = String(args.request || "Create a reusable workflow for release audits.");',
              '  const report = await wf.runAgent({ name: "release-auditor", prompt: request, readOnly: true });',
              '  const synthesis = await wf.synthesize({',
              '    inputs: [report.finalText],',
              '    rubric: "Summarize the release audit findings."',
              '  });',
              '  return { synthesis: synthesis.text };',
              '}',
            ].join('\n');
        return JSON.stringify({
          action: 'generate',
          manifest,
          source,
        });
      },
    });

    expect(result.kind).toBe('generated');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('Treat args as optional rerun input');
    expect(calls[1]).toContain('Validation error: workflow generation source failed safe smoke validation');
    expect(calls[1]).toContain('empty-args-rerun');
  });

  it('reports the final validation error after all workflow repair attempts fail', async () => {
    await expect(
      generateWorkflow({
        request: 'Create a workflow to audit source contracts.',
        generateText: async () => JSON.stringify({
          action: 'generate',
          manifest: {
            name: 'still-bad',
            description: 'Still invalid.',
            phases: ['run'],
            readOnly: true,
            maxAgents: 1,
            maxConcurrency: 1,
            patterns: ['fan-out-and-synthesize'],
          },
          source: 'async function run(wf) { const r = await wf.runAgent({ name: "a", prompt: "x" }); return { synthesis: r.output }; }',
        }),
      }),
    ).rejects.toThrow(/after 3 attempts.*finalText\/text/);
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
