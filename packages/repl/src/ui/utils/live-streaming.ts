import type { KodaXManagedTaskStatusEvent } from "@kodax-ai/coding";

export function mergeLiveThinkingContent(currentThinking: string, finalThinking: string): string {
  const current = currentThinking.trim();
  const finalText = finalThinking.trim();

  if (!finalText) {
    return currentThinking;
  }
  if (!current) {
    return finalThinking;
  }
  if (currentThinking === finalThinking) {
    return currentThinking;
  }
  if (finalThinking.startsWith(currentThinking)) {
    return finalThinking;
  }
  if (currentThinking.startsWith(finalThinking)) {
    return currentThinking;
  }
  return finalThinking;
}

function trimRepeatedWorkerPrefix(note: string | undefined, workerTitle?: string): string | undefined {
  if (!note) {
    return undefined;
  }
  if (!workerTitle) {
    return note;
  }

  return note.replace(
    new RegExp(`^${workerTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[-: ]*`, "i"),
    "",
  ).trim();
}

export function formatManagedTaskLiveStatusLabel(
  status: KodaXManagedTaskStatusEvent,
): string | undefined {
  const trimmedNote = trimRepeatedWorkerPrefix(status.note, status.activeWorkerTitle);

  if (status.phase === "verifying") {
    const label = `[${status.agentMode.toUpperCase()} Verifying]`;
    return trimmedNote ? `${label} ${trimmedNote}` : label;
  }

  if (status.activeWorkerTitle) {
    if (status.phase === "preflight") {
      // FEATURE_114 v0.7.38 Slice 7 — use the runner-supplied title
      // instead of the V1 hardcoded "Scout". Under V2 the preflight
      // emit carries `activeWorkerTitle: 'Worker'`; this keeps the V1
      // path bit-for-bit ('Scout' in → '[Scout]' out) while letting
      // V2 render `[Worker] analyzing task` correctly.
      return trimmedNote
        ? `[${status.activeWorkerTitle}] ${trimmedNote}`
        : `[Phase] ${status.activeWorkerTitle} preflight`;
    }
    if (status.phase === "routing") {
      return trimmedNote ? `[Routing] ${trimmedNote}` : "[Routing]";
    }
    const prefix = `[Phase] ${status.agentMode.toUpperCase()} ${status.activeWorkerTitle}`;
    return trimmedNote ? `${prefix} - ${trimmedNote}` : prefix;
  }

  if (status.phase === "routing" && trimmedNote) {
    return `[Routing] ${trimmedNote}`;
  }

  if (status.phase === "round" && trimmedNote) {
    return `[Round] ${trimmedNote}`;
  }

  if (status.phase === "preflight") {
    // No activeWorkerTitle on this preflight emit (defensive — runner
    // always supplies one). Keep the V1 fallback string so legacy
    // call sites that omit the title still render something sensible.
    return "[Phase] Scout preflight";
  }

  return undefined;
}

export function formatManagedTaskBreadcrumb(
  status: KodaXManagedTaskStatusEvent,
  options?: { expanded?: boolean },
): string | undefined {
  const note = options?.expanded ? (status.detailNote ?? status.note) : status.note;
  const prefix = status.activeWorkerTitle
    ? `${status.agentMode.toUpperCase()} ${status.activeWorkerTitle}`
    : status.agentMode.toUpperCase();
  // FEATURE_114 v0.7.38 Slice 7 — preflight breadcrumb derives the
  // role label from the runner-supplied title. V1 keeps "AMA Scout";
  // V2 renders "AMA Worker". When the title is missing (legacy
  // breadcrumb call), fall back to "Scout" so existing transcripts
  // don't regress.
  const preflightRole = status.activeWorkerTitle ?? "Scout";
  const preflightPrefix = `${status.agentMode.toUpperCase()} ${preflightRole}`;
  const routingPrefix = `${status.agentMode.toUpperCase()} Routing`;
  const roundSuffix = status.currentRound && status.maxRounds && status.currentRound > 1
    ? ` - Round ${status.currentRound}/${status.maxRounds}`
    : "";

  switch (status.phase) {
    case "routing":
      return `${routingPrefix} - Routing ready`;
    case "starting":
      return note ? `${prefix} - ${note}` : `${prefix} - Managed task starting`;
    case "preflight":
      return note
        ? `${preflightPrefix} - ${note}`
        : `${preflightPrefix} - ${preflightRole} preflight starting`;
    case "round":
      return note ? `${prefix} - ${note}` : `${prefix} - Managed task round update${roundSuffix}`;
    case "worker":
      return note
        ? `${prefix} - ${note}${roundSuffix}`
        : `${prefix} - ${status.activeWorkerTitle ?? "Worker"} starting${roundSuffix}`;
    case "upgrade":
      return note ? `${prefix} - ${note}` : `${prefix} - Harness transition${roundSuffix}`;
    case "verifying":
      return note ? `${status.agentMode.toUpperCase()} Verifying - ${note}` : `${status.agentMode.toUpperCase()} Verifying`;
    case "completed":
      return note ? `${prefix} - ${note}` : `${prefix} - Managed task completed`;
    default:
      return undefined;
  }
}

export function formatSilentIterationToolsSummary(
  iteration: number,
  toolsUsed: string[],
  managedStatus?: Pick<KodaXManagedTaskStatusEvent, "activeWorkerTitle"> | null,
): string {
  const workerPrefix = managedStatus?.activeWorkerTitle
    ? `[${managedStatus.activeWorkerTitle}] `
    : "";
  return `${workerPrefix}Iter ${iteration} tools: ${toolsUsed.join(", ")}`;
}
