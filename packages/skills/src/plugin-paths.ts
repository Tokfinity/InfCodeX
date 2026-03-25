import path from 'path';

const pluginSkillPaths = new Set<string>();

function normalizePluginSkillPath(skillPath: string): string {
  const trimmed = skillPath.trim();
  if (!trimmed) {
    throw new Error('Plugin skill path cannot be empty.');
  }
  return path.resolve(trimmed);
}

export function registerPluginSkillPath(skillPath: string): () => void {
  const normalizedPath = normalizePluginSkillPath(skillPath);
  pluginSkillPaths.add(normalizedPath);

  return () => {
    pluginSkillPaths.delete(normalizedPath);
  };
}

export function unregisterPluginSkillPath(skillPath: string): boolean {
  return pluginSkillPaths.delete(normalizePluginSkillPath(skillPath));
}

export function listPluginSkillPaths(): string[] {
  return Array.from(pluginSkillPaths.values());
}

export function clearPluginSkillPaths(): void {
  pluginSkillPaths.clear();
}
