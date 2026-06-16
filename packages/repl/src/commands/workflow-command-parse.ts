import type { WorkflowCapsule } from '@kodax-ai/agent';

export type WorkflowInvocation =
  | { readonly kind: 'help' }
  | { readonly kind: 'list' }
  | { readonly kind: 'runs'; readonly rawArgs: readonly string[] }
  | { readonly kind: 'show'; readonly runId: string; readonly full?: boolean }
  | { readonly kind: 'pause'; readonly runId: string }
  | { readonly kind: 'resume'; readonly runId: string }
  | { readonly kind: 'stop'; readonly runId: string }
  | { readonly kind: 'delete'; readonly runId: string; readonly force?: boolean }
  | { readonly kind: 'prune'; readonly rawArgs: readonly string[] }
  | { readonly kind: 'save'; readonly runId: string; readonly name: string }
  | { readonly kind: 'rename'; readonly target: string; readonly newName: string }
  | { readonly kind: 'revise'; readonly target: string; readonly request: string; readonly replace?: boolean }
  | { readonly kind: 'rerun'; readonly runId: string; readonly rawArgs: string }
  | { readonly kind: 'create'; readonly request: string }
  | { readonly kind: 'start'; readonly name: string; readonly rawArgs: string };

export const DEFAULT_WORKFLOW_RUNS_LIMIT = 20;
export const DEFAULT_WORKFLOW_PRUNE_KEEP = 50;
const MAX_WORKFLOW_RUNS_LIMIT = 200;

export function parseWorkflowInvocation(args: readonly string[]): WorkflowInvocation {
  const first = args[0]?.toLowerCase();
  if (first === 'help' || first === '--help' || first === '-h') return { kind: 'help' };
  if (!first || first === 'list') return { kind: 'list' };
  if (first === 'runs') return { kind: 'runs', rawArgs: args.slice(1) };
  if (first === 'show') {
    const rest = args.slice(1);
    const full = rest.includes('--full');
    const runId = rest.find((arg) => arg !== '--full') ?? '';
    return full ? { kind: 'show', runId, full: true } : { kind: 'show', runId };
  }
  if (first === 'pause') return { kind: 'pause', runId: args[1] ?? '' };
  if (first === 'resume') return { kind: 'resume', runId: args[1] ?? '' };
  if (first === 'stop') return { kind: 'stop', runId: args[1] ?? '' };
  if (first === 'delete') {
    const rest = args.slice(1);
    const force = rest.includes('--force');
    const runId = rest.find((arg) => arg !== '--force') ?? '';
    return force ? { kind: 'delete', runId, force: true } : { kind: 'delete', runId };
  }
  if (first === 'prune') return { kind: 'prune', rawArgs: args.slice(1) };
  if (first === 'save') return { kind: 'save', runId: args[1] ?? '', name: args[2] ?? '' };
  if (first === 'rename') {
    return { kind: 'rename', target: args[1] ?? '', newName: args.slice(2).join(' ').trim() };
  }
  if (first === 'revise') {
    const raw = args.slice(1);
    const replace = raw.includes('--replace');
    const cleaned = raw.filter((arg) => arg !== '--replace');
    return {
      kind: 'revise',
      target: cleaned[0] ?? '',
      request: cleaned.slice(1).join(' ').trim(),
      ...(replace ? { replace: true } : {}),
    };
  }
  if (first === 'rerun') {
    return { kind: 'rerun', runId: args[1] ?? '', rawArgs: args.slice(2).join(' ').trim() };
  }
  if (first === 'create') return { kind: 'create', request: args.slice(1).join(' ').trim() };
  return { kind: 'start', name: args[0]!, rawArgs: args.slice(1).join(' ').trim() };
}

/** Parse the trailing args: JSON object, or bare text into `{ question }`. */
export function parseWorkflowArgs(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return { question: trimmed };
    }
  }
  return { question: trimmed };
}

export function buildWorkflowRevisionRequest(input: {
  readonly target: string;
  readonly capsule: WorkflowCapsule;
  readonly changeRequest: string;
}): string {
  return [
    'Revise this existing KodaX dynamic workflow capsule.',
    'Return a complete revised workflow, not a patch.',
    'Preserve the reusable workflow intent, safety requirements, and compatible args shape unless the requested change explicitly requires otherwise.',
    '',
    `Target: ${input.target}`,
    '',
    'Original manifest:',
    JSON.stringify(input.capsule.manifest, null, 2),
    '',
    'Original source:',
    '```js',
    input.capsule.source,
    '```',
    '',
    `Change request: ${input.changeRequest}`,
  ].join('\n');
}

function parseNonNegativeInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export interface WorkflowRunsOptions {
  readonly all: boolean;
  readonly limit: number;
  readonly error?: string;
}

export function parseWorkflowRunsOptions(args: readonly string[]): WorkflowRunsOptions {
  let all = false;
  let limit = DEFAULT_WORKFLOW_RUNS_LIMIT;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--all') {
      all = true;
      continue;
    }
    if (arg === '--limit') {
      const parsed = parseNonNegativeInteger(args[index + 1]);
      if (parsed === undefined || parsed < 1) {
        return { all, limit, error: '--limit expects a positive integer' };
      }
      limit = Math.min(parsed, MAX_WORKFLOW_RUNS_LIMIT);
      index += 1;
      continue;
    }
    return { all, limit, error: `unknown option: ${arg ?? ''}` };
  }

  return { all, limit };
}

export interface WorkflowPruneOptions {
  readonly dryRun: boolean;
  readonly keep?: number;
  readonly olderThanMs?: number;
  readonly error?: string;
}

function parseOlderThanMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^(\d+)([dh]?)$/i.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isInteger(amount) || amount <= 0) return undefined;
  const unit = match[2]?.toLowerCase() || 'd';
  if (unit === 'h') return amount * 60 * 60 * 1000;
  return amount * 24 * 60 * 60 * 1000;
}

export function parseWorkflowPruneOptions(args: readonly string[]): WorkflowPruneOptions {
  let dryRun = false;
  let keep: number | undefined;
  let olderThanMs: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--keep') {
      const parsed = parseNonNegativeInteger(args[index + 1]);
      if (parsed === undefined) {
        return { dryRun, error: '--keep expects a non-negative integer' };
      }
      keep = parsed;
      index += 1;
      continue;
    }
    if (arg === '--older-than') {
      const parsed = parseOlderThanMs(args[index + 1]);
      if (parsed === undefined) {
        return { dryRun, error: '--older-than expects a value like 7d or 24h' };
      }
      olderThanMs = parsed;
      index += 1;
      continue;
    }
    return { dryRun, error: `unknown option: ${arg ?? ''}` };
  }

  if (dryRun && keep === undefined && olderThanMs === undefined) {
    return { dryRun, keep: DEFAULT_WORKFLOW_PRUNE_KEEP };
  }

  return {
    dryRun,
    ...(keep !== undefined ? { keep } : {}),
    ...(olderThanMs !== undefined ? { olderThanMs } : {}),
  };
}
