/**
 * Command system type definitions.
 */

import type { AgentsFile, KodaXOptions } from '@kodax/coding';
import type * as readline from 'readline';
import type { InteractiveContext } from '../interactive/context.js';
import type { PermissionMode } from '../permission/types.js';

export type CommandSource = 'builtin' | 'extension' | 'skill' | 'prompt';

export type CommandPriority = 'critical' | 'high' | 'medium' | 'low';

export interface CurrentConfig {
  provider: string;
  thinking: boolean;
  permissionMode: PermissionMode;
}

export interface CommandCallbacks {
  exit: () => void;
  saveSession: () => Promise<void>;
  startNewSession?: () => void;
  loadSession: (id: string) => Promise<boolean>;
  listSessions: () => Promise<void>;
  clearHistory: () => void;
  printHistory: () => void;
  switchProvider?: (provider: string) => void;
  setThinking?: (enabled: boolean) => void;
  setPermissionMode?: (mode: PermissionMode) => void;
  deleteSession?: (id: string) => Promise<void>;
  deleteAllSessions?: () => Promise<void>;
  setPlanMode?: (enabled: boolean) => void;
  createKodaXOptions?: () => KodaXOptions;
  reloadAgentsFiles?: () => Promise<AgentsFile[]>;
  confirm?: (message: string) => Promise<boolean>;
  readline?: readline.Interface;
  startCompacting?: () => void;
  stopCompacting?: () => void;
}

export interface CommandResultData {
  success?: boolean;
  message?: string;
  data?: unknown;
  skillContent?: string;
  projectInitPrompt?: string;
}

export type CommandResult = boolean | CommandResultData;

export type CommandHandler = (
  args: string[],
  context: InteractiveContext,
  callbacks: CommandCallbacks,
  currentConfig: CurrentConfig
) => Promise<CommandResult | void>;

export interface CommandDefinition {
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  detailedHelp?: () => void;
  handler: CommandHandler;
  source?: CommandSource;
  priority?: CommandPriority;
  location?: 'user' | 'project' | 'path';
  path?: string;
}

export interface CommandInfo {
  name: string;
  aliases?: string[];
  description: string;
  source: CommandSource;
  usage?: string;
  priority?: CommandPriority;
  location?: 'user' | 'project' | 'path';
  path?: string;
}

/**
 * Legacy command shape used by the existing REPL command table.
 */
export interface Command {
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  handler: CommandHandler;
  detailedHelp?: () => void;
}

export function toCommandDefinition(
  cmd: Command,
  source: CommandSource = 'builtin'
): CommandDefinition {
  return {
    ...cmd,
    source,
  };
}
