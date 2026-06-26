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
  type KodaXReasoningMode,
} from '@kodax-ai/coding';
// FEATURE_093 (v0.7.24): import from concrete module, not the barrel,
// to break the `ui/shortcuts/index.ts ↔ ui/shortcuts/GlobalShortcuts.tsx` cycle.
import { useShortcut } from './useShortcut.js';
import type { CurrentConfig } from '../../interactive/commands.js';
import type { PermissionMode } from '../../permission/types.js';
import { nextAgentMode } from '../../common/agent-mode.js';
import { getProviderReasoningEffortCycle, saveConfig } from '../../common/utils.js';
import type { KeyInfo } from '../types.js';

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
  const isCtrlCInterrupt = (keyInfo: KeyInfo | undefined): boolean =>
    keyInfo?.name?.toLowerCase() === 'c' && keyInfo.ctrl === true;

  useShortcut(
    'interrupt',
    (keyInfo) => {
      if (!isCtrlCInterrupt(keyInfo)) {
        return false;
      }
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
    // Cycle the active model's V2 effort ladder (off → … → max → auto → off),
    // not the legacy reasoning-mode sequence. `effort` drives both the runtime
    // request and the status bar; `reasoningMode`/`thinking` are kept coherent
    // as derived compatibility fields.
    const cycle = getProviderReasoningEffortCycle(
      currentConfig.provider,
      currentConfig.model,
    );
    if (cycle.length === 0) {
      return false;
    }
    const currentLabel =
      !currentConfig.effortOverride
      || currentConfig.effort === undefined
      || currentConfig.effort === 'auto'
        ? 'auto'
        : currentConfig.effort === 'none'
          ? 'off'
          : currentConfig.effort;
    const currentIndex = cycle.indexOf(currentLabel);
    const next = cycle[(currentIndex + 1) % cycle.length] ?? cycle[0]!;

    // `auto` clears the explicit override (model default); `off` disables
    // thinking (internal `none`); everything else is an explicit effort.
    const effort = next === 'auto' ? undefined : next === 'off' ? 'none' : next;
    const effortOverride = next !== 'auto';
    const thinking = next !== 'off';
    // `reasoningMode` is the harness "auto" track: dynamic per-task depth and
    // CAP-019 auto-reroute escalation are BOTH gated on `mode === 'auto'`
    // (coding/reasoning.ts:1682,1729). Keep it 'auto' for every thinking-on
    // rung — the explicit effort drives the provider, but it must not silently
    // disable harness escalation. This mirrors the `/effort` command, which
    // leaves reasoningMode='auto' when setting an explicit effort.
    const reasoningMode: KodaXReasoningMode = next === 'off' ? 'off' : 'auto';

    setCurrentConfig((prev) => ({
      ...prev,
      effort,
      effortOverride,
      thinking,
      reasoningMode,
    }));
    saveConfig({ effort, thinking, reasoningMode });
    onSetReasoningMode?.(reasoningMode);
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
    const nextMode: KodaXAgentMode = nextAgentMode(currentConfig.agentMode);

    setCurrentConfig((prev) => ({ ...prev, agentMode: nextMode }));
    saveConfig({ agentMode: nextMode });
    onSetAgentMode?.(nextMode);
    setShowHelp(false);
    return true;
  });

  return null;
}
