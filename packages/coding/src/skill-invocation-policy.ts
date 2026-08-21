import { exec as execCallback } from 'node:child_process';
import { promisify } from 'node:util';
import {
  SkillRegistry,
  emitKodaXDiagnostic,
  type Skill,
  type SkillHook,
} from '@kodax-ai/agent';
import type { KodaXOptions } from './types.js';

const execAsync = promisify(execCallback);
const TOOL_NAME_ALIASES: Readonly<Record<string, string>> = {
  read: 'read',
  grep: 'grep',
  glob: 'glob',
  write: 'write',
  edit: 'edit',
  bash: 'bash',
  undo: 'undo',
  askuserquestion: 'ask-user-question',
  askuser: 'ask-user-question',
};

interface AllowedToolRule {
  readonly tool: string;
  readonly patterns?: readonly string[];
}

interface AllowedToolPolicy {
  readonly configured: boolean;
  readonly rules: readonly AllowedToolRule[];
}

function splitTopLevelCommaList(value: string): string[] {
  const items: string[] = [];
  let current = '';
  let depth = 0;
  for (const char of value) {
    if (char === ',' && depth === 0) {
      if (current.trim()) items.push(current.trim());
      current = '';
      continue;
    }
    if (char === '(') depth++;
    else if (char === ')' && depth > 0) depth--;
    current += char;
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

function parseAllowedTools(value?: string): AllowedToolPolicy {
  if (!value?.trim()) return { configured: false, rules: [] };
  const rules = splitTopLevelCommaList(value).flatMap((entry): AllowedToolRule[] => {
    if (entry === '*') return [{ tool: '*' }];
    if (entry.includes('(') && !entry.endsWith(')')) return [];
    const match = entry.match(/^([^(]+?)(?:\((.*)\))?$/);
    if (!match) return [];
    const tool = TOOL_NAME_ALIASES[match[1]!.replace(/[^a-z]/gi, '').toLowerCase()];
    if (!tool) return [];
    const patterns = match[2]
      ? splitTopLevelCommaList(match[2]).map((item) => item.trim()).filter(Boolean)
      : undefined;
    return [{ tool, ...(patterns?.length ? { patterns } : {}) }];
  });
  return { configured: true, rules };
}

function matchesPattern(pattern: string, value: string): boolean {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i').test(value);
}

function isToolAllowed(
  policy: AllowedToolPolicy,
  tool: string,
  input: Record<string, unknown>,
): boolean {
  if (!policy.configured) return true;
  if (policy.rules.length === 0) return false;
  const normalizedTool = tool.toLowerCase();
  const command = normalizedTool === 'bash' ? String(input.command ?? '').trim() : '';
  return policy.rules.some((rule) => {
    if (rule.tool !== '*' && rule.tool !== normalizedTool) return false;
    if (!rule.patterns?.length || normalizedTool !== 'bash') return true;
    return rule.patterns.some((pattern) => matchesPattern(pattern, command));
  });
}

function hookMatches(hook: SkillHook, target: string): boolean {
  return hook.matcher === undefined || matchesPattern(hook.matcher, target);
}

async function runHook(
  event: 'PreToolUse' | 'PostToolUse',
  hook: SkillHook,
  payload: Record<string, unknown>,
  cwd: string,
): Promise<boolean | undefined> {
  try {
    const { stdout, stderr } = await execAsync(hook.command, {
      cwd,
      env: {
        ...process.env,
        KODAX_HOOK_EVENT: event,
        KODAX_HOOK_PAYLOAD: JSON.stringify(payload),
      },
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    if (stderr.trim()) {
      emitKodaXDiagnostic({
        source: 'coding:skill-invocation',
        level: 'warn',
        message: `Skill ${event} hook wrote to stderr.`,
        detail: stderr.trim(),
      });
    }
    const output = stdout.trim();
    if (!output) return undefined;
    try {
      const parsed = JSON.parse(output) as Record<string, unknown>;
      return typeof parsed.allow === 'boolean'
        ? parsed.allow
        : typeof parsed.continue === 'boolean'
          ? parsed.continue
          : undefined;
    } catch {
      return undefined;
    }
  } catch (error) {
    emitKodaXDiagnostic({
      source: 'coding:skill-invocation',
      level: 'error',
      message: `Skill ${event} hook failed.`,
      detail: error,
    });
    return undefined;
  }
}

async function runHooks(
  event: 'PreToolUse' | 'PostToolUse',
  hooks: readonly SkillHook[] | undefined,
  target: string,
  payload: Record<string, unknown>,
  cwd: string,
  allowedTools: AllowedToolPolicy,
  admitHook: NonNullable<KodaXOptions['events']>['beforeToolExecute'],
): Promise<boolean> {
  for (const hook of hooks ?? []) {
    if (!hookMatches(hook, target)) continue;
    const hookInput = {
      command: hook.command,
      _reason: `Frontmatter hook ${event}`,
      _frontmatterHook: true,
      _hookEvent: event,
      _hookMatcher: hook.matcher,
    } satisfies Record<string, unknown>;
    if (!isToolAllowed(allowedTools, 'bash', hookInput)) {
      emitKodaXDiagnostic({
        source: 'coding:skill-invocation',
        level: 'warn',
        message: `Skill ${event} hook is blocked by allowed-tools policy.`,
      });
      if (event === 'PreToolUse') return false;
      continue;
    }
    if (!admitHook || await admitHook('bash', hookInput) !== true) {
      emitKodaXDiagnostic({
        source: 'coding:skill-invocation',
        level: 'warn',
        message: `Skill ${event} hook was denied by runtime permission policy.`,
      });
      if (event === 'PreToolUse') return false;
      continue;
    }
    if (await runHook(event, hook, payload, cwd) === false) return false;
  }
  return true;
}

async function loadTrustedInvokedSkill(options: KodaXOptions, name: string): Promise<Skill> {
  const boundRegistry = options.context?.skillRegistry;
  if (boundRegistry) {
    if (!boundRegistry.has(name)) {
      throw new Error(`Cannot rehydrate runtime policy: Skill "${name}" is absent from the bound Skill registry.`);
    }
    return boundRegistry.loadFull(name);
  }
  const projectRoot = options.context?.gitRoot ?? options.context?.executionCwd ?? process.cwd();
  const registry = new SkillRegistry(projectRoot);
  await registry.discover();
  if (!registry.has(name)) {
    throw new Error(`Cannot rehydrate runtime policy for unknown Skill "${name}".`);
  }
  return registry.loadFull(name);
}

const pendingPostHooks = new WeakMap<KodaXOptions, Set<Promise<void>>>();

function trackPostHook(options: KodaXOptions, task: Promise<boolean>): void {
  const pending = pendingPostHooks.get(options);
  if (!pending) return;
  const tracked = task.then(
    () => undefined,
    (error: unknown) => {
      emitKodaXDiagnostic({
        source: 'coding:skill-invocation',
        level: 'error',
        message: 'Skill PostToolUse hook failed unexpectedly.',
        detail: error,
      });
    },
  );
  pending.add(tracked);
  void tracked.finally(() => pending.delete(tracked));
}

/** Wait until all PostToolUse work owned by this runtime invocation settles. */
export async function awaitRuntimeSkillInvocationPolicy(options: KodaXOptions): Promise<void> {
  const pending = pendingPostHooks.get(options);
  while (pending && pending.size > 0) {
    await Promise.all([...pending]);
  }
}

export async function applyRuntimeSkillInvocationPolicy(options: KodaXOptions): Promise<KodaXOptions> {
  const invocation = options.context?.skillInvocation;
  if (!invocation?.runtimePolicy?.enforceAtRuntime) return options;

  const skill = await loadTrustedInvokedSkill(options, invocation.name);
  const allowedTools = parseAllowedTools(skill.allowedTools);
  const baseEvents = options.events ?? {};
  const cwd = options.context?.executionCwd ?? options.context?.gitRoot ?? process.cwd();
  const pending = new Set<Promise<void>>();
  const runtimeOptions: KodaXOptions = {
    ...options,
    context: {
      ...options.context,
      skillInvocation: {
        ...invocation,
        runtimePolicy: { enforceAtRuntime: false },
      },
    },
    events: {
      ...baseEvents,
      beforeToolExecute: async (tool, input, meta) => {
        if (!isToolAllowed(allowedTools, tool, input)) {
          return `[Blocked] Tool '${tool}' is not allowed by ${invocation.name}`;
        }
        if (!await runHooks(
          'PreToolUse',
          skill.hooks?.PreToolUse,
          tool,
          { tool, input, displayName: invocation.name, source: 'skill', path: invocation.path },
          cwd,
          allowedTools,
          baseEvents.beforeToolExecute,
        )) {
          return `[Blocked] PreToolUse hook blocked '${tool}' for ${invocation.name}`;
        }
        return baseEvents.beforeToolExecute
          ? baseEvents.beforeToolExecute(tool, input, meta)
          : true;
      },
      onToolResult: (result, meta) => {
        baseEvents.onToolResult?.(result, meta);
        trackPostHook(runtimeOptions, runHooks(
          'PostToolUse',
          skill.hooks?.PostToolUse,
          result.name,
          { ...result, displayName: invocation.name, source: 'skill', path: invocation.path },
          cwd,
          allowedTools,
          baseEvents.beforeToolExecute,
        ));
      },
    },
  };
  pendingPostHooks.set(runtimeOptions, pending);
  return runtimeOptions;
}
