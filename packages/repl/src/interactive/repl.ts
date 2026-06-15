/**
 * KodaX Interactive REPL Mode - 交互式 REPL 模式
 */

import * as readline from 'readline';
import * as childProcess from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import chalk from 'chalk';

// Export Ink UI version entry point - 导出 Ink UI 版本的入口
export { runInkInteractiveMode } from '../ui/index.js';
export type { InkREPLOptions } from '../ui/index.js';
import {
  extractArtifactLedger,
  KodaXInputArtifact,
  KodaXOptions,
  type KodaXAgentMode,
  KodaXResult,
  KodaXReasoningMode,
  mergeArtifactLedger,
  runManagedTask,
  resolveRepoIntelligenceRuntimeConfig,
  KodaXError,
  KodaXRateLimitError,
  KodaXProviderError,
  KODAX_DEFAULT_PROVIDER,
  getCustomProvider,
  buildGoalRuntimeBinding,
  decideWorkflowInvocation,
} from '@kodax-ai/coding';
import {
  appendSessionLineageLabel,
  buildSessionTree,
  countActiveLineageMessages,
  createSessionLineage,
  estimateTokens,
  forkSessionLineage,
  generateSessionId as generateCoreSessionId,
  findPreviousUserEntryId,
  getMessageQueue,
  getSessionMessagesFromLineage,
  rewindSessionLineage,
  setSessionLineageActiveEntry,
} from '@kodax-ai/agent';
import type {
  KodaXMessage,
  KodaXSessionData,
  KodaXSessionStorage,
} from '@kodax-ai/agent';
import type { AgentsFile } from '@kodax-ai/coding';
import type { PermissionMode, ConfirmResult } from '../permission/types.js';
import {
  computeConfirmTools,
  createAutoInProjectDeprecationEmitter,
  FILE_MODIFICATION_TOOLS,
  isAutoMode,
  normalizePermissionMode,
} from '../permission/types.js';
import { bootstrapAutoMode, type AutoModeBootstrapResult } from './auto-mode-bootstrap.js';
import { createBashPrefixExtractor, type BashPrefixExtractor } from '@kodax-ai/coding';
import { bootstrapTeamMode, type TeamModeHandle } from '@kodax-ai/agent';
import { isToolCallAllowed, isAlwaysConfirmPath, isBashReadCommand, getPlanModeBlockReason } from '../permission/permission.js';
import { replBashPathSignalCollector } from '../permission/repl-bash-signals.js';
import { getGitRoot, prepareRuntimeConfig, getProviderModel, getProviderAvailableModels, KODAX_VERSION } from '../common/utils.js';
import {
  InteractiveContext,
  InteractiveMode,
  createInteractiveContext,
  generateSessionId as generateInteractiveSessionId,
  touchContext,
} from './context.js';
import {
  parseCommand,
  executeCommand,
  CommandCallbacks,
  CurrentConfig,
} from './commands.js';
import type { CommandWorkflowInvocationRequest } from '../commands/types.js';
import { loadCompactionConfig } from '../common/compaction-config.js';
import { loadAlwaysAllowTools, loadAutoModeSettings, saveAlwaysAllowToolPattern } from '../common/permission-config.js';
import {
  confirmToolExecution,
  getTerminalWidth,
} from './prompts.js';
import {
  StatusBar,
  createStatusBarState,
  supportsStatusBar,
  formatTokenCount,
} from './status-bar.js';
import {
  createCompleter,
  getCompletionSuggestions,
  type Completion,
} from './autocomplete.js';
import { getCurrentTheme, setTheme, type Theme } from './themes.js';
import { getSkillRegistry } from '@kodax-ai/agent';
import { ReadlineUIContext } from '../ui/readline-ui.js';
import { extractLastAssistantText, extractTitle as extractSessionTitle } from '../ui/utils/message-utils.js';
import { executeShellCommand, isShellCommandHandled } from '../ui/utils/shell-executor.js';
import { prepareInvocationExecution } from './invocation-runtime.js';
import {
  resolveConfirm,
  startGeneratedWorkflowFromRequest,
} from '../commands/workflow-command.js';
import {
  enforceSessionTransitionGuard,
} from './session-guardrails.js';
import { formatSessionTree } from './session-tree.js';
import {
  formatWorkspaceTruth,
  inspectWorkspaceRuntime,
  resolveSessionRuntimeInfo,
  workspaceExists,
} from './workspace-runtime.js';
import { preparePromptInputArtifacts } from '../common/input-artifacts.js';

// Extended session storage interface (adds list method) - 扩展的会话存储接口（增加 list 方法）
interface SessionStorage extends KodaXSessionStorage {
  list(gitRoot?: string): Promise<Array<{
    id: string;
    title: string;
    msgCount: number;
    tag?: string;
    runtimeInfo?: KodaXSessionData['runtimeInfo'];
  }>>;
}

// Simple in-memory session storage (replaceable with persistent storage) - 简单的内存会话存储（可替换为持久化存储）
class MemorySessionStorage implements SessionStorage {
  private sessions = new Map<string, { data: KodaXSessionData; createdAt: string }>();

  async save(id: string, data: KodaXSessionData): Promise<void> {
    const existing = this.sessions.get(id);
    const lineage = createSessionLineage(
      data.messages,
      data.lineage ?? existing?.data.lineage,
    );
    this.sessions.set(id, {
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      data: {
        ...structuredClone(data),
        scope: data.scope ?? existing?.data.scope ?? 'user',
        uiHistory: data.uiHistory ?? existing?.data.uiHistory,
        extensionState: data.extensionState ?? existing?.data.extensionState,
        extensionRecords: data.extensionRecords ?? existing?.data.extensionRecords,
        tag: data.tag ?? existing?.data.tag,
        lineage,
      },
    });
  }

  async load(id: string): Promise<KodaXSessionData | null> {
    return structuredClone(this.sessions.get(id)?.data ?? null);
  }

  async getLineage(id: string) {
    return structuredClone(this.sessions.get(id)?.data.lineage ?? null);
  }

  async setActiveEntry(
    id: string,
    selector: string,
    options?: { summarizeCurrentBranch?: boolean },
  ): Promise<KodaXSessionData | null> {
    const current = this.sessions.get(id);
    if (!current?.data.lineage) {
      return null;
    }

    const lineage = setSessionLineageActiveEntry(current.data.lineage, selector, options);
    if (!lineage) {
      return null;
    }

    const data: KodaXSessionData = {
      ...structuredClone(current.data),
      messages: getSessionMessagesFromLineage(lineage),
      lineage,
    };
    this.sessions.set(id, { ...current, data });
    return structuredClone(data);
  }

  async setLabel(id: string, selector: string, label?: string): Promise<KodaXSessionData | null> {
    const current = this.sessions.get(id);
    if (!current?.data.lineage) {
      return null;
    }

    const lineage = appendSessionLineageLabel(current.data.lineage, selector, label);
    if (!lineage) {
      return null;
    }

    const data: KodaXSessionData = {
      ...structuredClone(current.data),
      lineage,
    };
    this.sessions.set(id, { ...current, data });
    return structuredClone(data);
  }

  async fork(
    id: string,
    selector?: string,
    options?: { sessionId?: string; title?: string },
  ): Promise<{ sessionId: string; data: KodaXSessionData } | null> {
    const current = this.sessions.get(id);
    if (!current?.data.lineage) {
      return null;
    }

    const lineage = forkSessionLineage(current.data.lineage, selector);
    if (!lineage) {
      return null;
    }

    const sessionId = options?.sessionId ?? await generateCoreSessionId();
    const data: KodaXSessionData = {
      messages: getSessionMessagesFromLineage(lineage),
      title: options?.title ?? current.data.title,
      gitRoot: current.data.gitRoot,
      tag: current.data.tag,
      runtimeInfo: current.data.runtimeInfo
        ? structuredClone(current.data.runtimeInfo)
        : undefined,
      scope: current.data.scope ?? 'user',
      extensionState: current.data.extensionState
        ? structuredClone(current.data.extensionState)
        : undefined,
      extensionRecords: current.data.extensionRecords
        ? structuredClone(current.data.extensionRecords)
        : undefined,
      lineage,
    };
    this.sessions.set(sessionId, {
      createdAt: new Date().toISOString(),
      data,
    });
    return {
      sessionId,
      data: structuredClone(data),
    };
  }

  async rewind(id: string, selector?: string): Promise<KodaXSessionData | null> {
    const current = this.sessions.get(id);
    if (!current?.data.lineage) {
      return null;
    }

    const targetId = selector ?? findPreviousUserEntryId(current.data.lineage);
    if (!targetId) return null;

    const lineage = rewindSessionLineage(current.data.lineage, targetId);
    if (!lineage) {
      return null;
    }

    const data: KodaXSessionData = {
      ...current.data,
      messages: getSessionMessagesFromLineage(lineage),
      lineage,
    };
    this.sessions.set(id, { ...current, data });
    return structuredClone(data);
  }

  async list(_gitRoot?: string): Promise<Array<{
    id: string;
    title: string;
    msgCount: number;
    tag?: string;
    runtimeInfo?: KodaXSessionData['runtimeInfo'];
  }>> {
    return Array.from(this.sessions.entries())
      .filter(([, session]) => (session.data.scope ?? 'user') === 'user')
      .map(([id, session]) => ({
        id,
        title: session.data.title,
        msgCount: session.data.lineage
          ? countActiveLineageMessages(session.data.lineage)
          : session.data.messages.length,
        ...(session.data.tag !== undefined ? { tag: session.data.tag } : {}),
        ...(session.data.runtimeInfo
          ? {
            runtimeInfo: structuredClone(session.data.runtimeInfo),
          }
          : {}),
      }));
  }

  async delete(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  async deleteAll(_gitRoot?: string): Promise<void> {
    this.sessions.clear();
  }
}

export { MemorySessionStorage };

function applyRuntimeContext(
  context: InteractiveContext,
  currentOptions: RepLOptions,
  runtimeInfo: InteractiveContext['runtimeInfo'],
): void {
  context.runtimeInfo = runtimeInfo;
  context.gitRoot = runtimeInfo?.workspaceRoot ?? context.gitRoot;
  currentOptions.context = {
    ...currentOptions.context,
    gitRoot: context.gitRoot,
    executionCwd: runtimeInfo?.executionCwd ?? process.cwd(),
  };
}

// REPL options - REPL 选项
export interface RepLOptions extends KodaXOptions {
  storage?: SessionStorage;
}

function resolveInitialReasoningMode(
  options: Pick<KodaXOptions, 'reasoningMode' | 'thinking'>,
  config: { reasoningMode?: KodaXReasoningMode; thinking?: boolean },
): KodaXReasoningMode {
  if (options.reasoningMode) {
    return options.reasoningMode;
  }
  if (config.reasoningMode) {
    return config.reasoningMode;
  }
  if (options.thinking === true || config.thinking === true) {
    return 'auto';
  }
  return 'auto';
}

// Module-level cost report ref — agent populates via events.getCostReport, /cost reads it
const costReportRef: { current: (() => string) | null } = { current: null };

// Run interactive mode - 运行交互式模式
export async function runInteractiveMode(options: RepLOptions): Promise<void> {
  const startupRuntime = await inspectWorkspaceRuntime({ cwd: process.cwd() });
  const gitRoot = startupRuntime.workspaceRoot ?? await getGitRoot() ?? undefined;
  const storage = options.storage ?? new MemorySessionStorage();

  // FEATURE_125 v0.7.41 — Bootstrap Team Mode (multi-instance auto
  // coordination). Returns null when KODAX_DISABLE_MULTI_INSTANCE=1
  // is set; otherwise registers this session under
  // `<configHome>/instances/<pid>/`, reaps stale peer directories
  // from crashed sessions, and installs the writer in the
  // process-level singleton. Tools / runner-driven adapter consume
  // the singleton via `getActiveTeamModeWriter()`.
  const teamModeHandle: TeamModeHandle | null = bootstrapTeamMode({
    meta: {
      cwd: process.cwd(),
      startedAt: Date.now(),
    },
  });

  // Load config (priority: CLI args > config file > defaults) - 加载配置（优先级：CLI参数 > 配置文件 > 默认值）
  const config = prepareRuntimeConfig();

  // Initialize custom providers from config - 从配置初始化自定义 Provider
  const initialProvider = options.provider ?? config.provider ?? KODAX_DEFAULT_PROVIDER;
  const initialModel = options.model ?? config.model;
  const initialReasoningMode = resolveInitialReasoningMode(options, config);
  const initialAgentMode = options.agentMode ?? (config as { agentMode?: KodaXAgentMode }).agentMode ?? 'ama';
  const initialThinking = initialReasoningMode !== 'off';
  const initialPermissionMode: PermissionMode =
    normalizePermissionMode((config as { permissionMode?: string }).permissionMode, 'accept-edits') ?? 'accept-edits';
  // FEATURE_092 phase 2b.7b slice E: emit the auto-in-project alias
  // deprecation notice once per session — at startup if config picked the
  // alias, plus on `/mode auto-in-project`. Internal state is shared so
  // it fires AT MOST once even across both code paths.
  const emitAutoInProjectDeprecation = createAutoInProjectDeprecationEmitter();
  if (initialPermissionMode === 'auto-in-project') {
    emitAutoInProjectDeprecation();
  }
  const repoIntelligenceRuntime = resolveRepoIntelligenceRuntimeConfig();

  const configuredTheme = (config as { theme?: string }).theme;
  if (configuredTheme) {
    setTheme(configuredTheme);
  }
  const theme = getCurrentTheme();

  // Current config state - 当前配置状态
  let currentConfig: CurrentConfig = {
    provider: initialProvider,
    model: initialModel,
    thinking: initialThinking,
    reasoningMode: initialReasoningMode,
    agentMode: initialAgentMode,
    permissionMode: initialPermissionMode,
    repoIntelligenceMode: repoIntelligenceRuntime.mode,
    repointelEndpoint: repoIntelligenceRuntime.endpoint,
    repointelBin: repoIntelligenceRuntime.bin,
    repoIntelligenceTrace: repoIntelligenceRuntime.trace,
    fallbackProviders: config.fallbackProviders,
  };

  // Local permission state - 本地权限状态
  let currentPermissionMode: PermissionMode = initialPermissionMode;
  let alwaysAllowTools: string[] = loadAlwaysAllowTools();

  // Esc+Esc edit state - Esc+Esc 编辑状态
  let lastEscTime = 0;
  let lastUserMessage = '';
  let pendingEdit = false;  // Flag for editing last message in external editor - 标记是否需要在外部编辑器中编辑上一条消息
  const ESC_DOUBLE_PRESS_MS = 500;

  const context = await createInteractiveContext({
    sessionId: options.session?.id,
    gitRoot,
    runtimeInfo: startupRuntime,
  });

  // v0.7.43 (FEATURE_173 Part B follow-up) — publish the resolved
  // sessionId to the FEATURE_125 heartbeat so `listRunningSessions()`
  // can correlate a running instance with its `.jsonl` file.
  teamModeHandle?.writer.update({ sessionId: context.sessionId });

  const guardSessionTransition = (action: string): boolean => {
    return enforceSessionTransitionGuard(currentConfig, action, (status, headline, details) => {
      console.log((status === 'block' ? chalk.red : chalk.yellow)(`\n${headline}`));
      for (const detail of details) {
        console.log(chalk.dim(detail));
      }
      console.log();
    });
  };

  // Load compaction config for banner display
  const compactionConfig = await loadCompactionConfig(gitRoot ?? undefined);
  const { resolveProvider } = await import('@kodax-ai/coding');
  const providerInstance = resolveProvider(currentConfig.provider);
  const effectiveContextWindow = compactionConfig.contextWindow
    ?? providerInstance.getEffectiveContextWindow?.(currentConfig.model)
    ?? providerInstance.getContextWindow?.()
    ?? 200000;

  // Load AGENTS.md files
  const { loadAgentsFiles } = await import('@kodax-ai/coding');
  const reloadAgentsFiles = async (): Promise<AgentsFile[]> => {
    return loadAgentsFiles({
      cwd: process.cwd(),
      projectRoot: context.gitRoot ?? undefined,
    });
  };
  let agentsFiles = await reloadAgentsFiles();

  // Print startup Banner - 打印启动 Banner
  printStartupBanner(currentConfig, currentConfig.permissionMode, {
    contextWindow: effectiveContextWindow,
    triggerPercent: compactionConfig.triggerPercent,
    enabled: compactionConfig.enabled,
  }, agentsFiles);
  printWorkspaceEntryNotice(startupRuntime);

  // Detect and show project hint - 检测并显示项目提示

  // Create autocomplete - 创建自动补全器
  const completer = createCompleter(() => context.gitRoot ?? process.cwd());

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdout.isTTY ?? true,
    historySize: 100,
    completer: (line: string, callback: (err: null | Error, result: [string[], string]) => void) => {
      // Async completion - 异步补全
      completer(line).then(result => {
        callback(null, result);
      }).catch(() => {
        callback(null, [[], line]);
      });
    },
  });

  // FEATURE_092 phase 2b.7b: bootstrap auto-mode guardrail (factory only;
  // the guardrail is constructed lazily on first 'auto' tool call so the
  // cost is paid only by users who actually use auto mode).
  // Slice C: settings/env block resolved here so the bootstrap stays free
  // of file-system I/O — env override layers feed the resolver chain.
  const autoModeSettings = loadAutoModeSettings();
  const autoModeBootstrap: AutoModeBootstrapResult = await bootstrapAutoMode({
    askUser: async (call, reason, signals) => {
      const result = await confirmToolExecution(
        rl,
        call.name,
        // FEATURE_158: attach signals so confirmToolExecution renders
        // Scope/Risk from the classifier's view. Readline path follows
        // the same _classifierSignals input-marker convention as Ink.
        {
          ...(call.input as Record<string, unknown>),
          ...(signals && signals.length > 0 ? { _classifierSignals: signals } : {}),
        },
        {
          permissionMode: currentPermissionMode,
          reason: `[auto-mode] ${reason}`,
        },
      );
      return result.confirmed ? 'allow' : 'block';
    },
    projectRoot: gitRoot ?? process.cwd(),
    getAgentsFiles: () => agentsFiles,
    getCurrentProviderName: () => currentConfig.provider,
    getCurrentModel: () => currentConfig.model,
    getCurrentPermissionMode: () => currentPermissionMode,
    autoModeSettings,
    log: (level, msg) => {
      if (level === 'warn') console.warn(chalk.yellow(msg));
      else console.log(chalk.dim(msg));
    },
    // FEATURE_092 phase 2b.8: refresh the readline status bar engine
    // indicator on automatic downgrades (denial threshold / circuit breaker)
    // so the user sees `auto[RULES]` immediately after the guardrail flips
    // — without waiting for the next mode toggle.
    onEngineChange: (engine) => {
      if (isAutoMode(currentPermissionMode)) {
        statusBar?.update({ autoModeEngine: engine });
      }
    },
    // FEATURE_158: inject the REPL-side path-aware bash signal collector.
    extraCollectors: [replBashPathSignalCollector],
  });

  // FEATURE_153 (v0.7.38): build the LLM-backed bash prefix extractor used by
  // `isToolCallAllowed`. Live getters re-resolve provider + model on every
  // call, so mid-session `/provider` and `/model` swaps redirect the
  // extractor without an explicit reset (mirrors the auto-mode guardrail's
  // hotfix-3 LIVE getter pattern).
  const bashPrefixExtractor: BashPrefixExtractor = createBashPrefixExtractor({
    getProvider: () => resolveProvider(currentConfig.provider),
    getModel: () => currentConfig.model ?? '',
  });

  // Initialize status bar (if terminal supports) - 初始化状态栏 (如果终端支持)
  const effectiveModel = currentConfig.model ?? getProviderModel(currentConfig.provider) ?? currentConfig.provider;
  let statusBar: StatusBar | null = null;
  if (supportsStatusBar()) {
    statusBar = new StatusBar(createStatusBarState(
      context.sessionId,
      currentConfig.permissionMode,
      currentConfig.provider,
      effectiveModel,
      currentConfig.reasoningMode,
    ));
    // FEATURE_092 phase 2b.8: seed the engine indicator if the session
    // started in auto mode. The guardrail factory is built but the
    // guardrail itself only constructs lazily on first tool call —
    // we trigger eager construction here so the bar can read engine
    // immediately. The cost is one rules-load + one classifier-projection
    // setup, paid only when the user is in auto mode.
    if (isAutoMode(currentPermissionMode)) {
      statusBar.update({
        autoModeEngine: autoModeBootstrap.getGuardrail().getEngine(),
      });
    }
  }

  // Keyboard shortcut state (Phase 2 will use) - 键盘快捷键状态 (Phase 2 将实际使用)
  // let showToolOutput = true;
  // let showTodoList = false;

  // Keyboard shortcut mapping - 键盘快捷键映射
  const KEYBOARD_SHORTCUTS_HELP = `
Keyboard Shortcuts:
  Tab       Auto-complete (@paths, /commands)
  Esc+Esc   Edit last message
  Ctrl+T    Cycle reasoning mode
  Ctrl+E    Open external editor
  Ctrl+R    Search command history (built-in)
  Ctrl+C    Cancel current input
  Ctrl+D    Exit REPL`;

  // Print keyboard shortcuts help (can be called in /help command) - 打印快捷键帮助 (可在 /help 命令中调用)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _printKeyboardShortcuts = (): void => {
    console.log(chalk.dim(KEYBOARD_SHORTCUTS_HELP));
  };

  // Listen for keyboard events (for Esc+Esc and Ctrl+E) - 监听键盘事件 (用于 Esc+Esc 和 Ctrl+E)
  if (process.stdin.isTTY) {
    process.stdin.on('keypress', (char: string | undefined, key: readline.Key | undefined) => {
      if (!key) return;

      // Esc+Esc detection - Esc+Esc 检测
      if (key.name === 'escape') {
        const now = Date.now();
        if (now - lastEscTime < ESC_DOUBLE_PRESS_MS && lastUserMessage) {
          // Double Esc - flag for editing last message in editor - 双击 Esc - 标记需要在编辑器中编辑上一条消息
          pendingEdit = true;
          console.log(chalk.dim('\n[Opening editor with last message...]'));
          // Close current readline prompt so main loop can handle editing - 关闭当前 readline 问题以便主循环可以处理编辑
          rl.pause();
        }
        lastEscTime = now;
      }
    });
  }

  // FEATURE_143 (v0.7.36) — classic CLI parity with InkREPL: build the
  // skill registry's system-prompt snippet at startup and forward it via
  // `context.skillsPrompt`. Without this, classic CLI users got an empty
  // skills list in the system prompt while Ink TUI users got the full
  // hardened skills manifest. See `getSystemPromptSnippet()` for the
  // hardened wording.
  const classicCliSkillRegistry = getSkillRegistry(gitRoot);
  const classicCliSkillsPrompt = classicCliSkillRegistry.getSystemPromptSnippet();

  let isRunning = true;
  // Fix: Ensure session.id is set to reuse same session - 修复：确保 session.id 被设置以复用同一 session
  let currentOptions: RepLOptions = {
    ...options,
    provider: initialProvider,
    model: initialModel,
    agentMode: initialAgentMode,
    reasoningMode: initialReasoningMode,
    thinking: initialThinking,
    context: {
      ...options.context,
      gitRoot,
      executionCwd: startupRuntime.executionCwd,
      repoIntelligenceMode: repoIntelligenceRuntime.mode,
      repoIntelligenceTrace: repoIntelligenceRuntime.trace,
      skillsPrompt: classicCliSkillsPrompt,
    },
    session: {
      ...options.session,
      id: context.sessionId,
      // FEATURE_173 dual-writer fix: the REPL owns session persistence
      // (full lineage + uiHistory + artifactLedger via persistContextState).
      // Suppress the runner's redundant flat snapshot so it can't clobber.
      persistedByHost: true,
    },
  };

  // Cost tracking ref — agent populates this via events.getCostReport, /cost command reads it
  costReportRef.current = null;

  // Command callbacks - 命令回调
  const callbacks: CommandCallbacks = {
    exit: () => {
      isRunning = false;
      // FEATURE_125 — release the instance directory + clear the
      // process-level singleton on /exit so the next session's
      // discovery scan does not have to reap us as a stale peer.
      void teamModeHandle?.shutdown();
      rl.close();
    },
    saveSession: async () => {
      if (context.messages.length > 0) {
        const title = extractTitle(context.messages);
        context.title = title;
        await storage.save(context.sessionId, {
          messages: context.messages,
          title,
          gitRoot: context.gitRoot ?? '',
          runtimeInfo: context.runtimeInfo,
          artifactLedger: context.artifactLedger,
          // FEATURE_226: carry the session tag so a brand-new session's first
          // save persists it (storage merges `data.tag ?? existing` otherwise).
          ...(currentOptions.session?.tag !== undefined ? { tag: currentOptions.session.tag } : {}),
        });
      }
    },
    startNewSession: () => {
      context.sessionId = generateInteractiveSessionId();
      context.title = '';
      context.contextTokenSnapshot = undefined;
      context.artifactLedger = undefined;
      context.createdAt = new Date().toISOString();
      context.lastAccessed = context.createdAt;
      applyRuntimeContext(context, currentOptions, startupRuntime);
      currentOptions.session = {
        ...currentOptions.session,
        id: context.sessionId,
      };
      statusBar?.update({
        sessionId: context.sessionId,
        messageCount: 0,
      });
      teamModeHandle?.writer.update({ sessionId: context.sessionId });
    },
    loadSession: async (id: string) => {
      const loaded = await storage.load(id);
      if (loaded) {
        if (!guardSessionTransition('Resuming a saved session')) {
          return 'blocked';
        }
        const currentWorkspaceRuntime = await inspectWorkspaceRuntime({ cwd: process.cwd() });
        const savedRuntime = resolveSessionRuntimeInfo(loaded);
        let appliedRuntime = savedRuntime ?? currentWorkspaceRuntime;
        if (savedRuntime?.workspaceRoot && !workspaceExists(savedRuntime)) {
          console.log(chalk.yellow('\n[Saved workspace unavailable]'));
          console.log(chalk.dim(`  Session workspace: ${formatWorkspaceTruth(savedRuntime)}`));
          console.log(chalk.dim(`  Falling back to current workspace: ${formatWorkspaceTruth(currentWorkspaceRuntime)}`));
          appliedRuntime = currentWorkspaceRuntime;
        } else if (
          savedRuntime?.workspaceRoot
          && currentWorkspaceRuntime.workspaceRoot
          && savedRuntime.workspaceRoot !== currentWorkspaceRuntime.workspaceRoot
        ) {
          console.log(chalk.cyan('\n[Loading sibling workspace session]'));
          console.log(chalk.dim(`  Current workspace: ${formatWorkspaceTruth(currentWorkspaceRuntime)}`));
          console.log(chalk.dim(`  Session workspace: ${formatWorkspaceTruth(savedRuntime)}`));
        }

        context.messages = loaded.messages;
        context.title = loaded.title;
        context.sessionId = id;
        context.contextTokenSnapshot = undefined;
        context.artifactLedger = loaded.artifactLedger;
        context.lastAccessed = new Date().toISOString();
        applyRuntimeContext(context, currentOptions, appliedRuntime);
        currentOptions.session = {
          ...currentOptions.session,
          id,
          // FEATURE_226: reflect the loaded session's tag in-memory so saves
          // / forks carry it (storage merges `data.tag ?? existing` on save).
          tag: loaded.tag,
        };
        statusBar?.update({
          sessionId: id,
          messageCount: loaded.messages.length,
        });
        teamModeHandle?.writer.update({ sessionId: id });
        console.log(chalk.green(`\n[Loaded session: ${id}]`));
        console.log(chalk.dim(`  Messages: ${loaded.messages.length}`));
        if (context.runtimeInfo?.workspaceRoot) {
          console.log(chalk.dim(`  Workspace: ${formatWorkspaceTruth(context.runtimeInfo)}`));
        }
        return 'loaded';
      }
      return 'missing';
    },
      listSessions: async () => {
        const sessions = await storage.list(context.gitRoot ?? undefined);
        if (sessions.length === 0) {
          console.log(chalk.dim('\n[No saved sessions]'));
          return;
      }
      console.log(chalk.bold('\nRecent Sessions:\n'));
        if (context.runtimeInfo?.workspaceRoot) {
          console.log(chalk.dim(`  Current workspace: ${formatWorkspaceTruth(context.runtimeInfo)}`));
          console.log();
        }
        for (const s of sessions.slice(0, 10)) {
          console.log(`  ${chalk.cyan(s.id)} ${chalk.dim(`(${s.msgCount} messages)`)} ${s.title.slice(0, 40)}`);
          if (s.runtimeInfo?.workspaceRoot) {
            const sameWorkspace = context.runtimeInfo?.workspaceRoot === s.runtimeInfo.workspaceRoot;
            const suffix = sameWorkspace ? ' (current workspace)' : '';
            console.log(chalk.dim(`      workspace: ${formatWorkspaceTruth(s.runtimeInfo)}${suffix}`));
          }
        }
        console.log();
      },
    clearHistory: () => {
      context.messages = [];
      context.contextTokenSnapshot = undefined;
    },
    printHistory: () => {
      if (context.messages.length === 0) {
        console.log(chalk.dim('\n[No conversation history]'));
        return;
      }
      console.log(chalk.bold('\nConversation History:\n'));
      const recent = context.messages.slice(-20);
      for (let i = 0; i < recent.length; i++) {
        const m = recent[i]!;
        const role = chalk.cyan(m.role.padEnd(10));
        const content = typeof m.content === 'string' ? m.content : '[Complex content]';
        const preview = content.slice(0, 60).replace(/\n/g, ' ');
        const ellipsis = content.length > 60 ? '...' : '';
        console.log(`  ${(i + 1).toString().padStart(2)}. ${role} ${preview}${ellipsis}`);
      }
      console.log();
    },
    switchProvider: (provider: string, model?: string) => {
      currentConfig.provider = provider;
      currentConfig.model = model;
      currentOptions.provider = provider;
      currentOptions.model = model;
      let newModel = model ?? getProviderModel(provider);
      if (!newModel) {
        // Fallback for custom providers - 自定义 Provider 的后备
        try {
          const custom = getCustomProvider(provider);
          newModel = custom?.getModel() ?? provider;
        } catch {
          newModel = provider;
        }
      }
      statusBar?.update({
        provider,
        model: newModel,
      });
    },
    setThinking: (enabled: boolean) => {
      currentConfig.thinking = enabled;
      currentOptions.thinking = enabled;
      currentConfig.reasoningMode = enabled ? 'auto' : 'off';
      currentOptions.reasoningMode = currentConfig.reasoningMode;
      statusBar?.update({ reasoningMode: currentConfig.reasoningMode });
    },
    setReasoningMode: (mode: KodaXReasoningMode) => {
      const thinking = mode !== 'off';
      currentConfig.reasoningMode = mode;
      currentConfig.thinking = thinking;
      currentOptions.reasoningMode = mode;
      currentOptions.thinking = thinking;
      statusBar?.update({ reasoningMode: mode });
    },
    setAgentMode: (mode: KodaXAgentMode) => {
      currentConfig.agentMode = mode;
      currentOptions.agentMode = mode;
    },
    setPermissionMode: (mode: PermissionMode) => {
      currentConfig.permissionMode = mode;
      currentPermissionMode = mode; // Sync with local permission state
      // FEATURE_092 phase 2b.8: keep the status bar engine indicator in sync
      // when the user toggles in/out of auto mode. Outside auto modes,
      // setting `autoModeEngine: undefined` removes the [LLM]/[RULES] suffix.
      const autoModeEngine = isAutoMode(mode)
        ? autoModeBootstrap.getGuardrail().getEngine()
        : undefined;
      statusBar?.update({ permissionMode: mode, autoModeEngine });
      // FEATURE_092 phase 2b.7b slice E: surface the deprecation when the
      // user explicitly picks the alias via `/mode auto-in-project`.
      // Once-per-session semantics means picking it at startup THEN typing
      // /mode auto-in-project later still emits AT MOST once.
      if (mode === 'auto-in-project') {
        emitAutoInProjectDeprecation();
      }
      // Note: permissionMode is no longer part of KodaXOptions
      // Permission control is handled locally via beforeToolExecute callback
    },
    setRepoIntelligenceRuntime: (update) => {
      if (update.mode !== undefined) {
        currentConfig.repoIntelligenceMode = update.mode;
        process.env.KODAX_REPO_INTELLIGENCE_MODE = update.mode;
        currentOptions.context = {
          ...currentOptions.context,
          repoIntelligenceMode: update.mode,
        };
      }
      if (update.trace !== undefined) {
        currentConfig.repoIntelligenceTrace = update.trace;
        if (update.trace) {
          process.env.KODAX_REPO_INTELLIGENCE_TRACE = '1';
        } else {
          delete process.env.KODAX_REPO_INTELLIGENCE_TRACE;
        }
        currentOptions.context = {
          ...currentOptions.context,
          repoIntelligenceTrace: update.trace,
        };
      }
      if (update.endpoint !== undefined) {
        currentConfig.repointelEndpoint = update.endpoint ?? undefined;
        if (update.endpoint) {
          process.env.KODAX_REPOINTEL_ENDPOINT = update.endpoint;
        } else {
          delete process.env.KODAX_REPOINTEL_ENDPOINT;
        }
      }
      if (update.bin !== undefined) {
        currentConfig.repointelBin = update.bin ?? undefined;
        if (update.bin) {
          process.env.KODAX_REPOINTEL_BIN = update.bin;
        } else {
          delete process.env.KODAX_REPOINTEL_BIN;
        }
      }
    },
    deleteSession: async (id: string) => {
      await storage.delete?.(id);
    },
    deleteAllSessions: async () => {
      await storage.deleteAll?.(context.gitRoot ?? undefined);
    },
    printSessionTree: async () => {
      const lineage = await storage.getLineage?.(context.sessionId);
      if (!lineage) {
        console.log(chalk.dim('\n[No session tree available for this session]'));
        return;
      }

      const lines = formatSessionTree(buildSessionTree(lineage));
      console.log(chalk.bold('\nSession Tree:\n'));
      for (const line of lines) {
        console.log(`  ${line}`);
      }
      console.log();
    },
    switchSessionBranch: async (selector: string) => {
      if (!guardSessionTransition('Switching session branches')) {
        return 'blocked';
      }

      const loaded = await storage.setActiveEntry?.(
        context.sessionId,
        selector,
        { summarizeCurrentBranch: true },
      );
      if (!loaded) {
        return 'missing';
      }

      context.messages = loaded.messages;
      context.title = loaded.title;
      context.contextTokenSnapshot = undefined;
      statusBar?.update({ messageCount: context.messages.length });
      console.log(chalk.green(`\n[Switched to tree entry: ${selector}]`));
      console.log(chalk.dim(`  Messages: ${loaded.messages.length}`));
      return 'switched';
    },
    labelSessionBranch: async (selector: string, label?: string) => {
      const updated = await storage.setLabel?.(context.sessionId, selector, label);
      if (!updated) {
        return false;
      }

      const action = label && label.trim()
        ? `checkpoint label set: ${label.trim()}`
        : 'checkpoint label cleared';
      console.log(chalk.green(`\n[${action}]`));
      return true;
    },
    forkSession: async (selector?: string) => {
      if (!guardSessionTransition('Forking a session branch')) {
        return 'blocked';
      }

      const forked = await storage.fork?.(context.sessionId, selector);
      if (!forked) {
        return 'failed';
      }

      context.sessionId = forked.sessionId;
      context.messages = forked.data.messages;
      context.title = forked.data.title;
      context.contextTokenSnapshot = undefined;
      context.createdAt = new Date().toISOString();
      context.lastAccessed = context.createdAt;
      applyRuntimeContext(context, currentOptions, resolveSessionRuntimeInfo(forked.data) ?? context.runtimeInfo);
      currentOptions.session = {
        ...currentOptions.session,
        id: forked.sessionId,
      };
      statusBar?.update({
        sessionId: forked.sessionId,
        messageCount: context.messages.length,
      });
      console.log(chalk.green(`\n[Forked session: ${forked.sessionId}]`));
      console.log(chalk.dim(`  Messages: ${forked.data.messages.length}`));
      return 'forked';
    },
    rewindSession: async (selector?: string) => {
      if (!guardSessionTransition('Rewinding session')) {
        return 'blocked';
      }

      const rewound = await storage.rewind?.(context.sessionId, selector);
      if (!rewound) {
        return 'failed';
      }

      context.messages = rewound.messages;
      context.title = rewound.title;
      context.contextTokenSnapshot = undefined;
      context.lastAccessed = new Date().toISOString();
      statusBar?.update({ messageCount: context.messages.length });
      console.log(chalk.green(`\n[Rewound session${selector ? ` to ${selector}` : ' to previous turn'}]`));
      console.log(chalk.dim(`  Messages: ${rewound.messages.length}`));
      return 'rewound';
    },
    getCostReport: () => costReportRef.current?.() ?? null,
    // FEATURE_092 phase 2b.8: auto-mode read-only stats + manual engine setter
    // for /auto-engine, /auto-denials, status bar indicator. The accessors
    // delegate to the lazy guardrail factory — when REPL never enters auto
    // mode, the guardrail is never constructed and the stats are undefined.
    getAutoModeStats: () => {
      if (!isAutoMode(currentPermissionMode)) return undefined;
      return autoModeBootstrap.getGuardrail().getStats();
    },
    setAutoModeEngine: (engine) => {
      if (!isAutoMode(currentPermissionMode)) return;
      autoModeBootstrap.getGuardrail().setEngine(engine);
      statusBar?.update({ permissionMode: currentPermissionMode });
    },
    createKodaXOptions: () => {
      // FEATURE_074: live plan-mode check for child agents. The closure reads
      // currentPermissionMode lazily, so mid-run parent-mode toggles propagate
      // into in-flight children (user flipping plan ↔ accept-edits mid-stream
      // is a common case and was the original request).
      const planModeBlockCheck = (tool: string, input: Record<string, unknown>): string | null => {
        if (currentPermissionMode !== 'plan') return null;
        return getPlanModeBlockReason(tool, input, gitRoot ?? process.cwd());
      };
      // FEATURE_092 phase 2b.7b: when the user is in 'auto' (canonical) or
      // 'auto-in-project' (alias), forward the AutoModeToolGuardrail to
      // Runner via KodaXOptions.guardrails. The lazy factory means we only
      // pay the construction + rules-load cost for users who use auto mode.
      const guardrails = isAutoMode(currentPermissionMode)
        ? [autoModeBootstrap.getGuardrail()]
        : undefined;
      return {
        ...currentOptions,
        provider: currentConfig.provider,
        model: currentConfig.model,
        thinking: currentConfig.thinking,
        reasoningMode: currentConfig.reasoningMode,
        guardrails,
        context: {
          ...currentOptions.context,
          planModeBlockCheck,
        },
        events: {
          ...currentOptions.events,
          // FEATURE_074: exit_plan_mode tool callback. Three-state return:
          //   'not-in-plan-mode' when called outside plan mode (tool turns this
          //   into an explicit error); true on approval; false on rejection.
          // buildToolConfirmationDisplay renders the full plan from input.plan,
          // so the user actually sees what they're approving.
          exitPlanMode: async (plan: string): Promise<boolean | 'not-in-plan-mode'> => {
            if (currentPermissionMode !== 'plan') return 'not-in-plan-mode';
            const result = await confirmToolExecution(rl, 'exit_plan_mode', { plan }, {
              isProtectedPath: false,
              permissionMode: currentPermissionMode,
            });
            if (result.confirmed) {
              currentConfig.permissionMode = 'accept-edits';
              currentPermissionMode = 'accept-edits';
              statusBar?.update({ permissionMode: 'accept-edits' });
              return true;
            }
            return false;
          },
          // Permission control via beforeToolExecute hook - 通过 beforeToolExecute 钩子控制权限
          beforeToolExecute: async (tool: string, input: Record<string, unknown>): Promise<boolean | string> => {
            const mode = currentPermissionMode;
            const confirmTools = computeConfirmTools(mode);

            if (mode === 'plan') {
              const planModeBlockReason = getPlanModeBlockReason(tool, input, gitRoot ?? process.cwd());
              if (planModeBlockReason) {
                console.log(chalk.yellow(planModeBlockReason));
                return `${planModeBlockReason} Do not modify files while planning. Finish the plan first, then call exit_plan_mode with the finalized plan — the user will review and approve or reject.`;
              }
            }

            // All modes: safe read-only bash commands are auto-allowed BEFORE protected path check
            // 所有模式：安全的只读 bash 命令在受保护路径检查之前就自动放行
            if (tool === 'bash') {
              const command = (input.command as string) ?? '';
              if (isBashReadCommand(command)) {
                return true; // Auto-allowed for safe read-only commands
              }
            }

            // Protected paths: always confirm
            if (gitRoot && FILE_MODIFICATION_TOOLS.has(tool)) {
              const targetPath = input.path as string | undefined;
              if (targetPath && isAlwaysConfirmPath(targetPath, gitRoot)) {
                const result = await confirmToolExecution(rl, tool, input, {
                  isProtectedPath: true,
                  permissionMode: mode,
                });
                if (!result.confirmed) {
                  console.log(chalk.dim('[Cancelled] Operation on protected path requires confirmation'));
                  return false;
                }
                return true;
              }
            }

            // Check if tool needs confirmation based on mode
            if (confirmTools.has(tool)) {
              // Check alwaysAllowTools in accept-edits mode for bash.
              // FEATURE_153: pass LLM extractor (constructed at REPL bootstrap;
              // see bashPrefixExtractor below) so allowlist patterns match
              // against extracted safe prefix instead of naive startsWith.
              if (mode === 'accept-edits' && tool === 'bash') {
                if (
                  await isToolCallAllowed(
                    tool,
                    input,
                    alwaysAllowTools,
                    bashPrefixExtractor,
                  )
                ) {
                  return true;
                }
              }

              // Show confirmation dialog
              const result = await confirmToolExecution(rl, tool, input, {
                isOutsideProject: input._outsideProject === true,
                reason: input._reason as string | undefined,
                permissionMode: mode,
              });

              if (!result.confirmed) {
                console.log(chalk.dim('[Cancelled] Operation cancelled by user'));
                return false;
              }

              // Handle "always" selection
              if (result.always) {
                if (mode === 'accept-edits') {
                  saveAlwaysAllowToolPattern(tool, input, false);
                  alwaysAllowTools = loadAlwaysAllowTools();
                }
              }
            }

            return true;
          },
        },
      };
    },
    // Pass readline interface for commands requiring user interaction - 传递 readline 接口供需要用户交互的命令使用
    reloadAgentsFiles: async () => {
      agentsFiles = await reloadAgentsFiles();
      return agentsFiles;
    },
    readline: rl,
    ui: new ReadlineUIContext(rl),
  };

  // Handle Ctrl+C - 处理 Ctrl+C
  rl.on('SIGINT', async () => {
    console.log(chalk.dim('\n\n[Press /exit to quit]'));
    rl.prompt();
  });

  // Handle cleanup on exit - 处理退出时清理状态栏
  const cleanup = () => {
    statusBar?.hide();
    // FEATURE_125 — fire-and-forget Team Mode shutdown. The
    // state-writer's shutdown() does its work synchronously
    // (clearInterval + fs.rmSync) before the trailing
    // `await Promise.resolve()`, so the instance directory is
    // gone by the time the 'exit' handler returns even though
    // the promise is unawaited.
    void teamModeHandle?.shutdown();
    rl.close();
  };

  process.on('exit', cleanup);
  process.on('SIGTERM', cleanup);

  const startWorkflowInvocation = async (
    workflow: CommandWorkflowInvocationRequest,
    rawInput: string,
  ): Promise<boolean> => {
    const decision = decideWorkflowInvocation({
      agentMode: currentConfig.agentMode,
      source: workflow.source,
      input: rawInput || workflow.request,
    });

    if (decision.action === 'none') {
      return false;
    }

    if (decision.action === 'suggest' && workflow.source === 'natural-language') {
      const confirm = resolveConfirm(callbacks);
      if (!confirm) {
        console.log(chalk.dim('\n[workflow] This task looks suitable for workflow. Use /workflow create <request> to run it.\n'));
        return false;
      }
      const cancelsTurn = decision.trigger === 'explicit';
      const approved = await confirm(
        cancelsTurn
          ? 'This request explicitly asks for workflow. Generate and run it? Choose No to cancel this turn.'
          : 'This task looks suitable for workflow. Use workflow? Choose No to continue with normal AMA.',
      );
      if (!approved) {
        if (!cancelsTurn) return false;
        console.log(chalk.dim('\nWorkflow request cancelled. No normal AMA fallback was started.\n'));
        return true;
      }
    }

    let workflowUserCommitted = false;
    const commitWorkflowFinal = (text: string): void => {
      if (!workflowUserCommitted) {
        workflowUserCommitted = true;
        context.messages.push({
          role: 'user',
          content: rawInput || workflow.request,
        });
      }
      context.messages.push({ role: 'assistant', content: text });
      statusBar?.update({ messageCount: context.messages.length });
      const title = extractTitle(context.messages);
      context.title = title;
      void storage.save(context.sessionId, {
        messages: context.messages,
        title,
        gitRoot: context.gitRoot ?? '',
        runtimeInfo: context.runtimeInfo,
        artifactLedger: context.artifactLedger,
        ...(currentOptions.session?.tag !== undefined ? { tag: currentOptions.session.tag } : {}),
      }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.log(chalk.red(`\n[workflow] failed to save final answer: ${message}\n`));
      });
    };
    const workflowCallbacks: CommandCallbacks = {
      ...callbacks,
      onWorkflowRunMessage: (event) => {
        if (event.type === 'event') return;
        const text = event.text.trimEnd();
        if (!text.trim()) return;
        if (event.type === 'error') {
          console.log(chalk.red(`\n${text}\n`));
          return;
        }
        if (event.type === 'success') {
          console.log(chalk.green(`\n${text}\n`));
          return;
        }
        if (event.type === 'assistant') {
          console.log(`\n${text}\n`);
          if (event.final === true) {
            commitWorkflowFinal(text);
          }
          return;
        }
        console.log(chalk.dim(`\n${text}\n`));
      },
    };

    const outcome = await startGeneratedWorkflowFromRequest({
      request: workflow.request,
      callbacks: workflowCallbacks,
      approval: currentConfig.permissionMode === 'plan' ? 'required' : 'silent',
      presentation: 'agentic',
      sourceLabel: workflow.displayName,
    });

    return outcome === 'started' || outcome === 'cancelled';
  };

  const handleCommandResult = async (
    result: Awaited<ReturnType<typeof executeCommand>>,
    rawInput: string
  ): Promise<void> => {
    if (!result || typeof result !== 'object') {
      return;
    }

    if (result.workflow) {
      await startWorkflowInvocation(result.workflow, rawInput);
      return;
    }

    if (!result.invocation) {
      return;
    }

    const prepared = await prepareInvocationExecution(
      {
        ...currentOptions,
        provider: currentConfig.provider,
        thinking: currentConfig.thinking,
        reasoningMode: currentConfig.reasoningMode,
      },
      result.invocation,
      rawInput,
      (message) => console.log(chalk.dim(`\n${message}`))
    );

    if (prepared.mode === 'manual') {
      if (prepared.manualOutput) {
        console.log(chalk.yellow(`\n${prepared.manualOutput}\n`));
      }
      await prepared.finalize();
      return;
    }

    if (!prepared.prompt || !prepared.options) {
      await prepared.finalize();
      return;
    }

    try {
      const initialMessages = prepared.mode === 'fork' ? [] : context.messages;
      const runResult = await runAgentRound(
        prepared.options,
        context,
        prepared.prompt,
        initialMessages
      );

      if (prepared.mode === 'fork') {
        const assistantText = extractLastAssistantText(runResult.messages);
        if (assistantText.trim()) {
          console.log(`\n${assistantText}\n`);
          context.messages.push({ role: 'assistant', content: assistantText });
        }
      } else {
        context.messages = runResult.messages;
        context.contextTokenSnapshot = runResult.contextTokenSnapshot;
      }

      statusBar?.update({ messageCount: context.messages.length });
      if (context.messages.length > 0) {
        const title = extractTitle(context.messages);
        context.title = title;
        await storage.save(context.sessionId, {
          messages: context.messages,
          title,
          gitRoot: context.gitRoot ?? '',
          runtimeInfo: context.runtimeInfo,
          ...(currentOptions.session?.tag !== undefined ? { tag: currentOptions.session.tag } : {}),
        });
      }
      await prepared.finalize();
    } catch (error) {
      await prepared.finalize(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  };

  // Main loop - 主循环
  while (isRunning) {
    // Check if need to edit last message (Esc+Esc triggered) - 检查是否需要编辑上一条消息 (Esc+Esc 触发)
    if (pendingEdit && lastUserMessage) {
      pendingEdit = false;
      rl.resume();  // Resume readline - 恢复 readline
      // Open last message in external editor - 在外部编辑器中打开上一条消息
      const edited = await openExternalEditor(lastUserMessage);
      if (edited && edited.trim() && edited !== lastUserMessage) {
        // If modified, process as new input - 如果有修改，作为新输入处理
        console.log(chalk.dim(`\n[Edited message ready to send]`));
        // Process edited content directly, skip askInput - 直接处理编辑后的内容，跳过 askInput
        const trimmed = edited.trim();
        touchContext(context);

        // Process command - 处理命令
        const parsed = parseCommand(trimmed);
        if (parsed) {
          const commandResult = await executeCommand(parsed, context, callbacks, currentConfig);
          await handleCommandResult(commandResult, trimmed);
          continue;
        }

        // Process special syntax and update lastUserMessage - 处理特殊语法并更新 lastUserMessage
        const processed = await processSpecialSyntax(trimmed);
        if (trimmed.startsWith('!') && isShellCommandHandled(processed)) {
          continue;
        }
        if (await startWorkflowInvocation({
          request: processed,
          source: 'natural-language',
          displayName: currentConfig.agentMode.toUpperCase(),
        }, trimmed)) {
          lastUserMessage = trimmed;
          continue;
        }
        const preparedArtifacts = preparePromptInputArtifacts(
          processed,
          currentOptions.context?.executionCwd ?? process.cwd(),
        );
        for (const warning of preparedArtifacts.warnings) {
          console.log(chalk.yellow(`\n${warning}`));
        }
        context.messages.push({ role: 'user', content: preparedArtifacts.messageContent });
        lastUserMessage = trimmed;
        statusBar?.update({ messageCount: context.messages.length });

        // Run agent (copy main loop logic) - 运行 agent (复制主循环逻辑)
        // FEATURE_192 v0.7.44 — build the goal runtime binding so the
        // runner-driven adapter can wire turn-end accounting + auto-
        // continue on a Worker text-only termination. Default ON; the
        // binding is a no-op until the user creates a goal via `/goal`
        // or the model calls `create_goal` (the ADR-033 §1 prompt
        // discourages autonomous goal creation on simple tasks).
        const goalRuntime =
          context.lineage
            ? buildGoalRuntimeBinding({
                getLineage: () => context.lineage!,
                setLineage: (next) => {
                  context.lineage = next;
                },
                saveSession: async () => {
                  await storage.save(context.sessionId, {
                    messages: context.messages,
                    title: context.title ?? extractTitle(context.messages),
                    gitRoot: context.gitRoot ?? '',
                    runtimeInfo: context.runtimeInfo,
                    artifactLedger: context.artifactLedger,
                    lineage: context.lineage,
                    ...(currentOptions.session?.tag !== undefined ? { tag: currentOptions.session.tag } : {}),
                  });
                },
                // getLatestUsage + getTurnStartMs are overridden inside
                // runner-driven.ts (it owns the per-turn token state +
                // turn-start clock). Stubs here.
                getLatestUsage: () => undefined,
                getTurnStartMs: () => undefined,
                getPermissionMode: () => currentPermissionMode,
                // user-priority `mode:'prompt'` messages on the main
                // queue mean the user is typing — defer goal auto-
                // continue so their input lands naturally.
                hasPendingUserInput: () =>
                  getMessageQueue().has({
                    agentId: undefined,
                    maxPriority: 'user',
                    mode: 'prompt',
                  }),
                // STUB — Commit 3 of the v0.7.44 review-cycle replaces
                // this with a real verifier wire that closes over the
                // runner's per-turn transcript + fileEdits. Until the
                // adapter extraction lands (Commit 2 of the same cycle),
                // verifyComplete is constructed inside runner-driven.ts
                // (where transcript/edits are accessible) and overrides
                // the stub via the same dep-injection pattern as
                // getLatestUsage / getTurnStartMs.
                verifyComplete: async () => ({ ok: true }),
              })
            : undefined;

        try {
          const result = await runManagedTask(
            {
              ...currentOptions,
              provider: currentConfig.provider,
              thinking: currentConfig.thinking,
              reasoningMode: currentConfig.reasoningMode,
              session: {
                ...currentOptions.session,
                // FEATURE_072: Scout / managed-task workers inherit the
                // derived view (summary + attachments + kept tail) when a
                // lineage is available, instead of the flat `context.messages`
                // snapshot. Behaviour is identical post-072-Phase-B because
                // lineage is reconciled on every compaction; the derived
                // view is preferred as the authoritative source.
                initialMessages: context.lineage
                  ? getSessionMessagesFromLineage(context.lineage, context.lineage.activeEntryId)
                  : context.messages,
              },
              context: {
                ...currentOptions.context,
                taskSurface: 'repl',
                // FEATURE_074: live plan-mode check for child-agent inheritance.
                // Separate code path from createKodaXOptions — must propagate too.
                planModeBlockCheck: (tool: string, input: Record<string, unknown>): string | null => {
                  if (currentPermissionMode !== 'plan') return null;
                  return getPlanModeBlockReason(tool, input, gitRoot ?? process.cwd());
                },
                ...(preparedArtifacts.inputArtifacts.length > 0
                  ? { inputArtifacts: preparedArtifacts.inputArtifacts }
                  : {}),
                ...(goalRuntime ? { goalRuntime } : {}),
              },
            },
            processed
          );
          context.messages = result.messages;
          context.contextTokenSnapshot = result.contextTokenSnapshot;
          // FEATURE_076: prefer pre-extracted result.artifactLedger; fall
          // back to walking result.messages for backward compatibility
          // with paths that have not yet been reshape-updated.
          context.artifactLedger = mergeArtifactLedger(
            context.artifactLedger ?? [],
            (result.artifactLedger as typeof context.artifactLedger | undefined)
              ?? extractArtifactLedger(result.messages),
          );

          // Auto save - 自动保存
          if (context.messages.length > 0) {
            const title = extractTitle(context.messages);
            context.title = title;
            await storage.save(context.sessionId, {
              messages: context.messages,
              title,
              gitRoot: context.gitRoot ?? '',
              runtimeInfo: context.runtimeInfo,
              artifactLedger: context.artifactLedger,
              ...(currentOptions.session?.tag !== undefined ? { tag: currentOptions.session.tag } : {}),
            });
          }
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          context.messages.pop();
          console.log(chalk.red(`\n[Error] ${error.message}`));
        }
        continue;
      } else if (edited === lastUserMessage) {
        console.log(chalk.dim('\n[No changes made, continuing...]'));
      }
    }

    const prompt = getPrompt(currentConfig.permissionMode, currentConfig);
    const input = await askInput(rl, prompt);

    if (!isRunning) break;

    const trimmed = input.trim();
    if (!trimmed) continue;

    touchContext(context);

    // Process command - 处理命令
    const parsed = parseCommand(trimmed);
    if (parsed) {
      const commandResult = await executeCommand(parsed, context, callbacks, currentConfig);
      await handleCommandResult(commandResult, trimmed);
      continue;
    }

    // Process special syntax - 处理特殊语法
    const processed = await processSpecialSyntax(trimmed);

    // Shell command handling: Warp style - Shell 命令处理：Warp 风格
    // - Success → skip (result shown) - 成功执行 → 跳过（结果已显示）
    // - Empty command → skip (user knows) - 空命令 → 跳过（用户知道）
    // - Failure/Error → send to LLM (needs smart help) - 失败/错误 → 发送给 LLM（需要智能帮助）
    if (trimmed.startsWith('!')) {
      if (isShellCommandHandled(processed)) {
        continue;
      }
    }

    // Add user message to context - 添加用户消息到上下文
    if (await startWorkflowInvocation({
      request: processed,
      source: 'natural-language',
      displayName: currentConfig.agentMode.toUpperCase(),
    }, trimmed)) {
      lastUserMessage = trimmed;
      continue;
    }

    const preparedArtifacts = preparePromptInputArtifacts(
      processed,
      currentOptions.context?.executionCwd ?? process.cwd(),
    );
    for (const warning of preparedArtifacts.warnings) {
      console.log(chalk.yellow(`\n${warning}`));
    }
    context.messages.push({ role: 'user', content: preparedArtifacts.messageContent });

    // Save last user message (for Esc+Esc editing) - 保存最后一条用户消息 (用于 Esc+Esc 编辑)
    lastUserMessage = trimmed;

    // Update status bar message count - 更新状态栏消息数量
    statusBar?.update({ messageCount: context.messages.length });

    // Run Agent - 运行 Agent
    try {
      const result = await runAgentRound(
        currentOptions,
        context,
        processed,
        context.messages,
        preparedArtifacts.inputArtifacts,
      );

      // Update context messages (runKodaX returns complete message list) - 更新上下文中的消息（runKodaX 返回完整的消息列表）
      context.messages = result.messages;
      context.contextTokenSnapshot = result.contextTokenSnapshot;
      // FEATURE_076: prefer pre-extracted result.artifactLedger; fall back
      // to walking result.messages for backward compatibility with paths
      // that have not yet been reshape-updated.
      context.artifactLedger = mergeArtifactLedger(
        context.artifactLedger ?? [],
        (result.artifactLedger as typeof context.artifactLedger | undefined)
          ?? extractArtifactLedger(result.messages),
      );

      // Update status bar - 更新状态栏
      statusBar?.update({
        messageCount: context.messages.length,
      });

      // Auto save - 自动保存
      if (context.messages.length > 0) {
        const title = extractTitle(context.messages);
        context.title = title;
        await storage.save(context.sessionId, {
          messages: context.messages,
          title,
          gitRoot: context.gitRoot ?? '',
          runtimeInfo: context.runtimeInfo,
          artifactLedger: context.artifactLedger,
          ...(currentOptions.session?.tag !== undefined ? { tag: currentOptions.session.tag } : {}),
        });
      }
    } catch (err) {
      // Handle different error types - 处理不同类型的错误
      const error = err instanceof Error ? err : new Error(String(err));

      // Remove failed user message (avoid duplicates) - 移除失败的用户消息（避免重复）
      context.messages.pop();

      // Provide recovery suggestions based on error type - 根据错误类型提供不同的恢复建议
      if (error.message.includes('rate limit') || error.message.includes('Rate limit')) {
        console.log(chalk.yellow(`\n[Rate Limit] ${error.message}`));
        console.log(chalk.dim('Suggestion: Wait a moment and try again, or switch provider with /mode\n'));
      } else if (error.message.includes('API key') || error.message.includes('not configured')) {
        console.log(chalk.red(`\n[Configuration Error] ${error.message}`));
        console.log(chalk.dim('Suggestion: Set the required API key environment variable\n'));
      } else if (error.message.includes('network') || error.message.includes('ECONNREFUSED') || error.message.includes('ETIMEDOUT')) {
        console.log(chalk.red(`\n[Network Error] ${error.message}`));
        console.log(chalk.dim('Suggestion: Check your internet connection and try again\n'));
      } else if (error.message.includes('token') || error.message.includes('context too long')) {
        console.log(chalk.yellow(`\n[Context Error] ${error.message}`));
        console.log(chalk.dim('Suggestion: Use /clear to start a fresh conversation\n'));
      } else {
        console.log(chalk.red(`\n[Error] ${error.message}`));
        console.log(chalk.dim('Your message was not sent. Please try again.\n'));
      }
    }
  }
}

// Get prompt (responsive, using theme colors) - 获取提示符 (响应式，使用主题颜色)
export async function processSpecialSyntax(input: string): Promise<string> {
  // @path syntax: attach image artifacts to context - @path 语法：将图片工件附加到上下文
  const fileRefs = input.match(/@[\w./-]+/g);
  if (fileRefs) {
    for (const ref of fileRefs) {
      const filePath = ref.slice(1); // Remove @ - 移除 @
      // Can read file and add to context here - 这里可以读取文件并添加到上下文
      // Temporarily keep as is, implement later - 暂时保留原样，后续实现
    }
  }

  // !command syntax: execute shell command - !command 语法：执行 shell 命令
  if (input.startsWith('!')) {
    const command = input.slice(1).trim();
    return executeShellCommand(command, { cwd: process.cwd() });
  }

  return input;
}

// Run one round of Agent - 运行一轮 Agent
async function runAgentRound(
  options: KodaXOptions,
  context: InteractiveContext,
  prompt: string,
  initialMessages: KodaXMessage[] = context.messages,
  inputArtifacts?: readonly KodaXInputArtifact[],
): Promise<KodaXResult> {
  // Create event callbacks - 创建事件回调
  const events = {
    ...(options.events ?? {}),
    getCostReport: costReportRef,
  };

  // Pass existing conversation history for multi-turn dialogue - 传递已有的对话历史，实现多轮对话
  return runManagedTask(
    {
      ...options,
      events,
      session: {
        ...options.session,
        initialMessages,  // Pass existing messages - 传递已有消息
      },
      context: {
        ...options.context,
        contextTokenSnapshot: context.contextTokenSnapshot,
        taskSurface: 'repl',
        ...(inputArtifacts && inputArtifacts.length > 0
          ? { inputArtifacts: [...inputArtifacts] }
          : {}),
      },
    },
    prompt
  );
}

// Extract title from messages - 从消息中提取标题
function extractTitle(messages: KodaXMessage[]): string {
  return extractSessionTitle(messages);
}

// Print startup Banner (using theme colors) - 打印启动 Banner (使用主题颜色)
// FEATURE_200 Phase E: readline/input helpers extracted to ./readline-helpers.ts.
import { getPrompt, askInput, openExternalEditor, needsContinuation } from './readline-helpers.js';

// FEATURE_200 Phase E: startup banner extracted to ./startup-banner.ts.
import { printStartupBanner, printWorkspaceEntryNotice } from './startup-banner.js';
