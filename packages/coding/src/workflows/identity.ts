import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import {
  discoverSavedWorkflows,
  type SavedWorkflowDirs,
  type SavedWorkflowRef,
} from './discovery.js';

export type WorkflowIdentityResolution =
  | {
      readonly kind: 'run';
      readonly target: string;
      readonly runId: string;
      readonly runDir: string;
      readonly workflowName?: string;
      readonly displayName?: string;
    }
  | {
      readonly kind: 'saved';
      readonly target: string;
      readonly savedWorkflow: SavedWorkflowRef;
    }
  | {
      readonly kind: 'ambiguous';
      readonly target: string;
      readonly matches: readonly ('run' | 'saved')[];
      readonly run?: Extract<WorkflowIdentityResolution, { readonly kind: 'run' }>;
      readonly savedWorkflow?: SavedWorkflowRef;
    }
  | {
      readonly kind: 'missing';
      readonly target: string;
    };

export interface WorkflowIdentityResolverInput {
  readonly target: string;
  readonly runBaseDir?: string;
  readonly savedWorkflowDirs?: SavedWorkflowDirs;
}

function isSafeWorkflowRunId(runId: string): boolean {
  return runId !== '.' && /^[a-zA-Z0-9._-]+$/.test(runId) && !runId.includes('..');
}

function safeRunDir(baseDir: string, runId: string): string | undefined {
  if (!isSafeWorkflowRunId(runId)) return undefined;
  const base = resolve(baseDir);
  const target = resolve(base, runId);
  return target.startsWith(`${base}${sep}`) ? target : undefined;
}

function readRunRecord(runDir: string): Record<string, unknown> | undefined {
  const path = join(runDir, 'run.json');
  if (!existsSync(path)) return undefined;
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return typeof data === 'object' && data !== null
      ? data as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function readMetadataDisplayName(runDir: string): string | undefined {
  const path = join(runDir, 'workflow-metadata.json');
  if (!existsSync(path)) return undefined;
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (typeof data !== 'object' || data === null) return undefined;
    const displayName = (data as Record<string, unknown>).displayName;
    return typeof displayName === 'string' && displayName.trim().length > 0
      ? displayName
      : undefined;
  } catch {
    return undefined;
  }
}

function readRunJsonDisplayName(record: Record<string, unknown>): string | undefined {
  const displayName = record.displayName;
  return typeof displayName === 'string' && displayName.trim().length > 0
    ? displayName
    : undefined;
}

function displayNameMatches(displayName: string | undefined, target: string): boolean {
  return displayName?.trim() === target;
}

function resolveRun(
  target: string,
  runBaseDir: string | undefined,
): Extract<WorkflowIdentityResolution, { readonly kind: 'run' }> | undefined {
  if (!runBaseDir) return undefined;
  const dir = safeRunDir(runBaseDir, target);
  if (!dir) return undefined;
  const record = readRunRecord(dir);
  if (!record) return undefined;
  const workflow = record.workflow;
  const displayName = readMetadataDisplayName(dir) ?? readRunJsonDisplayName(record);
  return {
    kind: 'run',
    target,
    runId: target,
    runDir: dir,
    ...(typeof workflow === 'string' && workflow.length > 0 ? { workflowName: workflow } : {}),
    ...(displayName !== undefined ? { displayName } : {}),
  };
}

function resolveRunsByDisplayName(
  target: string,
  runBaseDir: string | undefined,
): readonly Extract<WorkflowIdentityResolution, { readonly kind: 'run' }>[] {
  if (!runBaseDir || !existsSync(runBaseDir)) return [];
  const matches: Extract<WorkflowIdentityResolution, { readonly kind: 'run' }>[] = [];
  for (const entry of readdirSync(runBaseDir)) {
    if (!isSafeWorkflowRunId(entry)) continue;
    const run = resolveRun(entry, runBaseDir);
    if (run && displayNameMatches(run.displayName, target)) matches.push(run);
  }
  return matches;
}

async function resolveSaved(
  target: string,
  savedWorkflowDirs: SavedWorkflowDirs | undefined,
): Promise<SavedWorkflowRef | undefined> {
  if (!savedWorkflowDirs) return undefined;
  const refs = await discoverSavedWorkflows(savedWorkflowDirs);
  return refs.find((ref) => ref.name === target);
}

export async function resolveWorkflowIdentity(
  input: WorkflowIdentityResolverInput,
): Promise<WorkflowIdentityResolution> {
  const target = input.target.trim();
  if (!target) return { kind: 'missing', target: input.target };
  const run = resolveRun(target, input.runBaseDir);
  const displayNameRuns = run ? [] : resolveRunsByDisplayName(target, input.runBaseDir);
  const saved = await resolveSaved(target, input.savedWorkflowDirs);
  const runMatches = run ? [run] : displayNameRuns;
  if (runMatches.length > 1) {
    return {
      kind: 'ambiguous',
      target,
      matches: saved ? ['run', 'saved'] : ['run'],
      ...(saved ? { savedWorkflow: saved } : {}),
    };
  }
  if (runMatches.length === 1 && saved) {
    return {
      kind: 'ambiguous',
      target,
      matches: ['run', 'saved'],
      run: runMatches[0]!,
      savedWorkflow: saved,
    };
  }
  if (run) return run;
  if (displayNameRuns.length === 1) return displayNameRuns[0]!;
  if (saved) return { kind: 'saved', target, savedWorkflow: saved };
  return { kind: 'missing', target };
}
