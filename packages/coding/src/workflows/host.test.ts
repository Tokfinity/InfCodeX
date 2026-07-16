import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { createRestrictedWorkflowModule } from '@kodax-ai/agent';
import type { WorkflowModule, WorkflowScriptManifest } from '@kodax-ai/agent';

import { startManagedWorkflow } from './host.js';
import type {
  ManagedWorkflowRun,
  ManagedWorkflowSnapshot,
  WorkflowRunManager,
} from './run-manager.js';
import type {
  RunWorkflowFromOptionsInput,
  RunWorkflowModuleOutcome,
} from './workflow-runner.js';
import type { WorkflowGenerationResult } from './generator.js';
import type { KodaXOptions } from '../types.js';

const MANIFEST: WorkflowScriptManifest = {
  name: 'inline-wf',
  description: 'inline test workflow',
  phases: ['investigate'],
  readOnly: true,
  maxAgents: 4,
  maxConcurrency: 2,
  patterns: ['fan-out-and-synthesize'],
};

const SOURCE = 'async function run(wf, args) { return { synthesis: "ok" }; }';

function completedOutcome(runId: string): RunWorkflowModuleOutcome {
  return {
    kind: 'completed',
    result: { synthesis: 'ok' },
    state: { runId, status: 'completed', totalSpawned: 0, events: [], artifacts: [] },
  };
}

function fakeManager(): { manager: WorkflowRunManager; calls: RunWorkflowFromOptionsInput[] } {
  const calls: RunWorkflowFromOptionsInput[] = [];
  const run = (runId: string): ManagedWorkflowRun => ({
    runId,
    done: Promise.resolve(completedOutcome(runId)),
    getSnapshot: (): ManagedWorkflowSnapshot | undefined => undefined,
    getProcessSnapshot: () => undefined,
  });
  const manager: WorkflowRunManager = {
    start: () => {
      throw new Error('start() not used by the host');
    },
    startFromOptions: (input) => {
      calls.push(input);
      return run(input.runId);
    },
    list: () => [],
    get: () => undefined,
    subscribeWorkflowProcess: () => () => {},
    getWorkflowProcessSnapshot: () => undefined,
    listWorkflowProcessSnapshots: () => [],
    pause: () => false,
    resume: () => false,
    stop: () => false,
  };
  return { manager, calls };
}

const OPTIONS = {} as KodaXOptions;
const RUNS_DIR = join('/tmp', 'kodax-runs');

describe('startManagedWorkflow', () => {
  it('inline: validates + builds the module, mints run dir, starts on the manager', async () => {
    const { manager, calls } = fakeManager();
    const result = await startManagedWorkflow({
      source: { kind: 'inline', manifest: MANIFEST, source: SOURCE },
      args: { request: 'x' },
      options: OPTIONS,
      runsBaseDir: RUNS_DIR,
      runId: 'run-inline',
      manager,
    });
    expect(result.kind).toBe('started');
    if (result.kind !== 'started') return;
    expect(result.runId).toBe('run-inline');
    expect(result.runDir).toBe(join(RUNS_DIR, 'run-inline'));
    expect(result.scriptSnapshot).toEqual({ manifest: MANIFEST, source: SOURCE });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.runId).toBe('run-inline');
    expect(calls[0]?.runDir).toBe(join(RUNS_DIR, 'run-inline'));
    expect(calls[0]?.module.meta.name).toBe('inline-wf');
    expect(calls[0]?.args).toEqual({ request: 'x' });
  });

  it('inline: rejects a malformed manifest through the same gate as generation', async () => {
    const { manager } = fakeManager();
    await expect(
      startManagedWorkflow({
        source: { kind: 'inline', manifest: { name: 'bad' }, source: SOURCE },
        args: {},
        options: OPTIONS,
        runsBaseDir: RUNS_DIR,
        runId: 'run-bad',
        manager,
      }),
    ).rejects.toThrow();
  });

  it('inline: rejects wf.parallel items that are already-started promises before starting a run', async () => {
    const { manager, calls } = fakeManager();
    const source = [
      'async function run(wf) {',
      '  const first = wf.runAgent({ name: "reader", prompt: "Read the target.", readOnly: true });',
      '  const results = await wf.parallel([first], { concurrency: 2 });',
      '  return { synthesis: String(results.length) };',
      '}',
    ].join('\n');

    await expect(
      startManagedWorkflow({
        source: { kind: 'inline', manifest: MANIFEST, source },
        args: { request: 'x' },
        options: OPTIONS,
        runsBaseDir: RUNS_DIR,
        runId: 'run-bad-parallel',
        manager,
      }),
    ).rejects.toThrow(/wf\.parallel items must be functions/);
    expect(calls).toHaveLength(0);
  });

  it('inline: rejects dynamic waits that use an agent name instead of a taskId before starting a run', async () => {
    const { manager, calls } = fakeManager();
    const source = [
      'async function run(wf) {',
      '  const result = await wf.runAgent({ name: "reader", prompt: "Read the target.", readOnly: true });',
      '  const followup = await wf.wait(result.name);',
      '  return { synthesis: followup.finalText };',
      '}',
    ].join('\n');

    await expect(
      startManagedWorkflow({
        source: { kind: 'inline', manifest: MANIFEST, source },
        args: { request: 'x' },
        options: OPTIONS,
        runsBaseDir: RUNS_DIR,
        runId: 'run-bad-wait',
        manager,
      }),
    ).rejects.toThrow(/used an agent name/);
    expect(calls).toHaveLength(0);
  });

  it('inline: rejects reading an unawaited agent result before starting a run', async () => {
    const { manager, calls } = fakeManager();
    const source = [
      'async function run(wf) {',
      '  const result = wf.runAgent({ name: "reader", prompt: "Read the target.", readOnly: true });',
      '  return { synthesis: String(result.structured) };',
      '}',
    ].join('\n');

    await expect(
      startManagedWorkflow({
        source: { kind: 'inline', manifest: MANIFEST, source },
        args: { request: 'x' },
        options: OPTIONS,
        runsBaseDir: RUNS_DIR,
        runId: 'run-unawaited-agent',
        manager,
      }),
    ).rejects.toThrow(/must be awaited/);
    expect(calls).toHaveLength(0);
  });

  it('inline: rejects returning an unawaited synthesis result before starting a run', async () => {
    const { manager, calls } = fakeManager();
    const source = [
      'async function run(wf) {',
      '  return { synthesis: wf.synthesize({ inputs: "notes", rubric: "merge" }) };',
      '}',
    ].join('\n');

    await expect(
      startManagedWorkflow({
        source: { kind: 'inline', manifest: MANIFEST, source },
        args: { request: 'x' },
        options: OPTIONS,
        runsBaseDir: RUNS_DIR,
        runId: 'run-unawaited-synthesis',
        manager,
      }),
    ).rejects.toThrow(/must be awaited/);
    expect(calls).toHaveLength(0);
  });

  it('inline: rejects write-capable children in a read-only manifest before starting a run', async () => {
    const { manager, calls } = fakeManager();
    const source = [
      'async function run(wf) {',
      '  const result = await wf.runAgent({ name: "writer", prompt: "Write files.", readOnly: false });',
      '  return { synthesis: result.finalText };',
      '}',
    ].join('\n');

    await expect(
      startManagedWorkflow({
        source: { kind: 'inline', manifest: MANIFEST, source },
        args: { request: 'x' },
        options: OPTIONS,
        runsBaseDir: RUNS_DIR,
        runId: 'run-readonly-conflict',
        manager,
      }),
    ).rejects.toThrow(/readOnly=true cannot spawn write-capable child/);
    expect(calls).toHaveLength(0);
  });

  it('inline: starts review fanout without verifier without heuristic warnings', async () => {
    const { manager, calls } = fakeManager();
    const reviewManifest: WorkflowScriptManifest = {
      ...MANIFEST,
      name: 'review-without-verifier',
      description: 'Review the current diff for bugs.',
      phases: ['review', 'synthesize'],
      maxAgents: 4,
      patterns: ['fan-out-and-synthesize'],
    };
    const source = [
      'async function run(wf) {',
      '  const reviewers = await wf.parallel([',
      '    () => wf.runAgent({ name: "correctness-reviewer", prompt: "Review src/runtime.ts for correctness bugs.", readOnly: true }),',
      '    () => wf.runAgent({ name: "security-reviewer", prompt: "Audit src/runtime.ts for security bugs.", readOnly: true })',
      '  ]);',
      '  const synthesis = await wf.synthesize({ inputs: reviewers.filter(Boolean).map((r) => r.finalText), rubric: "Merge the findings." });',
      '  return synthesis.text;',
      '}',
    ].join('\n');

    const result = await startManagedWorkflow({
      source: { kind: 'inline', manifest: reviewManifest, source },
      args: { request: 'x' },
      options: OPTIONS,
      runsBaseDir: RUNS_DIR,
      runId: 'run-review-no-verifier',
      manager,
    });

    expect(result.kind).toBe('started');
    if (result.kind !== 'started') return;
    expect(result.qualityWarnings).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('inline: does not surface generic prompt heuristics as warning metadata', async () => {
    const { manager, calls } = fakeManager();
    const source = [
      'async function run(wf) {',
      '  const result = await wf.runAgent({ name: "reviewer", prompt: "review", readOnly: true });',
      '  return result.finalText;',
      '}',
    ].join('\n');

    const result = await startManagedWorkflow({
      source: { kind: 'inline', manifest: MANIFEST, source },
      args: { request: 'x' },
      options: OPTIONS,
      runsBaseDir: RUNS_DIR,
      runId: 'run-warning-only',
      manager,
      processMetadata: { hostMetadata: { sessionId: 'session-1' } },
    });

    expect(result.kind).toBe('started');
    if (result.kind !== 'started') return;
    expect(result.qualityWarnings).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.processMetadata?.hostMetadata?.sessionId).toBe('session-1');
    expect(calls[0]?.processMetadata?.hostMetadata?.workflowQualityWarningCount).toBeUndefined();
    expect(calls[0]?.processMetadata?.hostMetadata?.workflowQualityWarningCodes).toBeUndefined();
    expect(calls[0]?.processMetadata?.hostMetadata?.workflowQualityWarnings).toBeUndefined();
  });

  it('inline: rejects literal fanout above host maxAgents policy before starting a run', async () => {
    const { manager, calls } = fakeManager();
    const source = [
      'async function run(wf) {',
      '  const results = await wf.parallel([1, 2, 3].map((n) => () =>',
      '    wf.runAgent({ name: "reader-" + n, prompt: "Inspect src/runtime.ts", readOnly: true })',
      '  ));',
      '  return { synthesis: String(results.length) };',
      '}',
    ].join('\n');

    await expect(
      startManagedWorkflow({
        source: {
          kind: 'inline',
          manifest: { ...MANIFEST, maxAgents: 5 },
          source,
        },
        args: { request: 'x' },
        options: { workflowHostPolicy: { maxAgents: 2 } } as KodaXOptions,
        runsBaseDir: RUNS_DIR,
        runId: 'run-host-cap-fanout',
        manager,
      }),
    ).rejects.toThrow(/literal fanout.*2 maxAgents/is);
    expect(calls).toHaveLength(0);
  });

  it('inline: treats ordinary smoke-only script branches as non-blocking', async () => {
    const { manager, calls } = fakeManager();
    const source = [
      'async function run(wf) {',
      '  const result = await wf.runAgent({ name: "reader", prompt: "Read the target.", readOnly: true });',
      '  if (result.finalText.includes("Smoke result")) throw new Error("stub-only branch");',
      '  return { synthesis: result.finalText };',
      '}',
    ].join('\n');

    const result = await startManagedWorkflow({
      source: { kind: 'inline', manifest: MANIFEST, source },
      args: { request: 'x' },
      options: OPTIONS,
      runsBaseDir: RUNS_DIR,
      runId: 'run-smoke-soft',
      manager,
    });

    expect(result.kind).toBe('started');
    expect(calls).toHaveLength(1);
  });

  it('request: returns declined when the generator declines (no run started)', async () => {
    const { manager, calls } = fakeManager();
    const result = await startManagedWorkflow({
      source: { kind: 'request', request: 'just say hi' },
      args: {},
      options: OPTIONS,
      runsBaseDir: RUNS_DIR,
      manager,
      generateWorkflow: async () =>
        ({ kind: 'declined', reason: 'too simple', rawText: '{}' }) satisfies WorkflowGenerationResult,
    });
    expect(result).toEqual({ kind: 'declined', reason: 'too simple' });
    expect(calls).toHaveLength(0);
  });

  it('request: starts the generated module + threads its script snapshot', async () => {
    const { manager, calls } = fakeManager();
    const module = createRestrictedWorkflowModule({ manifest: MANIFEST, source: SOURCE });
    const result = await startManagedWorkflow({
      source: { kind: 'request', request: 'audit the diff' },
      args: {},
      options: OPTIONS,
      runsBaseDir: RUNS_DIR,
      runId: 'run-gen',
      manager,
      generateWorkflow: async () =>
        ({
          kind: 'generated',
          manifest: MANIFEST,
          source: SOURCE,
          module,
          scriptSnapshot: { manifest: MANIFEST, source: SOURCE },
          approvalSummary: 'audit summary',
          rawText: '{}',
        }) satisfies WorkflowGenerationResult,
    });
    expect(result.kind).toBe('started');
    expect(calls[0]?.module).toBe(module);
    expect(calls[0]?.scriptSnapshot).toEqual({ manifest: MANIFEST, source: SOURCE });
    expect(calls[0]?.processMetadata?.hostMetadata?.workflowAuthorship).toBe('kodax-generated');
  });

  it('saved: starts the provided module with no script snapshot', async () => {
    const { manager, calls } = fakeManager();
    const module: WorkflowModule = createRestrictedWorkflowModule({ manifest: MANIFEST, source: SOURCE });
    const result = await startManagedWorkflow({
      source: { kind: 'saved', module },
      args: {},
      options: OPTIONS,
      runsBaseDir: RUNS_DIR,
      runId: 'run-saved',
      manager,
    });
    expect(result.kind).toBe('started');
    expect(calls[0]?.processMetadata?.hostMetadata?.workflowAuthorship).toBeUndefined();
    if (result.kind === 'started') expect(result.scriptSnapshot).toBeUndefined();
    expect(calls[0]?.scriptSnapshot).toBeUndefined();
  });

  it('threads the approval gate through to the manager', async () => {
    const { manager, calls } = fakeManager();
    const approval = (): boolean => true;
    await startManagedWorkflow({
      source: { kind: 'inline', manifest: MANIFEST, source: SOURCE },
      args: {},
      options: OPTIONS,
      runsBaseDir: RUNS_DIR,
      runId: 'run-appr',
      manager,
      approval,
    });
    expect(calls[0]?.approval).toBe(approval);
  });
});
