import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  disableBracketedPasteMode,
  enableBracketedPasteMode,
  isBracketedPasteModeEnabled,
} from './bracketed-paste-mode.js';

describe('bracketed paste mode lifecycle', () => {
  let writes: string[] = [];
  let originalWrite: typeof process.stdout.write;

  beforeEach(() => {
    writes = [];
    originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = vi.fn((chunk: string | Uint8Array) => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as unknown as typeof process.stdout.write;
    // Reset module state — the module is single-shot, but for tests we
    // need to ensure each test starts in disabled state. Disable to
    // clear any leftover from a previous test.
    disableBracketedPasteMode();
    writes = [];
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
    // Ensure mode is disabled at end of each test (don't leak terminal state).
    disableBracketedPasteMode();
  });

  it('enableBracketedPasteMode writes ESC[?2004h', () => {
    enableBracketedPasteMode();
    expect(writes).toContain('\x1b[?2004h');
    expect(isBracketedPasteModeEnabled()).toBe(true);
  });

  it('disableBracketedPasteMode writes ESC[?2004l after enable', () => {
    enableBracketedPasteMode();
    writes = [];
    disableBracketedPasteMode();
    expect(writes).toContain('\x1b[?2004l');
    expect(isBracketedPasteModeEnabled()).toBe(false);
  });

  it('enable is idempotent (does not double-write)', () => {
    enableBracketedPasteMode();
    enableBracketedPasteMode();
    enableBracketedPasteMode();
    const enableWrites = writes.filter((w) => w === '\x1b[?2004h');
    expect(enableWrites.length).toBe(1);
  });

  it('disable is a no-op when already disabled', () => {
    disableBracketedPasteMode();
    expect(writes).toHaveLength(0);
  });
});
