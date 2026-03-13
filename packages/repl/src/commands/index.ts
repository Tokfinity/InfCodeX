/**
 * Public command-system exports.
 */

import type { CommandRegistry } from './registry.js';
import { registerBuiltinCommands } from './builtin.js';

export type {
  CommandSource,
  CommandPriority,
  CurrentConfig,
  CommandCallbacks,
  CommandHandler,
  CommandResult,
  CommandResultData,
  CommandDefinition,
  CommandInfo,
  Command,
} from './types.js';
export { toCommandDefinition } from './types.js';

export { CommandRegistry, globalCommandRegistry } from './registry.js';

export { registerBuiltinCommands, getBuiltinCommandCount } from './builtin.js';

export { copyCommand } from './copy-command.js';
export { newCommand } from './new-command.js';

export function registerAllCommands(registry: CommandRegistry): void {
  registerBuiltinCommands(registry);
}
