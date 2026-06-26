import { describe, expect, it, vi } from 'vitest';

const runtimeMocks = vi.hoisted(() => ({
  getImpactEstimate: vi.fn(),
  getModuleContext: vi.fn(),
  getProcessContext: vi.fn(),
  getSymbolContext: vi.fn(),
  readRepoIntelligenceToolWaitMs: vi.fn(() => 1),
}));

vi.mock('../repo-intelligence/runtime.js', () => runtimeMocks);

import { toolRelationshipScan } from './relationship-scan.js';

describe('relationship_scan budget behavior', () => {
  it('stops indexed follow-up calls after the first warming result', async () => {
    runtimeMocks.getSymbolContext.mockResolvedValueOnce({
      symbol: {
        id: 'limited:NameService',
        name: 'NameService',
        qualifiedName: 'NameService',
        kind: 'function',
        filePath: '',
        moduleId: '.',
        language: 'unknown',
        capabilityTier: 'low',
        line: 1,
        signature: 'NameService',
        exported: false,
        calls: [],
        callTargets: [],
        importPaths: [],
        confidence: 0.1,
      },
      alternatives: [],
      callers: [],
      freshness: 'limited',
      confidence: 0.1,
      capability: {
        mode: 'full',
        engine: 'full',
        level: 'enhanced',
        status: 'warming',
        warnings: ['Repo intelligence symbol context is still warming; retry shortly.'],
      },
    });

    const result = await toolRelationshipScan({ symbol: 'NameService' }, {
      backups: new Map(),
      executionCwd: 'C:/repo',
    });

    expect(result).toContain('Relationship scan for NameService');
    expect(result).toContain('still warming');
    expect(runtimeMocks.getSymbolContext).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.getModuleContext).not.toHaveBeenCalled();
    expect(runtimeMocks.getProcessContext).not.toHaveBeenCalled();
    expect(runtimeMocks.getImpactEstimate).not.toHaveBeenCalled();
  });

  it('renders a clean warming response without false-negative edge claims', async () => {
    runtimeMocks.getSymbolContext.mockResolvedValueOnce({
      symbol: {
        id: 'limited:NameService',
        name: 'NameService',
        qualifiedName: 'NameService',
        kind: 'function',
        filePath: '',
        moduleId: '.',
        language: 'unknown',
        capabilityTier: 'low',
        line: 1,
        signature: 'NameService',
        exported: false,
        calls: [],
        callTargets: [],
        importPaths: [],
        confidence: 0.1,
      },
      alternatives: [],
      callers: [],
      freshness: 'limited',
      confidence: 0.1,
      capability: {
        mode: 'full',
        engine: 'full',
        level: 'enhanced',
        status: 'warming',
        warnings: ['Repo intelligence symbol context is still warming; retry shortly.'],
      },
    });

    const result = await toolRelationshipScan({ symbol: 'NameService' }, {
      backups: new Map(),
      executionCwd: 'C:/repo',
    });

    // The warming response must NOT assert that no relationships exist —
    // the empty edge lists are an artifact of an unbuilt index, not a finding.
    expect(result).not.toContain('No direct callers found');
    expect(result).not.toContain('No direct callees found');
    expect(result).not.toContain('No module dependents found');
    // It must explicitly flag the warming state and that this is not a result.
    expect(result).toContain('Structural relationships unavailable');
    expect(result).toContain('NOT a "no relationships found" result');
    expect(result).toContain('retry');
  });
});
