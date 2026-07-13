import type { KodaXToolExecutionContext } from '../types.js';

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function strings(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${label} must be an array of strings.`);
  }
  return value;
}

function fileMappings(
  value: unknown,
  label: string,
  keys: readonly [string, string],
): Array<Record<string, string>> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`${label}[${index}] must be an object.`);
    }
    const source = item as Record<string, unknown>;
    const unknown = Object.keys(source).find((key) => !keys.includes(key));
    if (unknown) throw new Error(`${label}[${index}] has unknown field "${unknown}".`);
    return Object.fromEntries(keys
      .filter((key) => source[key] !== undefined)
      .map((key) => [key, requiredText(source[key], `${label}[${index}].${key}`)]));
  });
}

export async function toolRunSkillScript(
  input: Record<string, unknown>,
  context: KodaXToolExecutionContext,
): Promise<string> {
  if (!context.skillScriptRunner || !context.executionCwd) {
    throw new Error('Skill script execution is unavailable in this runtime.');
  }
  const inputs = fileMappings(input.inputs, 'inputs', ['path', 'as'])
    .map((item) => {
      if (!item.path) throw new Error('Every input requires path.');
      return { path: item.path, ...(item.as ? { as: item.as } : {}) };
    });
  const outputs = fileMappings(input.outputs, 'outputs', ['path', 'target'])
    .map((item) => {
      if (!item.path || !item.target) throw new Error('Every output requires path and target.');
      return { path: item.path, target: item.target };
    });
  return context.skillScriptRunner.run({
    skill: requiredText(input.skill, 'skill'),
    script: requiredText(input.script, 'script'),
    args: strings(input.args, 'args'),
    inputs,
    outputs,
  }, {
    workspaceRoot: context.executionCwd,
    signal: context.abortSignal,
  });
}
