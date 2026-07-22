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
  const timestamp = item.timestamp === undefined ? {} : { timestamp: item.timestamp };
  switch (item.type) {
    case "assistant":
      return {
        type: "assistant",
        text: item.text,
        ...timestamp,
        ...(item.compactText ? { compactText: item.compactText } : {}),
      };
    case "thinking":
      return {
        type: "thinking",
        text: item.text,
        ...timestamp,
        ...(item.compactText ? { compactText: item.compactText } : {}),
      };
    case "event":
      return {
        type: "event",
        text: item.text,
        ...timestamp,
        ...(item.icon ? { icon: item.icon } : {}),
        ...(item.compactText ? { compactText: item.compactText } : {}),
      };
    case "info":
      return {
        type: "info",
        text: item.text,
        ...timestamp,
        ...(item.icon ? { icon: item.icon } : {}),
        ...(item.compactText ? { compactText: item.compactText } : {}),
      };
    case "user":
      return { type: "user", text: item.text, ...timestamp };
    case "system":
      return { type: "system", text: item.text, ...timestamp };
    case "error":
      return { type: "error", text: item.text, ...timestamp };
    case "hint":
      return { type: "hint", text: item.text, ...timestamp };
    case "sidecar": {
      // The icon slot carries the encoded verdict/delivery (see toPersistedUiHistoryItem).
      const encoded = item.icon;
      if (encoded === "budget-exhausted") {
        return { type: "sidecar", text: item.text, delivery: "budget-exhausted", ...timestamp };
      }
      const verdict = encoded === "blocked" ? "blocked" : "revise";
      return { type: "sidecar", text: item.text, verdict, ...timestamp };
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
  return tools.length > 0
    ? {
        type: "tool_group",
        tools,
        ...(item.timestamp === undefined ? {} : { timestamp: item.timestamp }),
      }
    : undefined;
}

function dedupePersistedToolGroups(
  items: readonly CreatableHistoryItem[],
): CreatableHistoryItem[] {
  const seenToolIds = new Set<string>();
  const result: CreatableHistoryItem[] = [];
  for (const item of items) {
    if (item.type !== "tool_group") {
      result.push(item);
      continue;
    }
    const tools = item.tools.filter((tool) => {
      if (seenToolIds.has(tool.id)) return false;
      seenToolIds.add(tool.id);
      return true;
    });
    if (tools.length > 0) result.push({ ...item, tools });
  }
  return result;
}

function matchesTimestampSource(
  item: CreatableHistoryItem,
  candidate: CreatableHistoryItem,
): boolean {
  if (item.type !== candidate.type) return false;
  if (item.type === "tool_group" && candidate.type === "tool_group") {
    return item.tools.map((tool) => tool.id).join("\n")
      === candidate.tools.map((tool) => tool.id).join("\n");
  }
  if (item.type === "tool_group" || candidate.type === "tool_group") return false;
  const itemText = item.text.trim();
  const candidateText = candidate.text.trim();
  return itemText === candidateText
    || hasDisplayPrefix(itemText, candidateText)
    || hasDisplayPrefix(candidateText, itemText);
}

function hasDisplayPrefix(displayText: string, sourceText: string): boolean {
  if (!displayText.endsWith(sourceText)) return false;
  const prefix = displayText.slice(0, -sourceText.length);
  return /^\[[^\]\r\n]+\]\s+$/.test(prefix);
}

function recoverMissingTimestamps(
  items: readonly CreatableHistoryItem[],
  derivedItems: readonly CreatableHistoryItem[],
): CreatableHistoryItem[] {
  let derivedCursor = 0;
  return items.map((item) => {
    if (item.timestamp !== undefined) return item;
    for (let index = derivedCursor; index < derivedItems.length; index += 1) {
      const candidate = derivedItems[index];
      if (candidate?.timestamp === undefined || !matchesTimestampSource(item, candidate)) continue;
      derivedCursor = index + 1;
      return { ...item, timestamp: candidate.timestamp };
    }
    return item;
  });
}

function alignCanonicalTextItems(
  persistedItems: readonly CreatableHistoryItem[],
  derivedItems: readonly CreatableHistoryItem[],
): ReadonlyMap<number, number> {
  const anchors = new Map<number, number>();
  let persistedCursor = persistedItems.length - 1;
  // uiHistory can be a bounded suffix of the canonical transcript. Match
  // backwards so repeated queries/answers bind to their latest canonical
  // occurrence instead of resurrecting tool groups from an older round.
  for (let derivedIndex = derivedItems.length - 1; derivedIndex >= 0; derivedIndex -= 1) {
    const derived = derivedItems[derivedIndex];
    if (!derived || derived.type === "tool_group") continue;
    for (let index = persistedCursor; index >= 0; index -= 1) {
      const persisted = persistedItems[index];
      if (!persisted || persisted.type === "tool_group") continue;
      if (!matchesTimestampSource(persisted, derived)) continue;
      anchors.set(derivedIndex, index);
      persistedCursor = index - 1;
      break;
    }
  }
  return anchors;
}

function previousAnchor(
  anchors: ReadonlyMap<number, number>,
  derivedIndex: number,
): number | undefined {
  for (let index = derivedIndex - 1; index >= 0; index -= 1) {
    const anchor = anchors.get(index);
    if (anchor !== undefined) return anchor;
  }
  return undefined;
}

function nextAnchor(
  anchors: ReadonlyMap<number, number>,
  derivedIndex: number,
  derivedLength: number,
): number | undefined {
  for (let index = derivedIndex + 1; index < derivedLength; index += 1) {
    const anchor = anchors.get(index);
    if (anchor !== undefined) return anchor;
  }
  return undefined;
}

function enrichPersistedUiHistory(
  persistedItems: readonly CreatableHistoryItem[],
  derivedItems: readonly CreatableHistoryItem[],
): CreatableHistoryItem[] {
  const anchors = alignCanonicalTextItems(persistedItems, derivedItems);
  const insertions = new Map<number, Extract<CreatableHistoryItem, { type: "tool_group" }>[]>();
  const persistedTools = new Map<string, {
    tool: Extract<CreatableHistoryItem, { type: "tool_group" }>["tools"][number];
    timestamp?: number;
  }>();
  for (const item of persistedItems) {
    if (item.type !== "tool_group") continue;
    for (const tool of item.tools) {
      if (!persistedTools.has(tool.id)) {
        persistedTools.set(tool.id, { tool, timestamp: item.timestamp });
      }
    }
  }
  const positionedToolIds = new Set<string>();
  const anchoredPersistedIndices = new Set(anchors.values());
  const legacyToolSummaryIndices = new Set<number>();

  for (let index = 0; index < derivedItems.length; index += 1) {
    const item = derivedItems[index];
    if (!item || item.type !== "tool_group") continue;
    const tools = item.tools.filter((tool) => {
      if (positionedToolIds.has(tool.id)) return false;
      positionedToolIds.add(tool.id);
      return true;
    }).map((tool) => persistedTools.get(tool.id)?.tool ?? tool);
    const before = previousAnchor(anchors, index);
    if (before === undefined || tools.length === 0) {
      for (const tool of tools) positionedToolIds.delete(tool.id);
      continue;
    }
    const after = nextAnchor(anchors, index, derivedItems.length);
    const boundary = after !== undefined && after > before ? after : before + 1;
    const legacySearchEnd = after ?? persistedItems.findIndex((candidate, candidateIndex) => (
      candidateIndex > before && candidate.type === "user"
    ));
    const boundedLegacySearchEnd = legacySearchEnd < 0 ? persistedItems.length : legacySearchEnd;
    for (let persistedIndex = before + 1; persistedIndex < boundedLegacySearchEnd; persistedIndex += 1) {
      const candidate = persistedItems[persistedIndex];
      if (
        candidate?.type === "event"
        && candidate.icon === "tool"
        && !anchoredPersistedIndices.has(persistedIndex)
      ) {
        legacyToolSummaryIndices.add(persistedIndex);
      }
    }
    const groups = insertions.get(boundary) ?? [];
    const persistedTimestamp = tools
      .map((tool) => persistedTools.get(tool.id)?.timestamp)
      .find((timestamp) => timestamp !== undefined);
    groups.push({
      ...item,
      tools,
      ...(persistedTimestamp === undefined ? {} : { timestamp: persistedTimestamp }),
    });
    insertions.set(boundary, groups);
  }

  const merged: CreatableHistoryItem[] = [];
  for (let boundary = 0; boundary <= persistedItems.length; boundary += 1) {
    merged.push(...(insertions.get(boundary) ?? []));
    const persisted = persistedItems[boundary];
    if (!persisted) continue;
    if (legacyToolSummaryIndices.has(boundary)) continue;
    if (persisted.type !== "tool_group") {
      merged.push(persisted);
      continue;
    }
    const tools = persisted.tools.filter((tool) => !positionedToolIds.has(tool.id));
    if (tools.length > 0) merged.push({ ...persisted, tools });
  }
  return recoverMissingTimestamps(merged, derivedItems);
}

export function restoreHistoryItemsFromSession(
  input: RestoreHistoryItemsFromSessionInput,
): CreatableHistoryItem[] {
  const derivedItems = extractHistorySeedsFromMessages(input.messages).map(seedToHistoryItem);
  const persistedHistory = normalizePersistedUiHistory(input.uiHistory);
  if (!persistedHistory || persistedHistory.length === 0) {
    return derivedItems;
  }

  const persistedItems = dedupePersistedToolGroups(persistedHistory
    .map(persistedUiHistoryItemToCreatableHistoryItem)
    .filter((item): item is CreatableHistoryItem => Boolean(item)));

  return enrichPersistedUiHistory(persistedItems, derivedItems);
}
