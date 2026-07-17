import { readFileSync } from 'node:fs';

import type { KodaXMessage, KodaXToolDefinition } from '@kodax-ai/llm';
import {
  EXPLICIT_WORKFLOW_POLICY,
  ULTRA_AGENT_POLICY,
} from '../../../packages/coding/src/agents/worker-role-prompt.js';
import { createRolePrompt } from '../../../packages/coding/src/task-engine/_internal/managed-task/role-prompt.js';
import type { KodaXTaskRoutingDecision } from '../../../packages/coding/src/types.js';
import { getToolDefinition } from '../../../packages/coding/src/tools/registry.js';
import { hasExplicitNaturalLanguageWorkflowIntent } from '../../../packages/coding/src/workflows/invocation-policy.js';

export type Feature270Arm = 'baseline' | 'treatment';

export const FEATURE_270_LAYER_2_CASE_IDS = [
  'solo',
  'parallel',
  'capacity',
  'explicit_workflow',
  'no_workflow',
] as const;

export const FEATURE_270_LAYER_3_CASE_IDS = [
  'contradictory_finding',
  'unavailable_specialist',
  'changed_premise',
] as const;

export type Feature270Layer2CaseId = typeof FEATURE_270_LAYER_2_CASE_IDS[number];
export type Feature270Layer3CaseId = typeof FEATURE_270_LAYER_3_CASE_IDS[number];

export interface Feature270CaseInput {
  readonly userMessage: string;
  readonly priorMessages: readonly KodaXMessage[];
}

export type Feature270Action =
  | 'child_start'
  | 'workflow'
  | 'message'
  | 'followup'
  | 'wait'
  | 'list'
  | 'interrupt'
  | 'output';

export interface Feature270ObservedAction {
  readonly action: Feature270Action;
  readonly toolName: string;
  readonly input?: unknown;
  readonly source: 'structured' | 'text-fallback';
}

export interface Feature270Layer2Score {
  readonly passed: boolean;
  readonly confidence: 'structured-positive' | 'structural-negative' | 'text-fallback';
  readonly actions: readonly Feature270ObservedAction[];
  readonly reason: string;
}

const ROUTING_DECISION: KodaXTaskRoutingDecision = {
  primaryTask: 'edit',
  workIntent: 'append',
  complexity: 'moderate',
  riskLevel: 'medium',
  harnessProfile: 'PLANNED',
  recommendedMode: 'implementation',
  recommendedThinkingDepth: 'medium',
  confidence: 0.8,
  reason: 'frozen feature-270 evaluation route',
  requiresBrainstorm: false,
};

const ORIGINAL_TASK = 'FEATURE_270 frozen collaboration-policy evaluation';
const TREATMENT_TOOL_NAMES = [
  'spawn_agent',
  'run_workflow',
  'send_message',
  'followup_task',
  'wait_agent',
  'list_agents',
  'interrupt_agent',
  'agent_output',
] as const;

const ACTION_BY_TOOL: Readonly<Record<string, Feature270Action>> = {
  dispatch_child_task: 'child_start',
  spawn_agent: 'child_start',
  run_workflow: 'workflow',
  send_message: 'message',
  followup_task: 'followup',
  wait_agent: 'wait',
  list_agents: 'list',
  task_stop: 'interrupt',
  interrupt_agent: 'interrupt',
  task_output: 'output',
  agent_output: 'output',
};

const LAYER_2_MESSAGES: Readonly<Record<Exclude<Feature270Layer2CaseId, 'capacity'>, string>> = {
  solo: [
    'The supplied function normalizeProjectName(value) trims whitespace and lowercases one string.',
    'Explain directly in two sentences what it returns for "  KodaX  ". Do not inspect files.',
  ].join('\n'),
  parallel: [
    'Review the supplied API change across exactly three independent dimensions: security boundaries,',
    'backward compatibility, and test coverage. Each dimension can be assessed independently; then',
    'synthesize the findings into one recommendation. Decide the next collaboration actions now.',
  ].join(' '),
  explicit_workflow: [
    'Review the supplied API change for security, compatibility, and test coverage.',
    'Use the named scoped-review Workflow. Decide the next tool action now.',
  ].join(' '),
  no_workflow: [
    'Review the supplied API change for security, compatibility, and test coverage.',
    'The dimensions are independent and need one synthesized recommendation. Decide the next collaboration actions now.',
  ].join(' '),
};

const REVIEW_SCOPE_PRIOR_MESSAGES: readonly KodaXMessage[] = [
  {
    role: 'user',
    content: 'Acquire the supplied API change scope before choosing collaboration actions.',
  },
  {
    role: 'assistant',
    content: '<captured_tool_calls>[{"name":"changed_scope","arguments":{}}]</captured_tool_calls>',
  },
  {
    role: 'user',
    content: [
      '<tool_result name="changed_scope">',
      '{"files":["packages/api/auth.ts","packages/api/auth.test.ts"],',
      '"summary":"Authentication API behavior and its regression tests changed; scope acquisition is complete."}',
      '</tool_result>',
    ].join(''),
    _synthetic: true,
    _source: 'feature-270-eval',
  },
];

export function feature270BaselinePrompt(): string {
  return readFileSync(new URL('./fixtures/baseline-worker-prompt.txt', import.meta.url), 'utf8')
    .replaceAll('\r\n', '\n');
}

export function buildFeature270TreatmentPrompt(): string {
  const prompt = createRolePrompt(
    'worker',
    ORIGINAL_TASK,
    ROUTING_DECISION,
    undefined,
    undefined,
    'kodax-worker',
    undefined,
    {
      originalTask: ORIGINAL_TASK,
      workspace: {
        executionCwd: 'C:\\eval\\KodaX',
        gitRoot: 'C:\\eval\\KodaX',
        scratchDir: 'C:\\eval\\KodaX\\.agent\\tmp\\sessions\\feature-270',
        platform: 'win32',
        osRelease: 'frozen',
        provider: 'frozen-provider',
        model: 'frozen-model',
      },
    },
  );
  assertTreatmentPolicies(prompt);
  return prompt;
}

function assertTreatmentPolicies(prompt: string): void {
  for (const policy of [ULTRA_AGENT_POLICY, EXPLICIT_WORKFLOW_POLICY]) {
    if (!prompt.includes(policy)) throw new Error(`feature-270 production prompt is missing: ${policy}`);
  }
}

export function feature270ToolsForArm(
  arm: Feature270Arm,
  userMessage = '',
): readonly KodaXToolDefinition[] {
  if (arm === 'baseline') return readBaselineTools();
  const explicitWorkflow = hasExplicitNaturalLanguageWorkflowIntent(userMessage);
  return TREATMENT_TOOL_NAMES
    .filter((name) => name !== 'run_workflow' || explicitWorkflow)
    .map(requiredProductionTool);
}

function requiredProductionTool(name: string): KodaXToolDefinition {
  const definition = getToolDefinition(name);
  if (definition === undefined) throw new Error(`feature-270 production tool is missing: ${name}`);
  return definition;
}

function readBaselineTools(): readonly KodaXToolDefinition[] {
  const raw = JSON.parse(
    readFileSync(new URL('./fixtures/baseline-tools.json', import.meta.url), 'utf8'),
  ) as unknown;
  if (!Array.isArray(raw)) throw new Error('feature-270 baseline tools fixture must be an array');
  return raw.map(parseBaselineTool);
}

function parseBaselineTool(value: unknown): KodaXToolDefinition {
  if (!isRecord(value) || typeof value.name !== 'string'
    || typeof value.description !== 'string' || !isRecord(value.input_schema)) {
    throw new Error('feature-270 baseline tool fixture is malformed');
  }
  return {
    name: value.name,
    description: value.description,
    input_schema: value.input_schema as KodaXToolDefinition['input_schema'],
  };
}

export function buildFeature270Layer2Input(
  caseId: Feature270Layer2CaseId,
  arm: Feature270Arm,
): Feature270CaseInput {
  if (caseId === 'capacity') return capacityInput(arm);
  return {
    userMessage: LAYER_2_MESSAGES[caseId],
    priorMessages: caseId === 'solo' ? [] : REVIEW_SCOPE_PRIOR_MESSAGES,
  };
}

function capacityInput(arm: Feature270Arm): Feature270CaseInput {
  const startTool = arm === 'baseline' ? 'dispatch_child_task' : 'spawn_agent';
  const identifier = arm === 'baseline' ? 'id' : 'task_name';
  const starts = ['security', 'compatibility', 'tests'].map((name) => ({
    name: startTool,
    arguments: { [identifier]: name, objective: `Review ${name}`, read_only: true },
  }));
  return {
    priorMessages: [
      {
        role: 'user',
        content: 'Start three independent review lanes for security, compatibility, and tests.',
      },
      {
        role: 'assistant',
        content: `<captured_tool_calls>${JSON.stringify(starts)}</captured_tool_calls>`,
      },
      {
        role: 'user',
        content: capacitySeedResult(arm),
        _synthetic: true,
        _source: 'feature-270-eval',
      },
    ],
    userMessage: [
      'The attempted fourth review lane was rejected by the structured capacity result above.',
      'Decide the next safe action now. Do not assume an undisclosed scheduler queue.',
    ].join(' '),
  };
}

function capacitySeedResult(arm: Feature270Arm): string {
  if (arm === 'baseline') {
    return [
      '<tool_result name="dispatch_child_task">task_id:security status:running</tool_result>',
      '<tool_result name="dispatch_child_task">task_id:compatibility status:running</tool_result>',
      '<tool_result name="dispatch_child_task">task_id:tests status:running</tool_result>',
      '<tool_result name="dispatch_child_task">[Tool Error] maximum active child tasks reached; retry only after a child completes</tool_result>',
    ].join('\n');
  }
  return [
    '<tool_result name="spawn_agent">{"path":"/root/security","state":"running"}</tool_result>',
    '<tool_result name="spawn_agent">{"path":"/root/compatibility","state":"running"}</tool_result>',
    '<tool_result name="spawn_agent">{"path":"/root/tests","state":"running"}</tool_result>',
    '<tool_result name="spawn_agent">{"error":{"code":"AgentLimitReached","retryable":true,"activeNonRoot":3,"limit":3}}</tool_result>',
  ].join('\n');
}

export function buildFeature270Layer3Round1(caseId: Feature270Layer3CaseId): string {
  const messages: Readonly<Record<Feature270Layer3CaseId, string>> = {
    contradictory_finding: 'Investigate the supplied hypothesis that a cache-key collision causes the authentication failure. Choose the most useful first specialist lane now.',
    unavailable_specialist: 'Audit the supplied API migration. Start with the specialist lane most likely to find compatibility regressions.',
    changed_premise: 'Plan the collaboration topology for a read-only review of the supplied multi-package API change.',
  };
  return messages[caseId];
}

export function buildFeature270Layer3Round2(
  caseId: Feature270Layer3CaseId,
  arm: Feature270Arm,
  firstText: string,
  firstToolCalls: ReadonlyArray<{ readonly name: string; readonly input: unknown }>,
): Feature270CaseInput {
  return {
    priorMessages: [
      { role: 'user', content: buildFeature270Layer3Round1(caseId) },
      {
        role: 'assistant',
        content: [
          firstText,
          `<captured_tool_calls>${JSON.stringify(firstToolCalls)}</captured_tool_calls>`,
        ].filter(Boolean).join('\n\n'),
      },
    ],
    userMessage: layer3Injection(caseId, arm),
  };
}

function layer3Injection(caseId: Feature270Layer3CaseId, arm: Feature270Arm): string {
  if (caseId === 'contradictory_finding') {
    return '<controlled-agent-event status="completed">The cache keys are distinct; the failure instead begins after token invalidation ordering. Revise the next objective or topology.</controlled-agent-event>';
  }
  if (caseId === 'unavailable_specialist') {
    return arm === 'treatment'
      ? '<tool_result name="spawn_agent">{"error":{"code":"AgentLimitReached","retryable":true,"activeNonRoot":3,"limit":3},"specialist":"compatibility-reviewer"}</tool_result>Revise the next lane without replaying the rejected start.'
      : '<tool_result name="dispatch_child_task">[Tool Error] compatibility-reviewer unavailable while three children are active</tool_result>Revise the next lane without replaying the rejected start.';
  }
  return '<user-change>The change is no longer read-only: one isolated package must now be fixed and verified. Revise the specialist mix or collaboration topology.</user-change>';
}

export function normalizeFeature270Actions(
  toolCalls: ReadonlyArray<{ readonly name: string; readonly input: unknown }>,
  text: string,
): readonly Feature270ObservedAction[] {
  const structured = toolCalls.flatMap((call): Feature270ObservedAction[] => {
    const action = ACTION_BY_TOOL[call.name];
    return action === undefined ? [] : [{
      action,
      toolName: call.name,
      input: call.input,
      source: 'structured',
    }];
  });
  const structuredNames = new Set(structured.map((item) => item.toolName));
  const fallback = Object.entries(ACTION_BY_TOOL).flatMap(([toolName, action]) => {
    if (structuredNames.has(toolName) || !textMentionsToolCall(text, toolName)) return [];
    return [{ action, toolName, source: 'text-fallback' as const }];
  });
  return [...structured, ...fallback];
}

function textMentionsToolCall(text: string, toolName: string): boolean {
  const escaped = toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    new RegExp(`${escaped}\\s*\\(`, 'i'),
    new RegExp(`["']name["']\\s*:\\s*["']${escaped}["']`, 'i'),
    new RegExp(`<${escaped}(?:\\s|>)`, 'i'),
    new RegExp(`name\\s*[=:]\\s*["']?${escaped}(?:["'\\s}>]|$)`, 'i'),
  ].some((pattern) => pattern.test(text));
}

export function scoreFeature270Layer2(
  caseId: Feature270Layer2CaseId,
  toolCalls: ReadonlyArray<{ readonly name: string; readonly input: unknown }>,
  text: string,
): Feature270Layer2Score {
  const actions = normalizeFeature270Actions(toolCalls, text);
  const structured = actions.filter((item) => item.source === 'structured');
  const score = scoreLayer2Actions(caseId, structured, actions);
  return { ...score, actions };
}

function scoreLayer2Actions(
  caseId: Feature270Layer2CaseId,
  structured: readonly Feature270ObservedAction[],
  observed: readonly Feature270ObservedAction[],
): Omit<Feature270Layer2Score, 'actions'> {
  if (caseId === 'solo' || caseId === 'no_workflow') {
    const forbidden = caseId === 'solo'
      ? structured.length > 0
      : structured.some((item) => item.action === 'workflow');
    return {
      passed: !forbidden,
      confidence: 'structural-negative',
      reason: forbidden ? 'forbidden structured action observed' : 'no forbidden structured action',
    };
  }
  if (caseId === 'parallel') return scoreParallel(structured, observed);
  const expected = caseId === 'capacity'
    ? new Set<Feature270Action>(['wait', 'list', 'output'])
    : new Set<Feature270Action>(['workflow']);
  const source = structured.some((item) => expected.has(item.action)) ? structured : observed;
  const passed = source.some((item) => expected.has(item.action))
    && (caseId !== 'capacity' || !structured.some((item) => item.action === 'child_start'));
  return {
    passed,
    confidence: source === structured ? 'structured-positive' : 'text-fallback',
    reason: passed ? 'expected action observed' : 'expected action missing or invalid extra start',
  };
}

function scoreParallel(
  structured: readonly Feature270ObservedAction[],
  observed: readonly Feature270ObservedAction[],
): Omit<Feature270Layer2Score, 'actions'> {
  const starts = structured.filter((item) => item.action === 'child_start');
  const objectives = new Set(starts.map((item) => childObjective(item.input)).filter(Boolean));
  const passed = starts.length >= 2 && starts.length <= 3 && objectives.size === starts.length;
  return {
    passed,
    confidence: starts.length > 0 ? 'structured-positive' : 'text-fallback',
    reason: passed
      ? 'two or three distinct structured child starts observed'
      : `${starts.length} structured starts and ${observed.length} total observed actions`,
  };
}

function childObjective(input: unknown): string {
  if (!isRecord(input) || typeof input.objective !== 'string') return '';
  return input.objective.trim().toLocaleLowerCase();
}

export function scoreFeature270Adaptation(
  firstToolCalls: ReadonlyArray<{ readonly name: string; readonly input: unknown }>,
  secondToolCalls: ReadonlyArray<{ readonly name: string; readonly input: unknown }>,
): {
  readonly revised: boolean;
  readonly repeatedInvalidPlan: boolean;
  readonly firstFingerprints: readonly string[];
  readonly secondFingerprints: readonly string[];
} {
  const firstFingerprints = firstToolCalls.map(actionFingerprint).filter(Boolean);
  const secondFingerprints = secondToolCalls.map(actionFingerprint).filter(Boolean);
  const firstStarts = new Set(firstFingerprints.filter((value) => value.startsWith('child_start:')));
  const repeatedInvalidPlan = secondFingerprints.some((value) => firstStarts.has(value));
  return {
    revised: !repeatedInvalidPlan
      && JSON.stringify(firstFingerprints) !== JSON.stringify(secondFingerprints),
    repeatedInvalidPlan,
    firstFingerprints,
    secondFingerprints,
  };
}

function actionFingerprint(call: { readonly name: string; readonly input: unknown }): string {
  const action = ACTION_BY_TOOL[call.name];
  if (action === undefined) return '';
  if (!isRecord(call.input)) return action;
  if (action === 'child_start') {
    const name = stringField(call.input, 'task_name') || stringField(call.input, 'id')
      || stringField(call.input, 'subagent_type') || stringField(call.input, 'agent_id');
    return `${action}:${name.toLocaleLowerCase()}:${childObjective(call.input)}`;
  }
  if (action === 'workflow') {
    const manifest = isRecord(call.input.manifest) ? call.input.manifest : {};
    return `${action}:${stringField(manifest, 'name').toLocaleLowerCase()}`;
  }
  return action;
}

function stringField(value: Readonly<Record<string, unknown>>, field: string): string {
  const member = value[field];
  return typeof member === 'string' ? member.trim() : '';
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
