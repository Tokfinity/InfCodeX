import type { KodaXJsonValue } from "@kodax-ai/agent";

export const TOOL_REPLAY_TEXT_MAX_LENGTH = 2000;
export const TOOL_REPLAY_PREVIEW_MAX_LENGTH = 500;
export const TOOL_REPLAY_JSON_MAX_DEPTH = 6;
export const TOOL_REPLAY_JSON_MAX_ITEMS = 50;
export const TOOL_REPLAY_REDACTED_VALUE = "[redacted]";
export const TOOL_REPLAY_TRUNCATED_VALUE = "[truncated]";

const TRUNCATION_SUFFIX = "...";

export function truncateToolReplayText(
  value: string,
  maxLength = TOOL_REPLAY_TEXT_MAX_LENGTH,
): string {
  return value.length > maxLength
    ? `${value.slice(0, maxLength - TRUNCATION_SUFFIX.length)}${TRUNCATION_SUFFIX}`
    : value;
}

export function isSensitiveToolInputKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[\s_-]/g, "");
  return normalized.includes("token")
    || normalized.includes("password")
    || normalized.includes("secret")
    || normalized.includes("apikey")
    || normalized.includes("accesstoken")
    || normalized === "authorization"
    || normalized === "cookie"
    || normalized === "setcookie";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sanitizeToolJsonValue(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet<object>(),
): KodaXJsonValue {
  if (
    value === null
    || typeof value === "number"
    || typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "string") {
    return truncateToolReplayText(value);
  }

  if (depth >= TOOL_REPLAY_JSON_MAX_DEPTH) {
    return TOOL_REPLAY_TRUNCATED_VALUE;
  }

  if (typeof value === "object" && value !== null) {
    if (seen.has(value)) {
      return TOOL_REPLAY_TRUNCATED_VALUE;
    }
    seen.add(value);

    if (Array.isArray(value)) {
      return value
        .slice(0, TOOL_REPLAY_JSON_MAX_ITEMS)
        .map((item) => sanitizeToolJsonValue(item, depth + 1, seen));
    }

    if (!isRecord(value)) {
      return truncateToolReplayText(String(value));
    }

    const output: { [key: string]: KodaXJsonValue } = {};
    for (const [key, child] of Object.entries(value).slice(0, TOOL_REPLAY_JSON_MAX_ITEMS)) {
      output[key] = isSensitiveToolInputKey(key)
        ? TOOL_REPLAY_REDACTED_VALUE
        : sanitizeToolJsonValue(child, depth + 1, seen);
    }
    return output;
  }

  return truncateToolReplayText(String(value));
}

export function sanitizeToolInput(
  input: Record<string, unknown> | undefined,
): { [key: string]: KodaXJsonValue } | undefined {
  if (!input) {
    return undefined;
  }

  const value = sanitizeToolJsonValue(input);
  return isRecord(value) ? value : undefined;
}

export function stringifyToolReplayValue(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return truncateToolReplayText(value);
  }
  try {
    return truncateToolReplayText(JSON.stringify(value));
  } catch {
    return truncateToolReplayText(String(value));
  }
}
