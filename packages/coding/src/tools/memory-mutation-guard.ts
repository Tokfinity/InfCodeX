import { getAgentConfigPath, isAutoManagedMemoryFile } from '@kodax-ai/agent';

export function memoryMutationDenial(filePath: string): string | undefined {
  return isAutoManagedMemoryFile(filePath)
    ? '[Tool Error] Memory files are governed by the Memory Control Plane; use an explicit memory command or proposal instead.'
    : undefined;
}

export function shellMemoryMutationDenial(command: string): string | undefined {
  const normalized = command.replaceAll('\\', '/').toLowerCase();
  const scopedRoot = getAgentConfigPath('memory-scopes').replaceAll('\\', '/').toLowerCase();
  const projectsRoot = getAgentConfigPath('projects').replaceAll('\\', '/').toLowerCase();
  const targetsScoped = normalized.includes(scopedRoot);
  const targetsLegacy = normalized.includes(projectsRoot) && /\/memory(?:\/|\b)/.test(normalized);
  if (!targetsScoped && !targetsLegacy) return undefined;
  if (isReadOnlyInspection(command) && !looksMutating(command)) return undefined;
  return '[Tool Error] Shell mutation of governed memory is denied; use the Memory Control Plane.';
}

function looksMutating(command: string): boolean {
  return /(?:^|[;&|]\s*)(?:rm|mv|cp|del|move|copy)\b|\b(?:set-content|add-content|remove-item|move-item|copy-item)\b|\bsed\s+-i\b|(?:>>?|\|\s*tee)\s*[^&|]+/i.test(command);
}

function isReadOnlyInspection(command: string): boolean {
  return /^\s*(?:get-content|cat|type|rg|grep|select-string|get-childitem|get-child-item|ls|dir|stat|test-path)\b/i
    .test(command);
}
