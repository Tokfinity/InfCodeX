import type { BashOutputFilter, BashOutputFilterInput, FilterResult } from '../types.js';
import { filterGitDiff } from './git-diff.js';
import { filterGitLog } from './git-log.js';
import { filterGitStatus } from './git-status.js';
import { filterJsonOutput } from './json-output.js';
import { filterLint } from './lint.js';
import { filterTestRunner } from './test-runner.js';

export const COMPILED_OUTPUT_FILTERS: readonly BashOutputFilter[] = [
  filterGitDiff,
  filterGitStatus,
  filterGitLog,
  filterTestRunner,
  filterLint,
  filterJsonOutput,
];

export function applyCompiledOutputFilters(input: BashOutputFilterInput): FilterResult {
  let current = input;
  for (const filter of COMPILED_OUTPUT_FILTERS) {
    const next = filter(current);
    current = { ...next, command: input.command };
  }
  return {
    stdout: current.stdout,
    stderr: current.stderr,
    lossiness: current.lossiness,
    note: current.note,
  };
}
