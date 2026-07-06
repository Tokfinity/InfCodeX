import { outputMatches } from '../detect.js';
import { changedResult, joinLines, splitLines, uniqueInOrder } from '../helpers.js';
import type { BashOutputFilterInput, FilterResult } from '../types.js';

const TEST_COMMAND = /\b(?:vitest|jest|pytest|cargo\s+test|go\s+test|npm\s+test|pnpm\s+test|yarn\s+test)\b/i;
const FAILURE_LINE = /(?:^|\b)(FAIL|FAILED|ERROR|AssertionError|Expected|Received|panic|failures?:|---- .+ ----)/i;
const SUMMARY_LINE = /(?:Test Files|Tests\s|Snapshots|Ran all test suites|test result:|short test summary|failed,|passed,|error: test failed)/i;

function isTestOutput(input: BashOutputFilterInput): boolean {
  return TEST_COMMAND.test(input.command) || outputMatches(input, /(?:Test Files|AssertionError|=+ FAILURES =+|test result:|FAIL\s+\S)/);
}

function compressTestText(text: string): string {
  const lines = splitLines(text);
  if (lines.length <= 80 && !lines.some((line) => FAILURE_LINE.test(line))) {
    return text;
  }

  const kept: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    if (FAILURE_LINE.test(line)) {
      kept.push(line);
      for (let offset = 1; offset <= 6; offset++) {
        const next = lines[index + offset];
        if (next === undefined) break;
        if (/^(PASS|\u2713)\b/.test(next)) break;
        kept.push(next);
      }
      continue;
    }
    if (SUMMARY_LINE.test(line)) {
      kept.push(line);
    }
  }

  const body = kept.length > 0 ? uniqueInOrder(kept) : lines.slice(-50);
  if (body.length >= lines.length) return text;

  return joinLines([
    `[test output summarized: showing ${body.length} of ${lines.length} lines]`,
    ...body,
  ]);
}

export function filterTestRunner(input: BashOutputFilterInput): FilterResult {
  if (!isTestOutput(input)) return input;

  return changedResult(
    input,
    compressTestText(input.stdout),
    compressTestText(input.stderr),
    'tail',
    '[Bash output compressed by test-runner.]',
  );
}
