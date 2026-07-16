/**
 * FEATURE_246 Part A1 (ADR-046) — the coding WorkflowHost entrypoint.
 *
 * `startManagedWorkflow` is the single capability both the REPL `/workflow`
 * command / AMAW intercept AND the model-callable `run_workflow` tool call. It
 * resolves a workflow module from one of three sources (inline `{manifest,
 * source}` written by the Worker, a saved module, or a natural-language request
 * routed through the generator), mints the run id + durable run dir, and starts
 * it on the (agent-layer) run manager. UI — approval rendering, progress, final
 * messages — stays in the REPL, which passes an `approval` callback + `onEvent`
 * sink. This removes the start-glue that previously lived in the REPL
 * (`startGeneratedWorkflowFromRequest`).
 */

import { join } from 'node:path';

import {
  createRestrictedWorkflowModule,
  lintRestrictedWorkflowSource,
  runRestrictedWorkflowScript,
  validateWorkflowScriptManifest,
} from '@kodax-ai/agent';
import type {
  WorkflowApproval,
  WorkflowApprovalSummary,
  WorkflowApi,
  WorkflowSpawnAgentInput,
  WorkflowTaskHandle,
  WorkflowTaskResult,
  WorkflowTaskSnapshot,
  WorkflowEvent,
  WorkflowModule,
  WorkflowQualityLintFinding,
  WorkflowScriptManifest,
} from '@kodax-ai/agent';

import { generateWorkflowFromOptions, validateGeneratedWorkflowSource } from './generator.js';
import {
  getDefaultWorkflowRunManager,
  type ManagedWorkflowRun,
  type WorkflowRunManager,
} from './run-manager.js';
import type { WorkflowRunProcessMetadata, WorkflowScriptSnapshotInput } from './run-graph.js';
import { buildApprovalSummary } from './workflow-runner.js';
import type { KodaXOptions } from '../types.js';

/** Where the workflow script comes from. */
export type ManagedWorkflowSource =
  | { readonly kind: 'inline'; readonly manifest: unknown; readonly source: string }
  | { readonly kind: 'saved'; readonly module: WorkflowModule }
  | { readonly kind: 'request'; readonly request: string };

export interface StartManagedWorkflowInput {
  readonly source: ManagedWorkflowSource;
  readonly args: unknown;
  readonly options: KodaXOptions;
  /** Durable run-graph base dir (one run dir per run id is created under it). */
  readonly runsBaseDir: string;
  /** Override the minted run id (tests / explicit rerun ids). */
  readonly runId?: string;
  /** FEATURE_246 Part D (ADR-048): a prior run dir to seed the result cache from
   *  (same-session resume). Unchanged effects replay; only changed ones re-run. */
  readonly resumeFromRunDir?: string;
  /** Defaults to the shared coding singleton (which wraps the agent default). */
  readonly manager?: WorkflowRunManager;
  /** Pre-run approval gate; when omitted the run auto-proceeds (headless). */
  readonly approval?: WorkflowApproval;
  readonly processMetadata?: WorkflowRunProcessMetadata;
  readonly onEvent?: (event: WorkflowEvent) => void;
  readonly signal?: AbortSignal;
  /** Test seam: override the NL→workflow generator. */
  readonly generateWorkflow?: typeof generateWorkflowFromOptions;
  /** Test seam: clock for the minted run id. */
  readonly now?: () => number;
}

export type StartManagedWorkflowResult =
  | { readonly kind: 'declined'; readonly reason: string }
  | {
      readonly kind: 'started';
      readonly runId: string;
      readonly runDir: string;
      readonly module: WorkflowModule;
      readonly managed: ManagedWorkflowRun;
      readonly approvalSummary: WorkflowApprovalSummary;
      readonly scriptSnapshot?: WorkflowScriptSnapshotInput;
      readonly qualityWarnings?: readonly WorkflowQualityLintFinding[];
    };

interface ResolvedModule {
  readonly module: WorkflowModule;
  readonly scriptSnapshot?: WorkflowScriptSnapshotInput;
  readonly qualityWarnings?: readonly WorkflowQualityLintFinding[];
}

const INLINE_WORKFLOW_SMOKE_TIMEOUT_MS = 2_000;
const QUALITY_WARNING_METADATA_LIMIT = 3;

function splitWorkflowQualityWarnings(input: {
  readonly source: string;
  readonly manifest: WorkflowScriptManifest;
  readonly hostMaxAgents?: number;
}): readonly WorkflowQualityLintFinding[] {
  const findings = lintRestrictedWorkflowSource(input.source, {
    manifest: input.manifest,
    ...(input.hostMaxAgents !== undefined ? { hostMaxAgents: input.hostMaxAgents } : {}),
  });
  const errors = findings.filter((finding) => finding.severity === 'error');
  if (errors.length > 0) {
    throw new Error(
      [
        'inline workflow source failed pre-flight quality validation:',
        ...errors.map((finding) => finding.message),
      ].join('\n'),
    );
  }
  return findings.filter((finding) => finding.severity === 'warning');
}

function readSchemaRecord(schema: unknown): Record<string, unknown> | undefined {
  return typeof schema === 'object' && schema !== null && !Array.isArray(schema)
    ? schema as Record<string, unknown>
    : undefined;
}

function smokeValueForFieldName(name: string): unknown {
  if (/(?:items|findings|results|files|paths|tasks|entries)$/i.test(name)) return [];
  if (/^(?:ok|valid|verified|passed|success)$/i.test(name)) return true;
  return `Smoke structured ${name}`;
}

function smokeStructuredValue(schema: unknown, fieldName?: string): unknown {
  const record = readSchemaRecord(schema);
  if (!record) return fieldName ? smokeValueForFieldName(fieldName) : 'Smoke structured value';
  const enumValues = record.enum;
  if (Array.isArray(enumValues) && enumValues.length > 0) return enumValues[0];
  const rawType = Array.isArray(record.type) ? record.type[0] : record.type;
  if (rawType === 'string') return 'Smoke structured text';
  if (rawType === 'integer' || rawType === 'number') return 1;
  if (rawType === 'boolean') return true;
  if (rawType === 'array') return [smokeStructuredValue(record.items)];
  if (rawType === 'object' || record.properties !== undefined) {
    const properties = readSchemaRecord(record.properties);
    const value: Record<string, unknown> = {};
    if (properties) {
      for (const [key, propertySchema] of Object.entries(properties)) {
        value[key] = smokeStructuredValue(propertySchema, key);
      }
    }
    if (Array.isArray(record.required)) {
      for (const key of record.required) {
        if (typeof key === 'string' && value[key] === undefined) value[key] = smokeValueForFieldName(key);
      }
    }
    return value;
  }
  return fieldName ? smokeValueForFieldName(fieldName) : 'Smoke structured value';
}

interface InlineSmokeTaskStore {
  nextTask: number;
  readonly names: Map<string, string>;
  readonly structuredByTaskId: Map<string, unknown>;
}

function createInlineSmokeTaskStore(): InlineSmokeTaskStore {
  return { nextTask: 0, names: new Map(), structuredByTaskId: new Map() };
}

function nextInlineSmokeHandle(
  store: InlineSmokeTaskStore,
  input: WorkflowSpawnAgentInput,
): WorkflowTaskHandle {
  store.nextTask += 1;
  const taskId = `inline-smoke-task-${store.nextTask}`;
  store.names.set(taskId, input.name);
  if (input.outputSchema !== undefined) {
    store.structuredByTaskId.set(taskId, smokeStructuredValue(input.outputSchema));
  }
  return { taskId, name: input.name };
}

function assertInlineSmokeKnownTaskId(
  store: InlineSmokeTaskStore,
  method: string,
  taskId: string,
): void {
  if (store.names.has(taskId)) return;
  const nameMatch = [...store.names.entries()].find((entry) => entry[1] === taskId);
  if (nameMatch) {
    throw new Error(
      `wf.${method}("${taskId}") used an agent name, but workflow task APIs require ` +
        'the taskId returned by spawnAgent/runAgent. Store the handle/result and pass ' +
        'handle.taskId or result.taskId.',
    );
  }
  throw new Error(`wf.${method}("${taskId}") references an unknown workflow task id`);
}

function assertInlineSmokeEvidenceRefs(
  store: InlineSmokeTaskStore,
  input: WorkflowSpawnAgentInput,
): void {
  for (const ref of input.evidenceRefs ?? []) {
    if (ref.startsWith('file:') || ref.startsWith('diff:') || ref.startsWith('finding:')) continue;
    if (ref.startsWith('task_id:')) {
      const taskId = ref.slice('task_id:'.length).trim();
      if (taskId.length === 0) {
        throw new Error(`wf.runAgent("${input.name}") evidenceRefs contains empty task_id: reference`);
      }
      assertInlineSmokeKnownTaskId(store, 'evidenceRefs', taskId);
      continue;
    }
    if ([...store.names.values()].includes(ref)) {
      throw new Error(
        `wf.runAgent("${input.name}") evidenceRefs contains agent name "${ref}". ` +
          'Use "task_id:" + result.taskId from the child result.',
      );
    }
    throw new Error(
      `wf.runAgent("${input.name}") evidenceRefs contains unsupported ref "${ref}". ` +
        'Use file:, diff:, finding:, or task_id:<id>.',
    );
  }
}

function inlineSmokeResultFor(store: InlineSmokeTaskStore, taskId: string): WorkflowTaskResult {
  assertInlineSmokeKnownTaskId(store, 'wait', taskId);
  const name = store.names.get(taskId) ?? taskId;
  const structured = store.structuredByTaskId.get(taskId);
  return {
    taskId,
    name,
    status: 'completed',
    finalText: `Smoke result for ${name}: completed, done, verified.`,
    ...(structured !== undefined ? { structured } : {}),
  };
}

function inlineSmokeSnapshotFor(
  store: InlineSmokeTaskStore,
  method: string,
  taskId: string,
): WorkflowTaskSnapshot {
  assertInlineSmokeKnownTaskId(store, method, taskId);
  const name = store.names.get(taskId) ?? taskId;
  return { taskId, name, status: 'completed', lastText: `Smoke snapshot for ${name}` };
}

function assertInlineSmokeReadOnly(
  workflowReadOnly: boolean,
  input: WorkflowSpawnAgentInput,
): void {
  if (workflowReadOnly && input.readOnly === false) {
    throw new Error(
      `workflow manifest readOnly=true cannot spawn write-capable child "${input.name}"; ` +
        'set the workflow manifest readOnly=false or use child readOnly:true',
    );
  }
}

function createInlineSmokeWorkflowApi(args: unknown, workflowReadOnly: boolean): WorkflowApi {
  const store = createInlineSmokeTaskStore();
  return {
    runId: 'run-inline-smoke',
    args,
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
    phase: async (_name, fn) => fn(),
    spawnAgent: async (input) => {
      assertInlineSmokeReadOnly(workflowReadOnly, input);
      assertInlineSmokeEvidenceRefs(store, input);
      return nextInlineSmokeHandle(store, input);
    },
    runAgent: async (input) => {
      assertInlineSmokeReadOnly(workflowReadOnly, input);
      assertInlineSmokeEvidenceRefs(store, input);
      const handle = nextInlineSmokeHandle(store, input);
      return inlineSmokeResultFor(store, handle.taskId);
    },
    wait: async (taskId) => inlineSmokeResultFor(store, taskId),
    snapshot: async (taskId) => inlineSmokeSnapshotFor(store, 'snapshot', taskId),
    output: async (taskId) => inlineSmokeSnapshotFor(store, 'output', taskId),
    send: async (taskId) => {
      assertInlineSmokeKnownTaskId(store, 'send', taskId);
    },
    stop: async (taskId) => {
      assertInlineSmokeKnownTaskId(store, 'stop', taskId);
    },
    parallel: async (items) => Promise.all(items.map((item) => item())),
    synthesize: async () => ({ text: 'Smoke synthesis: completed, done, verified.' }),
    workflow: async (name, workflowArgs) => ({ synthesis: `Smoke workflow ${name} completed.`, args: workflowArgs }),
    artifact: async (name) => ({ name }),
    log: () => undefined,
  };
}

function isInlineSmokeHardFailure(message: string): boolean {
  return [
    'wf.parallel expects an array of thunks',
    'wf.parallel items must be functions',
    'wf.pipeline expects an array as its first argument',
    'references an unknown workflow task id',
    'used an agent name, but workflow task APIs require',
    'evidenceRefs contains empty task_id:',
    'evidenceRefs contains agent name',
    'evidenceRefs contains unsupported ref',
    'result must be awaited before reading',
    'result must be awaited before JSON serialization',
    'result must be awaited before enumerating properties',
    'result must be awaited before assigning properties',
    'result must be awaited before defining properties',
    'result must be awaited before deleting properties',
    'workflow manifest readOnly=true cannot spawn write-capable child',
  ].some((signature) => message.includes(signature));
}

async function assertInlineWorkflowSmoke(
  source: string,
  args: unknown,
  workflowReadOnly: boolean,
): Promise<void> {
  try {
    await runRestrictedWorkflowScript({
      source,
      args,
      wf: createInlineSmokeWorkflowApi(args, workflowReadOnly),
      filename: 'inline-workflow-smoke.js',
      timeoutMs: INLINE_WORKFLOW_SMOKE_TIMEOUT_MS,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isInlineSmokeHardFailure(message)) {
      throw new Error(`inline workflow source failed pre-flight smoke validation: ${message}`);
    }
  }
}

async function resolveModule(
  input: StartManagedWorkflowInput,
): Promise<ResolvedModule | { readonly declined: string }> {
  const source = input.source;
  if (source.kind === 'saved') {
    return { module: source.module };
  }
  if (source.kind === 'inline') {
    // Validate manifest + source through the SAME gate generated workflows use,
    // so a malformed inline script fails closed exactly like a generated one.
    const manifest = validateWorkflowScriptManifest(source.manifest);
    // FEATURE_246 (P2 review): run_workflow (inline) is the PRIMARY workflow path,
    // so it must not have LESS pre-flight protection than the blind generator
    // fallback. Apply the same static source checks here — literal task targets
    // (e.g. wf.wait("name")), legacy `.output`, forbidden host/IO tokens, and a
    // non-displayable run() return now fail fast with an actionable message that
    // the Worker sees as a tool error and can correct, instead of a late runtime
    // crash. Inline also gets a narrow, single-scenario smoke run for structural
    // WorkflowApi contract errors that static validation cannot see.
    validateGeneratedWorkflowSource(source.source);
    await assertInlineWorkflowSmoke(source.source, input.args, manifest.readOnly === true);
    const qualityWarnings = splitWorkflowQualityWarnings({
      source: source.source,
      manifest,
      ...(input.options.workflowHostPolicy?.maxAgents !== undefined
        ? { hostMaxAgents: input.options.workflowHostPolicy.maxAgents }
        : {}),
    });
    const module = createRestrictedWorkflowModule({ manifest, source: source.source });
    return {
      module,
      scriptSnapshot: { manifest, source: source.source },
      ...(qualityWarnings.length > 0 ? { qualityWarnings } : {}),
    };
  }
  const generate = input.generateWorkflow ?? generateWorkflowFromOptions;
  const generated = await generate({ request: source.request, options: input.options });
  if (generated.kind === 'declined') {
    return { declined: generated.reason };
  }
  const hostQualityWarnings = splitWorkflowQualityWarnings({
    source: generated.source,
    manifest: generated.manifest,
    ...(input.options.workflowHostPolicy?.maxAgents !== undefined
      ? { hostMaxAgents: input.options.workflowHostPolicy.maxAgents }
      : {}),
  });
  const warningKeys = new Set<string>();
  const qualityWarnings = [...(generated.qualityWarnings ?? []), ...hostQualityWarnings]
    .filter((warning) => {
      const key = `${warning.code}\n${warning.message}`;
      if (warningKeys.has(key)) return false;
      warningKeys.add(key);
      return true;
    });
  return {
    module: generated.module,
    scriptSnapshot: generated.scriptSnapshot,
    ...(qualityWarnings.length > 0 ? { qualityWarnings } : {}),
  };
}

function workflowQualityWarningMetadata(
  warnings: readonly WorkflowQualityLintFinding[] | undefined,
): Record<string, string> | undefined {
  if (!warnings || warnings.length === 0) return undefined;
  const shown = warnings.slice(0, QUALITY_WARNING_METADATA_LIMIT);
  return {
    workflowQualityWarningCount: String(warnings.length),
    workflowQualityWarningCodes: [...new Set(warnings.map((warning) => warning.code))].join(','),
    workflowQualityWarnings: shown
      .map((warning) => `${warning.code}: ${warning.message}`)
      .join(' | '),
  };
}

function withWorkflowQualityWarningMetadata(
  metadata: WorkflowRunProcessMetadata | undefined,
  warnings: readonly WorkflowQualityLintFinding[] | undefined,
): WorkflowRunProcessMetadata | undefined {
  const warningMetadata = workflowQualityWarningMetadata(warnings);
  if (!warningMetadata) return metadata;
  return {
    ...metadata,
    hostMetadata: {
      ...(metadata?.hostMetadata ?? {}),
      ...warningMetadata,
    },
  };
}

function withWorkflowAuthorshipMetadata(
  metadata: WorkflowRunProcessMetadata | undefined,
  generated: boolean,
): WorkflowRunProcessMetadata | undefined {
  const hostMetadata = metadata?.hostMetadata;
  const sanitizedHostMetadata = hostMetadata
    ? Object.fromEntries(Object.entries(hostMetadata).filter(([key]) => key !== 'workflowAuthorship'))
    : undefined;
  if (!generated) {
    if (!metadata || hostMetadata === undefined) return metadata;
    return {
      ...metadata,
      ...(Object.keys(sanitizedHostMetadata ?? {}).length > 0
        ? { hostMetadata: sanitizedHostMetadata }
        : { hostMetadata: undefined }),
    };
  }
  return {
    ...metadata,
    hostMetadata: {
      ...(sanitizedHostMetadata ?? {}),
      workflowAuthorship: 'kodax-generated',
    },
  };
}

export async function startManagedWorkflow(
  input: StartManagedWorkflowInput,
): Promise<StartManagedWorkflowResult> {
  const resolved = await resolveModule(input);
  if ('declined' in resolved) {
    return { kind: 'declined', reason: resolved.declined };
  }
  const { module, scriptSnapshot, qualityWarnings } = resolved;

  const now = input.now ?? (() => Date.now());
  const runId = input.runId ?? `run-${now().toString(36)}`;
  const runDir = join(input.runsBaseDir, runId);
  const manager = input.manager ?? getDefaultWorkflowRunManager();
  const approvalSummary = buildApprovalSummary(module, input.options.workflowHostPolicy);

  const managed = manager.startFromOptions({
    module,
    args: input.args,
    options: input.options,
    runId,
    runDir,
    ...(scriptSnapshot ? { scriptSnapshot } : {}),
    ...(input.resumeFromRunDir ? { resumeFromRunDir: input.resumeFromRunDir } : {}),
    ...(() => {
      const processMetadata = withWorkflowAuthorshipMetadata(
        withWorkflowQualityWarningMetadata(input.processMetadata, qualityWarnings),
        input.source.kind === 'request',
      );
      return processMetadata ? { processMetadata } : {};
    })(),
    ...(input.approval ? { approval: input.approval } : {}),
    ...(input.onEvent ? { onEvent: input.onEvent } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });

  return {
    kind: 'started',
    runId,
    runDir,
    module,
    managed,
    approvalSummary,
    ...(scriptSnapshot ? { scriptSnapshot } : {}),
    ...(qualityWarnings !== undefined ? { qualityWarnings } : {}),
  };
}
