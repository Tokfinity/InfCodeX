/**
 * KodaX - 极致轻量化 Coding Agent
 *
 * 根入口文件 - 代理到 monorepo packages
 */

// Core API - 从 @kodax-ai/coding 重新导出
export * from '@kodax-ai/coding';
export {
  ACP_LOG_LEVELS,
  AcpLogger,
  resolveAcpLogLevel,
  type AcpLogLevel,
} from './acp_logger.js';
export {
  AcpEventEmitter,
  type AcpEventSink,
  type AcpRuntimeEvent,
} from './acp_events.js';
export {
  createKodaXRuntime,
} from './sdk-runtime.js';
export type {
  CreateKodaXRuntimeOptions,
  KodaXRuntime,
  KodaXRuntimeMode,
  RuntimeCreateSessionInput,
  RuntimeEvent,
  RuntimeEventEnvelope,
  RuntimeEventFilter,
  RuntimeEventListener,
  RuntimeEventReplayFilter,
  RuntimeEventService,
  RuntimeEventType,
  RuntimeForkSessionInput,
  RuntimeIdentity,
  RuntimeKodaXOptions,
  RuntimePermissionDecision,
  RuntimePermissionFilter,
  RuntimePermissionRequest,
  RuntimePermissionRisk,
  RuntimePermissionScope,
  RuntimePermissionService,
  RuntimeRunFilter,
  RuntimeRunHandle,
  RuntimeRunPhase,
  RuntimeRunResult,
  RuntimeRunService,
  RuntimeRunStatus,
  RuntimeSession,
  RuntimeSessionFilter,
  RuntimeSessionService,
  RuntimeSessionSummary,
  RuntimeSubscription,
  RuntimeTextInput,
  RuntimeTranscript,
  RuntimeWorkflowFilter,
  RuntimeWorkflowListener,
  RuntimeWorkflowService,
  RuntimeWorkflowSnapshot,
  RuntimeWorkflowSummary,
} from './sdk-runtime.js';
// ACP server API - server `cwd` can pin the session-level executionCwd for prompts and tools.
export { KodaXAcpServer, runAcpServer, type KodaXAcpServerOptions } from './acp_server.js';

// REPL API - 从 @kodax-ai/repl 重新导出
export {
  runInkInteractiveMode,
  type InkREPLOptions,
  runInteractiveMode,
  processSpecialSyntax,
  type RepLOptions,
  InteractiveContext,
  createInteractiveContext,
  touchContext,
  parseCommand,
  executeCommand,
  BUILTIN_COMMANDS,
  type Command,
  type CommandCallbacks,
  type CurrentConfig,
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
  FileSessionStorage,
} from '@kodax-ai/repl';
