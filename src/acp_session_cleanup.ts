import type { KodaXSessionData } from '@kodax-ai/agent';
import { FileSessionStorage } from '@kodax-ai/repl';

export interface AcpPollutionCandidate {
  readonly id: string;
  readonly createdAt?: string;
}

export function isAcpPollutionSession(data: KodaXSessionData): boolean {
  return data.scope !== 'managed-task-worker'
    && data.title === 'ACP Session'
    && data.runtimeInfo?.surface === 'acp'
    && data.messages.length === 0
    && (data.uiHistory?.length ?? 0) === 0
    && (data.lineage?.entries.length ?? 0) === 0
    && (data.artifactLedger?.length ?? 0) === 0
    && (data.extensionRecords?.length ?? 0) === 0
    && data.extensionState === undefined
    && data.errorMetadata === undefined;
}

export async function findAcpPollutionCandidates(
  storage: FileSessionStorage,
  limit = 10_000,
): Promise<AcpPollutionCandidate[]> {
  const summaries = await storage.list(undefined, { limit });
  const candidates: AcpPollutionCandidate[] = [];
  for (const summary of summaries) {
    if (
      summary.title !== 'ACP Session'
      || summary.msgCount !== 0
      || summary.runtimeInfo?.surface !== 'acp'
    ) {
      continue;
    }
    const data = await storage.load(summary.id);
    if (data && isAcpPollutionSession(data)) {
      candidates.push({
        id: summary.id,
        ...(summary.createdAt !== undefined ? { createdAt: summary.createdAt } : {}),
      });
    }
  }
  return candidates;
}

export async function archiveAcpPollutionCandidates(
  storage: FileSessionStorage,
  candidates: readonly AcpPollutionCandidate[],
): Promise<string[]> {
  const archived: string[] = [];
  for (const candidate of candidates) {
    if (await storage.archive(candidate.id)) archived.push(candidate.id);
  }
  return archived;
}
