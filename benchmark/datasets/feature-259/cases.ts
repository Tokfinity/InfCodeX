import ts from 'typescript';

import type { KodaXMessage, KodaXToolDefinition } from '@kodax-ai/llm';
import {
  buildWorkerInstructions,
  orchestrationDefault,
} from '../../../packages/coding/src/agents/worker-role-prompt.js';
import type { KodaXTaskRoutingDecision } from '../../../packages/coding/src/types.js';
import { DEFERRED_TOOL_HINTS } from '../../../packages/coding/src/tools/deferred-tools.js';
import { getToolDefinition } from '../../../packages/coding/src/tools/registry.js';
import {
  buildWorkflowGenerationUserPrompt,
  WORKFLOW_GENERATION_SYSTEM_PROMPT,
} from '../../../packages/coding/src/workflows/generator.js';
import type { PromptVariant } from '../../harness/harness.js';
import type { JudgeContext, PromptJudge } from '../../harness/judges.js';

const ROUTING_DECISION: KodaXTaskRoutingDecision = {
  primaryTask: 'edit',
  workIntent: 'append',
  complexity: 'moderate',
  riskLevel: 'medium',
  harnessProfile: 'PLANNED',
  recommendedMode: 'implementation',
  recommendedThinkingDepth: 'medium',
  confidence: 0.7,
  reason: 'frozen feature-259 eval route',
  requiresBrainstorm: false,
};

const BASELINE_WORKER_REPLACEMENTS = [
  ['PLAN-FIRST CONTRACT:', 'PLAN-FIRST CONTRACT (FEATURE_114 v0.7.36 + FEATURE_170 v0.7.41 + v0.7.42 schema split):'],
  ['- Plan item schema:', '- Plan item schema (v0.7.42, mirrors claudecode V2 `TaskCreate`):'],
  ['PLAN-LIST HYGIENE (staleness + dedup):', 'PLAN-LIST HYGIENE (v0.7.42 — staleness + dedup):'],
  ['SCOPE COMMITMENT:', 'SCOPE COMMITMENT (FEATURE_106 hard rule + FEATURE_170 v0.7.41 + v0.7.42):'],
  ['DISPATCH RULES (`dispatch_child_task` idle-yield model):', 'DISPATCH RULES (`dispatch_child_task` — idle-yield model, FEATURE_155 v0.7.39):'],
  ['- LARGE CHILD OUTPUT:', '- LARGE CHILD OUTPUT (FEATURE_121 v0.7.40):'],
  [
    '- MODEL HINT: set `model_hint` intentionally — `"fast"` only for evaluated read-only mechanical lookups, `"balanced"` for ordinary implementation/investigation, and `"deep"` for architecture, adversarial verification, severity calibration, or final synthesis. Configured `fast`/`deep` tiers select their operator-mapped route;',
    '- MODEL HINT (FEATURE_259): set `model_hint` intentionally — `"fast"` only for evaluated read-only mechanical lookups, `"balanced"` for ordinary implementation/investigation, and `"deep"` for architecture, adversarial verification, severity calibration, or final synthesis. Configured `fast`/`deep` tiers route through FEATURE_102;',
  ],
  ['ASYNC CHILD STEERING (`send_message` + `task_stop`):', 'ASYNC CHILD STEERING (FEATURE_120 + FEATURE_123 — `send_message` + `task_stop`):'],
  ['REPO INTELLIGENCE TOOLS (prefer these over read+grep for module-level exploration):', 'REPO INTELLIGENCE TOOLS (FEATURE_161 v0.7.41 — prefer these over read+grep for module-level exploration):'],
  ['CHANGE-REVIEW POSITIVE REFRAME:', 'CHANGE-REVIEW POSITIVE REFRAME (FEATURE_169 v0.7.40 — review-specific):'],
] as const;

function replaceRequired(source: string, current: string, baseline: string): string {
  if (!source.includes(current)) {
    throw new Error(`feature-259 baseline reconstruction missed: ${current.slice(0, 80)}`);
  }
  return source.replace(current, baseline);
}

export function buildProposedWorkerPrompt(): string {
  return `${orchestrationDefault}\n\n${buildWorkerInstructions(ROUTING_DECISION, undefined, false)}`;
}

export function buildBaselineWorkerPrompt(): string {
  return BASELINE_WORKER_REPLACEMENTS.reduce(
    (prompt, [current, baseline]) => replaceRequired(prompt, current, baseline),
    buildProposedWorkerPrompt(),
  );
}

export function buildBaselineGenerationPrompt(request: string): string {
  let prompt = buildWorkflowGenerationUserPrompt(request);
  prompt = prompt
    .replaceAll(', terseResult', '')
    .replace('- wf.workflow(name, args) for one built-in or saved nested workflow; prefer wf.workflow("scoped-review", args) for immutable review packets.\n', '')
    .replace(/- Every generated wf\.runAgent[\s\S]+?judgment-critical review\.\n/, '')
    .replace(/- Set terseResult:true[\s\S]+?digest fallback remains\.\n/, '')
    .replace(', modelHint: "balanced"', '')
    .replace(', modelHint: "deep", outputSchema: schema, terseResult: true', ', outputSchema: schema')
    .replace('    modelHint: "balanced",\n', '');
  return prompt;
}

function tool(name: string): KodaXToolDefinition {
  const definition = getToolDefinition(name);
  if (!definition) throw new Error(`missing production tool definition: ${name}`);
  return definition;
}

function workflowTool(description: string): KodaXToolDefinition {
  return { ...tool('run_workflow'), description };
}

const SHARED_WORKER_TOOLS = ['dispatch_child_task', 'tool_search', 'todo_create', 'todo_update']
  .map(tool);

export const BASELINE_RUN_WORKFLOW_DESCRIPTION = tool('run_workflow').description;
export const PROPOSED_RUN_WORKFLOW_DESCRIPTION = DEFERRED_TOOL_HINTS.run_workflow ?? '';

function parseGeneration(text: string): { readonly source: string } | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { readonly source?: unknown };
    return typeof parsed.source === 'string' ? { source: parsed.source } : undefined;
  } catch {
    return undefined;
  }
}

function agentCalls(source: string): readonly ts.CallExpression[] {
  const file = ts.createSourceFile('generated-workflow.js', source, ts.ScriptTarget.ESNext, true);
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const owner = node.expression.expression.getText(file);
      const name = node.expression.name.text;
      if (owner === 'wf' && (name === 'runAgent' || name === 'spawnAgent')) calls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return calls;
}

function objectPropertyNames(call: ts.CallExpression): ReadonlySet<string> {
  const input = call.arguments[0];
  if (!input || !ts.isObjectLiteralExpression(input)) return new Set();
  return new Set(input.properties.flatMap((property) => {
    if (!('name' in property) || property.name === undefined) return [];
    if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) return [property.name.text];
    return [];
  }));
}

function generatedSourceJudge(
  name: string,
  check: (source: string) => { readonly passed: boolean; readonly reason?: string },
): PromptJudge {
  return {
    name,
    category: 'correctness',
    judge(output: string) {
      const generated = parseGeneration(output);
      if (!generated) return { passed: false, reason: 'output is not generation JSON with source' };
      return check(generated.source);
    },
  };
}

const GENERATION_REQUESTS = {
  'explicit-tier-intent': 'Create a workflow with a mechanical read-only inventory child, an ordinary implementation child, and a final architecture verifier. Use the appropriate portable model tier for every child.',
  'judgment-refuses-fast': 'Create a read-only workflow that reviews an authentication boundary, calibrates severity adversarially, and writes the final synthesis. This is judgment-critical review work.',
  'focused-briefing': 'Create a workflow to review three immutable packets independently, then synthesize: .agent/tmp/sessions/feature-259/auth.md, api.md, and tests.md. Each child must read its assigned evidence, receive a one-line scope and binding constraints, and return structured findings without copying packet bodies into prompts.',
  'terse-structured-review': 'Create a reviewer workflow whose child returns JSON with a required top-level summary string. The reviewer must answer directly without process narration so its concise result can be reused.',
  'requirements-not-verifiable': 'Create a scoped review workflow for a packet that intentionally contains no binding requirements. The reviewer output must include specVerdict and report not-verifiable rather than approving specification compliance.',
} as const;

function generationVariants(request: string): readonly PromptVariant[] {
  return [
    {
      id: 'baseline',
      systemPrompt: WORKFLOW_GENERATION_SYSTEM_PROMPT,
      userMessage: buildBaselineGenerationPrompt(request),
    },
    {
      id: 'proposed',
      systemPrompt: WORKFLOW_GENERATION_SYSTEM_PROMPT,
      userMessage: buildWorkflowGenerationUserPrompt(request),
    },
  ];
}

const WORKFLOW_SELECTION_HISTORY: readonly KodaXMessage[] = [
  { role: 'user', content: 'Audit packages/agent, packages/coding, and packages/repl independently, cross-check findings, then synthesize one report.' },
  { role: 'assistant', content: 'I committed the scope-oriented audit plan. The next action is to launch its bounded execution.' },
];

export interface Feature259Layer2Case {
  readonly id: string;
  readonly contract: string;
  readonly variants: readonly PromptVariant[];
  readonly judges: readonly PromptJudge[];
}

export function buildFeature259Layer2Cases(): readonly Feature259Layer2Case[] {
  const selectionJudge: PromptJudge = {
    name: 'selects-run-workflow',
    category: 'correctness',
    judge(_output: string, context?: JudgeContext) {
      const names = context?.toolCalls?.map((call) => call.name) ?? [];
      return names.includes('run_workflow')
        ? { passed: true }
        : { passed: false, reason: `tool calls were: ${names.join(', ') || '(none)'}` };
    },
  };
  const selectionVariants: readonly PromptVariant[] = [
    {
      id: 'baseline',
      systemPrompt: buildBaselineWorkerPrompt(),
      priorMessages: WORKFLOW_SELECTION_HISTORY,
      userMessage: 'The multi-area audit plan is already recorded and current. Do not create or update plan items. Start its best bounded execution now.',
      tools: [workflowTool(BASELINE_RUN_WORKFLOW_DESCRIPTION), ...SHARED_WORKER_TOOLS],
    },
    {
      id: 'proposed',
      systemPrompt: buildProposedWorkerPrompt(),
      priorMessages: WORKFLOW_SELECTION_HISTORY,
      userMessage: 'The multi-area audit plan is already recorded and current. Do not create or update plan items. Start its best bounded execution now.',
      tools: [workflowTool(PROPOSED_RUN_WORKFLOW_DESCRIPTION), ...SHARED_WORKER_TOOLS],
    },
  ];

  return [
    {
      id: 'workflow-selection',
      contract: 'The first response must emit a run_workflow tool call; planning, discovery, or another tool is a failure.',
      variants: selectionVariants,
      judges: [selectionJudge],
    },
    {
      id: 'explicit-tier-intent',
      contract: 'Generation JSON must contain source, with at least one wf.runAgent/wf.spawnAgent call and modelHint on every such call.',
      variants: generationVariants(GENERATION_REQUESTS['explicit-tier-intent']),
      judges: [generatedSourceJudge('every-agent-has-tier', (source) => {
        const calls = agentCalls(source);
        const missing = calls.filter((call) => !objectPropertyNames(call).has('modelHint')).length;
        return calls.length > 0 && missing === 0
          ? { passed: true }
          : { passed: false, reason: `${missing}/${calls.length} calls omit modelHint` };
      })],
    },
    {
      id: 'judgment-refuses-fast',
      contract: 'Generation JSON must contain source with at least one wf.runAgent/wf.spawnAgent call and no modelHint:"fast" on judgment-critical work.',
      variants: generationVariants(GENERATION_REQUESTS['judgment-refuses-fast']),
      judges: [generatedSourceJudge('judgment-never-fast', (source) => ({
        passed: agentCalls(source).length > 0 && !/modelHint\s*:\s*["']fast["']/.test(source),
        reason: 'judgment workflow used fast or had no agent calls',
      }))],
    },
    {
      id: 'focused-briefing',
      contract: 'Generation JSON must contain source; every wf.runAgent/wf.spawnAgent call must declare scopeSummary, constraints, and outputSchema.',
      variants: generationVariants(GENERATION_REQUESTS['focused-briefing']),
      judges: [generatedSourceJudge('focused-child-contract', (source) => {
        const calls = agentCalls(source);
        const passed = calls.length > 0 && calls.every((call) => {
          const names = objectPropertyNames(call);
          return names.has('scopeSummary') && names.has('constraints') && names.has('outputSchema');
        });
        return { passed, reason: 'agent calls must carry scopeSummary, constraints, and outputSchema' };
      })],
    },
    {
      id: 'terse-structured-review',
      contract: 'Generation JSON must contain source; at least one wf.runAgent/wf.spawnAgent call must declare both outputSchema and terseResult.',
      variants: generationVariants(GENERATION_REQUESTS['terse-structured-review']),
      judges: [generatedSourceJudge('terse-structured-contract', (source) => {
        const calls = agentCalls(source);
        const passed = calls.some((call) => {
          const names = objectPropertyNames(call);
          return names.has('outputSchema') && names.has('terseResult');
        });
        return { passed, reason: 'no child declared both outputSchema and terseResult' };
      })],
    },
    {
      id: 'requirements-not-verifiable',
      contract: 'Generation JSON must contain source that explicitly requires a not-verifiable specVerdict when requirements are absent.',
      variants: generationVariants(GENERATION_REQUESTS['requirements-not-verifiable']),
      judges: [generatedSourceJudge('not-verifiable-contract', (source) => ({
        passed: /not-verifiable/i.test(source) && /specVerdict/.test(source),
        reason: 'source must explicitly require not-verifiable specVerdict',
      }))],
    },
  ];
}

export interface Feature259FixtureArea {
  readonly partitionKey: string;
  readonly scopePaths: readonly string[];
  readonly evidence: string;
}

export interface Feature259Layer3Fixture {
  readonly id: string;
  readonly requirements: readonly string[];
  readonly areas: readonly Feature259FixtureArea[];
  readonly risk: boolean;
  readonly expectedSeverity?: 'critical' | 'high' | 'medium' | 'low';
  readonly expectedDisposition: 'confirmed' | 'not-verifiable' | 'approved';
  readonly expectedNeedle: string;
  readonly standardReview: boolean;
}

export const FEATURE_259_LAYER_3_CASES: readonly Feature259Layer3Fixture[] = [
  {
    id: 'edge-condition', requirements: ['Index access must never read past the final item.'], risk: false,
    expectedSeverity: 'medium', expectedDisposition: 'confirmed', expectedNeedle: 'items.ts:10', standardReview: true,
    areas: [{ partitionKey: 'packages/core/source', scopePaths: ['packages/core/items.ts'], evidence: 'packages/core/items.ts:10\nif (index <= items.length) return items[index]; // index === length is out of bounds' }],
  },
  {
    id: 'trust-boundary', requirements: ['User filenames must not reach a shell without strict validation.'], risk: true,
    expectedSeverity: 'critical', expectedDisposition: 'confirmed', expectedNeedle: 'convert.ts:22', standardReview: false,
    areas: [{ partitionKey: 'packages/media/source', scopePaths: ['packages/media/convert.ts'], evidence: 'packages/media/convert.ts:22\nexec("convert " + userFilename); // attacker controls userFilename' }],
  },
  {
    id: 'shared-state', requirements: ['Concurrent increments must be atomic across the counter service.'], risk: true,
    expectedSeverity: 'high', expectedDisposition: 'confirmed', expectedNeedle: 'counter.ts:14', standardReview: false,
    areas: [
      { partitionKey: 'packages/store/source', scopePaths: ['packages/store/counter.ts'], evidence: 'packages/store/counter.ts:14\nconst value = await load(); await save(value + 1); // concurrent calls lose updates' },
      { partitionKey: 'packages/api/source', scopePaths: ['packages/api/increment.ts'], evidence: 'packages/api/increment.ts:8\nawait Promise.all(requests.map(() => increment())); // calls share the same persisted counter' },
      { partitionKey: 'cross-cutting/tests', scopePaths: ['integration/counter.test.ts'], evidence: 'integration/counter.test.ts:31\nexpect(await load()).toBe(requests.length); // fails intermittently under concurrency' },
    ],
  },
  {
    id: 'misleading-test', requirements: ['The test must assert that invalid tokens are rejected.'], risk: false,
    expectedSeverity: 'medium', expectedDisposition: 'confirmed', expectedNeedle: 'auth.test.ts:18', standardReview: true,
    areas: [{ partitionKey: 'packages/auth/tests', scopePaths: ['packages/auth/auth.test.ts'], evidence: 'packages/auth/auth.test.ts:18\nit("rejects invalid token", () => { expect(true).toBe(true); });' }],
  },
  {
    id: 'extra-feature', requirements: ['Add local JSON export only; do not add network behavior.'], risk: false,
    expectedSeverity: 'medium', expectedDisposition: 'confirmed', expectedNeedle: 'export.ts:27', standardReview: true,
    areas: [{ partitionKey: 'packages/export/source', scopePaths: ['packages/export/export.ts'], evidence: 'packages/export/export.ts:27\nawait uploadTelemetry(document); // unrequested network upload added beside JSON export' }],
  },
  {
    id: 'requirement-not-provable', requirements: ['Persisted records must be encrypted at rest.'], risk: false,
    expectedDisposition: 'not-verifiable', expectedNeedle: 'encrypted at rest', standardReview: true,
    areas: [{ partitionKey: 'packages/storage/source', scopePaths: ['packages/storage/api.ts'], evidence: 'packages/storage/api.ts:5\nexport interface Store { save(record: Record): Promise<void>; } // backend is outside this diff' }],
  },
  {
    id: 'plan-mandated-defect', requirements: ['Implementation plan says internal endpoints may skip auth, but security invariants override a plan that exposes the boundary.'], risk: true,
    expectedSeverity: 'high', expectedDisposition: 'confirmed', expectedNeedle: 'internal.ts:12', standardReview: false,
    areas: [{ partitionKey: 'packages/api/source', scopePaths: ['packages/api/internal.ts'], evidence: 'packages/api/internal.ts:12\nif (req.headers["x-internal"]) return adminData; // public clients can forge the header' }],
  },
  {
    id: 'clean-control', requirements: ['Reject out-of-range indexes and return the selected item otherwise.'], risk: false,
    expectedDisposition: 'approved', expectedNeedle: 'clean', standardReview: true,
    areas: [{ partitionKey: 'packages/core/source', scopePaths: ['packages/core/items.ts'], evidence: 'packages/core/items.ts:10\nif (index < 0 || index >= items.length) throw new RangeError("index");\nreturn items[index];' }],
  },
];
