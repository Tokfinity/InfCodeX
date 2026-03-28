import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  mockCreateReasoningPlan,
  mockResolveProvider,
  mockRunDirectKodaX,
} = vi.hoisted(() => ({
  mockCreateReasoningPlan: vi.fn(),
  mockResolveProvider: vi.fn(() => ({ name: 'anthropic' })),
  mockRunDirectKodaX: vi.fn(),
}));

vi.mock('./agent.js', () => ({
  runKodaX: mockRunDirectKodaX,
}));

vi.mock('./providers/index.js', async () => {
  const actual = await vi.importActual<typeof import('./providers/index.js')>('./providers/index.js');
  return {
    ...actual,
    resolveProvider: mockResolveProvider,
  };
});

vi.mock('./reasoning.js', async () => {
  const actual = await vi.importActual<typeof import('./reasoning.js')>('./reasoning.js');
  return {
    ...actual,
    createReasoningPlan: mockCreateReasoningPlan,
  };
});

import { runManagedTask } from './task-engine.js';
import type { KodaXManagedTaskStatusEvent } from './types.js';

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function initGitRepo(workspaceRoot: string): void {
  execFileSync('git', ['init'], { cwd: workspaceRoot, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'KodaX Test'], { cwd: workspaceRoot, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'kodax-test@example.com'], { cwd: workspaceRoot, stdio: 'ignore' });
}

function commitAll(workspaceRoot: string, message: string): void {
  execFileSync('git', ['add', '.'], { cwd: workspaceRoot, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', message], { cwd: workspaceRoot, stdio: 'ignore' });
}

function createRepoFixture(workspaceRoot: string): void {
  mkdirSync(path.join(workspaceRoot, 'packages', 'app', 'src'), { recursive: true });
  mkdirSync(path.join(workspaceRoot, 'packages', 'shared', 'src'), { recursive: true });

  writeFileSync(path.join(workspaceRoot, 'package.json'), JSON.stringify({ name: 'managed-task-fixture' }, null, 2));
  writeFileSync(path.join(workspaceRoot, 'packages', 'app', 'package.json'), JSON.stringify({ name: '@fixture/app' }, null, 2));
  writeFileSync(path.join(workspaceRoot, 'packages', 'shared', 'package.json'), JSON.stringify({ name: '@fixture/shared' }, null, 2));

  writeFileSync(path.join(workspaceRoot, 'packages', 'shared', 'src', 'strings.ts'), [
    'export function normalizeName(input: string): string {',
    '  return input.trim().toLowerCase();',
    '}',
    '',
  ].join('\n'));

  writeFileSync(path.join(workspaceRoot, 'packages', 'app', 'src', 'boot.ts'), [
    "import { normalizeName } from '../../shared/src/strings';",
    '',
    'export function bootApp(input: string): string {',
    '  return normalizeName(input);',
    '}',
    '',
    "bootApp('Demo');",
    '',
  ].join('\n'));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildAdmissionResponse(
  summary = 'Admission confirmed the current harness.',
  confirmedHarness?: 'H1_EXECUTE_EVAL' | 'H2_PLAN_EXECUTE_EVAL' | 'H3_MULTI_WORKER',
  reviewFilesOrAreas?: string[],
  evidenceAcquisitionMode?: 'overview' | 'diff-bundle' | 'diff-slice' | 'file-read',
): string {
  return [
    summary,
    '```kodax-task-admission',
    `summary: ${summary}`,
    confirmedHarness ? `confirmed_harness: ${confirmedHarness}` : undefined,
    evidenceAcquisitionMode ? `evidence_acquisition_mode: ${evidenceAcquisitionMode}` : undefined,
    'scope:',
    '- Review the changed scope and evidence surface.',
    'required_evidence:',
    '- Concrete evidence from inspected files or checks.',
    reviewFilesOrAreas?.length ? 'review_files_or_areas:' : undefined,
    ...(reviewFilesOrAreas ?? []).map((item) => `- ${item}`),
    '```',
  ].filter(Boolean).join('\n');
}

function buildHandoffResponse(
  visibleText: string,
  options?: {
    status?: 'ready' | 'incomplete' | 'blocked';
    summary?: string;
    evidence?: string[];
    followup?: string[];
  },
): string {
  const status = options?.status ?? 'ready';
  const summary = options?.summary ?? visibleText;
  const evidence = options?.evidence ?? ['Reviewed the assigned slice and gathered evidence.'];
  const followup = options?.followup ?? ['none'];
  return [
    visibleText,
    '```kodax-task-handoff',
    `status: ${status}`,
    `summary: ${summary}`,
    'evidence:',
    ...evidence.map((item) => `- ${item}`),
    'followup:',
    ...followup.map((item) => `- ${item}`),
    '```',
  ].join('\n');
}

afterEach(async () => {
  mockCreateReasoningPlan.mockReset();
  mockResolveProvider.mockClear();
  mockRunDirectKodaX.mockReset();

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe('runManagedTask', () => {
  it('runs low-complexity tasks in H0 direct mode and writes managed-task artifacts', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-');
    mockCreateReasoningPlan.mockResolvedValue({
      mode: 'auto',
      depth: 'low',
      promptOverlay: '[Routing] direct',
      decision: {
        primaryTask: 'edit',
        confidence: 0.91,
        riskLevel: 'low',
        recommendedMode: 'implementation',
        recommendedThinkingDepth: 'low',
        complexity: 'simple',
        workIntent: 'append',
        requiresBrainstorm: false,
        harnessProfile: 'H0_DIRECT',
        reason: 'Simple execution',
      },
    });
    mockRunDirectKodaX.mockResolvedValue({
      success: true,
      lastText: 'Handled directly.',
      messages: [{ role: 'assistant', content: 'Handled directly.' }],
      sessionId: 'session-direct',
      routingDecision: undefined,
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        context: {
          taskSurface: 'cli',
          managedTaskWorkspaceDir: workspaceRoot,
        },
      },
      'Fix the typo in the README.'
    );

    expect(mockRunDirectKodaX).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.routingDecision?.harnessProfile).toBe('H0_DIRECT');
    expect(result.managedTask?.contract.harnessProfile).toBe('H0_DIRECT');
    expect(result.managedTask?.roleAssignments).toEqual([
      expect.objectContaining({
        id: 'direct',
        role: 'direct',
        status: 'completed',
      }),
    ]);

    const artifact = JSON.parse(
      await readFile(path.join(result.managedTask!.evidence.workspaceDir, 'managed-task.json'), 'utf8')
    );
    expect(artifact.contract.taskId).toBe(result.managedTask?.contract.taskId);
    expect(result.managedTask?.evidence.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: path.join(result.managedTask!.evidence.workspaceDir, 'managed-task.json'),
        }),
        expect.objectContaining({
          path: path.join(result.managedTask!.evidence.workspaceDir, 'result.json'),
        }),
      ]),
    );
  });

  it('records raw and final routing decisions for a small current-worktree review that stays in H0', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-');
    const statusEvents: KodaXManagedTaskStatusEvent[] = [];
    mockCreateReasoningPlan.mockResolvedValue({
      mode: 'auto',
      depth: 'low',
      promptOverlay: '[Routing] current-small',
      decision: {
        primaryTask: 'review',
        confidence: 0.86,
        riskLevel: 'low',
        recommendedMode: 'pr-review',
        recommendedThinkingDepth: 'low',
        complexity: 'simple',
        workIntent: 'overwrite',
        requiresBrainstorm: false,
        harnessProfile: 'H0_DIRECT',
        reviewScale: 'small',
        routingSource: 'model',
        routingAttempts: 1,
        reason: 'Small current review should stay direct.',
      },
    });
    mockRunDirectKodaX.mockResolvedValue({
      success: true,
      lastText: 'Small review completed directly.',
      messages: [{ role: 'assistant', content: 'Small review completed directly.' }],
      sessionId: 'session-current-small',
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        events: {
          onManagedTaskStatus: (status) => statusEvents.push(status),
        },
        context: {
          taskSurface: 'repl',
          managedTaskWorkspaceDir: workspaceRoot,
          repoRoutingSignals: {
            changedFileCount: 2,
            changedLineCount: 40,
            addedLineCount: 30,
            deletedLineCount: 10,
            touchedModuleCount: 1,
            changedModules: ['packages/repl'],
            crossModule: false,
            reviewScale: 'small',
            riskHints: [],
            plannerBias: false,
            investigationBias: false,
            lowConfidence: false,
          },
        },
      },
      '请review下当前代码改动'
    );

    expect(result.managedTask?.runtime?.rawRoutingDecision).toEqual(
      expect.objectContaining({
        harnessProfile: 'H0_DIRECT',
        reviewTarget: 'current-worktree',
        reviewScale: 'small',
        routingSource: 'model',
      }),
    );
    expect(result.managedTask?.runtime?.finalRoutingDecision).toEqual(
      expect.objectContaining({
        harnessProfile: 'H0_DIRECT',
        reviewTarget: 'current-worktree',
        reviewScale: 'small',
      }),
    );
    expect(statusEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: 'routing',
          note: expect.stringContaining('AMA H0'),
        }),
        expect.objectContaining({
          phase: 'routing',
          note: expect.stringContaining('small current-diff review'),
        }),
      ]),
    );
    expect(String(mockRunDirectKodaX.mock.calls[0]?.[0]?.context?.promptOverlay ?? '')).toContain(
      '[Managed Task Routing] AMA routing: raw=H0_DIRECT(model) -> final=H0_DIRECT',
    );
  });

  it('floors a large current-worktree review to H2 and exposes the routing override', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-');
    const statusEvents: KodaXManagedTaskStatusEvent[] = [];
    mockCreateReasoningPlan.mockResolvedValue({
      mode: 'auto',
      depth: 'medium',
      promptOverlay: '[Routing] current-large',
      decision: {
        primaryTask: 'review',
        confidence: 0.72,
        riskLevel: 'medium',
        recommendedMode: 'pr-review',
        recommendedThinkingDepth: 'medium',
        complexity: 'moderate',
        workIntent: 'overwrite',
        requiresBrainstorm: false,
        harnessProfile: 'H0_DIRECT',
        reviewScale: 'large',
        routingSource: 'model',
        routingAttempts: 1,
        reason: 'Provider suggested a direct review path.',
      },
    });

    mockRunDirectKodaX.mockImplementation(async (_options, prompt: string) => {
      if (prompt.includes('Admission role')) {
        const content = buildAdmissionResponse(
          'Admission confirmed a large current-diff review and selected diff-bundle evidence gathering.',
          'H2_PLAN_EXECUTE_EVAL',
          ['packages/coding/src/task-engine.ts', 'packages/repl/src/ui/InkREPL.tsx'],
          'diff-bundle',
        );
        return {
          success: true,
          lastText: content,
          messages: [{ role: 'assistant', content }],
          sessionId: 'session-admission-large-current',
        };
      }

      if (prompt.includes('Planner role')) {
        const content = [
          'Planner prepared the large review contract.',
          '```kodax-task-contract',
          'summary: Review the large current diff with a batched evidence pass first.',
          'success_criteria:',
          '- Must-fix findings are evidence-backed.',
          'required_evidence:',
          '- changed_scope summary.',
          '- changed_diff_bundle batch evidence.',
          'constraints:',
          '- Do not skip suspicious files after the bundle sweep.',
          '```',
        ].join('\n');
        return {
          success: true,
          lastText: content,
          messages: [{ role: 'assistant', content }],
          sessionId: 'session-planner-large-current',
        };
      }

      if (prompt.includes('Contract Reviewer role')) {
        const content = [
          'The contract is concrete enough for execution.',
          '```kodax-task-contract-review',
          'status: approve',
          'reason: The large diff is scoped and evidence-backed.',
          'followup:',
          '- Proceed with the bundled review execution.',
          '```',
        ].join('\n');
        return {
          success: true,
          lastText: content,
          messages: [{ role: 'assistant', content }],
          sessionId: 'session-contract-review-large-current',
        };
      }

      if (prompt.includes('Generator role')) {
        const content = buildHandoffResponse('Generator completed the first-pass large review.', {
          summary: 'Generator completed the first-pass large review.',
          evidence: ['Batched diff evidence collected before drilling into suspicious files.'],
          followup: ['Evaluator should verify the findings and the evidence path.'],
        });
        return {
          success: true,
          lastText: content,
          messages: [{ role: 'assistant', content }],
          sessionId: 'session-generator-large-current',
        };
      }

      const content = [
        'Evaluator accepted the large current-diff review.',
        '```kodax-task-verdict',
        'status: accept',
        'reason: The large review satisfied the scoped H2 contract.',
        'followup:',
        '- Deliver the final review.',
        '```',
      ].join('\n');
      return {
        success: true,
        lastText: content,
        messages: [{ role: 'assistant', content }],
        sessionId: 'session-evaluator-large-current',
        signal: 'COMPLETE',
      };
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        events: {
          onManagedTaskStatus: (status) => statusEvents.push(status),
        },
        context: {
          taskSurface: 'repl',
          managedTaskWorkspaceDir: workspaceRoot,
          repoRoutingSignals: {
            changedFileCount: 12,
            changedLineCount: 1500,
            addedLineCount: 1200,
            deletedLineCount: 300,
            touchedModuleCount: 3,
            changedModules: ['packages/coding', 'packages/repl', 'docs'],
            crossModule: false,
            reviewScale: 'large',
            riskHints: ['large-current-diff'],
            plannerBias: false,
            investigationBias: false,
            lowConfidence: false,
          },
        },
      },
      '请review下所有当前代码改动'
    );

    expect(result.managedTask?.contract.harnessProfile).toBe('H2_PLAN_EXECUTE_EVAL');
    expect(result.managedTask?.runtime?.rawRoutingDecision).toEqual(
      expect.objectContaining({
        harnessProfile: 'H0_DIRECT',
        reviewTarget: 'current-worktree',
        reviewScale: 'large',
      }),
    );
    expect(result.managedTask?.runtime?.finalRoutingDecision).toEqual(
      expect.objectContaining({
        harnessProfile: 'H2_PLAN_EXECUTE_EVAL',
        reviewTarget: 'current-worktree',
        reviewScale: 'large',
      }),
    );
    expect(result.managedTask?.runtime?.routingOverrideReason).toContain('large current-diff review');
    expect(result.managedTask?.runtime?.evidenceAcquisitionMode).toBe('diff-bundle');
    expect(statusEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: 'routing',
          note: expect.stringContaining('AMA H2'),
        }),
        expect.objectContaining({
          phase: 'routing',
          note: expect.stringContaining('raw H0 -> H2'),
        }),
      ]),
    );
  });

  it('floors a massive current-worktree review to H2 with an H3 ceiling before execution', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-');
    mockCreateReasoningPlan.mockResolvedValue({
      mode: 'auto',
      depth: 'medium',
      promptOverlay: '[Routing] current-massive',
      decision: {
        primaryTask: 'review',
        confidence: 0.68,
        riskLevel: 'high',
        recommendedMode: 'pr-review',
        recommendedThinkingDepth: 'high',
        complexity: 'complex',
        workIntent: 'overwrite',
        requiresBrainstorm: false,
        harnessProfile: 'H0_DIRECT',
        reviewScale: 'massive',
        routingSource: 'model',
        routingAttempts: 1,
        reason: 'Provider suggested a direct review path for the current diff.',
      },
    });

    mockRunDirectKodaX.mockImplementation(async (_options, prompt: string) => {
      if (prompt.includes('Admission role')) {
        const content = buildAdmissionResponse(
          'Admission confirmed the review is massive and should start at H2 with H3 available.',
          'H2_PLAN_EXECUTE_EVAL',
          ['packages/coding/src/task-engine.ts'],
          'diff-bundle',
        );
        return {
          success: true,
          lastText: content,
          messages: [{ role: 'assistant', content }],
          sessionId: 'session-admission-massive-current',
        };
      }

      if (prompt.includes('Planner role')) {
        const content = [
          'Planner prepared the initial massive-review contract.',
          '```kodax-task-contract',
          'summary: Start the massive review on H2 and keep H3 available if coverage widens.',
          'success_criteria:',
          '- Initial high-risk areas are covered.',
          'required_evidence:',
          '- changed_diff_bundle across the first review batch.',
          'constraints:',
          '- Preserve the option to upgrade to H3 if the review widens.',
          '```',
        ].join('\n');
        return {
          success: true,
          lastText: content,
          messages: [{ role: 'assistant', content }],
          sessionId: 'session-planner-massive-current',
        };
      }

      if (prompt.includes('Contract Reviewer role')) {
        const content = [
          'The initial H2 review contract is approved with an H3 upgrade path.',
          '```kodax-task-contract-review',
          'status: approve',
          'reason: The task can start at H2 while preserving the H3 escape hatch.',
          'followup:',
          '- Proceed with the initial batched review pass.',
          '```',
        ].join('\n');
        return {
          success: true,
          lastText: content,
          messages: [{ role: 'assistant', content }],
          sessionId: 'session-contract-review-massive-current',
        };
      }

      if (prompt.includes('Generator role')) {
        const content = buildHandoffResponse('Generator completed the initial batched pass.', {
          summary: 'Generator completed the initial batched pass.',
          evidence: ['Initial batched diff evidence collected for the massive review.'],
          followup: ['Evaluator should decide whether the initial H2 pass is sufficient.'],
        });
        return {
          success: true,
          lastText: content,
          messages: [{ role: 'assistant', content }],
          sessionId: 'session-generator-massive-current',
        };
      }

      const content = [
        'Evaluator completed the initial massive review pass.',
        '```kodax-task-verdict',
        'status: accept',
        'reason: The initial H2 pass completed successfully.',
        'followup:',
        '- Deliver the final review.',
        '```',
      ].join('\n');
      return {
        success: true,
        lastText: content,
        messages: [{ role: 'assistant', content }],
        sessionId: 'session-evaluator-massive-current',
        signal: 'COMPLETE',
      };
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        context: {
          taskSurface: 'repl',
          managedTaskWorkspaceDir: workspaceRoot,
          repoRoutingSignals: {
            changedFileCount: 34,
            changedLineCount: 4600,
            addedLineCount: 4100,
            deletedLineCount: 500,
            touchedModuleCount: 4,
            changedModules: ['packages/coding', 'packages/repl', 'packages/ai', 'docs'],
            crossModule: false,
            reviewScale: 'massive',
            riskHints: ['massive-current-diff'],
            plannerBias: true,
            investigationBias: false,
            lowConfidence: false,
          },
        },
      },
      '请review下所有当前代码改动'
    );

    expect(result.managedTask?.contract.harnessProfile).toBe('H2_PLAN_EXECUTE_EVAL');
    expect(result.managedTask?.runtime?.finalRoutingDecision).toEqual(
      expect.objectContaining({
        harnessProfile: 'H2_PLAN_EXECUTE_EVAL',
        reviewTarget: 'current-worktree',
        reviewScale: 'massive',
        upgradeCeiling: 'H3_MULTI_WORKER',
      }),
    );
    expect(result.managedTask?.runtime?.routingOverrideReason).toContain('massive current-diff review');
  });

  it('runs planner, contract review, generator, and evaluator roles for H2 managed tasks', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-');
    let contractReviewReadError: string | undefined;
    let contractReviewContractTaskId: string | undefined;
    let contractReviewRuntimeGuide: string | undefined;
    mockCreateReasoningPlan.mockResolvedValue({
      mode: 'auto',
      depth: 'medium',
      promptOverlay: '[Routing] h2',
      decision: {
        primaryTask: 'plan',
        confidence: 0.88,
        riskLevel: 'medium',
        recommendedMode: 'planning',
        recommendedThinkingDepth: 'medium',
        complexity: 'complex',
        workIntent: 'overwrite',
        requiresBrainstorm: true,
        harnessProfile: 'H2_PLAN_EXECUTE_EVAL',
        reason: 'Planning-heavy execution',
      },
    });

    mockRunDirectKodaX.mockImplementation(async (runOptions, prompt: string) => {
      if (prompt.includes('Admission role')) {
        const lastText = buildAdmissionResponse('Admission confirmed the planning-heavy scope and current H2 harness.');
        return {
          success: true,
          lastText,
          messages: [{ role: 'assistant', content: lastText }],
          sessionId: 'session-admission',
        };
      }

      if (prompt.includes('Lead role')) {
        return {
          success: true,
          lastText: [
            'Lead split the review into high-risk and surface tracks.',
            '```kodax-task-contract',
            'summary: Split the massive review into high-risk and surface tracks.',
            'success_criteria:',
            '- High-risk blockers are reviewed independently.',
            '- Surface regressions and test gaps are reviewed independently.',
            'required_evidence:',
            '- High-risk findings with evidence.',
            '- Surface findings with evidence.',
            'constraints:',
            '- Keep the review user-facing and evidence-backed.',
            '```',
          ].join('\n'),
          messages: [{
            role: 'assistant',
            content: [
              'Lead split the review into high-risk and surface tracks.',
              '```kodax-task-contract',
              'summary: Split the massive review into high-risk and surface tracks.',
              'success_criteria:',
              '- High-risk blockers are reviewed independently.',
              '- Surface regressions and test gaps are reviewed independently.',
              'required_evidence:',
              '- High-risk findings with evidence.',
              '- Surface findings with evidence.',
              'constraints:',
              '- Keep the review user-facing and evidence-backed.',
              '```',
            ].join('\n'),
          }],
          sessionId: 'session-review-lead',
        };
      }

      if (prompt.includes('Contract Reviewer role')) {
        const managedTaskWorkspaceDir = runOptions.context?.managedTaskWorkspaceDir;
        try {
          const contract = JSON.parse(
            await readFile(path.join(managedTaskWorkspaceDir!, 'contract.json'), 'utf8'),
          );
          const runtimeGuide = await readFile(path.join(managedTaskWorkspaceDir!, 'runtime-execution.md'), 'utf8');
          contractReviewContractTaskId = typeof contract.taskId === 'string' ? contract.taskId : undefined;
          contractReviewRuntimeGuide = runtimeGuide;
        } catch (error) {
          contractReviewReadError = error instanceof Error ? error.message : String(error);
        }
        return {
          success: true,
          lastText: [
            'The contract is concrete enough to execute.',
            '```kodax-task-contract-review',
            'status: approve',
            'reason: The planned work is specific and verifiable.',
            'followup:',
            '- Proceed with implementation against the agreed contract.',
            '```',
          ].join('\n'),
          messages: [{ role: 'assistant', content: [
            'The contract is concrete enough to execute.',
            '```kodax-task-contract-review',
            'status: approve',
            'reason: The planned work is specific and verifiable.',
            'followup:',
            '- Proceed with implementation against the agreed contract.',
            '```',
          ].join('\n') }],
          sessionId: 'session-contract-review',
        };
      }

      if (prompt.includes('Planner role')) {
        return {
          success: true,
          lastText: [
            'Plan ready with evidence checklist.',
            '```kodax-task-contract',
            'summary: Deliver the release checklist flow safely.',
            'success_criteria:',
            '- The release checklist flow is implemented end-to-end.',
            'required_evidence:',
            '- Automated verification covering the release checklist flow.',
            'constraints:',
            '- Preserve existing release rollback behavior.',
            '```',
          ].join('\n'),
          messages: [{ role: 'assistant', content: [
            'Plan ready with evidence checklist.',
            '```kodax-task-contract',
            'summary: Deliver the release checklist flow safely.',
            'success_criteria:',
            '- The release checklist flow is implemented end-to-end.',
            'required_evidence:',
            '- Automated verification covering the release checklist flow.',
            'constraints:',
            '- Preserve existing release rollback behavior.',
            '```',
          ].join('\n') }],
          sessionId: 'session-planner',
        };
      }

      if (prompt.includes('Generator role')) {
        const lastText = buildHandoffResponse(
          'Implementation complete with updated tests.',
          {
            summary: 'Implementation is ready for evaluator review.',
            evidence: ['Updated tests and implementation changes are complete.'],
          },
        );
        return {
          success: true,
          lastText,
          messages: [{ role: 'assistant', content: lastText }],
          sessionId: 'session-generator',
        };
      }

      return {
        success: true,
        lastText: [
          'Evaluator accepted the result.',
          '```kodax-task-verdict',
          'status: accept',
          'reason: The task is complete.',
          'followup:',
          '- Deliver the final answer.',
          '```',
        ].join('\n'),
        messages: [{
          role: 'assistant',
          content: [
            'Evaluator accepted the result.',
            '```kodax-task-verdict',
            'status: accept',
            'reason: The task is complete.',
            'followup:',
            '- Deliver the final answer.',
            '```',
          ].join('\n'),
        }],
        sessionId: 'session-evaluator',
        signal: 'COMPLETE',
      };
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        context: {
          taskSurface: 'repl',
          managedTaskWorkspaceDir: workspaceRoot,
        },
      },
      'Design and implement the new release checklist flow.'
    );

    expect(mockRunDirectKodaX).toHaveBeenCalledTimes(5);
    expect(result.lastText).toBe('Evaluator accepted the result.');
    expect(contractReviewReadError).toBeUndefined();
    expect(contractReviewContractTaskId).toBeTruthy();
    expect(contractReviewRuntimeGuide).toContain('No explicit runtime-under-test contract.');
    expect(result.managedTask?.contract.harnessProfile).toBe('H2_PLAN_EXECUTE_EVAL');
    expect(result.managedTask?.roleAssignments.map((assignment) => assignment.role)).toEqual([
      'admission',
      'planner',
      'validator',
      'generator',
      'evaluator',
    ]);
    expect(result.managedTask?.evidence.entries).toEqual([
      expect.objectContaining({ assignmentId: 'admission', status: 'completed' }),
      expect.objectContaining({ assignmentId: 'planner', status: 'completed' }),
      expect.objectContaining({ assignmentId: 'contract-review', status: 'completed' }),
      expect.objectContaining({ assignmentId: 'generator', status: 'completed' }),
      expect.objectContaining({ assignmentId: 'evaluator', status: 'completed', signal: 'COMPLETE' }),
    ]);
    expect(result.managedTask?.roleAssignments).toEqual([
      expect.objectContaining({ id: 'admission', agent: 'AdmissionAgent' }),
      expect.objectContaining({ id: 'planner', agent: 'PlanningAgent' }),
      expect.objectContaining({ id: 'contract-review', agent: 'ContractReviewAgent' }),
      expect.objectContaining({ id: 'generator', agent: 'ExecutionAgent' }),
      expect.objectContaining({ id: 'evaluator', agent: 'EvaluationAgent' }),
    ]);
    const contractReviewerPrompt = String(
      mockRunDirectKodaX.mock.calls.find((call) => String(call[1]).includes('Contract Reviewer role'))?.[1] ?? ''
    );
    const generatorPrompt = String(
      mockRunDirectKodaX.mock.calls.find((call) => String(call[1]).includes('Generator role'))?.[1] ?? ''
    );
    expect(contractReviewerPrompt).toContain('Dependency handoff artifacts:');
    expect(generatorPrompt).toContain('Dependency handoff artifacts:');
  });

  it('preserves the full terminal evaluator output instead of replacing it with the managed-task summary', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-');
    mockCreateReasoningPlan.mockResolvedValue({
      mode: 'auto',
      depth: 'medium',
      promptOverlay: '[Routing] h1-long-final',
      decision: {
        primaryTask: 'review',
        confidence: 0.9,
        riskLevel: 'medium',
        recommendedMode: 'pr-review',
        recommendedThinkingDepth: 'medium',
        complexity: 'moderate',
        workIntent: 'overwrite',
        requiresBrainstorm: false,
        harnessProfile: 'H1_EXECUTE_EVAL',
        reason: 'Review requires independent QA.',
      },
    });

    const longReview = [
      'Final review: confirmed issues with detailed reasoning.',
      '',
      ...Array.from({ length: 32 }, (_, index) => `Must fix ${index + 1}: detailed explanation line ${index + 1}.`),
    ].join('\n');

    mockRunDirectKodaX.mockImplementation(async (_options, prompt: string) => {
      if (prompt.includes('Admission role')) {
        const lastText = buildAdmissionResponse('Admission confirmed that this review should begin in H1.');
        return {
          success: true,
          lastText,
          messages: [{ role: 'assistant', content: lastText }],
          sessionId: 'session-admission',
        };
      }

      if (prompt.includes('Generator role')) {
        const lastText = buildHandoffResponse(
          'Generator draft review.',
          {
            summary: 'Draft review is ready for evaluator validation.',
            evidence: ['Initial review draft captured the notable findings.'],
          },
        );
        return {
          success: true,
          lastText,
          messages: [{ role: 'assistant', content: lastText }],
          sessionId: 'session-generator',
        };
      }

      return {
        success: true,
        lastText: [
          longReview,
          '```kodax-task-verdict',
          'status: accept',
          'reason: The final review is complete.',
          'followup:',
          '- Deliver the final review.',
          '```',
        ].join('\n'),
        messages: [{
          role: 'assistant',
          content: [
            longReview,
            '```kodax-task-verdict',
            'status: accept',
            'reason: The final review is complete.',
            'followup:',
            '- Deliver the final review.',
            '```',
          ].join('\n'),
        }],
        sessionId: 'session-evaluator',
        signal: 'COMPLETE',
      };
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        context: {
          taskSurface: 'repl',
          managedTaskWorkspaceDir: workspaceRoot,
        },
      },
      'Review the release workflow changes and deliver the final code review.'
    );

    expect(result.lastText).toBe(longReview);
    expect(result.messages.at(-1)?.content).toBe(longReview);
    expect(result.managedTask?.verdict.summary).toBe(longReview);
  });

  it('can omit the evaluator for low-risk AMA tasks that stay within the solo implementation boundary', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-');
    const textDeltas: string[] = [];
    mockCreateReasoningPlan.mockResolvedValue({
      mode: 'auto',
      depth: 'medium',
      promptOverlay: '[Routing] h2-optional-qa',
      decision: {
        primaryTask: 'edit',
        confidence: 0.87,
        riskLevel: 'low',
        recommendedMode: 'implementation',
        recommendedThinkingDepth: 'medium',
        complexity: 'complex',
        workIntent: 'append',
        requiresBrainstorm: false,
        harnessProfile: 'H2_PLAN_EXECUTE_EVAL',
        reason: 'Complex but low-risk implementation task.',
      },
    });

    mockRunDirectKodaX.mockImplementation(async (_options, prompt: string) => {
      if (prompt.includes('Admission role')) {
        return {
          success: true,
          lastText: buildAdmissionResponse(
            'Admission confirmed the scoped implementation can stay on the current harness.',
            'H2_PLAN_EXECUTE_EVAL',
          ),
          messages: [{
            role: 'assistant',
            content: buildAdmissionResponse(
              'Admission confirmed the scoped implementation can stay on the current harness.',
              'H2_PLAN_EXECUTE_EVAL',
            ),
          }],
          sessionId: 'session-admission-optional-qa',
        };
      }

      if (prompt.includes('Planner role')) {
        return {
          success: true,
          lastText: [
            'Plan ready.',
            '```kodax-task-contract',
            'summary: Add the low-risk enhancement safely.',
            'success_criteria:',
            '- Enhancement works end-to-end.',
            'required_evidence:',
            '- Minimal implementation evidence.',
            'constraints:',
            '- Preserve existing behavior.',
            '```',
          ].join('\n'),
          messages: [{ role: 'assistant', content: [
            'Plan ready.',
            '```kodax-task-contract',
            'summary: Add the low-risk enhancement safely.',
            'success_criteria:',
            '- Enhancement works end-to-end.',
            'required_evidence:',
            '- Minimal implementation evidence.',
            'constraints:',
            '- Preserve existing behavior.',
            '```',
          ].join('\n') }],
          sessionId: 'session-planner-optional-qa',
        };
      }

      if (prompt.includes('Contract Reviewer role')) {
        return {
          success: true,
          lastText: [
            'The contract is approved for direct implementation.',
            '```kodax-task-contract-review',
            'status: approve',
            'reason: The task stays within the solo implementation boundary.',
            'followup:',
            '- Proceed directly to implementation.',
            '```',
          ].join('\n'),
          messages: [{ role: 'assistant', content: [
            'The contract is approved for direct implementation.',
            '```kodax-task-contract-review',
            'status: approve',
            'reason: The task stays within the solo implementation boundary.',
            'followup:',
            '- Proceed directly to implementation.',
            '```',
          ].join('\n') }],
          sessionId: 'session-contract-review-optional-qa',
        };
      }

      return {
        success: true,
        lastText: 'Final implementation answer delivered directly by the generator.',
        messages: [{ role: 'assistant', content: 'Final implementation answer delivered directly by the generator.' }],
        sessionId: 'session-generator-optional-qa',
      };
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        context: {
          taskSurface: 'cli',
          managedTaskWorkspaceDir: workspaceRoot,
        },
        events: {
          onTextDelta: (text) => {
            textDeltas.push(text);
          },
        },
      },
      'Implement the small enhancement and keep the rest of the workflow unchanged.'
    );

    expect(mockRunDirectKodaX).toHaveBeenCalledTimes(4);
    expect(mockRunDirectKodaX.mock.calls.some((call) => String(call[1]).includes('Evaluator role'))).toBe(false);
    expect(result.managedTask?.runtime?.qualityAssuranceMode).toBe('optional');
    expect(result.success).toBe(true);
    expect(result.managedTask?.roleAssignments.map((assignment) => assignment.role)).toEqual([
      'admission',
      'planner',
      'validator',
      'generator',
    ]);
    const generatorCall = mockRunDirectKodaX.mock.calls.find((call) =>
      String(call[1]).includes('Generator role')
    );
    expect(String(generatorCall?.[1])).toContain('You are the terminal delivery role for this run.');
  });

  it('forces single-agent execution when agent mode is SA', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-');
    mockCreateReasoningPlan.mockResolvedValue({
      mode: 'auto',
      depth: 'high',
      promptOverlay: '[Routing] h3',
      decision: {
        primaryTask: 'edit',
        confidence: 0.93,
        riskLevel: 'high',
        recommendedMode: 'implementation',
        recommendedThinkingDepth: 'high',
        complexity: 'complex',
        workIntent: 'overwrite',
        requiresBrainstorm: false,
        harnessProfile: 'H3_MULTI_WORKER',
        reason: 'Requires role-split execution and validation',
      },
    });
    mockRunDirectKodaX.mockResolvedValue({
      success: true,
      lastText: 'Handled in single-agent mode.',
      messages: [{ role: 'assistant', content: 'Handled in single-agent mode.' }],
      sessionId: 'session-sa',
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        agentMode: 'sa',
        context: {
          taskSurface: 'cli',
          managedTaskWorkspaceDir: workspaceRoot,
        },
      },
      'Implement the release workflow and validate it before accepting.'
    );

    expect(mockRunDirectKodaX).toHaveBeenCalledTimes(1);
    expect(result.routingDecision?.harnessProfile).toBe('H0_DIRECT');
    expect(result.managedTask?.contract.harnessProfile).toBe('H0_DIRECT');
    expect(result.managedTask?.roleAssignments).toEqual([
      expect.objectContaining({
        id: 'direct',
        role: 'direct',
        status: 'completed',
      }),
    ]);
    expect(result.routingDecision?.reason).toContain('Agent mode SA forced single-agent execution');
    expect(String(mockRunDirectKodaX.mock.calls[0]?.[0]?.context?.promptOverlay ?? '')).toContain('[Agent Mode: SA]');
  });

  it('injects verification contracts into evaluator runs and enforces evaluator tool policy', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-');
    mockCreateReasoningPlan.mockResolvedValue({
      mode: 'auto',
      depth: 'medium',
      promptOverlay: '[Routing] verify-ui',
      decision: {
        primaryTask: 'verify',
        confidence: 0.9,
        riskLevel: 'medium',
        recommendedMode: 'implementation',
        recommendedThinkingDepth: 'medium',
        complexity: 'complex',
        workIntent: 'append',
        requiresBrainstorm: false,
        harnessProfile: 'H2_PLAN_EXECUTE_EVAL',
        reason: 'Verification-heavy flow',
      },
    });

    mockRunDirectKodaX.mockImplementation(async (_options, prompt: string) => {
      if (prompt.includes('Admission role')) {
        const content = buildAdmissionResponse(
          'Admission confirmed the browser-verification scope and kept the task on H2.',
          'H2_PLAN_EXECUTE_EVAL',
        );
        return {
          success: true,
          lastText: content,
          messages: [{ role: 'assistant', content }],
          sessionId: 'session-admission-verify',
        };
      }

      if (prompt.includes('Planner role')) {
        const content = [
          'Planner prepared the verification contract.',
          '```kodax-task-contract',
          'summary: Verify the signup flow with browser evidence before accepting.',
          'success_criteria:',
          '- The signup flow is exercised end-to-end.',
          'required_evidence:',
          '- Browser evidence and console findings are captured.',
          'constraints:',
          '- Do not accept without runtime validation.',
          '```',
        ].join('\n');
        return {
          success: true,
          lastText: content,
          messages: [{ role: 'assistant', content }],
          sessionId: 'session-planner-verify',
        };
      }

      if (prompt.includes('Contract Reviewer role')) {
        const content = [
          'The contract is ready for browser verification work.',
          '```kodax-task-contract-review',
          'status: approve',
          'reason: The verification scope and evidence are explicit.',
          'followup:',
          '- Proceed with implementation and validation.',
          '```',
        ].join('\n');
        return {
          success: true,
          lastText: content,
          messages: [{ role: 'assistant', content }],
          sessionId: 'session-contract-review',
        };
      }

      if (prompt.includes('Generator role')) {
        const content = buildHandoffResponse('Intermediate worker finished.', {
          summary: 'Implementation work is ready for validation.',
          evidence: ['Prepared the verification setup and supporting evidence.'],
          followup: ['Proceed with the evaluator verification pass.'],
        });
        return {
          success: true,
          lastText: content,
          messages: [{ role: 'assistant', content }],
          sessionId: 'session-worker',
        };
      }

      const content = [
        'Evaluator finished after browser verification.',
        '```kodax-task-verdict',
        'status: accept',
        'reason: Browser verification is complete.',
        'followup:',
        '- Deliver the validated result.',
        '```',
      ].join('\n');
      return {
        success: true,
        lastText: content,
        messages: [{ role: 'assistant', content }],
        sessionId: 'session-evaluator',
        signal: 'COMPLETE',
      };
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        session: {
          id: 'outer-user-session',
          scope: 'user',
          storage: {
            save: vi.fn(async () => {}),
            load: vi.fn(async () => null),
            list: vi.fn(async () => []),
          },
        },
        context: {
          taskSurface: 'project',
          managedTaskWorkspaceDir: workspaceRoot,
          taskMetadata: {
            featureIndex: 7,
            projectMode: 'next',
          },
          taskVerification: {
            summary: 'Run real frontend verification before accepting.',
            instructions: ['Use agent-browser or Playwright to execute the signup flow.'],
            requiredEvidence: ['Attach browser evidence and console findings.'],
            requiredChecks: ['playwright:e2e'],
            runtime: {
              cwd: workspaceRoot,
              startupCommand: 'npm run dev',
              baseUrl: 'http://localhost:4173',
              apiChecks: ['health: curl http://localhost:4173/health'],
            },
            capabilityHints: [
              { kind: 'skill', name: 'agent-browser', details: 'Preferred browser automation skill.' },
              { kind: 'tool', name: 'playwright', details: 'Fallback browser runner.' },
            ],
          },
        },
      },
      'Verify the signup flow on the frontend and only accept with browser evidence.'
    );

    const evaluatorCall = mockRunDirectKodaX.mock.calls.find((call) =>
      String(call[1]).includes('Evaluator role')
    );
    expect(evaluatorCall).toBeTruthy();
    const evaluatorOptions = evaluatorCall?.[0];

    expect(String(evaluatorCall?.[1])).toContain('Verification contract:');
    expect(String(evaluatorCall?.[1])).toContain('agent-browser');
    expect(String(evaluatorCall?.[1])).toContain('Runtime execution guide:');
    expect(String(evaluatorCall?.[1])).toContain('Startup command: npm run dev');
    expect(evaluatorOptions?.context?.promptOverlay).toContain('Task metadata:');
    expect(evaluatorOptions?.context?.promptOverlay).toContain('"featureIndex": 7');
    expect(evaluatorOptions?.context?.taskVerification?.requiredChecks).toContain('playwright:e2e');
    expect(evaluatorOptions?.session?.id).toContain('managed-task-worker-task-');
    expect(evaluatorOptions?.session?.id).toContain('-evaluator');
    expect(evaluatorOptions?.session?.scope).toBe('managed-task-worker');
    expect(evaluatorOptions?.session?.storage).toBeDefined();

    const allowBrowser = await evaluatorOptions?.events?.beforeToolExecute?.('bash', { command: 'npx playwright test' });
    const allowRuntimeStartup = await evaluatorOptions?.events?.beforeToolExecute?.('bash', { command: 'npm run dev' });
    const allowRuntimeHealth = await evaluatorOptions?.events?.beforeToolExecute?.('bash', { command: 'curl http://localhost:4173/health' });
    const blockRuntimeStartupWrite = await evaluatorOptions?.events?.beforeToolExecute?.('bash', { command: 'npm run dev > runtime.log' });
    const blockWrite = await evaluatorOptions?.events?.beforeToolExecute?.('write', { path: 'src/app.ts', content: 'oops' });
    const blockShellWrite = await evaluatorOptions?.events?.beforeToolExecute?.('bash', { command: 'echo broken > src/app.ts' });

    expect(allowBrowser).toBe(true);
    expect(allowRuntimeStartup).toBe(true);
    expect(allowRuntimeHealth).toBe(true);
    expect(typeof blockRuntimeStartupWrite).toBe('string');
    expect(typeof blockWrite).toBe('string');
    expect(typeof blockShellWrite).toBe('string');
    expect(result.managedTask?.contract.verification?.capabilityHints?.map((hint) => hint.name)).toContain('agent-browser');
    expect(result.managedTask?.evidence.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: path.join(result.managedTask!.evidence.workspaceDir, 'runtime-execution.md'),
        }),
      ]),
    );
    expect(result.managedTask?.roleAssignments.find((assignment) => assignment.id === 'evaluator')).toEqual(
      expect.objectContaining({
        agent: 'EvaluationAgent',
        toolPolicy: expect.objectContaining({
          summary: expect.stringContaining('Verification agents'),
        }),
      }),
    );
  });

  it('uses compact worker memory seeds instead of raw session resume when the context is already heavy', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-');
    mockCreateReasoningPlan.mockResolvedValue({
      mode: 'auto',
      depth: 'medium',
      promptOverlay: '[Routing] compact-memory',
      decision: {
        primaryTask: 'review',
        confidence: 0.86,
        riskLevel: 'medium',
        recommendedMode: 'pr-review',
        recommendedThinkingDepth: 'medium',
        complexity: 'moderate',
        workIntent: 'append',
        requiresBrainstorm: false,
        harnessProfile: 'H1_EXECUTE_EVAL',
        reason: 'Review task with very large context.',
      },
    });

    mockRunDirectKodaX.mockImplementation(async (_options, prompt: string) => {
      if (prompt.includes('Admission role')) {
        const content = buildAdmissionResponse(
          'Admission kept the review on H1 with a compact worker memory strategy.',
          'H1_EXECUTE_EVAL',
        );
        return {
          success: true,
          lastText: content,
          messages: [{ role: 'assistant', content }],
          sessionId: 'session-admission-compact',
        };
      }

      if (prompt.includes('Generator role')) {
        const content = buildHandoffResponse('Compact-memory generator draft.', {
          summary: 'Compact-memory generator draft.',
          evidence: ['Focused draft review prepared from compacted memory.'],
          followup: ['Evaluator should validate the focused findings.'],
        });
        return {
          success: true,
          lastText: content,
          messages: [{ role: 'assistant', content }],
          sessionId: 'session-generator-compact',
        };
      }

      return {
        success: true,
        lastText: [
          'Compact-memory review accepted.',
          '```kodax-task-verdict',
          'status: accept',
          'reason: The compact-memory run still produced a complete review.',
          'followup:',
          '- Deliver the final answer.',
          '```',
        ].join('\n'),
        messages: [{
          role: 'assistant',
          content: [
            'Compact-memory review accepted.',
            '```kodax-task-verdict',
            'status: accept',
            'reason: The compact-memory run still produced a complete review.',
            'followup:',
            '- Deliver the final answer.',
            '```',
          ].join('\n'),
        }],
        sessionId: 'session-evaluator-compact',
        signal: 'COMPLETE',
      };
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        context: {
          taskSurface: 'cli',
          managedTaskWorkspaceDir: workspaceRoot,
          contextTokenSnapshot: {
            currentTokens: 130000,
            baselineEstimatedTokens: 130000,
            source: 'estimate',
          },
        },
      },
      'Review the release workflow changes and stay focused on the critical findings.'
    );

    const generatorCall = mockRunDirectKodaX.mock.calls.find((call) =>
      String(call[1]).includes('Generator role')
    );
    const generatorOptions = generatorCall?.[0];

    expect(generatorOptions?.session?.resume).toBe(false);
    expect(generatorOptions?.session?.autoResume).toBe(false);
    expect(generatorOptions?.session?.initialMessages?.[0]?.content).toContain('Compacted managed-task memory:');
    expect(result.managedTask?.runtime?.memoryStrategies?.generator).toBe('compact');
    expect(
      Object.values(result.managedTask?.runtime?.memoryNotes ?? {}).some((note) =>
        note.includes('Compacted managed-task memory:')
      )
    ).toBe(true);
  });

  it('forwards non-terminal worker output for observability', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-');
    const textDeltas: string[] = [];
    mockCreateReasoningPlan.mockResolvedValue({
      mode: 'auto',
      depth: 'medium',
      promptOverlay: '[Routing] observability',
      decision: {
        primaryTask: 'plan',
        confidence: 0.88,
        riskLevel: 'medium',
        recommendedMode: 'planning',
        recommendedThinkingDepth: 'medium',
        complexity: 'complex',
        workIntent: 'append',
        requiresBrainstorm: false,
        harnessProfile: 'H2_PLAN_EXECUTE_EVAL',
        reason: 'Need visible orchestration',
      },
    });

    mockRunDirectKodaX.mockImplementation(async (options, prompt: string) => {
      if (prompt.includes('Planner role')) {
        options.events?.onTextDelta?.('Planner checked the repo.');
      }
      if (prompt.includes('Contract Reviewer role')) {
        return {
          success: true,
          lastText: [
            'Contract review passed.',
            '```kodax-task-contract-review',
            'status: approve',
            'reason: The contract is specific enough to execute.',
            'followup:',
            '- Continue to implementation.',
            '```',
          ].join('\n'),
          messages: [{
            role: 'assistant',
            content: [
              'Contract review passed.',
              '```kodax-task-contract-review',
              'status: approve',
              'reason: The contract is specific enough to execute.',
              'followup:',
              '- Continue to implementation.',
              '```',
            ].join('\n'),
          }],
          sessionId: 'session-contract-review',
        };
      }
      return {
        success: true,
        lastText: prompt.includes('Evaluator role')
          ? [
              'Evaluator accepted.',
              '```kodax-task-verdict',
              'status: accept',
              'reason: The work is complete.',
              'followup:',
              '- Deliver the final answer.',
              '```',
            ].join('\n')
          : 'Worker output.',
        messages: [{
          role: 'assistant',
          content: prompt.includes('Evaluator role')
            ? [
                'Evaluator accepted.',
                '```kodax-task-verdict',
                'status: accept',
                'reason: The work is complete.',
                'followup:',
                '- Deliver the final answer.',
                '```',
              ].join('\n')
            : 'Worker output.',
        }],
        sessionId: prompt.includes('Evaluator role') ? 'session-evaluator' : 'session-other',
        signal: prompt.includes('Evaluator role') ? 'COMPLETE' : undefined,
      };
    });

    await runManagedTask(
      {
        provider: 'anthropic',
        context: {
          taskSurface: 'repl',
          managedTaskWorkspaceDir: workspaceRoot,
        },
        events: {
          onTextDelta: (text) => {
            textDeltas.push(text);
          },
        },
      },
      'Plan and implement a visible orchestration flow.'
    );

    expect(textDeltas.join('')).toContain('[Planner]');
    expect(textDeltas.join('')).toContain('Planner checked the repo.');
    expect(textDeltas.join('')).toContain('starting');
  });

  it('runs H3 managed tasks with parallel worker roles and evaluator handoff', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-');
    let concurrent = 0;
    let maxConcurrent = 0;

    mockCreateReasoningPlan.mockResolvedValue({
      mode: 'auto',
      depth: 'high',
      promptOverlay: '[Routing] h3',
      decision: {
        primaryTask: 'edit',
        confidence: 0.93,
        riskLevel: 'high',
        recommendedMode: 'implementation',
        recommendedThinkingDepth: 'high',
        complexity: 'complex',
        workIntent: 'overwrite',
        requiresBrainstorm: false,
        harnessProfile: 'H3_MULTI_WORKER',
        reason: 'Requires role-split execution and validation',
      },
    });

    mockRunDirectKodaX.mockImplementation(async (options, prompt: string) => {
      const overlay = String(options.context?.promptOverlay ?? '');
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      try {
        if (overlay.includes('worker=worker-implementation') || overlay.includes('worker=worker-validation')) {
          await delay(25);
        } else {
          await delay(5);
        }

        if (prompt.includes('Admission role')) {
          const content = buildAdmissionResponse(
            'Admission confirmed the task should start directly on H3 for split execution and validation.',
            'H3_MULTI_WORKER',
          );
          return {
            success: true,
            lastText: content,
            messages: [{ role: 'assistant', content }],
            sessionId: 'session-admission',
          };
        }

        if (prompt.includes('Lead role')) {
          return {
            success: true,
            lastText: [
              'Lead aligned the execution strategy.',
              '```kodax-task-contract',
              'summary: Coordinate the implementation and validation lanes for the release workflow.',
              'success_criteria:',
              '- The implementation and validation workers stay aligned on the same release-workflow contract.',
              'required_evidence:',
              '- Explicit coordination guidance for the downstream workers.',
              'constraints:',
              '- Preserve rollback behavior.',
              '```',
            ].join('\n'),
            messages: [{ role: 'assistant', content: [
              'Lead aligned the execution strategy.',
              '```kodax-task-contract',
              'summary: Coordinate the implementation and validation lanes for the release workflow.',
              'success_criteria:',
              '- The implementation and validation workers stay aligned on the same release-workflow contract.',
              'required_evidence:',
              '- Explicit coordination guidance for the downstream workers.',
              'constraints:',
              '- Preserve rollback behavior.',
              '```',
            ].join('\n') }],
            sessionId: 'session-lead',
          };
        }

        if (prompt.includes('Planner role')) {
          return {
            success: true,
            lastText: [
              'Planner produced the decomposition.',
              '```kodax-task-contract',
              'summary: Implement and validate the release workflow.',
              'success_criteria:',
              '- The release workflow is implemented.',
              '- Validation covers the release workflow end-to-end.',
              'required_evidence:',
              '- Validation evidence for the release workflow.',
              'constraints:',
              '- Preserve rollback behavior.',
              '```',
            ].join('\n'),
            messages: [{ role: 'assistant', content: [
              'Planner produced the decomposition.',
              '```kodax-task-contract',
              'summary: Implement and validate the release workflow.',
              'success_criteria:',
              '- The release workflow is implemented.',
              '- Validation covers the release workflow end-to-end.',
              'required_evidence:',
              '- Validation evidence for the release workflow.',
              'constraints:',
              '- Preserve rollback behavior.',
              '```',
            ].join('\n') }],
            sessionId: 'session-planner',
          };
        }

        if (prompt.includes('Contract Reviewer role')) {
          return {
            success: true,
            lastText: [
              'The implementation contract is approved.',
              '```kodax-task-contract-review',
              'status: approve',
              'reason: The worker split and evidence plan are concrete enough.',
              'followup:',
              '- Proceed with implementation and validation.',
              '```',
            ].join('\n'),
            messages: [{ role: 'assistant', content: [
              'The implementation contract is approved.',
              '```kodax-task-contract-review',
              'status: approve',
              'reason: The worker split and evidence plan are concrete enough.',
              'followup:',
              '- Proceed with implementation and validation.',
              '```',
            ].join('\n') }],
            sessionId: 'session-contract-review',
          };
        }

        if (overlay.includes('worker=worker-implementation')) {
          const content = buildHandoffResponse('Implementation worker updated the feature.', {
            summary: 'Implementation worker updated the feature.',
            evidence: ['Implementation changes were applied to the assigned slice.'],
            followup: ['Evaluator should combine this with validation evidence.'],
          });
          return {
            success: true,
            lastText: content,
            messages: [{ role: 'assistant', content }],
            sessionId: 'session-implementation',
          };
        }

        if (overlay.includes('worker=worker-validation')) {
          const content = buildHandoffResponse('Validation worker checked the flow.', {
            summary: 'Validation worker checked the flow.',
            evidence: ['Validation checks for the release flow completed.'],
            followup: ['Evaluator should merge implementation and validation evidence.'],
          });
          return {
            success: true,
            lastText: content,
            messages: [{ role: 'assistant', content }],
            sessionId: 'session-validation',
          };
        }

        return {
          success: true,
          lastText: [
            'Evaluator accepted both implementation and validation evidence.',
            '```kodax-task-verdict',
            'status: accept',
            'reason: Implementation and validation evidence are sufficient.',
            'followup:',
            '- Deliver the final answer.',
            '```',
          ].join('\n'),
          messages: [{
            role: 'assistant',
            content: [
              'Evaluator accepted both implementation and validation evidence.',
              '```kodax-task-verdict',
              'status: accept',
              'reason: Implementation and validation evidence are sufficient.',
              'followup:',
              '- Deliver the final answer.',
              '```',
            ].join('\n'),
          }],
          sessionId: 'session-evaluator',
          signal: 'COMPLETE',
        };
      } finally {
        concurrent -= 1;
      }
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        context: {
          taskSurface: 'project',
          managedTaskWorkspaceDir: workspaceRoot,
        },
      },
      'Implement the release workflow and validate it before accepting.'
    );

    expect(mockRunDirectKodaX).toHaveBeenCalledTimes(7);
    expect(maxConcurrent).toBeGreaterThanOrEqual(2);
    expect(result.success).toBe(true);
    expect(result.managedTask?.contract.harnessProfile).toBe('H3_MULTI_WORKER');
    expect(result.managedTask?.roleAssignments.map((assignment) => assignment.role)).toEqual([
      'admission',
      'lead',
      'planner',
      'validator',
      'worker',
      'validator',
      'evaluator',
    ]);

    const evaluatorCall = mockRunDirectKodaX.mock.calls.find((call) =>
      String(call[1]).includes('Evaluator role')
    );
    expect(String(evaluatorCall?.[1])).toContain('Implementation Worker');
    expect(String(evaluatorCall?.[1])).toContain('Validation Worker');
  expect(result.managedTask?.evidence.entries).toEqual([
      expect.objectContaining({ assignmentId: 'admission', status: 'completed' }),
      expect.objectContaining({ assignmentId: 'lead', status: 'completed' }),
      expect.objectContaining({ assignmentId: 'planner', status: 'completed' }),
      expect.objectContaining({ assignmentId: 'contract-review', status: 'completed' }),
      expect.objectContaining({ assignmentId: 'worker-implementation', status: 'completed' }),
      expect.objectContaining({ assignmentId: 'worker-validation', status: 'completed' }),
      expect.objectContaining({ assignmentId: 'evaluator', status: 'completed', signal: 'COMPLETE' }),
    ]);
  });

  it('uses contract summaries for lead and planner even when they only emit structured blocks', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-');

    mockCreateReasoningPlan.mockResolvedValue({
      mode: 'auto',
      depth: 'high',
      promptOverlay: '[Routing] h3-contract-summary',
      decision: {
        primaryTask: 'review',
        confidence: 0.9,
        riskLevel: 'high',
        recommendedMode: 'review',
        recommendedThinkingDepth: 'high',
        complexity: 'complex',
        workIntent: 'new',
        requiresBrainstorm: false,
        harnessProfile: 'H3_MULTI_WORKER',
        reason: 'Massive review needs split coverage.',
      },
    });

    mockRunDirectKodaX.mockImplementation(async (_options, prompt: string) => {
      if (prompt.includes('Admission role')) {
        const content = buildAdmissionResponse(
          'Admission confirmed the H3 review should begin with preflight evidence gathering.',
          'H3_MULTI_WORKER',
        );
        return {
          success: true,
          lastText: content,
          messages: [{ role: 'assistant', content }],
          sessionId: 'session-admission-contract-summary',
        };
      }

      if (prompt.includes('Lead role')) {
        const content = [
          '```kodax-task-contract',
          'summary: Coordinate high-risk and surface review lanes.',
          'success_criteria:',
          '- High-risk coverage is explicit.',
          'required_evidence:',
          '- Evidence plan for both review lanes.',
          'constraints:',
          '- Preserve review completeness.',
          '```',
        ].join('\n');
        return {
          success: true,
          lastText: content,
          messages: [{ role: 'assistant', content }],
          sessionId: 'session-lead-contract-summary',
        };
      }

      if (prompt.includes('Planner role')) {
        const content = [
          '```kodax-task-contract',
          'summary: Review task-engine and REPL changes with explicit worker coverage.',
          'success_criteria:',
          '- Review findings are evidence-backed.',
          'required_evidence:',
          '- Concrete diff evidence for both review lanes.',
          'constraints:',
          '- Do not miss cross-cutting regressions.',
          '```',
        ].join('\n');
        return {
          success: true,
          lastText: content,
          messages: [{ role: 'assistant', content }],
          sessionId: 'session-planner-contract-summary',
        };
      }

      if (prompt.includes('Contract Reviewer role')) {
        const content = [
          '```kodax-task-contract-review',
          'status: approve',
          'reason: The H3 review split is concrete enough.',
          'followup:',
          '- Proceed with review execution.',
          '```',
        ].join('\n');
        return {
          success: true,
          lastText: content,
          messages: [{ role: 'assistant', content }],
          sessionId: 'session-contract-review-contract-summary',
        };
      }

      if (prompt.includes('High-Risk Review Worker role')) {
        const content = buildHandoffResponse('', {
          summary: 'High-risk review worker completed the runtime pass.',
          evidence: ['Runtime-sensitive paths were reviewed.'],
          followup: ['Evaluator should merge runtime findings.'],
        });
        return {
          success: true,
          lastText: content,
          messages: [{ role: 'assistant', content }],
          sessionId: 'session-high-risk-contract-summary',
        };
      }

      if (prompt.includes('Surface Review Worker role')) {
        const content = buildHandoffResponse('', {
          summary: 'Surface review worker completed the regression pass.',
          evidence: ['Regression-sensitive UI paths were reviewed.'],
          followup: ['Evaluator should merge regression findings.'],
        });
        return {
          success: true,
          lastText: content,
          messages: [{ role: 'assistant', content }],
          sessionId: 'session-surface-contract-summary',
        };
      }

      const content = [
        'Final review completed.',
        '```kodax-task-verdict',
        'status: accept',
        'reason: The review coverage is complete.',
        'followup:',
        '- Deliver the review.',
        '```',
      ].join('\n');
      return {
        success: true,
        lastText: content,
        messages: [{ role: 'assistant', content }],
        sessionId: 'session-evaluator-contract-summary',
      };
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        context: {
          taskSurface: 'project',
          managedTaskWorkspaceDir: workspaceRoot,
        },
      },
      'Review the current changes.'
    );

    expect(result.managedTask?.evidence.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        assignmentId: 'lead',
        summary: 'Coordinate high-risk and surface review lanes.',
        output: 'Coordinate high-risk and surface review lanes.',
      }),
      expect.objectContaining({
        assignmentId: 'planner',
        summary: 'Review task-engine and REPL changes with explicit worker coverage.',
        output: 'Review task-engine and REPL changes with explicit worker coverage.',
      }),
    ]));
  });

  it('runs an explicit evaluator-to-generator refinement loop before accepting AMA tasks', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-');
    const textDeltas: string[] = [];
    mockCreateReasoningPlan.mockResolvedValue({
      mode: 'auto',
      depth: 'medium',
      promptOverlay: '[Routing] review',
      decision: {
        primaryTask: 'review',
        confidence: 0.9,
        riskLevel: 'medium',
        recommendedMode: 'pr-review',
        recommendedThinkingDepth: 'medium',
        complexity: 'moderate',
        workIntent: 'append',
        requiresBrainstorm: false,
        harnessProfile: 'H1_EXECUTE_EVAL',
        reason: 'Review tasks require an independent evaluator.',
      },
    });

    let evaluatorRound = 0;
    mockRunDirectKodaX.mockImplementation(async (_options, prompt: string) => {
      if (prompt.includes('Admission role')) {
        const content = buildAdmissionResponse(
          'Admission confirmed the review should start on H1 with an independent evaluator.',
          'H1_EXECUTE_EVAL',
        );
        return {
          success: true,
          lastText: content,
          messages: [{ role: 'assistant', content }],
          sessionId: 'session-admission-review',
        };
      }

      if (prompt.includes('Generator role')) {
        const isRefinement = prompt.includes('Evaluator feedback after round 1:');
        const visibleText = isRefinement
          ? 'Must Fix #1: switch to dynamic import and add guardrails around the index build.'
          : 'Must Fix #1: switch to dynamic import.';
        const content = buildHandoffResponse(visibleText, {
          summary: visibleText,
          evidence: isRefinement
            ? ['Dynamic import issue and index-build resilience issue both documented.']
            : ['Dynamic import issue documented.'],
          followup: ['Evaluator should validate the review coverage.'],
        });
        return {
          success: true,
          lastText: content,
          messages: [{
            role: 'assistant',
            content,
          }],
          sessionId: isRefinement ? 'session-generator-round-2' : 'session-generator-round-1',
        };
      }

      evaluatorRound += 1;
      if (evaluatorRound === 1) {
        return {
          success: true,
          lastText: [
            'Final code review is not ready yet. The TypeScript import finding is valid, but the review needs one more pass with the missing index-build failure mode covered.',
            '```kodax-task-verdict',
            'status: revise',
            'reason: The review is incomplete and needs one more must-fix finding.',
            'followup:',
            '- Add the index-build failure finding with concrete consequence and fix direction.',
            '```',
          ].join('\n'),
          messages: [{
            role: 'assistant',
            content: [
              'Final code review is not ready yet. The TypeScript import finding is valid, but the review needs one more pass with the missing index-build failure mode covered.',
              '```kodax-task-verdict',
              'status: revise',
              'reason: The review is incomplete and needs one more must-fix finding.',
              'followup:',
              '- Add the index-build failure finding with concrete consequence and fix direction.',
              '```',
            ].join('\n'),
          }],
          sessionId: 'session-evaluator-round-1',
          signal: 'BLOCKED',
        };
      }

      return {
        success: true,
        lastText: [
          'Final code review: 2 must-fix findings are confirmed, with dynamic import and index-build resilience called out precisely.',
          '```kodax-task-verdict',
          'status: accept',
          'reason: Review findings are complete and supported.',
          'followup:',
          '- Ship the validated review as the final answer.',
          '```',
        ].join('\n'),
        messages: [{
          role: 'assistant',
          content: [
            'Final code review: 2 must-fix findings are confirmed, with dynamic import and index-build resilience called out precisely.',
            '```kodax-task-verdict',
            'status: accept',
            'reason: Review findings are complete and supported.',
            'followup:',
            '- Ship the validated review as the final answer.',
            '```',
          ].join('\n'),
        }],
        sessionId: 'session-evaluator-round-2',
        signal: 'COMPLETE',
      };
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        context: {
          taskSurface: 'cli',
          managedTaskWorkspaceDir: workspaceRoot,
        },
        events: {
          onTextDelta: (text) => {
            textDeltas.push(text);
          },
        },
      },
      'Review the repo-intelligence changes and deliver the final code review.'
    );

    expect(mockRunDirectKodaX).toHaveBeenCalledTimes(5);
    expect(result.success).toBe(true);
    expect(result.lastText).toContain('Final code review: 2 must-fix findings are confirmed');
    expect(result.messages.at(-1)?.content).not.toContain('```kodax-task-verdict');
    expect(result.managedTask?.evidence.entries.map((entry) => ({
      assignmentId: entry.assignmentId,
      round: entry.round,
    }))).toEqual([
      { assignmentId: 'admission', round: 0 },
      { assignmentId: 'generator', round: 1 },
      { assignmentId: 'evaluator', round: 1 },
      { assignmentId: 'generator', round: 2 },
      { assignmentId: 'evaluator', round: 2 },
    ]);
    expect(textDeltas.join('')).toContain('evaluator requested another pass');

    const generatorCalls = mockRunDirectKodaX.mock.calls.filter((call) =>
      String(call[1]).includes('Generator role')
    );
    expect(generatorCalls).toHaveLength(2);
    expect(String(generatorCalls[1]?.[1])).toContain('Evaluator feedback after round 1:');
    expect(String(generatorCalls[1]?.[1])).toContain('Previous round feedback artifact:');
    expect(String(generatorCalls[1]?.[1])).toContain('Add the index-build failure finding with concrete consequence and fix direction.');

    const roundHistory = JSON.parse(
      await readFile(path.join(result.managedTask!.evidence.workspaceDir, 'round-history.json'), 'utf8')
    );
    expect(roundHistory).toHaveLength(3);
    expect(roundHistory.map((entry: { round: number }) => entry.round)).toEqual([0, 1, 2]);
    expect(result.managedTask?.evidence.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: path.join(result.managedTask!.evidence.workspaceDir, 'round-history.json'),
        }),
        expect.objectContaining({
          path: path.join(result.managedTask!.evidence.workspaceDir, 'rounds', 'round-01', 'feedback.json'),
        }),
      ]),
    );
  });

  it('reduces the AMA round budget when the existing context is already large', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-');
    const textDeltas: string[] = [];
    mockCreateReasoningPlan.mockResolvedValue({
      mode: 'auto',
      depth: 'medium',
      promptOverlay: '[Routing] review-budget',
      decision: {
        primaryTask: 'review',
        confidence: 0.9,
        riskLevel: 'medium',
        recommendedMode: 'pr-review',
        recommendedThinkingDepth: 'medium',
        complexity: 'moderate',
        workIntent: 'append',
        requiresBrainstorm: false,
        harnessProfile: 'H1_EXECUTE_EVAL',
        reason: 'Review tasks require an independent evaluator.',
      },
    });

    mockRunDirectKodaX.mockImplementation(async (_options, prompt: string) => {
      if (prompt.includes('Admission role')) {
        const content = buildAdmissionResponse(
          'Admission confirmed the current review harness and large-context budget.',
          'H1_EXECUTE_EVAL',
        );
        return {
          success: true,
          lastText: content,
          messages: [{ role: 'assistant', content }],
          sessionId: 'session-admission-budget',
        };
      }

      if (prompt.includes('Generator role')) {
        const content = buildHandoffResponse('Draft review still needs another pass.', {
          summary: 'Draft review still needs another pass.',
          evidence: ['A preliminary review draft is available.'],
          followup: ['Evaluator should decide whether another round is required.'],
        });
        return {
          success: true,
          lastText: content,
          messages: [{ role: 'assistant', content }],
          sessionId: 'session-generator-budget',
        };
      }

      return {
        success: true,
        lastText: [
          'The review still needs another pass.',
          '```kodax-task-verdict',
          'status: revise',
          'reason: One more review pass is still requested.',
          'followup:',
          '- Keep iterating.',
          '```',
        ].join('\n'),
        messages: [{
          role: 'assistant',
          content: [
            'The review still needs another pass.',
            '```kodax-task-verdict',
            'status: revise',
            'reason: One more review pass is still requested.',
            'followup:',
            '- Keep iterating.',
            '```',
          ].join('\n'),
        }],
        sessionId: 'session-evaluator-budget',
      };
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        context: {
          taskSurface: 'cli',
          managedTaskWorkspaceDir: workspaceRoot,
          contextTokenSnapshot: {
            currentTokens: 130000,
            baselineEstimatedTokens: 130000,
            source: 'estimate',
          },
        },
        events: {
          onTextDelta: (text) => {
            textDeltas.push(text);
          },
        },
      },
      'Review the code changes and keep iterating until the review is complete.'
    );

    expect(mockRunDirectKodaX).toHaveBeenCalledTimes(5);
    expect(result.managedTask?.runtime?.budget?.plannedRounds).toBe(2);
    expect(result.success).toBe(false);
    expect(result.signal).toBe('BLOCKED');
    expect(result.signalReason).toContain('One more review pass is still requested');
    const continuation = JSON.parse(
      await readFile(path.join(result.managedTask!.evidence.workspaceDir, 'continuation.json'), 'utf8')
    );
    expect(continuation.continuationSuggested).toBe(true);
    expect(String(continuation.latestFeedbackArtifact)).toContain('feedback.json');
    expect(String(continuation.suggestedPrompt)).toContain('Keep iterating.');
  });

  it('extends the AMA round budget for project-scoped long-running tasks', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-');
    const textDeltas: string[] = [];
    mockCreateReasoningPlan.mockResolvedValue({
      mode: 'auto',
      depth: 'high',
      promptOverlay: '[Routing] project-long-running',
      decision: {
        primaryTask: 'review',
        confidence: 0.94,
        riskLevel: 'high',
        recommendedMode: 'pr-review',
        recommendedThinkingDepth: 'high',
        complexity: 'complex',
        workIntent: 'overwrite',
        requiresBrainstorm: true,
        harnessProfile: 'H2_PLAN_EXECUTE_EVAL',
        reason: 'Project-scoped long-running review.',
      },
    });

    mockRunDirectKodaX.mockImplementation(async (_options, prompt: string) => {
      if (prompt.includes('Admission role')) {
        const content = buildAdmissionResponse(
          'Admission confirmed the project-scoped long-running review should stay on H2.',
          'H2_PLAN_EXECUTE_EVAL',
        );
        return {
          success: true,
          lastText: content,
          messages: [{ role: 'assistant', content }],
          sessionId: 'session-admission-project',
        };
      }

      if (prompt.includes('Planner role')) {
        return {
          success: true,
          lastText: [
            'Plan ready.',
            '```kodax-task-contract',
            'summary: Long-running project review.',
            'success_criteria:',
            '- Deliver the project review.',
            'required_evidence:',
            '- Verified project evidence.',
            'constraints:',
            '- Stay within the review scope.',
            '```',
          ].join('\n'),
          messages: [{ role: 'assistant', content: [
            'Plan ready.',
            '```kodax-task-contract',
            'summary: Long-running project review.',
            'success_criteria:',
            '- Deliver the project review.',
            'required_evidence:',
            '- Verified project evidence.',
            'constraints:',
            '- Stay within the review scope.',
            '```',
          ].join('\n') }],
          sessionId: 'session-planner-project',
        };
      }
      if (prompt.includes('Contract Reviewer role')) {
        return {
          success: true,
          lastText: [
            'Contract approved.',
            '```kodax-task-contract-review',
            'status: approve',
            'reason: The project review contract is clear.',
            'followup:',
            '- Proceed.',
            '```',
          ].join('\n'),
          messages: [{ role: 'assistant', content: [
            'Contract approved.',
            '```kodax-task-contract-review',
            'status: approve',
            'reason: The project review contract is clear.',
            'followup:',
            '- Proceed.',
            '```',
          ].join('\n') }],
          sessionId: 'session-contract-review-project',
        };
      }
      if (prompt.includes('Generator role')) {
        const content = buildHandoffResponse('Project review draft ready.', {
          summary: 'Project review draft ready.',
          evidence: ['Project-scoped review draft prepared.'],
          followup: ['Evaluator should validate the project review draft.'],
        });
        return {
          success: true,
          lastText: content,
          messages: [{ role: 'assistant', content }],
          sessionId: 'session-generator-project',
        };
      }
      return {
        success: true,
        lastText: [
          'Project review accepted.',
          '```kodax-task-verdict',
          'status: accept',
          'reason: The project review is complete.',
          'followup:',
          '- Deliver the review.',
          '```',
        ].join('\n'),
        messages: [{ role: 'assistant', content: [
          'Project review accepted.',
          '```kodax-task-verdict',
          'status: accept',
          'reason: The project review is complete.',
          'followup:',
          '- Deliver the review.',
          '```',
        ].join('\n') }],
        sessionId: 'session-evaluator-project',
      };
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        context: {
          taskSurface: 'project',
          managedTaskWorkspaceDir: workspaceRoot,
          longRunning: {
            featuresFile: 'docs/features.md',
            progressFile: '.agent/progress.md',
          },
        },
        events: {
          onTextDelta: (text) => {
            textDeltas.push(text);
          },
        },
      },
      'Review the project implementation until the managed task concludes.'
    );

    expect(textDeltas.join('')).not.toContain('quality assurance mode=');
    expect(textDeltas.join('')).not.toContain('adaptive round budget=');
    expect(textDeltas.join('')).not.toContain('[Managed Task Routing] mode=');
    expect(result.managedTask?.runtime?.budget?.plannedRounds).toBe(11);
  });

  it('blocks managed tasks when the evaluator omits the required verdict block', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-');
    mockCreateReasoningPlan.mockResolvedValue({
      mode: 'auto',
      depth: 'medium',
      promptOverlay: '[Routing] review',
      decision: {
        primaryTask: 'review',
        confidence: 0.9,
        riskLevel: 'medium',
        recommendedMode: 'pr-review',
        recommendedThinkingDepth: 'medium',
        complexity: 'moderate',
        workIntent: 'append',
        requiresBrainstorm: false,
        harnessProfile: 'H1_EXECUTE_EVAL',
        reason: 'Review tasks require an independent evaluator.',
      },
    });

    mockRunDirectKodaX.mockImplementation(async (_options, prompt: string) => {
      if (prompt.includes('Admission role')) {
        const content = buildAdmissionResponse(
          'Admission confirmed the review should start on H1.',
          'H1_EXECUTE_EVAL',
        );
        return {
          success: true,
          lastText: content,
          messages: [{ role: 'assistant', content }],
          sessionId: 'session-admission-blocked',
        };
      }

      if (prompt.includes('Generator role')) {
        const content = buildHandoffResponse('Draft review with one finding.', {
          summary: 'Draft review with one finding.',
          evidence: ['One review finding is documented.'],
          followup: ['Evaluator should assess whether the review is complete.'],
        });
        return {
          success: true,
          lastText: content,
          messages: [{ role: 'assistant', content }],
          sessionId: 'session-generator',
        };
      }

      return {
        success: true,
        lastText: 'The review is incomplete and needs another pass, but I forgot the fenced block.',
        messages: [{
          role: 'assistant',
          content: 'The review is incomplete and needs another pass, but I forgot the fenced block.',
        }],
        sessionId: 'session-evaluator',
      };
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        context: {
          taskSurface: 'cli',
          managedTaskWorkspaceDir: workspaceRoot,
        },
      },
      'Review the repo-intelligence changes and deliver the final code review.'
    );

    expect(result.success).toBe(false);
    expect(result.signal).toBe('BLOCKED');
    expect(result.signalReason).toContain('omitted required');
    expect(result.managedTask?.verdict.status).toBe('blocked');
  });

  it('re-enters planner during H2 refinement and persists the updated task contract', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-');
    mockCreateReasoningPlan.mockResolvedValue({
      mode: 'auto',
      depth: 'medium',
      promptOverlay: '[Routing] h2-contract',
      decision: {
        primaryTask: 'edit',
        confidence: 0.89,
        riskLevel: 'medium',
        recommendedMode: 'implementation',
        recommendedThinkingDepth: 'medium',
        complexity: 'complex',
        workIntent: 'overwrite',
        requiresBrainstorm: false,
        harnessProfile: 'H2_PLAN_EXECUTE_EVAL',
        reason: 'Needs contract-backed implementation.',
      },
    });

    let plannerRound = 0;
    mockRunDirectKodaX.mockImplementation(async (options, prompt: string) => {
      if (prompt.includes('Admission role')) {
        const content = buildAdmissionResponse(
          'Admission confirmed the release workflow edit should start on H2.',
          'H2_PLAN_EXECUTE_EVAL',
        );
        return {
          success: true,
          lastText: content,
          messages: [{ role: 'assistant', content }],
          sessionId: 'session-admission-h2-refinement',
        };
      }

      if (prompt.includes('Planner role')) {
        plannerRound += 1;
        if (plannerRound === 1) {
          return {
            success: true,
            lastText: [
              'Initial plan is ready.',
              '```kodax-task-contract',
              'summary: Ship the release workflow safely.',
              'success_criteria:',
              '- Release workflow completes end-to-end.',
              'required_evidence:',
              '- Focused automated verification.',
              'constraints:',
              '- Do not break rollback behavior.',
              '```',
            ].join('\n'),
            messages: [{
              role: 'assistant',
              content: [
                'Initial plan is ready.',
                '```kodax-task-contract',
                'summary: Ship the release workflow safely.',
                'success_criteria:',
                '- Release workflow completes end-to-end.',
                'required_evidence:',
                '- Focused automated verification.',
                'constraints:',
                '- Do not break rollback behavior.',
                '```',
              ].join('\n'),
            }],
            sessionId: 'session-planner-round-1',
          };
        }

        return {
          success: true,
          lastText: [
            'Replanned contract with rollback coverage.',
            '```kodax-task-contract',
            'summary: Ship the release workflow safely with rollback coverage.',
            'success_criteria:',
            '- Release workflow completes end-to-end.',
            '- Rollback path is explicitly covered.',
            'required_evidence:',
            '- Focused automated verification.',
            '- Rollback-path verification evidence.',
            'constraints:',
            '- Do not break rollback behavior.',
            '```',
          ].join('\n'),
          messages: [{
            role: 'assistant',
            content: [
              'Replanned contract with rollback coverage.',
              '```kodax-task-contract',
              'summary: Ship the release workflow safely with rollback coverage.',
              'success_criteria:',
              '- Release workflow completes end-to-end.',
              '- Rollback path is explicitly covered.',
              'required_evidence:',
              '- Focused automated verification.',
              '- Rollback-path verification evidence.',
              'constraints:',
              '- Do not break rollback behavior.',
              '```',
            ].join('\n'),
          }],
          sessionId: 'session-planner-round-2',
        };
      }

      if (prompt.includes('Contract Reviewer role')) {
        if (plannerRound === 1) {
          return {
            success: true,
            lastText: [
              'The contract needs replanning to cover rollback.',
              '```kodax-task-contract-review',
              'status: revise',
              'reason: The contract is missing explicit rollback-path coverage.',
              'followup:',
              '- Replan with rollback-path success criteria and evidence.',
              '```',
            ].join('\n'),
            messages: [{
              role: 'assistant',
              content: [
                'The contract needs replanning to cover rollback.',
                '```kodax-task-contract-review',
                'status: revise',
                'reason: The contract is missing explicit rollback-path coverage.',
                'followup:',
                '- Replan with rollback-path success criteria and evidence.',
                '```',
              ].join('\n'),
            }],
            sessionId: 'session-contract-review-round-1',
          };
        }

        return {
          success: true,
          lastText: [
            'The revised contract is approved.',
            '```kodax-task-contract-review',
            'status: approve',
            'reason: The revised contract now covers rollback explicitly.',
            'followup:',
            '- Proceed with implementation.',
            '```',
          ].join('\n'),
          messages: [{
            role: 'assistant',
            content: [
              'The revised contract is approved.',
              '```kodax-task-contract-review',
              'status: approve',
              'reason: The revised contract now covers rollback explicitly.',
              'followup:',
              '- Proceed with implementation.',
              '```',
            ].join('\n'),
          }],
          sessionId: 'session-contract-review-round-2',
        };
      }

      if (prompt.includes('Generator role')) {
        const overlay = String(options.context?.promptOverlay ?? '');
        const visibleText = overlay.includes('Rollback path is explicitly covered.')
          ? 'Generator implemented the workflow with rollback coverage.'
          : 'Generator implemented the workflow.';
        const content = buildHandoffResponse(visibleText, {
          summary: visibleText,
          evidence: overlay.includes('Rollback path is explicitly covered.')
            ? ['Implementation covers the rollback path explicitly.']
            : ['Implementation covers the primary workflow.'],
          followup: ['Evaluator should validate the implementation against the updated contract.'],
        });
        return {
          success: true,
          lastText: content,
          messages: [{
            role: 'assistant',
            content,
          }],
          sessionId: overlay.includes('Rollback path is explicitly covered.')
            ? 'session-generator-round-2'
            : 'session-generator-round-1',
        };
      }

      return {
        success: true,
        lastText: [
          'Final result accepted with the updated contract and rollback coverage.',
          '```kodax-task-verdict',
          'status: accept',
          'reason: The revised contract is satisfied.',
          'followup:',
          '- Deliver the final answer.',
          '```',
        ].join('\n'),
        messages: [{
          role: 'assistant',
          content: [
            'Final result accepted with the updated contract and rollback coverage.',
            '```kodax-task-verdict',
            'status: accept',
            'reason: The revised contract is satisfied.',
            'followup:',
            '- Deliver the final answer.',
            '```',
          ].join('\n'),
        }],
        sessionId: 'session-evaluator-round-2',
        signal: 'COMPLETE',
      };
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        context: {
          taskSurface: 'cli',
          managedTaskWorkspaceDir: workspaceRoot,
        },
      },
      'Implement the release workflow with strong verification.'
    );

    const plannerCalls = mockRunDirectKodaX.mock.calls.filter((call) =>
      String(call[1]).includes('Planner role')
    );
    const contractReviewCalls = mockRunDirectKodaX.mock.calls.filter((call) =>
      String(call[1]).includes('Contract Reviewer role')
    );
    const generatorCalls = mockRunDirectKodaX.mock.calls.filter((call) =>
      String(call[1]).includes('Generator role')
    );

    expect(plannerCalls).toHaveLength(2);
    expect(contractReviewCalls).toHaveLength(2);
    expect(generatorCalls).toHaveLength(1);
    expect(result.success).toBe(true);
    expect(result.managedTask?.contract.contractSummary).toContain('rollback coverage');
    expect(result.managedTask?.contract.successCriteria).toContain('Rollback path is explicitly covered.');
    expect(result.managedTask?.contract.requiredEvidence).toContain('Rollback-path verification evidence.');

    const persistedContract = JSON.parse(
      await readFile(path.join(result.managedTask!.evidence.workspaceDir, 'contract.json'), 'utf8')
    );
    expect(persistedContract.successCriteria).toContain('Rollback path is explicitly covered.');
  });

  it('rebuilds a massive AMA review into review-specific H3 at a round boundary', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-');
    let contractReviewRound = 0;
    mockCreateReasoningPlan.mockResolvedValue({
      mode: 'auto',
      depth: 'high',
      promptOverlay: '[Routing] review-upgrade',
      decision: {
        primaryTask: 'review',
        confidence: 0.95,
        riskLevel: 'high',
        recommendedMode: 'pr-review',
        recommendedThinkingDepth: 'high',
        complexity: 'complex',
        workIntent: 'overwrite',
        requiresBrainstorm: false,
        harnessProfile: 'H2_PLAN_EXECUTE_EVAL',
        upgradeCeiling: 'H3_MULTI_WORKER',
        reviewScale: 'massive',
        reason: 'Massive review starts at H2 and can upgrade if contract review needs more parallel coverage.',
      },
    });

    mockRunDirectKodaX.mockImplementation(async (_options, prompt: string) => {
      if (prompt.includes('Admission role')) {
        const content = buildAdmissionResponse(
          'Admission confirmed the massive review should start on H2 and may upgrade to H3.',
          'H2_PLAN_EXECUTE_EVAL',
          ['packages/coding/src/task-engine.ts', 'packages/repl/src/ui/InkREPL.tsx'],
        );
        return {
          success: true,
          lastText: content,
          messages: [{ role: 'assistant', content }],
          sessionId: 'session-admission-review-upgrade',
        };
      }

      if (prompt.includes('Lead role')) {
        const content = [
          'Lead aligned the upgraded H3 review strategy.',
          '```kodax-task-contract',
          'summary: Coordinate high-risk and surface review lanes for the massive review.',
          'success_criteria:',
          '- High-risk and surface findings are both covered.',
          'required_evidence:',
          '- Parallel review evidence from both review workers.',
          'constraints:',
          '- Do not miss cross-cutting regressions.',
          '```',
        ].join('\n');
        return {
          success: true,
          lastText: content,
          messages: [{ role: 'assistant', content }],
          sessionId: 'session-lead-review-upgrade',
        };
      }

      if (prompt.includes('Planner role')) {
        return {
          success: true,
          lastText: [
            'Initial review contract is ready.',
            '```kodax-task-contract',
            'summary: Validate a massive cross-cutting review surface safely.',
            'success_criteria:',
            '- Identify all must-fix blockers with evidence.',
            'required_evidence:',
            '- Cross-surface review evidence.',
            'constraints:',
            '- Do not miss runtime blockers.',
            '```',
          ].join('\n'),
          messages: [{
            role: 'assistant',
            content: [
              'Initial review contract is ready.',
              '```kodax-task-contract',
              'summary: Validate a massive cross-cutting review surface safely.',
              'success_criteria:',
              '- Identify all must-fix blockers with evidence.',
              'required_evidence:',
              '- Cross-surface review evidence.',
              'constraints:',
              '- Do not miss runtime blockers.',
              '```',
            ].join('\n'),
          }],
          sessionId: 'session-planner-review-upgrade',
        };
      }

      if (prompt.includes('Contract Reviewer role')) {
        contractReviewRound += 1;
        if (contractReviewRound > 1) {
          return {
            success: true,
            lastText: [
              'The stronger review harness has enough coverage now.',
              '```kodax-task-contract-review',
              'status: approve',
              'reason: The H3 review worker split covers the massive review surface.',
              'followup:',
              '- Proceed with review execution.',
              '```',
            ].join('\n'),
            messages: [{
              role: 'assistant',
              content: [
                'The stronger review harness has enough coverage now.',
                '```kodax-task-contract-review',
                'status: approve',
                'reason: The H3 review worker split covers the massive review surface.',
                'followup:',
                '- Proceed with review execution.',
                '```',
              ].join('\n'),
            }],
            sessionId: 'session-contract-review-upgraded',
          };
        }

        return {
          success: true,
          lastText: [
            'This review needs a stronger harness before execution.',
            '```kodax-task-contract-review',
            'status: revise',
            'reason: The review surface is too broad for a single generator pass.',
            'next_harness: H3_MULTI_WORKER',
            'followup:',
            '- Split into high-risk and surface review workers.',
            '```',
          ].join('\n'),
          messages: [{
            role: 'assistant',
            content: [
              'This review needs a stronger harness before execution.',
              '```kodax-task-contract-review',
              'status: revise',
              'reason: The review surface is too broad for a single generator pass.',
              'next_harness: H3_MULTI_WORKER',
              'followup:',
              '- Split into high-risk and surface review workers.',
              '```',
            ].join('\n'),
          }],
          sessionId: 'session-contract-review-review-upgrade',
        };
      }

      if (prompt.includes('High-Risk Review Worker role')) {
        const content = buildHandoffResponse('High-risk review worker found the runtime blocker.', {
          summary: 'High-risk review worker found the runtime blocker.',
          evidence: ['Runtime blocker documented with supporting evidence.'],
          followup: ['Evaluator should merge the high-risk finding into the final review.'],
        });
        return {
          success: true,
          lastText: content,
          messages: [{ role: 'assistant', content }],
          sessionId: 'session-review-high-risk',
        };
      }

      if (prompt.includes('Surface Review Worker role')) {
        const content = buildHandoffResponse('Surface review worker found the regression and test gap.', {
          summary: 'Surface review worker found the regression and test gap.',
          evidence: ['Regression surface and test gap documented.'],
          followup: ['Evaluator should merge the surface finding into the final review.'],
        });
        return {
          success: true,
          lastText: content,
          messages: [{ role: 'assistant', content }],
          sessionId: 'session-review-surface',
        };
      }

      if (prompt.includes('Evaluator role')) {
        return {
          success: true,
          lastText: [
            'Final code review is complete with merged high-risk and surface findings.',
            '```kodax-task-verdict',
            'status: accept',
            'reason: The upgraded H3 review harness produced complete review coverage.',
            'followup:',
            '- Deliver the final review.',
            '```',
          ].join('\n'),
          messages: [{
            role: 'assistant',
            content: [
              'Final code review is complete with merged high-risk and surface findings.',
              '```kodax-task-verdict',
              'status: accept',
              'reason: The upgraded H3 review harness produced complete review coverage.',
              'followup:',
              '- Deliver the final review.',
              '```',
            ].join('\n'),
          }],
          sessionId: 'session-review-evaluator-upgraded',
          signal: 'COMPLETE',
        };
      }

      throw new Error(`Unexpected prompt: ${prompt}`);
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        context: {
          taskSurface: 'cli',
          managedTaskWorkspaceDir: workspaceRoot,
        },
      },
      'Review this 50 file / 7000 line change set and deliver a final code review.'
    );

    expect(result.managedTask?.contract.harnessProfile).toBe('H3_MULTI_WORKER');
    expect(result.managedTask?.runtime?.reviewFilesOrAreas).toEqual(
      expect.arrayContaining([
        'packages/coding/src/task-engine.ts',
        'packages/repl/src/ui/InkREPL.tsx',
      ]),
    );
    expect(result.managedTask?.runtime?.harnessTransitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'H2_PLAN_EXECUTE_EVAL',
          to: 'H3_MULTI_WORKER',
          approved: true,
          source: 'contract-review',
        }),
      ]),
    );

    const assignmentIds = result.managedTask?.roleAssignments.map((assignment) => assignment.id) ?? [];
    expect(assignmentIds).toEqual(
      expect.arrayContaining([
        'review-worker-high-risk',
        'review-worker-surface',
      ]),
    );
    const admissionPrompt = String(
      mockRunDirectKodaX.mock.calls.find((call) => String(call[1]).includes('Admission role'))?.[1] ?? ''
    );
    const highRiskPrompt = String(
      mockRunDirectKodaX.mock.calls.find((call) => String(call[1]).includes('High-Risk Review Worker'))?.[1] ?? ''
    );
    expect(admissionPrompt).toContain('changed_scope -> repo_overview (only when needed) -> changed_diff_bundle');
    expect(admissionPrompt).toContain('review_files_or_areas:');
    expect(highRiskPrompt).toContain('changed_scope -> repo_overview (only when needed) -> changed_diff_bundle');

  });

  it('falls back to heuristic routing when provider-backed routing is unavailable', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-');
    mockCreateReasoningPlan.mockRejectedValue(new Error('routing unavailable'));
    mockRunDirectKodaX.mockResolvedValue({
      success: true,
      lastText: 'Summary completed.',
      messages: [{ role: 'assistant', content: 'Summary completed.' }],
      sessionId: 'session-fallback',
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        context: {
          taskSurface: 'cli',
          managedTaskWorkspaceDir: workspaceRoot,
        },
      },
      'Summarize the release notes in one paragraph.'
    );

    expect(result.managedTask?.contract.harnessProfile).toBe('H0_DIRECT');
    expect(result.routingDecision?.routingNotes?.join('\n')).toContain('heuristic fallback routing');
    expect(mockRunDirectKodaX).toHaveBeenCalledTimes(1);
  });

  it('captures repo intelligence artifacts for managed tasks when repo context is available', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-repo-intel-');
    initGitRepo(workspaceRoot);
    createRepoFixture(workspaceRoot);
    commitAll(workspaceRoot, 'initial fixture');

    mockCreateReasoningPlan.mockResolvedValue({
      mode: 'auto',
      depth: 'low',
      promptOverlay: '[Routing] direct-repo-intel',
      decision: {
        primaryTask: 'edit',
        confidence: 0.89,
        riskLevel: 'low',
        recommendedMode: 'implementation',
        recommendedThinkingDepth: 'low',
        complexity: 'simple',
        workIntent: 'append',
        requiresBrainstorm: false,
        harnessProfile: 'H0_DIRECT',
        reason: 'Simple repo-aware execution',
      },
    });
    mockRunDirectKodaX.mockResolvedValue({
      success: true,
      lastText: 'Repo-aware task handled directly.',
      messages: [{ role: 'assistant', content: 'Repo-aware task handled directly.' }],
      sessionId: 'session-direct-repo-intel',
    });

    const result = await runManagedTask(
      {
        provider: 'anthropic',
        context: {
          taskSurface: 'project',
          gitRoot: workspaceRoot,
          executionCwd: path.join(workspaceRoot, 'packages', 'app'),
          managedTaskWorkspaceDir: path.join(workspaceRoot, '.agent', 'managed-tasks'),
        },
      },
      'Inspect the app package and adjust the boot flow.'
    );

    const artifactPaths = result.managedTask?.evidence.artifacts.map((artifact) => artifact.path) ?? [];
    expect(artifactPaths.some((artifactPath) => artifactPath.endsWith(path.join('repo-intelligence', 'summary.md')))).toBe(true);
    expect(artifactPaths.some((artifactPath) => artifactPath.endsWith(path.join('repo-intelligence', 'repo-overview.json')))).toBe(true);
    expect(artifactPaths.some((artifactPath) => artifactPath.endsWith(path.join('repo-intelligence', 'active-module.json')))).toBe(true);

    const repoSummary = await readFile(
      path.join(result.managedTask!.evidence.workspaceDir, 'repo-intelligence', 'summary.md'),
      'utf8'
    );
    expect(repoSummary).toContain('## Repository Overview');
    expect(repoSummary).toContain('## Active Module');
    expect(repoSummary).toContain('@fixture/app');
  }, 15000);
});
