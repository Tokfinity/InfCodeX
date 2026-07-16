import { describe, expect, it, vi } from 'vitest';

const workerMocks = vi.hoisted(() => ({
  buildRepoIntelligenceIndex: vi.fn(),
  detachRepoIntelligenceWorkerRequest: vi.fn(() => true),
  getCyclicDependencyAnalysis: vi.fn(),
  getImpactEstimate: vi.fn(),
  getModuleContext: vi.fn(),
  getProcessContext: vi.fn(),
  getRepoIntelligenceIndex: vi.fn(),
  getRepoRoutingSignals: vi.fn(),
  getSymbolContext: vi.fn(),
  semanticLookup: vi.fn(),
}));

vi.mock('./semantic-worker-client.js', () => workerMocks);

import {
  getCyclicDependencyAnalysis,
  getModuleContext,
  semanticLookup,
} from './runtime.js';

function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

describe('repo-intelligence tool budgets', () => {
  it('returns warming module context when the worker misses the tool budget', async () => {
    workerMocks.getModuleContext.mockReturnValueOnce(never());

    const result = await getModuleContext(
      { executionCwd: 'C:/repo' },
      { targetPath: 'src/index.ts', mode: 'full', maxWaitMs: 1 },
    );

    expect(result.capability).toMatchObject({
      mode: 'full',
      engine: 'full',
      status: 'warming',
    });
    expect(result.capability?.warnings.join(' ')).toContain('still warming');
    expect(workerMocks.getModuleContext).toHaveBeenCalledTimes(1);
  });

  it('returns warming semantic lookup results when the worker misses the tool budget', async () => {
    workerMocks.semanticLookup.mockReturnValueOnce(never());

    const result = await semanticLookup(
      { executionCwd: 'C:/repo' },
      { query: 'NameService', kind: 'symbol', limit: 5, mode: 'full', maxWaitMs: 1 },
    );

    expect(result.items).toEqual([]);
    expect(result.capability).toMatchObject({
      mode: 'full',
      engine: 'full',
      status: 'warming',
    });
  });

  it('returns warming cyclic analysis when the worker misses the tool budget', async () => {
    workerMocks.getCyclicDependencyAnalysis.mockReturnValueOnce(never());

    const result = await getCyclicDependencyAnalysis(
      { executionCwd: 'C:/repo' },
      { mode: 'full', maxWaitMs: 1 },
    );

    expect(result.cycles).toEqual([]);
    expect(result.summary).toContain('still warming');
  });
});
