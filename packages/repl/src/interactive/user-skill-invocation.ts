import {
  expandSkillForLLM,
  getSkillRegistry,
  initializeSkillRegistry,
  type SkillContext,
} from '@kodax-ai/agent';
import {
  parseBareInlineSlashReferences,
  parseInlineSkillReferences,
  type InlineSkillReference,
  type KodaXContextTokenSnapshot,
  type KodaXResult,
} from '@kodax-ai/coding';
import type { CommandInvocationRequest } from '../commands/types.js';

function collectSkillReferences(input: string): readonly InlineSkillReference[] {
  return [
    ...parseInlineSkillReferences(input),
    ...parseBareInlineSlashReferences(input),
  ].sort((left, right) => left.start - right.start);
}

export interface UserSkillReference {
  readonly name: string;
  readonly argumentsText: string;
}

/** Parse explicit slash syntax without performing discovery or expansion. */
export function parseUserSkillReferences(input: string): readonly UserSkillReference[] {
  return collectSkillReferences(input).map((reference) => ({
    name: reference.name,
    argumentsText: input.slice(reference.end).trim(),
  }));
}

/** Classify a busy-turn slash reference without waiting on discovery. */
export function findQueueableUserSkillReference(
  input: string,
  hasSkill: (name: string) => boolean,
  registryReady: boolean,
): UserSkillReference | undefined {
  const references = parseUserSkillReferences(input);
  return references.find((reference) => hasSkill(reference.name))
    ?? (registryReady ? undefined : references[0]);
}

/** Resolve only trusted registry membership; do not load or expand the Skill. */
export async function resolveUserSkillReference(
  input: string,
  context: SkillContext,
): Promise<UserSkillReference | undefined> {
  const projectRoot = context.projectRoot ?? context.workingDirectory;
  let registry = getSkillRegistry(projectRoot);
  if (registry.size === 0) {
    registry = await initializeSkillRegistry(projectRoot);
  }
  for (const reference of parseUserSkillReferences(input)) {
    if (!registry.has(reference.name)) continue;
    return reference;
  }
  return undefined;
}

export async function createUserSkillInvocation(
  name: string,
  argumentsText: string,
  context: SkillContext,
): Promise<CommandInvocationRequest | undefined> {
  const projectRoot = context.projectRoot ?? context.workingDirectory;
  let registry = getSkillRegistry(projectRoot);
  if (registry.size === 0) {
    registry = await initializeSkillRegistry(projectRoot);
  }
  if (!registry.has(name)) return undefined;

  const skill = await registry.loadFull(name);
  const expanded = await expandSkillForLLM(skill, argumentsText, context);
  return {
    prompt: expanded.content,
    source: 'skill',
    displayName: name,
    path: skill.skillFilePath,
    disableModelInvocation: expanded.disableModelInvocation,
    userInvocable: true,
    allowedTools: skill.allowedTools,
    context: skill.context,
    agent: skill.agent,
    argumentHint: skill.argumentHint,
    model: skill.model,
    hooks: skill.hooks,
    skillInvocation: {
      name,
      path: skill.skillFilePath,
      description: skill.description,
      arguments: argumentsText || undefined,
      allowedTools: skill.allowedTools,
      context: skill.context,
      agent: skill.agent,
      argumentHint: skill.argumentHint,
      model: skill.model,
      hookEvents: skill.hooks
        ? Object.entries(skill.hooks)
            .filter(([, hooks]) => Array.isArray(hooks) && hooks.length > 0)
            .map(([eventName]) => eventName)
        : undefined,
      expandedContent: expanded.content,
    },
  };
}

export async function resolveUserSkillInvocation(
  input: string,
  context: SkillContext,
): Promise<CommandInvocationRequest | undefined> {
  const reference = await resolveUserSkillReference(input, context);
  return reference
    ? createUserSkillInvocation(reference.name, reference.argumentsText, context)
    : undefined;
}

export function preserveQueuedSkillContextSnapshot(
  result: KodaXResult,
  snapshot: KodaXContextTokenSnapshot | undefined,
): KodaXResult {
  return { ...result, contextTokenSnapshot: snapshot };
}
