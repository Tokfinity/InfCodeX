import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resetTerminalCapabilityCachesForTest,
  setWindowsCodePageForTest,
  supportsUnicode,
} from './terminalCapabilities.js';

function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });

  try {
    return fn();
  } finally {
    if (descriptor) {
      Object.defineProperty(process, 'platform', descriptor);
    }
  }
}

describe('terminalCapabilities', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.LC_ALL;
    delete process.env.LC_CTYPE;
    delete process.env.LANG;
    delete process.env.WT_SESSION;
    delete process.env.TERM_PROGRAM;
    resetTerminalCapabilityCachesForTest();
  });

  it('detects unicode from UTF-8 locale settings', () => {
    process.env.LANG = 'en_US.UTF-8';
    expect(supportsUnicode()).toBe(true);
  });

  it('treats Windows Terminal and VS Code as unicode-capable on win32', () => {
    withPlatform('win32', () => {
      process.env.WT_SESSION = 'session';
      expect(supportsUnicode()).toBe(true);
    });
  });

  it('checks the active Windows code page when other hints are absent', () => {
    withPlatform('win32', () => {
      setWindowsCodePageForTest('65001');
      expect(supportsUnicode()).toBe(true);
    });
  });

  it('returns false for non-UTF Windows code pages without modern terminal hints', () => {
    withPlatform('win32', () => {
      setWindowsCodePageForTest('936');
      expect(supportsUnicode()).toBe(false);
    });
  });
});
