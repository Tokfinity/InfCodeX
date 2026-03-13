/**
 * CommandRegistry Unit Tests - CommandRegistry 单元测试
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CommandRegistry } from './registry.js';
import type { CommandDefinition } from './types.js';

describe('CommandRegistry', () => {
  let registry: CommandRegistry;

  beforeEach(() => {
    registry = new CommandRegistry();
  });

  describe('register()', () => {
    it('should register a command', () => {
      const cmd: CommandDefinition = {
        name: 'test',
        description: 'Test command',
        source: 'builtin',
        handler: async () => {},
      };

      registry.register(cmd);
      expect(registry.has('test')).toBe(true);
      expect(registry.size).toBe(1);
    });

    it('should register command with aliases', () => {
      const cmd: CommandDefinition = {
        name: 'test',
        aliases: ['t', 'tst'],
        description: 'Test command',
        source: 'builtin',
        handler: async () => {},
      };

      registry.register(cmd);
      expect(registry.has('test')).toBe(true);
      expect(registry.has('t')).toBe(true);
      expect(registry.has('tst')).toBe(true);
      expect(registry.aliasCount).toBe(2);
    });

    it('should throw error when registering duplicate command', () => {
      const cmd1: CommandDefinition = {
        name: 'test',
        description: 'Test command 1',
        source: 'builtin',
        handler: async () => {},
      };

      const cmd2: CommandDefinition = {
        name: 'test',
        description: 'Test command 2',
        source: 'builtin',
        handler: async () => {},
      };

      registry.register(cmd1);
      expect(() => registry.register(cmd2)).toThrow('already registered');
    });

    it('should throw when alias conflicts with an existing command name', () => {
      registry.register({
        name: 'help',
        description: 'Help command',
        source: 'builtin',
        handler: async () => {},
      });

      expect(() =>
        registry.register({
          name: 'copy',
          aliases: ['help'],
          description: 'Copy command',
          source: 'builtin',
          handler: async () => {},
        })
      ).toThrow('conflicts with existing command');
    });

    it('should throw when alias is already registered by another command', () => {
      registry.register({
        name: 'help',
        aliases: ['h'],
        description: 'Help command',
        source: 'builtin',
        handler: async () => {},
      });

      expect(() =>
        registry.register({
          name: 'history',
          aliases: ['h'],
          description: 'History command',
          source: 'builtin',
          handler: async () => {},
        })
      ).toThrow('already registered');
    });

    it('should normalize command name to lowercase', () => {
      const cmd: CommandDefinition = {
        name: 'TEST',
        description: 'Test command',
        source: 'builtin',
        handler: async () => {},
      };

      registry.register(cmd);
      expect(registry.has('test')).toBe(true);
      expect(registry.has('TEST')).toBe(true);
      expect(registry.get('TEST')?.name).toBe('TEST');
    });
  });

  describe('unregister()', () => {
    it('should unregister a command', () => {
      const cmd: CommandDefinition = {
        name: 'test',
        description: 'Test command',
        source: 'builtin',
        handler: async () => {},
      };

      registry.register(cmd);
      expect(registry.has('test')).toBe(true);

      const result = registry.unregister('test');
      expect(result).toBe(true);
      expect(registry.has('test')).toBe(false);
      expect(registry.size).toBe(0);
    });

    it('should unregister command with aliases', () => {
      const cmd: CommandDefinition = {
        name: 'test',
        aliases: ['t', 'tst'],
        description: 'Test command',
        source: 'builtin',
        handler: async () => {},
      };

      registry.register(cmd);
      expect(registry.aliasCount).toBe(2);

      registry.unregister('test');
      expect(registry.has('test')).toBe(false);
      expect(registry.has('t')).toBe(false);
      expect(registry.has('tst')).toBe(false);
      expect(registry.aliasCount).toBe(0);
    });

    it('should return false when unregistering non-existent command', () => {
      const result = registry.unregister('nonexistent');
      expect(result).toBe(false);
    });

    it('should unregister by alias', () => {
      const cmd: CommandDefinition = {
        name: 'test',
        aliases: ['t'],
        description: 'Test command',
        source: 'builtin',
        handler: async () => {},
      };

      registry.register(cmd);
      registry.unregister('t');
      expect(registry.has('test')).toBe(false);
    });
  });

  describe('get()', () => {
    it('should get command by name', () => {
      const cmd: CommandDefinition = {
        name: 'test',
        description: 'Test command',
        source: 'builtin',
        handler: async () => {},
      };

      registry.register(cmd);
      const retrieved = registry.get('test');
      expect(retrieved).toBeDefined();
      expect(retrieved?.name).toBe('test');
      expect(retrieved?.description).toBe('Test command');
    });

    it('should get command by alias', () => {
      const cmd: CommandDefinition = {
        name: 'test',
        aliases: ['t'],
        description: 'Test command',
        source: 'builtin',
        handler: async () => {},
      };

      registry.register(cmd);
      const retrieved = registry.get('t');
      expect(retrieved).toBeDefined();
      expect(retrieved?.name).toBe('test');
    });

    it('should return undefined for non-existent command', () => {
      const retrieved = registry.get('nonexistent');
      expect(retrieved).toBeUndefined();
    });
  });

  describe('has()', () => {
    it('should return true for existing command', () => {
      const cmd: CommandDefinition = {
        name: 'test',
        description: 'Test command',
        source: 'builtin',
        handler: async () => {},
      };

      registry.register(cmd);
      expect(registry.has('test')).toBe(true);
    });

    it('should return true for alias', () => {
      const cmd: CommandDefinition = {
        name: 'test',
        aliases: ['t'],
        description: 'Test command',
        source: 'builtin',
        handler: async () => {},
      };

      registry.register(cmd);
      expect(registry.has('t')).toBe(true);
    });

    it('should return false for non-existent command', () => {
      expect(registry.has('nonexistent')).toBe(false);
    });
  });

  describe('getAll()', () => {
    it('should return empty array when no commands registered', () => {
      const commands = registry.getAll();
      expect(commands).toEqual([]);
    });

    it('should return all registered commands', () => {
      const cmd1: CommandDefinition = {
        name: 'test1',
        description: 'Test command 1',
        source: 'builtin',
        handler: async () => {},
      };

      const cmd2: CommandDefinition = {
        name: 'test2',
        description: 'Test command 2',
        source: 'extension',
        handler: async () => {},
      };

      registry.register(cmd1);
      registry.register(cmd2);

      const commands = registry.getAll();
      expect(commands).toHaveLength(2);
      expect(commands.map(c => c.name)).toContain('test1');
      expect(commands.map(c => c.name)).toContain('test2');
    });

    it('should filter commands by source', () => {
      const cmd1: CommandDefinition = {
        name: 'test1',
        description: 'Test command 1',
        source: 'builtin',
        handler: async () => {},
      };

      const cmd2: CommandDefinition = {
        name: 'test2',
        description: 'Test command 2',
        source: 'extension',
        handler: async () => {},
      };

      registry.register(cmd1);
      registry.register(cmd2);

      const builtinCommands = registry.getAll('builtin');
      expect(builtinCommands).toHaveLength(1);
      expect(builtinCommands[0]?.name).toBe('test1');

      const extensionCommands = registry.getAll('extension');
      expect(extensionCommands).toHaveLength(1);
      expect(extensionCommands[0]?.name).toBe('test2');
    });

    it('should sort commands by name', () => {
      const cmd1: CommandDefinition = {
        name: 'zebra',
        description: 'Zebra command',
        source: 'builtin',
        handler: async () => {},
      };

      const cmd2: CommandDefinition = {
        name: 'alpha',
        description: 'Alpha command',
        source: 'builtin',
        handler: async () => {},
      };

      registry.register(cmd1);
      registry.register(cmd2);

      const commands = registry.getAll();
      expect(commands[0]?.name).toBe('alpha');
      expect(commands[1]?.name).toBe('zebra');
    });
  });

  describe('getBySource()', () => {
    it('should return commands filtered by source', () => {
      const builtinCmd: CommandDefinition = {
        name: 'builtin-test',
        description: 'Builtin test',
        source: 'builtin',
        handler: async () => {},
      };

      const extensionCmd: CommandDefinition = {
        name: 'extension-test',
        description: 'Extension test',
        source: 'extension',
        handler: async () => {},
      };

      registry.register(builtinCmd);
      registry.register(extensionCmd);

      const builtinCommands = registry.getBySource('builtin');
      expect(builtinCommands).toHaveLength(1);
      expect(builtinCommands[0]?.name).toBe('builtin-test');

      const extensionCommands = registry.getBySource('extension');
      expect(extensionCommands).toHaveLength(1);
      expect(extensionCommands[0]?.name).toBe('extension-test');
    });
  });

  describe('getNames()', () => {
    it('should return sorted command names', () => {
      const cmd1: CommandDefinition = {
        name: 'zebra',
        description: 'Zebra command',
        source: 'builtin',
        handler: async () => {},
      };

      const cmd2: CommandDefinition = {
        name: 'alpha',
        description: 'Alpha command',
        source: 'builtin',
        handler: async () => {},
      };

      registry.register(cmd1);
      registry.register(cmd2);

      const names = registry.getNames();
      expect(names).toEqual(['alpha', 'zebra']);
    });
  });

  describe('clear()', () => {
    it('should clear all commands and aliases', () => {
      const cmd: CommandDefinition = {
        name: 'test',
        aliases: ['t'],
        description: 'Test command',
        source: 'builtin',
        handler: async () => {},
      };

      registry.register(cmd);
      expect(registry.size).toBe(1);
      expect(registry.aliasCount).toBe(1);

      registry.clear();
      expect(registry.size).toBe(0);
      expect(registry.aliasCount).toBe(0);
    });
  });

  describe('size and aliasCount', () => {
    it('should track command count correctly', () => {
      expect(registry.size).toBe(0);

      registry.register({
        name: 'test1',
        description: 'Test 1',
        source: 'builtin',
        handler: async () => {},
      });
      expect(registry.size).toBe(1);

      registry.register({
        name: 'test2',
        description: 'Test 2',
        source: 'builtin',
        handler: async () => {},
      });
      expect(registry.size).toBe(2);

      registry.unregister('test1');
      expect(registry.size).toBe(1);
    });

    it('should track alias count correctly', () => {
      expect(registry.aliasCount).toBe(0);

      registry.register({
        name: 'test',
        aliases: ['t', 'tst'],
        description: 'Test',
        source: 'builtin',
        handler: async () => {},
      });
      expect(registry.aliasCount).toBe(2);

      registry.unregister('test');
      expect(registry.aliasCount).toBe(0);
    });
  });
});
