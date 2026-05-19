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
// FEATURE_155 v0.7.39 Slice C1 — `await_child_task` tool deleted; all
// tests that exercised the await reclaim path are removed below. The
// dispatch-half tests stay.
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
    // FEATURE_155 v0.7.39 cleanup — duplicate-id error must not point
    // the LLM at the deleted `await_child_task` tool. Idle-yield is now
    // the only reclaim path; the message advertises it via the
    // `<task-completed>` banner pattern.
    expect(second).not.toContain('await_child_task');
    expect(second).toContain('<task-completed task_id="dup">');
    expect(mockExec).toHaveBeenCalledTimes(1);
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

  it('background notification is enqueued on child crash (Slice C1: tracked via queue, not via await reclaim)', async () => {
    mockExec.mockRejectedValue(new Error('boom'));
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    const ctx = buildBaseCtx(registry);

    const banner = await drainGeneratorReturn(
      toolDispatchChildTask({ id: 'c6', objective: 'crash' }, ctx),
    );
    expect(banner).toContain('task_id:c6');

    // Wait for the IIFE to settle (the `.catch(() => {})` swallows the
    // unhandled-rejection warning so we can observe the side effects
    // — the crash banner lands on the background queue).
    await registry.get('c6')?.catch(() => undefined);
    // Yield one more microtask so the dispatch IIFE's `.finally`
    // (the registry-cleanup hotfix below) has a chance to run.
    await Promise.resolve();

    const queue = getMessageQueue();
    const peeked = queue.peek({ maxPriority: 'background' });
    expect(peeked).toHaveLength(1);
    expect(peeked[0]?.mode).toBe('task-notification');
    expect(peeked[0]?.content).toContain('<task-completed task_id="c6">');
    expect(peeked[0]?.content).toContain('crash: boom');
  });

  // v0.7.38 FEATURE_155 hotfix — Bug A regression. Without the
  // dispatch-side `.finally(() => registry.delete(childId))`, a settled
  // child's promise stays in the registry forever; every subsequent
  // `waitForWakeEvent` call wraps it with `.then`, which fires
  // synchronously for an already-resolved promise and triggers a
  // spurious wake. Production symptom: Evaluator gets bombarded by
  // duplicate `<task-completed>` notifications for the same child,
  // each one consuming an extra LLM turn up to the
  // IDLE_YIELD_MAX_ITERATIONS=64 ceiling.
  //
  // The test uses a manually-controlled child promise so we can
  // assert two distinct states: (1) entry present while child is
  // in flight, (2) entry removed once child settles.
  it('registry entry is deleted after the child promise resolves (Bug A hotfix, happy path)', async () => {
    let resolveExec!: (r: KodaXChildExecutionResult) => void;
    mockExec.mockReturnValue(
      new Promise<KodaXChildExecutionResult>((resolve) => {
        resolveExec = resolve;
      }),
    );
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    const ctx = buildBaseCtx(registry);

    const banner = await drainGeneratorReturn(
      toolDispatchChildTask({ id: 'cleanup-1', objective: 'finish' }, ctx),
    );
    expect(banner).toContain('task_id:cleanup-1');
    // In-flight — entry must be present so `waitForWakeEvent` can race
    // it on the next outer-loop iteration.
    expect(registry.has('cleanup-1')).toBe(true);

    resolveExec(buildSuccessResult('cleanup-1', ['done']));
    await registry.get('cleanup-1');
    // The `.finally` hook is scheduled in the microtask queue alongside
    // any consumer `.then` handlers — yield one more tick so it runs
    // before we inspect.
    await Promise.resolve();

    // Settled — registry must be cleaned up. Without the hotfix this
    // entry would persist, and a follow-up `waitForWakeEvent` would
    // immediately fire `child-completed` for the already-resolved
    // promise, triggering the defensive-fallback fake banner.
    expect(registry.has('cleanup-1')).toBe(false);
  });

  it('registry entry is deleted after the child promise rejects (Bug A hotfix, crash branch)', async () => {
    let rejectExec!: (err: Error) => void;
    mockExec.mockReturnValue(
      new Promise<KodaXChildExecutionResult>((_resolve, reject) => {
        rejectExec = reject;
      }),
    );
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    const ctx = buildBaseCtx(registry);

    await drainGeneratorReturn(
      toolDispatchChildTask({ id: 'cleanup-2', objective: 'crash' }, ctx),
    );
    expect(registry.has('cleanup-2')).toBe(true);

    rejectExec(new Error('crashed'));
    await registry.get('cleanup-2')?.catch(() => undefined);
    await Promise.resolve();

    expect(registry.has('cleanup-2')).toBe(false);
  });
});

// FEATURE_155 (v0.7.39 Slice C3) — dispatch banner is always
// idle-yield. The `KODAX_IDLE_YIELD` flag was retired alongside
// `await_child_task` (Slice C1) — the legacy banner that pointed
// the LLM at the deleted tool would teach a non-existent capability.
describe('FEATURE_155 v0.7.39 — dispatch banner is always idle-yield (Slice C3)', () => {
  beforeEach(() => {
    mockExec.mockReset();
    _resetMessageQueueForTests();
  });
  afterEach(() => {
    _resetMessageQueueForTests();
  });

  it('banner instructs the LLM to idle-yield and never mentions the deleted await_child_task tool', async () => {
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
    // The deleted tool's name must not appear anywhere in the banner.
    expect(banner).not.toContain('await_child_task');
    resolveExec(buildSuccessResult('iy-on', ['ok']));
    await registry.get('iy-on');
  });
});

// FEATURE_120 v0.7.39 Phase 4 — model_hint schema field (routing
// no-op). The tool surfaces + parses the hint onto the bundle so
// FEATURE_102 (v0.7.45) can consume it later without re-plumbing.
describe('FEATURE_120 v0.7.39 Phase 4 — dispatch_child_task.model_hint', () => {
  beforeEach(() => {
    mockExec.mockReset();
    _resetMessageQueueForTests();
  });
  afterEach(() => {
    _resetMessageQueueForTests();
  });

  it.each(['fast', 'balanced', 'deep'] as const)(
    'forwards %s on the bundle passed to executeChildAgents',
    async (hint) => {
      mockExec.mockResolvedValueOnce(buildSuccessResult('mh', ['ok']));
      const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
      await drainGeneratorReturn(
        toolDispatchChildTask(
          { id: 'mh', objective: 'probe', model_hint: hint },
          buildBaseCtx(registry),
        ),
      );
      // First call: [bundles, ctx, options]; first bundle is our child.
      const call = mockExec.mock.calls[0]!;
      const bundles = call[0] as Array<{ modelHint?: string }>;
      expect(bundles[0]?.modelHint).toBe(hint);
      await registry.get('mh')?.catch(() => undefined);
    },
  );

  it('omitted model_hint becomes undefined on the bundle (no default substitution)', async () => {
    mockExec.mockResolvedValueOnce(buildSuccessResult('mh-omit', ['ok']));
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    await drainGeneratorReturn(
      toolDispatchChildTask(
        { id: 'mh-omit', objective: 'probe' },
        buildBaseCtx(registry),
      ),
    );
    const bundles = mockExec.mock.calls[0]![0] as Array<{ modelHint?: string }>;
    expect(bundles[0]?.modelHint).toBeUndefined();
    await registry.get('mh-omit')?.catch(() => undefined);
  });

  it('unknown model_hint string falls back to undefined (tolerant parse)', async () => {
    mockExec.mockResolvedValueOnce(buildSuccessResult('mh-bad', ['ok']));
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    const result = await drainGeneratorReturn(
      toolDispatchChildTask(
        { id: 'mh-bad', objective: 'probe', model_hint: 'ultra-fast' },
        buildBaseCtx(registry),
      ),
    );
    // Dispatch still launches; the unknown hint is silently dropped.
    expect(result).toContain('task_id:mh-bad');
    const bundles = mockExec.mock.calls[0]![0] as Array<{ modelHint?: string }>;
    expect(bundles[0]?.modelHint).toBeUndefined();
    await registry.get('mh-bad')?.catch(() => undefined);
  });

  it('non-string model_hint is ignored (no TypeError, modelHint undefined)', async () => {
    mockExec.mockResolvedValueOnce(buildSuccessResult('mh-num', ['ok']));
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    await drainGeneratorReturn(
      toolDispatchChildTask(
        { id: 'mh-num', objective: 'probe', model_hint: 42 as unknown as string },
        buildBaseCtx(registry),
      ),
    );
    const bundles = mockExec.mock.calls[0]![0] as Array<{ modelHint?: string }>;
    expect(bundles[0]?.modelHint).toBeUndefined();
    await registry.get('mh-num')?.catch(() => undefined);
  });
});

// Empty-summary fallback — guards against `<task-completed task_id="X">\n\n</task-completed>`
// (project memory `project_dispatch_child_empty_banner_bug`). Root cause:
// `runKodaX` returns `{success:true, lastText:''}` via CAP-083 AbortError
// silent terminal (or other "success but empty" paths), and the pre-fix
// `??` chain let the empty string fall through into the banner.
//
// These tests exercise the three pipeline shapes from the async-success
// branch + the sync legacy branch:
//   1. empty `mergedFindings[0].evidence` + empty `childResult.summary`
//      → fallback fires
//   2. whitespace-only summary → fallback fires (visual emptiness)
//   3. normal non-empty content → fallback does NOT fire (no regression)
function buildEmptySuccessResult(
  childId: string,
  opts?: { interrupted?: boolean; iterations?: number; whitespace?: boolean },
): KodaXChildExecutionResult {
  const text = opts?.whitespace ? '   \n\t  \n' : '';
  return {
    results: [
      {
        childId,
        fanoutClass: 'evidence-scan',
        status: 'completed',
        disposition: 'valid',
        summary: text,
        evidenceRefs: [],
        contradictions: [],
        actualIterations: opts?.iterations ?? 0,
        interrupted: opts?.interrupted ?? false,
      },
    ],
    mergedFindings: [
      {
        childId,
        objective: 'test',
        evidence: [text],
        artifacts: [],
      },
    ],
    mergedArtifacts: [],
    totalTokensUsed: 0,
    cancelledChildren: [],
  };
}

describe('empty-summary fallback — dispatch_child_task pipeline', () => {
  beforeEach(() => {
    mockExec.mockReset();
    _resetMessageQueueForTests();
    delete process.env.KODAX_ASYNC_DISPATCH;
    delete process.env.KODAX_DISPATCH_CHILD_TRACE;
  });
  afterEach(() => {
    _resetMessageQueueForTests();
    delete process.env.KODAX_ASYNC_DISPATCH;
    delete process.env.KODAX_DISPATCH_CHILD_TRACE;
  });

  it('async-success path: empty lastText/summary triggers diagnostic fallback (not empty banner)', async () => {
    mockExec.mockResolvedValueOnce(
      buildEmptySuccessResult('empty-1', { interrupted: true, iterations: 0 }),
    );
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    const ctx = buildBaseCtx(registry);

    await drainGeneratorReturn(
      toolDispatchChildTask({ id: 'empty-1', objective: 'probe' }, ctx),
    );
    await registry.get('empty-1');

    const queue = getMessageQueue();
    const peeked = queue.peek({ maxPriority: 'background' });
    expect(peeked).toHaveLength(1);
    const banner = peeked[0]?.content ?? '';
    // Outer wrapper still present.
    expect(banner).toContain('<task-completed task_id="empty-1">');
    expect(banner).toContain('</task-completed>');
    // Diagnostic fallback body — was empty before fix.
    expect(banner).toContain('produced no observable text output');
    expect(banner).toContain('interrupted=true');
    expect(banner).toContain('iterations=0');
    // Strip outer tag whitespace; the inner content MUST NOT be empty.
    const inner = banner
      .replace(/^<task-completed task_id="[^"]+">\s*/, '')
      .replace(/\s*<\/task-completed>$/, '');
    expect(inner.trim().length).toBeGreaterThan(0);
  });

  it('async-success path: whitespace-only summary also triggers fallback', async () => {
    mockExec.mockResolvedValueOnce(
      buildEmptySuccessResult('empty-2', { whitespace: true }),
    );
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    const ctx = buildBaseCtx(registry);

    await drainGeneratorReturn(
      toolDispatchChildTask({ id: 'empty-2', objective: 'probe' }, ctx),
    );
    await registry.get('empty-2');

    const banner = getMessageQueue().peek({ maxPriority: 'background' })[0]?.content ?? '';
    expect(banner).toContain('produced no observable text output');
  });

  it('async-success path: non-empty findings bypass the fallback (no regression)', async () => {
    mockExec.mockResolvedValueOnce(buildSuccessResult('good-1', ['real findings here']));
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    const ctx = buildBaseCtx(registry);

    await drainGeneratorReturn(
      toolDispatchChildTask({ id: 'good-1', objective: 'probe' }, ctx),
    );
    await registry.get('good-1');

    const banner = getMessageQueue().peek({ maxPriority: 'background' })[0]?.content ?? '';
    expect(banner).toContain('real findings here');
    expect(banner).not.toContain('produced no observable text output');
  });

  it('sync legacy path: empty findings produce diagnostic fallback, not empty string', async () => {
    process.env.KODAX_ASYNC_DISPATCH = '0';
    mockExec.mockResolvedValueOnce(
      buildEmptySuccessResult('sync-empty', { interrupted: false, iterations: 3 }),
    );
    // Sync mode: registry undefined.
    const ctx = buildBaseCtx(undefined);

    const result = await drainGeneratorReturn(
      toolDispatchChildTask({ id: 'sync-empty', objective: 'probe' }, ctx),
    );

    expect(result).toContain('produced no observable text output');
    expect(result).toContain('iterations=3');
    expect(result.trim().length).toBeGreaterThan(0);
  });

  it('crash path: empty Error.message still produces a non-empty banner', async () => {
    mockExec.mockRejectedValueOnce(new Error(''));
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    const ctx = buildBaseCtx(registry);

    await drainGeneratorReturn(
      toolDispatchChildTask({ id: 'crash-empty', objective: 'probe' }, ctx),
    );
    await registry.get('crash-empty')?.catch(() => undefined);
    await Promise.resolve();

    const banner = getMessageQueue().peek({ maxPriority: 'background' })[0]?.content ?? '';
    expect(banner).toContain('crash:');
    expect(banner).toContain('unknown error');
  });

  it('KODAX_DISPATCH_CHILD_TRACE=1 writes a JSON trace file', async () => {
    process.env.KODAX_DISPATCH_CHILD_TRACE = '1';
    mockExec.mockResolvedValueOnce(buildSuccessResult('trace-1', ['hi']));
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    const ctx = buildBaseCtx(registry);

    await drainGeneratorReturn(
      toolDispatchChildTask({ id: 'trace-1', objective: 'probe' }, ctx),
    );
    await registry.get('trace-1');

    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const fsPromises = await import('fs/promises');
    const traceDir = join(tmpdir(), 'kodax-dispatch-trace');
    const files = await fsPromises.readdir(traceDir).catch(() => [] as string[]);
    const matching = files.filter((f) => f.includes('trace-1'));
    expect(matching.length).toBeGreaterThan(0);
    // Cleanup
    await Promise.all(
      matching.map((f) => fsPromises.unlink(join(traceDir, f)).catch(() => undefined)),
    );
  });

  it('KODAX_DISPATCH_CHILD_TRACE unset writes no trace file', async () => {
    mockExec.mockResolvedValueOnce(buildSuccessResult('trace-off', ['hi']));
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    const ctx = buildBaseCtx(registry);

    await drainGeneratorReturn(
      toolDispatchChildTask({ id: 'trace-off', objective: 'probe' }, ctx),
    );
    await registry.get('trace-off');

    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const fsPromises = await import('fs/promises');
    const traceDir = join(tmpdir(), 'kodax-dispatch-trace');
    const files = await fsPromises.readdir(traceDir).catch(() => [] as string[]);
    const matching = files.filter((f) => f.includes('trace-off'));
    expect(matching.length).toBe(0);
  });
});
