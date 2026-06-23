import { describe, expect, it } from 'vitest';
import {
  buildSessionOptions,
  createKodaXOptions,
  parseAgentModeOption,
  parseOptionalNonNegativeInt,
  parseOutputModeOption,
  parseReasoningModeOption,
  parseRepoIntelligenceModeOption,
  resolveCliModelSelection,
  validateCliModeSelection,
  type CliOptions,
} from './cli_option_helpers.js';

function createCliOptions(overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    provider: 'openai',
    thinking: true,
    reasoningMode: 'auto',
    agentMode: 'ama',
    outputMode: 'text',
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

describe('createKodaXOptions', () => {
  it('projects repo intelligence mode and trace flags from runtime env into context', () => {
    const previousMode = process.env.KODAX_REPO_INTELLIGENCE_MODE;
    const previousTrace = process.env.KODAX_REPO_INTELLIGENCE_TRACE;
    process.env.KODAX_REPO_INTELLIGENCE_MODE = 'premium-native';
    process.env.KODAX_REPO_INTELLIGENCE_TRACE = '1';

    try {
      const options = createKodaXOptions(createCliOptions());
      expect(options.context).toMatchObject({
        repoIntelligenceMode: 'premium-native',
        repoIntelligenceTrace: true,
      });
    } finally {
      if (previousMode === undefined) {
        delete process.env.KODAX_REPO_INTELLIGENCE_MODE;
      } else {
        process.env.KODAX_REPO_INTELLIGENCE_MODE = previousMode;
      }
      if (previousTrace === undefined) {
        delete process.env.KODAX_REPO_INTELLIGENCE_TRACE;
      } else {
        process.env.KODAX_REPO_INTELLIGENCE_TRACE = previousTrace;
      }
    }
  });
});

describe('parseAgentModeOption', () => {
  it('accepts SA mode case-insensitively', () => {
    expect(parseAgentModeOption('SA')).toBe('sa');
  });

  it('accepts AMAW mode case-insensitively', () => {
    expect(parseAgentModeOption('AMAW')).toBe('amaw');
  });

  it('rejects unsupported agent modes', () => {
    expect(() => parseAgentModeOption('team')).toThrow(
      'Expected one of: ama, amaw, sa.',
    );
  });
});

describe('parseReasoningModeOption', () => {
  it('accepts supported reasoning modes', () => {
    expect(parseReasoningModeOption('balanced')).toBe('balanced');
  });

  it('rejects unsupported reasoning modes', () => {
    expect(() => parseReasoningModeOption('verbose')).toThrow(
      'Expected one of: off, auto, quick, balanced, deep.',
    );
  });
});

describe('parseRepoIntelligenceModeOption', () => {
  it('accepts supported repo-intelligence modes', () => {
    expect(parseRepoIntelligenceModeOption('premium-native')).toBe('premium-native');
  });

  it('rejects unsupported repo-intelligence modes', () => {
    expect(() => parseRepoIntelligenceModeOption('premium')).toThrow(
      'Expected one of: auto, off, oss, premium-shared, premium-native.',
    );
  });
});

describe('numeric CLI helpers', () => {
  it('accepts a valid non-negative integer', () => {
    expect(parseOptionalNonNegativeInt('12')).toBe(12);
  });

  it('throws on invalid non-negative integers instead of silently swallowing them', () => {
    expect(() => parseOptionalNonNegativeInt('abc')).toThrow(
      'Expected a non-negative integer, got "abc".',
    );
  });

  it('rejects partially numeric and decimal values', () => {
    expect(() => parseOptionalNonNegativeInt('12abc')).toThrow(
      'Expected a non-negative integer, got "12abc".',
    );
    expect(() => parseOptionalNonNegativeInt('1.5')).toThrow(
      'Expected a non-negative integer, got "1.5".',
    );
  });
});

describe('resolveCliModelSelection', () => {
  it('uses the configured model when the provider is unchanged', () => {
    expect(
      resolveCliModelSelection(
        undefined,
        undefined,
        'zhipu-coding',
        'glm-5.1',
      ),
    ).toBe('glm-5.1');
  });

  it('does not carry a configured model across provider switches', () => {
    expect(
      resolveCliModelSelection(
        'newapi-openai',
        undefined,
        'zhipu-coding',
        'glm-5.1',
      ),
    ).toBeUndefined();
  });

  it('drops an ambiguous configured model when the CLI explicitly switches providers', () => {
    expect(
      resolveCliModelSelection(
        'newapi-openai',
        undefined,
        undefined,
        'gpt-4o',
      ),
    ).toBeUndefined();
  });

  it('prefers an explicit CLI model override', () => {
    expect(
      resolveCliModelSelection(
        'newapi-openai',
        'gpt-5',
        'zhipu-coding',
        'glm-5.1',
      ),
    ).toBe('gpt-5');
  });
});
