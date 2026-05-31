/**
 * FEATURE_205-A (v0.7.45) — circular dependency detection via Tarjan's SCC
 * over the module-level import graph (`RepoIntelligenceIndex.modules[]`,
 * `moduleId → dependencies[]`). Pure functions; no I/O. The 8 existing repo
 * pull-tools answer 1-hop blast radius; none answer "is there a cycle".
 */
import type { RepoIntelligenceIndex } from './query-fallback.js';

export interface CycleFinding {
  /** Module ids in cycle order; `chain[last] === chain[0]` to show it loops. */
  chain: string[];
  /** Number of modules in the cycle (2 = A↔B, 3 = A→B→C→A, …). */
  hopCount: number;
  severity: 'high' | 'medium' | 'low';
}

export interface CycleAnalysis {
  cycles: CycleFinding[];
  scanned: { modules: number; edges: number };
  summary: string;
}

/** Tarjan's strongly-connected-components. Returns SCCs (each a list of ids). */
function tarjanScc(adjacency: Map<string, string[]>): string[][] {
  let counter = 0;
  const indexOf = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];

  const strongconnect = (v: string): void => {
    indexOf.set(v, counter);
    lowlink.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);

    for (const w of adjacency.get(v) ?? []) {
      if (!indexOf.has(w)) {
        strongconnect(w);
        lowlink.set(v, Math.min(lowlink.get(v) ?? 0, lowlink.get(w) ?? 0));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v) ?? 0, indexOf.get(w) ?? 0));
      }
    }

    if ((lowlink.get(v) ?? 0) === (indexOf.get(v) ?? 0)) {
      const scc: string[] = [];
      let w = '';
      do {
        w = stack.pop() ?? '';
        onStack.delete(w);
        scc.push(w);
      } while (w !== v && stack.length >= 0 && w !== '');
      sccs.push(scc);
    }
  };

  for (const v of adjacency.keys()) {
    if (!indexOf.has(v)) {
      strongconnect(v);
    }
  }
  return sccs;
}

function severityFor(hopCount: number): CycleFinding['severity'] {
  if (hopCount >= 4) return 'high';
  if (hopCount === 3) return 'medium';
  return 'low';
}

export function findCyclicDependencies(index: RepoIntelligenceIndex): CycleAnalysis {
  const modules = index.modules ?? [];
  const ids = new Set(modules.map((m) => m.moduleId));
  const adjacency = new Map<string, string[]>();
  let edges = 0;
  for (const m of modules) {
    // Keep only intra-graph edges; drop self-loops (handled as degenerate).
    const deps = (m.dependencies ?? []).filter((d) => ids.has(d) && d !== m.moduleId);
    adjacency.set(m.moduleId, deps);
    edges += deps.length;
  }

  const cycles: CycleFinding[] = tarjanScc(adjacency)
    .filter((scc) => scc.length > 1)
    .map((scc) => {
      const ordered = [...scc].reverse(); // Tarjan pops in reverse finish order
      return {
        chain: [...ordered, ordered[0] ?? ''],
        hopCount: scc.length,
        severity: severityFor(scc.length),
      };
    })
    .sort((a, b) => b.hopCount - a.hopCount);

  const highCount = cycles.filter((c) => c.severity === 'high').length;
  const summary =
    cycles.length === 0
      ? 'No circular dependencies found.'
      : `${cycles.length} cycle(s) found, ${highCount} high-severity.`;

  return { cycles, scanned: { modules: modules.length, edges }, summary };
}

/** Render a CycleAnalysis as a tool-result string. */
export function renderCycleAnalysis(analysis: CycleAnalysis): string {
  const lines: string[] = [
    analysis.summary,
    `Scanned ${analysis.scanned.modules} modules, ${analysis.scanned.edges} edges.`,
  ];
  for (const cycle of analysis.cycles) {
    lines.push(`- [${cycle.severity}] ${cycle.hopCount}-hop: ${cycle.chain.join(' -> ')}`);
  }
  return lines.join('\n');
}
