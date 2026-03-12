/**
 * useShortcut - React Hook for Keyboard Shortcuts
 * useShortcut - 键盘快捷键 React Hook
 *
 * Reference: Issue 083 - 键盘快捷键系统
 *
 * This hook integrates with the existing KeypressContext priority system
 * and the centralized ShortcutsRegistry.
 */

import { useEffect, useCallback, useRef } from 'react';
import { useKeypress } from '../contexts/KeypressContext.js';
import type { KeyInfo } from '../types.js';
import {
  type ShortcutActionId,
  type ShortcutHandler,
  type ShortcutContext,
  type UseShortcutOptions,
  type ShortcutDefinition,
} from './types.js';
import { getShortcutsRegistry } from './ShortcutsRegistry.js';

/**
 * Register a keyboard shortcut handler
 * 注册键盘快捷键处理函数
 *
 * @param actionId - The shortcut action ID to handle - 要处理的快捷键操作 ID
 * @param handler - The handler function - 处理函数
 * @param options - Optional configuration - 可选配置
 *
 * @example
 * ```tsx
 * // Basic usage
 * useShortcut('clearScreen', () => {
 *   console.clear();
 *   return true; // Return true to consume the event
 * });
 *
 * // With options
 * useShortcut('clearScreen', () => {
 *   console.clear();
 *   return true;
 * }, { context: 'global' });
 *
 * // Conditional activation
 * useShortcut('submitInput', handleSubmit, { isActive: isInputFocused });
 * ```
 */
export function useShortcut(
  actionId: ShortcutActionId,
  handler: ShortcutHandler,
  options: UseShortcutOptions = {}
): void {
  const { context, isActive = true } = options;

  // Get the shortcuts registry
  const registry = getShortcutsRegistry();

  // Store handler in ref to avoid re-registering on handler changes
  const handlerRef = useRef<ShortcutHandler>(handler);
  handlerRef.current = handler;

  // Register the shortcut definition and handler on mount
  useEffect(() => {
    // Set handler in registry
    registry.setHandler(actionId, (...args) => handlerRef.current(...args));

    // Cleanup: clear handler on unmount
    return () => {
      registry.setHandler(actionId, undefined);
    };
  }, [registry, actionId]);

  // Create the keypress handler that checks for shortcut match
  const keypressHandler = useCallback(
    (keyInfo: KeyInfo): boolean => {
      if (!isActive) {
        return false;
      }

      // Get the shortcut definition to find its priority
      const shortcuts = registry.getAllShortcuts();
      const shortcut = shortcuts.find((s) => s.definition.id === actionId);

      if (!shortcut) {
        return false;
      }

      // Check if the context matches
      const shortcutContext = context ?? shortcut.definition.context;
      const effectiveContext: ShortcutContext =
        shortcutContext === 'global' ? 'input' : shortcutContext; // 'global' works in all contexts

      // Check if key matches the shortcut's bindings
      const match = registry.findMatchingShortcut(keyInfo, effectiveContext);

      if (match && match.definition.id === actionId) {
        // Execute the handler
        const result = handlerRef.current();
        return result === true;
      }

      return false;
    },
    [registry, actionId, isActive, context]
  );

  // Get priority from the shortcut definition
  const priority = getShortcutPriority(actionId, registry);

  // Register with the KeypressContext
  useKeypress(keypressHandler, {
    isActive,
    priority,
  });
}

/**
 * Get priority for a shortcut action
 * 获取快捷键操作的优先级
 */
function getShortcutPriority(
  actionId: ShortcutActionId,
  registry: ReturnType<typeof getShortcutsRegistry>
): number {
  const shortcuts = registry.getAllShortcuts();
  const shortcut = shortcuts.find((s) => s.definition.id === actionId);

  if (shortcut) {
    return shortcut.definition.priority;
  }

  // Default priority if shortcut not found
  return 0;
}

/**
 * Hook to register multiple shortcuts at once
 * 一次注册多个快捷键的 Hook
 *
 * @param shortcuts - Array of shortcut registrations - 快捷键注册数组
 *
 * @example
 * ```tsx
 * useShortcuts([
 *   { actionId: 'clearScreen', handler: handleClearScreen },
 *   { actionId: 'toggleThinking', handler: handleToggleThinking },
 *   { actionId: 'interrupt', handler: handleInterrupt },
 * ]);
 * ```
 */
export function useShortcuts(
  shortcuts: Array<{
    actionId: ShortcutActionId;
    handler: ShortcutHandler;
    options?: UseShortcutOptions;
  }>
): void {
  for (const { actionId, handler, options } of shortcuts) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useShortcut(actionId, handler, options);
  }
}

/**
 * Hook to get all shortcuts for a specific context
 * 获取特定上下文所有快捷键的 Hook
 *
 * Useful for displaying help/shortcuts list
 */
export function useContextShortcuts(context: ShortcutContext) {
  const registry = getShortcutsRegistry();
  return registry.getShortcutsByContext(context);
}

/**
 * Hook to get all shortcuts grouped by category
 * 获取按分类分组的所有快捷键的 Hook
 */
export function useShortcutsByCategory() {
  const registry = getShortcutsRegistry();

  const categories: Record<string, ShortcutDefinition[]> = {
    global: [],
    mode: [],
    navigation: [],
    editing: [],
  };

  const shortcuts = registry.getAllShortcuts();

  for (const shortcut of shortcuts) {
    const category = shortcut.definition.category;
    if (!categories[category]) {
      categories[category] = [];
    }
    categories[category].push(shortcut.definition);
  }

  return categories;
}

/**
 * Hook to check if a key event matches any registered shortcut
 * 检查按键事件是否匹配任何已注册快捷键的 Hook
 */
export function useShortcutMatcher(context: ShortcutContext) {
  const registry = getShortcutsRegistry();

  return useCallback(
    (keyInfo: KeyInfo) => {
      return registry.findMatchingShortcut(keyInfo, context);
    },
    [registry, context]
  );
}
