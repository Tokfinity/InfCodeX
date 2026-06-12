import type {
  KodaXMessage,
  KodaXSessionArtifactLedgerEntry,
  KodaXSessionData,
  KodaXSessionLineage,
  KodaXSessionUiHistoryItem,
} from '@kodax-ai/agent';

interface HostSessionPayloadInput {
  messages: KodaXMessage[];
  title: string;
  gitRoot?: string;
  tag?: string;
  uiHistory?: KodaXSessionUiHistoryItem[];
  lineage?: KodaXSessionLineage;
  artifactLedger?: KodaXSessionArtifactLedgerEntry[];
}

export function buildHostSessionPayload(input: HostSessionPayloadInput): KodaXSessionData {
  return {
    messages: input.messages,
    title: input.title,
    gitRoot: input.gitRoot ?? '',
    ...(input.tag !== undefined ? { tag: input.tag } : {}),
    ...(input.uiHistory !== undefined ? { uiHistory: input.uiHistory } : {}),
    ...(input.lineage !== undefined ? { lineage: input.lineage } : {}),
    ...(input.artifactLedger !== undefined ? { artifactLedger: input.artifactLedger } : {}),
  };
}
