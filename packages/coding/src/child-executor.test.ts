import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock runKodaX before importing child-executor
vi.mock('./agent.js', () => ({
  runKodaX: vi.fn(),
}));

// FEATURE_188 v0.7.42 — child-executor no longer imports worktree helpers,
// so `vi.mock('./tools/worktree.js')` and its mock objects are removed.

import type {
  KodaXChildContextBundle,
  KodaXAmaFanoutClass,
} from './types.js';
import {
  executeChildAgents,
  buildChildEvents,
  CHILD_AGENT_SYSTEM_PROMPT,
  CHILD_EXCLUDE_TOOLS_BASE,
} from './child-executor.js';
import { clearAgentsLoaderCacheForTesting } from './context/agents-loader.js';
import type { ChildExecutorOptions } from './child-executor.js';
import { runKodaX } from './agent.js';

const mockRunKodaX = runKodaX as ReturnType<typeof vi.fn>;

function createBundle(overrides: Partial<KodaXChildContextBundle> = {}): KodaXChildContextBundle {
  return {
    id: `cb-${Math.random().toString(36).slice(2, 6)}`,
    fanoutClass: 'evidence-scan' as KodaXAmaFanoutClass,
    objective: 'Test objective',
    evidenceRefs: [],
    constraints: [],
    readOnly: true,
    ...overrides,
  };
}

function createOptions(overrides: Partial<ChildExecutorOptions> = {}): ChildExecutorOptions {
  return {
    maxParallel: 4,
    maxIterationsPerChild: 20,
    parentOptions: { provider: 'anthropic' },
    parentRole: 'scout',
    parentHarness: 'H0_DIRECT',
    ...overrides,
  };
}

function createCtx() {
  return {
    backups: new Map(),
    gitRoot: '/test/repo',
    executionCwd: '/test/repo',
  };
}

describe('executeChildAgents — guardrails propagation (FEATURE_092 phase 2b.7b slice D)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const okResult = (lastText = 'done') => ({
    success: true,
    lastText,
    messages: [{ role: 'assistant', content: lastText }],
    sessionId: 's1',
  });

  it('forwards options.guardrails to the child runKodaX call (read child)', async () => {
    const fakeGuardrail = { kind: 'tool', name: 'auto-mode' } as const;
    mockRunKodaX.mockResolvedValue(okResult('inspected'));
    const bundles = [createBundle({ id: 'cb-g1', readOnly: true, objective: 'inspect' })];
    await executeChildAgents(bundles, createCtx(), createOptions({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      guardrails: [fakeGuardrail as any],
    } as Partial<ChildExecutorOptions>));
    expect(mockRunKodaX).toHaveBeenCalled();
    const childOptions = mockRunKodaX.mock.calls[0]![0] as { guardrails?: readonly unknown[] };
    expect(childOptions.guardrails).toBeDefined();
    expect(childOptions.guardrails).toEqual([fakeGuardrail]);
  });

  it('omits guardrails on child runKodaX when parent did not supply any (backward compat)', async () => {
    mockRunKodaX.mockResolvedValue(okResult('inspected'));
    const bundles = [createBundle({ id: 'cb-g2', readOnly: true, objective: 'inspect' })];
    await executeChildAgents(bundles, createCtx(), createOptions());
    expect(mockRunKodaX).toHaveBeenCalled();
    const childOptions = mockRunKodaX.mock.calls[0]![0] as { guardrails?: readonly unknown[] };
    expect(childOptions.guardrails).toBeUndefined();
  });

  it('forwards the SAME guardrail instance by reference (state-sharing contract)', async () => {
    // The auto-mode guardrail relies on a single shared mutable instance —
    // pass-by-reference is the contract that makes engine/tracker state
    // observable across the parent/child boundary.
    const fakeGuardrail = { kind: 'tool', name: 'auto-mode', mutableMarker: {} } as const;
    mockRunKodaX.mockResolvedValue(okResult('done'));
    const bundles = [createBundle({ id: 'cb-g3', readOnly: true, objective: 'read' })];
    await executeChildAgents(bundles, createCtx(), createOptions({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      guardrails: [fakeGuardrail as any],
    } as Partial<ChildExecutorOptions>));
    const childGuardrails = (mockRunKodaX.mock.calls[0]![0] as { guardrails?: readonly unknown[] }).guardrails;
    expect(childGuardrails![0]).toBe(fakeGuardrail); // identity, not equality
  });
});

describe('executeChildAgents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /* ---------- Read-only fan-out ---------- */

  it('returns empty result for empty bundles', async () => {
    const result = await executeChildAgents([], createCtx(), createOptions());
    expect(result.results).toEqual([]);
    expect(result.mergedFindings).toEqual([]);
    expect(result.cancelledChildren).toEqual([]);
  });

  it('executes read-only bundles in parallel', async () => {
    const bundles = [
      createBundle({ id: 'cb-1', objective: 'Check auth module' }),
      createBundle({ id: 'cb-2', objective: 'Check cache module' }),
    ];

    mockRunKodaX
      .mockResolvedValueOnce({ success: true, lastText: 'Auth coverage: 85%', messages: [{ role: 'assistant', content: '' }], sessionId: 's1' })
      .mockResolvedValueOnce({ success: true, lastText: 'Cache coverage: 72%', messages: [{ role: 'assistant', content: '' }], sessionId: 's2' });

    const result = await executeChildAgents(bundles, createCtx(), createOptions());

    expect(result.results).toHaveLength(2);
    expect(result.mergedFindings).toHaveLength(2);
    expect(result.mergedFindings[0]!.objective).toBe('Check auth module');
    expect(result.mergedFindings[1]!.objective).toBe('Check cache module');
    expect(mockRunKodaX).toHaveBeenCalledTimes(2);
  });

  it('handles child failure without affecting other children', async () => {
    const bundles = [
      createBundle({ id: 'cb-1', objective: 'Success task' }),
      createBundle({ id: 'cb-2', objective: 'Failing task' }),
    ];

    mockRunKodaX
      .mockResolvedValueOnce({ success: true, lastText: 'Done', messages: [{ role: 'assistant', content: '' }], sessionId: 's1' })
      .mockRejectedValueOnce(new Error('Provider timeout'));

    const result = await executeChildAgents(bundles, createCtx(), createOptions());

    expect(result.results).toHaveLength(2);
    const success = result.results.find((r) => r.childId === 'cb-1');
    const failure = result.results.find((r) => r.childId === 'cb-2');
    expect(success?.status).toBe('completed');
    expect(failure?.status).toBe('failed');
    expect(failure?.summary).toContain('Provider timeout');
  });

  it('respects maxParallel concurrency limit', async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;

    mockRunKodaX.mockImplementation(async () => {
      concurrentCount++;
      maxConcurrent = Math.max(maxConcurrent, concurrentCount);
      await new Promise((resolve) => setTimeout(resolve, 50));
      concurrentCount--;
      return { success: true, lastText: 'Done', messages: [{ role: 'assistant', content: '' }], sessionId: 's' };
    });

    const bundles = Array.from({ length: 6 }, (_, i) =>
      createBundle({ id: `cb-${i}`, objective: `Task ${i}` }),
    );

    await executeChildAgents(bundles, createCtx(), createOptions({ maxParallel: 2 }));

    expect(maxConcurrent).toBeLessThanOrEqual(2);
    expect(mockRunKodaX).toHaveBeenCalledTimes(6);
  });

  it('cancels pending children when abort signal fires', async () => {
    const controller = new AbortController();

    mockRunKodaX.mockImplementation(async () => {
      // Simulate slow execution
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { success: true, lastText: 'Done', messages: [{ role: 'assistant', content: '' }], sessionId: 's' };
    });

    const bundles = [
      createBundle({ id: 'cb-1' }),
      createBundle({ id: 'cb-2' }),
      createBundle({ id: 'cb-3' }),
    ];

    // Abort after a short delay
    setTimeout(() => controller.abort(), 50);

    const result = await executeChildAgents(
      bundles,
      createCtx(),
      createOptions({ maxParallel: 1, abortSignal: controller.signal }),
    );

    // At least some should be cancelled
    expect(result.cancelledChildren.length + result.results.length).toBeGreaterThan(0);
  });

  it('merges findings with anchored incremental approach', async () => {
    const bundles = [
      createBundle({ id: 'cb-1', objective: 'Find bugs in auth', evidenceRefs: ['file:src/auth.ts'] }),
      createBundle({ id: 'cb-2', objective: 'Find bugs in cache', evidenceRefs: ['file:src/cache.ts'] }),
    ];

    mockRunKodaX
      .mockResolvedValueOnce({ success: true, lastText: 'Found null check bug', messages: [{ role: 'assistant', content: '' }], sessionId: 's1' })
      .mockResolvedValueOnce({ success: true, lastText: 'Found race condition', messages: [{ role: 'assistant', content: '' }], sessionId: 's2' });

    const result = await executeChildAgents(bundles, createCtx(), createOptions());

    expect(result.mergedFindings).toHaveLength(2);
    expect(result.mergedFindings[0]!.evidence).toContain('Found null check bug');
    expect(result.mergedFindings[1]!.evidence).toContain('Found race condition');
    // Evidence refs from bundle are preserved
    expect(result.mergedFindings[0]!.evidence).toContain('file:src/auth.ts');
  });

  /* ---------- Write fan-out validation ---------- */

  it('rejects write bundles from non-H2 Generator roles', async () => {
    const bundles = [
      createBundle({ id: 'cb-1', readOnly: false, objective: 'Write task' }),
    ];

    // Scout cannot do write fan-out
    const result = await executeChildAgents(
      bundles,
      createCtx(),
      createOptions({ parentRole: 'scout', parentHarness: 'H0_DIRECT' }),
    );

    expect(result.results).toEqual([]);
    expect(mockRunKodaX).not.toHaveBeenCalled();
  });

  it('allows write bundles from V2 Worker via tool-dispatch (parentRole=worker)', async () => {
    // V2 single-loop Worker inherits Generator's dispatch surface (see
    // `wrapDispatchChildTaskForRole` role union + worker-role-prompt RULE
    // C). The `validateWriteBundles` allow-list MUST include 'worker',
    // otherwise the bundle is silently dropped (executeChildAgents returns
    // EMPTY_RESULT, dispatch-child-tasks unpacks `undefined`, Worker sees
    // `failed: no result` with no clue what happened). Regression guard.
    const bundles = [
      createBundle({ id: 'cb-worker-1', readOnly: false, objective: 'Refactor module A' }),
    ];

    mockRunKodaX.mockResolvedValueOnce({ success: true, lastText: 'Done', messages: [{ role: 'assistant', content: '' }], sessionId: 's-w1' });

    const result = await executeChildAgents(
      bundles,
      createCtx(),
      createOptions({ parentRole: 'worker', parentHarness: 'tool-dispatch' }),
    );

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.status).toBe('completed');
    expect(mockRunKodaX).toHaveBeenCalledTimes(1);
  });

  it('still rejects write bundles from non-dispatcher roles (planner/evaluator parity)', async () => {
    // Defensive: allow-list expansion must not turn into an allow-all. Use a
    // role string outside the {scout, generator, worker} set.
    const bundles = [
      createBundle({ id: 'cb-stranger-1', readOnly: false, objective: 'Write task' }),
    ];

    const result = await executeChildAgents(
      bundles,
      createCtx(),
      createOptions({ parentRole: 'planner', parentHarness: 'tool-dispatch' }),
    );

    expect(result.results).toEqual([]);
    expect(mockRunKodaX).not.toHaveBeenCalled();
  });

  it('allows write bundles from H2 Generator', async () => {
    const bundles = [
      createBundle({ id: 'cb-1', readOnly: false, objective: 'Refactor auth' }),
    ];

    mockRunKodaX.mockResolvedValueOnce({ success: true, lastText: 'Refactored', messages: [{ role: 'assistant', content: '' }], sessionId: 's1' });

    const result = await executeChildAgents(
      bundles,
      createCtx(),
      createOptions({ parentRole: 'generator', parentHarness: 'H2_PLAN_EXECUTE_EVAL' }),
    );

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.status).toBe('completed');
    expect(mockRunKodaX).toHaveBeenCalledTimes(1);
    // FEATURE_188 v0.7.42 — write child shares parent cwd/gitRoot (no
    // worktree); `KodaXChildExecutionResult.worktreePaths` field removed.
    expect((result as { worktreePaths?: unknown }).worktreePaths).toBeUndefined();
  });

  it('surfaces a failed result when the child crashes (no worktree cleanup needed post-FEATURE_188)', async () => {
    const bundles = [
      createBundle({ id: 'cb-1', readOnly: false, objective: 'Crash task' }),
    ];

    mockRunKodaX.mockRejectedValueOnce(new Error('Crash!'));

    const result = await executeChildAgents(
      bundles,
      createCtx(),
      createOptions({ parentRole: 'generator', parentHarness: 'H2_PLAN_EXECUTE_EVAL' }),
    );

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.status).toBe('failed');
  });

  /* ---------- Evidence resolution ---------- */

  it('passes resolved evidence refs to child briefing', async () => {
    const bundles = [
      createBundle({
        id: 'cb-1',
        objective: 'Investigate auth',
        evidenceRefs: ['finding:Token validation skips expiry check'],
      }),
    ];

    mockRunKodaX.mockResolvedValueOnce({
      success: true,
      lastText: 'Confirmed: expiry check missing',
      messages: [],
      sessionId: 's1',
    });

    await executeChildAgents(bundles, createCtx(), createOptions());

    // Verify the prompt passed to runKodaX contains the resolved finding
    const callArgs = mockRunKodaX.mock.calls[0]!;
    const prompt = callArgs[1] as string;
    expect(prompt).toContain('Token validation skips expiry check');
    expect(prompt).toContain('Known fact');
  });

  /* ---------- FEATURE_188 v0.7.42: peer-coordination briefing ---------- */

  it('write-child briefing includes the "Coordination with peers" section (FEATURE_188 ADR-034)', async () => {
    const bundles = [
      createBundle({ id: 'cb-coord-w', readOnly: false, objective: 'Refactor module X' }),
    ];

    mockRunKodaX.mockResolvedValueOnce({ success: true, lastText: 'Done', messages: [{ role: 'assistant', content: '' }], sessionId: 's-coord-w' });

    await executeChildAgents(
      bundles,
      createCtx(),
      createOptions({ parentRole: 'generator', parentHarness: 'H2_PLAN_EXECUTE_EVAL' }),
    );

    const briefing = mockRunKodaX.mock.calls[0]![1] as string;
    expect(briefing).toContain('## Coordination with peers');
    expect(briefing).toContain('STOP and report back to the coordinator');
    expect(briefing).toContain('parallel');
  });

  it('read-child briefing does NOT include the "Coordination with peers" section', async () => {
    const bundles = [
      createBundle({ id: 'cb-coord-r', readOnly: true, objective: 'Investigate module Y' }),
    ];

    mockRunKodaX.mockResolvedValueOnce({ success: true, lastText: 'Inspected', messages: [{ role: 'assistant', content: '' }], sessionId: 's-coord-r' });

    await executeChildAgents(
      bundles,
      createCtx(),
      createOptions({ parentRole: 'scout', parentHarness: 'H0_DIRECT' }),
    );

    const briefing = mockRunKodaX.mock.calls[0]![1] as string;
    expect(briefing).not.toContain('## Coordination with peers');
    expect(briefing).not.toContain('STOP and report back to the coordinator');
  });
});

/* ---------- FEATURE_117 v2: Write-child mutation context inject ---------- */

describe('FEATURE_117 v2 — write-child AGENTS.md inject', () => {
  let tmpRoot: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpRoot = mkdtempSync(join(tmpdir(), 'kodax-feat117-'));
    clearAgentsLoaderCacheForTesting();
  });

  afterEach(() => {
    clearAgentsLoaderCacheForTesting();
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  function createTmpCtx(gitRoot: string) {
    return {
      backups: new Map(),
      gitRoot,
      executionCwd: gitRoot,
    };
  }

  it('write child receives AGENTS.md mutation policy in systemPromptOverride', async () => {
    const sentinel = 'NEVER_USE_ANY_TYPE_FEAT117_SENTINEL';
    writeFileSync(
      join(tmpRoot, 'AGENTS.md'),
      `# Project Rules\n\n- ${sentinel}\n- All commits must be conventional.\n`,
    );

    mockRunKodaX.mockResolvedValueOnce({
      success: true,
      lastText: 'done',
      messages: [{ role: 'assistant', content: '' }],
      sessionId: 's1',
    });

    const bundles = [createBundle({ id: 'cb-w1', readOnly: false, objective: 'Refactor' })];

    await executeChildAgents(
      bundles,
      createTmpCtx(tmpRoot),
      createOptions({ parentRole: 'generator', parentHarness: 'H2_PLAN_EXECUTE_EVAL' }),
    );

    expect(mockRunKodaX).toHaveBeenCalledTimes(1);
    const opts = mockRunKodaX.mock.calls[0]![0] as {
      context: { systemPromptOverride: string };
    };
    expect(opts.context.systemPromptOverride).toContain(sentinel);
    // The framing line introducing project rules to the child.
    expect(opts.context.systemPromptOverride).toContain(
      'Project rules apply to your mutations',
    );
    // `formatAgentsForPrompt` always wraps with `# Project Context` H1.
    expect(opts.context.systemPromptOverride).toContain('# Project Context');
    // Base CHILD_AGENT_SYSTEM_PROMPT preserved as the leading block.
    expect(opts.context.systemPromptOverride.startsWith(CHILD_AGENT_SYSTEM_PROMPT)).toBe(true);
  });

  it('write child falls back to bare CHILD_AGENT_SYSTEM_PROMPT when no AGENTS.md exists', async () => {
    // tmpRoot has no AGENTS.md
    mockRunKodaX.mockResolvedValueOnce({
      success: true,
      lastText: 'done',
      messages: [{ role: 'assistant', content: '' }],
      sessionId: 's1',
    });

    const bundles = [createBundle({ id: 'cb-w2', readOnly: false, objective: 'Refactor' })];

    await executeChildAgents(
      bundles,
      createTmpCtx(tmpRoot),
      createOptions({ parentRole: 'generator', parentHarness: 'H2_PLAN_EXECUTE_EVAL' }),
    );

    expect(mockRunKodaX).toHaveBeenCalledTimes(1);
    const opts = mockRunKodaX.mock.calls[0]![0] as {
      context: { systemPromptOverride: string };
    };
    // Exact equality — no project-rules block when AGENTS.md is absent.
    expect(opts.context.systemPromptOverride).toBe(CHILD_AGENT_SYSTEM_PROMPT);
    expect(opts.context.systemPromptOverride).not.toContain('Project rules apply');
    expect(opts.context.systemPromptOverride).not.toContain('# Project Context');
  });

  it('read-only child does NOT receive AGENTS.md content (read path stays minimal)', async () => {
    writeFileSync(
      join(tmpRoot, 'AGENTS.md'),
      '# Project Rules\n\n- READONLY_LEAK_SENTINEL_FEAT117\n',
    );

    mockRunKodaX.mockResolvedValueOnce({
      success: true,
      lastText: 'inspected',
      messages: [{ role: 'assistant', content: '' }],
      sessionId: 's1',
    });

    const bundles = [createBundle({ id: 'cb-r1', readOnly: true, objective: 'Inspect' })];

    await executeChildAgents(
      bundles,
      createTmpCtx(tmpRoot),
      createOptions({ parentRole: 'scout', parentHarness: 'H0_DIRECT' }),
    );

    expect(mockRunKodaX).toHaveBeenCalledTimes(1);
    const opts = mockRunKodaX.mock.calls[0]![0] as {
      context: { systemPromptOverride: string };
    };
    expect(opts.context.systemPromptOverride).toBe(CHILD_AGENT_SYSTEM_PROMPT);
    expect(opts.context.systemPromptOverride).not.toContain('READONLY_LEAK_SENTINEL_FEAT117');
    expect(opts.context.systemPromptOverride).not.toContain('Project rules apply');
  });

  it('write child gracefully no-ops when parent gitRoot is undefined (non-git workspace)', async () => {
    // FEATURE_188 v0.7.42 — `buildWriteSystemPrompt` now falls back from
    // parent gitRoot → executionCwd → process.cwd() (no worktree path).
    // To exercise the "no project rules" path we point executionCwd at a
    // clean tmpdir that has no AGENTS.md, so the AGENTS.md walk finds
    // nothing and the bare CHILD_AGENT_SYSTEM_PROMPT surfaces.
    mockRunKodaX.mockResolvedValueOnce({
      success: true,
      lastText: 'done',
      messages: [{ role: 'assistant', content: '' }],
      sessionId: 's1',
    });

    const bundles = [createBundle({ id: 'cb-w-nogr', readOnly: false, objective: 'Refactor' })];

    await executeChildAgents(
      bundles,
      { backups: new Map(), gitRoot: undefined, executionCwd: tmpRoot } as unknown as Parameters<typeof executeChildAgents>[1],
      createOptions({ parentRole: 'generator', parentHarness: 'H2_PLAN_EXECUTE_EVAL' }),
    );

    expect(mockRunKodaX).toHaveBeenCalledTimes(1);
    const opts = mockRunKodaX.mock.calls[0]![0] as {
      context: { systemPromptOverride: string };
    };
    expect(opts.context.systemPromptOverride).toBe(CHILD_AGENT_SYSTEM_PROMPT);
  });

  it('write child resolves AGENTS.md from parent gitRoot (FEATURE_188 v0.7.42 — child shares parent cwd)', async () => {
    // Post-FEATURE_188 the child no longer runs inside a separate
    // worktree; it shares the parent's gitRoot directly. The AGENTS.md
    // lookup therefore walks the parent gitRoot, picking up the project
    // rules as expected.
    const sentinel = 'PARENT_GITROOT_AGENTS_SENTINEL';
    writeFileSync(
      join(tmpRoot, 'AGENTS.md'),
      `# Rules\n\n- ${sentinel}\n`,
    );

    mockRunKodaX.mockResolvedValueOnce({
      success: true,
      lastText: 'done',
      messages: [{ role: 'assistant', content: '' }],
      sessionId: 's1',
    });

    const bundles = [createBundle({ id: 'cb-w3', readOnly: false, objective: 'Refactor' })];
    await executeChildAgents(
      bundles,
      createTmpCtx(tmpRoot),
      createOptions({ parentRole: 'generator', parentHarness: 'H2_PLAN_EXECUTE_EVAL' }),
    );

    const opts = mockRunKodaX.mock.calls[0]![0] as {
      context: { systemPromptOverride: string };
    };
    expect(opts.context.systemPromptOverride).toContain(sentinel);
  });
});

/* ---------- FEATURE_074: Permission boundary tool exclusion ---------- */

describe('CHILD_EXCLUDE_TOOLS_BASE (FEATURE_074)', () => {
  it('excludes exit_plan_mode from child agent tool list', () => {
    expect(CHILD_EXCLUDE_TOOLS_BASE).toContain('exit_plan_mode');
  });

  it('still excludes the legacy parent-only tools (regression guard)', () => {
    expect(CHILD_EXCLUDE_TOOLS_BASE).toContain('emit_managed_protocol');
    expect(CHILD_EXCLUDE_TOOLS_BASE).toContain('dispatch_child_task');
    expect(CHILD_EXCLUDE_TOOLS_BASE).toContain('ask_user_question');
    expect(CHILD_EXCLUDE_TOOLS_BASE).toContain('worktree_create');
    expect(CHILD_EXCLUDE_TOOLS_BASE).toContain('worktree_remove');
  });

  it('passes the exclude list into runKodaX so the LLM never sees exit_plan_mode', async () => {
    const bundles = [createBundle({ id: 'cb-1', objective: 'Read-only check' })];

    mockRunKodaX.mockResolvedValueOnce({
      success: true,
      lastText: 'Done',
      messages: [{ role: 'assistant', content: '' }],
      sessionId: 's1',
    });

    await executeChildAgents(bundles, createCtx(), createOptions());

    const callArgs = mockRunKodaX.mock.calls[0]!;
    const opts = callArgs[0] as { context: { excludeTools: readonly string[] } };
    expect(opts.context.excludeTools).toContain('exit_plan_mode');
  });
});

/* ---------- FEATURE_074: Plan-mode propagation into child events ---------- */

describe('buildChildEvents plan-mode propagation (FEATURE_074)', () => {
  it('blocks tools when planModeBlockCheck returns a reason', async () => {
    const events = buildChildEvents(
      'cb-test',
      undefined,
      (tool) => (tool === 'edit' ? `[Blocked] ${tool} not allowed in plan mode.` : null),
    );
    const decision = await events!.beforeToolExecute!('edit', { path: '/x.ts' });
    expect(typeof decision).toBe('string');
    expect(decision).toContain('[Blocked]');
    expect(decision).toContain('child agent inheriting plan-mode constraints');
  });

  it('allows read-only tools when planModeBlockCheck returns null for them', async () => {
    const events = buildChildEvents(
      'cb-test',
      undefined,
      (tool) => (tool === 'edit' ? `[Blocked] ${tool} not allowed in plan mode.` : null),
    );
    const decision = await events!.beforeToolExecute!('read', { path: '/x.ts' });
    expect(decision).toBe(true);
  });

  it('skips the check entirely when planModeBlockCheck is undefined', async () => {
    const events = buildChildEvents('cb-test', undefined, undefined);
    const decision = await events!.beforeToolExecute!('edit', { path: '/x.ts' });
    expect(decision).toBe(true);
  });

  it('propagates live parent mode via closure — toggle reflected on next call', async () => {
    // Simulates the user flipping plan ↔ accept-edits mid-run.
    let parentMode: 'plan' | 'accept-edits' = 'plan';
    const liveCheck = vi.fn((tool: string) => {
      if (parentMode !== 'plan') return null;
      return tool === 'edit' ? '[Blocked] plan mode' : null;
    });
    const events = buildChildEvents('cb-test', undefined, liveCheck);
    // First call in plan mode — blocked.
    expect(typeof await events!.beforeToolExecute!('edit', { path: '/x.ts' })).toBe('string');
    // User toggles to accept-edits mid-run. No respawn.
    parentMode = 'accept-edits';
    // Next call — allowed, with zero re-configuration.
    expect(await events!.beforeToolExecute!('edit', { path: '/x.ts' })).toBe(true);
    expect(liveCheck).toHaveBeenCalledTimes(2);
  });

  it('CHILD_BLOCKED_TOOLS guard still fires before plan-mode check', async () => {
    const check = vi.fn(() => '[Blocked] should not be called');
    const events = buildChildEvents('cb-test', undefined, check);
    // dispatch_child_task is in CHILD_EXCLUDE_TOOLS_BASE / CHILD_BLOCKED_TOOLS
    const decision = await events!.beforeToolExecute!('dispatch_child_task', {});
    expect(typeof decision).toBe('string');
    expect(decision).toContain('Not available in child agent context');
    expect(check).not.toHaveBeenCalled();
  });
});

