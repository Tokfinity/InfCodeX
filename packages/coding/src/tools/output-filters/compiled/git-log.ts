import { outputMatches } from '../detect.js';
import { changedResult, joinLines, splitLines } from '../helpers.js';
import type { BashOutputFilterInput, FilterResult } from '../types.js';

function isGitLog(input: BashOutputFilterInput): boolean {
  return /(?:^|\s)git\s+(?:log|reflog)\b/i.test(input.command)
    || outputMatches(input, /(?:^|\n)(?:commit [0-9a-f]{7,40}|[0-9a-f]{7,40}\s+\S)/i);
}

export function filterGitLog(input: BashOutputFilterInput): FilterResult {
  if (!isGitLog(input)) return input;

  const lines = splitLines(input.stdout);
  if (lines.length <= 40) return input;

  const shown = lines.slice(0, 30);
  return changedResult(
    input,
    joinLines([
      `[git log summarized: showing ${shown.length} of ${lines.length} lines]`,
      ...shown,
    ]),
    input.stderr,
    'tail',
    '[Bash output compressed by git-log.]',
  );
}
