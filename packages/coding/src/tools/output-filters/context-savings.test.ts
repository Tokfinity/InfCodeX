import { describe, expect, it } from 'vitest';
import { countTokens } from '../../tokenizer.js';
import type { KodaXToolExecutionContext } from '../../types.js';
import { applyCompiledOutputFilters } from './compiled/index.js';
import { applyDeclarativeOutputFilters } from './declarative.js';
import { applyGenericOutputFilter } from './generic.js';
import { filterBashOutputBodies, renderBashBody } from './registry.js';
import type { FilterResult, Lossiness } from './types.js';

interface SavingsCase {
  id: string;
  command: string;
  stdout: string;
  stderr: string;
  minimumSavingsRatio: number;
  expectedLossiness: Lossiness;
}

function makeCtx(): KodaXToolExecutionContext {
  return {
    backups: new Map(),
    executionCwd: process.cwd(),
  };
}

function gitDiffFixture(): string {
  return Array.from({ length: 120 }, (_, index) => [
    `diff --git a/src/file-${index}.ts b/src/file-${index}.ts`,
    'index 1111111..2222222 100644',
    `--- a/src/file-${index}.ts`,
    `+++ b/src/file-${index}.ts`,
    '@@ -1,4 +1,5 @@',
    '-const oldValue = 1;',
    '+const newValue = 2;',
    '+const anotherValue = 3;',
    ' export const stable = true;',
  ].join('\n')).join('\n');
}

function testRunnerFixture(): string {
  const passing = Array.from({ length: 220 }, (_, index) => `PASS src/pass-${index}.test.ts`).join('\n');
  return [
    passing,
    'FAIL src/fail.test.ts',
    'AssertionError: expected true to be false',
    '  at src/fail.test.ts:10:5',
    'Test Files 1 failed | 220 passed',
    'Tests 1 failed | 440 passed',
  ].join('\n');
}

function packageProgressFixture(): string {
  const progress = Array.from({ length: 220 }, (_, index) => `Progress: resolved ${index}, reused ${index}, downloaded ${index}`).join('\n');
  return `${progress}\nPackages: +12\nDone in 3.1s`;
}

function gitStatusFixture(): string {
  const modified = Array.from({ length: 90 }, (_, index) => ` M packages/coding/src/changed-${index}.ts`);
  const added = Array.from({ length: 70 }, (_, index) => `A  packages/coding/src/added-${index}.ts`);
  const untracked = Array.from({ length: 50 }, (_, index) => `?? scratch/generated-${index}.json`);
  return [...modified, ...added, ...untracked].join('\n');
}

function gitLogFixture(): string {
  return Array.from(
    { length: 160 },
    (_, index) => `${index.toString(16).padStart(7, 'a')} feat: implement context-heavy workflow case ${index} with detailed notes`,
  ).join('\n');
}

function lintFixture(): string {
  const progress = Array.from({ length: 180 }, (_, index) => `Checking project reference ${index}/180`);
  return [
    ...progress,
    'packages/coding/src/tools/example.ts',
    '  18:7  error  Unexpected nullable branch  no-unnecessary-condition',
    '  42:11 warning  Missing explicit return type  @typescript-eslint/explicit-function-return-type',
    'packages/coding/src/tools/other.ts',
    '  9:5  error  TS2322: Type string is not assignable to type number',
    '\u2716 3 problems (2 errors, 1 warning)',
  ].join('\n');
}

function dockerProgressFixture(): string {
  return Array.from({ length: 520 }, (_, index) => {
    if (index % 3 === 0) return `#${index} [stage ${index}/180] DONE 0.${index % 10}s`;
    if (index % 3 === 1) return `#${index} transferring context: ${index}.2MB`;
    return `${index.toString(16).padStart(12, 'a')}: Downloading`;
  }).join('\n');
}

function infraProgressFixture(): string {
  const creating = Array.from(
    { length: 420 },
    (_, index) => `Still creating aws_instance.worker[${index % 6}]... [${index * 10}s elapsed]`,
  );
  const uploads = Array.from({ length: 220 }, (_, index) => `upload: ./dist/chunk-${index}.js to s3://example/chunk-${index}.js`);
  return [...creating, ...uploads, 'Apply complete! Resources: 6 added, 0 changed, 0 destroyed.'].join('\n');
}

function jsonFixture(): string {
  return JSON.stringify(Array.from({ length: 160 }, (_, index) => ({
    id: index,
    name: `item-${index}`,
    tags: ['alpha', 'beta', 'gamma'],
    nested: {
      ok: true,
      count: index,
    },
  })), null, 2);
}

function ndjsonFixture(): string {
  return Array.from({ length: 180 }, (_, index) => JSON.stringify({
    id: index,
    title: `issue-${index}`,
    state: index % 3 === 0 ? 'open' : 'closed',
    labels: ['bug', 'context', 'feature-251'],
    user: {
      login: `user-${index}`,
      id: index + 1000,
    },
  })).join('\n');
}

const SAVINGS_CASES: readonly SavingsCase[] = [
  {
    id: 'git-diff-120-files',
    command: 'git diff',
    stdout: gitDiffFixture(),
    stderr: '',
    minimumSavingsRatio: 0.55,
    expectedLossiness: 'whole',
  },
  {
    id: 'vitest-one-failure',
    command: 'npx vitest run',
    stdout: testRunnerFixture(),
    stderr: '',
    minimumSavingsRatio: 0.75,
    expectedLossiness: 'tail',
  },
  {
    id: 'pnpm-install-progress',
    command: 'pnpm install',
    stdout: packageProgressFixture(),
    stderr: '',
    minimumSavingsRatio: 0.75,
    expectedLossiness: 'tail',
  },
  {
    id: 'git-status-210-paths',
    command: 'git status --porcelain=v1',
    stdout: gitStatusFixture(),
    stderr: '',
    minimumSavingsRatio: 0.45,
    expectedLossiness: 'tail',
  },
  {
    id: 'git-log-160-lines',
    command: 'git log --oneline',
    stdout: gitLogFixture(),
    stderr: '',
    minimumSavingsRatio: 0.70,
    expectedLossiness: 'tail',
  },
  {
    id: 'lint-with-noisy-progress',
    command: 'npx tsc --noEmit',
    stdout: lintFixture(),
    stderr: '',
    minimumSavingsRatio: 0.80,
    expectedLossiness: 'tail',
  },
  {
    id: 'docker-build-progress-stderr',
    command: 'docker build .',
    stdout: 'Successfully built feature251',
    stderr: dockerProgressFixture(),
    minimumSavingsRatio: 0.80,
    expectedLossiness: 'tail',
  },
  {
    id: 'terraform-apply-progress',
    command: 'terraform apply',
    stdout: infraProgressFixture(),
    stderr: '',
    minimumSavingsRatio: 0.80,
    expectedLossiness: 'tail',
  },
  {
    id: 'aws-json-array',
    command: 'aws ec2 describe-instances',
    stdout: jsonFixture(),
    stderr: '',
    minimumSavingsRatio: 0.85,
    expectedLossiness: 'whole',
  },
  {
    id: 'gh-ndjson-events',
    command: 'gh api repos/example/project/issues --paginate',
    stdout: ndjsonFixture(),
    stderr: '',
    minimumSavingsRatio: 0.80,
    expectedLossiness: 'whole',
  },
];

function bodyTokens(body: FilterResult): number {
  return countTokens(renderBashBody(body));
}

describe('explicit lossy Bash output filters', () => {
  it.each(SAVINGS_CASES)('$id can reduce bash body context tokens when explicitly requested', async (testCase) => {
    const raw: FilterResult = {
      stdout: testCase.stdout,
      stderr: testCase.stderr,
      lossiness: 'none',
    };
    const filtered = await filterBashOutputBodies({
      command: testCase.command,
      stdout: testCase.stdout,
      stderr: testCase.stderr,
      ctx: makeCtx(),
      filters: [
        applyGenericOutputFilter,
        applyCompiledOutputFilters,
        applyDeclarativeOutputFilters,
      ],
      persist: async () => 'C:\\tmp\\feature-251-raw.txt',
    });
    const rawTokens = bodyTokens(raw);
    const filteredTokens = bodyTokens(filtered);
    const savingsRatio = (rawTokens - filteredTokens) / rawTokens;

    expect(filteredTokens).toBeLessThan(rawTokens);
    expect(savingsRatio).toBeGreaterThanOrEqual(testCase.minimumSavingsRatio);
    expect(filtered.lossiness).toBe(testCase.expectedLossiness);
  });
});
