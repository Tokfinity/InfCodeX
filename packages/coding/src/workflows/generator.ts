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
  'Generated source must return displayable final text for the user.',
  'Never use import, require, process, fs, child_process, network APIs, shell commands, or direct file access.',
].join('\n');

export const DEFAULT_WORKFLOW_GENERATION_TIMEOUT_MS = 120_000;
const WORKFLOW_GENERATION_TIMEOUT_ENV = 'KODAX_WORKFLOW_GENERATION_TIMEOUT_MS';
const GENERATED_WORKFLOW_MAX_AGENTS_HARD_CAP = 64;

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

export function resolveWorkflowGenerationTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[WORKFLOW_GENERATION_TIMEOUT_ENV];
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_WORKFLOW_GENERATION_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_WORKFLOW_GENERATION_TIMEOUT_MS;
  }
  return Math.floor(parsed);
}

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

function normalizePhaseEntry(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  for (const key of ['name', 'id', 'title', 'phase']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return undefined;
}

function splitPhaseString(value: string): readonly string[] {
  return value
    .split(/(?:->|\u2192|,|\n)/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function normalizeGeneratedManifestCandidate(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) {
    return value;
  }

  const record = value as Record<string, unknown>;
  const phasesValue = record.phases;
  let phases: readonly string[] | undefined;

  if (Array.isArray(phasesValue)) {
    const normalized = phasesValue.map(normalizePhaseEntry);
    if (normalized.every((item): item is string => item !== undefined)) {
      phases = normalized;
    }
  } else if (typeof phasesValue === 'string') {
    const split = splitPhaseString(phasesValue);
    if (split.length > 0) {
      phases = split;
    }
  }

  return phases ? { ...record, phases } : value;
}

function estimateDirectAgentCalls(source: string): number {
  return source.match(/\bwf\.(?:runAgent|spawnAgent|synthesize)\s*\(/g)?.length ?? 0;
}

function reserveGeneratedWorkflowAgentCapacity(
  manifest: WorkflowScriptManifest,
  source: string,
): WorkflowScriptManifest {
  const phaseConcurrencyReserve =
    manifest.maxConcurrency * Math.max(1, manifest.phases.length) + 2;
  const directCallReserve = estimateDirectAgentCalls(source) + 2;
  const required = Math.min(
    GENERATED_WORKFLOW_MAX_AGENTS_HARD_CAP,
    Math.max(manifest.maxAgents, phaseConcurrencyReserve, directCallReserve),
  );

  return required > manifest.maxAgents
    ? { ...manifest, maxAgents: required }
    : manifest;
}

function stripGeneratedSourceLiterals(source: string): string {
  let stripped = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      stripped += '  ';
      i += 2;
      while (i < source.length && source[i] !== '\n') {
        stripped += ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      stripped += '  ';
      i += 2;
      while (i < source.length) {
        if (source[i] === '*' && source[i + 1] === '/') {
          stripped += '  ';
          i += 2;
          break;
        }
        stripped += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      stripped += ' ';
      i += 1;
      while (i < source.length) {
        const current = source[i];
        stripped += current === '\n' ? '\n' : ' ';
        i += 1;
        if (current === '\\') {
          if (i < source.length) {
            stripped += source[i] === '\n' ? '\n' : ' ';
            i += 1;
          }
          continue;
        }
        if (current === quote) break;
      }
      continue;
    }
    stripped += ch ?? '';
    i += 1;
  }
  return stripped;
}

function isIdentifierPart(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
}

function findRunBodyRange(source: string): { readonly start: number; readonly end: number } | undefined {
  const stripped = stripGeneratedSourceLiterals(source);
  const match = /\basync\s+function\s+run\s*\([^)]*\)\s*\{/.exec(stripped);
  if (!match) return undefined;
  const open = stripped.indexOf('{', match.index);
  if (open < 0) return undefined;
  let depth = 0;
  for (let i = open; i < stripped.length; i += 1) {
    const ch = stripped[i];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return { start: open + 1, end: i };
    }
  }
  return undefined;
}

function findOuterRunReturnExpression(source: string): string | undefined {
  const range = findRunBodyRange(source);
  if (!range) return undefined;
  const stripped = stripGeneratedSourceLiterals(source);
  let depth = 1;
  for (let i = range.start; i < range.end; i += 1) {
    const ch = stripped[i];
    if (ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      continue;
    }
    if (
      depth === 1
      && stripped.startsWith('return', i)
      && !isIdentifierPart(stripped[i - 1])
      && !isIdentifierPart(stripped[i + 'return'.length])
    ) {
      const expressionStart = i + 'return'.length;
      let nested = 0;
      for (let j = expressionStart; j < range.end; j += 1) {
        const current = stripped[j];
        if (current === '(' || current === '[' || current === '{') nested += 1;
        if (current === ')' || current === ']' || current === '}') nested -= 1;
        if (nested === 0 && (current === ';' || current === '\n' || current === '\r')) {
          return source.slice(expressionStart, j).trim();
        }
      }
      return source.slice(expressionStart, range.end).trim();
    }
  }
  return undefined;
}

function hasDisplayableRunReturn(source: string): boolean {
  const expression = findOuterRunReturnExpression(source);
  if (!expression || /^(?:undefined|null|\{\})$/.test(expression.trim())) return false;
  return /\b(?:synthesis|summary|report|text|result|finalText)\b|\bwf\.synthesize\s*\(/.test(expression);
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
  if (/\.\s*output\b/.test(source)) {
    throw new Error('workflow generation source must use finalText/text instead of non-existent .output');
  }
  for (const line of source.split(/\r?\n/)) {
    const artifactCall = line.search(/\bwf\.artifact\s*\(/);
    if (artifactCall >= 0 && !/\b(?:await|return)\b/.test(line.slice(0, artifactCall))) {
      throw new Error('workflow generation source must await wf.artifact(...)');
    }
  }
  if (!hasDisplayableRunReturn(source)) {
    throw new Error('workflow generation source outer run function must return displayable final text');
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
    '- Return shapes: wf.runAgent/wf.wait return { taskId, name, status, finalText, usage }; wf.synthesize returns { text }; wf.artifact returns { name, path? }. Never use a non-existent .output field.',
    '- Always await asynchronous workflow calls, especially wf.artifact(...), before returning.',
    '- For fan-out, prefer wf.parallel with thunks that call wf.runAgent; if using wf.spawnAgent, always wait or stop each handle so maxConcurrency capacity can release.',
    '- Keep intermediate findings in local variables and pass their finalText/text values forward; artifacts are durable outputs, not mutable args.',
    '- The outer run function must return displayable final text, preferably { synthesis: finalText }. Returning only inside a wf.phase callback is invalid. Artifact-only or empty returns are invalid.',
    '- Also await wf.artifact("final-report", { summary/report/text: finalText }) for durable inspection when a final report is produced.',
    '- Every child agent prompt must ask the child to end with a compact [workflow handoff]...[/workflow handoff] block in the same language as the request. The block should contain concrete conclusions, evidence, risks, unresolved questions, or next actions, not generic report preambles.',
    '',
    `Supported pattern ids: ${WORKFLOW_PATTERN_IDS.join(', ')}`,
    '',
    'Manifest requirements:',
    '- name, description, phases, readOnly, maxAgents, maxConcurrency, optional tokenBudget',
    '- phases must be a JSON array of non-empty string literals, for example ["investigate","verify","synthesize"]; never return phase objects or a single string',
    '- maxAgents and maxConcurrency must be positive JSON integers',
    '- maxAgents is a lifetime total cap for every wf.runAgent, wf.spawnAgent, and wf.synthesize call in the whole run, not the parallel lane count; reserve enough for all phases plus synthesis',
    '- Do not set tokenBudget unless the user explicitly asks for a token/resource budget; omit it for normal complex work',
    '- readOnly must be a JSON boolean',
    '- optional mayUseWorktree when child prompts need isolated worktrees',
    '- patterns must use only supported ids',
    '- Use the same natural language as the task request for manifest description, approvalSummary, child agent prompts, synthesis rubric, and artifact text unless the user explicitly asks otherwise',
    '',
    'Return JSON only.',
  ].join('\n');
}

function buildWorkflowGenerationRepairPrompt(input: {
  readonly request: string;
  readonly previousOutput: string;
  readonly error: string;
}): string {
  return [
    buildWorkflowGenerationUserPrompt(input.request),
    '',
    'Your previous output failed KodaX workflow validation.',
    `Validation error: ${input.error}`,
    '',
    'Previous output:',
    input.previousOutput,
    '',
    'Return corrected JSON only. Keep the same task intent, but make the manifest and source valid.',
  ].join('\n');
}

interface ParseWorkflowGenerationOptions {
  readonly request?: string;
}

function requestExplicitlyMentionsTokenBudget(request: string): boolean {
  return /(?:token\s*(?:budget|limit|cap)|budget\s*(?:for|of)?\s*tokens?|\b\d+(?:\.\d+)?\s*(?:k|m)?\s*tokens?\b|\d+(?:\.\d+)?\s*(?:k|m)?\s*令牌|(?:tokens?|令牌).{0,12}(?:预算|上限|限制)|(?:预算|上限|限制).{0,12}(?:tokens?|令牌))/i.test(request);
}

function stripImplicitTokenBudget(
  manifest: WorkflowScriptManifest,
  request: string | undefined,
): WorkflowScriptManifest {
  if (manifest.tokenBudget === undefined || request === undefined) {
    return manifest;
  }
  if (requestExplicitlyMentionsTokenBudget(request)) {
    return manifest;
  }
  const { tokenBudget: _tokenBudget, ...withoutTokenBudget } = manifest;
  return withoutTokenBudget;
}

export function parseWorkflowGeneration(
  rawText: string,
  options: ParseWorkflowGenerationOptions = {},
): WorkflowGenerationResult {
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

  const source = validateGeneratedWorkflowSource(readNonEmptyString(data, 'source'));
  const manifest = stripImplicitTokenBudget(
    reserveGeneratedWorkflowAgentCapacity(
      validateWorkflowScriptManifest(normalizeGeneratedManifestCandidate(data.manifest)),
      source,
    ),
    options.request,
  );
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
  try {
    return parseWorkflowGeneration(rawText, { request });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const repairedText = await input.generateText({
      system: WORKFLOW_GENERATION_SYSTEM_PROMPT,
      prompt: buildWorkflowGenerationRepairPrompt({
        request,
        previousOutput: rawText,
        error: message,
      }),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return parseWorkflowGeneration(repairedText, { request });
  }
}

export async function generateWorkflowFromOptions(
  input: GenerateWorkflowFromOptionsInput,
): Promise<WorkflowGenerationResult> {
  const provider = resolveProvider(input.options.provider);
  const model = input.options.modelOverride ?? input.options.model ?? provider.getModel();
  const timeoutMs = input.timeoutMs ?? resolveWorkflowGenerationTimeoutMs();
  return generateWorkflow({
    request: input.request,
    ...(input.signal ? { signal: input.signal } : {}),
    generateText: async (request) => {
      const messages: readonly KodaXMessage[] = [
        { role: 'user', content: request.prompt },
      ];
      const result = await sideQuery({
        provider,
        model,
        system: request.system,
        messages,
        querySource: 'workflow-generation',
        timeoutMs,
        ...(request.signal ? { abortSignal: request.signal } : {}),
      });

      if (!result.text.trim()) {
        const suffix = result.error ? `: ${result.error.message}` : '';
        const timeoutHint = result.stopReason === 'timeout' ? ` after ${timeoutMs}ms` : '';
        throw new Error(`workflow generation failed (${result.stopReason}${timeoutHint})${suffix}`);
      }
      return result.text;
    },
  });
}
