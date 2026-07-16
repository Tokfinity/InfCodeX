import { commandMatches } from './detect.js';
import { BUILT_IN_LINE_FILTERS } from './filters.data.js';
import { changedResult, joinLines, splitLines } from './helpers.js';
import type { BashOutputFilterInput, FilterResult } from './types.js';

export interface LineFilterRule {
  id: string;
  commandPattern?: RegExp;
  contentPattern?: RegExp;
  filterStderr?: boolean;
  stripLinesMatching?: readonly RegExp[];
  keepLinesMatching?: readonly RegExp[];
  headLines?: number;
  tailLines?: number;
  maxLines?: number;
  truncateLinesAt?: number;
  onEmpty?: string;
}

interface TextFilterResult {
  text: string;
  changed: boolean;
}

function ruleMatches(input: BashOutputFilterInput, rule: LineFilterRule): boolean {
  const commandMatch = rule.commandPattern ? commandMatches(input, rule.commandPattern) : false;
  const body = `${input.stdout}\n${input.stderr}`;
  const contentMatch = rule.contentPattern ? rule.contentPattern.test(body) : false;
  if (rule.commandPattern && !commandMatch) return false;
  if (rule.contentPattern && !contentMatch) return false;
  return Boolean(rule.commandPattern || rule.contentPattern);
}

function lineMatchesAny(line: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(line));
}

function truncateLine(line: string, maxChars: number): string {
  return line.length > maxChars ? `${line.slice(0, maxChars)}... [line truncated]` : line;
}

function applyLineRule(text: string, rule: LineFilterRule): TextFilterResult {
  if (!text) return { text, changed: false };

  const originalLines = splitLines(text);
  let lines = originalLines;

  if (rule.stripLinesMatching && rule.stripLinesMatching.length > 0) {
    lines = lines.filter((line) => !lineMatchesAny(line, rule.stripLinesMatching ?? []));
  }
  if (rule.keepLinesMatching && rule.keepLinesMatching.length > 0) {
    lines = lines.filter((line) => lineMatchesAny(line, rule.keepLinesMatching ?? []));
  }
  if (rule.truncateLinesAt) {
    lines = lines.map((line) => truncateLine(line, rule.truncateLinesAt ?? line.length));
  }
  if (rule.maxLines && lines.length > rule.maxLines) {
    const headCount = Math.min(rule.headLines ?? Math.floor(rule.maxLines / 2), rule.maxLines);
    const tailCount = Math.max(0, Math.min(rule.tailLines ?? rule.maxLines - headCount, rule.maxLines - headCount));
    const omitted = lines.length - headCount - tailCount;
    lines = [
      ...lines.slice(0, headCount),
      `[... ${omitted} lines omitted by ${rule.id} ...]`,
      ...lines.slice(lines.length - tailCount),
    ];
  }

  if (lines.length === 0 && originalLines.length > 0) {
    lines = [rule.onEmpty ?? `[${rule.id} output removed]`];
  }

  const filtered = joinLines(lines);
  return {
    text: filtered,
    changed: filtered !== text,
  };
}

export function applyDeclarativeOutputFilters(
  input: BashOutputFilterInput,
  rules: readonly LineFilterRule[] = BUILT_IN_LINE_FILTERS,
): FilterResult {
  let current: BashOutputFilterInput = input;
  for (const rule of rules) {
    if (!ruleMatches(current, rule)) continue;

    const stdout = applyLineRule(current.stdout, rule);
    const stderr = rule.filterStderr ? applyLineRule(current.stderr, rule) : { text: current.stderr, changed: false };
    const next = changedResult(
      current,
      stdout.text,
      stderr.text,
      'tail',
      `[Bash output compressed by ${rule.id}.]`,
    );
    current = { ...next, command: input.command };
  }

  return {
    stdout: current.stdout,
    stderr: current.stderr,
    lossiness: current.lossiness,
    note: current.note,
  };
}
