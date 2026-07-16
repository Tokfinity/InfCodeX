import { outputMatches } from '../detect.js';
import { changedResult, joinLines, splitLines } from '../helpers.js';
import type { BashOutputFilterInput, FilterResult } from '../types.js';

interface StatusItem {
  code: string;
  path: string;
}

function isGitStatus(input: BashOutputFilterInput): boolean {
  return /(?:^|\s)git\s+status\b/i.test(input.command)
    || outputMatches(input, /(?:^|\n)(?:On branch |Changes to be committed:|Changes not staged for commit:|Untracked files:)/);
}

function addItem(items: StatusItem[], code: string, path: string): void {
  const trimmedPath = path.trim();
  if (!trimmedPath || trimmedPath.startsWith('(')) return;
  items.push({ code, path: trimmedPath });
}

function parsePorcelain(lines: readonly string[]): StatusItem[] {
  const items: StatusItem[] = [];
  for (const line of lines) {
    const match = line.match(/^([ MADRCU?!]{2})\s+(.+)$/);
    if (!match) continue;
    addItem(items, (match[1] ?? '').trim() || 'changed', match[2] ?? '');
  }
  return items;
}

function parseHuman(lines: readonly string[]): { branch: string | undefined; items: StatusItem[] } {
  const items: StatusItem[] = [];
  let branch: string | undefined;
  let inUntracked = false;

  for (const line of lines) {
    const branchMatch = line.match(/^On branch (.+)$/);
    if (branchMatch) {
      branch = `On branch ${branchMatch[1]}`;
      continue;
    }

    if (/^Untracked files:/.test(line)) {
      inUntracked = true;
      continue;
    }
    if (/^(Changes|no changes|nothing to commit)/i.test(line)) {
      inUntracked = false;
    }

    const statusMatch = line.match(/^\s*(modified|new file|deleted|renamed|both modified|both added):\s+(.+)$/);
    if (statusMatch) {
      addItem(items, statusMatch[1] ?? 'changed', statusMatch[2] ?? '');
      continue;
    }

    if (inUntracked) {
      const untracked = line.match(/^\s+([^\s(].+)$/);
      if (untracked) addItem(items, 'untracked', untracked[1] ?? '');
    }
  }

  return { branch, items };
}

function groupItems(items: readonly StatusItem[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const item of items) {
    const paths = groups.get(item.code) ?? [];
    paths.push(item.path);
    groups.set(item.code, paths);
  }
  return groups;
}

function renderStatusSummary(branch: string | undefined, items: readonly StatusItem[]): string {
  const lines = [`[git status summarized: ${items.length} paths]`];
  if (branch) lines.push(branch);
  const groups = groupItems(items);
  for (const [code, paths] of groups) {
    lines.push(`${code}: ${paths.length}`);
    for (const path of paths.slice(0, 20)) {
      lines.push(`  - ${path}`);
    }
    if (paths.length > 20) {
      lines.push(`  [... ${paths.length - 20} more ...]`);
    }
  }
  return joinLines(lines);
}

export function filterGitStatus(input: BashOutputFilterInput): FilterResult {
  if (!isGitStatus(input)) return input;

  const lines = splitLines(input.stdout);
  const porcelain = parsePorcelain(lines);
  const parsed = porcelain.length > 0 ? { branch: undefined, items: porcelain } : parseHuman(lines);
  if (parsed.items.length === 0) return input;

  return changedResult(
    input,
    renderStatusSummary(parsed.branch, parsed.items),
    input.stderr,
    'tail',
    '[Bash output compressed by git-status.]',
  );
}
