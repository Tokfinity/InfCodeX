/**
 * FEATURE_217 (v0.7.49) Phase M — reusable generated workflow capsule.
 *
 * Agent owns only the domain-neutral capsule contract. Persistence,
 * environment preflight, skills, MCP, and REPL UX live in higher layers.
 */

import type { WorkflowModelHint, WorkflowModule } from './types.js';
import type { WorkflowScriptManifest } from './manifest.js';
import { validateWorkflowScriptManifest } from './manifest.js';
import { createRestrictedWorkflowModule } from './script-runner.js';

export const WORKFLOW_CAPSULE_FORMAT = 'kodax.workflow' as const;
export const WORKFLOW_CAPSULE_VERSION = 1 as const;
export const WORKFLOW_CAPSULE_API_VERSION = 1 as const;

export type WorkflowCapsuleEnvironmentRequirement = 'git-repo' | 'worktree-capable';

export interface WorkflowCapsuleIntent {
  readonly taskClass: string;
  readonly originalRequest?: string;
  readonly reusableFor?: readonly string[];
  readonly notFor?: readonly string[];
}

export interface WorkflowCapsuleInputs {
  readonly description: string;
  readonly examples?: readonly unknown[];
}

export interface WorkflowCapsuleRequirements {
  readonly environment?: readonly WorkflowCapsuleEnvironmentRequirement[];
  readonly tools?: readonly string[];
  readonly mcp?: readonly string[];
  readonly skills?: readonly string[];
  readonly modelTiers?: readonly WorkflowModelHint[];
  readonly userInteraction?: boolean;
}

export interface WorkflowCapsuleProvenance {
  readonly fromRunId?: string;
  readonly createdAt: string;
  readonly kodaxVersion: string;
}

export interface WorkflowCapsule {
  readonly format: typeof WORKFLOW_CAPSULE_FORMAT;
  readonly version: typeof WORKFLOW_CAPSULE_VERSION;
  readonly workflowApiVersion: typeof WORKFLOW_CAPSULE_API_VERSION;
  readonly minKodaxVersion: string;
  readonly manifest: WorkflowScriptManifest;
  readonly source: string;
  readonly intent?: WorkflowCapsuleIntent;
  readonly inputs?: WorkflowCapsuleInputs;
  readonly requires?: WorkflowCapsuleRequirements;
  readonly provenance?: WorkflowCapsuleProvenance;
}

export interface CreateWorkflowCapsuleInput {
  readonly minKodaxVersion: string;
  readonly manifest: WorkflowScriptManifest;
  readonly source: string;
  readonly intent?: WorkflowCapsuleIntent;
  readonly inputs?: WorkflowCapsuleInputs;
  readonly requires?: WorkflowCapsuleRequirements;
  readonly provenance?: WorkflowCapsuleProvenance;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readLiteral<T extends string | number>(
  record: Record<string, unknown>,
  key: string,
  expected: T,
): T {
  if (record[key] !== expected) {
    throw new Error(`workflow capsule ${key} must be ${String(expected)}`);
  }
  return expected;
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`workflow capsule ${key} must be a non-empty string`);
  }
  return value;
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`workflow capsule ${key} must be a non-empty string when provided`);
  }
  return value;
}

function readOptionalStringArray(
  record: Record<string, unknown>,
  key: string,
): readonly string[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    !value.every((item): item is string => typeof item === 'string' && item.trim().length > 0)
  ) {
    throw new Error(`workflow capsule ${key} must be a string array when provided`);
  }
  return [...value];
}

function validateIntent(value: unknown): WorkflowCapsuleIntent | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('workflow capsule intent must be an object');
  const originalRequest = readOptionalString(value, 'originalRequest');
  const reusableFor = readOptionalStringArray(value, 'reusableFor');
  const notFor = readOptionalStringArray(value, 'notFor');
  return {
    taskClass: readString(value, 'taskClass'),
    ...(originalRequest !== undefined ? { originalRequest } : {}),
    ...(reusableFor !== undefined ? { reusableFor } : {}),
    ...(notFor !== undefined ? { notFor } : {}),
  };
}

function validateInputs(value: unknown): WorkflowCapsuleInputs | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('workflow capsule inputs must be an object');
  const examples = value.examples;
  if (examples !== undefined && !Array.isArray(examples)) {
    throw new Error('workflow capsule inputs.examples must be an array when provided');
  }
  return {
    description: readString(value, 'description'),
    ...(examples !== undefined ? { examples: [...examples] } : {}),
  };
}

function validateEnvironmentRequirements(
  value: readonly string[] | undefined,
): readonly WorkflowCapsuleEnvironmentRequirement[] | undefined {
  if (value === undefined) return undefined;
  const allowed: readonly WorkflowCapsuleEnvironmentRequirement[] = [
    'git-repo',
    'worktree-capable',
  ];
  const out: WorkflowCapsuleEnvironmentRequirement[] = [];
  for (const item of value) {
    if (!allowed.includes(item as WorkflowCapsuleEnvironmentRequirement)) {
      throw new Error(`workflow capsule environment requirement is unsupported: ${item}`);
    }
    out.push(item as WorkflowCapsuleEnvironmentRequirement);
  }
  return out;
}

function validateModelTiers(value: readonly string[] | undefined): readonly WorkflowModelHint[] | undefined {
  if (value === undefined) return undefined;
  const allowed: readonly WorkflowModelHint[] = ['fast', 'balanced', 'deep'];
  const out: WorkflowModelHint[] = [];
  for (const item of value) {
    if (!allowed.includes(item as WorkflowModelHint)) {
      throw new Error(`workflow capsule model tier is unsupported: ${item}`);
    }
    out.push(item as WorkflowModelHint);
  }
  return out;
}

function validateRequirements(value: unknown): WorkflowCapsuleRequirements | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('workflow capsule requires must be an object');
  const userInteraction = value.userInteraction;
  if (userInteraction !== undefined && typeof userInteraction !== 'boolean') {
    throw new Error('workflow capsule requires.userInteraction must be a boolean when provided');
  }
  const environment = validateEnvironmentRequirements(readOptionalStringArray(value, 'environment'));
  const tools = readOptionalStringArray(value, 'tools');
  const mcp = readOptionalStringArray(value, 'mcp');
  const skills = readOptionalStringArray(value, 'skills');
  const modelTiers = validateModelTiers(readOptionalStringArray(value, 'modelTiers'));
  return {
    ...(environment !== undefined ? { environment } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(mcp !== undefined ? { mcp } : {}),
    ...(skills !== undefined ? { skills } : {}),
    ...(modelTiers !== undefined ? { modelTiers } : {}),
    ...(userInteraction !== undefined ? { userInteraction } : {}),
  };
}

function validateProvenance(value: unknown): WorkflowCapsuleProvenance | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('workflow capsule provenance must be an object');
  const fromRunId = readOptionalString(value, 'fromRunId');
  return {
    ...(fromRunId !== undefined ? { fromRunId } : {}),
    createdAt: readString(value, 'createdAt'),
    kodaxVersion: readString(value, 'kodaxVersion'),
  };
}

export function validateWorkflowCapsule(value: unknown): WorkflowCapsule {
  if (!isRecord(value)) {
    throw new Error('workflow capsule must be an object');
  }
  const intent = validateIntent(value.intent);
  const inputs = validateInputs(value.inputs);
  const requires = validateRequirements(value.requires);
  const provenance = validateProvenance(value.provenance);
  return {
    format: readLiteral(value, 'format', WORKFLOW_CAPSULE_FORMAT),
    version: readLiteral(value, 'version', WORKFLOW_CAPSULE_VERSION),
    workflowApiVersion: readLiteral(
      value,
      'workflowApiVersion',
      WORKFLOW_CAPSULE_API_VERSION,
    ),
    minKodaxVersion: readString(value, 'minKodaxVersion'),
    manifest: validateWorkflowScriptManifest(value.manifest),
    source: readString(value, 'source'),
    ...(intent !== undefined ? { intent } : {}),
    ...(inputs !== undefined ? { inputs } : {}),
    ...(requires !== undefined ? { requires } : {}),
    ...(provenance !== undefined ? { provenance } : {}),
  };
}

export function createWorkflowCapsule(input: CreateWorkflowCapsuleInput): WorkflowCapsule {
  return validateWorkflowCapsule({
    format: WORKFLOW_CAPSULE_FORMAT,
    version: WORKFLOW_CAPSULE_VERSION,
    workflowApiVersion: WORKFLOW_CAPSULE_API_VERSION,
    minKodaxVersion: input.minKodaxVersion,
    manifest: input.manifest,
    source: input.source,
    ...(input.intent !== undefined ? { intent: input.intent } : {}),
    ...(input.inputs !== undefined ? { inputs: input.inputs } : {}),
    ...(input.requires !== undefined ? { requires: input.requires } : {}),
    ...(input.provenance !== undefined ? { provenance: input.provenance } : {}),
  });
}

export function createWorkflowModuleFromCapsule(capsule: WorkflowCapsule): WorkflowModule {
  const validated = validateWorkflowCapsule(capsule);
  return createRestrictedWorkflowModule({
    manifest: validated.manifest,
    source: validated.source,
  });
}
