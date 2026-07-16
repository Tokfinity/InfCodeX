import { outputMatches } from '../detect.js';
import { changedResult, joinLines, splitLines, uniqueInOrder } from '../helpers.js';
import type { BashOutputFilterInput, FilterResult } from '../types.js';

const LINT_COMMAND = /\b(?:eslint|tsc|biome|ruff|mypy|clippy)\b/i;
const DIAGNOSTIC_LINE = /(?:\berror\b|\bwarning\b|TS\d{4}|[.:]\d+:\d+)/i;
const SUMMARY_LINE = /(?:problem|errors?|warnings?|Found \d+|failed with|\u2716)/i;

function isLintOutput(input: BashOutputFilterInput): boolean {
  return LINT_COMMAND.test(input.command) || outputMatches(input, /(?:TS\d{4}|\u2716 \d+ problems?|error\s{2,})/i);
}

function compressLintText(text: string): string {
  const lines = splitLines(text);
  if (lines.length <= 80) return text;

  const kept: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    if (DIAGNOSTIC_LINE.test(line)) {
      const previous = lines[index - 1];
      if (previous && previous.trim() && !DIAGNOSTIC_LINE.test(previous)) {
        kept.push(previous);
      }
      kept.push(line);
      continue;
    }
    if (SUMMARY_LINE.test(line)) {
      kept.push(line);
    }
  }

  const body = kept.length > 0 ? uniqueInOrder(kept).slice(0, 220) : lines.slice(-80);
  if (body.length >= lines.length) return text;

  return joinLines([
    `[lint output summarized: showing ${body.length} of ${lines.length} lines]`,
    ...body,
  ]);
}

export function filterLint(input: BashOutputFilterInput): FilterResult {
  if (!isLintOutput(input)) return input;

  return changedResult(
    input,
    compressLintText(input.stdout),
    compressLintText(input.stderr),
    'tail',
    '[Bash output compressed by lint.]',
  );
}
