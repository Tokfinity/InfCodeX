import type { KodaXAgentMode } from '../types.js';

export type WorkflowInvocationSource = 'natural-language' | 'command';
export type WorkflowInvocationAction = 'none' | 'suggest' | 'auto-start';
export type WorkflowInvocationTrigger = 'explicit' | 'complexity' | 'negated' | 'none';

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

const NEGATED_WORKFLOW_PATTERNS: readonly RegExp[] = [
  /\b(?:do not|don't|dont|without|avoid|skip|no)\s+(?:using\s+|use\s+)?(?:a\s+|an\s+|the\s+)?(?:workflow|workflows|multi[- ]?agent|multi agent)\b/iu,
  /(?:不要|别|不用|不要使用|不使用|禁止|避免|跳过)\s*(?:使用|用)?\s*(?:workflow|工作流|多\s*agent|多智能体)/iu,
];

const EXPLICIT_WORKFLOW_REQUEST_PATTERNS: readonly RegExp[] = [
  /\b(?:use|run|start|create|build|generate|make|launch|set\s+up|setup)\s+(?:a\s+|an\s+|the\s+)?(?:dynamic\s+|multi[- ]?agent\s+)?workflow\b/iu,
  /\bworkflow\s+(?:for|to)\b/iu,
  /(?:用|使用|建立|创建|新建|生成|启动|运行|跑|建)\s*(?:一个|这个|该)?\s*(?:workflow|工作流)/iu,
  /(?:workflow|工作流)\s*(?:来|去|用于|帮我|执行|运行)/iu,
];

const STRONG_COMPLEXITY_PATTERNS: readonly RegExp[] = [
  /\b(?:fan[- ]?out|multi[- ]?agent|parallel agents?|competing hypotheses|independent hypotheses)\b/iu,
  /(?:互相独立|竞争假设|竞品假设|并行|多\s*agent|多智能体)/iu,
];

const COMPLEXITY_SIGNAL_PATTERNS: readonly RegExp[] = [
  /\b(?:batch|many|multiple|several|three|3)\b/iu,
  /\b(?:compare|competing|independent|hypotheses|hypothesis)\b/iu,
  /\b(?:verify|verification|audit|review|rank|sort|dedupe|filter)\b/iu,
  /\b(?:loop until done|deep research|triage|root cause)\b/iu,
  /(?:批量|大量|多个|多份|几十|上百|三个|多角度|多视角)/iu,
  /(?:验证|审计|评审|排序|筛选|去重|循环|直到完成|深度研究|根因|排查)/iu,
];

function matchesAny(input: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(input));
}

function workflowComplexityScore(input: string): number {
  if (matchesAny(input, STRONG_COMPLEXITY_PATTERNS)) return 2;
  return COMPLEXITY_SIGNAL_PATTERNS.reduce(
    (score, pattern) => score + (pattern.test(input) ? 1 : 0),
    0,
  );
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

  const explicit =
    input.source === 'command' || matchesAny(text, EXPLICIT_WORKFLOW_REQUEST_PATTERNS);
  const complex = workflowComplexityScore(text) >= 2;

  if (!explicit && !complex) {
    return decision('none', 'none', 'no workflow trigger detected');
  }

  if (input.agentMode === 'amaw') {
    if (input.source === 'natural-language') {
      if (input.hostPolicy?.autoStart === 'off') {
        return decision('none', explicit ? 'explicit' : 'complexity', 'host policy disabled natural-language workflow auto-start');
      }
      if (input.hostPolicy?.autoStart === 'confirm') {
        return decision('suggest', explicit ? 'explicit' : 'complexity', 'host policy requires confirmation before workflow auto-start');
      }
    }
    return decision('auto-start', explicit ? 'explicit' : 'complexity', 'AMAW starts capability-generated workflows automatically');
  }

  if (input.source === 'command') {
    return decision('suggest', 'explicit', 'command requested workflow execution');
  }

  if (input.agentMode === 'ama') {
    return decision('suggest', explicit ? 'explicit' : 'complexity', 'AMA asks before starting workflow');
  }

  return decision('none', explicit ? 'explicit' : 'complexity', 'SA does not route natural-language prompts into workflow');
}
