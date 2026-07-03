import { describe, expect, it } from 'vitest';

import type { WorkflowEvent } from './events.js';
import {
  createWorkflowProcessTracker,
  isFinalWorkflowProcessStatus,
  normalizeHostMetadata,
} from './process.js';

describe('workflow process tracker', () => {
  it('folds runtime events into a host-readable process snapshot', () => {
    const tracker = createWorkflowProcessTracker({
      runId: 'run-1',
      workflowName: 'feature-review',
      displayName: 'Feature review',
      source: 'command',
      hostMetadata: { sessionId: 'session-1', tag: 'coder' },
      phases: ['scan', 'synthesize'],
      maxAgents: 4,
      now: () => '2026-06-15T00:00:00.000Z',
    });

    const events: readonly WorkflowEvent[] = [
      { seq: 0, type: 'workflow_started', data: { runId: 'run-1' } },
      { seq: 1, type: 'phase_started', data: { name: 'scan' } },
      { seq: 2, type: 'agent_spawned', data: { taskId: 'child-1', name: 'reader' } },
      {
        seq: 3,
        type: 'agent_completed',
        data: {
          taskId: 'child-1',
          name: 'reader',
          status: 'completed',
          provider: 'anthropic',
          model: 'claude-sonnet-4-5',
          summary: 'Finding: process snapshots are reusable.',
          summaryKind: 'digest',
          usage: { inputTokens: 10, outputTokens: 15 },
        },
      },
      { seq: 4, type: 'phase_finished', data: { name: 'scan' } },
      { seq: 5, type: 'artifact_written', data: { name: 'report', path: 'artifacts/report.json' } },
      { seq: 6, type: 'workflow_completed' },
    ];

    for (const event of events) tracker.applyEvent(event);

    const snapshot = tracker.getSnapshot();
    expect(snapshot).toMatchObject({
      runId: 'run-1',
      workflowName: 'feature-review',
      displayName: 'Feature review',
      source: 'command',
      hostMetadata: { sessionId: 'session-1', tag: 'coder' },
      status: 'completed',
      phaseCount: 2,
      counts: {
        pending: 0,
        running: 0,
        completed: 3,
        failed: 0,
        cancelled: 0,
        skipped: 1,
      },
      progress: {
        spawnedAgents: 1,
        finishedAgents: 1,
        activeAgents: 0,
        failedAgents: 0,
        stoppedAgents: 0,
        agentCap: 4,
      },
      tokens: { spent: 25 },
    });
    expect(snapshot.items.find((item) => item.id === 'agent:child-1')).toMatchObject({
      title: 'reader',
      kind: 'agent',
      status: 'completed',
      summary: 'Finding: process snapshots are reusable.',
      summaryStatus: 'result',
      childAgentId: 'child-1',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    });
    expect(snapshot.artifacts).toEqual([{ name: 'report', path: 'artifacts/report.json' }]);
    expect(snapshot.activePhaseId).toBeUndefined();
    expect(snapshot.activePhaseIndex).toBeUndefined();
  });

  it('normalizes host metadata before exposing it in snapshots', () => {
    const longKey = 'k'.repeat(80);
    const longValue = 'v'.repeat(600);
    const manyEntries: Record<string, unknown> = Object.fromEntries(
      Array.from({ length: 18 }, (_, index) => [`k${index}`, `v${index}`]),
    );

    expect(normalizeHostMetadata(undefined)).toBeUndefined();
    expect(normalizeHostMetadata('metadata')).toBeUndefined();
    expect(normalizeHostMetadata({ ignored: 1 })).toBeUndefined();
    expect(Object.keys(normalizeHostMetadata(manyEntries) ?? {})).toEqual(
      Array.from({ length: 16 }, (_, index) => `k${index}`),
    );
    expect(normalizeHostMetadata({
      [longKey]: longValue,
      ok: 'yes',
      ignored: 1,
    })).toEqual({
      [longKey.slice(0, 64)]: longValue.slice(0, 512),
      ok: 'yes',
    });
  });

  it('maps stopped workflows to process cancellation and exposes terminal helper', () => {
    const tracker = createWorkflowProcessTracker({
      runId: 'run-stop',
      workflowName: 'stop-test',
      now: () => '2026-06-15T00:00:00.000Z',
    });

    tracker.applyEvent({ seq: 0, type: 'workflow_started' });
    tracker.applyEvent({ seq: 1, type: 'agent_spawned', data: { taskId: 'child-1', name: 'worker' } });
    tracker.applyEvent({ seq: 2, type: 'workflow_stopped' });

    const snapshot = tracker.getSnapshot();
    expect(snapshot.status).toBe('cancelled');
    expect(snapshot.items.find((item) => item.id === 'agent:child-1')?.status).toBe('cancelled');
    expect(isFinalWorkflowProcessStatus(snapshot.status)).toBe(true);
    expect(isFinalWorkflowProcessStatus('paused')).toBe(false);
  });

  it('groups agents by an explicit per-agent phase tag (FEATURE_246 Part E)', () => {
    const tracker = createWorkflowProcessTracker({
      runId: 'run-phase',
      workflowName: 'phase-test',
      now: () => '2026-06-15T00:00:00.000Z',
    });

    tracker.applyEvent({ seq: 0, type: 'workflow_started' });
    // No wf.phase() wrapper active; the tag itself creates + joins the group.
    tracker.applyEvent({ seq: 1, type: 'agent_spawned', data: { taskId: 'c1', name: 'find-a', phase: 'Find' } });
    tracker.applyEvent({ seq: 2, type: 'agent_spawned', data: { taskId: 'c2', name: 'find-b', phase: 'Find' } });
    tracker.applyEvent({ seq: 3, type: 'agent_spawned', data: { taskId: 'c3', name: 'verify-a', phase: 'Verify' } });

    const snapshot = tracker.getSnapshot();
    const phases = snapshot.items.filter((item) => item.kind === 'phase');
    expect(phases.map((p) => p.title)).toEqual(['Find', 'Verify']);
    // Both Find agents share the Find phase id; verify agent is under Verify.
    const findPhaseId = phases.find((p) => p.title === 'Find')!.id;
    const verifyPhaseId = phases.find((p) => p.title === 'Verify')!.id;
    expect(snapshot.items.find((i) => i.id === 'agent:c1')?.phaseId).toBe(findPhaseId);
    expect(snapshot.items.find((i) => i.id === 'agent:c2')?.phaseId).toBe(findPhaseId);
    expect(snapshot.items.find((i) => i.id === 'agent:c3')?.phaseId).toBe(verifyPhaseId);
    // The on-demand phase group is shown active once it has a running agent.
    expect(phases.find((p) => p.title === 'Find')?.status).toBe('running');
  });

  it('maps agent_failed events to failed agent items', () => {
    const tracker = createWorkflowProcessTracker({
      runId: 'run-agent-failed',
      workflowName: 'agent-failed-test',
      now: () => '2026-06-15T00:00:00.000Z',
    });

    tracker.applyEvent({ seq: 0, type: 'workflow_started' });
    tracker.applyEvent({ seq: 1, type: 'agent_spawned', data: { taskId: 'child-1', name: 'writer' } });
    tracker.applyEvent({
      seq: 2,
      type: 'agent_failed',
      data: {
        taskId: 'child-1',
        name: 'writer',
        status: 'failed',
        error: 'expected file mutations',
      },
    });

    const snapshot = tracker.getSnapshot();
    expect(snapshot.progress.failedAgents).toBe(1);
    expect(snapshot.items.find((item) => item.id === 'agent:child-1')).toMatchObject({
      status: 'failed',
      error: 'expected file mutations',
    });
  });

  it('maps agent_unverified events to completed agent items with a warning message', () => {
    const tracker = createWorkflowProcessTracker({
      runId: 'run-agent-unverified',
      workflowName: 'agent-unverified-test',
      now: () => '2026-06-15T00:00:00.000Z',
    });

    tracker.applyEvent({ seq: 0, type: 'workflow_started' });
    tracker.applyEvent({ seq: 1, type: 'agent_spawned', data: { taskId: 'child-1', name: 'writer' } });
    const event = tracker.applyEvent({
      seq: 2,
      type: 'agent_unverified',
      data: {
        taskId: 'child-1',
        name: 'writer',
        status: 'completed_unverified',
        summary: 'Finished without observed file mutations.',
      },
    });

    const snapshot = tracker.getSnapshot();
    expect(snapshot.progress.finishedAgents).toBe(1);
    expect(snapshot.progress.failedAgents).toBe(0);
    expect(event.message).toBe('agent completed without verification: writer');
    expect(snapshot.items.find((item) => item.id === 'agent:child-1')).toMatchObject({
      status: 'completed',
      summary: 'Finished without observed file mutations.',
    });
  });

  it('clears the active phase after phase completion', () => {
    const tracker = createWorkflowProcessTracker({
      runId: 'run-phase-gap',
      workflowName: 'phase-gap',
      phases: ['scan', 'synthesize'],
      now: () => '2026-06-15T00:00:00.000Z',
    });

    tracker.applyEvent({ seq: 0, type: 'workflow_started' });
    tracker.applyEvent({ seq: 1, type: 'phase_started', data: { name: 'scan' } });
    tracker.applyEvent({ seq: 2, type: 'phase_finished', data: { name: 'scan' } });

    const snapshot = tracker.getSnapshot();
    expect(snapshot.activePhaseId).toBeUndefined();
    expect(snapshot.activePhaseIndex).toBeUndefined();
    expect(snapshot.items.find((item) => item.id === 'phase:1')?.status).toBe('completed');
    expect(snapshot.items.find((item) => item.id === 'phase:2')?.status).toBe('pending');
  });

  it('lets late summaries update completed children without changing terminal status', () => {
    const tracker = createWorkflowProcessTracker({
      runId: 'run-late',
      workflowName: 'late-summary',
      now: () => '2026-06-15T00:00:00.000Z',
    });

    tracker.applyEvent({ seq: 0, type: 'workflow_started' });
    tracker.applyEvent({ seq: 1, type: 'agent_spawned', data: { taskId: 'child-1', name: 'worker' } });
    tracker.applyEvent({
      seq: 2,
      type: 'agent_completed',
      data: {
        taskId: 'child-1',
        name: 'worker',
        status: 'completed',
        summary: 'Local excerpt while digest runs.',
        summaryKind: 'pending',
      },
    });
    tracker.applyEvent({ seq: 3, type: 'workflow_completed' });

    const update = tracker.applyEvent({
      seq: 4,
      type: 'agent_summary_updated',
      data: {
        taskId: 'child-1',
        summary: 'Finding: the model-authored digest arrived later.',
        summaryKind: 'digest',
        usage: { totalTokens: 7 },
      },
    });

    expect(update.type).toBe('workflow_updated');
    const snapshot = tracker.getSnapshot();
    expect(snapshot.status).toBe('completed');
    expect(snapshot.tokens?.spent).toBe(7);
    expect(snapshot.items.find((item) => item.id === 'agent:child-1')).toMatchObject({
      status: 'completed',
      summary: 'Finding: the model-authored digest arrived later.',
      summaryStatus: 'result',
    });
  });

  it('folds workflow log events into latest process messages', () => {
    const tracker = createWorkflowProcessTracker({
      runId: 'run-log',
      workflowName: 'log-test',
      now: () => '2026-06-15T00:00:00.000Z',
    });

    tracker.applyEvent({ seq: 0, type: 'workflow_started' });
    const update = tracker.applyEvent({
      seq: 1,
      type: 'workflow_log',
      data: { message: 'checking generated workflow contract' },
    });

    expect(update).toMatchObject({
      type: 'workflow_updated',
      message: 'checking generated workflow contract',
    });
    expect(tracker.getSnapshot().latestMessage).toBe('checking generated workflow contract');
  });

  it('closes pending and running items when a host forces a terminal status', () => {
    const tracker = createWorkflowProcessTracker({
      runId: 'run-force-stop',
      workflowName: 'force-stop',
      phases: ['scan'],
      now: () => '2026-06-15T00:00:00.000Z',
    });

    tracker.applyEvent({ seq: 0, type: 'workflow_started' });
    tracker.applyEvent({ seq: 1, type: 'phase_started', data: { name: 'scan' } });
    tracker.applyEvent({ seq: 2, type: 'agent_spawned', data: { taskId: 'child-1', name: 'worker' } });
    const event = tracker.setStatus('cancelled', 'host stopped workflow');

    expect(event.type).toBe('workflow_finished');
    const snapshot = tracker.getSnapshot();
    expect(snapshot.status).toBe('cancelled');
    expect(snapshot.counts.running).toBe(0);
    expect(snapshot.activePhaseId).toBeUndefined();
    expect(snapshot.items.map((item) => item.status)).toEqual(['cancelled', 'cancelled']);
  });
});

describe('workflow process tracker — FEATURE_246 resume replay telemetry', () => {
  it('a fresh (non-resumed) run stamps no origin / replayedAgents / resumedFromRunId', () => {
    const tracker = createWorkflowProcessTracker({
      runId: 'run-fresh',
      workflowName: 'fresh',
      now: () => '2026-06-15T00:00:00.000Z',
    });
    tracker.applyEvent({ seq: 0, type: 'workflow_started' });
    tracker.applyEvent({ seq: 1, type: 'agent_spawned', data: { taskId: 'c1', name: 'worker' } });
    tracker.applyEvent({ seq: 2, type: 'agent_completed', data: { taskId: 'c1', name: 'worker', status: 'completed' } });

    const snapshot = tracker.getSnapshot();
    // Byte-identity guard: no resume fields appear on a fresh run.
    expect(snapshot.resumedFromRunId).toBeUndefined();
    expect(snapshot.progress.replayedAgents).toBeUndefined();
    expect(snapshot.items.find((i) => i.id === 'agent:c1')?.origin).toBeUndefined();
    expect(snapshot.progress.spawnedAgents).toBe(1);
  });

  it('a resumed run marks ran agents `ran`, replayed agents `replayed-from-cache`, and counts each side', () => {
    const tracker = createWorkflowProcessTracker({
      runId: 'run-resumed',
      workflowName: 'resumed',
      resumedFromRunId: 'run-prior',
      now: () => '2026-06-15T00:00:00.000Z',
    });
    tracker.applyEvent({ seq: 0, type: 'workflow_started' });
    // Two agents replay from the prior run's cache (no spawn/complete, just the replay event).
    tracker.applyEvent({ seq: 1, type: 'agent_replayed', data: { taskId: 'c1', name: 'reader-a' } });
    tracker.applyEvent({ seq: 2, type: 'agent_replayed', data: { taskId: 'c2', name: 'reader-b' } });
    // One agent actually re-runs live this turn.
    tracker.applyEvent({ seq: 3, type: 'agent_spawned', data: { taskId: 'c3', name: 'writer' } });
    tracker.applyEvent({ seq: 4, type: 'agent_completed', data: { taskId: 'c3', name: 'writer', status: 'completed' } });
    tracker.applyEvent({ seq: 5, type: 'workflow_completed' });

    const snapshot = tracker.getSnapshot();
    expect(snapshot.resumedFromRunId).toBe('run-prior');
    expect(snapshot.progress.replayedAgents).toBe(2);
    // spawnedAgents counts only the live-run agent, not the replayed ones.
    expect(snapshot.progress.spawnedAgents).toBe(1);
    expect(snapshot.progress.finishedAgents).toBe(1);

    const c1 = snapshot.items.find((i) => i.id === 'agent:replayed:c1');
    expect(c1).toMatchObject({ kind: 'agent', status: 'completed', origin: 'replayed-from-cache' });
    const c3 = snapshot.items.find((i) => i.id === 'agent:c3');
    expect(c3).toMatchObject({ kind: 'agent', status: 'completed', origin: 'ran' });
  });

  it('preserves a replayed agent phase grouping when the replay carries a phase tag', () => {
    const tracker = createWorkflowProcessTracker({
      runId: 'run-resumed-phase',
      workflowName: 'resumed-phase',
      resumedFromRunId: 'run-prior',
      now: () => '2026-06-15T00:00:00.000Z',
    });
    tracker.applyEvent({ seq: 0, type: 'workflow_started' });
    tracker.applyEvent({ seq: 1, type: 'agent_replayed', data: { taskId: 'c1', name: 'find-a', phase: 'Find' } });

    const snapshot = tracker.getSnapshot();
    const phase = snapshot.items.find((i) => i.kind === 'phase' && i.title === 'Find');
    const agent = snapshot.items.find((i) => i.id === 'agent:replayed:c1');
    expect(phase).toBeDefined();
    expect(agent?.phaseId).toBe(phase?.id);
    expect(agent?.origin).toBe('replayed-from-cache');
  });

  it('keeps a replayed agent distinct from a live spawn that reuses the same taskId (C1 collision guard)', () => {
    // The workflow backend mints taskIds from a per-run counter restarting at 1,
    // so a resumed run's first live spawn and a replayed prior-run agent can both
    // be "wf-child-1". They must remain TWO items, not merge into one.
    const tracker = createWorkflowProcessTracker({
      runId: 'run-collide',
      workflowName: 'collide',
      resumedFromRunId: 'run-prior',
      now: () => '2026-06-15T00:00:00.000Z',
    });
    tracker.applyEvent({ seq: 0, type: 'workflow_started' });
    // Replayed prior-run agent carries the prior run's taskId wf-child-1.
    tracker.applyEvent({ seq: 1, type: 'agent_replayed', data: { taskId: 'wf-child-1', name: 'cached-reader' } });
    // A live spawn in THIS run gets the same taskId from the reset counter.
    tracker.applyEvent({ seq: 2, type: 'agent_spawned', data: { taskId: 'wf-child-1', name: 'live-writer' } });
    tracker.applyEvent({ seq: 3, type: 'agent_completed', data: { taskId: 'wf-child-1', name: 'live-writer', status: 'completed' } });
    tracker.applyEvent({ seq: 4, type: 'workflow_completed' });

    const snapshot = tracker.getSnapshot();
    const replayed = snapshot.items.find((i) => i.id === 'agent:replayed:wf-child-1');
    const live = snapshot.items.find((i) => i.id === 'agent:wf-child-1');
    // Both survive as distinct items with correct origins.
    expect(replayed).toMatchObject({ origin: 'replayed-from-cache', status: 'completed', title: 'cached-reader' });
    expect(live).toMatchObject({ origin: 'ran', status: 'completed', title: 'live-writer' });
    // Counts are not corrupted: 1 replayed, 1 ran.
    expect(snapshot.progress.replayedAgents).toBe(1);
    expect(snapshot.progress.spawnedAgents).toBe(1);
    expect(snapshot.progress.finishedAgents).toBe(1);
  });
});
