import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  compact: vi.fn(),
  loadCompactionConfig: vi.fn(),
  resolveProvider: vi.fn(),
}));

vi.mock('@kodax-ai/agent', async () => {
  // Partial mock: only override `compact`. Keep all other exports real.
  // (v0.7.35.1 FEATURE_142 Batch B: compact() moved from @kodax-ai/agent to
  // @kodax-ai/agent; mock the new home — see ADR-021.)
  const actual = await vi.importActual<typeof import('@kodax-ai/agent')>('@kodax-ai/agent');
  return {
    ...actual,
    compact: mocks.compact,
  };
});

vi.mock('../common/compaction-config.js', () => ({
  loadCompactionConfig: mocks.loadCompactionConfig,
}));

vi.mock('@kodax-ai/coding', async () => {
  const actual = await vi.importActual<typeof import('@kodax-ai/coding')>('@kodax-ai/coding');
  return {
    ...actual,
    resolveProvider: mocks.resolveProvider,
  };
});

import { BUILTIN_COMMANDS, type CommandCallbacks, type CurrentConfig } from './commands.js';
import { createInteractiveContext, type InteractiveContext } from './context.js';

describe('/compact command', () => {
  let context: InteractiveContext;
  let callbacks: CommandCallbacks;
  let currentConfig: CurrentConfig;

  beforeEach(async () => {
    context = await createInteractiveContext({});
    context.contextTokenSnapshot = {
      currentTokens: 50000,
      baselineEstimatedTokens: 50000,
      source: 'estimate',
    };

    callbacks = {
      exit: vi.fn(),
      saveSession: vi.fn(async () => {}),
      loadSession: vi.fn(async (): Promise<'loaded'> => 'loaded') as CommandCallbacks['loadSession'],
      listSessions: vi.fn(async () => {}),
      clearHistory: vi.fn(),
      printHistory: vi.fn(),
      startCompacting: vi.fn(),
      stopCompacting: vi.fn(),
      ui: {} as CommandCallbacks['ui'],
    };

    currentConfig = {
      provider: 'zhipu-coding',
      thinking: true,
      reasoningMode: 'auto',
      agentMode: 'ama',
      permissionMode: 'accept-edits',
    };

    mocks.resolveProvider.mockReturnValue({
      getContextWindow: () => 200000,
      getEffectiveMaxOutputTokens: () => 32_000,
    });
    mocks.loadCompactionConfig.mockResolvedValue({
      enabled: false,
      triggerPercent: 75,
    });
    mocks.compact.mockResolvedValue({
      compacted: false,
      messages: context.messages,
      tokensBefore: 50000,
      tokensAfter: 50000,
      entriesRemoved: 0,
    });
  });

  it('keeps manual /compact available when auto-compaction is disabled', async () => {
    const compactCommand = BUILTIN_COMMANDS.find(command => command.name === 'compact');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(compactCommand).toBeDefined();
    await compactCommand!.handler([], context, callbacks, currentConfig);

    expect(mocks.compact).toHaveBeenCalledTimes(1);
    const compactionConfig = mocks.compact.mock.calls[0]?.[1];
    expect(compactionConfig).toMatchObject({
      enabled: true,
      triggerPercent: 75,
    });
    expect(mocks.compact.mock.calls[0]?.[6]).toBe(50000);
    expect(mocks.compact.mock.calls[0]?.[10]).toBe(true);
    expect(mocks.compact.mock.calls[0]?.[11]).toBe(32_000);
    expect(logSpy.mock.calls.flat().join('\n')).not.toContain('Compaction is disabled in config');
    expect(callbacks.startCompacting).toHaveBeenCalledTimes(1);
    expect(callbacks.stopCompacting).toHaveBeenCalledTimes(1);

    logSpy.mockRestore();
  });

  it('documents enabled as auto-only in detailed help', () => {
    const compactCommand = BUILTIN_COMMANDS.find(command => command.name === 'compact');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(compactCommand?.detailedHelp).toBeDefined();
    compactCommand!.detailedHelp!();

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('/compact still works even if auto-compaction is disabled');
    expect(output).toContain('compaction.enabled: Controls auto-compaction only');
    expect(output).toContain('100 uses physical capacity');

    logSpy.mockRestore();
  });
});
