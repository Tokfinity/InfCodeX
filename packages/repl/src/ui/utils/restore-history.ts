import type {
  KodaXMessage,
  KodaXSessionUiHistoryItem,
} from "@kodax-ai/agent";
import type { CreatableHistoryItem } from "../types.js";
import {
  extractHistorySeedsFromMessages,
  seedToHistoryItem,
  toolCallSeedToHistoryToolCall,
} from "./message-utils.js";

const MAX_PERSISTED_UI_HISTORY_ITEMS = 150;
const MAX_PERSISTED_UI_HISTORY_ROUNDS = 50;

export interface RestoreHistoryItemsFromSessionInput {
  messages: readonly KodaXMessage[];
  uiHistory?: readonly KodaXSessionUiHistoryItem[];
}

export function trimPersistedUiHistorySnapshot(
  items: readonly KodaXSessionUiHistoryItem[],
): KodaXSessionUiHistoryItem[] {
  if (items.length === 0) {
    return [];
  }

  const userIndices: number[] = [];
  for (let index = 0; index < items.length; index += 1) {
    if (items[index]?.type === "user") {
      userIndices.push(index);
    }
  }

  let trimmed = [...items];
  if (userIndices.length > MAX_PERSISTED_UI_HISTORY_ROUNDS) {
    const startIndex = userIndices[userIndices.length - MAX_PERSISTED_UI_HISTORY_ROUNDS] ?? 0;
    trimmed = items.slice(startIndex);
  }

  if (trimmed.length > MAX_PERSISTED_UI_HISTORY_ITEMS) {
    const windowed = trimmed.slice(-MAX_PERSISTED_UI_HISTORY_ITEMS);
    const firstUserIndex = windowed.findIndex((item) => item.type === "user");
    trimmed = firstUserIndex > 0 ? windowed.slice(firstUserIndex) : windowed;
  }

  return [...trimmed];
}

export function normalizePersistedUiHistory(
  items: readonly KodaXSessionUiHistoryItem[] | undefined,
): KodaXSessionUiHistoryItem[] | undefined {
  if (!items) {
    return undefined;
  }

  return trimPersistedUiHistorySnapshot(items);
}

function toCreatableTextHistoryItem(
  item: Exclude<KodaXSessionUiHistoryItem, { type: "tool_group" }>,
): CreatableHistoryItem {
  switch (item.type) {
    case "assistant":
      return {
        type: "assistant",
        text: item.text,
        ...(item.compactText ? { compactText: item.compactText } : {}),
      };
    case "thinking":
      return {
        type: "thinking",
        text: item.text,
        ...(item.compactText ? { compactText: item.compactText } : {}),
      };
    case "event":
      return {
        type: "event",
        text: item.text,
        ...(item.icon ? { icon: item.icon } : {}),
        ...(item.compactText ? { compactText: item.compactText } : {}),
      };
    case "info":
      return {
        type: "info",
        text: item.text,
        ...(item.icon ? { icon: item.icon } : {}),
        ...(item.compactText ? { compactText: item.compactText } : {}),
      };
    case "user":
      return { type: "user", text: item.text };
    case "system":
      return { type: "system", text: item.text };
    case "error":
      return { type: "error", text: item.text };
    case "hint":
      return { type: "hint", text: item.text };
    case "sidecar": {
      // The icon slot carries the encoded verdict/delivery (see toPersistedUiHistoryItem).
      const encoded = item.icon;
      if (encoded === "budget-exhausted") {
        return { type: "sidecar", text: item.text, delivery: "budget-exhausted" };
      }
      const verdict = encoded === "blocked" ? "blocked" : "revise";
      return { type: "sidecar", text: item.text, verdict };
    }
  }
}

function persistedUiHistoryItemToCreatableHistoryItem(
  item: KodaXSessionUiHistoryItem,
): CreatableHistoryItem | undefined {
  if (item.type !== "tool_group") {
    return toCreatableTextHistoryItem(item);
  }

  const tools = item.tools.map(toolCallSeedToHistoryToolCall);
  return tools.length > 0 ? { type: "tool_group", tools } : undefined;
}

function splitCreatableHistoryRounds(
  items: readonly CreatableHistoryItem[],
): CreatableHistoryItem[][] {
  const rounds: CreatableHistoryItem[][] = [];
  let current: CreatableHistoryItem[] = [];

  for (const item of items) {
    if (item.type === "user" && current.length > 0) {
      rounds.push(current);
      current = [];
    }
    current.push(item);
  }

  if (current.length > 0) {
    rounds.push(current);
  }
  return rounds;
}

function roundHasToolGroup(round: readonly CreatableHistoryItem[]): boolean {
  return round.some((item) => item.type === "tool_group");
}

function isLegacyToolSummaryItem(item: CreatableHistoryItem): boolean {
  return item.type === "event" && item.icon === "tool";
}

function insertDerivedToolGroupsIntoRound(
  persistedRound: readonly CreatableHistoryItem[],
  derivedToolGroups: readonly Extract<CreatableHistoryItem, { type: "tool_group" }>[],
): CreatableHistoryItem[] {
  if (derivedToolGroups.length === 0 || roundHasToolGroup(persistedRound)) {
    return [...persistedRound];
  }

  const round = persistedRound.filter((item) => !isLegacyToolSummaryItem(item));
  let lastThinkingIndex = -1;
  for (let index = round.length - 1; index >= 0; index -= 1) {
    if (round[index]?.type === "thinking") {
      lastThinkingIndex = index;
      break;
    }
  }
  const firstAssistantIndex = round.findIndex((item) => item.type === "assistant");
  const insertIndex = lastThinkingIndex >= 0
    ? lastThinkingIndex + 1
    : firstAssistantIndex >= 0
      ? firstAssistantIndex
      : round.length;

  return [
    ...round.slice(0, insertIndex),
    ...derivedToolGroups,
    ...round.slice(insertIndex),
  ];
}

function enrichTextOnlyUiHistory(
  persistedItems: readonly CreatableHistoryItem[],
  derivedItems: readonly CreatableHistoryItem[],
): CreatableHistoryItem[] {
  const derivedToolGroups = derivedItems.filter(
    (item): item is Extract<CreatableHistoryItem, { type: "tool_group" }> => item.type === "tool_group",
  );
  if (derivedToolGroups.length === 0) {
    return [...persistedItems];
  }

  const persistedRounds = splitCreatableHistoryRounds(persistedItems);
  const derivedRounds = splitCreatableHistoryRounds(derivedItems);
  const offset = Math.max(0, derivedRounds.length - persistedRounds.length);

  return persistedRounds.flatMap((round, index) => {
    const derivedRound = derivedRounds[index + offset] ?? [];
    const roundToolGroups = derivedRound.filter(
      (item): item is Extract<CreatableHistoryItem, { type: "tool_group" }> => item.type === "tool_group",
    );
    return insertDerivedToolGroupsIntoRound(round, roundToolGroups);
  });
}

export function restoreHistoryItemsFromSession(
  input: RestoreHistoryItemsFromSessionInput,
): CreatableHistoryItem[] {
  const derivedItems = extractHistorySeedsFromMessages(input.messages).map(seedToHistoryItem);
  const persistedHistory = normalizePersistedUiHistory(input.uiHistory);
  if (!persistedHistory || persistedHistory.length === 0) {
    return derivedItems;
  }

  const persistedItems = persistedHistory
    .map(persistedUiHistoryItemToCreatableHistoryItem)
    .filter((item): item is CreatableHistoryItem => Boolean(item));

  return enrichTextOnlyUiHistory(persistedItems, derivedItems);
}
