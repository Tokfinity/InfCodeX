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
  KodaXEvents,
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

  it('passes parent events into child executor options for child live telemetry', async () => {
    const events: KodaXEvents = {
      onTextDelta: () => {},
      onToolProgress: () => {},
    };
    mockExec.mockResolvedValue(buildSuccessResult('telemetry-child', ['done']));
    const ctx = {
      ...buildBaseCtx(undefined),
      parentEvents: events,
    };

    await drainGeneratorReturn(
      toolDispatchChildTask({ id: 'telemetry-child', objective: 'scan' }, ctx),
    );

    expect(mockExec).toHaveBeenCalledOnce();
    const options = mockExec.mock.calls[0]![2] as { parentOptions: { events?: KodaXEvents } };
    expect(options.parentOptions.events).toBe(events);
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

  it('generates unique ids for same-millisecond auto dispatches', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_234_567_890);
    mockExec.mockReturnValue(new Promise(() => {})); // never resolves
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    const ctx = buildBaseCtx(registry);

    try {
      const first = await drainGeneratorReturn(
        toolDispatchChildTask({ objective: 'a' }, ctx),
      );
      const second = await drainGeneratorReturn(
        toolDispatchChildTask({ objective: 'b' }, ctx),
      );

      const firstId = first.match(/task_id:([^\s]+)/)?.[1];
      const secondId = second.match(/task_id:([^\s]+)/)?.[1];
      expect(firstId).toMatch(/^child-/);
      expect(secondId).toMatch(/^child-/);
      expect(firstId).not.toBe(secondId);
      expect(first).not.toContain('already in flight');
      expect(second).not.toContain('already in flight');
      expect(registry.has(firstId ?? '')).toBe(true);
      expect(registry.has(secondId ?? '')).toBe(true);
      expect(mockExec).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
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
  // Per-describe-run unique suffix so trace-file assertions don't collide
  // with stray files from a previous crashed test process (M2 fix in the
  // post-commit review pass). Without this, the "env unset writes no
  // trace" assertion could go flaky if an earlier run aborted before
  // afterEach cleanup ran.
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // Track every childId used in this describe block so afterEach can
  // remove any matching trace file regardless of whether the test body
  // reached its inline cleanup (M1 fix — old version had cleanup inside
  // the `it` body, so an early `expect` failure leaked files).
  const childIdsUsed: string[] = [];
  const childId = (base: string): string => {
    const id = `${base}-${runId}`;
    childIdsUsed.push(id);
    return id;
  };

  beforeEach(() => {
    mockExec.mockReset();
    _resetMessageQueueForTests();
    delete process.env.KODAX_ASYNC_DISPATCH;
    delete process.env.KODAX_DISPATCH_CHILD_TRACE;
  });
  afterEach(async () => {
    _resetMessageQueueForTests();
    delete process.env.KODAX_ASYNC_DISPATCH;
    delete process.env.KODAX_DISPATCH_CHILD_TRACE;
    // Sweep any trace files this test produced. Best-effort — directory
    // may not exist if no test in this run hit the writer.
    if (childIdsUsed.length === 0) return;
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const fsPromises = await import('fs/promises');
    const traceDir = join(tmpdir(), 'kodax-dispatch-trace');
    const files = await fsPromises.readdir(traceDir).catch(() => [] as string[]);
    await Promise.all(
      files
        .filter((f) => childIdsUsed.some((id) => f.includes(id)))
        .map((f) => fsPromises.unlink(join(traceDir, f)).catch(() => undefined)),
    );
  });

  it('async-success path: empty lastText/summary triggers diagnostic fallback (not empty banner)', async () => {
    const id = childId('empty-1');
    mockExec.mockResolvedValueOnce(
      buildEmptySuccessResult(id, { interrupted: true, iterations: 0 }),
    );
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    const ctx = buildBaseCtx(registry);

    await drainGeneratorReturn(
      toolDispatchChildTask({ id, objective: 'probe' }, ctx),
    );
    await registry.get(id);

    const queue = getMessageQueue();
    const peeked = queue.peek({ maxPriority: 'background' });
    expect(peeked).toHaveLength(1);
    const banner = peeked[0]?.content ?? '';
    // Outer wrapper still present.
    expect(banner).toContain(`<task-completed task_id="${id}">`);
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
    const id = childId('empty-2');
    mockExec.mockResolvedValueOnce(
      buildEmptySuccessResult(id, { whitespace: true }),
    );
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    const ctx = buildBaseCtx(registry);

    await drainGeneratorReturn(
      toolDispatchChildTask({ id, objective: 'probe' }, ctx),
    );
    await registry.get(id);

    const banner = getMessageQueue().peek({ maxPriority: 'background' })[0]?.content ?? '';
    expect(banner).toContain('produced no observable text output');
  });

  it('async-success path: non-empty findings bypass the fallback (no regression)', async () => {
    const id = childId('good-1');
    mockExec.mockResolvedValueOnce(buildSuccessResult(id, ['real findings here']));
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    const ctx = buildBaseCtx(registry);

    await drainGeneratorReturn(
      toolDispatchChildTask({ id, objective: 'probe' }, ctx),
    );
    await registry.get(id);

    const banner = getMessageQueue().peek({ maxPriority: 'background' })[0]?.content ?? '';
    expect(banner).toContain('real findings here');
    expect(banner).not.toContain('produced no observable text output');
  });

  // L5: evidence array `[childSummary='', ...evidenceRefs]` joins to a
  // non-empty string when any evidenceRef survives. Fallback must NOT
  // fire in this shape — the bundle's known evidence is real content
  // even if the child agent itself emitted no final text. Pins the
  // contract so a future "simplification" that uses `r.summary.trim()`
  // instead of `evidence.join(...).trim()` would fail this test.
  it('async-success path: empty childSummary but non-empty evidenceRefs bypasses fallback', async () => {
    const id = childId('refs-only');
    const result: KodaXChildExecutionResult = {
      results: [
        {
          childId: id,
          fanoutClass: 'evidence-scan',
          status: 'completed',
          disposition: 'valid',
          summary: '', // child emitted no text
          evidenceRefs: ['file:src/foo.ts'],
          contradictions: [],
          actualIterations: 1,
          interrupted: false,
        },
      ],
      mergedFindings: [
        {
          childId: id,
          objective: 'test',
          // mergeChildResults builds: [r.summary, ...r.evidenceRefs]
          evidence: ['', 'file:src/foo.ts'],
          artifacts: [],
        },
      ],
      mergedArtifacts: [],
      totalTokensUsed: 0,
      cancelledChildren: [],
    };
    mockExec.mockResolvedValueOnce(result);
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    const ctx = buildBaseCtx(registry);

    await drainGeneratorReturn(
      toolDispatchChildTask({ id, objective: 'probe' }, ctx),
    );
    await registry.get(id);

    const banner = getMessageQueue().peek({ maxPriority: 'background' })[0]?.content ?? '';
    expect(banner).toContain('file:src/foo.ts');
    expect(banner).not.toContain('produced no observable text output');
  });

  it('sync legacy path: empty findings produce diagnostic fallback, not empty string', async () => {
    const id = childId('sync-empty');
    process.env.KODAX_ASYNC_DISPATCH = '0';
    mockExec.mockResolvedValueOnce(
      buildEmptySuccessResult(id, { interrupted: false, iterations: 3 }),
    );
    // Sync mode: registry undefined.
    const ctx = buildBaseCtx(undefined);

    const result = await drainGeneratorReturn(
      toolDispatchChildTask({ id, objective: 'probe' }, ctx),
    );

    expect(result).toContain('produced no observable text output');
    expect(result).toContain('iterations=3');
    expect(result.trim().length).toBeGreaterThan(0);
  });

  it('async-failed path: silent-drop (resultsCount=0) triggers diagnostic envelope', async () => {
    // Regression guard for the validateWriteBundles silent-drop bug: Worker
    // dispatches write child, validateWriteBundles drops it before the
    // child runner is invoked, executeChildAgents returns EMPTY_RESULT,
    // and dispatch unpacks `result.results[0] === undefined`. Pre-fix the
    // Worker banner read `failed: no result`; now it carries a diagnostic
    // envelope classifying mode=silent-drop with the readOnly + parentRole
    // context so investigation has a starting point.
    //
    // The test uses managedProtocolRole='worker' + read_only:false so the
    // dispatch passes the role gate at dispatch-child-tasks.ts:308-316.
    // The mocked executeChildAgents returns EMPTY_RESULT directly to
    // simulate any silent-drop path (validateWriteBundles or other early
    // returns inside executeChildAgents).
    const id = childId('silent-drop');
    const emptyResult: KodaXChildExecutionResult = {
      results: [],
      mergedFindings: [],
      mergedArtifacts: [],
      totalTokensUsed: 0,
      cancelledChildren: [],
    };
    mockExec.mockResolvedValueOnce(emptyResult);
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    const ctx: KodaXToolExecutionContext = {
      ...buildBaseCtx(registry),
      managedProtocolRole: 'worker',
    };

    await drainGeneratorReturn(
      toolDispatchChildTask({ id, objective: 'probe', read_only: false }, ctx),
    );
    await registry.get(id);

    const banner = getMessageQueue().peek({ maxPriority: 'background' })[0]?.content ?? '';
    expect(banner).toContain(`<task-completed task_id="${id}">`);
    expect(banner).toContain('FAILED with no result text');
    expect(banner).toContain('mode=silent-drop');
    expect(banner).toContain('parentRole=worker');
    expect(banner).toContain('readOnly=false');
    // Critical: does NOT contain the bare literal pre-fix text.
    expect(banner).not.toContain('failed: no result');
    // Outer tag content is non-empty.
    const inner = banner
      .replace(/^<task-completed task_id="[^"]+">\s*/, '')
      .replace(/\s*<\/task-completed>$/, '');
    expect(inner.trim().length).toBeGreaterThan(0);
  });

  it('async-failed path: startup-crash (iterations=0, results=1) classifies as startup-crash', async () => {
    // run-substrate CAP-084 generic error terminal returns
    // `success:false, lastText:''` after a provider stream error before any
    // text was accumulated. child-executor reports `status='failed',
    // summary='', actualIterations=0`. The envelope should classify
    // mode=startup-crash with the iteration count visible.
    const id = childId('startup-crash');
    const failedResult: KodaXChildExecutionResult = {
      results: [
        {
          childId: id,
          fanoutClass: 'evidence-scan',
          status: 'failed',
          disposition: 'needs-more-evidence',
          summary: '',
          evidenceRefs: [],
          contradictions: [],
          actualIterations: 0,
          interrupted: false,
        },
      ],
      mergedFindings: [],
      mergedArtifacts: [],
      totalTokensUsed: 0,
      cancelledChildren: [],
    };
    mockExec.mockResolvedValueOnce(failedResult);
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    const ctx = buildBaseCtx(registry);

    await drainGeneratorReturn(
      toolDispatchChildTask({ id, objective: 'probe' }, ctx),
    );
    await registry.get(id);

    const banner = getMessageQueue().peek({ maxPriority: 'background' })[0]?.content ?? '';
    expect(banner).toContain('FAILED with no result text');
    expect(banner).toContain('mode=startup-crash');
    expect(banner).toContain('iterations=0');
    expect(banner).not.toContain('failed: no result');
  });

  it('async-failed path: mid-run-failure (iterations>0) classifies as mid-run-failure', async () => {
    const id = childId('mid-run');
    const failedResult: KodaXChildExecutionResult = {
      results: [
        {
          childId: id,
          fanoutClass: 'evidence-scan',
          status: 'failed',
          disposition: 'needs-more-evidence',
          summary: '',
          evidenceRefs: [],
          contradictions: [],
          actualIterations: 7,
          interrupted: false,
        },
      ],
      mergedFindings: [],
      mergedArtifacts: [],
      totalTokensUsed: 0,
      cancelledChildren: [],
    };
    mockExec.mockResolvedValueOnce(failedResult);
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    const ctx = buildBaseCtx(registry);

    await drainGeneratorReturn(
      toolDispatchChildTask({ id, objective: 'probe' }, ctx),
    );
    await registry.get(id);

    const banner = getMessageQueue().peek({ maxPriority: 'background' })[0]?.content ?? '';
    expect(banner).toContain('mode=mid-run-failure');
    expect(banner).toContain('iterations=7');
  });

  it('async-failed path: non-empty summary bypasses envelope (no regression)', async () => {
    // When child reports failure WITH a summary, the envelope must NOT fire
    // — the Worker should see the real error message, not a generic
    // diagnostic.
    const id = childId('failed-with-msg');
    const failedResult: KodaXChildExecutionResult = {
      results: [
        {
          childId: id,
          fanoutClass: 'evidence-scan',
          status: 'failed',
          disposition: 'needs-more-evidence',
          summary: 'specific error: ENOENT /tmp/foo',
          evidenceRefs: [],
          contradictions: [],
          actualIterations: 2,
          interrupted: false,
        },
      ],
      mergedFindings: [],
      mergedArtifacts: [],
      totalTokensUsed: 0,
      cancelledChildren: [],
    };
    mockExec.mockResolvedValueOnce(failedResult);
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    const ctx = buildBaseCtx(registry);

    await drainGeneratorReturn(
      toolDispatchChildTask({ id, objective: 'probe' }, ctx),
    );
    await registry.get(id);

    const banner = getMessageQueue().peek({ maxPriority: 'background' })[0]?.content ?? '';
    expect(banner).toContain('failed: specific error: ENOENT /tmp/foo');
    expect(banner).not.toContain('FAILED with no result text');
    expect(banner).not.toContain('mode=');
  });

  it('sync-failed path: empty summary triggers diagnostic envelope (parity with async)', async () => {
    const id = childId('sync-failed-empty');
    process.env.KODAX_ASYNC_DISPATCH = '0';
    const failedResult: KodaXChildExecutionResult = {
      results: [
        {
          childId: id,
          fanoutClass: 'evidence-scan',
          status: 'failed',
          disposition: 'needs-more-evidence',
          summary: '',
          evidenceRefs: [],
          contradictions: [],
          actualIterations: 0,
          interrupted: false,
        },
      ],
      mergedFindings: [],
      mergedArtifacts: [],
      totalTokensUsed: 0,
      cancelledChildren: [],
    };
    mockExec.mockResolvedValueOnce(failedResult);
    const ctx = buildBaseCtx(undefined);

    const result = await drainGeneratorReturn(
      toolDispatchChildTask({ id, objective: 'probe' }, ctx),
    );

    expect(result).toContain('FAILED with no result text');
    expect(result).toContain('mode=startup-crash');
    expect(result).not.toContain('failed: no result');
  });

  it('crash path: empty Error.message still produces a non-empty banner', async () => {
    const id = childId('crash-empty');
    mockExec.mockRejectedValueOnce(new Error(''));
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    const ctx = buildBaseCtx(registry);

    await drainGeneratorReturn(
      toolDispatchChildTask({ id, objective: 'probe' }, ctx),
    );
    await registry.get(id)?.catch(() => undefined);
    await Promise.resolve();

    const banner = getMessageQueue().peek({ maxPriority: 'background' })[0]?.content ?? '';
    expect(banner).toContain('crash:');
    expect(banner).toContain('unknown error');
  });

  it('KODAX_DISPATCH_CHILD_TRACE=1 writes a JSON trace file', async () => {
    const id = childId('trace-on');
    process.env.KODAX_DISPATCH_CHILD_TRACE = '1';
    mockExec.mockResolvedValueOnce(buildSuccessResult(id, ['hi']));
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    const ctx = buildBaseCtx(registry);

    await drainGeneratorReturn(
      toolDispatchChildTask({ id, objective: 'probe' }, ctx),
    );
    await registry.get(id);

    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const fsPromises = await import('fs/promises');
    const traceDir = join(tmpdir(), 'kodax-dispatch-trace');
    const files = await fsPromises.readdir(traceDir).catch(() => [] as string[]);
    const matching = files.filter((f) => f.includes(id));
    expect(matching.length).toBeGreaterThan(0);
    // Trace JSON should carry the new `branch` discriminator (renamed
    // from `path` in the review pass to avoid shadowing the `path` Node
    // module name in payload skim).
    const content = await fsPromises.readFile(join(traceDir, matching[0]!), 'utf-8');
    const parsed = JSON.parse(content) as { branch: string };
    expect(parsed.branch).toBe('async-success');
    // Cleanup is handled by afterEach via childIdsUsed registry.
  });

  it('KODAX_DISPATCH_CHILD_TRACE unset writes no trace file', async () => {
    const id = childId('trace-off');
    mockExec.mockResolvedValueOnce(buildSuccessResult(id, ['hi']));
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    const ctx = buildBaseCtx(registry);

    await drainGeneratorReturn(
      toolDispatchChildTask({ id, objective: 'probe' }, ctx),
    );
    await registry.get(id);

    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const fsPromises = await import('fs/promises');
    const traceDir = join(tmpdir(), 'kodax-dispatch-trace');
    const files = await fsPromises.readdir(traceDir).catch(() => [] as string[]);
    const matching = files.filter((f) => f.includes(id));
    expect(matching.length).toBe(0);
  });
});

// FEATURE_177 v0.7.45 — snapshot lifecycle wiring. Verifies that the
// dispatch tool initialises the per-child snapshot at launch and
// finalises it (status + finalText) in the inner-IIFE `.finally` for
// both the success and crash paths.
describe('FEATURE_177 — child progress snapshot lifecycle', () => {
  beforeEach(() => {
    mockExec.mockReset();
    _resetMessageQueueForTests();
    delete process.env.KODAX_ASYNC_DISPATCH;
  });
  afterEach(() => {
    _resetMessageQueueForTests();
    delete process.env.KODAX_ASYNC_DISPATCH;
  });

  it('initialises snapshot status=running at dispatch (before child settles)', async () => {
    let resolveExec!: (r: KodaXChildExecutionResult) => void;
    mockExec.mockReturnValue(
      new Promise<KodaXChildExecutionResult>((resolve) => {
        resolveExec = resolve;
      }),
    );
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    const snapshots = new Map<
      string,
      import('../child-progress-snapshot.js').ChildProgressSnapshot
    >();
    const ctx: KodaXToolExecutionContext = {
      ...buildBaseCtx(registry),
      childProgressSnapshots: snapshots,
    };

    await drainGeneratorReturn(
      toolDispatchChildTask({ id: 'snap-1', objective: 'probe' }, ctx),
    );
    // Snapshot must exist immediately after the dispatch banner, BEFORE
    // the child promise settles. This is the contract that lets a
    // concurrent task_output call see `running` instead of `not_found`.
    expect(snapshots.has('snap-1')).toBe(true);
    expect(snapshots.get('snap-1')?.status).toBe('running');

    // Settle and let the .finally chain run.
    resolveExec(buildSuccessResult('snap-1', ['ok']));
    await registry.get('snap-1');
    await Promise.resolve();
  });

  it('finalises snapshot status=completed + finalText on success', async () => {
    mockExec.mockResolvedValue(buildSuccessResult('snap-2', ['evidence A', 'evidence B']));
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    const snapshots = new Map<
      string,
      import('../child-progress-snapshot.js').ChildProgressSnapshot
    >();
    const ctx: KodaXToolExecutionContext = {
      ...buildBaseCtx(registry),
      childProgressSnapshots: snapshots,
    };

    await drainGeneratorReturn(
      toolDispatchChildTask({ id: 'snap-2', objective: 'probe' }, ctx),
    );
    await registry.get('snap-2');
    await Promise.resolve();

    const snap = snapshots.get('snap-2');
    expect(snap).toBeDefined();
    expect(snap?.status).toBe('completed');
    expect(snap?.endedAt).toBeDefined();
    // finalText carries the pre-guardrail rawSummary — for the success
    // path that's the merged-findings evidence text.
    expect(snap?.finalText).toContain('evidence A');
    expect(snap?.finalText).toContain('evidence B');
  });

  it('finalises snapshot status=failed + finalText (diagnostic envelope) on silent-drop', async () => {
    // Silent-drop: executor returns EMPTY_RESULT with no results entries.
    mockExec.mockResolvedValue({
      results: [],
      mergedFindings: [],
      mergedArtifacts: [],
      totalTokensUsed: 0,
      cancelledChildren: [],
    });
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    const snapshots = new Map<
      string,
      import('../child-progress-snapshot.js').ChildProgressSnapshot
    >();
    const ctx: KodaXToolExecutionContext = {
      ...buildBaseCtx(registry),
      childProgressSnapshots: snapshots,
    };

    await drainGeneratorReturn(
      toolDispatchChildTask({ id: 'snap-3', objective: 'probe' }, ctx),
    );
    await registry.get('snap-3');
    await Promise.resolve();

    const snap = snapshots.get('snap-3');
    expect(snap?.status).toBe('failed');
    // The failed-empty envelope from buildFailedEmptySummaryFallback —
    // mode= field is the key diagnostic the Worker uses.
    expect(snap?.finalText).toMatch(/mode=/);
  });

  it('finalises snapshot status=failed + finalText (crash envelope) on executor reject', async () => {
    mockExec.mockRejectedValue(new Error('boom'));
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    const snapshots = new Map<
      string,
      import('../child-progress-snapshot.js').ChildProgressSnapshot
    >();
    const ctx: KodaXToolExecutionContext = {
      ...buildBaseCtx(registry),
      childProgressSnapshots: snapshots,
    };

    await drainGeneratorReturn(
      toolDispatchChildTask({ id: 'snap-4', objective: 'probe' }, ctx),
    );
    await registry.get('snap-4')?.catch(() => undefined);
    await Promise.resolve();

    const snap = snapshots.get('snap-4');
    expect(snap?.status).toBe('failed');
    expect(snap?.finalText).toMatch(/crash: boom/);
  });

  it('snapshot persists after registry entry is cleaned (post-completion peek works)', async () => {
    mockExec.mockResolvedValue(buildSuccessResult('snap-5', ['done']));
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    const snapshots = new Map<
      string,
      import('../child-progress-snapshot.js').ChildProgressSnapshot
    >();
    const ctx: KodaXToolExecutionContext = {
      ...buildBaseCtx(registry),
      childProgressSnapshots: snapshots,
    };

    await drainGeneratorReturn(
      toolDispatchChildTask({ id: 'snap-5', objective: 'probe' }, ctx),
    );
    await registry.get('snap-5');
    await Promise.resolve();

    // Registry entry is cleaned by registerChildTask's built-in finally;
    // snapshot should remain (post-completion task_output reads).
    expect(registry.has('snap-5')).toBe(false);
    expect(snapshots.has('snap-5')).toBe(true);
    expect(snapshots.get('snap-5')?.status).toBe('completed');
  });

  it('does not crash dispatch when childProgressSnapshots is undefined (defensive)', async () => {
    mockExec.mockResolvedValue(buildSuccessResult('snap-6', ['ok']));
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    // Explicitly omit childProgressSnapshots from ctx — covers older test
    // ctx shapes and the future ext-runtime path that may not provision
    // the substrate.
    const ctx: KodaXToolExecutionContext = buildBaseCtx(registry);

    const banner = await drainGeneratorReturn(
      toolDispatchChildTask({ id: 'snap-6', objective: 'probe' }, ctx),
    );
    expect(banner).toContain('task_id:snap-6');
    await registry.get('snap-6');
    await Promise.resolve();
    // No snapshot map → no exception, the rest of dispatch proceeds.
  });
});

describe('FEATURE_191 — dispatch_child_task subagent_type guards (A.2 + A.2c)', () => {
  beforeEach(async () => {
    mockExec.mockReset();
    _resetMessageQueueForTests();
    const { _resetAgentResolverForTesting } = await import('../construction/agent-resolver.js');
    _resetAgentResolverForTesting();
  });
  afterEach(async () => {
    _resetMessageQueueForTests();
    const { _resetAgentResolverForTesting } = await import('../construction/agent-resolver.js');
    _resetAgentResolverForTesting();
  });

  it('A.2: returns tool-result error for unknown subagent_type (does not throw)', async () => {
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    const ctx = buildBaseCtx(registry);

    const result = await drainGeneratorReturn(
      toolDispatchChildTask(
        { id: 'sp-unknown', objective: 'probe', subagent_type: 'ghost-reviewer' },
        ctx,
      ),
    );

    expect(result).toMatch(/^\[Tool Error\]/);
    expect(result).toContain('ghost-reviewer');
    expect(result).toContain('not registered');
    expect(result).toContain('Available:');
    // Executor must NOT be called when subagent_type is rejected
    expect(mockExec).not.toHaveBeenCalled();
    // Registry must not gain a bogus entry
    expect(registry.size).toBe(0);
  });

  it('A.2: known subagent_type passes through to bundle.specialistName', async () => {
    const { registerConstructedAgent } = await import('../construction/agent-resolver.js');
    registerConstructedAgent({
      kind: 'agent',
      name: 'db-reviewer',
      version: '1.0.0',
      content: {
        instructions: 'DB REVIEWER',
        tools: [{ ref: 'builtin:read' }],
      },
      status: 'active',
      createdAt: Date.now(),
      testedAt: Date.now(),
      activatedAt: Date.now(),
    });
    mockExec.mockResolvedValue(buildSuccessResult('sp-known', ['ok']));
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    const ctx = buildBaseCtx(registry);

    const result = await drainGeneratorReturn(
      toolDispatchChildTask(
        { id: 'sp-known', objective: 'review schema', subagent_type: 'db-reviewer' },
        ctx,
      ),
    );

    expect(result).toContain('task_id:sp-known');
    expect(mockExec).toHaveBeenCalledTimes(1);
    // Inspect the bundle passed to executor — bundle.specialistName must be set
    const execCallArgs = mockExec.mock.calls[0]!;
    const bundles = execCallArgs[0] as readonly { specialistName?: string }[];
    expect(bundles[0]?.specialistName).toBe('db-reviewer');
  });

  it('A.2: specialist-declared effort is applied to the dispatch bundle', async () => {
    const { registerConstructedAgent } = await import('../construction/agent-resolver.js');
    registerConstructedAgent({
      kind: 'agent',
      name: 'deep-reviewer',
      version: '1.0.0',
      content: {
        instructions: 'DEEP REVIEWER',
        tools: [{ ref: 'builtin:read' }],
        effort: 'xhigh',
      },
      status: 'active',
      createdAt: Date.now(),
      testedAt: Date.now(),
      activatedAt: Date.now(),
    });
    mockExec.mockResolvedValue(buildSuccessResult('sp-effort', ['ok']));
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    const ctx = buildBaseCtx(registry);

    const result = await drainGeneratorReturn(
      toolDispatchChildTask(
        { id: 'sp-effort', objective: 'review deeply', subagent_type: 'deep-reviewer' },
        ctx,
      ),
    );

    expect(result).toContain('task_id:sp-effort');
    expect(mockExec).toHaveBeenCalledTimes(1);
    const bundles = mockExec.mock.calls[0]![0] as readonly { effort?: string }[];
    expect(bundles[0]?.effort).toBe('xhigh');
  });

  it('A.2: rejects dispatch effort that conflicts with specialist-declared effort', async () => {
    const { registerConstructedAgent } = await import('../construction/agent-resolver.js');
    registerConstructedAgent({
      kind: 'agent',
      name: 'locked-reviewer',
      version: '1.0.0',
      content: {
        instructions: 'LOCKED REVIEWER',
        tools: [{ ref: 'builtin:read' }],
        effort: 'high',
      },
      status: 'active',
      createdAt: Date.now(),
      testedAt: Date.now(),
      activatedAt: Date.now(),
    });
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    const ctx = buildBaseCtx(registry);

    const result = await drainGeneratorReturn(
      toolDispatchChildTask(
        {
          id: 'sp-effort-conflict',
          objective: 'review cheaply',
          subagent_type: 'locked-reviewer',
          effort: 'low',
        },
        ctx,
      ),
    );

    expect(result).toMatch(/^\[Tool Error\]/);
    expect(result).toContain('locked-reviewer');
    expect(result).toContain('locks effort "high"');
    expect(result).toContain('dispatch requested "low"');
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('A.2c: rejects write specialist dispatch from scout role with explicit error', async () => {
    const { registerConstructedAgent } = await import('../construction/agent-resolver.js');
    registerConstructedAgent({
      kind: 'agent',
      name: 'refactor-helper',
      version: '1.0.0',
      content: {
        instructions: 'REFACTOR HELPER',
        tools: [{ ref: 'builtin:write' }, { ref: 'builtin:edit' }],
      },
      status: 'active',
      createdAt: Date.now(),
      testedAt: Date.now(),
      activatedAt: Date.now(),
    });
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    const ctx = buildBaseCtx(registry); // managedProtocolRole: 'scout'

    // The pre-existing scout/!readOnly guard at line 399 fires FIRST and
    // returns its own scout-specific error. This test verifies that combined
    // guard surface — scout can never dispatch write children whether or not
    // a specialist is named.
    const result = await drainGeneratorReturn(
      toolDispatchChildTask(
        { id: 'sp-write-scout', objective: 'refactor', readOnly: false, subagent_type: 'refactor-helper' },
        ctx,
      ),
    );

    expect(result).toMatch(/^\[Tool Error\]/);
    // Either the scout-readonly guard OR the specialist-write-role guard
    // produces the error — both surface explicit reason, neither silently drops.
    expect(result.toLowerCase()).toMatch(/scout|write|specialist|cannot|read-only/);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('A.2c: rejects write specialist dispatch from unauthorized role with specialist-specific error', async () => {
    const { registerConstructedAgent } = await import('../construction/agent-resolver.js');
    registerConstructedAgent({
      kind: 'agent',
      name: 'refactor-helper',
      version: '1.0.0',
      content: {
        instructions: 'REFACTOR HELPER',
        tools: [{ ref: 'builtin:write' }],
      },
      status: 'active',
      createdAt: Date.now(),
      testedAt: Date.now(),
      activatedAt: Date.now(),
    });
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    // Custom role outside scout/planner/evaluator/worker/generator that
    // would historically pass the pre-existing guards but fall into
    // validateWriteBundles silent-drop. The specialist-specific A.2c guard
    // catches it here with an explicit reason.
    const ctx: KodaXToolExecutionContext = {
      ...buildBaseCtx(registry),
      managedProtocolRole: 'custom-role' as never,
    };

    const result = await drainGeneratorReturn(
      toolDispatchChildTask(
        { id: 'sp-write-custom', objective: 'refactor', readOnly: false, subagent_type: 'refactor-helper' },
        ctx,
      ),
    );

    expect(result).toMatch(/^\[Tool Error\]/);
    expect(result).toContain('refactor-helper');
    expect(result.toLowerCase()).toMatch(/write|cannot dispatch/);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('A.2c: allows write specialist dispatch from worker role', async () => {
    const { registerConstructedAgent } = await import('../construction/agent-resolver.js');
    registerConstructedAgent({
      kind: 'agent',
      name: 'refactor-helper',
      version: '1.0.0',
      content: {
        instructions: 'REFACTOR HELPER',
        tools: [{ ref: 'builtin:write' }],
      },
      status: 'active',
      createdAt: Date.now(),
      testedAt: Date.now(),
      activatedAt: Date.now(),
    });
    mockExec.mockResolvedValue(buildSuccessResult('sp-write-ok', ['done']));
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    const ctx: KodaXToolExecutionContext = {
      ...buildBaseCtx(registry),
      managedProtocolRole: 'worker',
    };

    const result = await drainGeneratorReturn(
      toolDispatchChildTask(
        { id: 'sp-write-ok', objective: 'refactor', readOnly: false, subagent_type: 'refactor-helper' },
        ctx,
      ),
    );

    expect(result).toContain('task_id:sp-write-ok');
    expect(mockExec).toHaveBeenCalledTimes(1);
  });

  it('A.2d: ChildProgressSnapshot carries specialistName at init', async () => {
    const { registerConstructedAgent } = await import('../construction/agent-resolver.js');
    registerConstructedAgent({
      kind: 'agent',
      name: 'db-reviewer',
      version: '1.0.0',
      content: {
        instructions: 'DB REVIEWER',
        tools: [{ ref: 'builtin:read' }],
      },
      status: 'active',
      createdAt: Date.now(),
      testedAt: Date.now(),
      activatedAt: Date.now(),
    });
    const snapshots = new Map();
    mockExec.mockResolvedValue(buildSuccessResult('sp-snap', ['ok']));
    const registry = new Map<string, Promise<KodaXChildExecutionResult>>();
    const ctx: KodaXToolExecutionContext = {
      ...buildBaseCtx(registry),
      childProgressSnapshots: snapshots,
    };

    await drainGeneratorReturn(
      toolDispatchChildTask(
        { id: 'sp-snap', objective: 'probe', subagent_type: 'db-reviewer' },
        ctx,
      ),
    );

    const snap = snapshots.get('sp-snap');
    expect(snap).toBeDefined();
    expect(snap?.specialistName).toBe('db-reviewer');
  });
});
