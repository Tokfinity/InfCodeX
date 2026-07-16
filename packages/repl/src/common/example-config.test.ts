import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import {
  ensureExampleConfigFiles,
  ensureExampleConfigFile,
  getConfigTemplate,
  KODAX_CONFIG_FILE,
  KODAX_DIR,
  KODAX_EXAMPLE_CONFIG_FILE,
  KODAX_INTEGRATION_EXAMPLE_FILES,
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
    // Dir is created recursively BEFORE the write (first-launch on a fresh machine).
    expect(mkdir).toHaveBeenCalledWith(KODAX_DIR, { recursive: true });
    expect(write).toHaveBeenCalledTimes(4);
    const [writtenPath, content] = write.mock.calls[0]!;
    expect(writtenPath).toBe(KODAX_EXAMPLE_CONFIG_FILE);
    // Reference file is JSONC (leading // comment) and documents the custom-provider
    // thinking/reasoning config that motivated F1.
    expect(String(content)).toMatch(/^\/\//);
    expect(String(content)).toContain('customProviders');
    expect(String(content)).not.toContain('mcpServers');
    expect(write.mock.calls.map(([written]) => written)).toEqual([
      KODAX_EXAMPLE_CONFIG_FILE,
      KODAX_INTEGRATION_EXAMPLE_FILES.mcp,
      KODAX_INTEGRATION_EXAMPLE_FILES.a2a,
      KODAX_INTEGRATION_EXAMPLE_FILES.extensions,
    ]);
  });

  it('still installs missing integration examples when config.json already exists', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => p === KODAX_CONFIG_FILE);
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

    expect(ensureExampleConfigFiles()).toHaveLength(4);
    expect(write).toHaveBeenCalledTimes(4);
  });

  it('does not overwrite an existing example file', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => p === KODAX_EXAMPLE_CONFIG_FILE);
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

    expect(ensureExampleConfigFile()).toBe(KODAX_INTEGRATION_EXAMPLE_FILES.mcp);
    expect(write).toHaveBeenCalledTimes(3);
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

  it('returns the exact embedded canonical templates', () => {
    expect(getConfigTemplate('core')).toContain('KodaX core configuration template');
    expect(getConfigTemplate('mcp')).toContain('"version": 1');
    expect(getConfigTemplate('a2a')).toContain('"agents": {}');
    expect(getConfigTemplate('extensions')).toContain('"paths": []');
  });
});
