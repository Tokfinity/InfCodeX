import { describe, expect, it } from 'vitest';

import { resolveKodaXManual } from '@kodax-ai/coding';
import { BUILTIN_COMMANDS } from './commands.js';

/**
 * FEATURE_218 drift guard — the self-knowledge manual's `commands` topic must
 * not reference slash commands that no longer exist. Two-way check keeps the
 * referenced list honest: every name is both a real command AND named in the
 * topic prose. Remove /goal from BUILTIN_COMMANDS -> first assert fails;
 * remove it from the manual prose -> second assert fails.
 */
const MANUAL_REFERENCED_COMMANDS = [
  'help',
  'compact',
  'model',
  'fallback',
  'mcp',
  'skill',
  'goal',
  'learn',
  'recover',
] as const;

describe('FEATURE_218 manual ↔ commands drift guard', () => {
  it('every command the manual names exists in BUILTIN_COMMANDS', () => {
    const known = new Set<string>(
      BUILTIN_COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]),
    );
    for (const name of MANUAL_REFERENCED_COMMANDS) {
      expect(known.has(name), `manual names /${name} but no such command`).toBe(true);
    }
  });

  it('the commands topic actually mentions each referenced command', () => {
    const topic = resolveKodaXManual({ topic: 'commands' }).content;
    for (const name of MANUAL_REFERENCED_COMMANDS) {
      expect(topic, `commands topic no longer mentions /${name}`).toContain(`/${name}`);
    }
  });
});
