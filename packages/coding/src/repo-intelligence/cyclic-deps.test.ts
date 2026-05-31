/**
 * FEATURE_205-A (v0.7.45) — Tarjan SCC cyclic dependency tests.
 */
import { describe, expect, it } from 'vitest';

import { findCyclicDependencies } from './cyclic-deps.js';
import type { ModuleCapsule, RepoIntelligenceIndex } from './query-fallback.js';

function mod(moduleId: string, dependencies: string[]): ModuleCapsule {
  // Only moduleId + dependencies are read by findCyclicDependencies; the rest
  // are filled to satisfy the type (cast keeps the fixture terse).
  return { moduleId, dependencies } as unknown as ModuleCapsule;
}

function index(modules: ModuleCapsule[]): RepoIntelligenceIndex {
  return { modules } as unknown as RepoIntelligenceIndex;
}

describe('findCyclicDependencies', () => {
  it('finds no cycle in an acyclic graph', () => {
    const result = findCyclicDependencies(index([
      mod('a', ['b', 'c']),
      mod('b', ['c']),
      mod('c', []),
    ]));
    expect(result.cycles).toHaveLength(0);
    expect(result.summary).toMatch(/No circular/);
    expect(result.scanned).toEqual({ modules: 3, edges: 3 });
  });

  it('detects a simple 2-hop cycle A<->B', () => {
    const result = findCyclicDependencies(index([
      mod('a', ['b']),
      mod('b', ['a']),
    ]));
    expect(result.cycles).toHaveLength(1);
    expect(result.cycles[0]!.hopCount).toBe(2);
    expect(result.cycles[0]!.severity).toBe('low');
    // chain closes the loop
    expect(result.cycles[0]!.chain[0]).toBe(result.cycles[0]!.chain.at(-1));
    expect(new Set(result.cycles[0]!.chain)).toEqual(new Set(['a', 'b']));
  });

  it('detects a 3-hop cycle A->B->C->A as medium severity', () => {
    const result = findCyclicDependencies(index([
      mod('a', ['b']),
      mod('b', ['c']),
      mod('c', ['a']),
    ]));
    expect(result.cycles).toHaveLength(1);
    expect(result.cycles[0]!.hopCount).toBe(3);
    expect(result.cycles[0]!.severity).toBe('medium');
  });

  it('ignores self-loops (degenerate, not a multi-module cycle)', () => {
    const result = findCyclicDependencies(index([
      mod('a', ['a', 'b']),
      mod('b', []),
    ]));
    expect(result.cycles).toHaveLength(0);
  });

  it('finds multiple independent cycles + ranks high severity first', () => {
    const result = findCyclicDependencies(index([
      // 4-module cycle (high)
      mod('a', ['b']), mod('b', ['c']), mod('c', ['d']), mod('d', ['a']),
      // 2-module cycle (low)
      mod('x', ['y']), mod('y', ['x']),
      // acyclic
      mod('z', []),
    ]));
    expect(result.cycles).toHaveLength(2);
    expect(result.cycles[0]!.severity).toBe('high'); // sorted high first
    expect(result.cycles[0]!.hopCount).toBe(4);
    expect(result.cycles[1]!.hopCount).toBe(2);
  });

  it('drops edges to unknown (out-of-graph) modules', () => {
    const result = findCyclicDependencies(index([
      mod('a', ['external-lib', 'b']),
      mod('b', []),
    ]));
    expect(result.cycles).toHaveLength(0);
    expect(result.scanned.edges).toBe(1); // external-lib edge dropped
  });
});
