import { describe, expect, it } from 'vitest';
import { parseCommand } from './commands.js';

describe('parseCommand', () => {
  it('supports colon-style inline arguments for regular commands', () => {
    expect(parseCommand('/reasoning:auto')).toEqual({
      command: 'reasoning',
      args: ['auto'],
    });
  });

  it('preserves existing /skill:name behavior', () => {
    expect(parseCommand('/skill:smart-context compact now')).toEqual({
      command: 'skill',
      args: ['compact', 'now'],
      skillInvocation: { name: 'smart-context' },
    });
  });
});
