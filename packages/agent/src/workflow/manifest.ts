import type { WorkflowMeta } from './types.js';

export const WORKFLOW_PATTERN_IDS = [
  'classify-and-act',
  'fan-out-and-synthesize',
  'adversarial-verification',
  'generate-and-filter',
  'tournament',
  'loop-until-done',
] as const;

export type WorkflowPatternId = (typeof WORKFLOW_PATTERN_IDS)[number];

export interface WorkflowScriptManifest extends WorkflowMeta {
  readonly phases: readonly string[];
  readonly readOnly: boolean;
  readonly maxAgents: number;
  readonly maxConcurrency: number;
  readonly tokenBudget?: number;
  readonly mayUseWorktree?: boolean;
  readonly patterns: readonly WorkflowPatternId[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`workflow manifest ${key} must be a non-empty string`);
  }
  return value;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') {
    throw new Error(`workflow manifest ${key} must be a boolean`);
  }
  return value;
}

function readPositiveInt(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (!Number.isInteger(value) || typeof value !== 'number' || value <= 0) {
    throw new Error(`workflow manifest ${key} must be a positive integer`);
  }
  return value;
}

function readOptionalPositiveInt(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || typeof value !== 'number' || value <= 0) {
    throw new Error(`workflow manifest ${key} must be a positive integer when provided`);
  }
  return value;
}

function readStringArray(record: Record<string, unknown>, key: string): readonly string[] {
  const value = record[key];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item): item is string => typeof item === 'string' && item.trim().length > 0)
  ) {
    throw new Error(`workflow manifest ${key} must be a non-empty string array`);
  }
  return value;
}

function isWorkflowPatternId(value: string): value is WorkflowPatternId {
  return WORKFLOW_PATTERN_IDS.includes(value as WorkflowPatternId);
}

function readPatternArray(
  record: Record<string, unknown>,
): readonly WorkflowPatternId[] {
  const values = readStringArray(record, 'patterns');
  const patterns: WorkflowPatternId[] = [];
  for (const value of values) {
    if (!isWorkflowPatternId(value)) {
      throw new Error(`workflow manifest patterns contains unsupported id: ${value}`);
    }
    patterns.push(value);
  }
  return patterns;
}

export function validateWorkflowScriptManifest(value: unknown): WorkflowScriptManifest {
  if (!isRecord(value)) {
    throw new Error('workflow manifest must be an object');
  }

  const tokenBudget = readOptionalPositiveInt(value, 'tokenBudget');
  const mayUseWorktree = value.mayUseWorktree;
  if (mayUseWorktree !== undefined && typeof mayUseWorktree !== 'boolean') {
    throw new Error('workflow manifest mayUseWorktree must be a boolean when provided');
  }

  return {
    name: readString(value, 'name'),
    description: readString(value, 'description'),
    phases: readStringArray(value, 'phases'),
    readOnly: readBoolean(value, 'readOnly'),
    maxAgents: readPositiveInt(value, 'maxAgents'),
    maxConcurrency: readPositiveInt(value, 'maxConcurrency'),
    ...(tokenBudget !== undefined ? { tokenBudget } : {}),
    ...(mayUseWorktree !== undefined ? { mayUseWorktree } : {}),
    patterns: readPatternArray(value),
  };
}
