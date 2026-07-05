/**
 * FEATURE_217 (v0.7.49) Phase B — Coding workflow backend tests.
 *
 * Injects a fake `runChild` + minimal ctx + fake queue so no real child
 * agents run. Validates spawn → wait mapping, snapshot output, graceful
 * stop (abort), MessageQueue send routing, and synthesize.
 */

import { describe, expect, it, vi } from 'vitest';

import type { MessageQueue, WorkflowTaskSummaryEventUpdate } from '@kodax-ai/agent';

import {
  createCodingWorkflowBackend,
  type WorkflowChildOptions,
} from './agent-adapter.js';
import type { ChildExecutorOptions } from '../child-executor.js';
import type {
  KodaXChildAgentResult,
  KodaXChildExecutionResult,
  KodaXToolExecutionContext,
} from '../types.js';

function execResult(
  over: Partial<KodaXChildAgentResult> = {},
  extra: Partial<KodaXChildExecutionResult> = {},
): KodaXChildExecutionResult {
  const child: KodaXChildAgentResult = {
    childId: 'c',
    fanoutClass: 'evidence-scan',
    status: 'completed',
    disposition: 'valid',
    summary: 'the answer',
    evidenceRefs: [],
    contradictions: [],
    ...over,
  };
  return {
    results: [child],
    mergedFindings: [],
    mergedArtifacts: [],
    totalTokensUsed: 0,
    cancelledChildren: [],
    ...extra,
  };
}

function fakeCtx(): KodaXToolExecutionContext {
  return {
    childAbortControllers: new Map<string, AbortController>(),
    childProgressSnapshots: new Map(),
  } as unknown as KodaXToolExecutionContext;
}

function fakeQueue(): {
  queue: MessageQueue;
  enqueued: Array<{ agentId?: string; content: string; priority: string; mode: string }>;
} {
  const enqueued: Array<{ agentId?: string; content: string; priority: string; mode: string }> = [];
  const queue = {
    enqueue: (input: { agentId?: string; content: string; priority: string; mode: string }) => {
      enqueued.push(input);
      return 'msg-1';
    },
  } as unknown as MessageQueue;
  return { queue, enqueued };
}

const childOptions: WorkflowChildOptions = {
  maxIterationsPerChild: 50,
  parentRole: 'worker',
  parentHarness: 'workflow',
  parentOptions: {},
};

describe('createCodingWorkflowBackend — spawn + wait', () => {
  it('spawns and maps a completed child result', async () => {
    const ctx = fakeCtx();
    const backend = createCodingWorkflowBackend({
      ctx,
      childOptions,
      runChild: async () => execResult({
        status: 'completed',
        summary: 'full child report',
        digest: '- Found 3 workflow UX risks.',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
      }),
      generateId: () => 'task-x',
    });
    const handle = await backend.spawn({ name: 'security', prompt: 'audit', readOnly: true });
    expect(handle).toEqual({ taskId: 'task-x', name: 'security' });
    const result = await backend.wait(handle.taskId);
    expect(result.status).toBe('completed');
    expect(result.finalText).toBe('full child report');
    expect(result.digest).toBe('- Found 3 workflow UX risks.');
    expect(result.provider).toBe('anthropic');
    expect(result.model).toBe('claude-sonnet-4-5');
    expect(result.name).toBe('security');
  });

  it('throws loudly on wait/output/send/stop for an unknown task id (review A2)', async () => {
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      runChild: async () => execResult({ status: 'completed', summary: 'ok' }),
      generateId: () => 'task-known',
    });
    await backend.spawn({ name: 'a', prompt: 'p', readOnly: true });
    // Known id: no throw (in-flight output returns a running snapshot).
    await expect(backend.output('task-known')).resolves.toBeDefined();
    // Unknown id: every task-targeted method fails loudly instead of silently
    // fabricating a snapshot / dropping the message / no-op'ing the abort.
    await expect(backend.wait('task-bogus')).rejects.toThrow(/unknown workflow task: task-bogus/);
    await expect(backend.output('task-bogus')).rejects.toThrow(/unknown workflow task: task-bogus/);
    await expect(backend.send('task-bogus', 'hi')).rejects.toThrow(/unknown workflow task: task-bogus/);
    await expect(backend.stop('task-bogus')).rejects.toThrow(/unknown workflow task: task-bogus/);
  });

  it('surfaces a child structured output on the workflow result (FEATURE_246 Part B)', async () => {
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      runChild: async () => execResult({
        status: 'completed',
        summary: 'report',
        structured: { lens: 'correctness', findings: [{ severity: 'high', title: 'x' }] },
      }),
      generateId: () => 'task-s',
    });
    const handle = await backend.spawn({
      name: 'review',
      prompt: 'review',
      readOnly: true,
      outputSchema: { type: 'object', required: ['lens'], properties: { lens: { type: 'string' } } },
    });
    const result = await backend.wait(handle.taskId);
    expect(result.structured).toEqual({
      lens: 'correctness',
      findings: [{ severity: 'high', title: 'x' }],
    });
  });

  it('passes outputSchema into the child bundle (FEATURE_246 Part B)', async () => {
    let seenSchema: unknown;
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      runChild: async (bundles) => {
        seenSchema = bundles[0]?.outputSchema;
        return execResult({ status: 'completed', summary: 'ok' });
      },
    });
    const schema = { type: 'object', required: ['x'], properties: { x: { type: 'string' } } };
    const handle = await backend.spawn({ name: 'r', prompt: 'p', readOnly: true, outputSchema: schema });
    await backend.wait(handle.taskId);
    expect(seenSchema).toEqual(schema);
  });

  it('passes per-child effort into the bundle (FEATURE_246 Part E)', async () => {
    let seenEffort: unknown;
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      runChild: async (bundles) => {
        seenEffort = bundles[0]?.effort;
        return execResult({ status: 'completed', summary: 'ok' });
      },
    });
    const handle = await backend.spawn({ name: 'r', prompt: 'p', readOnly: true, effort: 'high' });
    await backend.wait(handle.taskId);
    expect(seenEffort).toBe('high');
  });

  it('maps a failed child to status=failed', async () => {
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      runChild: async () => execResult({ status: 'failed', summary: '[Crash] boom' }),
    });
    const handle = await backend.spawn({ name: 'a', prompt: 'x', readOnly: true });
    expect((await backend.wait(handle.taskId)).status).toBe('failed');
  });

  it('maps a cancelled child to status=stopped', async () => {
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      runChild: async () => execResult({}, { cancelledChildren: ['task-c'] }),
      generateId: () => 'task-c',
    });
    const handle = await backend.spawn({ name: 'a', prompt: 'x', readOnly: true });
    expect((await backend.wait(handle.taskId)).status).toBe('stopped');
  });

  it('honors wait timeout and aborts the in-flight child', async () => {
    const ctx = fakeCtx();
    let seenSignal: AbortSignal | undefined;
    const backend = createCodingWorkflowBackend({
      ctx,
      childOptions,
      generateId: () => 'task-timeout',
      runChild: (_bundles, _ctx, opts) => {
        seenSignal = opts.abortSignal;
        return new Promise<KodaXChildExecutionResult>(() => {});
      },
    });

    const handle = await backend.spawn({ name: 'slow', prompt: 'x', readOnly: true });

    await expect(backend.wait(handle.taskId, { timeoutMs: 5 })).rejects.toThrow(
      /timed out after 5ms/,
    );
    expect(seenSignal?.aborted).toBe(true);
  });

  it('marks every child as a workflow child so the self-distill digest fires (FEATURE_217)', async () => {
    let seenWorkflowChild: boolean | undefined;
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      generateId: () => 'task-wf-child',
      runChild: (_bundles, _ctx, opts) => {
        seenWorkflowChild = opts.workflowChild;
        return Promise.resolve(execResult());
      },
    });

    await backend.spawn({ name: 'x', prompt: 'x', readOnly: true });
    // The backend stamps `workflowChild` regardless of parentHarness, so the
    // digest fires in production where parentHarness stays 'tool-dispatch'
    // (write children must not be dropped by validateWriteBundles).
    expect(seenWorkflowChild).toBe(true);
  });

  it('enables async digest updates when the runtime subscribes', async () => {
    let seenDigestMode: ChildExecutorOptions['workflowDigestMode'];
    let seenDigestCallback: ChildExecutorOptions['onWorkflowChildDigest'];
    const updates: Array<{
      readonly taskId: string;
      readonly update: WorkflowTaskSummaryEventUpdate;
    }> = [];
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      generateId: () => 'task-async',
      runChild: (_bundles, _ctx, opts) => {
        seenDigestMode = opts.workflowDigestMode;
        seenDigestCallback = opts.onWorkflowChildDigest;
        opts.onWorkflowChildDigest?.({
          childId: 'task-async',
          digest: '- Finding: adapter forwarded digest.',
          totalTokensUsed: 9,
        });
        return Promise.resolve(execResult({
          childId: 'task-async',
          status: 'completed',
          summary: 'full report',
          digestPending: true,
        }, { totalTokensUsed: 12 }));
      },
    });
    backend.subscribeTaskSummaryUpdates?.((taskId, update) => updates.push({ taskId, update }));

    const handle = await backend.spawn({ name: 'x', prompt: 'x', readOnly: true });
    const result = await backend.wait(handle.taskId);

    expect(seenDigestMode).toBe('async');
    expect(seenDigestCallback).toBeDefined();
    expect(result.digestPending).toBe(true);
    expect(result.digest).toBeUndefined();
    expect(updates).toEqual([
      {
        taskId: 'task-async',
        update: {
          summary: '- Finding: adapter forwarded digest.',
          summaryKind: 'digest',
          usage: { totalTokens: 9 },
        },
      },
    ]);
  });

  it('passes workflow correlation into child executor options', async () => {
    let seenCorrelation: ChildExecutorOptions['workflowCorrelation'];
    let seenChildActivityName: ChildExecutorOptions['childActivityName'];
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      runId: 'run-correlation',
      generateId: () => 'task-correlation',
      runChild: (_bundles, _ctx, opts) => {
        seenCorrelation = opts.workflowCorrelation;
        seenChildActivityName = opts.childActivityName;
        return Promise.resolve(execResult({
          childId: 'task-correlation',
          status: 'completed',
          summary: 'done',
        }));
      },
    });

    const handle = await backend.spawn({ name: 'x', prompt: 'x', readOnly: true });
    await backend.wait(handle.taskId);

    expect(seenCorrelation).toEqual({
      workflowRunId: 'run-correlation',
      childAgentId: 'task-correlation',
      itemId: 'agent:task-correlation',
    });
    expect(seenChildActivityName).toBe('x');
  });

  it('passes readOnly + specialist + modelHint + isolation into the bundle', async () => {
    let seenBundle:
      | {
          readOnly: boolean;
          specialistName?: string;
          modelHint?: string;
          isolation?: string;
          objective: string;
        }
      | undefined;
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      runChild: async (bundles) => {
        const b = bundles[0]!;
        seenBundle = {
          readOnly: b.readOnly,
          specialistName: b.specialistName,
          modelHint: b.modelHint,
          isolation: b.isolation,
          objective: b.objective,
        };
        return execResult();
      },
    });
    const h = await backend.spawn({
      name: 'r', prompt: 'review sql', readOnly: true, subagentType: 'db-reviewer', modelHint: 'deep', isolation: 'worktree',
    });
    await backend.wait(h.taskId);
    expect(seenBundle).toEqual({
      readOnly: true,
      specialistName: 'db-reviewer',
      modelHint: 'deep',
      isolation: 'worktree',
      objective: 'review sql',
    });
  });

  it('defaults child readOnly from a read-only workflow manifest', async () => {
    const snapshots: readonly string[][] = [[], []];
    let index = 0;
    let seenReadOnly: boolean | undefined;
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      defaultChildReadOnly: true,
      listChangedFiles: async () => snapshots[Math.min(index++, snapshots.length - 1)]!,
      runChild: async (bundles) => {
        seenReadOnly = bundles[0]?.readOnly;
        return execResult({
          status: 'completed',
          summary: 'Read-only review completed with a sufficiently detailed terminal report.',
        });
      },
    });

    const handle = await backend.spawn({ name: 'reader', prompt: 'review only' });
    const result = await backend.wait(handle.taskId);

    expect(seenReadOnly).toBe(true);
    expect(index).toBe(0);
    expect(result.status).toBe('completed');
    expect(result.verification).toBeUndefined();
  });

  it('rejects write-capable children inside a read-only workflow manifest', async () => {
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      defaultChildReadOnly: true,
      runChild: async () => execResult(),
    });

    await expect(
      backend.spawn({ name: 'writer', prompt: 'write files', readOnly: false }),
    ).rejects.toThrow(/readOnly=true/);
  });

  it('uses a digest instead of preparatory last text as the workflow finalText', async () => {
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      runChild: async () => execResult({
        status: 'completed',
        summary: 'Let me create the implementation plan and start building.',
        digest: '- Implemented the requested workflow verification changes.',
      }),
    });

    const handle = await backend.spawn({ name: 'writer', prompt: 'implement', readOnly: true });
    const result = await backend.wait(handle.taskId);

    expect(result.status).toBe('completed');
    expect(result.finalText).toBe('- Implemented the requested workflow verification changes.');
  });

  it('marks an implicit write-capable child unverified when no mutation evidence is observed', async () => {
    const snapshots: readonly string[][] = [[], []];
    let index = 0;
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      listChangedFiles: async () => snapshots[Math.min(index++, snapshots.length - 1)]!,
      runChild: async () => execResult({
        status: 'completed',
        summary: 'Implementation completed with a sufficiently detailed terminal report for the parent workflow.',
      }),
    });

    const handle = await backend.spawn({ name: 'writer', prompt: 'write files', readOnly: false });
    const result = await backend.wait(handle.taskId);

    expect(result.status).toBe('completed_unverified');
    expect(result.verification?.ok).toBe(false);
    expect(result.verification?.enforcement).toBe('warn');
    expect(result.verification?.reasons.join('\n')).toContain('expected file mutations');
    expect(result.finalText).toContain('completed without verification');
  });

  it('fails explicit mutation verification when no mutation evidence is observed', async () => {
    const snapshots: readonly string[][] = [[], []];
    let index = 0;
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      listChangedFiles: async () => snapshots[Math.min(index++, snapshots.length - 1)]!,
      runChild: async () => execResult({
        status: 'completed',
        summary: 'Implementation completed with a detailed terminal report for the parent workflow.',
      }),
    });

    const handle = await backend.spawn({
      name: 'writer',
      prompt: 'write files',
      readOnly: false,
      verification: { requiresMutation: true },
    });
    const result = await backend.wait(handle.taskId);

    expect(result.status).toBe('failed');
    expect(result.verification?.ok).toBe(false);
    expect(result.verification?.enforcement).toBe('hard');
    expect(result.verification?.reasons.join('\n')).toContain('expected file mutations');
  });

  it('repairs a hard write verification failure before returning failed', async () => {
    let attempts = 0;
    const objectives: string[] = [];
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      listChangedFiles: async () => [],
      runChild: async (bundles, _ctx, opts) => {
        attempts += 1;
        objectives.push(bundles[0]?.objective ?? '');
        if (attempts === 2) {
          opts.parentOptions.events?.onToolUseStart?.({
            id: 'tool-1',
            name: 'write',
            input: { path: 'docs/FEATURE_LIST.md' },
          });
          opts.parentOptions.events?.onToolResult?.({
            id: 'tool-1',
            name: 'write',
            content: 'ok',
          });
          return execResult({
            status: 'completed',
            summary: 'Updated docs/FEATURE_LIST.md with the requested feature entry.',
          });
        }
        return execResult({
          status: 'completed',
          summary: 'I now understand the docs. Let me set up a plan and execute.',
        });
      },
    });

    const handle = await backend.spawn({
      name: 'feature-tracker-writer',
      prompt: 'Add the feature to docs/FEATURE_LIST.md.',
      readOnly: false,
      verification: { requiresMutation: true },
    });
    const result = await backend.wait(handle.taskId);

    expect(result.status).toBe('completed');
    expect(result.verification?.ok).toBe(true);
    expect(result.verification?.mutationToolCalls).toEqual(['write']);
    expect(attempts).toBe(2);
    expect(objectives[1]).toContain('[Workflow verification repair]');
    expect(objectives[1]).toContain('expected file mutations');
  });

  it('stops repairing after two hard verification repair attempts', async () => {
    let attempts = 0;
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      listChangedFiles: async () => [],
      runChild: async () => {
        attempts += 1;
        return execResult({
          status: 'completed',
          summary: `Attempt ${attempts}: I will start writing the files now.`,
        });
      },
    });

    const handle = await backend.spawn({
      name: 'feature-tracker-writer',
      prompt: 'Add the feature to docs/FEATURE_LIST.md.',
      readOnly: false,
      verification: { requiresMutation: true },
    });
    const result = await backend.wait(handle.taskId);

    expect(result.status).toBe('failed');
    expect(result.verification?.ok).toBe(false);
    expect(attempts).toBe(3);
    expect(result.finalText).toContain('[Workflow task verification failed]');
  });

  it('uses one wait timeout budget across verification repair attempts', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const ctx = fakeCtx();
      const backend = createCodingWorkflowBackend({
        ctx,
        childOptions,
        generateId: () => 'task-repair-timeout',
        listChangedFiles: async () => [],
        runChild: () => {
          attempts += 1;
          return new Promise<KodaXChildExecutionResult>((resolve) => {
            setTimeout(() => {
              resolve(execResult({
                status: 'completed',
                summary: `Attempt ${attempts}: I will start writing the files now.`,
              }));
            }, 10);
          });
        },
      });

      const handle = await backend.spawn({
        name: 'feature-tracker-writer',
        prompt: 'Add the feature to docs/FEATURE_LIST.md.',
        readOnly: false,
        verification: { requiresMutation: true },
      });
      const waitPromise = backend.wait(handle.taskId, { timeoutMs: 15 });
      const waitRejection = expect(waitPromise).rejects.toThrow(/timed out after 15ms/);

      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(5);

      await waitRejection;
      expect(attempts).toBe(2);
      expect(ctx.childAbortControllers?.get(handle.taskId)?.signal.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes a write-capable child when required changed paths appear', async () => {
    const snapshots: readonly string[][] = [[], ['docs/features/v0.1.16.md', 'docs/FEATURE_LIST.md']];
    let index = 0;
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      listChangedFiles: async () => snapshots[Math.min(index++, snapshots.length - 1)]!,
      runChild: async () => execResult({
        status: 'completed',
        summary: 'Implemented the requested feature documentation and updated the feature list with the new version entries.',
      }),
    });

    const handle = await backend.spawn({
      name: 'feature-design-author',
      prompt: 'write feature docs',
      readOnly: false,
      verification: {
        requiresMutation: true,
        requiredChangedPaths: ['docs/features/v0.1.16.md', 'docs/FEATURE_LIST.md'],
      },
    });
    const result = await backend.wait(handle.taskId);

    expect(result.status).toBe('completed');
    expect(result.verification?.ok).toBe(true);
    expect(result.verification?.changedPaths).toContain('docs/features/v0.1.16.md');
  });

  it('allows successful shared-cwd write tools as mutation evidence', async () => {
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      listChangedFiles: async () => [],
      runChild: async (_bundles, _ctx, opts) => {
        opts.parentOptions.events?.onToolUseStart?.({
          id: 'tool-1',
          name: 'write',
          input: { path: 'docs/features/v0.1.16.md' },
        });
        opts.parentOptions.events?.onToolResult?.({
          id: 'tool-1',
          name: 'write',
          content: 'ok',
        });
        return execResult({
          status: 'completed',
          summary: 'Wrote the requested feature design document, updated the tracked workspace target, and reported the changed files.',
        });
      },
    });

    const handle = await backend.spawn({
      name: 'writer',
      prompt: 'write docs',
      readOnly: false,
      verification: {
        requiresMutation: true,
        requiredChangedPaths: ['docs/features/v0.1.16.md'],
      },
    });
    const result = await backend.wait(handle.taskId);

    expect(result.status).toBe('completed');
    expect(result.verification?.mutationToolCalls).toEqual(['write']);
  });

  it('does not treat isolated worktree write tools as delivered workspace changes', async () => {
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      listChangedFiles: async () => [],
      runChild: async (_bundles, _ctx, opts) => {
        opts.parentOptions.events?.onToolUseStart?.({
          id: 'tool-1',
          name: 'write',
          input: { path: 'docs/features/v0.1.16.md' },
        });
        opts.parentOptions.events?.onToolResult?.({
          id: 'tool-1',
          name: 'write',
          content: 'ok',
        });
        return execResult({
          status: 'completed',
          summary: 'Wrote the requested feature design document inside the isolated workspace.',
        });
      },
    });

    const handle = await backend.spawn({
      name: 'isolated-writer',
      prompt: 'write docs',
      readOnly: false,
      isolation: 'worktree',
    });
    const result = await backend.wait(handle.taskId);

    expect(result.status).toBe('completed_unverified');
    expect(result.verification?.reasons.join('\n')).toContain('isolated worktree');
    expect(result.verification?.mutationToolCalls).toEqual(['write']);
  });

  it('marks an implicit read-only child unverified after reaching the iteration limit', async () => {
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      runChild: async () => execResult({
        status: 'completed',
        summary: 'Partial result after running out of iterations.',
        limitReached: true,
      }),
    });

    const handle = await backend.spawn({ name: 'limited', prompt: 'finish', readOnly: true });
    const result = await backend.wait(handle.taskId);

    expect(result.status).toBe('completed_unverified');
    expect(result.limitReached).toBe(true);
    expect(result.verification).toMatchObject({
      ok: false,
      enforcement: 'warn',
      reasons: ['workflow child reached its iteration limit before satisfying the task'],
      mutationEvidence: false,
    });
    expect(result.finalText).toContain('completed without verification');
  });

  it('keeps explicit verification as a hard failure when limitReached has no evidence', async () => {
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      runChild: async () => execResult({
        status: 'completed',
        summary: 'Partial result after running out of iterations.',
        limitReached: true,
      }),
    });

    const handle = await backend.spawn({
      name: 'limited',
      prompt: 'finish',
      readOnly: true,
      verification: { rejectPreparatoryFinalText: true },
    });
    const result = await backend.wait(handle.taskId);

    expect(result.status).toBe('failed');
    expect(result.limitReached).toBe(true);
    expect(result.verification).toMatchObject({
      ok: false,
      enforcement: 'hard',
      reasons: ['workflow child reached its iteration limit before satisfying the task'],
      mutationEvidence: false,
    });
  });

  it('does not fail a write-capable child solely for short finalText when mutation evidence exists', async () => {
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      listChangedFiles: async () => [],
      runChild: async (_bundles, _ctx, opts) => {
        opts.parentOptions.events?.onToolUseStart?.({
          id: 'tool-1',
          name: 'write',
          input: { path: 'docs/features/v0.1.16.md' },
        });
        opts.parentOptions.events?.onToolResult?.({
          id: 'tool-1',
          name: 'write',
          content: 'ok',
        });
        return execResult({ status: 'completed', summary: 'Done.' });
      },
    });

    const handle = await backend.spawn({
      name: 'writer',
      prompt: 'write docs',
      readOnly: false,
      verification: {
        requiresMutation: true,
        minFinalTextChars: 80,
      },
    });
    const result = await backend.wait(handle.taskId);

    expect(result.status).toBe('completed');
    expect(result.verification?.ok).toBe(true);
  });

  it('does not fail a write-capable child solely for limitReached when mutation evidence exists', async () => {
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      listChangedFiles: async () => [],
      runChild: async (_bundles, _ctx, opts) => {
        opts.parentOptions.events?.onToolUseStart?.({
          id: 'tool-1',
          name: 'write',
          input: { path: 'docs/features/v0.1.16.md' },
        });
        opts.parentOptions.events?.onToolResult?.({
          id: 'tool-1',
          name: 'write',
          content: 'ok',
        });
        return execResult({
          status: 'completed',
          summary: 'Partial files were written before the child hit its iteration limit.',
          limitReached: true,
        });
      },
    });

    const handle = await backend.spawn({
      name: 'writer',
      prompt: 'write docs',
      readOnly: false,
      verification: { requiresMutation: true },
    });
    const result = await backend.wait(handle.taskId);

    expect(result.status).toBe('completed');
    expect(result.limitReached).toBe(true);
    expect(result.verification?.ok).toBe(true);
  });
});

describe('createCodingWorkflowBackend — output snapshot', () => {
  it('reports running before completion and completed after', async () => {
    const ctx = fakeCtx();
    let release: (r: KodaXChildExecutionResult) => void = () => {};
    const backend = createCodingWorkflowBackend({
      ctx,
      childOptions,
      generateId: () => 'task-o',
      runChild: () => new Promise<KodaXChildExecutionResult>((r) => { release = r; }),
    });
    const handle = await backend.spawn({ name: 'a', prompt: 'x', readOnly: true });
    const mid = await backend.output(handle.taskId);
    expect(mid.status).toBe('running');

    release(execResult({ status: 'completed', summary: 'done text' }));
    await backend.wait(handle.taskId);
    const final = await backend.output(handle.taskId);
    expect(final.status).toBe('completed');
    expect(final.lastText).toBe('done text');
  });
});

describe('createCodingWorkflowBackend — stop + send', () => {
  it('stop aborts the in-flight child signal', async () => {
    const ctx = fakeCtx();
    let seenSignal: AbortSignal | undefined;
    let release: (r: KodaXChildExecutionResult) => void = () => {};
    const backend = createCodingWorkflowBackend({
      ctx,
      childOptions,
      generateId: () => 'task-s',
      runChild: (_b, _c, opts) => {
        seenSignal = opts.abortSignal;
        return new Promise<KodaXChildExecutionResult>((r) => { release = r; });
      },
    });
    const handle = await backend.spawn({ name: 'a', prompt: 'x', readOnly: true });
    await backend.stop(handle.taskId, 'user cancel');
    expect(seenSignal?.aborted).toBe(true);
    release(execResult());
    await backend.wait(handle.taskId);
  });

  it('send routes a user-priority prompt to the child via the queue', async () => {
    const { queue, enqueued } = fakeQueue();
    let release: (r: KodaXChildExecutionResult) => void = () => {};
    const backend = createCodingWorkflowBackend({
      ctx: fakeCtx(),
      childOptions,
      queue,
      generateId: () => 'task-m',
      runChild: () => new Promise<KodaXChildExecutionResult>((r) => { release = r; }),
    });
    const handle = await backend.spawn({ name: 'a', prompt: 'x', readOnly: true });
    await backend.send(handle.taskId, 'keep going');
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({ agentId: 'task-m', content: 'keep going', priority: 'user', mode: 'prompt' });
    release(execResult());
    await backend.wait(handle.taskId);
  });
});

// `synthesize` is no longer a backend method — it runs as a gated agent in
// the runtime (see runtime.test.ts + parallel-investigation.test.ts).
