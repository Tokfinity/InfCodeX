import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { Readable, Writable } from 'node:stream';
import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  ndJsonStream,
  type Agent,
  type ContentBlock,
  type InitializeRequest,
  type InitializeResponse,
  type McpServer,
  type NewSessionRequest,
  type NewSessionResponse,
  type PermissionOption,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionResponse,
  type SessionMode,
  type SessionModeState,
  type SessionNotification,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type ToolCallUpdate,
  type ToolKind,
} from '@agentclientprotocol/sdk';
import {
  KODAX_DEFAULT_PROVIDER,
  type KodaXContextTokenSnapshot,
  type KodaXOptions,
  type KodaXReasoningMode,
  type KodaXWireReasoningEffort,
  isToolFileMutation,
  normalizeReasoningEffortValue,
  parseReasoningEffortEnv,
  combineExtensionRuntimes,
  createExtensionRuntime,
  dedupeExtensionPathsByEntrypoint,
  discoverDefaultExtensions,
  excludeExtensionPathsByEntrypoint,
  registerConfiguredMcpCapabilityProvider,
  buildMcpReverseCapabilities,
  shutdownDefaultLspService,
  type CombinedExtensionRuntime,
  type KodaXExtensionRuntime,
} from '@kodax-ai/coding';
import {
  computeConfirmTools,
  FileSessionStorage,
  collectBashWriteTargets,
  generateSavePattern,
  getBashOutsideProjectWriteRisk,
  getPlanModeBlockReason,
  isAlwaysConfirmPath,
  isBashReadCommand,
  isPathInsideProject,
  isToolCallAllowed,
  prepareRuntimeConfig,
  resolveRuntimeEffortSelection,
  resolveRuntimeModelSelection,
  resolveRuntimeProviderSelection,
  KODAX_CONFIG_FILE,
} from '@kodax-ai/repl';
import {
  createBashPrefixExtractor,
  resolveProvider,
  type BashPrefixExtractor,
} from '@kodax-ai/coding';
import {
  AcpLogger,
  resolveAcpLogLevel,
  type AcpLogLevel,
} from './acp_logger.js';
import {
  AcpEventEmitter,
  type AcpEventSink,
} from './acp_events.js';
import {
  createKodaXRuntime,
  type KodaXRuntime,
  type RuntimeRunHandle,
  type RuntimeRunPhase,
} from './sdk-runtime.js';

/**
 * Permission mode ids exposed to ACP clients. These are wire-protocol values
 * advertised in `SessionMode.id`, so the set is intentionally narrower than
 * the canonical `PermissionMode` from `@kodax-ai/repl`.
 *
 * Why `'auto'` (canonical FEATURE_092 v0.7.33) is **not** here:
 *
 *   1. ACP's auto-mode classifier path requires an interactive `askUser`
 *      surface (the readline confirm prompt or Ink confirm dialog).
 *      `KodaXAcpServer` runs out-of-process and routes confirmations through
 *      `connection.requestPermission` — a different protocol that has no
 *      structural place for the classifier-escalate `<reason>` payload.
 *   2. ACP clients that want auto-style behavior continue to use the
 *      legacy alias `'auto-in-project'`, which goes through
 *      `evaluateToolPermission` → `requestPermissionFromClient` (no LLM
 *      classifier, identical pre-v0.7.33 semantics).
 *   3. Once an ACP-native classifier-escalate channel lands, `'auto'` will
 *      be added here as a third id without breaking existing clients.
 */
export const ACP_PERMISSION_MODE_IDS = ['plan', 'accept-edits', 'auto-in-project'] as const;
export type AcpPermissionMode = (typeof ACP_PERMISSION_MODE_IDS)[number];

// v0.7.42 — replaced the hardcoded `Set(['write', 'edit'])` with the
// metadata-driven `isToolFileMutation` from `@kodax-ai/coding`. The old
// 2-element list silently under-classified `multi_edit`,
// `insert_after_anchor`, `undo`, `worktree_*`, construction-staircase
// writes, etc. — ACP clients were not asked for protected-path / outside-
// project confirmation on those tools. The metadata path auto-syncs as
// new write tools are added.
function acpIsFileModificationTool(toolName: string): boolean {
  return isToolFileMutation(toolName);
}
const ACP_TOOL_KIND_MAP: Record<string, ToolKind> = {
  read: 'read',
  write: 'edit',
  edit: 'edit',
  undo: 'edit',
  bash: 'execute',
  grep: 'search',
  glob: 'search',
  think: 'think',
  fetch: 'fetch',
};

const ACP_PERMISSION_MODE_DEFINITIONS: SessionMode[] = [
  {
    id: 'plan',
    name: 'Plan',
    description: 'Read-only planning mode. File modifications are blocked except the plan-mode whitelist.',
  },
  {
    id: 'accept-edits',
    name: 'Accept Edits',
    description: 'File edits are auto-approved. Shell commands still require confirmation unless explicitly remembered.',
  },
  {
    id: 'auto-in-project',
    name: 'Auto In Project',
    description: 'Project-scoped changes are auto-approved. Protected paths and risky out-of-project operations still require confirmation.',
  },
];

export interface KodaXAcpServerOptions {
  /** Provider name forwarded to the coding runtime. */
  provider?: string;
  /** Optional model override forwarded to the coding runtime. */
  model?: string;
  /** Optional default reasoning effort forwarded to the coding runtime. */
  effort?: KodaXWireReasoningEffort;
  /** Optional plan-mode default; ignored when `effort` is provided directly. */
  planModeEffort?: KodaXWireReasoningEffort;
  thinking?: boolean;
  reasoningMode?: KodaXReasoningMode;
  /**
   * Default session working directory. When explicitly set on the server, it
   * becomes the fixed execution cwd for all ACP sessions and overrides any
   * client-provided session cwd.
   */
  cwd?: string;
  permissionMode?: AcpPermissionMode;
  logLevel?: AcpLogLevel;
  /** Additional sinks that receive structured ACP runtime events. */
  eventSinks?: AcpEventSink[];
  agentName?: string;
  agentVersion?: string;
  /** Base home used by the owned Runtime. Primarily useful for isolated hosts and tests. */
  homeDir?: string;
  storage?: FileSessionStorage;
  runtime?: KodaXRuntime;
}

type AcpPromptExtensionRuntime = KodaXExtensionRuntime | CombinedExtensionRuntime;

interface KodaXAcpSessionState {
  sessionId: string;
  cwd: string;
  permissionMode: AcpPermissionMode;
  mcpServers: McpServer[];
  alwaysAllowTools: string[];
  activeRunIds: Set<string>;
  /** Created lazily on the first valid prompt so handshake-only sessions stay in memory. */
  runtimeSessionReady?: Promise<void>;
  contextTokenSnapshot?: KodaXContextTokenSnapshot;
  /** Runtime view used for prompts when client provides per-session MCP servers. */
  extensionRuntime?: AcpPromptExtensionRuntime;
  /** Per-session MCP runtime owned by this session and disposed with it. */
  ownedExtensionRuntime?: KodaXExtensionRuntime;
}

type AcpPromptRequestWithEffort = PromptRequest & {
  effort?: unknown;
};

type AcpPromptEffortOverride =
  | { readonly kind: 'absent' }
  | { readonly kind: 'value'; readonly value?: KodaXWireReasoningEffort };

function normalizeOptionalEffort(
  value: unknown,
  label: string,
): KodaXWireReasoningEffort | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string.`);
  }
  const normalized = normalizeReasoningEffortValue(value);
  return normalized === 'auto' ? undefined : normalized;
}

function buildAcpSessionTitle(prompt: string): string {
  const singleLine = prompt.replace(/\s+/g, ' ').trim();
  return singleLine.length <= 80 ? singleLine : `${singleLine.slice(0, 77)}...`;
}

function resolvePromptEffortOverride(params: PromptRequest): AcpPromptEffortOverride {
  const rawEffort = (params as AcpPromptRequestWithEffort).effort;
  if (rawEffort === undefined) {
    return { kind: 'absent' };
  }
  try {
    return {
      kind: 'value',
      value: normalizeOptionalEffort(rawEffort, 'Prompt effort'),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw RequestError.invalidParams({ effort: rawEffort }, message);
  }
}

/** Convert ACP McpServer[] to KodaX flat server config. */
function convertAcpMcpServers(
  servers: McpServer[],
): import('@kodax-ai/coding').KodaXMcpServersConfig {
  const result: import('@kodax-ai/coding').KodaXMcpServersConfig = {};
  for (const server of servers) {
    if ('command' in server) {
      // Stdio
      const envMap: Record<string, string> = {};
      for (const entry of server.env ?? []) {
        envMap[entry.name] = entry.value;
      }
      result[server.name] = {
        type: 'stdio',
        command: server.command,
        args: server.args ?? [],
        env: Object.keys(envMap).length > 0 ? envMap : undefined,
      };
    } else if ('type' in server && server.type === 'sse') {
      const headerMap: Record<string, string> = {};
      for (const h of (server as { headers?: Array<{ name: string; value: string }> }).headers ?? []) {
        headerMap[h.name] = h.value;
      }
      result[server.name] = {
        type: 'sse',
        url: server.url,
        headers: Object.keys(headerMap).length > 0 ? headerMap : undefined,
      };
    } else if ('type' in server && server.type === 'http') {
      const headerMap: Record<string, string> = {};
      for (const h of (server as { headers?: Array<{ name: string; value: string }> }).headers ?? []) {
        headerMap[h.name] = h.value;
      }
      result[server.name] = {
        type: 'http',
        url: server.url,
        headers: Object.keys(headerMap).length > 0 ? headerMap : undefined,
      };
    }
  }
  return result;
}

function dedupeExtensionPaths(paths: string[]): string[] {
  const result: string[] = [];
  for (const value of paths) {
    const normalized = value.trim();
    if (normalized && !result.includes(normalized)) {
      result.push(normalized);
    }
  }
  return result;
}

function normalizeConfiguredExtensionPaths(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return dedupeExtensionPaths(
    value
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .map((entry) => path.isAbsolute(entry) ? entry : path.resolve(path.dirname(KODAX_CONFIG_FILE), entry)),
  );
}

async function discoverAcpDefaultExtensions(logger: Pick<AcpLogger, 'error'>): Promise<string[]> {
  try {
    return await discoverDefaultExtensions();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('ACP extension discovery failed: ' + message);
    return [];
  }
}

async function loadAcpExtensionGroups(
  runtime: KodaXExtensionRuntime,
  discoveredExtensions: string[],
  configuredExtensions: string[],
): Promise<void> {
  const configured = await dedupeExtensionPathsByEntrypoint(configuredExtensions);
  const discoveredOnly = await excludeExtensionPathsByEntrypoint(
    await dedupeExtensionPathsByEntrypoint(discoveredExtensions),
    configured,
  );
  await runtime.loadExtensions(discoveredOnly, { continueOnError: true, loadSource: 'discovery' });
  await runtime.loadExtensions(configured, { continueOnError: true, loadSource: 'config' });
}

interface ToolPermissionDecision {
  allowed: boolean;
  override?: string;
}

function normalizeAcpPermissionMode(
  mode: string | undefined,
  fallback: AcpPermissionMode = 'accept-edits',
): AcpPermissionMode {
  if (mode && ACP_PERMISSION_MODE_IDS.includes(mode as AcpPermissionMode)) {
    return mode as AcpPermissionMode;
  }

  return fallback;
}

function parseSessionMode(mode: string | undefined): AcpPermissionMode {
  if (mode && ACP_PERMISSION_MODE_IDS.includes(mode as AcpPermissionMode)) {
    return mode as AcpPermissionMode;
  }

  throw RequestError.invalidParams(
    { modeId: mode },
    'Invalid session mode. Expected one of: plan, accept-edits, auto-in-project.',
  );
}

function buildModeState(currentModeId: AcpPermissionMode): SessionModeState {
  return {
    availableModes: ACP_PERMISSION_MODE_DEFINITIONS,
    currentModeId,
  };
}

function inferToolKind(toolName: string): ToolKind {
  return ACP_TOOL_KIND_MAP[toolName] ?? 'other';
}

function inferToolLocations(toolName: string, input: Record<string, unknown>): Array<{ path: string }> | undefined {
  if (acpIsFileModificationTool(toolName)) {
    const targetPath = typeof input.path === 'string' ? input.path : undefined;
    return targetPath ? [{ path: targetPath }] : undefined;
  }

  if (toolName === 'bash') {
    const command = typeof input.command === 'string' ? input.command : '';
    const targets = collectBashWriteTargets(command);
    if (targets.length > 0) {
      return targets.map((targetPath: string) => ({ path: targetPath }));
    }
  }

  return undefined;
}

function extractPromptText(blocks: ContentBlock[]): string {
  const parts: string[] = [];

  for (const block of blocks) {
    const anyBlock = block as Record<string, unknown>;
    const type = typeof anyBlock.type === 'string' ? anyBlock.type : '';

    if (type === 'text' && typeof anyBlock.text === 'string') {
      parts.push(anyBlock.text);
      continue;
    }

    if (type === 'resource_link' && typeof anyBlock.uri === 'string') {
      parts.push(`[Resource] ${anyBlock.uri}`);
      continue;
    }

    if (type === 'resource' && anyBlock.resource && typeof anyBlock.resource === 'object') {
      const resource = anyBlock.resource as Record<string, unknown>;
      if (typeof resource.text === 'string') {
        parts.push(resource.text);
        continue;
      }
      if (typeof resource.uri === 'string') {
        parts.push(`[Resource] ${resource.uri}`);
      }
    }
  }

  return parts.join('\n\n').trim();
}

function isToolResultFailure(content: string): boolean {
  return /^\[(?:Tool Error|Cancelled|Blocked|Error)\]/.test(content);
}

function isAbortLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.name === 'AbortError' ||
    error.message.includes('aborted') ||
    error.message.includes('ABORTED')
  );
}

function acpAbortPhaseRank(phase: RuntimeRunPhase): number {
  if (phase === 'queued') return 0;
  if (phase === 'running' || phase === 'waiting_permission' || phase === 'waiting_user_input') return 1;
  return 2;
}

function toAcpUsage(snapshot: KodaXContextTokenSnapshot | undefined): PromptResponse['usage'] | undefined {
  const usage = snapshot?.usage;
  if (!usage) {
    return undefined;
  }

  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    ...(usage.cachedReadTokens !== undefined ? { cachedReadTokens: usage.cachedReadTokens } : {}),
    ...(usage.cachedWriteTokens !== undefined ? { cachedWriteTokens: usage.cachedWriteTokens } : {}),
    ...(usage.thoughtTokens !== undefined ? { thoughtTokens: usage.thoughtTokens } : {}),
  };
}

export class KodaXAcpServer implements Agent {
  private readonly provider: string;
  private readonly model?: string;
  private readonly effort?: KodaXWireReasoningEffort;
  private readonly planModeEffort?: KodaXWireReasoningEffort;
  private readonly thinking: boolean;
  private readonly reasoningMode: KodaXReasoningMode;
  private readonly defaultPermissionMode: AcpPermissionMode;
  private readonly defaultCwd: string;
  private readonly hasFixedCwd: boolean;
  private readonly agentName: string;
  private readonly agentVersion: string;
  private readonly storage: FileSessionStorage;
  private readonly runtimeReady: Promise<KodaXRuntime>;
  private readonly ownsRuntime: boolean;
  private readonly logger: AcpLogger;
  private readonly events: AcpEventEmitter;
  /**
   * FEATURE_153 (v0.7.38) — LLM-backed bash prefix extractor used by
   * `isToolCallAllowed` to match allowlist patterns against the extracted
   * safe prefix instead of naive `command.startsWith`. Server-scoped (one
   * per `KodaXAcpServer` instance) so the LRU cache is shared across all
   * sessions, mirroring the REPL's session-scoped pattern.
   */
  private readonly bashPrefixExtractor: BashPrefixExtractor;
  private readonly configuredExtensions: string[];
  private readonly discoveredExtensions: Promise<string[]>;

  private connection: AgentSideConnection | null = null;
  private readonly sessions = new Map<string, KodaXAcpSessionState>();
  private extensionRuntime?: KodaXExtensionRuntime;
  private extensionRuntimeReady?: Promise<void>;
  private disposePromise?: Promise<void>;

  constructor(options: KodaXAcpServerOptions = {}) {
    const environmentProvider = process.env.KODAX_PROVIDER;
    const environmentEffort = process.env.KODAX_EFFORT;
    const config = prepareRuntimeConfig();
    const configWithExtensions = config as typeof config & { extensions?: unknown };
    this.provider = resolveRuntimeProviderSelection({
      explicitProvider: options.provider,
      environmentProvider,
      configuredProvider: config.provider,
      defaultProvider: KODAX_DEFAULT_PROVIDER,
    });
    this.model = resolveRuntimeModelSelection({
      explicitProvider: options.provider,
      environmentProvider,
      explicitModel: options.model,
      configuredProvider: config.provider,
      configuredModel: config.model,
    });
    const hasExplicitEffort = options.effort !== undefined
      || parseReasoningEffortEnv(environmentEffort).kind === 'value';
    this.effort = normalizeOptionalEffort(resolveRuntimeEffortSelection({
      explicitEffort: options.effort,
      environmentEffort,
      configuredEffort: config.effort,
    }), 'Configured effort');
    this.planModeEffort = hasExplicitEffort
      ? undefined
      : normalizeOptionalEffort(
          options.planModeEffort ?? config.planModeEffort,
          'Configured plan-mode effort',
        );
    this.thinking = options.thinking ?? config.thinking ?? false;
    this.reasoningMode = options.reasoningMode ?? config.reasoningMode ?? 'auto';
    this.defaultPermissionMode = normalizeAcpPermissionMode(
      options.permissionMode ?? config.permissionMode,
      'accept-edits',
    );
    const defaultCwd = path.resolve(options.cwd ?? process.cwd());
    const configuredExtensions = normalizeConfiguredExtensionPaths(configWithExtensions.extensions);
    const logger = new AcpLogger({
      level: resolveAcpLogLevel(options.logLevel ?? process.env.KODAX_ACP_LOG, 'info'),
    });
    const discoveredExtensionsPromise = discoverAcpDefaultExtensions(logger);

    this.defaultCwd = defaultCwd;
    this.hasFixedCwd = options.cwd !== undefined;
    this.agentName = options.agentName ?? 'kodax-acp-server';
    this.agentVersion = options.agentVersion ?? '0.0.0';
    this.storage = options.storage ?? new FileSessionStorage();
    this.logger = logger;
    this.ownsRuntime = options.runtime === undefined;
    this.runtimeReady = options.runtime
      ? Promise.resolve(options.runtime)
      : createKodaXRuntime({
          homeDir: options.homeDir ?? os.homedir(),
          sessionsDir: this.storage.getSessionsDir(),
          profile: 'acp',
          defaultProvider: this.provider,
          ...(this.model !== undefined ? { defaultModel: this.model } : {}),
        });
    this.configuredExtensions = configuredExtensions;
    this.discoveredExtensions = discoveredExtensionsPromise;
    this.events = new AcpEventEmitter({
      sinks: [
        ...(options.eventSinks ?? []),
        logger,
      ],
    });

    // FEATURE_153 (v0.7.38): build the bash prefix extractor once at server
    // construction. ACP sessions share the cache across the server lifetime
    // (one server per process; the LRU cap of 200 keeps memory bounded).
    this.bashPrefixExtractor = createBashPrefixExtractor({
      getProvider: () => resolveProvider(this.provider),
      getModel: () => this.model ?? '',
    });

    // Initialize extension runtime (non-blocking). Default/config extensions
    // share the same runtime as configured MCP so tool/capability surfaces stay
    // consistent across CLI, ACP, and desktop-style hosts.
    const mcpServers = config.mcpServers;
    const hasMcp = mcpServers && Object.values(mcpServers).some(
      (s) => (s.connect ?? 'lazy') !== 'disabled',
    );
    this.extensionRuntimeReady = (async () => {
      const discoveredExtensions = await discoveredExtensionsPromise;
      const hasExtensions = discoveredExtensions.length > 0 || configuredExtensions.length > 0;
      if (!hasMcp && !hasExtensions) {
        return;
      }

      const rt = createExtensionRuntime({ config });
      if (hasMcp) {
        await registerConfiguredMcpCapabilityProvider(rt, mcpServers, {
          reverse: buildMcpReverseCapabilities({ cwd: defaultCwd }),
        });
      }
      await loadAcpExtensionGroups(rt, discoveredExtensions, configuredExtensions);
      rt.activate();
      this.extensionRuntime = rt;
    })().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('ACP extension initialization failed: ' + message);
    });
  }

  attach(
    input: ReadableStream<Uint8Array>,
    output: WritableStream<Uint8Array>,
  ): AgentSideConnection {
    const stream = ndJsonStream(output, input);
    const connection = new AgentSideConnection(() => this, stream);
    this.connection = connection;
    const attachedThinking = this.effort === 'none' ? false : this.thinking;
    const attachedReasoningMode = this.effort === 'none' ? 'off' : this.reasoningMode;
    this.events.emit({
      type: 'server_attached',
      agent: this.agentName,
      version: this.agentVersion,
      provider: this.provider,
      model: this.model ?? '(default)',
      cwd: this.defaultCwd,
      permissionMode: this.defaultPermissionMode,
      reasoningMode: attachedReasoningMode,
      thinking: attachedThinking,
      fixedCwd: this.hasFixedCwd,
    });
    connection.signal.addEventListener('abort', () => {
      const activeSessions = this.sessions.size;
      this.events.emit({
        type: 'connection_closed',
        activeSessions,
      });
      void this.dispose();
    });
    return connection;
  }

  async waitForClose(): Promise<void> {
    await this.connection?.closed;
  }

  async dispose(): Promise<void> {
    if (this.disposePromise) {
      return this.disposePromise;
    }

    this.disposePromise = (async () => {
      for (const session of this.sessions.values()) {
        await this.abortSessionRuns(session);
      }

      const runtimes = new Set<KodaXExtensionRuntime>();
      for (const session of this.sessions.values()) {
        if (session.ownedExtensionRuntime) {
          runtimes.add(session.ownedExtensionRuntime);
          session.ownedExtensionRuntime = undefined;
        }
        session.extensionRuntime = undefined;
      }
      this.sessions.clear();
      this.connection = null;

      const ready = this.extensionRuntimeReady;
      this.extensionRuntimeReady = undefined;
      await ready?.catch(() => undefined);

      if (this.extensionRuntime) {
        runtimes.add(this.extensionRuntime);
        this.extensionRuntime = undefined;
      }

      await Promise.all([...runtimes].map((runtime) => runtime.dispose()));
      if (this.ownsRuntime) {
        await (await this.runtimeReady).close().catch(() => undefined);
      }
      await shutdownDefaultLspService();
    })();

    return this.disposePromise;
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    this.events.emit({
      type: 'initialize_completed',
      protocolVersion: PROTOCOL_VERSION,
    });
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: {
        name: this.agentName,
        version: this.agentVersion,
      },
      agentCapabilities: {
        promptCapabilities: {
          embeddedContext: true,
          image: false,
          audio: false,
        },
        sessionCapabilities: {},
      },
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const requestedCwd = this.hasFixedCwd
      ? this.defaultCwd
      : (params.cwd ?? this.defaultCwd);
    if (!path.isAbsolute(requestedCwd)) {
      throw RequestError.invalidParams({ cwd: requestedCwd }, 'Session cwd must be an absolute path.');
    }

    const sessionId = randomUUID();
    const clientMcpServers = params.mcpServers ?? [];
    const session: KodaXAcpSessionState = {
      sessionId,
      cwd: path.resolve(requestedCwd),
      permissionMode: this.defaultPermissionMode,
      mcpServers: clientMcpServers,
      alwaysAllowTools: [],
      activeRunIds: new Set(),
    };

    // If the client provides per-session MCP servers, keep that MCP runtime
    // session-owned and compose it with the already-activated global runtime.
    // Global extensions are not loaded again, so sidecar-style extensions stay
    // single-instance in the ACP process.
    if (clientMcpServers.length > 0) {
      const converted = convertAcpMcpServers(clientMcpServers);
      const rt = createExtensionRuntime({});
      await registerConfiguredMcpCapabilityProvider(rt, converted, {
        reverse: buildMcpReverseCapabilities({ cwd: session.cwd }),
      }).catch((error) => {
        const msg = error instanceof Error ? error.message : String(error);
        this.logger.error('ACP per-session MCP init failed for ' + sessionId + ': ' + msg);
      });
      await this.extensionRuntimeReady;
      session.ownedExtensionRuntime = rt;
      session.extensionRuntime = this.extensionRuntime
        ? combineExtensionRuntimes(rt, this.extensionRuntime)
        : rt;
    }

    this.sessions.set(sessionId, session);
    this.events.emit({
      type: 'session_created',
      sessionId,
      cwd: session.cwd,
      permissionMode: session.permissionMode,
      mcpServers: session.mcpServers.length,
    });

    return {
      sessionId,
      modes: buildModeState(session.permissionMode),
    };
  }

  async authenticate(): Promise<void> {
    return undefined;
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const session = this.requireSession(params.sessionId);
    const previousMode = session.permissionMode;
    const nextMode = parseSessionMode(params.modeId);
    session.permissionMode = nextMode;
    this.events.emit({
      type: 'session_mode_changed',
      sessionId: session.sessionId,
      from: previousMode,
      to: nextMode,
    });
    await this.sendSessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: 'current_mode_update',
        currentModeId: nextMode,
      },
    });
    return {};
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.requireSession(params.sessionId);
    const promptText = extractPromptText(params.prompt);
    const promptEffortOverride = resolvePromptEffortOverride(params);
    if (!promptText) {
      throw RequestError.invalidParams(
        { prompt: params.prompt },
        'Prompt must include at least one text or resource block with content.',
      );
    }
    const promptQueuedAt = Date.now();

    const task = async (): Promise<PromptResponse> => {
      const promptStartedAt = Date.now();
      this.events.emit({
        type: 'prompt_started',
        sessionId: session.sessionId,
        messageId: params.messageId ?? null,
        chars: promptText.length,
        cwd: session.cwd,
        queueDelayMs: promptStartedAt - promptQueuedAt,
      });
      this.events.emit({
        type: 'prompt_preview',
        sessionId: session.sessionId,
        prompt: promptText,
      });

      let handle: RuntimeRunHandle | undefined;
      try {
        // Ensure MCP is initialized before the first prompt.
        if (this.extensionRuntimeReady) {
          await this.extensionRuntimeReady;
        }
        const runtime = await this.runtimeReady;
        await this.ensureRuntimeSession(runtime, session, promptText);
        handle = await runtime.runs.start({
          sessionId: session.sessionId,
          prompt: promptText,
          options: this.buildKodaXOptions(session, promptEffortOverride),
        });
        session.activeRunIds.add(handle.runId);
        const runtimeResult = await handle.result;
        if (runtimeResult.error) {
          throw runtimeResult.error;
        }
        const cancelled = runtimeResult.phase === 'cancelled' || runtimeResult.phase === 'interrupted';
        const result = runtimeResult.result;
        if (!result) {
          if (cancelled) {
            this.events.emit({
              type: 'prompt_cancelled',
              sessionId: session.sessionId,
              durationMs: Date.now() - promptStartedAt,
            });
            return {
              stopReason: 'cancelled',
              userMessageId: params.messageId ?? undefined,
            };
          }
          throw new Error(`Runtime run ${handle.runId} ended without a coding result.`);
        }
        session.contextTokenSnapshot = result.contextTokenSnapshot;
        const interrupted = !!result.interrupted || cancelled;
        const stopReason = interrupted ? 'cancelled' : 'end_turn';
        this.events.emit({
          type: 'prompt_finished',
          sessionId: session.sessionId,
          stopReason,
          interrupted,
          durationMs: Date.now() - promptStartedAt,
        });

        return {
          stopReason,
          userMessageId: params.messageId ?? undefined,
          ...(toAcpUsage(result.contextTokenSnapshot) ? { usage: toAcpUsage(result.contextTokenSnapshot) } : {}),
        };
      } catch (error) {
        if (isAbortLikeError(error)) {
          this.events.emit({
            type: 'prompt_cancelled',
            sessionId: session.sessionId,
            durationMs: Date.now() - promptStartedAt,
          });
          return {
            stopReason: 'cancelled',
            userMessageId: params.messageId ?? undefined,
          };
        }

        const message = error instanceof Error ? error.message : String(error);
        this.events.emit({
          type: 'prompt_failed',
          sessionId: session.sessionId,
          durationMs: Date.now() - promptStartedAt,
          error: message,
        });
        await this.sendTextChunk(session.sessionId, `\n[ACP Server Error] ${message}\n`);
        return {
          stopReason: 'end_turn',
          userMessageId: params.messageId ?? undefined,
        };
      } finally {
        if (handle) {
          session.activeRunIds.delete(handle.runId);
        }
      }
    };

    return task();
  }

  private async ensureRuntimeSession(
    runtime: KodaXRuntime,
    session: KodaXAcpSessionState,
    prompt: string,
  ): Promise<void> {
    if (!session.runtimeSessionReady) {
      session.runtimeSessionReady = runtime.sessions.create({
        sessionId: session.sessionId,
        title: buildAcpSessionTitle(prompt),
        projectPath: session.cwd,
        gitRoot: session.cwd,
        surface: 'acp',
      }).then(() => undefined);
    }
    try {
      await session.runtimeSessionReady;
    } catch (error) {
      session.runtimeSessionReady = undefined;
      throw error;
    }
  }

  async cancel(params: { sessionId: string }): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    this.events.emit({
      type: 'cancel_requested',
      sessionId: params.sessionId,
      active: (session?.activeRunIds.size ?? 0) > 0,
    });
    if (session) {
      await this.abortSessionRuns(session);
    }
  }

  private async abortSessionRuns(session: KodaXAcpSessionState): Promise<void> {
    if (session.activeRunIds.size === 0) return;

    const runtime = await this.runtimeReady;
    const runIds = [...session.activeRunIds];
    const abortTargets = await Promise.all(
      runIds.map(async (runId) => {
        try {
          const status = await runtime.runs.get(runId);
          return { runId, rank: acpAbortPhaseRank(status.phase) };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error(`ACP runtime run status lookup failed for ${runId}: ${message}`);
          return { runId, rank: acpAbortPhaseRank('cancelled') };
        }
      }),
    );

    abortTargets.sort((left, right) => left.rank - right.rank);
    await Promise.all(
      abortTargets.map(({ runId }) => runtime.runs.abort(runId).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`ACP runtime run abort failed for ${runId}: ${message}`);
      })),
    );
  }

  private requireSession(sessionId: string): KodaXAcpSessionState {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw RequestError.resourceNotFound(sessionId);
    }
    return session;
  }

  private buildKodaXOptions(
    session: KodaXAcpSessionState,
    effortOverride: AcpPromptEffortOverride = { kind: 'absent' },
  ): KodaXOptions {
    const effort = effortOverride.kind === 'value'
      ? effortOverride.value
      : session.permissionMode === 'plan' && this.planModeEffort !== undefined
        ? this.planModeEffort
        : this.effort;
    return {
      provider: this.provider,
      model: this.model,
      effort,
      thinking: effort === 'none' ? false : this.thinking,
      reasoningMode: effort === 'none' ? 'off' : this.reasoningMode,
      // Per-session runtime (from client MCP servers) takes precedence over global.
      extensionRuntime: session.extensionRuntime ?? this.extensionRuntime,
      session: {
        id: session.sessionId,
        storage: this.storage,
      },
      context: {
        gitRoot: session.cwd,
        executionCwd: session.cwd,
        contextTokenSnapshot: session.contextTokenSnapshot,
      },
      events: {
        onTextDelta: (text) => {
          this.dispatchNotification(
            'assistant text chunk',
            session.sessionId,
            this.sendTextChunk(session.sessionId, text),
          );
        },
        onThinkingDelta: (text) => {
          this.dispatchNotification(
            'thinking chunk',
            session.sessionId,
            this.sendSessionUpdate({
              sessionId: session.sessionId,
              update: {
                sessionUpdate: 'agent_thought_chunk',
                content: { type: 'text', text },
              },
            }),
          );
        },
        onToolUseStart: (tool) => {
          this.dispatchNotification(
            'tool call start',
            session.sessionId,
            this.sendSessionUpdate({
              sessionId: session.sessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: tool.id,
                title: tool.name,
                kind: inferToolKind(tool.name),
                rawInput: tool.input,
                locations: inferToolLocations(tool.name, tool.input ?? {}),
                status: 'pending',
              },
            }),
          );
        },
        onToolResult: (result) => {
          this.dispatchNotification(
            'tool call update',
            session.sessionId,
            this.sendSessionUpdate({
              sessionId: session.sessionId,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: result.id,
                title: result.name,
                status: isToolResultFailure(result.content) ? 'failed' : 'completed',
                rawOutput: result.content,
              },
            }),
          );
        },
        onRepoIntelligenceTrace: (event) => {
          this.events.emit({
            type: 'repo_intelligence_trace',
            sessionId: session.sessionId,
            stage: event.stage,
            summary: event.summary,
            mode: event.capability?.mode,
            engine: event.capability?.engine,
            status: event.capability?.status,
            cacheHit: event.trace?.cacheHit,
            capsuleEstimatedTokens: event.trace?.capsuleEstimatedTokens,
          });
        },
        onError: (error) => {
          this.dispatchNotification(
            'error text chunk',
            session.sessionId,
            this.sendTextChunk(session.sessionId, `\n[Error] ${error.message}\n`),
          );
        },
        beforeToolExecute: async (toolName, input, meta) => {
          const decision = await this.evaluateToolPermission(session, toolName, input, meta?.toolId);
          if (!decision.allowed) {
            return decision.override ?? false;
          }
          return true;
        },
      },
    };
  }

  private async evaluateToolPermission(
    session: KodaXAcpSessionState,
    toolName: string,
    input: Record<string, unknown>,
    toolId?: string,
  ): Promise<ToolPermissionDecision> {
    this.events.emit({
      type: 'tool_permission_evaluated',
      sessionId: session.sessionId,
      tool: toolName,
      toolId: toolId ?? null,
      permissionMode: session.permissionMode,
    });
    if (toolName === 'bash') {
      const command = typeof input.command === 'string' ? input.command : '';
      if (isBashReadCommand(command)) {
        this.events.emit({
          type: 'tool_permission_resolved',
          sessionId: session.sessionId,
          tool: toolName,
          toolId: toolId ?? null,
          outcome: 'auto_allowed_read_only_bash',
        });
        return { allowed: true };
      }

      // FEATURE_153 (v0.7.38): pass extractor so allowlist patterns match
      // against the LLM-extracted safe prefix, closing the injection surface
      // (`git commit -m "x" $(curl evil)` no longer matches `git commit:*`).
      if (
        await isToolCallAllowed(
          toolName,
          input,
          session.alwaysAllowTools,
          this.bashPrefixExtractor,
        )
      ) {
        this.events.emit({
          type: 'tool_permission_resolved',
          sessionId: session.sessionId,
          tool: toolName,
          toolId: toolId ?? null,
          outcome: 'auto_allowed_remembered',
        });
        return { allowed: true };
      }
    }

    if (session.permissionMode === 'plan') {
      const blockReason = getPlanModeBlockReason(toolName, input, session.cwd);
      if (blockReason) {
        this.events.emit({
          type: 'tool_permission_resolved',
          sessionId: session.sessionId,
          tool: toolName,
          toolId: toolId ?? null,
          outcome: 'blocked_plan_mode',
        });
        return {
          allowed: false,
          override: `${blockReason} Do not try to modify files while planning. Finish the plan first, then hand off to a writable mode.`,
        };
      }
      this.events.emit({
        type: 'tool_permission_resolved',
        sessionId: session.sessionId,
        tool: toolName,
        toolId: toolId ?? null,
        outcome: 'auto_allowed_plan_mode',
      });
      return { allowed: true };
    }

    const needsProtectedPathConfirmation =
      acpIsFileModificationTool(toolName) &&
      typeof input.path === 'string' &&
      isAlwaysConfirmPath(path.resolve(session.cwd, input.path), session.cwd);

    const needsModeConfirmation = computeConfirmTools(session.permissionMode).has(toolName);
    const needsAutoOutsideProjectConfirmation =
      session.permissionMode === 'auto-in-project' &&
      (
        (acpIsFileModificationTool(toolName) &&
          typeof input.path === 'string' &&
          !isPathInsideProject(input.path, session.cwd)) ||
        (toolName === 'bash' &&
          typeof input.command === 'string' &&
          getBashOutsideProjectWriteRisk(input.command, session.cwd).dangerous)
      );

    if (
      !needsProtectedPathConfirmation &&
      !needsModeConfirmation &&
      !needsAutoOutsideProjectConfirmation
    ) {
      this.events.emit({
        type: 'tool_permission_resolved',
        sessionId: session.sessionId,
        tool: toolName,
        toolId: toolId ?? null,
        outcome: 'auto_allowed_policy',
      });
      return { allowed: true };
    }

    const permissionResult = await this.requestPermissionFromClient(session, toolName, input, toolId);
    return permissionResult;
  }

  private async requestPermissionFromClient(
    session: KodaXAcpSessionState,
    toolName: string,
    input: Record<string, unknown>,
    toolId?: string,
  ): Promise<ToolPermissionDecision> {
    if (!this.connection) {
      this.events.emit({
        type: 'tool_permission_resolved',
        sessionId: session.sessionId,
        tool: toolName,
        toolId: toolId ?? null,
        outcome: 'request_failed_disconnected',
      });
      return {
        allowed: false,
        override: '[Cancelled] ACP client is disconnected, so the permission request could not be completed.',
      };
    }

    const permissionOptions: PermissionOption[] = [
      {
        optionId: 'allow_once',
        kind: 'allow_once',
        name: 'Allow once',
      },
      {
        optionId: 'allow_always',
        kind: 'allow_always',
        name: 'Always allow',
      },
      {
        optionId: 'reject_once',
        kind: 'reject_once',
        name: 'Reject',
      },
    ];

    const toolCall: ToolCallUpdate = {
      toolCallId: toolId ?? randomUUID(),
      title: toolName,
      kind: inferToolKind(toolName),
      rawInput: input,
      locations: inferToolLocations(toolName, input),
      status: 'pending',
    };

    let response: RequestPermissionResponse;
    this.events.emit({
      type: 'permission_requested',
      sessionId: session.sessionId,
      tool: toolName,
      toolId: toolCall.toolCallId,
    });
    try {
      response = await this.connection.requestPermission({
        sessionId: session.sessionId,
        toolCall,
        options: permissionOptions,
      });
    } catch (error) {
      this.events.emit({
        type: 'tool_permission_resolved',
        sessionId: session.sessionId,
        tool: toolName,
        toolId: toolCall.toolCallId,
        outcome: 'request_failed_incomplete',
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        allowed: false,
        override: '[Cancelled] ACP client did not complete the permission request. Operation failed closed.',
      };
    }

    if (response.outcome.outcome !== 'selected') {
      this.events.emit({
        type: 'tool_permission_resolved',
        sessionId: session.sessionId,
        tool: toolName,
        toolId: toolCall.toolCallId,
        outcome: 'request_dismissed',
      });
      return {
        allowed: false,
        override: '[Cancelled] Operation cancelled by user',
      };
    }

    if (response.outcome.optionId === 'allow_always') {
      if (toolName === 'bash') {
        session.alwaysAllowTools = Array.from(
          new Set([
            ...session.alwaysAllowTools,
            generateSavePattern(toolName, input, false),
          ]),
        ).filter(Boolean);
      }
    }

    if (response.outcome.optionId === 'reject_once') {
      this.events.emit({
        type: 'tool_permission_resolved',
        sessionId: session.sessionId,
        tool: toolName,
        toolId: toolCall.toolCallId,
        outcome: 'request_rejected',
      });
      return {
        allowed: false,
        override: '[Cancelled] Operation cancelled by user',
      };
    }

    this.events.emit({
      type: 'tool_permission_resolved',
      sessionId: session.sessionId,
      tool: toolName,
      toolId: toolCall.toolCallId,
      outcome: 'request_granted',
      remember: response.outcome.optionId === 'allow_always',
    });
    return { allowed: true };
  }

  private async sendTextChunk(sessionId: string, text: string): Promise<void> {
    await this.sendSessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
      },
    });
  }

  private async sendSessionUpdate(notification: SessionNotification): Promise<void> {
    if (!this.connection || this.connection.signal.aborted) {
      return;
    }
    await this.connection.sessionUpdate(notification);
  }

  private dispatchNotification(label: string, sessionId: string, operation: Promise<void>): void {
    void operation.catch((error) => {
      if (!this.connection || this.connection.signal.aborted) {
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      this.events.emit({
        type: 'notification_failed',
        sessionId,
        label,
        error: message,
      });
    });
  }
}

export async function runAcpServer(options: KodaXAcpServerOptions = {}): Promise<void> {
  const server = new KodaXAcpServer(options);
  const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
  const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
  server.attach(input, output);
  try {
    await server.waitForClose();
  } finally {
    await server.dispose();
  }
}
