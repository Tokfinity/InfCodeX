/**
 * FEATURE_217 (v0.7.49) Phase B — Coding workflow agent backend.
 *
 * Bridges the domain-neutral `WorkflowAgentBackend` (from
 * `@kodax-ai/agent/workflow`) onto KodaX's existing child-dispatch
 * substrate: `executeChildAgents` + per-child AbortController registry +
 * `childProgressSnapshots` + `MessageQueue` routing. It does NOT
 * duplicate the child state model — spawn/wait/output/stop/send all
 * reuse the same primitives `dispatch_child_task` / `task_output` /
 * `task_stop` / `send_message` already use.
 *
 * Each `spawn` launches one bundle through `executeChildAgents`
 * (maxParallel:1) without awaiting; the workflow runtime owns the
 * concurrency gate (Semaphore) so each backend spawn is a single child.
 *
 * Test seams (DI): `runChild` (defaults to `executeChildAgents`),
 * `queue`, `generateId`, `now`. Tests inject a fake `runChild` + a
 * minimal ctx so no real agents run.
 */

import { registerChildTask, routeMessage, getMessageQueue } from '@kodax-ai/agent';
import type { ChildTaskRegistry, MessageQueue } from '@kodax-ai/agent';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  WorkflowAgentBackend,
  WorkflowSpawnAgentInput,
  WorkflowTaskHandle,
  WorkflowTaskResult,
  WorkflowTaskSummaryEventUpdate,
  WorkflowTaskSnapshot,
  WorkflowTaskStatus,
  WorkflowTaskVerification,
  WorkflowTaskVerificationResult,
  WorkflowWaitOptions,
} from '@kodax-ai/agent';

import { executeChildAgents } from '../child-executor.js';
import type { ChildExecutorOptions } from '../child-executor.js';
import {
  initChildSnapshot,
  applyChildSnapshotEvent,
  finalizeChildSnapshot,
} from '../child-progress-snapshot.js';
import type { ChildProgressStatus } from '../child-progress-snapshot.js';
import type {
  KodaXChildContextBundle,
  KodaXChildExecutionResult,
  KodaXEvents,
  KodaXToolExecutionContext,
} from '../types.js';

const execFileAsync = promisify(execFile);
const GIT_STATUS_TIMEOUT_MS = 10_000;
const DEFAULT_VERIFICATION_REPAIR_ATTEMPTS = 2;
const MUTATING_TOOL_NAMES = new Set(['write', 'edit', 'multi_edit', 'insert_after_anchor']);
const PREPARATORY_FINAL_TEXT_RE =
  /^\s*(?:let me|i will|i'll|i am going to)\b[\s\S]{0,120}\b(?:start|create|implement|write|build|plan)\b|^\s*(?:我将|让我|接下来)[\s\S]{0,80}(?:开始|创建|编写|实现|制定)/i;

/** The subset of `ChildExecutorOptions` the caller fixes once per run;
 *  the adapter adds `maxParallel` / `abortSignal` / `snapshotUpdater`
 *  per spawn. */
export type WorkflowChildOptions = Omit<
  ChildExecutorOptions,
  | 'maxParallel'
  | 'abortSignal'
  | 'snapshotUpdater'
  | 'workflowChild'
  | 'workflowDigestMode'
  | 'onWorkflowChildDigest'
  | 'workflowCorrelation'
>;

export interface CodingWorkflowBackendDeps {
  /** Parent tool-execution context (carries abort + snapshot registries). */
  readonly ctx: KodaXToolExecutionContext;
  /** Fixed per-run child options (parentRole / parentHarness / parentOptions
   *  / maxIterationsPerChild / guardrails / …). */
  readonly childOptions: WorkflowChildOptions;
  /** Seam: child runner. Defaults to `executeChildAgents`. */
  readonly runChild?: (
    bundles: readonly KodaXChildContextBundle[],
    ctx: KodaXToolExecutionContext,
    options: ChildExecutorOptions,
  ) => Promise<KodaXChildExecutionResult>;
  /** Seam: message queue. Defaults to the process-global singleton. */
  readonly queue?: MessageQueue;
  /** Seam: unique child id generator. */
  readonly generateId?: () => string;
  /** Seam: clock for snapshot timestamps. */
  readonly now?: () => number;
  /** Workflow run id for correlating child-agent SDK callbacks. */
  readonly runId?: string;
  /** Seam: workspace changed path reader. Defaults to git status/diff. */
  readonly listChangedFiles?: (ctx: KodaXToolExecutionContext) => Promise<readonly string[]>;
  readonly onTaskSummary?: (taskId: string, update: WorkflowTaskSummaryEventUpdate) => void;
}

interface TaskEntry {
  readonly name: string;
  readonly input: WorkflowSpawnAgentInput;
  readonly bundle: KodaXChildContextBundle;
  promise: Promise<KodaXChildExecutionResult>;
  readonly runBundle: (bundle: KodaXChildContextBundle) => Promise<KodaXChildExecutionResult>;
  readonly verification?: WorkflowTaskVerification;
  readonly changedPathBaseline: Promise<ChangedPathSnapshot>;
  readonly mutationRecorder: MutationRecorder;
  readonly acceptToolMutationEvidence: boolean;
  repairAttempts: number;
}

interface ChangedPathSnapshot {
  readonly paths: readonly string[];
  readonly error?: string;
}

interface MutationRecorder {
  readonly toolNameById: Map<string, string>;
  readonly toolPathById: Map<string, string>;
  readonly succeededToolCalls: string[];
  readonly succeededPaths: string[];
}

interface ResolvedVerification {
  readonly verification?: WorkflowTaskVerification;
}

function normalizeWaitTimeoutMs(opts: WorkflowWaitOptions | undefined): number | undefined {
  if (opts?.timeoutMs === undefined) return undefined;
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
    throw new Error('workflow wait timeoutMs must be a positive number');
  }
  return Math.floor(opts.timeoutMs);
}

function hasVerificationWork(verification: WorkflowTaskVerification | undefined): boolean {
  return verification?.requiresMutation === true ||
    (verification?.requiredChangedPaths?.length ?? 0) > 0;
}

function normalizeWorkspacePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

function normalizeRequiredPath(value: string, ctx: KodaXToolExecutionContext): string {
  const root = ctx.gitRoot ? path.resolve(ctx.gitRoot) : undefined;
  const candidate = path.isAbsolute(value) && root
    ? path.relative(root, path.resolve(value))
    : value;
  return normalizeWorkspacePath(candidate);
}

function resolveVerificationForInput(
  input: WorkflowSpawnAgentInput,
): ResolvedVerification {
  const writeDefault: WorkflowTaskVerification | undefined = (input.readOnly ?? false) === false
    ? {
        enforcement: 'warn',
        requiresMutation: true,
        rejectPreparatoryFinalText: true,
      }
    : undefined;
  if (input.verification !== undefined) {
    const merged = {
      ...(writeDefault ?? {}),
      ...input.verification,
      enforcement: input.verification.enforcement ?? 'hard',
    };
    const requiredChangedPaths = input.verification.requiredChangedPaths;
    return {
      verification: {
        ...merged,
        ...(requiredChangedPaths !== undefined &&
          requiredChangedPaths.length > 0 &&
          merged.requiresMutation === undefined
          ? { requiresMutation: true }
          : {}),
      },
    };
  }
  return { verification: writeDefault };
}

function isPreparatoryOnlyText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && PREPARATORY_FINAL_TEXT_RE.test(trimmed);
}

function selectWorkflowFinalText(childSummary: string, digest: string | undefined): string {
  const summary = childSummary.trim();
  const cleanDigest = digest?.trim();
  if (cleanDigest && (summary.length === 0 || isPreparatoryOnlyText(summary))) {
    return cleanDigest;
  }
  return childSummary;
}

async function runGit(args: readonly string[], cwd: string): Promise<string> {
  const result = await execFileAsync('git', [...args], {
    cwd,
    timeout: GIT_STATUS_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout.toString();
}

async function listGitChangedFiles(ctx: KodaXToolExecutionContext): Promise<readonly string[]> {
  const cwd = ctx.gitRoot ?? ctx.executionCwd ?? process.cwd();
  const root = (await runGit(['rev-parse', '--show-toplevel'], cwd)).trim();
  const outputs = await Promise.all([
    runGit(['diff', '--name-only', '--'], root),
    runGit(['diff', '--cached', '--name-only', '--'], root),
    runGit(['ls-files', '--others', '--exclude-standard'], root),
  ]);
  return [
    ...new Set(
      outputs
        .flatMap((output) => output.split(/\r?\n/))
        .map(normalizeWorkspacePath)
        .filter((item) => item.length > 0),
    ),
  ];
}

async function captureChangedPaths(
  ctx: KodaXToolExecutionContext,
  listChangedFiles: (ctx: KodaXToolExecutionContext) => Promise<readonly string[]>,
): Promise<ChangedPathSnapshot> {
  try {
    const paths = await listChangedFiles(ctx);
    return { paths: paths.map(normalizeWorkspacePath).filter((item) => item.length > 0) };
  } catch (error) {
    return {
      paths: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function createMutationRecorder(): MutationRecorder {
  return {
    toolNameById: new Map(),
    toolPathById: new Map(),
    succeededToolCalls: [],
    succeededPaths: [],
  };
}

function readMutationPath(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  for (const key of ['path', 'file_path', 'target_path']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return normalizeWorkspacePath(value);
    }
  }
  return undefined;
}

function wrapEventsForMutationRecording(
  original: KodaXEvents | undefined,
  recorder: MutationRecorder,
): KodaXEvents {
  return {
    ...(original ?? {}),
    onToolUseStart: (tool, meta) => {
      if (MUTATING_TOOL_NAMES.has(tool.name)) {
        recorder.toolNameById.set(tool.id, tool.name);
        const targetPath = readMutationPath(tool.input);
        if (targetPath !== undefined) {
          recorder.toolPathById.set(tool.id, targetPath);
        }
      }
      original?.onToolUseStart?.(tool, meta);
    },
    onToolResult: (result, meta) => {
      const toolName = recorder.toolNameById.get(result.id) ?? result.name;
      if (
        MUTATING_TOOL_NAMES.has(toolName) &&
        !result.content.trimStart().startsWith('[Tool Error]')
      ) {
        recorder.succeededToolCalls.push(toolName);
        const targetPath = recorder.toolPathById.get(result.id);
        if (targetPath !== undefined) {
          recorder.succeededPaths.push(targetPath);
        }
      }
      original?.onToolResult?.(result, meta);
    },
  };
}

function uniqueItems(items: readonly string[]): readonly string[] {
  return [...new Set(items.filter((item) => item.trim().length > 0))];
}

function evaluateVerification(input: {
  readonly verification: WorkflowTaskVerification | undefined;
  readonly term: ReturnType<typeof deriveTerminal>;
  readonly before: ChangedPathSnapshot;
  readonly after: ChangedPathSnapshot;
  readonly mutationRecorder: MutationRecorder;
  readonly ctx: KodaXToolExecutionContext;
  readonly acceptToolMutationEvidence: boolean;
}): WorkflowTaskVerificationResult | undefined {
  const verification = input.verification;
  if (!verification) return undefined;

  const reasons: string[] = [];
  const beforePaths = new Set(input.before.paths.map(normalizeWorkspacePath));
  const afterPaths = uniqueItems(input.after.paths.map(normalizeWorkspacePath));
  const newlyChangedPaths = afterPaths.filter((item) => !beforePaths.has(item));
  const observedToolCalls = uniqueItems(input.mutationRecorder.succeededToolCalls);
  const toolCalls = input.acceptToolMutationEvidence ? observedToolCalls : [];
  const toolPaths = input.acceptToolMutationEvidence
    ? uniqueItems(input.mutationRecorder.succeededPaths.map(normalizeWorkspacePath))
    : [];
  const mutationEvidence = newlyChangedPaths.length > 0 || toolCalls.length > 0;
  const enforcement = verification.enforcement ?? 'hard';
  const requiredPaths = (verification.requiredChangedPaths ?? [])
    .map((item) => normalizeRequiredPath(item, input.ctx));

  if (verification.requiresMutation === true) {
    if (input.before.error !== undefined || input.after.error !== undefined) {
      reasons.push(
        `workspace mutation verification could not read changed files: ${
          input.after.error ?? input.before.error
        }`,
      );
    } else if (!mutationEvidence) {
      reasons.push(
        input.acceptToolMutationEvidence || observedToolCalls.length === 0
          ? 'expected file mutations, but no new workspace changes or successful write tools were observed'
          : 'write tools ran in an isolated worktree, but no main workspace changes were present after cleanup',
      );
    }
  }

  if (input.term.limitReached === true && !mutationEvidence) {
    reasons.push('workflow child reached its iteration limit before satisfying the task');
  }

  for (const requiredPath of requiredPaths) {
    if (!afterPaths.includes(requiredPath) && !toolPaths.includes(requiredPath)) {
      reasons.push(`required changed path was not present in workspace changes: ${requiredPath}`);
    }
  }

  const minFinalTextChars = verification.minFinalTextChars;
  if (
    minFinalTextChars !== undefined &&
    !mutationEvidence &&
    input.term.finalText.trim().length < minFinalTextChars
  ) {
    reasons.push(
      `finalText was shorter than the required ${minFinalTextChars} characters`,
    );
  }

  if (
    verification.rejectPreparatoryFinalText === true &&
    !mutationEvidence &&
    isPreparatoryOnlyText(input.term.finalText)
  ) {
    reasons.push('finalText looks preparatory instead of terminal');
  }

  return {
    ok: reasons.length === 0,
    enforcement,
    reasons,
    changedPaths: afterPaths,
    mutationToolCalls: observedToolCalls,
    mutationEvidence,
  };
}

function appendVerificationFailure(
  finalText: string,
  verification: WorkflowTaskVerificationResult,
): string {
  if (verification.ok) return finalText;
  const header = verification.enforcement === 'warn'
    ? '[Workflow task completed without verification]'
    : '[Workflow task verification failed]';
  const suffix = [
    header,
    ...verification.reasons.map((reason) => `- ${reason}`),
  ].join('\n');
  return finalText.trim().length > 0 ? `${finalText}\n\n${suffix}` : suffix;
}

function limitReachedWarningVerification(): WorkflowTaskVerificationResult {
  return {
    ok: false,
    enforcement: 'warn',
    reasons: ['workflow child reached its iteration limit before satisfying the task'],
    mutationEvidence: false,
  };
}

function shouldRepairVerificationFailure(input: {
  readonly entry: TaskEntry;
  readonly term: ReturnType<typeof deriveTerminal>;
  readonly verification: WorkflowTaskVerificationResult | undefined;
}): boolean {
  return input.entry.bundle.readOnly !== true &&
    input.entry.repairAttempts < DEFAULT_VERIFICATION_REPAIR_ATTEMPTS &&
    input.term.status === 'completed' &&
    input.verification !== undefined &&
    input.verification.ok !== true &&
    input.verification.enforcement !== 'warn';
}

function buildVerificationRepairPrompt(input: {
  readonly originalPrompt: string;
  readonly previousFinalText: string;
  readonly verification: WorkflowTaskVerificationResult;
  readonly attempt: number;
}): string {
  const reasons = input.verification.reasons.map((reason) => `- ${reason}`).join('\n');
  const changedPaths = (input.verification.changedPaths ?? []).length > 0
    ? `\nWorkspace changes already present before this repair attempt:\n${
        input.verification.changedPaths?.map((item) => `- ${item}`).join('\n') ?? ''
      }`
    : '';
  return [
    input.originalPrompt,
    '',
    '[Workflow verification repair]',
    `Repair attempt ${input.attempt}/${DEFAULT_VERIFICATION_REPAIR_ATTEMPTS}.`,
    'The previous attempt did not satisfy the workflow postconditions.',
    'Do not stop at analysis, planning, or a promise to begin. Complete the required file writes in the real workspace now.',
    'Use the available file editing tools when a file change is required, then report the exact files changed.',
    '',
    'Verification failures:',
    reasons,
    changedPaths,
    '',
    'Previous terminal response:',
    input.previousFinalText.trim() || '(empty)',
  ].join('\n');
}

async function waitForChildPromise(
  promise: Promise<KodaXChildExecutionResult>,
  taskId: string,
  timeoutMs: number | undefined,
  ctx: KodaXToolExecutionContext,
  timeoutLabelMs: number | undefined = timeoutMs,
): Promise<KodaXChildExecutionResult> {
  if (timeoutMs === undefined) return promise;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<KodaXChildExecutionResult>((_resolve, reject) => {
        timer = setTimeout(() => {
          ctx.childAbortControllers?.get(taskId)?.abort();
          reject(new Error(`workflow task ${taskId} timed out after ${timeoutLabelMs ?? timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function buildBundle(childId: string, input: WorkflowSpawnAgentInput): KodaXChildContextBundle {
  return {
    id: childId,
    fanoutClass: 'evidence-scan',
    objective: input.prompt,
    readOnly: input.readOnly ?? false,
    evidenceRefs: input.evidenceRefs ? [...input.evidenceRefs] : [],
    constraints: [],
    ...(input.modelHint ? { modelHint: input.modelHint } : {}),
    ...(input.isolation ? { isolation: input.isolation } : {}),
    ...(input.subagentType ? { specialistName: input.subagentType } : {}),
  };
}

/** Derive workflow-level terminal status + final text from a single-bundle
 *  execution result. */
function deriveTerminal(
  result: KodaXChildExecutionResult,
  taskId: string,
): {
  status: WorkflowTaskStatus;
  snapStatus: ChildProgressStatus;
  finalText: string;
  digest?: string;
  digestFailed?: boolean;
  digestPending?: boolean;
  limitReached?: boolean;
  provider?: string;
  model?: string;
} {
  if (result.cancelledChildren.includes(taskId)) {
    return { status: 'stopped', snapStatus: 'aborted', finalText: '' };
  }
  const child = result.results[0];
  const finalText = selectWorkflowFinalText(child?.summary ?? '', child?.digest);
  if (child?.status === 'completed') {
    return {
      status: 'completed',
      snapStatus: 'completed',
      finalText,
      ...(child.digest ? { digest: child.digest } : {}),
      ...(child.digestFailed ? { digestFailed: true } : {}),
      ...(child.digestPending ? { digestPending: true } : {}),
      ...(child.limitReached ? { limitReached: true } : {}),
      ...(child.provider ? { provider: child.provider } : {}),
      ...(child.model ? { model: child.model } : {}),
    };
  }
  return {
    status: 'failed',
    snapStatus: 'failed',
    finalText,
    ...(child?.limitReached ? { limitReached: true } : {}),
    ...(child?.provider ? { provider: child.provider } : {}),
    ...(child?.model ? { model: child.model } : {}),
  };
}

/**
 * Build a `WorkflowAgentBackend` over the coding child-dispatch substrate.
 */
export function createCodingWorkflowBackend(deps: CodingWorkflowBackendDeps): WorkflowAgentBackend {
  const { ctx, childOptions } = deps;
  const runChild = deps.runChild ?? executeChildAgents;
  const queue = deps.queue ?? getMessageQueue();
  const listChangedFiles = deps.listChangedFiles ?? listGitChangedFiles;
  const now = deps.now ?? (() => Date.now());
  let counter = 0;
  const genId = deps.generateId ?? (() => `wf-child-${(counter += 1)}`);

  const tasks = new Map<string, TaskEntry>();
  const summarySubscribers = new Set<(
    taskId: string,
    update: WorkflowTaskSummaryEventUpdate,
  ) => void>();
  // Registry used ONLY for routeMessage target validation; auto-cleared on
  // settle by registerChildTask. `tasks` (above) persists for wait/output.
  const registry: ChildTaskRegistry<KodaXChildExecutionResult> = new Map();

  const hasTaskSummaryObservers = (): boolean =>
    deps.onTaskSummary !== undefined || summarySubscribers.size > 0;

  const notifyTaskSummary = (
    taskId: string,
    update: WorkflowTaskSummaryEventUpdate,
  ): void => {
    try {
      deps.onTaskSummary?.(taskId, update);
    } catch {
      // Late digest subscribers are observers.
    }
    for (const subscriber of summarySubscribers) {
      try {
        subscriber(taskId, update);
      } catch {
        // Late digest subscribers are observers.
      }
    }
  };

  const spawn = async (input: WorkflowSpawnAgentInput): Promise<WorkflowTaskHandle> => {
    const childId = genId();
    const bundle = buildBundle(childId, input);
    const resolvedVerification = resolveVerificationForInput(input);
    const verification = resolvedVerification.verification;
    const mutationRecorder = createMutationRecorder();
    const acceptToolMutationEvidence = input.isolation !== 'worktree';
    const changedPathBaseline = hasVerificationWork(verification)
      ? captureChangedPaths(ctx, listChangedFiles)
      : Promise.resolve({ paths: [] });
    const snapshotMap = ctx.childProgressSnapshots;
    const runBundle = async (runBundleInput: KodaXChildContextBundle): Promise<KodaXChildExecutionResult> => {
      const abort = new AbortController();
      ctx.childAbortControllers?.set(childId, abort);
    if (snapshotMap) {
      initChildSnapshot(snapshotMap, {
        childId,
        startedAt: now(),
        maxIterations: childOptions.maxIterationsPerChild,
        parentRole: childOptions.parentRole,
        readOnly: runBundleInput.readOnly,
        specialistName: runBundleInput.specialistName,
      });
    }
    const perChild: ChildExecutorOptions = {
      ...childOptions,
      parentOptions: {
        ...childOptions.parentOptions,
        events: wrapEventsForMutationRecording(
          childOptions.parentOptions.events,
          mutationRecorder,
        ),
      },
      maxParallel: 1,
      // FEATURE_217 — every child launched through the workflow backend gets the
      // self-distill digest. This is the single workflow boundary, so it marks
      // workflow children without overloading `parentHarness` (which stays
      // 'tool-dispatch' so write children are not dropped by validateWriteBundles).
      workflowChild: true,
      ...(deps.runId !== undefined
        ? {
            workflowCorrelation: {
              workflowRunId: deps.runId,
              childAgentId: childId,
              itemId: `agent:${childId}`,
            },
          }
        : {}),
      childActivityName: input.name,
      workflowDigestMode: hasTaskSummaryObservers() ? 'async' : 'blocking',
      ...(hasTaskSummaryObservers()
        ? {
            onWorkflowChildDigest: (update) => {
              notifyTaskSummary(update.childId, {
                ...(update.digest ? { summary: update.digest } : {}),
                summaryKind: update.digest ? 'digest' : 'digest-failed',
                ...(update.totalTokensUsed > 0
                  ? { usage: { totalTokens: update.totalTokensUsed } }
                  : {}),
              });
            },
          }
        : {}),
      abortSignal: abort.signal,
      snapshotUpdater: snapshotMap
        ? (event) => applyChildSnapshotEvent(snapshotMap, childId, event)
        : undefined,
    };

      let result: KodaXChildExecutionResult | undefined;
      try {
        await changedPathBaseline;
        result = await runChild([runBundleInput], ctx, perChild);
        return result;
      } finally {
        ctx.childAbortControllers?.delete(childId);
        if (snapshotMap) {
          const term = result
            ? deriveTerminal(result, childId)
            : { snapStatus: 'failed' as ChildProgressStatus, finalText: '' };
          finalizeChildSnapshot(snapshotMap, childId, {
            status: term.snapStatus,
            finalText: term.finalText,
            endedAt: now(),
          });
        }
      }
    };

    const promise = runBundle(bundle);

    tasks.set(childId, {
      name: input.name,
      input,
      bundle,
      promise,
      runBundle,
      verification,
      changedPathBaseline,
      mutationRecorder,
      acceptToolMutationEvidence,
      repairAttempts: 0,
    });
    registerChildTask(registry, childId, promise);
    return { taskId: childId, name: input.name };
  };

  const wait = async (
    taskId: string,
    opts?: WorkflowWaitOptions,
  ): Promise<WorkflowTaskResult> => {
    const entry = tasks.get(taskId);
    if (!entry) throw new Error(`unknown workflow task: ${taskId}`);
    const totalWaitTimeoutMs = normalizeWaitTimeoutMs(opts);
    const waitStartedAt = Date.now();
    const waitForAttempt = async (
      promise: Promise<KodaXChildExecutionResult>,
    ): Promise<KodaXChildExecutionResult> => {
      if (totalWaitTimeoutMs === undefined) {
        return waitForChildPromise(promise, taskId, undefined, ctx);
      }
      const elapsedMs = Date.now() - waitStartedAt;
      const remainingMs = totalWaitTimeoutMs - elapsedMs;
      if (remainingMs <= 0) {
        ctx.childAbortControllers?.get(taskId)?.abort();
        throw new Error(`workflow task ${taskId} timed out after ${totalWaitTimeoutMs}ms`);
      }
      return waitForChildPromise(
        promise,
        taskId,
        Math.max(1, Math.floor(remainingMs)),
        ctx,
        totalWaitTimeoutMs,
      );
    };
    let result = await waitForAttempt(entry.promise);
    let totalTokensUsed = result.totalTokensUsed;
    let term = deriveTerminal(result, taskId);
    let verification = entry.verification
      ? evaluateVerification({
          verification: entry.verification,
          term,
          before: await entry.changedPathBaseline,
          after: hasVerificationWork(entry.verification)
            ? await captureChangedPaths(ctx, listChangedFiles)
            : { paths: [] },
          mutationRecorder: entry.mutationRecorder,
          ctx,
          acceptToolMutationEvidence: entry.acceptToolMutationEvidence,
        })
      : undefined;
    if (term.limitReached === true && verification === undefined && term.status === 'completed') {
      verification = limitReachedWarningVerification();
      term = {
        ...term,
        status: 'completed_unverified',
        snapStatus: 'completed',
        finalText: appendVerificationFailure(term.finalText, verification),
      };
    }
    while (shouldRepairVerificationFailure({ entry, term, verification })) {
      entry.repairAttempts += 1;
      const repairBundle = buildBundle(taskId, {
        ...entry.input,
        prompt: buildVerificationRepairPrompt({
          originalPrompt: entry.input.prompt,
          previousFinalText: term.finalText,
          verification: verification!,
          attempt: entry.repairAttempts,
        }),
      });
      entry.promise = entry.runBundle(repairBundle);
      registerChildTask(registry, taskId, entry.promise);
      result = await waitForAttempt(entry.promise);
      totalTokensUsed += result.totalTokensUsed;
      term = deriveTerminal(result, taskId);
      verification = entry.verification
        ? evaluateVerification({
            verification: entry.verification,
            term,
            before: await entry.changedPathBaseline,
            after: hasVerificationWork(entry.verification)
              ? await captureChangedPaths(ctx, listChangedFiles)
              : { paths: [] },
            mutationRecorder: entry.mutationRecorder,
            ctx,
            acceptToolMutationEvidence: entry.acceptToolMutationEvidence,
          })
        : undefined;
      if (term.limitReached === true && verification === undefined && term.status === 'completed') {
        verification = limitReachedWarningVerification();
        term = {
          ...term,
          status: 'completed_unverified',
          snapStatus: 'completed',
          finalText: appendVerificationFailure(term.finalText, verification),
        };
      }
    }
    if (verification !== undefined && !verification.ok && term.status === 'completed') {
      const warnOnly = verification.enforcement === 'warn';
      term = {
        ...term,
        status: warnOnly ? 'completed_unverified' : 'failed',
        snapStatus: warnOnly ? 'completed' : 'failed',
        finalText: appendVerificationFailure(term.finalText, verification),
      };
    }
    finalizeChildSnapshot(ctx.childProgressSnapshots, taskId, {
      status: term.snapStatus,
      finalText: term.finalText,
      endedAt: now(),
    });
    return {
      taskId,
      name: entry.name,
      status: term.status,
      finalText: term.finalText,
      ...(term.digest ? { digest: term.digest } : {}),
      ...(term.digestFailed ? { digestFailed: true } : {}),
      ...(term.digestPending ? { digestPending: true } : {}),
      ...(verification !== undefined ? { verification } : {}),
      ...(term.limitReached ? { limitReached: true } : {}),
      ...(term.provider ? { provider: term.provider } : {}),
      ...(term.model ? { model: term.model } : {}),
      usage: { totalTokens: totalTokensUsed },
    };
  };

  const output = async (taskId: string): Promise<WorkflowTaskSnapshot> => {
    const name = tasks.get(taskId)?.name ?? taskId;
    const snap = ctx.childProgressSnapshots?.get(taskId);
    if (!snap) return { taskId, name, status: 'running' };
    const status: WorkflowTaskStatus = snap.status === 'aborted' ? 'stopped' : snap.status;
    return snap.finalText !== undefined
      ? { taskId, name, status, lastText: snap.finalText }
      : { taskId, name, status };
  };

  const send = async (taskId: string, content: string): Promise<void> => {
    routeMessage({ to: taskId, priority: 'user', mode: 'prompt', content, registry, queue });
  };

  const stop = async (taskId: string): Promise<void> => {
    ctx.childAbortControllers?.get(taskId)?.abort();
  };

  // NOTE: no `synthesize` here — `wf.synthesize` runs as a gated agent in
  // the runtime (through spawn/wait) so it counts toward maxAgents /
  // concurrency / budget and emits run-graph events.
  return {
    spawn,
    wait,
    output,
    send,
    stop,
    subscribeTaskSummaryUpdates: (listener) => {
      summarySubscribers.add(listener);
      return () => {
        summarySubscribers.delete(listener);
      };
    },
  };
}
