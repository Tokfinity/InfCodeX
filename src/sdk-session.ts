/**
 * SDK subpath entry — `@kodax-ai/kodax/session` (v0.7.42).
 *
 * Re-exports the Session Management Public SDK from `@kodax-ai/repl/session`.
 * Provides thin facades over FileSessionStorage + discoverInstances so SDK
 * consumers can list, load, fork, rewind, delete, watch, and manage sessions
 * without importing internal REPL machinery directly.
 *
 * Usage:
 * ```ts
 * import {
 *   listSessions,
 *   loadSession,
 *   loadFullTranscript,
 *   readConversationHistory,
 *   appendClientNotice,
 *   forkSession,
 *   rewindSession,
 *   setActiveEntry,
 *   deleteSession,
 *   listRunningSessions,
 *   watchSessions,
 *   createSessionManager,
 *   compactSession,
 *   type SessionSummary,
 *   type AppendClientNoticeOptions,
 *   type ListSessionsOptions,
 *   type SessionManager,
 * } from '@kodax-ai/kodax/session';
 * ```
 *
 * All functions NEVER throw — missing sessions return null, blocked
 * operations return error envelopes, missing directories return empty arrays
 * or no-op watchers. See FEATURE_173 Part B for the full contract.
 *
 * See docs/ADR.md ADR-024 for the SDK subpath formalization decision.
 */

// Note: direct import from the session barrel (not @kodax-ai/repl/session subpath)
// so that rollup-plugin-dts can inline types into the bundled sdk-session.d.ts.
// The @kodax-ai/repl/session subpath is used at runtime (esbuild handles it fine);
// rollup-plugin-dts does not resolve package.json subpath exports for monorepo
// workspace packages in this build configuration.
export type {
  SessionSummary,
  FullTranscriptSessionData,
  SessionReadErrorCode,
  SessionReadOptions,
  SessionConversationHistoryData,
  SessionConversationHistoryEntry,
  SessionConversationHistoryIssue,
  SessionConversationHistoryIssueCode,
  SessionConversationHistoryStatus,
  SessionConversationMutationBoundary,
  ForkSessionOptions,
  RewindSessionOptions,
  SessionBundleExportDiagnostic,
  SessionBundleExportFile,
  SessionBundleExportOptions,
  SessionBundleExportResult,
  SessionBundleExportStatus,
  AppendClientNoticeOptions,
  ListSessionsOptions,
  SessionTranscriptEntry,
  SessionTranscriptEntryType,
  WatchSessionsCallback,
  SessionManager,
  PreparedSessionAppendBaseline,
  PreparedSessionTailDelta,
  RunningSessionInfo,
  DeleteSessionResult,
  CompactSessionOptions,
  CompactSessionResult,
  CreatableHistoryItem,
  HistorySeedSourceMessage,
  RestoredHistorySeed,
  RestoreHistoryItemsFromSessionInput,
} from '@kodax-ai/repl';
export type {
  KodaXSessionUiHistoryItem,
  KodaXSessionUiHistoryItemType,
  KodaXSessionUiTextHistoryItem,
  KodaXSessionUiTextHistoryItemType,
  KodaXSessionUiToolCall,
  KodaXSessionUiToolCallStatus,
  KodaXSessionUiToolGroupHistoryItem,
  KodaXTaskResultMetadata,
  KodaXTaskResultSource,
} from '@kodax-ai/agent';
export {
  listSessions,
  loadSession,
  loadFullTranscript,
  readFullTranscript,
  readConversationHistory,
  exportSessionBundle,
  SessionReadError,
  appendClientNotice,
  forkSession,
  rewindSession,
  setActiveEntry,
  deleteSession,
  archiveSession,
  unarchiveSession,
  listRunningSessions,
  watchSessions,
  createSessionManager,
  compactSession,
  extractHistorySeedsFromMessage,
  extractHistorySeedsFromMessages,
  restoreHistoryItemsFromSession,
} from '@kodax-ai/repl';
