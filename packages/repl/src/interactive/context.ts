/**
 * KodaX Interactive Context Management - 交互式上下文管理
 */

import type {
  KodaXContextTokenSnapshot,
  KodaXSkillDynamicContextPolicy,
} from '@kodax-ai/coding';
import type {
  KodaXExtensionSessionRecord,
  KodaXExtensionSessionState,
  KodaXMessage,
  KodaXSessionArtifactLedgerEntry,
  KodaXSessionLineage,
  KodaXSessionRuntimeInfo,
  KodaXSessionUiHistoryItem,
} from '@kodax-ai/agent';
import { generateSessionIdSync } from '@kodax-ai/agent';

// Interactive mode - 交互模式
export type InteractiveMode = 'code' | 'ask';

// Interactive session context - 交互式会话上下文
export interface InteractiveContext {
  messages: KodaXMessage[];
  uiHistory?: KodaXSessionUiHistoryItem[];
  contextTokenSnapshot?: KodaXContextTokenSnapshot;
  lineage?: KodaXSessionLineage;
  artifactLedger?: KodaXSessionArtifactLedgerEntry[];
  extensionState?: KodaXExtensionSessionState;
  extensionRecords?: KodaXExtensionSessionRecord[];
  extensionStateDirty?: boolean;
  extensionRecordsDirty?: boolean;
  /** Internal fence: a non-tail Session field changed since the last exact write. */
  sessionSnapshotDirty?: boolean;
  sessionId: string;
  title: string;
  gitRoot?: string;
  runtimeInfo?: KodaXSessionRuntimeInfo;
  createdAt: string;
  lastAccessed: string;
  // FEATURE_222 (R4): host skill dynamic-context policy, forwarded from
  // RepLOptions so the user-typed `/skill` slash path honors the same
  // executeDynamicContext / disable policy as the model-triggered skill tool.
  skillDynamicContext?: KodaXSkillDynamicContextPolicy;
  // Note: mode moved to CurrentConfig to avoid scattered state - 注意：mode 已移至 CurrentConfig 管理，避免状态分散
}

// Create interactive context - 创建交互式上下文
export async function createInteractiveContext(options: {
  sessionId?: string;
  gitRoot?: string;
  runtimeInfo?: KodaXSessionRuntimeInfo;
  existingMessages?: KodaXMessage[];
  existingUiHistory?: KodaXSessionUiHistoryItem[];
  existingLineage?: KodaXSessionLineage;
  existingArtifactLedger?: KodaXSessionArtifactLedgerEntry[];
  existingExtensionState?: KodaXExtensionSessionState;
  existingExtensionRecords?: KodaXExtensionSessionRecord[];
}): Promise<InteractiveContext> {
  const artifactLedger = options.existingArtifactLedger?.map((entry) => ({
    ...entry,
    metadata: entry.metadata ? { ...entry.metadata } : undefined,
  }));
  return {
    messages: options.existingMessages ?? [],
    uiHistory: options.existingUiHistory?.map((item) => ({ ...item })),
    lineage: options.existingLineage ?? undefined,
    artifactLedger,
    extensionState: options.existingExtensionState
      ? structuredClone(options.existingExtensionState)
      : undefined,
    extensionRecords: options.existingExtensionRecords?.map((record) => ({ ...record })),
    extensionStateDirty: false,
    extensionRecordsDirty: false,
    sessionSnapshotDirty: false,
    sessionId: options.sessionId ?? generateSessionId(),
    title: '',
    gitRoot: options.gitRoot,
    runtimeInfo: options.runtimeInfo,
    createdAt: new Date().toISOString(),
    lastAccessed: new Date().toISOString(),
  };
}

// Generate session ID - 生成会话 ID
export function generateSessionId(): string {
  return generateSessionIdSync();
}

// Update context access time - 更新上下文访问时间
export function touchContext(context: InteractiveContext): void {
  context.lastAccessed = new Date().toISOString();
}
