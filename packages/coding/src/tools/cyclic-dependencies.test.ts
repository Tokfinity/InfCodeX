import { describe, expect, it, vi } from 'vitest';

const runtimeMocks = vi.hoisted(() => ({
  getCyclicDependencyAnalysis: vi.fn(),
  readRepoIntelligenceToolWaitMs: vi.fn(() => 1),
}));

vi.mock('../repo-intelligence/runtime.js', () => runtimeMocks);

import { toolCyclicDependencies } from './cyclic-dependencies.js';

describe('toolCyclicDependencies', () => {
  it('renders bounded cyclic dependency analysis from the repo-intelligence runtime', async () => {
    runtimeMocks.getCyclicDependencyAnalysis.mockResolvedValue({
      summary: '1 cycle(s) found, 0 high-severity.',
      scanned: { modules: 2, edges: 2 },
      cycles: [{
        chain: ['a', 'b', 'a'],
        hopCount: 2,
        severity: 'low',
      }],
    });

    const result = await toolCyclicDependencies({}, {
      backups: new Map(),
      executionCwd: 'C:/repo',
    });

    expect(runtimeMocks.getCyclicDependencyAnalysis).toHaveBeenCalledTimes(1);
    expect(result).toContain('1 cycle(s) found');
    expect(result).toContain('[low] 2-hop: a -> b -> a');
  });
});
