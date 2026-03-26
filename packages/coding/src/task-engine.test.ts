import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

const tempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  });

  it('runs planner, generator, and evaluator roles for H2 managed tasks', async () => {
    const workspaceRoot = await createTempDir('kodax-task-engine-');
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

    mockRunDirectKodaX.mockImplementation(async (_options, prompt: string) => {
      if (prompt.includes('Planner role')) {
        return {
          success: true,
          lastText: 'Plan ready with evidence checklist.',
          messages: [{ role: 'assistant', content: 'Plan ready with evidence checklist.' }],
          sessionId: 'session-planner',
        };
      }

      if (prompt.includes('Generator role')) {
        return {
          success: true,
          lastText: 'Implementation complete with updated tests.',
          messages: [{ role: 'assistant', content: 'Implementation complete with updated tests.' }],
          sessionId: 'session-generator',
        };
      }

      return {
        success: true,
        lastText: 'Evaluator accepted the result.',
        messages: [{ role: 'assistant', content: 'Evaluator accepted the result.' }],
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

    expect(mockRunDirectKodaX).toHaveBeenCalledTimes(3);
    expect(result.lastText).toBe('Evaluator accepted the result.');
    expect(result.managedTask?.contract.harnessProfile).toBe('H2_PLAN_EXECUTE_EVAL');
    expect(result.managedTask?.roleAssignments.map((assignment) => assignment.role)).toEqual([
      'planner',
      'generator',
      'evaluator',
    ]);
    expect(result.managedTask?.evidence.entries).toEqual([
      expect.objectContaining({ assignmentId: 'planner', status: 'completed' }),
      expect.objectContaining({ assignmentId: 'generator', status: 'completed' }),
      expect.objectContaining({ assignmentId: 'evaluator', status: 'completed', signal: 'COMPLETE' }),
    ]);
    expect(result.managedTask?.roleAssignments).toEqual([
      expect.objectContaining({ id: 'planner', agent: 'PlanningAgent' }),
      expect.objectContaining({ id: 'generator', agent: 'ExecutionAgent' }),
      expect.objectContaining({ id: 'evaluator', agent: 'EvaluationAgent' }),
    ]);
    expect(String(mockRunDirectKodaX.mock.calls[1]?.[1])).toContain('Dependency handoff:');
    expect(String(mockRunDirectKodaX.mock.calls[2]?.[1])).toContain('Dependency handoff:');
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

    mockRunDirectKodaX.mockImplementation(async (_options, prompt: string) => ({
      success: true,
      lastText: prompt.includes('Evaluator role')
        ? 'Evaluator finished after browser verification.'
        : 'Intermediate worker finished.',
      messages: [{
        role: 'assistant',
        content: prompt.includes('Evaluator role')
          ? 'Evaluator finished after browser verification.'
          : 'Intermediate worker finished.',
      }],
      sessionId: prompt.includes('Evaluator role') ? 'session-evaluator' : 'session-worker',
      signal: prompt.includes('Evaluator role') ? 'COMPLETE' : undefined,
    }));

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
    expect(evaluatorOptions?.context?.promptOverlay).toContain('Task metadata:');
    expect(evaluatorOptions?.context?.promptOverlay).toContain('"featureIndex": 7');
    expect(evaluatorOptions?.context?.taskVerification?.requiredChecks).toContain('playwright:e2e');
    expect(evaluatorOptions?.session?.id).toContain('managed-task-worker-task-');
    expect(evaluatorOptions?.session?.id).toContain('-evaluator');
    expect(evaluatorOptions?.session?.scope).toBe('managed-task-worker');
    expect(evaluatorOptions?.session?.storage).toBeUndefined();

    const allowBrowser = await evaluatorOptions?.events?.beforeToolExecute?.('bash', { command: 'npx playwright test' });
    const blockWrite = await evaluatorOptions?.events?.beforeToolExecute?.('write', { path: 'src/app.ts', content: 'oops' });
    const blockShellWrite = await evaluatorOptions?.events?.beforeToolExecute?.('bash', { command: 'echo broken > src/app.ts' });

    expect(allowBrowser).toBe(true);
    expect(typeof blockWrite).toBe('string');
    expect(typeof blockShellWrite).toBe('string');
    expect(result.managedTask?.contract.verification?.capabilityHints?.map((hint) => hint.name)).toContain('agent-browser');
    expect(result.managedTask?.roleAssignments.find((assignment) => assignment.id === 'evaluator')).toEqual(
      expect.objectContaining({
        agent: 'EvaluationAgent',
        toolPolicy: expect.objectContaining({
          summary: expect.stringContaining('Verification agents'),
        }),
      }),
    );
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
      return {
        success: true,
        lastText: prompt.includes('Evaluator role') ? 'Evaluator accepted.' : 'Worker output.',
        messages: [{
          role: 'assistant',
          content: prompt.includes('Evaluator role') ? 'Evaluator accepted.' : 'Worker output.',
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

        if (prompt.includes('Lead role')) {
          return {
            success: true,
            lastText: 'Lead aligned the execution strategy.',
            messages: [{ role: 'assistant', content: 'Lead aligned the execution strategy.' }],
            sessionId: 'session-lead',
          };
        }

        if (prompt.includes('Planner role')) {
          return {
            success: true,
            lastText: 'Planner produced the decomposition.',
            messages: [{ role: 'assistant', content: 'Planner produced the decomposition.' }],
            sessionId: 'session-planner',
          };
        }

        if (overlay.includes('worker=worker-implementation')) {
          return {
            success: true,
            lastText: 'Implementation worker updated the feature.',
            messages: [{ role: 'assistant', content: 'Implementation worker updated the feature.' }],
            sessionId: 'session-implementation',
          };
        }

        if (overlay.includes('worker=worker-validation')) {
          return {
            success: true,
            lastText: 'Validation worker checked the flow.',
            messages: [{ role: 'assistant', content: 'Validation worker checked the flow.' }],
            sessionId: 'session-validation',
          };
        }

        return {
          success: true,
          lastText: 'Evaluator accepted both implementation and validation evidence.',
          messages: [{ role: 'assistant', content: 'Evaluator accepted both implementation and validation evidence.' }],
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

    expect(mockRunDirectKodaX).toHaveBeenCalledTimes(5);
    expect(maxConcurrent).toBeGreaterThanOrEqual(2);
    expect(result.success).toBe(true);
    expect(result.managedTask?.contract.harnessProfile).toBe('H3_MULTI_WORKER');
    expect(result.managedTask?.roleAssignments.map((assignment) => assignment.role)).toEqual([
      'lead',
      'planner',
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
      expect.objectContaining({ assignmentId: 'lead', status: 'completed' }),
      expect.objectContaining({ assignmentId: 'planner', status: 'completed' }),
      expect.objectContaining({ assignmentId: 'worker-implementation', status: 'completed' }),
      expect.objectContaining({ assignmentId: 'worker-validation', status: 'completed' }),
      expect.objectContaining({ assignmentId: 'evaluator', status: 'completed', signal: 'COMPLETE' }),
    ]);
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
});
