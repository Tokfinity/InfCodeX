/**
 * Utils exports - Utils 导出
 *
 * Centralizes exports of all utility modules, simplifying import paths - 集中导出所有工具模块，简化导入路径
 * Includes modules extracted from InkREPL.tsx (Issue 016) - 鍖呭惈浠?InkREPL.tsx 鎻愬彇鐨勬ā鍧?(Issue 016)
 */

// Text buffer utilities
export { TextBuffer } from "./text-buffer.js";
export type { CursorPosition, TextBufferOptions } from "./text-buffer.js";

// Text processing utilities
export {
  LRUCache,
  getCodePointLength,
  getVisualWidth,
  getCharAtCodePoint,
  splitByCodePoints,
  truncateByVisualWidth,
  isWideChar,
  visualWidthCache,
  getVisualWidthCached,
  calculateVisualLayout,
  calculateVisualCursorFromLayout,
} from "./textUtils.js";

// Terminal capabilities
export {
  detectTerminalCapabilities,
  supportsTrueColor,
  supports256Colors,
  supportsUnicode,
  supportsEmoji,
  getTerminalWidth,
  isScreenReader,
} from "./terminalCapabilities.js";
export type { TerminalCapabilities } from "./terminalCapabilities.js";

export {
  detectTerminalRenderHost,
  detectTerminalHostProfile,
  getTerminalHostCapabilities,
  hasCursorUpViewportYankRisk,
  hasMainScreenRenderScrollRisk,
  isRemoteConptyHost,
  isTmuxControlMode,
  isVsCodeTerminalHostEnv,
  resetTmuxControlModeProbeForTesting,
  resolveConfiguredTuiRendererMode,
  resolveEffectiveTuiRendererMode,
  resolveFullscreenPolicy,
  resolveInteractiveSurfacePreference,
  isOwnedRendererPreferred,
  isClassicReplForced,
} from "./terminal-host-profile.js";
export type {
  EffectiveTuiRendererMode,
  FullscreenPolicy,
  InteractiveSurfacePreference,
  TerminalHostCapabilities,
  TerminalHostDetectionOptions,
  TerminalHostProfile,
  TerminalRenderHost,
  TuiRendererMode,
} from "./terminal-host-profile.js";

// Console capture utilities (Issue 040, 045)
export { ConsoleCapturer, withCapture, withCaptureSync } from "./console-capturer.js";

// Retry history utilities
export {
  createRetryHistoryItem,
  emitRetryHistoryItem,
  createRecoveryHistoryItem,
  emitRecoveryHistoryItem,
} from "./retry-history.js";

// Message processing utilities
export {
  extractHistorySeedsFromMessage,
  extractHistorySeedsFromMessages,
  extractTextContent,
  extractTitle,
  formatMessagePreview,
  seedToHistoryItem,
  toolCallSeedToHistoryToolCall,
} from "./message-utils.js";
export type {
  HistorySeedSourceMessage,
  RestoredHistorySeed,
} from "./message-utils.js";

export {
  restoreHistoryItemsFromSession,
  trimPersistedUiHistorySnapshot,
} from "./restore-history.js";
export type { RestoreHistoryItemsFromSessionInput } from "./restore-history.js";

// Session storage utilities
export {
  MemorySessionStorage,
  createMemorySessionStorage,
  type SessionData,
  type SessionStorage,
} from "./session-storage.js";

// Shell execution utilities
export {
  executeShellCommand,
  isShellCommand,
  isShellCommandSuccess,
  processSpecialSyntax,
  type ShellExecutorConfig,
} from "./shell-executor.js";

// Keypress parser utilities
export {
  parseKeypress,
  KeypressParser,
  isFunctionKey,
  isPrintable,
  getKeyDisplayName,
} from "./keypress-parser.js";
