import type {
  KodaXExtensionSessionRecord,
  KodaXExtensionSessionState,
  KodaXMessage,
  KodaXSessionArtifactLedgerEntry,
  KodaXSessionData,
  KodaXSessionLineage,
  KodaXSessionRuntimeInfo,
  KodaXSessionUiHistoryItem,
} from '@kodax-ai/agent';

interface HostSessionPayloadInput {
  messages: KodaXMessage[];
  title: string;
  gitRoot?: string;
  runtimeInfo?: KodaXSessionRuntimeInfo;
  tag?: string;
  uiHistory?: KodaXSessionUiHistoryItem[];
  lineage?: KodaXSessionLineage;
  artifactLedger?: KodaXSessionArtifactLedgerEntry[];
  extensionState?: KodaXExtensionSessionState;
  extensionRecords?: KodaXExtensionSessionRecord[];
}

export function buildHostSessionPayload(input: HostSessionPayloadInput): KodaXSessionData {
  return {
    messages: input.messages,
    title: input.title,
    gitRoot: input.gitRoot ?? '',
    ...(input.runtimeInfo !== undefined ? { runtimeInfo: input.runtimeInfo } : {}),
    ...(input.tag !== undefined ? { tag: input.tag } : {}),
    ...(input.uiHistory !== undefined ? { uiHistory: input.uiHistory } : {}),
    ...(input.lineage !== undefined ? { lineage: input.lineage } : {}),
    ...(input.artifactLedger !== undefined ? { artifactLedger: input.artifactLedger } : {}),
    ...(input.extensionState !== undefined ? { extensionState: input.extensionState } : {}),
    ...(input.extensionRecords !== undefined ? { extensionRecords: input.extensionRecords } : {}),
  };
}
