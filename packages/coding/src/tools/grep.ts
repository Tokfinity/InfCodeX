import fs from 'fs/promises';
import { glob as globAsync } from 'glob';
import type { KodaXToolExecutionContext } from '../types.js';
import { resolveExecutionPathOrCwd } from '../runtime-paths.js';
import { formatSize, persistToolOutput, truncateHead, truncateLine } from './truncate.js';

const MAX_GREP_PATTERN_LENGTH = 256;
const INVALID_OUTPUT_MODES = new Set(['content', 'files_with_matches', 'count']);
const MAX_GREP_FILES = 100;
const MAX_GREP_RESULTS = 200;
const MAX_GREP_OUTPUT_LINES = 400;
const MAX_GREP_OUTPUT_BYTES = 24 * 1024;

function getUnsafeRegexReason(pattern: string): string | null {
  if (!pattern.trim()) {
    return 'Pattern must not be empty';
  }

  if (pattern.length > MAX_GREP_PATTERN_LENGTH) {
    return `Pattern exceeds the ${MAX_GREP_PATTERN_LENGTH}-character safety limit`;
  }

  if (pattern.includes('\0')) {
    return 'Pattern must not contain null bytes';
  }

  if (/\\[1-9]/.test(pattern)) {
    return 'Backreferences are not allowed';
  }

  if (/\(\?<([=!])/.test(pattern) || /\(\?[=!]/.test(pattern)) {
    return 'Lookaround assertions are not allowed';
  }

  if (/\((?:[^()\\]|\\.)*[+*{](?:[^()\\]|\\.)*\)[+*{]/.test(pattern)) {
    return 'Nested quantifiers are not allowed';
  }

  if (/\{(?:\d{4,}|\d+,\d{4,}|\d{4,},\d*)\}/.test(pattern)) {
    return 'Large repetition ranges are not allowed';
  }

  return null;
}

function createSafeRegex(pattern: string, ignoreCase: boolean): RegExp {
  const unsafeReason = getUnsafeRegexReason(pattern);
  if (unsafeReason) {
    throw new Error(`Pattern rejected as potentially unsafe. ${unsafeReason}.`);
  }

  try {
    return new RegExp(pattern, ignoreCase ? 'i' : '');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid regex pattern. ${message}`);
  }
}

async function getPathStat(targetPath: string): Promise<import('node:fs').Stats | null> {
  try {
    return await fs.stat(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function finalizeGrepResults(
  results: string[],
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  const joined = results.join('\n');
  const preview = truncateHead(joined, {
    maxLines: MAX_GREP_OUTPUT_LINES,
    maxBytes: MAX_GREP_OUTPUT_BYTES,
  });

  if (!preview.truncated) {
    return joined;
  }

  let outputPath: string | undefined;
  try {
    outputPath = await persistToolOutput('grep', joined, ctx);
  } catch {
    outputPath = undefined;
  }

  const saved = outputPath ? ` Full output saved to: ${outputPath}.` : '';
  return `${preview.content}\n\n[Grep output truncated: showing ${preview.outputLines} of ${preview.totalLines} lines (${formatSize(preview.outputBytes)} of ${formatSize(preview.totalBytes)}).${saved} Narrow the pattern or path, or switch to files_with_matches/count first.]`;
}

export async function toolGrep(input: Record<string, unknown>, ctx: KodaXToolExecutionContext): Promise<string> {
  const pattern = input.pattern as string;
  const searchPath = (input.path as string) ?? ctx.executionCwd ?? ctx.gitRoot;
  const ignoreCase = (input.ignore_case as boolean) ?? false;
  const outputMode = (input.output_mode as string) ?? 'content';
  const resolvedPath = resolveExecutionPathOrCwd(searchPath, ctx);
  const results: string[] = [];
  let regex: RegExp;

  if (!INVALID_OUTPUT_MODES.has(outputMode)) {
    return `[Tool Error] grep: Unsupported output mode "${outputMode}"`;
  }

  try {
    regex = createSafeRegex(pattern, ignoreCase);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[Tool Error] grep: ${message}`;
  }

  let stat;
  try {
    stat = await getPathStat(resolvedPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[Tool Error] grep: Unable to access "${searchPath}". ${message}`;
  }
  if (!stat) {
    return `[Tool Error] grep: Path not found: ${searchPath}`;
  }

  if (stat.isFile()) {
    try {
      const content = await fs.readFile(resolvedPath, 'utf-8');
      const lines = content.split('\n');
      for (let index = 0; index < lines.length && results.length < MAX_GREP_RESULTS; index++) {
        if (regex.test(lines[index]!)) {
          if (outputMode === 'files_with_matches') {
            results.push(resolvedPath);
            break;
          }
          const matchLine = truncateLine(lines[index]!.trim());
          results.push(`${resolvedPath}:${index + 1}: ${matchLine.text}`);
        }
      }
    } catch {
      // Skip unreadable files and continue with a best-effort search result.
    }
  } else {
    const files = (
      await globAsync('**/*', {
        cwd: resolvedPath,
        nodir: true,
        absolute: true,
        ignore: ['**/node_modules/**', '**/.*'],
      })
    ).slice(0, MAX_GREP_FILES);
    for (const file of files) {
      try {
        const content = await fs.readFile(file, 'utf-8');
        const lines = content.split('\n');
        for (let index = 0; index < lines.length && results.length < MAX_GREP_RESULTS; index++) {
          if (regex.test(lines[index]!)) {
            if (outputMode === 'files_with_matches') {
              results.push(file);
              break;
            }
            const matchLine = truncateLine(lines[index]!.trim());
            results.push(`${file}:${index + 1}: ${matchLine.text}`);
          }
        }
      } catch {
        // Skip unreadable files and continue with a best-effort search result.
      }
    }
  }

  if (outputMode === 'count') return `${results.length} matches`;
  if (!results.length) {
    return `No matches for "${pattern}"`;
  }

  return finalizeGrepResults(results, ctx);
}
