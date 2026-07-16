import { beforeEach, describe, expect, it, vi } from 'vitest';
import { semanticLookup } from '../repo-intelligence/runtime.js';
import type { SemanticLookupResult } from '../repo-intelligence/semantic-lookup-query.js';
import { toolSemanticLookup } from './semantic-lookup.js';

vi.mock('../repo-intelligence/runtime.js', () => ({
  readRepoIntelligenceToolWaitMs: () => 100,
  semanticLookup: vi.fn(),
}));

const mockedSemanticLookup = vi.mocked(semanticLookup);

function createLookupResult(count: number): SemanticLookupResult {
  return {
    items: Array.from({ length: count }, (_, index) => ({
      title: `Match ${index + 1}`,
      locator: `src/match-${index + 1}.ts:1`,
      snippet: `match ${index + 1}`,
      score: 1 - index / 10,
      metadata: { kind: 'symbol' },
    })),
    artifacts: Array.from({ length: count }, (_, index) => ({
      kind: 'symbol' as const,
      label: `Artifact ${index + 1}`,
      value: `src/match-${index + 1}.ts:1`,
    })),
    generatedAt: '2026-07-14T00:00:00.000Z',
    sourceFileCount: count,
  };
}

describe('toolSemanticLookup result limits', () => {
  beforeEach(() => {
    mockedSemanticLookup.mockReset();
  });

  it('probes N+1 but does not mark an exact N-result response incomplete', async () => {
    mockedSemanticLookup.mockResolvedValue(createLookupResult(2));

    const output = await toolSemanticLookup({ query: 'match', limit: 2 }, {
      backups: new Map(),
      executionCwd: process.cwd(),
    });

    expect(mockedSemanticLookup).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ limit: 3 }));
    expect(output).not.toContain('RESULT_LIMIT_REACHED');
    expect(output).toContain('Match 2');
  });

  it('returns only N synchronized items/artifacts and marks a real N+1 result', async () => {
    mockedSemanticLookup.mockResolvedValue(createLookupResult(3));

    const output = await toolSemanticLookup({ query: 'match', limit: 2 }, {
      backups: new Map(),
      executionCwd: process.cwd(),
    });

    expect(output).toContain('RESULT_LIMIT_REACHED');
    expect(output).toContain('Narrow `query`, `kind`, or `target_path`');
    expect(output).toContain('Match 2');
    expect(output).not.toContain('Match 3');
    expect(output).not.toContain('src/match-3.ts:1');
    expect(output).toContain('Artifact 2');
    expect(output).not.toContain('Artifact 3');
  });
});
