/**
 * @kodax-ai/repl - KodaX 完整的交互式终端体验
 *
 * 提供两个入口：
 * - Ink UI (推荐): 现代化 React 终端 UI
 * - 传统 REPL: Node.js readline 实现
 */

// === 主入口：Ink UI ===
export { runInkInteractiveMode } from "./ui/index.js";
export type { InkREPLOptions } from "./ui/index.js";

// === 传统 REPL 入口 ===
export { runInteractiveMode, processSpecialSyntax, type RepLOptions } from "./interactive/repl.js";

// === UI 组件 ===
export * from "./ui/index.js";
export {
  detectTerminalRenderHost,
  detectTerminalHostProfile,
  getTerminalHostCapabilities,
  hasCursorUpViewportYankRisk,
  hasMainScreenRenderScrollRisk,
  isRemoteConptyHost,
  isTmuxControlMode,
  isVsCodeTerminalHostEnv,
  resolveConfiguredTuiRendererMode,
  resolveEffectiveTuiRendererMode,
  resolveFullscreenPolicy,
  resolveInteractiveSurfacePreference,
  isOwnedRendererPreferred,
  isClassicReplForced,
} from "./ui/utils/terminal-host-profile.js";
export type {
  EffectiveTuiRendererMode,
  FullscreenPolicy,
  InteractiveSurfacePreference,
  TerminalHostCapabilities,
  TerminalHostDetectionOptions,
  TerminalHostProfile,
  TerminalRenderHost,
  TuiRendererMode,
} from "./ui/utils/terminal-host-profile.js";

// === 交互式命令系统 ===
export {
  InteractiveContext,
  InteractiveMode,
  createInteractiveContext,
  touchContext,
} from "./interactive/context.js";
export {
  parseCommand,
  executeCommand,
  BUILTIN_COMMANDS,
  type Command,
  type CommandCallbacks,
  type CurrentConfig,
} from "./interactive/commands.js";

// === 共享工具 ===
export {
  getVersion,
  KODAX_VERSION,
  getProviderModel,
  getProviderList,
  isProviderConfigured,
  hydrateProcessEnvFromShell,
  loadConfig,
  prepareRuntimeConfig,
  registerConfiguredCustomProviders,
  saveConfig,
  getGitRoot,
  rateLimitedCall,
  KODAX_DIR,
  KODAX_SESSIONS_DIR,
  KODAX_CONFIG_FILE,
  PREVIEW_MAX_LENGTH,
} from "./common/utils.js";

// === 会话存储 ===
export { FileSessionStorage } from "./interactive/storage.js";

// === Permission helpers ===
export type { PermissionMode, ConfirmResult, PermissionContext } from "./permission/index.js";
export {
  computeConfirmTools,
  PERMISSION_MODES,
  isPermissionMode,
  normalizePermissionMode,
  permissionModeDisplayName,
  isToolCallAllowed,
  isAlwaysConfirmPath,
  isBashReadCommand,
  isBashWriteCommand,
  collectBashWriteTargets,
  isPathInsideProject,
  getBashOutsideProjectWriteRisk,
  generateSavePattern,
  getPlanModeBlockReason,
} from "./permission/index.js";

// === Auto-mode bootstrap (v0.7.42 SDK export) ===
// FEATURE_092 auto-mode guardrail wiring. SDK consumers (KodaX Space etc.)
// now reach the same bootstrap REPL uses for the `auto` permission mode,
// instead of mirroring the internal API. See packages/repl/src/interactive/
// auto-mode-bootstrap.ts for the wiring contract.
export { bootstrapAutoMode } from "./interactive/auto-mode-bootstrap.js";
export type {
  AutoModeBootstrapDeps,
  AutoModeBootstrapResult,
  ResolvedAutoModeBootstrapSettings,
} from "./interactive/auto-mode-bootstrap.js";
