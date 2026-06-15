import { describe, expect, it } from 'vitest';

import type { WorkflowEvent } from './events.js';
import {
  createWorkflowProcessTracker,
  isFinalWorkflowProcessStatus,
} from './process.js';

describe('workflow process tracker', () => {
  it('folds runtime events into a host-readable process snapshot', () => {
    const tracker = createWorkflowProcessTracker({
      runId: 'run-1',
      workflowName: 'feature-review',
      displayName: 'Feature review',
      source: 'command',
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
      status: 'completed',
      activePhaseIndex: 1,
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
    });
    expect(snapshot.artifacts).toEqual([{ name: 'report', path: 'artifacts/report.json' }]);
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
    expect(snapshot.items.find((item) => item.id === 'agent:child-1')?.status).toBe('skipped');
    expect(isFinalWorkflowProcessStatus(snapshot.status)).toBe(true);
    expect(isFinalWorkflowProcessStatus('paused')).toBe(false);
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
    expect(snapshot.items.map((item) => item.status)).toEqual(['skipped', 'skipped']);
  });
});
