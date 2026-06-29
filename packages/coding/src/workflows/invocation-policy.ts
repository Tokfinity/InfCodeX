import type { KodaXAgentMode } from '../types.js';

export type WorkflowInvocationSource = 'natural-language' | 'command';
export type WorkflowInvocationAction = 'none' | 'suggest';
export type WorkflowInvocationTrigger = 'explicit' | 'none';
export type WorkflowStartOutcome = 'started' | 'declined' | 'cancelled' | 'failed';

export interface WorkflowHostPolicy {
  readonly autoStart?: 'off' | 'confirm' | 'on';
  readonly maxAgents?: number;
  readonly maxConcurrency?: number;
  readonly tokenBudget?: number;
}

export interface WorkflowInvocationPolicyInput {
  readonly agentMode: KodaXAgentMode;
  readonly source: WorkflowInvocationSource;
  readonly input: string;
  readonly hostPolicy?: WorkflowHostPolicy;
}

export interface WorkflowInvocationPolicyDecision {
  readonly action: WorkflowInvocationAction;
  readonly trigger: WorkflowInvocationTrigger;
  readonly reason: string;
}

function decision(
  action: WorkflowInvocationAction,
  trigger: WorkflowInvocationTrigger,
  reason: string,
): WorkflowInvocationPolicyDecision {
  return { action, trigger, reason };
}

/**
 * Decide whether the REPL host should launch a workflow before the agent runs.
 *
 * FEATURE_246 A5 (ADR-047): the host only launches workflows for an explicit
 * `/workflow` command. Natural language is never intercepted — in AMA/AMAW the
 * Worker owns the decision through the `run_workflow` tool, which scouts the
 * codebase first and authors a script from real findings (file paths, the
 * actual sub-problems, a concrete outputSchema). A blind host-side generator
 * cannot investigate, so pre-empting NL here produced shallow, disjointed
 * workflows. SA has no workflow host, so NL there also defers to the agent.
 *
 * The earlier NL detection (explicit/complexity/negation regexes) existed only
 * to gate that removed auto-start path and was dropped with it: the regex
 * heuristic is exactly the kind of judgment the Worker now makes with full
 * context instead of a keyword match.
 */
export function decideWorkflowInvocation(
  input: WorkflowInvocationPolicyInput,
): WorkflowInvocationPolicyDecision {
  if (input.source === 'command') {
    return decision('suggest', 'explicit', 'command requested workflow execution');
  }
  return decision(
    'none',
    'none',
    'natural-language workflow authoring is delegated to the agent (run_workflow tool)',
  );
}

export function workflowStartOutcomeConsumesTurn(input: {
  readonly outcome: WorkflowStartOutcome;
}): boolean {
  return input.outcome === 'started' || input.outcome === 'cancelled';
}
