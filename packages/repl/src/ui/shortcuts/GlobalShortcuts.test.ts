import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentConfig } from '../../interactive/commands.js';
import type { KeyInfo } from '../types.js';

const {
  shortcutHandlers,
  saveConfigMock,
} = vi.hoisted(() => ({
  shortcutHandlers: new Map<string, (keyInfo?: KeyInfo) => boolean | void>(),
  saveConfigMock: vi.fn(),
}));

// FEATURE_093 (v0.7.24): GlobalShortcuts now imports `useShortcut` directly
// from `./useShortcut.js` rather than the barrel `./index.js` to avoid the
// cycle — mock the concrete path so the hook is intercepted at the source.
vi.mock('./useShortcut.js', () => ({
  useShortcut: (actionId: string, handler: (keyInfo?: KeyInfo) => boolean | void) => {
    shortcutHandlers.set(actionId, handler);
  },
}));

vi.mock('../../common/utils.js', () => ({
  saveConfig: (...args: unknown[]) => saveConfigMock(...args),
}));

import { GlobalShortcuts } from './GlobalShortcuts.js';
import { DEFAULT_SHORTCUTS } from './defaultShortcuts.js';

function createKey(overrides: Partial<KeyInfo>): KeyInfo {
  return {
    name: '',
    sequence: '',
    ctrl: false,
    meta: false,
    shift: false,
    insertable: false,
    ...overrides,
  };
}

describe('GlobalShortcuts', () => {
  beforeEach(() => {
    shortcutHandlers.clear();
    saveConfigMock.mockReset();
  });

  it('lets Alt+M cycle agent mode AMA -> AMAW -> SA -> AMA and persist each change', () => {
    let currentConfig: CurrentConfig = {
      provider: 'openai',
      model: 'gpt-5.4',
      thinking: false,
      reasoningMode: 'off',
      agentMode: 'ama',
      permissionMode: 'accept-edits',
    };

    const setShowHelp = vi.fn();
    const onSetAgentMode = vi.fn();

    const renderShortcuts = () => {
      GlobalShortcuts({
        currentConfig,
        setCurrentConfig: (updater) => {
          currentConfig =
            typeof updater === 'function'
              ? updater(currentConfig)
              : updater;
        },
        isLoading: false,
        abort: vi.fn(),
        stopThinking: vi.fn(),
        clearThinkingContent: vi.fn(),
        setCurrentTool: vi.fn(),
        setIsLoading: vi.fn(),
        onToggleHelp: vi.fn(),
        setShowHelp,
        onSetAgentMode,
        isInputEmpty: true,
      });
      return shortcutHandlers.get('toggleAgentMode');
    };

    let handler = renderShortcuts();
    expect(handler).toBeDefined();
    expect(handler?.()).toBe(true);
    expect(currentConfig.agentMode).toBe('amaw');
    expect(saveConfigMock).toHaveBeenLastCalledWith({ agentMode: 'amaw' });
    expect(onSetAgentMode).toHaveBeenLastCalledWith('amaw');

    handler = renderShortcuts();
    expect(handler?.()).toBe(true);
    expect(currentConfig.agentMode).toBe('sa');
    expect(saveConfigMock).toHaveBeenLastCalledWith({ agentMode: 'sa' });
    expect(onSetAgentMode).toHaveBeenLastCalledWith('sa');

    handler = renderShortcuts();
    expect(handler?.()).toBe(true);
    expect(currentConfig.agentMode).toBe('ama');
    expect(saveConfigMock).toHaveBeenLastCalledWith({ agentMode: 'ama' });
    expect(onSetAgentMode).toHaveBeenLastCalledWith('ama');
    expect(setShowHelp).toHaveBeenCalledWith(false);
  });

  it('lets Alt+M leave AMAW mode by switching to SA', () => {
    let currentConfig: CurrentConfig = {
      provider: 'openai',
      model: 'gpt-5.4',
      thinking: false,
      reasoningMode: 'off',
      agentMode: 'amaw',
      permissionMode: 'accept-edits',
    };

    const onSetAgentMode = vi.fn();

    GlobalShortcuts({
      currentConfig,
      setCurrentConfig: (updater) => {
        currentConfig =
          typeof updater === 'function'
            ? updater(currentConfig)
            : updater;
      },
      isLoading: false,
      abort: vi.fn(),
      stopThinking: vi.fn(),
      clearThinkingContent: vi.fn(),
      setCurrentTool: vi.fn(),
      setIsLoading: vi.fn(),
      onToggleHelp: vi.fn(),
      setShowHelp: vi.fn(),
      onSetAgentMode,
      isInputEmpty: true,
    });

    expect(shortcutHandlers.get('toggleAgentMode')?.()).toBe(true);
    expect(currentConfig.agentMode).toBe('sa');
    expect(saveConfigMock).toHaveBeenCalledWith({ agentMode: 'sa' });
    expect(onSetAgentMode).toHaveBeenCalledWith('sa');
  });

  it('lets Ctrl+O toggle transcript mode without persisting config', () => {
    const currentConfig: CurrentConfig = {
      provider: 'openai',
      model: 'gpt-5.4',
      thinking: false,
      reasoningMode: 'off',
      agentMode: 'ama',
      permissionMode: 'accept-edits',
    };

    const setShowHelp = vi.fn();
    const onToggleTranscriptMode = vi.fn();

    GlobalShortcuts({
      currentConfig,
      setCurrentConfig: vi.fn(),
      isLoading: false,
      abort: vi.fn(),
      stopThinking: vi.fn(),
      clearThinkingContent: vi.fn(),
      setCurrentTool: vi.fn(),
      setIsLoading: vi.fn(),
      onToggleHelp: vi.fn(),
      setShowHelp,
      onToggleTranscriptMode,
      isInputEmpty: true,
    });

    const handler = shortcutHandlers.get('toggleTranscriptMode');
    expect(handler).toBeDefined();
    expect(handler?.()).toBe(true);
    expect(onToggleTranscriptMode).toHaveBeenCalledTimes(1);
    expect(saveConfigMock).not.toHaveBeenCalled();
    expect(setShowHelp).toHaveBeenCalledWith(false);
  });

  it('does not open transcript search while interactive dialogs are active', () => {
    const currentConfig: CurrentConfig = {
      provider: 'openai',
      model: 'gpt-5.4',
      thinking: false,
      reasoningMode: 'off',
      agentMode: 'ama',
      permissionMode: 'accept-edits',
    };

    const setShowHelp = vi.fn();
    const onOpenTranscriptSearch = vi.fn();

    GlobalShortcuts({
      currentConfig,
      setCurrentConfig: vi.fn(),
      isLoading: false,
      abort: vi.fn(),
      stopThinking: vi.fn(),
      clearThinkingContent: vi.fn(),
      setCurrentTool: vi.fn(),
      setIsLoading: vi.fn(),
      onToggleHelp: vi.fn(),
      setShowHelp,
      onOpenTranscriptSearch,
      canOpenTranscriptSearch: false,
      isInputEmpty: true,
    });

    const handler = shortcutHandlers.get('openTranscriptSearch');
    expect(handler).toBeDefined();
    expect(handler?.()).toBe(false);
    expect(onOpenTranscriptSearch).not.toHaveBeenCalled();
    expect(setShowHelp).not.toHaveBeenCalled();
  });

  // Regression: Shift-Tab cycle must NOT produce the deprecated
  // 'auto-in-project' alias, which (when persisted) triggers a startup
  // `console.warn` that bypasses the cell renderer and drifts the cursor
  // by one row, causing subsequent input to paint on the wrong terminal row.
  describe('togglePermissionMode cycle does not produce deprecated alias', () => {
    function setupAndCycle(startMode: 'plan' | 'accept-edits' | 'auto' | 'auto-in-project') {
      let currentConfig: CurrentConfig = {
        provider: 'openai',
        model: 'gpt-5.4',
        thinking: false,
        reasoningMode: 'off',
        agentMode: 'ama',
        permissionMode: startMode,
      };
      const onSetPermissionMode = vi.fn();
      const onSavePermissionMode = vi.fn();
      GlobalShortcuts({
        currentConfig,
        setCurrentConfig: (updater) => {
          currentConfig =
            typeof updater === 'function' ? updater(currentConfig) : updater;
        },
        isLoading: false,
        abort: vi.fn(),
        stopThinking: vi.fn(),
        clearThinkingContent: vi.fn(),
        setCurrentTool: vi.fn(),
        setIsLoading: vi.fn(),
        onToggleHelp: vi.fn(),
        setShowHelp: vi.fn(),
        onSetPermissionMode,
        onSavePermissionMode,
        isInputEmpty: true,
      });
      const handler = shortcutHandlers.get('togglePermissionMode');
      handler?.();
      return { currentConfig, onSetPermissionMode, onSavePermissionMode };
    }

    it('plan → accept-edits', () => {
      const { currentConfig, onSavePermissionMode } = setupAndCycle('plan');
      expect(currentConfig.permissionMode).toBe('accept-edits');
      expect(onSavePermissionMode).toHaveBeenCalledWith('accept-edits');
    });

    it('accept-edits → auto (NOT auto-in-project — the bug fix)', () => {
      const { currentConfig, onSavePermissionMode } = setupAndCycle('accept-edits');
      expect(currentConfig.permissionMode).toBe('auto');
      expect(currentConfig.permissionMode).not.toBe('auto-in-project');
      expect(onSavePermissionMode).toHaveBeenCalledWith('auto');
    });

    it('auto → plan (wrap)', () => {
      const { currentConfig } = setupAndCycle('auto');
      expect(currentConfig.permissionMode).toBe('plan');
    });

    it('legacy auto-in-project config → cycles off to plan (treated as auto position)', () => {
      const { currentConfig } = setupAndCycle('auto-in-project');
      expect(currentConfig.permissionMode).toBe('plan');
    });

    it('full 3-cycle from accept-edits never lands on auto-in-project', () => {
      const seen: string[] = [];
      let currentConfig: CurrentConfig = {
        provider: 'openai',
        model: 'gpt-5.4',
        thinking: false,
        reasoningMode: 'off',
        agentMode: 'ama',
        permissionMode: 'accept-edits',
      };
      for (let i = 0; i < 3; i++) {
        GlobalShortcuts({
          currentConfig,
          setCurrentConfig: (updater) => {
            currentConfig =
              typeof updater === 'function' ? updater(currentConfig) : updater;
          },
          isLoading: false,
          abort: vi.fn(),
          stopThinking: vi.fn(),
          clearThinkingContent: vi.fn(),
          setCurrentTool: vi.fn(),
          setIsLoading: vi.fn(),
          onToggleHelp: vi.fn(),
          setShowHelp: vi.fn(),
          isInputEmpty: true,
        });
        shortcutHandlers.get('togglePermissionMode')?.();
        seen.push(currentConfig.permissionMode);
      }
      expect(seen).not.toContain('auto-in-project');
      expect(seen).toEqual(['auto', 'plan', 'accept-edits']);
    });
  });

  it('blocks mode toggles while interactive dialogs are active', () => {
    let currentConfig: CurrentConfig = {
      provider: 'openai',
      model: 'gpt-5.4',
      thinking: false,
      reasoningMode: 'off',
      agentMode: 'ama',
      permissionMode: 'accept-edits',
    };

    const setShowHelp = vi.fn();

    GlobalShortcuts({
      currentConfig,
      setCurrentConfig: (updater) => {
        currentConfig =
          typeof updater === 'function'
            ? updater(currentConfig)
            : updater;
      },
      isLoading: false,
      abort: vi.fn(),
      stopThinking: vi.fn(),
      clearThinkingContent: vi.fn(),
      setCurrentTool: vi.fn(),
      setIsLoading: vi.fn(),
      onToggleHelp: vi.fn(),
      setShowHelp,
      isInteractiveDialogActive: true,
      isInputEmpty: true,
    });

    const toggleThinking = shortcutHandlers.get('toggleThinking');

    expect(toggleThinking).toBeDefined();
    expect(toggleThinking?.()).toBe(false);
    expect(saveConfigMock).not.toHaveBeenCalled();
    expect(setShowHelp).not.toHaveBeenCalled();
  });

  it('interrupts an active run with Ctrl+C and clears live state', () => {
    const currentConfig: CurrentConfig = {
      provider: 'openai',
      model: 'gpt-5.4',
      thinking: false,
      reasoningMode: 'off',
      agentMode: 'ama',
      permissionMode: 'accept-edits',
    };
    const abort = vi.fn();
    const stopThinking = vi.fn();
    const clearThinkingContent = vi.fn();
    const setCurrentTool = vi.fn();
    const setIsLoading = vi.fn();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    GlobalShortcuts({
      currentConfig,
      setCurrentConfig: vi.fn(),
      isLoading: true,
      abort,
      stopThinking,
      clearThinkingContent,
      setCurrentTool,
      setIsLoading,
      onToggleHelp: vi.fn(),
      setShowHelp: vi.fn(),
      isInputEmpty: true,
    });

    expect(shortcutHandlers.get('interrupt')?.(
      createKey({ name: 'c', sequence: '\u0003', ctrl: true }),
    )).toBe(true);
    expect(abort).toHaveBeenCalledOnce();
    expect(stopThinking).toHaveBeenCalledOnce();
    expect(clearThinkingContent).toHaveBeenCalledOnce();
    expect(setCurrentTool).toHaveBeenCalledWith(undefined);
    expect(setIsLoading).toHaveBeenCalledWith(false);
    logSpy.mockRestore();
  });

  it('does not interrupt an active run with a single Escape shortcut call', () => {
    const currentConfig: CurrentConfig = {
      provider: 'openai',
      model: 'gpt-5.4',
      thinking: false,
      reasoningMode: 'off',
      agentMode: 'ama',
      permissionMode: 'accept-edits',
    };
    const abort = vi.fn();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    GlobalShortcuts({
      currentConfig,
      setCurrentConfig: vi.fn(),
      isLoading: true,
      abort,
      stopThinking: vi.fn(),
      clearThinkingContent: vi.fn(),
      setCurrentTool: vi.fn(),
      setIsLoading: vi.fn(),
      onToggleHelp: vi.fn(),
      setShowHelp: vi.fn(),
      isInputEmpty: true,
    });

    expect(shortcutHandlers.get('interrupt')?.(
      createKey({ name: 'escape' }),
    )).toBe(false);
    expect(abort).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('lets dialog Escape stay local while keeping Ctrl+C as a hard interrupt', () => {
    const currentConfig: CurrentConfig = {
      provider: 'openai',
      model: 'gpt-5.4',
      thinking: false,
      reasoningMode: 'off',
      agentMode: 'ama',
      permissionMode: 'accept-edits',
    };
    const abort = vi.fn();
    const stopThinking = vi.fn();
    const clearThinkingContent = vi.fn();
    const setCurrentTool = vi.fn();
    const setIsLoading = vi.fn();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    GlobalShortcuts({
      currentConfig,
      setCurrentConfig: vi.fn(),
      isLoading: true,
      abort,
      stopThinking,
      clearThinkingContent,
      setCurrentTool,
      setIsLoading,
      onToggleHelp: vi.fn(),
      setShowHelp: vi.fn(),
      isInteractiveDialogActive: true,
      isInputEmpty: true,
    });

    const interrupt = shortcutHandlers.get('interrupt');
    expect(interrupt?.(createKey({ name: 'escape' }))).toBe(false);
    expect(abort).not.toHaveBeenCalled();

    expect(interrupt?.(createKey({ name: 'c', sequence: '\u0003', ctrl: true }))).toBe(true);
    expect(abort).toHaveBeenCalledOnce();
    expect(stopThinking).toHaveBeenCalledOnce();
    expect(clearThinkingContent).toHaveBeenCalledOnce();
    expect(setCurrentTool).toHaveBeenCalledWith(undefined);
    expect(setIsLoading).toHaveBeenCalledWith(false);
    logSpy.mockRestore();
  });

  it('binds interrupt to Ctrl+C while loading', () => {
    const interrupt = DEFAULT_SHORTCUTS.find((shortcut) => shortcut.id === 'interrupt');
    expect(interrupt?.defaultBindings).toContainEqual({ key: 'c', ctrl: true });
    expect(interrupt?.defaultBindings).not.toContainEqual({ key: 'escape' });
  });
});
