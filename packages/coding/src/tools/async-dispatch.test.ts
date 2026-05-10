/**
 * FEATURE_119 v0.7.36 Pattern B — async dispatch + await reclaim contract.
 *
 * Validates the launch/await split:
 *  - dispatch_child_task with a registry returns a `task_id:<id>` banner
 *    immediately and registers the in-flight promise.
 *  - await_child_task awaits the registered promise and returns the
 *    finding text (parity with the sync path).
 *  - dispatch with no registry / KODAX_ASYNC_DISPATCH=0 keeps the legacy
 *    sync behavior.
 *  - duplicate task_ids are rejected; awaiting an unknown id surfaces a
 *    helpful error; await consumes the registry entry.
 *  - the launch path emits a background task-completed notification on
 *    settle so Sleep-gated mid-turn drain can wake the Worker.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetMessageQueueForTests, getMessageQueue } from '@kodax-ai/agent';

import { toolDispatchChildTask } from './dispatch-child-tasks.js';
import { toolAwaitChildTask } from './await-child-task.js';
import type {
  KodaXChildExecutionResult,
  KodaXToolExecutionContext,
} from '../types.js';

// Mock the child-executor so the test never spawns a real child agent.
vi.mock('../child-executor.js', async () => {
  return {
    executeChildAgents: vi.fn(),
  };
});

// Re-import the mocked symbol so we can drive its return value per test.
const { executeChildAgents } = await import('../child-executor.js');
const mockExec = executeChildAgents as unknown as ReturnType<typeof vi.fn>;

function buildSuccessResult(childId: string, evidence: string[]): KodaXChildExecutionResult {
  return {
    results: [
      {
        childId,
        fanoutClass: 'evidence-scan',
        status: 'completed',
        disposition: 'valid',
        summary: evidence.join('\n'),
        evidenceRefs: [],
        contradictions: [],
      },
    ],
    mergedFindings: [
      {
        childId,
        objective: 'test',
        evidence,
        artifacts: [],
      },
    ],
    mergedArtifacts: [],
    totalTokensUsed: 0,
    cancelledChildren: [],
  };
}

function buildBaseCtx(
  registry: Map<string, Promise<KodaXChildExecutionResult>> | undefined,
): KodaXToolExecutionContext {
  return {
    backups: new Map(),
    managedProtocolRole: 'scout',
    childTaskRegistry: registry,
    parentAgentConfig: {
      provider: 'anthropic',
    },
  };
}

async function drainGeneratorReturn(
  gen: AsyncGenerator<unknown, string, void>,
): Promise<string> {
  let next = await gen.next();
  while (!next.done) {
    next = await gen.next();
  }
  return next.value;
}

describe('FEATURE_119 Pattern B — async dispatch', () => {
  beforeEach(() => {
    mockExec.mockReset();
    _resetMessageQueueForTests();
    delete process.env.KODAX_ASYNC_DISPATCH;
  });
  afterEach(() => {
    _resetMessageQueueForTests();
    delete process.env.KODAX_ASYNC_DISPATCH;
  });

  it('returns task_id banner immediately and registers the promise', async () => {
    let resolveExec!: (r: KodaXChildExecutionResult) => void;
    mockExec.mockReturnValue(
      new Promise<KodaXChildExecutionResult>((resolve) => {
        resolveExec = resolve;
      }),
    );

    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    const ctx = buildBaseCtx(registry);

    const result = await drainGeneratorReturn(
      toolDispatchChildTask(
        { id: 'c1', objective: 'scan packages/' },
        ctx,
      ),
    );

    expect(result).toContain('task_id:c1');
    expect(registry.has('c1')).toBe(true);
    // Executor was launched (called) but we have not awaited it.
    expect(mockExec).toHaveBeenCalledTimes(1);

    // Settle so the test does not leak an unresolved promise.
    resolveExec(buildSuccessResult('c1', ['ok']));
    await registry.get('c1');
  });

  it('await_child_task awaits the registered promise and returns finding', async () => {
    mockExec.mockResolvedValue(buildSuccessResult('c2', ['evidence-A', 'evidence-B']));

    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    const ctx = buildBaseCtx(registry);

    const banner = await drainGeneratorReturn(
      toolDispatchChildTask({ id: 'c2', objective: 'x' }, ctx),
    );
    expect(banner).toContain('task_id:c2');
    expect(registry.size).toBe(1);

    const finding = await toolAwaitChildTask({ task_id: 'c2' }, ctx);
    expect(finding).toBe('evidence-A\nevidence-B');
    // Registry entry consumed.
    expect(registry.has('c2')).toBe(false);
  });

  it('rejects duplicate task_ids', async () => {
    mockExec.mockReturnValue(new Promise(() => {})); // never resolves
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    const ctx = buildBaseCtx(registry);

    const first = await drainGeneratorReturn(
      toolDispatchChildTask({ id: 'dup', objective: 'a' }, ctx),
    );
    expect(first).toContain('task_id:dup');

    const second = await drainGeneratorReturn(
      toolDispatchChildTask({ id: 'dup', objective: 'b' }, ctx),
    );
    expect(second).toContain('already in flight');
    expect(mockExec).toHaveBeenCalledTimes(1);
  });

  it('await with unknown task_id surfaces helpful error', async () => {
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    const ctx = buildBaseCtx(registry);

    const result = await toolAwaitChildTask({ task_id: 'ghost' }, ctx);
    expect(result).toContain('unknown task_id "ghost"');
    expect(result).toContain('In-flight task ids: <none>');
  });

  it('await without registry surfaces sync-mode hint', async () => {
    const ctx = buildBaseCtx(undefined);
    const result = await toolAwaitChildTask({ task_id: 'anything' }, ctx);
    expect(result).toContain('async dispatch is disabled');
  });

  it('await without task_id rejects with missing-parameter error', async () => {
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    const ctx = buildBaseCtx(registry);
    const result = await toolAwaitChildTask({}, ctx);
    expect(result).toContain('Missing required parameter: task_id');
  });

  it('background notification is enqueued on child completion', async () => {
    mockExec.mockResolvedValue(buildSuccessResult('c3', ['done']));
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    const ctx = buildBaseCtx(registry);

    const banner = await drainGeneratorReturn(
      toolDispatchChildTask({ id: 'c3', objective: 'y' }, ctx),
    );
    expect(banner).toContain('task_id:c3');

    // Wait for the background promise to settle.
    await registry.get('c3');

    const queue = getMessageQueue();
    const peeked = queue.peek({ maxPriority: 'background' });
    expect(peeked).toHaveLength(1);
    expect(peeked[0]?.mode).toBe('task-notification');
    expect(peeked[0]?.content).toContain('<task-completed task_id="c3">');
  });

  it('KODAX_ASYNC_DISPATCH=0 forces sync path even with registry set', async () => {
    process.env.KODAX_ASYNC_DISPATCH = '0';
    mockExec.mockResolvedValue(buildSuccessResult('c4', ['sync-result']));
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    const ctx = buildBaseCtx(registry);

    const result = await drainGeneratorReturn(
      toolDispatchChildTask({ id: 'c4', objective: 'z' }, ctx),
    );
    // Sync path returns the finding text directly, not a task_id banner.
    expect(result).toBe('sync-result');
    expect(registry.has('c4')).toBe(false);
  });

  it('dispatch with no registry runs the legacy sync path', async () => {
    mockExec.mockResolvedValue(buildSuccessResult('c5', ['legacy']));
    const ctx = buildBaseCtx(undefined);

    const result = await drainGeneratorReturn(
      toolDispatchChildTask({ id: 'c5', objective: 'q' }, ctx),
    );
    expect(result).toBe('legacy');
  });

  it('await re-throws crash messages and removes the entry', async () => {
    mockExec.mockRejectedValue(new Error('boom'));
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    const ctx = buildBaseCtx(registry);

    const banner = await drainGeneratorReturn(
      toolDispatchChildTask({ id: 'c6', objective: 'crash' }, ctx),
    );
    expect(banner).toContain('task_id:c6');

    const reclaimed = await toolAwaitChildTask({ task_id: 'c6' }, ctx);
    expect(reclaimed).toContain('crashed: boom');
    expect(registry.has('c6')).toBe(false);
  });
});

// FEATURE_155 (v0.7.39 Slice B1) — dispatch banner branches on
// KODAX_IDLE_YIELD. Default is now ON (Slice B1.D); the v0.7.38
// banner pointing the LLM at `await_child_task` is reachable only
// through the explicit `KODAX_IDLE_YIELD=false` opt-out.
describe('FEATURE_155 v0.7.39 — dispatch banner respects KODAX_IDLE_YIELD', () => {
  let prevIdleYield: string | undefined;
  beforeEach(() => {
    prevIdleYield = process.env.KODAX_IDLE_YIELD;
    mockExec.mockReset();
    _resetMessageQueueForTests();
  });
  afterEach(() => {
    if (prevIdleYield === undefined) delete process.env.KODAX_IDLE_YIELD;
    else process.env.KODAX_IDLE_YIELD = prevIdleYield;
    _resetMessageQueueForTests();
  });

  it('opt-out (KODAX_IDLE_YIELD=false): banner instructs the LLM to call await_child_task', async () => {
    process.env.KODAX_IDLE_YIELD = 'false';
    let resolveExec!: (r: KodaXChildExecutionResult) => void;
    mockExec.mockReturnValue(
      new Promise<KodaXChildExecutionResult>((resolve) => {
        resolveExec = resolve;
      }),
    );
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    const banner = await drainGeneratorReturn(
      toolDispatchChildTask({ id: 'iy-off', objective: 'probe' }, buildBaseCtx(registry)),
    );
    expect(banner).toContain('task_id:iy-off');
    expect(banner).toContain('await_child_task({task_id:"iy-off"})');
    // No idle-yield wording on the legacy path.
    expect(banner).not.toContain('end your turn with one short status sentence');
    resolveExec(buildSuccessResult('iy-off', ['ok']));
    await registry.get('iy-off');
  });

  it('default (idle-yield ON): banner instructs the LLM to idle-yield and explicitly forbids await_child_task', async () => {
    delete process.env.KODAX_IDLE_YIELD;
    let resolveExec!: (r: KodaXChildExecutionResult) => void;
    mockExec.mockReturnValue(
      new Promise<KodaXChildExecutionResult>((resolve) => {
        resolveExec = resolve;
      }),
    );
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    const banner = await drainGeneratorReturn(
      toolDispatchChildTask({ id: 'iy-on', objective: 'probe' }, buildBaseCtx(registry)),
    );
    expect(banner).toContain('task_id:iy-on');
    expect(banner).toContain('end your turn with one short status sentence and NO tool calls');
    expect(banner).toContain('<task-completed task_id="iy-on">');
    expect(banner).toContain('Do NOT call await_child_task to wait');
    // Make sure the legacy "then call await_child_task({task_id})" line is gone.
    expect(banner).not.toContain('then call await_child_task({task_id:"iy-on"})');
    resolveExec(buildSuccessResult('iy-on', ['ok']));
    await registry.get('iy-on');
  });
});
