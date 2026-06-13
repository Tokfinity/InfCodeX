/**
 * Command Arguments Registry - 命令参数注册表
 *
 * Defines argument completions for built-in commands.
 * 为内置命令定义参数补全。
 */

// FEATURE_093 (v0.7.24): import types from ./types.ts to break the
// `argument-completer.ts ↔ command-arguments.ts` cycle.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ArgumentDefinition, CommandArgumentsRegistry } from './types.js';
import { getAgentConfigPath } from '@kodax-ai/agent';
import {
  REPOINTEL_DEFAULT_ENDPOINT,
  getAvailableProviderNames,
  getDefaultWorkflowRunManager,
  isKnownProvider,
  listBuiltinWorkflows,
} from '@kodax-ai/coding';
import { getProviderAvailableModels } from '../../common/utils.js';
import { deriveProjectKeyFromRoot } from '../project-key.js';

/**
 * Mode command arguments - /mode 命令参数
 */
const MODE_ARGS: ArgumentDefinition[] = [
  {
    name: 'plan',
    description: 'Read-only planning mode - blocks all modifications',
    type: 'enum',
  },
  {
    name: 'accept-edits',
    description: 'File edits auto-approved, bash requires confirmation',
    type: 'enum',
  },
  {
    name: 'auto-in-project',
    description: 'All tools auto within project directory',
    type: 'enum',
  },
];

/**
 * Thinking command arguments - /thinking 命令参数
 */
const THINKING_ARGS: ArgumentDefinition[] = [
  {
    name: 'on',
    description: 'Map to reasoning auto',
    type: 'enum',
  },
  {
    name: 'off',
    description: 'Disable reasoning',
    type: 'enum',
  },
  {
    name: 'auto',
    description: 'Use semantic routing with adaptive depth',
    type: 'enum',
  },
  {
    name: 'quick',
    description: 'Low-depth reasoning mode',
    type: 'enum',
  },
  {
    name: 'balanced',
    description: 'Medium-depth reasoning mode',
    type: 'enum',
  },
  {
    name: 'deep',
    description: 'High-depth reasoning mode',
    type: 'enum',
  },
];

const REASONING_ARGS = THINKING_ARGS.slice(2).concat([
  {
    name: 'off',
    description: 'Disable reasoning',
    type: 'enum',
  },
]);

/**
 * Model command arguments - /model 命令参数
 * Dynamically populated from available providers (includes custom providers).
 * Supports two-stage completion: provider names, then provider/model combinations.
 */
function getModelArgs(partial?: string): ArgumentDefinition[] {
  // Two-stage: if partial contains a known provider followed by /, show models for that provider
  if (partial && partial.includes('/')) {
    const slashIdx = partial.indexOf('/');
    const providerName = partial.slice(0, slashIdx);
    const modelPartial = partial.slice(slashIdx + 1);
    if (isKnownProvider(providerName)) {
      try {
        const models = getProviderAvailableModels(providerName);
        return models
          .filter(m => !modelPartial || m.toLowerCase().includes(modelPartial.toLowerCase()))
          .map(m => ({
            name: `${providerName}/${m}`,
            description: m,
            type: 'enum' as const,
          }));
      } catch { /* fall through */ }
    }
    // Unknown provider with / format — no completions
    return [];
  }
  // Default: show provider names
  return getAvailableProviderNames().map(
    (provider) => ({
      name: provider,
      description: `Switch to ${provider} provider`,
      type: 'enum' as const,
    })
  );
}

/**
 * Plan command arguments - /plan 命令参数
 */
const PLAN_ARGS: ArgumentDefinition[] = [
  {
    name: 'on',
    description: 'Enable plan mode for all requests',
    type: 'enum',
  },
  {
    name: 'off',
    description: 'Disable plan mode',
    type: 'enum',
  },
  {
    name: 'once',
    description: 'Run plan mode for a single request (followed by task)',
    type: 'enum',
  },
  {
    name: 'list',
    description: 'List all saved plans',
    type: 'enum',
  },
  {
    name: 'resume',
    description: 'Resume a saved plan (followed by plan ID)',
    type: 'enum',
  },
  {
    name: 'clear',
    description: 'Clear completed plans',
    type: 'enum',
  },
];

const STATUS_ARGS: ArgumentDefinition[] = [
  {
    name: 'workspace',
    description: 'Inspect current workspace/runtime truth in more detail',
    type: 'enum',
  },
  {
    name: 'runtime',
    description: 'Alias for workspace runtime inspection',
    type: 'enum',
  },
  {
    name: 'worktree',
    description: 'Alias for workspace runtime inspection',
    type: 'enum',
  },
];

/**
 * Delete command arguments - /delete 命令参数
 */
const DELETE_ARGS: ArgumentDefinition[] = [
  {
    name: 'all',
    description: 'Delete ALL sessions',
    type: 'enum',
  },
];

const REPOINTEL_SUBCOMMAND_ARGS: ArgumentDefinition[] = [
  {
    name: 'status',
    description: 'Inspect the current repo-intelligence runtime state',
    type: 'enum',
  },
  {
    name: 'warm',
    description: 'Warm or start the local premium runtime if available',
    type: 'enum',
  },
  {
    name: 'mode',
    description: 'Switch repo-intelligence runtime mode',
    type: 'enum',
  },
  {
    name: 'trace',
    description: 'Toggle repo-intelligence trace output',
    type: 'enum',
  },
  {
    name: 'endpoint',
    description: 'Inspect or override the local repointel daemon endpoint',
    type: 'enum',
  },
  {
    name: 'bin',
    description: 'Inspect or override the local repointel command or path',
    type: 'enum',
  },
];

const REPOINTEL_MODE_ARGS: ArgumentDefinition[] = [
  {
    name: 'auto',
    description: 'Resolve to premium-native when available, otherwise fall back to oss',
    type: 'enum',
  },
  {
    name: 'off',
    description: 'Disable repo-intelligence injection',
    type: 'enum',
  },
  {
    name: 'oss',
    description: 'Use only the public OSS repo-intelligence baseline',
    type: 'enum',
  },
  {
    name: 'premium-shared',
    description: 'Use premium without the native KodaX auto lane',
    type: 'enum',
  },
  {
    name: 'premium-native',
    description: 'Use premium through the native KodaX bridge',
    type: 'enum',
  },
];

const REPOINTEL_TRACE_ARGS: ArgumentDefinition[] = [
  {
    name: 'on',
    description: 'Enable repo-intelligence trace output',
    type: 'enum',
  },
  {
    name: 'off',
    description: 'Disable repo-intelligence trace output',
    type: 'enum',
  },
  {
    name: 'toggle',
    description: 'Toggle repo-intelligence trace output',
    type: 'enum',
  },
];

const REPOINTEL_RESETTABLE_ARGS: ArgumentDefinition[] = [
  {
    name: 'default',
    description: 'Clear the override and use the default value again',
    type: 'enum',
  },
];

const WORKFLOW_SUBCOMMAND_ARGS: ArgumentDefinition[] = [
  { name: 'list', description: 'List built-in and saved workflows', type: 'enum' },
  { name: 'create', description: 'Generate and run a workflow from a request', type: 'enum' },
  { name: 'runs', description: 'List active and recent workflow runs', type: 'enum' },
  { name: 'show', description: 'Show latest run or a specific workflow run', type: 'enum' },
  { name: 'pause', description: 'Pause future child launches for a run', type: 'enum' },
  { name: 'resume', description: 'Resume a paused run', type: 'enum' },
  { name: 'stop', description: 'Stop an active workflow run', type: 'enum' },
  { name: 'delete', description: 'Delete one persisted workflow run', type: 'enum' },
  { name: 'prune', description: 'Preview or delete old terminal workflow runs', type: 'enum' },
  { name: 'rerun', description: 'Rerun a generated workflow from run history', type: 'enum' },
  { name: 'save', description: 'Save a generated run as a workflow capsule', type: 'enum' },
  { name: 'help', description: 'Show workflow help', type: 'enum' },
];

const WORKFLOW_RUN_ID_SUBCOMMANDS = new Set([
  'show',
  'pause',
  'resume',
  'stop',
  'delete',
  'rerun',
  'save',
]);

const WORKFLOW_PERSISTED_RUN_ID_SUBCOMMANDS = new Set(['show', 'delete', 'rerun', 'save']);

const WORKFLOW_RUNS_OPTION_ARGS: ArgumentDefinition[] = [
  { name: '--all', description: 'Show all persisted workflow runs', type: 'enum' },
  { name: '--limit', description: 'Show at most N persisted workflow runs', type: 'enum' },
];

const WORKFLOW_PRUNE_OPTION_ARGS: ArgumentDefinition[] = [
  { name: '--dry-run', description: 'Preview cleanup without deleting runs', type: 'enum' },
  { name: '--keep', description: 'Keep the newest N terminal runs', type: 'enum' },
  { name: '--older-than', description: 'Delete terminal runs older than Nd or Nh', type: 'enum' },
];

function workflowRunMatchesSubcommand(subcommand: string, status: string): boolean {
  switch (subcommand) {
    case 'pause':
      return status === 'running';
    case 'resume':
      return status === 'paused';
    case 'stop':
      return status === 'running' || status === 'paused';
    case 'delete':
      return status !== 'running' && status !== 'paused';
    case 'show':
    case 'rerun':
    case 'save':
    default:
      return true;
  }
}

function isWorkflowRunEntryName(value: string): boolean {
  return (
    /^[a-zA-Z0-9._-]{1,120}$/.test(value) &&
    !value.startsWith('.') &&
    !value.includes('..')
  );
}

interface WorkflowRunArgumentCandidate {
  readonly arg: ArgumentDefinition;
  readonly endedAt: number;
}

function getPersistedWorkflowRunIdArgs(): ArgumentDefinition[] {
  const projectKey = deriveProjectKeyFromRoot(process.cwd()).key;
  const baseDir = getAgentConfigPath('workflow-runs', projectKey);
  if (!existsSync(baseDir)) return [];

  const candidates: WorkflowRunArgumentCandidate[] = [];
  for (const entry of readdirSync(baseDir)) {
    if (!isWorkflowRunEntryName(entry)) continue;
    const runJsonPath = join(baseDir, entry, 'run.json');
    if (!existsSync(runJsonPath)) continue;
    try {
      const data = JSON.parse(readFileSync(runJsonPath, 'utf8')) as Record<string, unknown>;
      const workflow = typeof data.workflow === 'string' ? data.workflow : '?';
      const status = typeof data.status === 'string' ? data.status : '?';
      candidates.push({
        arg: {
          name: entry,
          description: `${workflow} - ${status}`,
          type: 'string',
        },
        endedAt: typeof data.endedAt === 'number' ? data.endedAt : 0,
      });
    } catch {
      // Malformed persisted runs should not break command completion.
    }
  }

  return candidates
    .sort((a, b) => b.endedAt - a.endedAt)
    .map((candidate) => candidate.arg);
}

function getWorkflowRunIdArgs(subcommand: string): ArgumentDefinition[] {
  const activeArgs = getDefaultWorkflowRunManager()
    .list()
    .filter((run) => workflowRunMatchesSubcommand(subcommand, run.status))
    .map((run) => ({
      name: run.runId,
      description: `${run.workflow} - ${run.status}`,
      type: 'string' as const,
    }));
  const persistedArgs = WORKFLOW_PERSISTED_RUN_ID_SUBCOMMANDS.has(subcommand)
    ? getPersistedWorkflowRunIdArgs()
    : [];
  const seen = new Set<string>();
  return [...activeArgs, ...persistedArgs].filter((arg) => {
    if (seen.has(arg.name)) return false;
    seen.add(arg.name);
    return true;
  });
}

function getWorkflowArgs(argParts: string[]): ArgumentDefinition[] {
  const [subcommand = ''] = argParts;
  const normalizedSubcommand = subcommand.toLowerCase();
  const effectiveLength = argParts.length === 1 && argParts[0] === '' ? 0 : argParts.length;

  if (effectiveLength <= 1) {
    return [
      ...WORKFLOW_SUBCOMMAND_ARGS,
      ...listBuiltinWorkflows().map((workflow) => ({
        name: workflow.name,
        description: workflow.description,
        type: 'enum' as const,
      })),
    ];
  }

  if (WORKFLOW_RUN_ID_SUBCOMMANDS.has(normalizedSubcommand) && effectiveLength <= 2) {
    return getWorkflowRunIdArgs(normalizedSubcommand);
  }

  if (normalizedSubcommand === 'runs' && effectiveLength <= 2) {
    return WORKFLOW_RUNS_OPTION_ARGS;
  }

  if (normalizedSubcommand === 'prune' && effectiveLength <= 2) {
    return WORKFLOW_PRUNE_OPTION_ARGS;
  }

  return [];
}

function getRepointelArgs(argParts: string[]): ArgumentDefinition[] {
  const [subcommand = ''] = argParts;
  const normalizedSubcommand = subcommand.toLowerCase();
  const effectiveLength = argParts.length === 1 && argParts[0] === '' ? 0 : argParts.length;

  if (effectiveLength <= 1) {
    return REPOINTEL_SUBCOMMAND_ARGS;
  }

  if (effectiveLength > 2) {
    return [];
  }

  if (normalizedSubcommand === 'mode') {
    return REPOINTEL_MODE_ARGS;
  }

  if (normalizedSubcommand === 'trace') {
    return REPOINTEL_TRACE_ARGS;
  }

  if (normalizedSubcommand === 'endpoint') {
    return [
      ...REPOINTEL_RESETTABLE_ARGS,
      {
        name: REPOINTEL_DEFAULT_ENDPOINT,
        description: 'Default local repointel daemon endpoint',
        type: 'string',
      },
    ];
  }

  if (normalizedSubcommand === 'bin') {
    return REPOINTEL_RESETTABLE_ARGS;
  }

  return [];
}

/**
 * Global command arguments registry
 * 全局命令参数注册表
 */
export const COMMAND_ARGUMENTS: CommandArgumentsRegistry = new Map([
  ['mode', MODE_ARGS],
  ['thinking', THINKING_ARGS],
  ['think', THINKING_ARGS], // alias
  ['t', THINKING_ARGS], // alias
  ['reasoning', REASONING_ARGS],
  ['reason', REASONING_ARGS],
  // 'model' and 'm' handled dynamically in getCommandArguments()
  ['plan', PLAN_ARGS],
  ['p', PLAN_ARGS], // alias
  ['status', STATUS_ARGS],
  ['info', STATUS_ARGS],
  ['ctx', STATUS_ARGS],
  ['delete', DELETE_ARGS],
  ['rm', DELETE_ARGS], // alias
  ['del', DELETE_ARGS], // alias
]);

/**
 * Get argument definitions for a command
 * 获取命令的参数定义
 * Returns dynamic list for /model (includes custom providers).
 * For /model, supports two-stage completion when partial contains provider/.
 */
const MODEL_COMMAND_NAMES = new Set(['model', 'm']);
const REPOINTEL_COMMAND_NAMES = new Set(['repointel', 'ri']);
const WORKFLOW_COMMAND_NAMES = new Set(['workflow']);

export function getCommandArguments(commandName: string, partial?: string, argParts: string[] = []): ArgumentDefinition[] {
  const key = commandName.toLowerCase();
  if (MODEL_COMMAND_NAMES.has(key)) {
    return getModelArgs(partial);
  }
  if (REPOINTEL_COMMAND_NAMES.has(key)) {
    return getRepointelArgs(argParts);
  }
  if (WORKFLOW_COMMAND_NAMES.has(key)) {
    return getWorkflowArgs(argParts);
  }
  return COMMAND_ARGUMENTS.get(key) ?? [];
}

/**
 * Check if a command has argument completions
 * 检查命令是否有参数补全
 */
export function hasCommandArguments(commandName: string): boolean {
  const key = commandName.toLowerCase();
  if (COMMAND_ARGUMENTS.has(key)) return true;
  return getCommandArguments(key).length > 0;
}
