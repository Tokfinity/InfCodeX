import { describe, expect, it, vi } from 'vitest';

import type {
  AgentActorClient,
  KodaXToolExecutionContext,
  WorkflowToolHost,
  WorkflowToolHostResult,
} from '../types.js';
import { toolRunWorkflow } from './run-workflow.js';

function context(host?: WorkflowToolHost): KodaXToolExecutionContext {
  return {
    workflowHost: host,
    actorControl: { callerPath: '/root' } as AgentActorClient,
  } as KodaXToolExecutionContext;
}

function hostWith(
  startInline: WorkflowToolHost['startInline'],
): WorkflowToolHost {
  return {
    startInline,
    runInline: async (input): Promise<WorkflowToolHostResult> => {
      const started = await startInline(input);
      return started.kind === 'declined'
        ? { kind: 'declined', reason: started.reason }
        : started.done;
    },
  };
}

const validInput = {
  manifest: { name: 'review', description: 'Review', readOnly: true },
  source: 'async function run(wf, args) { return args; }',
};

describe('toolRunWorkflow', () => {
  it('fails closed when explicit Workflow capability is absent', async () => {
    await expect(toolRunWorkflow(validInput, context())).resolves.toContain('unavailable');
  });

  it('validates the inline source and manifest', async () => {
    const host = hostWith(vi.fn());
    await expect(toolRunWorkflow({ manifest: {} }, context(host))).resolves.toContain('non-empty');
    await expect(toolRunWorkflow({ source: 'run' }, context(host))).resolves.toContain('manifest');
  });

  it('returns the canonical Workflow Actor reference without awaiting completion', async () => {
    const never = new Promise<WorkflowToolHostResult>(() => {});
    const startInline = vi.fn(async () => ({
      kind: 'started' as const,
      runId: 'run-1',
      done: never,
    }));

    const result = await toolRunWorkflow(
      { ...validInput, args: { scope: 'src' }, resumeFromRunId: 'run-0' },
      context(hostWith(startInline)),
    );

    expect(result).toContain('workflow_path:/root/workflow:run-1');
    expect(result).toContain('agent_output("/root/workflow:run-1")');
    expect(result).toContain('interrupt_agent("/root/workflow:run-1")');
    expect(result).not.toContain('task_output');
    expect(startInline).toHaveBeenCalledWith(expect.objectContaining({
      args: { scope: 'src' },
      resumeFromRunId: 'run-0',
    }));
  });

  it('surfaces a host decline or startup failure', async () => {
    const declined = hostWith(async () => ({ kind: 'declined', reason: 'approval denied' }));
    await expect(toolRunWorkflow(validInput, context(declined))).resolves.toContain('approval denied');

    const failed = hostWith(async () => { throw new Error('invalid workflow'); });
    await expect(toolRunWorkflow(validInput, context(failed))).resolves.toContain('invalid workflow');
  });
});
