/**
 * FEATURE_217 (v0.7.49) Phase G — LLM-generated workflow scripts.
 *
 * The generator is intentionally small: one text-only LLM call must return
 * structured JSON, which is validated before it can become a capability-routed
 * workflow module. Execution safety belongs to the WorkflowApi command bridge;
 * this file adds an earlier prompt/output gate so bad generations fail closed.
 */

import {
  createRestrictedWorkflowModule,
  validateWorkflowScriptManifest,
  WORKFLOW_PATTERN_IDS,
  type WorkflowModule,
  type WorkflowScriptManifest,
} from '@kodax-ai/agent';
import { resolveProvider, sideQuery } from '@kodax-ai/llm';
import type { KodaXMessage } from '@kodax-ai/llm';

import type { WorkflowScriptSnapshotInput } from './run-graph.js';
import type { KodaXOptions } from '../types.js';

export const WORKFLOW_GENERATION_SYSTEM_PROMPT = [
  'You generate KodaX Dynamic Workflow scripts.',
  'Return JSON only. Do not wrap the answer in prose.',
  'For simple tasks that do not benefit from multiple agents, return:',
  '{"action":"decline","reason":"..."}',
  'For complex tasks, return:',
  '{"action":"generate","manifest":{...},"source":"async function run(wf, args) { ... }","approvalSummary":"..."}',
  'Generated source may only coordinate agents through wf and args.',
  'Never use import, require, process, fs, child_process, network APIs, shell commands, or direct file access.',
].join('\n');

export interface WorkflowGenerationTextRequest {
  readonly system: string;
  readonly prompt: string;
  readonly signal?: AbortSignal;
}

export type WorkflowGenerationTextFn = (
  request: WorkflowGenerationTextRequest,
) => Promise<string>;

export interface GenerateWorkflowInput {
  readonly request: string;
  readonly generateText: WorkflowGenerationTextFn;
  readonly signal?: AbortSignal;
}

export interface GenerateWorkflowFromOptionsInput {
  readonly request: string;
  readonly options: KodaXOptions;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface GeneratedWorkflow {
  readonly manifest: WorkflowScriptManifest;
  readonly source: string;
  readonly module: WorkflowModule;
  readonly scriptSnapshot: WorkflowScriptSnapshotInput;
  readonly approvalSummary: string;
  readonly rawText: string;
}

export type WorkflowGenerationResult =
  | { readonly kind: 'declined'; readonly reason: string; readonly rawText: string }
  | ({ readonly kind: 'generated' } & GeneratedWorkflow);

const FORBIDDEN_SOURCE_PATTERNS: readonly {
  readonly id: string;
  readonly pattern: RegExp;
}[] = [
  { id: 'import', pattern: /\bimport\s*(?:\(|['"*{]|\w+\s+from\b)/ },
  { id: 'require', pattern: /\brequire\s*\(/ },
  { id: 'process', pattern: /\bprocess\b/ },
  { id: 'fs', pattern: /\b(?:node:)?fs\b/ },
  { id: 'child_process', pattern: /\bchild_process\b/ },
  { id: 'shell', pattern: /\b(?:exec|spawn|execFile)\s*\(/ },
  { id: 'fetch', pattern: /\bfetch\s*\(/ },
  { id: 'Deno', pattern: /\bDeno\b/ },
  { id: 'Bun', pattern: /\bBun\b/ },
];

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readNonEmptyString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`workflow generation ${key} must be a non-empty string`);
  }
  return value;
}

function extractJsonText(rawText: string): string {
  const trimmed = rawText.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (fenced?.[1]) return fenced[1].trim();

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  throw new Error('workflow generation output did not contain a JSON object');
}

function parseGenerationJson(rawText: string): Record<string, unknown> {
  const jsonText = extractJsonText(rawText);
  return readRecord(JSON.parse(jsonText) as unknown, 'workflow generation output');
}

export function validateGeneratedWorkflowSource(source: string): string {
  if (source.trim().length === 0) {
    throw new Error('workflow generation source must be non-empty');
  }
  if (!/\basync\s+function\s+run\s*\(/.test(source)) {
    throw new Error('workflow generation source must define async function run(wf, args)');
  }
  for (const forbidden of FORBIDDEN_SOURCE_PATTERNS) {
    if (forbidden.pattern.test(source)) {
      throw new Error(`forbidden generated workflow token: ${forbidden.id}`);
    }
  }
  return source;
}

export function buildWorkflowGenerationUserPrompt(request: string): string {
  return [
    'Task request:',
    request,
    '',
    'Available WorkflowApi calls:',
    '- wf.phase(name, async () => ...)',
    '- wf.spawnAgent({ name, prompt, readOnly, modelHint, isolation, evidenceRefs })',
    '- wf.runAgent({ name, prompt, readOnly, modelHint, isolation, evidenceRefs })',
    '- wf.wait(taskId), wf.output(taskId), wf.send(taskId, content), wf.stop(taskId, reason)',
    '- wf.parallel([() => promise], { concurrency })',
    '- wf.synthesize({ inputs, rubric })',
    '- wf.artifact(name, value), wf.log({ message, data })',
    '- For fan-out, prefer wf.parallel with thunks that call wf.runAgent; if using wf.spawnAgent, always wait or stop each handle so maxConcurrency capacity can release.',
    '',
    `Supported pattern ids: ${WORKFLOW_PATTERN_IDS.join(', ')}`,
    '',
    'Manifest requirements:',
    '- name, description, phases, readOnly, maxAgents, maxConcurrency, optional tokenBudget',
    '- optional mayUseWorktree when child prompts need isolated worktrees',
    '- patterns must use only supported ids',
    '',
    'Return JSON only.',
  ].join('\n');
}

export function parseWorkflowGeneration(rawText: string): WorkflowGenerationResult {
  const data = parseGenerationJson(rawText);
  const action = data.action;

  if (action === 'decline') {
    return {
      kind: 'declined',
      reason: readNonEmptyString(data, 'reason'),
      rawText,
    };
  }

  if (action !== 'generate') {
    throw new Error('workflow generation action must be "generate" or "decline"');
  }

  const manifest = validateWorkflowScriptManifest(data.manifest);
  const source = validateGeneratedWorkflowSource(readNonEmptyString(data, 'source'));
  const approvalSummary =
    typeof data.approvalSummary === 'string' && data.approvalSummary.trim().length > 0
      ? data.approvalSummary
      : manifest.description;

  return {
    kind: 'generated',
    manifest,
    source,
    module: createRestrictedWorkflowModule({ manifest, source }),
    scriptSnapshot: { manifest, source },
    approvalSummary,
    rawText,
  };
}

export async function generateWorkflow(
  input: GenerateWorkflowInput,
): Promise<WorkflowGenerationResult> {
  const request = input.request.trim();
  if (!request) {
    return { kind: 'declined', reason: 'Workflow request is empty.', rawText: '' };
  }

  const rawText = await input.generateText({
    system: WORKFLOW_GENERATION_SYSTEM_PROMPT,
    prompt: buildWorkflowGenerationUserPrompt(request),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return parseWorkflowGeneration(rawText);
}

export async function generateWorkflowFromOptions(
  input: GenerateWorkflowFromOptionsInput,
): Promise<WorkflowGenerationResult> {
  const provider = resolveProvider(input.options.provider);
  const model = input.options.modelOverride ?? input.options.model ?? provider.getModel();
  const messages: readonly KodaXMessage[] = [
    { role: 'user', content: buildWorkflowGenerationUserPrompt(input.request) },
  ];

  const result = await sideQuery({
    provider,
    model,
    system: WORKFLOW_GENERATION_SYSTEM_PROMPT,
    messages,
    querySource: 'workflow-generation',
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.signal ? { abortSignal: input.signal } : {}),
  });

  if (!result.text.trim()) {
    const suffix = result.error ? `: ${result.error.message}` : '';
    throw new Error(`workflow generation failed (${result.stopReason})${suffix}`);
  }
  return parseWorkflowGeneration(result.text);
}
