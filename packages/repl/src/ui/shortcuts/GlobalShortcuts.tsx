/**
 * GlobalShortcuts - Global Keyboard Shortcuts Handler
 *
 * This component registers global shortcuts using the shortcuts system.
 * It should be placed inside the component tree where it can access
 * the necessary state and callbacks.
 */

import type React from 'react';
import chalk from 'chalk';
import {
  type KodaXAgentMode,
  KODAX_REASONING_MODE_SEQUENCE,
  type KodaXReasoningMode,
} from '@kodax-ai/coding';
// FEATURE_093 (v0.7.24): import from concrete module, not the barrel,
// to break the `ui/shortcuts/index.ts ↔ ui/shortcuts/GlobalShortcuts.tsx` cycle.
import { useShortcut } from './useShortcut.js';
import type { CurrentConfig } from '../../interactive/commands.js';
import type { PermissionMode } from '../../permission/types.js';
import { saveConfig } from '../../common/utils.js';

export interface GlobalShortcutsProps {
  currentConfig: CurrentConfig;
  setCurrentConfig: React.Dispatch<React.SetStateAction<CurrentConfig>>;
  isLoading: boolean;
  abort: () => void;
  stopThinking: () => void;
  clearThinkingContent: () => void;
  setCurrentTool: (tool: string | undefined) => void;
  setIsLoading: (loading: boolean) => void;
  onToggleHelp: () => void;
  setShowHelp: (visible: boolean) => void;
  onSetThinking?: (enabled: boolean) => void;
  onSetReasoningMode?: (mode: KodaXReasoningMode) => void;
  onToggleTranscriptMode?: () => void;
  onOpenTranscriptSearch?: () => void;
  canOpenTranscriptSearch?: boolean;
  isInteractiveDialogActive?: boolean;
  onSetAgentMode?: (mode: KodaXAgentMode) => void;
  onSetPermissionMode?: (mode: PermissionMode) => void;
  isInputEmpty: boolean;
  onSavePermissionMode?: (mode: PermissionMode) => void;
}

export function GlobalShortcuts({
  currentConfig,
  setCurrentConfig,
  isLoading,
  abort,
  stopThinking,
  clearThinkingContent,
  setCurrentTool,
  setIsLoading,
  onToggleHelp,
  setShowHelp,
  onSetThinking,
  onSetReasoningMode,
  onToggleTranscriptMode,
  onOpenTranscriptSearch,
  canOpenTranscriptSearch = true,
  isInteractiveDialogActive = false,
  onSetAgentMode,
  onSetPermissionMode,
  isInputEmpty,
  onSavePermissionMode,
}: GlobalShortcutsProps): null {
  useShortcut(
    'interrupt',
    () => {
      if (isLoading) {
        abort();
        stopThinking();
        clearThinkingContent();
        setCurrentTool(undefined);
        setIsLoading(false);
        console.log(chalk.yellow('\n[Interrupted]'));
        return true;
      }
      return false;
    },
    { isActive: isLoading },
  );

  useShortcut(
    'showHelp',
    () => {
      if (isInteractiveDialogActive) {
        return false;
      }
      if (isInputEmpty) {
        onToggleHelp();
        return true;
      }
      return false;
    },
    { isActive: isInputEmpty },
  );

  useShortcut('toggleThinking', () => {
    if (isInteractiveDialogActive) {
      return false;
    }
    const currentIndex = KODAX_REASONING_MODE_SEQUENCE.indexOf(
      currentConfig.reasoningMode,
    );
    const nextMode =
      KODAX_REASONING_MODE_SEQUENCE[
        (currentIndex + 1) % KODAX_REASONING_MODE_SEQUENCE.length
      ];
    const thinking = nextMode !== 'off';

    setCurrentConfig((prev) => ({
      ...prev,
      thinking,
      reasoningMode: nextMode,
    }));
    saveConfig({
      reasoningMode: nextMode,
      thinking,
    });
    onSetReasoningMode?.(nextMode);
    onSetThinking?.(thinking);
    setShowHelp(false);
    return true;
  });

  useShortcut('toggleTranscriptMode', () => {
    if (isInteractiveDialogActive) {
      return false;
    }
    onToggleTranscriptMode?.();
    setShowHelp(false);
    return true;
  });

  useShortcut('openTranscriptSearch', () => {
    if (isInteractiveDialogActive || !canOpenTranscriptSearch) {
      return false;
    }
    onOpenTranscriptSearch?.();
    setShowHelp(false);
    return true;
  });

  useShortcut('togglePermissionMode', () => {
    if (isInteractiveDialogActive) {
      return false;
    }
    // Canonical names only — persisting 'auto-in-project' here triggered a startup deprecation warn that drifted the cursor by one row.
    const modeCycle: PermissionMode[] = ['plan', 'accept-edits', 'auto'];
    // Map the deprecated alias to its canonical position so legacy configs
    // advance from 'auto's slot, not via the indexOf=-1 wrap fallback.
    const aliasedCurrent =
      currentConfig.permissionMode === 'auto-in-project'
        ? 'auto'
        : currentConfig.permissionMode;
    const currentIndex = modeCycle.indexOf(aliasedCurrent);
    const nextIndex = (currentIndex + 1) % modeCycle.length;
    const newMode = modeCycle[nextIndex];

    setCurrentConfig((prev) => ({ ...prev, permissionMode: newMode }));
    onSetPermissionMode?.(newMode);
    onSavePermissionMode?.(newMode);
    setShowHelp(false);
    return true;
  });

  useShortcut('toggleAgentMode', () => {
    if (isInteractiveDialogActive) {
      return false;
    }
    const nextMode: KodaXAgentMode = currentConfig.agentMode === 'sa' ? 'ama' : 'sa';

    setCurrentConfig((prev) => ({ ...prev, agentMode: nextMode }));
    saveConfig({ agentMode: nextMode });
    onSetAgentMode?.(nextMode);
    setShowHelp(false);
    return true;
  });

  return null;
}
