import { describe, expect, it } from 'vitest';
import {
  buildSessionOptions,
  mergeConfiguredExtensions,
  parseOutputModeOption,
  validateCliModeSelection,
  type CliOptions,
} from './cli_option_helpers.js';

function createCliOptions(overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    provider: 'openai',
    thinking: true,
    reasoningMode: 'auto',
    outputMode: 'text',
    parallel: false,
    append: false,
    overwrite: false,
    autoContinue: false,
    maxSessions: 50,
    maxHours: 2,
    prompt: ['inspect', 'repo'],
    noSession: false,
    ...overrides,
  };
}

describe('parseOutputModeOption', () => {
  it('accepts json mode', () => {
    expect(parseOutputModeOption('json')).toBe('json');
  });

  it('rejects unsupported values', () => {
    expect(() => parseOutputModeOption('text')).toThrow(
      'Expected "json". Text mode is the default and does not need --mode.',
    );
  });
});

describe('validateCliModeSelection', () => {
  it('rejects combining --mode json with print mode', () => {
    expect(() =>
      validateCliModeSelection(
        createCliOptions({ outputMode: 'json', print: true }),
      ),
    ).toThrow('`--mode json` cannot be combined with `-p/--print`.');
  });

  it('rejects json mode without a positional prompt', () => {
    expect(() =>
      validateCliModeSelection(
        createCliOptions({ outputMode: 'json', prompt: [] }),
      ),
    ).toThrow('`--mode json` requires a prompt as positional arguments.');
  });

  it('rejects bare resume in json mode', () => {
    expect(() =>
      validateCliModeSelection(
        createCliOptions({ outputMode: 'json' }),
        { resumeWithoutId: true },
      ),
    ).toThrow('`--mode json` requires an explicit session id for `--resume`');
  });
});

describe('buildSessionOptions', () => {
  it('allows stateless json mode runs with --no-session', () => {
    const options = buildSessionOptions(
      createCliOptions({ outputMode: 'json', noSession: true }),
    );

    expect(options).toBeUndefined();
  });

  it('marks persisted CLI sessions as user-scoped', () => {
    const options = buildSessionOptions(
      createCliOptions({ continue: true }),
    );

    expect(options).toMatchObject({
      resume: true,
      scope: 'user',
    });
  });
});

describe('mergeConfiguredExtensions', () => {
  it('merges configured and CLI extension lists with deduplication', () => {
    expect(
      mergeConfiguredExtensions(
        ['  ./local-ext.mjs  ', './shared-ext.mjs'],
        ['./shared-ext.mjs', './config-ext.mjs', ''],
      ),
    ).toEqual([
      './shared-ext.mjs',
      './config-ext.mjs',
      './local-ext.mjs',
    ]);
  });
});
