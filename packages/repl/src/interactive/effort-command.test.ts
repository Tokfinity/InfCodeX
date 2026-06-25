import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock only saveConfig so the test never touches the real ~/.kodax/config.json.
vi.mock('../common/utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../common/utils.js')>()),
  saveConfig: vi.fn(),
}));

import { saveConfig } from '../common/utils.js';
import { BUILTIN_COMMANDS } from './commands.js';
import type { CommandCallbacks, CurrentConfig, InteractiveContext } from '../commands/types.js';

const effortCmd = BUILTIN_COMMANDS.find((command) => command.name === 'effort')!;
const ctx = {} as unknown as InteractiveContext;

function createConfig(overrides: Partial<CurrentConfig> = {}): CurrentConfig {
  return {
    provider: 'openai',
    thinking: false,
    reasoningMode: 'off',
    agentMode: 'ama',
    permissionMode: 'accept-edits',
    ...overrides,
  };
}

describe('/effort command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sets explicit effort and re-enables legacy reasoning when it was off', async () => {
    const setEffort = vi.fn();
    const setReasoningMode = vi.fn();
    const callbacks = { setEffort, setReasoningMode } as unknown as CommandCallbacks;
    const config = createConfig();

    await effortCmd.handler(['high'], ctx, callbacks, config);

    expect(saveConfig).toHaveBeenCalledWith({
      effort: 'high',
      reasoningMode: 'auto',
      thinking: true,
    });
    expect(setEffort).toHaveBeenCalledWith('high');
    expect(setReasoningMode).toHaveBeenCalledWith('auto');
  });

  it('clears explicit effort with auto without changing reasoning mode', async () => {
    const setEffort = vi.fn();
    const setReasoningMode = vi.fn();
    const callbacks = { setEffort, setReasoningMode } as unknown as CommandCallbacks;
    const config = createConfig({ effort: 'high', reasoningMode: 'deep', thinking: true });

    await effortCmd.handler(['auto'], ctx, callbacks, config);

    expect(saveConfig).toHaveBeenCalledWith({ effort: undefined });
    expect(setEffort).toHaveBeenCalledWith(undefined);
    expect(setReasoningMode).not.toHaveBeenCalled();
  });

  it('restores auto reasoning when clearing a previous none effort', async () => {
    const setEffort = vi.fn();
    const setReasoningMode = vi.fn();
    const callbacks = { setEffort, setReasoningMode } as unknown as CommandCallbacks;
    const config = createConfig({ effort: 'none', reasoningMode: 'off', thinking: false });

    await effortCmd.handler(['auto'], ctx, callbacks, config);

    expect(saveConfig).toHaveBeenCalledWith({
      effort: undefined,
      reasoningMode: 'auto',
      thinking: true,
    });
    expect(setEffort).toHaveBeenCalledWith(undefined);
    expect(setReasoningMode).toHaveBeenCalledWith('auto');
  });

  it('maps none to legacy reasoning off for visible runtime state', async () => {
    const setEffort = vi.fn();
    const setReasoningMode = vi.fn();
    const callbacks = { setEffort, setReasoningMode } as unknown as CommandCallbacks;
    const config = createConfig({ reasoningMode: 'auto', thinking: true });

    await effortCmd.handler(['none'], ctx, callbacks, config);

    expect(saveConfig).toHaveBeenCalledWith({
      effort: 'none',
      reasoningMode: 'off',
      thinking: false,
    });
    expect(setEffort).toHaveBeenCalledWith('none');
    expect(setReasoningMode).toHaveBeenCalledWith('off');
  });

  it('rejects whitespace-split effort values without persisting', async () => {
    const callbacks = {} as unknown as CommandCallbacks;
    await effortCmd.handler(['high', 'now'], ctx, callbacks, createConfig());

    expect(saveConfig).not.toHaveBeenCalled();
  });
});
