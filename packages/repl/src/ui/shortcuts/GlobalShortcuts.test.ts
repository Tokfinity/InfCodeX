import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CurrentConfig } from '../../interactive/commands.js';

const {
  shortcutHandlers,
  saveConfigMock,
} = vi.hoisted(() => ({
  shortcutHandlers: new Map<string, () => boolean>(),
  saveConfigMock: vi.fn(),
}));

// FEATURE_093 (v0.7.24): GlobalShortcuts now imports `useShortcut` directly
// from `./useShortcut.js` rather than the barrel `./index.js` to avoid the
// cycle — mock the concrete path so the hook is intercepted at the source.
vi.mock('./useShortcut.js', () => ({
  useShortcut: (actionId: string, handler: () => boolean) => {
    shortcutHandlers.set(actionId, handler);
  },
}));

vi.mock('../../common/utils.js', () => ({
  saveConfig: (...args: unknown[]) => saveConfigMock(...args),
}));

import { GlobalShortcuts } from './GlobalShortcuts.js';

describe('GlobalShortcuts', () => {
  beforeEach(() => {
    shortcutHandlers.clear();
    saveConfigMock.mockReset();
  });

  it('lets Alt+M toggle agent mode and persist the change', () => {
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

    const handler = shortcutHandlers.get('toggleAgentMode');
    expect(handler).toBeDefined();
    expect(handler?.()).toBe(true);
    expect(currentConfig.agentMode).toBe('sa');
    expect(saveConfigMock).toHaveBeenCalledWith({ agentMode: 'sa' });
    expect(onSetAgentMode).toHaveBeenCalledWith('sa');
    expect(setShowHelp).toHaveBeenCalledWith(false);
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
});
