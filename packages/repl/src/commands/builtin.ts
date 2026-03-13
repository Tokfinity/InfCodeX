/**
 * Builtin Commands Registration - 内置命令注册
 *
 * This module registers all builtin commands with the CommandRegistry.
 * It imports the existing BUILTIN_COMMANDS array and converts them
 * to CommandDefinitions with proper source tracking.
 */

import type { CommandRegistry } from './registry.js';
import { toCommandDefinition } from './types.js';

// Import builtin commands from the interactive command module, which now
// serves as the single source of truth for shipped REPL commands.
import { BUILTIN_COMMANDS } from '../interactive/commands.js';

/**
 * Register all builtin commands with the registry
 * 向注册表注册所有内置命令
 *
 * @param registry - CommandRegistry instance
 */
export function registerBuiltinCommands(registry: CommandRegistry): void {
  for (const cmd of BUILTIN_COMMANDS) {
    try {
      const def = toCommandDefinition(cmd, 'builtin');
      registry.register(def);
    } catch (error) {
      console.error(`Failed to register command "${cmd.name}":`, error);
    }
  }
}

/**
 * Get builtin command count
 * 获取内置命令数量
 *
 * @returns Number of builtin commands
 */
export function getBuiltinCommandCount(): number {
  return BUILTIN_COMMANDS.length;
}
