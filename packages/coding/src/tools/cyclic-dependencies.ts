/**
 * FEATURE_205-A (v0.7.45) — `cyclic_dependencies` repo pull-tool.
 * Detects circular import chains (Tarjan SCC) over the module-level import
 * graph. Fills a real gap: the 8 existing pull-tools answer 1-hop blast
 * radius (impact_estimate / module_context / symbol_context), none answer
 * "is there a cycle".
 */
import type { KodaXToolExecutionContext } from '../types.js';
import {
  getCyclicDependencyAnalysis,
  readRepoIntelligenceToolWaitMs,
} from '../repo-intelligence/runtime.js';
import { renderCycleAnalysis } from '../repo-intelligence/cyclic-deps.js';

export async function toolCyclicDependencies(
  _input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  try {
    return renderCycleAnalysis(await getCyclicDependencyAnalysis(ctx, {
      maxWaitMs: readRepoIntelligenceToolWaitMs(),
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[Tool Error] cyclic_dependencies: ${message}`;
  }
}
