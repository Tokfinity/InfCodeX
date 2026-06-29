import { describe, expect, it } from 'vitest';

import type { KodaXAgentMode } from '../types.js';
import {
  decideWorkflowInvocation,
  workflowStartOutcomeConsumesTurn,
} from './invocation-policy.js';

describe('decideWorkflowInvocation', () => {
  it('treats AMAW as a first-class agent mode', () => {
    const modes: readonly KodaXAgentMode[] = ['sa', 'ama', 'amaw'];
    expect(modes).toContain('amaw');
  });

  // FEATURE_246 A5 (ADR-047): natural language is NEVER intercepted by the host,
  // in any mode. AMA/AMAW Workers author workflows themselves through the
  // run_workflow tool (scout the codebase, then author from real findings); SA
  // has no workflow host. The old explicit/complexity/negation keyword gate was
  // removed with the auto-start path — that judgment now belongs to the Worker.
  it('never intercepts natural-language input — defers to the agent in every mode', () => {
    const modes: readonly KodaXAgentMode[] = ['sa', 'ama', 'amaw'];
    const inputs = [
      'please create a workflow to analyze this flaky test',
      'Please compare three independent competing hypotheses and verify each one.',
      'use a multi-agent fan-out workflow to audit this codebase',
      'do not use a workflow; just answer directly',
      'what does the workflow option do?',
      'verify this one file',
    ];
    for (const agentMode of modes) {
      for (const input of inputs) {
        expect(
          decideWorkflowInvocation({ agentMode, source: 'natural-language', input }),
          `${agentMode} :: ${input}`,
        ).toMatchObject({ action: 'none', trigger: 'none' });
      }
    }
  });

  it('suggests a workflow for an explicit /workflow command in every mode', () => {
    const modes: readonly KodaXAgentMode[] = ['sa', 'ama', 'amaw'];
    for (const agentMode of modes) {
      expect(
        decideWorkflowInvocation({
          agentMode,
          source: 'command',
          input: '/workflow create audit this feature',
        }),
        agentMode,
      ).toMatchObject({ action: 'suggest', trigger: 'explicit' });
    }
  });

  it('a host workflow policy never weakens explicit command routing', () => {
    // WorkflowHostPolicy still carries execution ceilings (maxAgents, etc.) but
    // those do not change the launch decision: a /workflow command always
    // suggests, regardless of policy.
    expect(
      decideWorkflowInvocation({
        agentMode: 'amaw',
        source: 'command',
        input: '/workflow create audit this feature',
        hostPolicy: { maxAgents: 4 },
      }),
    ).toMatchObject({ action: 'suggest', trigger: 'explicit' });
  });

  it('only consumes turns for started or cancelled workflow outcomes', () => {
    expect(workflowStartOutcomeConsumesTurn({ outcome: 'started' })).toBe(true);
    expect(workflowStartOutcomeConsumesTurn({ outcome: 'cancelled' })).toBe(true);
    expect(workflowStartOutcomeConsumesTurn({ outcome: 'failed' })).toBe(false);
    expect(workflowStartOutcomeConsumesTurn({ outcome: 'declined' })).toBe(false);
  });
});
