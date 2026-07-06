import { describe, expect, it } from 'vitest';
import { commandHead, commandMatches, outputMatches } from './detect.js';

describe('output filter detection', () => {
  it('extracts a simple command head without importing the REPL bash parser', () => {
    expect(commandHead('NODE_ENV=test npm run build')).toBe('npm');
    expect(commandHead('cd repo && git diff --stat')).toBe('git');
    expect(commandHead('C:\\Program Files\\Git\\bin\\git.exe status')).toBe('git');
  });

  it('matches commands and decoded output independently', () => {
    const input = {
      command: 'npm test',
      stdout: 'FAIL src/a.test.ts\nAssertionError: nope',
      stderr: '',
      lossiness: 'none' as const,
    };

    expect(commandMatches(input, /^npm$/)).toBe(true);
    expect(outputMatches(input, /AssertionError/)).toBe(true);
  });
});
