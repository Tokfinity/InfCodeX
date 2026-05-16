import type {
  KodaXBaseProvider,
  KodaXMessage,
  KodaXReasoningMode,
} from '@kodax-ai/llm';
import type {
  KodaXExtensionSessionRecord,
  KodaXExtensionStore,
  KodaXJsonValue,
} from '../types.js';
import type {
  LocalToolDefinition,
  RegisteredToolDefinition,
} from '../tools/types.js';

import type { ExecOptions, ExecResult, WebhookOptions, WebhookResult } from './helpers.js';
export type { ExecOptions, ExecResult, WebhookOptions, WebhookResult } from './helpers.js';

// FEATURE_082 (v0.7.24): capability contract lives in `@kodax-ai/core` so
// third-party providers (MCP, RAG, custom indexes, …) can implement it
// without a coding dependency. Re-exported here for backward compatibility.
import type {
  CapabilityKind,
  CapabilityProvider,
  CapabilityResult,
} from '@kodax-ai/agent';
export type { CapabilityKind, CapabilityProvider, CapabilityResult };

export interface ModelProviderRegistration {
  name: string;
  factory: () => KodaXBaseProvider;
}

export interface ExtensionCommandDefinition {
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  metadata?: Record<string, unknown>;
  handler: (
    args: string[],
    context: ExtensionCommandContext,
  ) => Promise<ExtensionCommandResult | void> | ExtensionCommandResult | void;
}

export interface ExtensionModelSelection {
  provider?: string;
  model?: string;
}

export interface ExtensionLogger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface ExtensionFileContributionSource {
  kind: 'extension';
  id: string;
  label: string;
  path: string;
}

export interface RuntimeContributionSource {
  kind: 'runtime';
  id: string;
  label: string;
  path?: string;
}

export type ExtensionContributionSource =
  | ExtensionFileContributionSource
  | RuntimeContributionSource;

export type ExtensionLoadSource = 'api' | 'cli' | 'config';

export interface LoadedExtensionDiagnostic {
  path: string;
  label: string;
  loadSource: ExtensionLoadSource;
  sessionStateKeys?: string[];
  sessionRecordCounts?: Record<string, number>;
}

export interface RegisteredCapabilityProviderDiagnostic {
  id: string;
  kinds: CapabilityKind[];
  source: ExtensionContributionSource;
  metadata?: Record<string, unknown>;
}

export interface RegisteredCommandDiagnostic {
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  metadata?: Record<string, unknown>;
  source: ExtensionContributionSource;
}

export interface RegisteredToolDiagnostic {
  name: string;
  description: string;
  requiredParams: string[];
  source: RegisteredToolDefinition['source'];
  shadowedSources: RegisteredToolDefinition['source'][];
}

export interface RegisteredHookDiagnostic {
  hook: keyof ExtensionHookMap;
  order: number;
  source: ExtensionContributionSource;
}

export type ExtensionFailureStage = 'load' | 'reload' | 'event' | 'hook' | 'persistence';

export interface ExtensionFailureDiagnostic {
  stage: ExtensionFailureStage;
  target: string;
  message: string;
  occurredAt: string;
  source: ExtensionContributionSource;
}

export interface ExtensionRuntimeDiagnostics {
  loadedExtensions: LoadedExtensionDiagnostic[];
  capabilityProviders: RegisteredCapabilityProviderDiagnostic[];
  commands: RegisteredCommandDiagnostic[];
  tools: RegisteredToolDiagnostic[];
  hooks: RegisteredHookDiagnostic[];
  failures: ExtensionFailureDiagnostic[];
  defaults: {
    activeTools?: string[];
    modelSelection: ExtensionModelSelection;
    thinkingLevel?: KodaXReasoningMode;
  };
}

export interface ExtensionCommandInvocation {
  prompt: string;
  displayName?: string;
  disableModelInvocation?: boolean;
  allowedTools?: string;
  context?: 'fork';
  model?: string;
}

export interface ExtensionCommandResult {
  success?: boolean;
  message?: string;
  data?: unknown;
  invocation?: ExtensionCommandInvocation;
}

export interface ExtensionCommandContext {
  sessionId?: string;
  gitRoot?: string;
  workingDirectory: string;
  reloadExtensions: () => Promise<void>;
  getDiagnostics: () => ExtensionRuntimeDiagnostics;
  logger: ExtensionLogger;
}

export interface ExtensionToolBeforeHookContext {
  name: string;
  input: Record<string, unknown>;
  toolId?: string;
  executionCwd?: string;
  gitRoot?: string;
}

export interface ExtensionProviderBeforeHookContext {
  provider: string;
  model?: string;
  reasoningMode?: KodaXReasoningMode;
  systemPrompt: string;
  block: (reason: string) => void;
  replaceProvider: (provider: string) => void;
  replaceModel: (model?: string) => void;
  replaceSystemPrompt: (systemPrompt: string) => void;
  setThinkingLevel: (level: KodaXReasoningMode) => void;
}

export interface ExtensionTurnSettleHookContext {
  sessionId: string;
  lastText: string;
  hadToolCalls: boolean;
  success: boolean;
  signal?: 'COMPLETE' | 'BLOCKED' | 'DECIDE';
  queueUserMessage: (message: string | KodaXMessage) => void;
  setModelSelection: (next: ExtensionModelSelection) => void;
  setThinkingLevel: (level: KodaXReasoningMode) => void;
}

export interface ExtensionSessionHydrateHookContext {
  sessionId: string;
  getState: <T = KodaXJsonValue>(key: string) => T | undefined;
  setState: (key: string, value: KodaXJsonValue | undefined) => void;
  listRecords: (type?: string) => KodaXExtensionSessionRecord[];
  appendRecord: (
    type: string,
    data?: KodaXJsonValue,
    options?: { dedupeKey?: string },
  ) => KodaXExtensionSessionRecord | undefined;
  clearRecords: (type?: string) => number;
}

export interface ExtensionEventMap {
  'session:start': { provider: string; sessionId: string };
  'turn:start': { sessionId: string; iteration: number; maxIter: number };
  'text:delta': { text: string };
  'thinking:delta': { text: string };
  'thinking:end': { thinking: string };
  'tool:start': { name: string; id: string; input?: Record<string, unknown> };
  'tool:result': { id: string; name: string; content: string };
  'provider:selected': { provider: string; model?: string };
  'provider:rate-limit': { provider: string; attempt: number; maxRetries: number; delayMs: number };
  'capability:search': { providerId: string; query: string; kind?: CapabilityKind; limit?: number };
  'capability:describe': { providerId: string; capabilityId: string };
  'capability:invoke': { providerId: string; capabilityId: string; kind: CapabilityKind };
  'capability:refresh': { providerId: string };
  'stream:end': undefined;
  'turn:end': {
    sessionId: string;
    iteration: number;
    lastText: string;
    hadToolCalls: boolean;
    signal?: 'COMPLETE' | 'BLOCKED' | 'DECIDE';
  };
  'complete': { success: boolean; signal?: 'COMPLETE' | 'BLOCKED' | 'DECIDE' };
  'error': { error: Error };
  // FEATURE_170 v0.7.41 — todo CRUD observability. Broadcast-only (no
  // blocking semantics). Fired after the store mutation completes. The
  // matching blocking gates live in ExtensionHookMap below.
  //
  // `'todo:updated'` fires for *every* observable mutation including
  // status flips driven by runner-side autoCompleteOnAccept /
  // markInProgressFailed / resetFailed — extensions wanting to observe
  // only LLM-initiated updates should filter via `source`.
  'todo:created': { id: string; item: KodaXTodoItem; source: TodoMutationSource };
  'todo:updated': {
    id: string;
    before: KodaXTodoItem;
    after: KodaXTodoItem;
    changedFields: readonly (keyof KodaXTodoItem)[];
    source: TodoMutationSource;
  };
  'todo:deleted': { id: string; item: KodaXTodoItem; source: TodoMutationSource };
}

/**
 * FEATURE_170 v0.7.41 — provenance tag for todo:* events / hooks. Lets
 * extension authors distinguish LLM-driven mutations (`tool`) from
 * runner-side automation (`internal`) — e.g. an extension that audits
 * todo churn should ignore `internal` flips to avoid false positives.
 */
export type TodoMutationSource = 'tool' | 'internal';

/**
 * FEATURE_170 v0.7.41 — seed shape passed to `'todo:before-create'`.
 * Mirrors `TodoAddSeed` from todo-store.ts (kept structurally compatible
 * to avoid coupling extension authors to the internal task-engine type).
 */
export interface ExtensionTodoCreateSeed {
  readonly content: string;
  readonly activeForm?: string;
  readonly evaluator?: 'build' | 'test' | 'lint';
  readonly owner?: string;
  readonly sourceObligationIndex?: number;
  readonly metadata?: Record<string, unknown>;
}

/**
 * FEATURE_170 v0.7.41 — minimal todo item shape exposed to extensions
 * via the todo:* events. Kept structurally identical to the engine's
 * `TodoItem` so the runtime can pass values straight through without
 * conversion, but redeclared here so extension consumers don't import
 * from `packages/coding/src/types.ts` (which is task-engine internal).
 */
export interface KodaXTodoItem {
  readonly id: string;
  readonly content: string;
  readonly status:
    | 'pending'
    | 'in_progress'
    | 'completed'
    | 'failed'
    | 'skipped'
    | 'cancelled';
  readonly owner?: string;
  readonly sourceObligationIndex?: number;
  readonly note?: string;
  readonly evaluator?: 'build' | 'test' | 'lint';
  readonly activeForm?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface ExtensionHookMap {
  'tool:before': (
    context: ExtensionToolBeforeHookContext,
  ) => Promise<void | string | false> | void | string | false;
  'provider:before': (
    context: ExtensionProviderBeforeHookContext,
  ) => Promise<void> | void;
  'turn:settle': (
    context: ExtensionTurnSettleHookContext,
  ) => Promise<void> | void;
  'session:hydrate': (
    context: ExtensionSessionHydrateHookContext,
  ) => Promise<void> | void;
  // FEATURE_170 v0.7.41 — todo blocking gates.
  //
  // Return semantics (mirrors `tool:before`):
  //   - `void` / `undefined`  → allow (default)
  //   - `string`              → block; the string is the reason surfaced
  //                             back to the LLM in the tool result envelope
  //   - `false`               → block without a reason (envelope uses
  //                             'blocked-by-hook' as the fallback reason)
  //
  // KodaX does NOT throw on block (unlike claudecode's
  // executeTaskCompletedHooks). Block translates to `{ok:false, reason}`
  // in the todo_create / todo_update tool result. This preserves the
  // unified KodaX tool-result envelope.
  //
  // The runner-side autoCompleteOnAccept / markInProgressFailed paths
  // (Evaluator-driven, not LLM-driven) bypass `todo:before-complete`
  // entirely — see the `source: 'internal'` event payload. Hook
  // authority is reserved for LLM-initiated mutations.
  'todo:before-create': (
    context: { seed: ExtensionTodoCreateSeed },
  ) => Promise<void | string | false> | void | string | false;
  'todo:before-complete': (
    context: { id: string; item: KodaXTodoItem },
  ) => Promise<void | string | false> | void | string | false;
}

export interface ExtensionRuntimeController {
  queueUserMessage(message: string | KodaXMessage): void;
  getSessionState<T = KodaXJsonValue>(key: string): T | undefined;
  setSessionState(key: string, value: KodaXJsonValue | undefined): void;
  appendSessionRecord(
    type: string,
    data?: KodaXJsonValue,
    options?: { dedupeKey?: string },
  ): KodaXExtensionSessionRecord | undefined;
  listSessionRecords(type?: string): KodaXExtensionSessionRecord[];
  clearSessionRecords(type?: string): number;
  getActiveTools(): string[];
  setActiveTools(toolNames: string[]): void;
  getModelSelection(): ExtensionModelSelection;
  setModelSelection(next: ExtensionModelSelection): void;
  getThinkingLevel(): KodaXReasoningMode | undefined;
  setThinkingLevel(level: KodaXReasoningMode): void;
}

export interface KodaXExtensionAPI {
  registerTool: (definition: LocalToolDefinition) => () => void;
  getTool: (name: string) => RegisteredToolDefinition | undefined;
  getBuiltinTool: (name: string) => RegisteredToolDefinition | undefined;
  registerModelProvider: (registration: ModelProviderRegistration) => () => void;
  registerCapabilityProvider: (provider: CapabilityProvider) => () => void;
  registerCommand: (command: ExtensionCommandDefinition) => () => void;
  registerSkillPath: (skillPath: string) => () => void;
  on: <TEvent extends keyof ExtensionEventMap>(
    event: TEvent,
    handler: (payload: ExtensionEventMap[TEvent]) => Promise<void> | void,
  ) => () => void;
  hook: <THook extends keyof ExtensionHookMap>(
    hook: THook,
    handler: ExtensionHookMap[THook],
  ) => () => void;
  logger: ExtensionLogger;
  config: Readonly<Record<string, unknown>>;
  runtime: ExtensionRuntimeController;
  /** Extension-scoped key-value store that persists across sessions. */
  persistence: KodaXExtensionStore;
  /** Run a shell command with sandboxed environment (no API key leakage). */
  exec: (command: string, options?: ExecOptions) => Promise<ExecResult>;
  /** Send an HTTP webhook with timeout support. */
  webhook: (url: string, payload: unknown, options?: WebhookOptions) => Promise<WebhookResult>;
}

export type KodaXExtensionActivationResult =
  | void
  | (() => void | Promise<void>)
  | Promise<void | (() => void | Promise<void>)>;

export interface KodaXExtensionModule {
  default?: (api: KodaXExtensionAPI) => KodaXExtensionActivationResult;
  activate?: (api: KodaXExtensionAPI) => KodaXExtensionActivationResult;
}
