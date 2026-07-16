import { changedResult, joinLines, splitLines } from '../helpers.js';
import type { BashOutputFilterInput, FilterResult } from '../types.js';

const JSON_COMMAND = /\b(?:aws|kubectl|jq|curl|gh|az|gcloud)\b/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function valueKind(value: unknown): string {
  if (Array.isArray(value)) return `array length=${value.length}`;
  if (isRecord(value)) return `object keys=${Object.keys(value).length}`;
  if (value === null) return 'null';
  return typeof value;
}

function summarizeValue(value: unknown, depth: number): string[] {
  if (Array.isArray(value)) {
    const lines = [`array length=${value.length}`];
    const first = value[0];
    if (first !== undefined && depth < 2) {
      lines.push(`first: ${valueKind(first)}`);
      lines.push(...summarizeValue(first, depth + 1).map((line) => `  ${line}`));
    }
    return lines;
  }

  if (isRecord(value)) {
    const entries = Object.entries(value);
    const lines = [`object keys=${entries.length}`];
    for (const [key, child] of entries.slice(0, 20)) {
      lines.push(`- ${key}: ${valueKind(child)}`);
    }
    if (entries.length > 20) {
      lines.push(`- ... ${entries.length - 20} more keys`);
    }
    return lines;
  }

  return [valueKind(value)];
}

function parseNdjson(lines: readonly string[]): unknown[] | undefined {
  const parsed: unknown[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      parsed.push(JSON.parse(line) as unknown);
    } catch {
      return undefined;
    }
  }
  return parsed.length > 1 ? parsed : undefined;
}

function summarizeJsonText(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  try {
    const parsed: unknown = JSON.parse(trimmed);
    return joinLines([
      '[json output summarized]',
      ...summarizeValue(parsed, 0),
    ]);
  } catch {
    const ndjson = parseNdjson(splitLines(text));
    if (!ndjson) return undefined;
    return joinLines([
      '[ndjson output summarized]',
      `records=${ndjson.length}`,
      ...summarizeValue(ndjson[0], 0).map((line) => `first: ${line}`),
    ]);
  }
}

export function filterJsonOutput(input: BashOutputFilterInput): FilterResult {
  if (!JSON_COMMAND.test(input.command)) return input;
  if (input.stdout.length < 2048 && splitLines(input.stdout).length < 80) return input;

  const summarized = summarizeJsonText(input.stdout);
  if (!summarized) return input;

  return changedResult(
    input,
    summarized,
    input.stderr,
    'whole',
    '[Bash output compressed by json-output.]',
  );
}
