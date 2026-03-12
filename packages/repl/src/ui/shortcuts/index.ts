/**
 * Keyboard Shortcuts System
 * 键盘快捷键系统
 *
 * Reference: Issue 083 - 键盘快捷键系统
 *
 * This module provides a centralized, discoverable, and configurable
 * keyboard shortcuts system for KodaX.
 *
 * Features:
 * - Centralized registry for all shortcuts
 * - Context-aware activation (global, input, streaming)
 * - Priority-based conflict resolution
 * - User-configurable key bindings
 * - React hooks for easy integration
 *
 * @example
 * ```tsx
 * import { useShortcut, getShortcutsRegistry, DEFAULT_SHORTCUTS } from './shortcuts';
 *
 * // Register default shortcuts
 * const registry = getShortcutsRegistry();
 * registry.registerAll(DEFAULT_SHORTCUTS);
 *
 * // Use in component
 * function MyComponent() {
 *   useShortcut('clearScreen', () => {
 *     console.clear();
 *     return true;
 *   });
 * }
 * ```
 */

// === Types ===
export type {
  ShortcutActionId,
  KeyBinding,
  ShortcutContext,
  ShortcutCategory,
  ShortcutDefinition,
  ShortcutHandler,
  UseShortcutOptions,
  RegisteredShortcut,
  KeyMatchResult,
} from './types.js';

// === Registry ===
export { ShortcutsRegistry, getShortcutsRegistry } from './ShortcutsRegistry.js';

// === Default Shortcuts ===
export {
  DEFAULT_SHORTCUTS,
  getShortcutsByContext,
  getShortcutsByCategory,
  getConfigurableShortcuts,
} from './defaultShortcuts.js';

// === Hooks ===
export {
  useShortcut,
  useShortcuts,
  useContextShortcuts,
  useShortcutsByCategory,
  useShortcutMatcher,
} from './useShortcut.js';

// === Provider ===
export {
  ShortcutsProvider,
  useShortcutsContext,
  useHelpVisibility,
  useShortcutContext,
} from './ShortcutsProvider.js';
export type { ShortcutsContextValue, ShortcutsProviderProps } from './ShortcutsProvider.js';

// === Global Shortcuts Component ===
export { GlobalShortcuts } from './GlobalShortcuts.js';
export type { GlobalShortcutsProps } from './GlobalShortcuts.js';
