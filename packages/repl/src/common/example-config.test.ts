import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import {
  ensureExampleConfigFile,
  KODAX_CONFIG_FILE,
  KODAX_EXAMPLE_CONFIG_FILE,
} from './utils.js';

describe('ensureExampleConfigFile (F1 first-launch template)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes a commented config.example.jsonc when no config.json exists', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const mkdir = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

    const result = ensureExampleConfigFile();

    expect(result).toBe(KODAX_EXAMPLE_CONFIG_FILE);
    expect(mkdir).toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
    const [writtenPath, content] = write.mock.calls[0]!;
    expect(writtenPath).toBe(KODAX_EXAMPLE_CONFIG_FILE);
    // Reference file is JSONC (leading // comment) and documents the custom-provider
    // thinking/reasoning config that motivated F1.
    expect(String(content)).toMatch(/^\/\//);
    expect(String(content)).toContain('supportsThinking');
    expect(String(content)).toContain('reasoningCapability');
    expect(String(content)).toContain('customProviders');
  });

  it('does nothing when config.json already exists', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => p === KODAX_CONFIG_FILE);
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

    expect(ensureExampleConfigFile()).toBeUndefined();
    expect(write).not.toHaveBeenCalled();
  });

  it('does not overwrite an existing example file', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => p === KODAX_EXAMPLE_CONFIG_FILE);
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

    expect(ensureExampleConfigFile()).toBeUndefined();
    expect(write).not.toHaveBeenCalled();
  });

  it('never throws — a write failure returns undefined', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('disk full');
    });

    expect(() => ensureExampleConfigFile()).not.toThrow();
    expect(ensureExampleConfigFile()).toBeUndefined();
  });
});
