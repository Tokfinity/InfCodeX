import { commandMatches, outputMatches } from '../detect.js';
import { changedResult, joinLines, splitLines } from '../helpers.js';
import type { BashOutputFilterInput, FilterResult } from '../types.js';

interface DiffFileSummary {
  path: string;
  additions: number;
  deletions: number;
  hunks: number;
  flags: string[];
}

function isGitDiff(input: BashOutputFilterInput): boolean {
  return /(?:^|\s)git\s+(?:diff|show)\b/i.test(input.command) || outputMatches(input, /(?:^|\n)diff --git /);
}

function parseDiffFiles(text: string): DiffFileSummary[] {
  const files: DiffFileSummary[] = [];
  let current: DiffFileSummary | undefined;

  for (const line of splitLines(text)) {
    const header = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (header) {
      current = {
        path: header[2] ?? header[1] ?? 'unknown',
        additions: 0,
        deletions: 0,
        hunks: 0,
        flags: [],
      };
      files.push(current);
      continue;
    }
    if (!current) continue;

    if (line.startsWith('new file mode')) {
      current.flags.push('new');
    } else if (line.startsWith('deleted file mode')) {
      current.flags.push('deleted');
    } else if (line.startsWith('rename from') || line.startsWith('rename to')) {
      if (!current.flags.includes('renamed')) current.flags.push('renamed');
    } else if (line.startsWith('Binary files ')) {
      current.flags.push('binary');
    } else if (line.startsWith('@@')) {
      current.hunks++;
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      current.additions++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      current.deletions++;
    }
  }

  return files;
}

function formatFile(file: DiffFileSummary): string {
  const hunkLabel = file.hunks === 1 ? '1 hunk' : `${file.hunks} hunks`;
  const extras = [hunkLabel, ...file.flags].filter(Boolean).join(', ');
  return `- ${file.path} (+${file.additions} -${file.deletions}${extras ? `, ${extras}` : ''})`;
}

export function filterGitDiff(input: BashOutputFilterInput): FilterResult {
  if (!isGitDiff(input)) return input;

  const files = parseDiffFiles(input.stdout);
  if (files.length === 0) return input;

  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const shown = files.slice(0, 80);
  const omitted = files.length - shown.length;
  const lines = [
    `[git diff summarized: ${files.length} files, +${additions} -${deletions}]`,
    ...shown.map(formatFile),
  ];
  if (omitted > 0) {
    lines.push(`[... ${omitted} files omitted ...]`);
  }

  return changedResult(
    input,
    joinLines(lines),
    input.stderr,
    'whole',
    '[Bash output compressed by git-diff.]',
  );
}
