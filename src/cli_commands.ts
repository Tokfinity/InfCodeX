import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { KodaXResult } from '@kodax/coding';

export const KODAX_COMMANDS_DIR = path.join(os.homedir(), '.kodax', 'commands');

export interface KodaXCommand {
  name: string;
  description: string;
  content: string;
  type: 'prompt' | 'programmable';
  execute?: (context: KodaXCommandContext) => Promise<string>;
}

export interface KodaXCommandContext {
  args?: string;
  runAgent: (prompt: string) => Promise<KodaXResult>;
}

export function getDefaultCommandDir(): string {
  return KODAX_COMMANDS_DIR;
}

export async function loadCommands(commandDir?: string): Promise<Map<string, KodaXCommand>> {
  const commands = new Map<string, KodaXCommand>();
  const dir = commandDir ?? KODAX_COMMANDS_DIR;

  try {
    await fs.mkdir(dir, { recursive: true });
    const files = await fs.readdir(dir);

    for (const fileName of files) {
      const extension = path.extname(fileName);
      const commandName = fileName.replace(extension, '');

      if (extension === '.md') {
        try {
          const content = await fs.readFile(path.join(dir, fileName), 'utf-8');
          const firstLine = content.split('\n')[0]?.replace(/^#\s*/, '').trim() ?? '';
          const description = firstLine.slice(0, 60) || '(prompt command)';
          commands.set(commandName, {
            name: commandName,
            description,
            content,
            type: 'prompt',
          });
        } catch {
          // Ignore malformed prompt command files so one bad file does not break discovery.
        }
        continue;
      }

      if (extension === '.js' || extension === '.ts') {
        try {
          const modulePath = path.join(dir, fileName);
          const mod = await import(modulePath);
          for (const [key, value] of Object.entries(mod)) {
            if (key.startsWith('command_') && typeof value === 'function') {
              const functionName = key.replace('command_', '');
              const description = (value as { description?: unknown }).description ?? functionName;
              commands.set(functionName, {
                name: functionName,
                description: String(description).slice(0, 60),
                content: `[Programmable command: ${functionName}]`,
                type: 'programmable',
                execute: value as (context: KodaXCommandContext) => Promise<string>,
              });
            }
          }
        } catch {
          // Ignore malformed programmable commands so the rest of the directory stays usable.
        }
      }
    }
  } catch {
    // Treat unreadable command directories as empty to preserve CLI startup behavior.
  }

  return commands;
}

export async function processCommandCall(
  commandName: string,
  args: string | undefined,
  commands: Map<string, KodaXCommand>,
  runAgent: (prompt: string) => Promise<KodaXResult>,
): Promise<string | null> {
  const command = commands.get(commandName);
  if (!command) {
    return null;
  }

  if (command.type === 'prompt') {
    return args ? command.content.replace(/{args}/g, args) : command.content;
  }

  if (command.type === 'programmable' && command.execute) {
    return command.execute({
      args,
      runAgent,
    });
  }

  return null;
}

export function parseCommandCall(input: string): [string, string?] | null {
  if (!input.startsWith('/')) {
    return null;
  }

  const parts = input.slice(1).split(/\s+/, 2);
  if (parts.length === 0) {
    return null;
  }

  const [commandName, args] = parts;
  return commandName ? [commandName, args] : null;
}
