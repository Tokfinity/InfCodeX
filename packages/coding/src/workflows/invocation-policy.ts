import type { KodaXAgentMode } from '../types.js';

export type WorkflowInvocationSource = 'natural-language' | 'command';
export type WorkflowInvocationAction = 'none' | 'suggest' | 'auto-start';
export type WorkflowInvocationTrigger = 'explicit' | 'complexity' | 'negated' | 'none';

export interface WorkflowInvocationPolicyInput {
  readonly agentMode: KodaXAgentMode;
  readonly source: WorkflowInvocationSource;
  readonly input: string;
}

export interface WorkflowInvocationPolicyDecision {
  readonly action: WorkflowInvocationAction;
  readonly trigger: WorkflowInvocationTrigger;
  readonly reason: string;
}

const NEGATED_WORKFLOW_PATTERNS: readonly RegExp[] = [
  /(?:不要|别|不用|不要使用|不使用|禁止)\s*(?:workflow|工作流|多\s*agent|多智能体)/iu,
  /\b(?:do not|don't|dont|without|no)\s+(?:use\s+)?(?:workflow|multi-agent|multi agent)\b/iu,
];

const EXPLICIT_WORKFLOW_PATTERNS: readonly RegExp[] = [
  /\bworkflow\b/iu,
  /工作流/u,
  /\bultracode\b/iu,
];

const COMPLEXITY_PATTERNS: readonly RegExp[] = [
  /(?:批量|大量|上百|几十|多份|多个|多角度|多视角|互相独立|竞争假设|竞品假设)/u,
  /(?:对抗|验证|反驳|评审团|锦标赛|排序|筛选|去重|循环|直到完成|深度研究|根因|triage)/iu,
  /\b(?:batch|many|multiple|parallel|fan[- ]?out|adversarial|verify|verification|tournament|rank|sort|loop until done|deep research|triage|root cause)\b/iu,
];

function matchesAny(input: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(input));
}

function decision(
  action: WorkflowInvocationAction,
  trigger: WorkflowInvocationTrigger,
  reason: string,
): WorkflowInvocationPolicyDecision {
  return { action, trigger, reason };
}

export function decideWorkflowInvocation(
  input: WorkflowInvocationPolicyInput,
): WorkflowInvocationPolicyDecision {
  const text = input.input.trim();
  if (!text) return decision('none', 'none', 'empty input');

  if (matchesAny(text, NEGATED_WORKFLOW_PATTERNS)) {
    return decision('none', 'negated', 'user explicitly rejected workflow or multi-agent execution');
  }

  const explicit = input.source === 'command' || matchesAny(text, EXPLICIT_WORKFLOW_PATTERNS);
  const complex = matchesAny(text, COMPLEXITY_PATTERNS);

  if (!explicit && !complex) {
    return decision('none', 'none', 'no workflow trigger detected');
  }

  if (input.agentMode === 'amaw') {
    return decision('auto-start', explicit ? 'explicit' : 'complexity', 'AMAW starts restricted generated workflows automatically');
  }

  if (input.source === 'command') {
    return decision('suggest', 'explicit', 'command requested workflow execution');
  }

  if (input.agentMode === 'ama') {
    return decision('suggest', explicit ? 'explicit' : 'complexity', 'AMA asks before starting workflow');
  }

  return decision('none', explicit ? 'explicit' : 'complexity', 'SA does not route natural-language prompts into workflow');
}
