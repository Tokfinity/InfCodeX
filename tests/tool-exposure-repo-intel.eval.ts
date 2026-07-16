/**
 * Eval: FEATURE_254 repo-intelligence progressive exposure.
 *
 * Layer 1 deterministic release gate. The question here is mechanical:
 * repo-intelligence tools must be active in repo-intel mode, removable from the
 * provider-visible schema under small-window pressure, and still discoverable
 * through the production tool_search teaching path.
 *
 * Run:
 *   npm run test:eval -- tests/tool-exposure-repo-intel.eval.ts
 */

import { describe, expect, it } from 'vitest';

import { createRuntimeContextBudgetSnapshot } from '../packages/coding/src/agent-runtime/context-budget.js';
import {
  applyToolExposurePlan,
  hasPortableToolBridge,
  planToolExposure,
  selectRuntimeContextOptimizationProfile,
} from '../packages/coding/src/agent-runtime/tool-exposure-planner.js';
import { getActiveToolDefinitions } from '../packages/coding/src/agent-runtime/tool-resolution.js';
import type { KodaXToolExecutionContext } from '../packages/coding/src/types.js';
import { listToolDefinitions } from '../packages/coding/src/tools/index.js';
import { toolSearchHandler } from '../packages/coding/src/tools/tool-search.js';
import { getUnlockedDeferredTools } from '../packages/coding/src/tools/deferred-tools.js';
import { toolNames, writeToolExposureEvalDump } from './tool-exposure-eval-helpers.js';

const SUITE = 'tool-exposure-repo-intel';
const REPO_INTEL_DEFERRED = [
  'repo_overview',
  'changed_scope',
  'module_context',
  'symbol_context',
  'process_context',
  'impact_estimate',
] as const;

function makeToolContext(): KodaXToolExecutionContext {
  return {
    backups: new Map<string, string>(),
    gitRoot: process.cwd(),
    executionCwd: process.cwd(),
  };
}

describe('Eval: tool exposure repo-intelligence', () => {
  it('bridges repo-intelligence schemas under small-window pressure without losing discovery', async () => {
    const allToolNames = listToolDefinitions().map((tool) => tool.name);
    const activeDefinitions = getActiveToolDefinitions(
      allToolNames,
      'full',
      false,
      false,
    );
    const budget = createRuntimeContextBudgetSnapshot({
      contextWindow: 16_000,
      systemPrompt: 'Repo-intelligence eval prompt.',
      toolDefinitions: activeDefinitions,
    });
    const profile = selectRuntimeContextOptimizationProfile(budget);
    const plan = planToolExposure({
      tools: activeDefinitions,
      budget: { ...budget, profile },
      bridgeAvailable: hasPortableToolBridge(activeDefinitions),
      profile,
    });
    const visibleNames = toolNames(applyToolExposurePlan(activeDefinitions, plan));

    expect(profile).toBe('small_window');
    expect(plan.reportOnly).toBe(false);
    expect(plan.bridgeAvailable).toBe(true);
    expect(visibleNames).toContain('tool_search');
    expect(visibleNames).toContain('tool_describe');
    expect(visibleNames).toContain('tool_call');

    for (const name of REPO_INTEL_DEFERRED) {
      const decision = plan.decisions.find((entry) => entry.toolName === name);
      expect(activeDefinitions.map((tool) => tool.name), `${name} should be active in repo-intel mode`)
        .toContain(name);
      expect(decision?.mode, `${name} should move behind the bridge`).toBe('bridge');
      expect(visibleNames, `${name} should be hidden from provider-visible schema`).not.toContain(name);
    }

    const toolContext = makeToolContext();
    const searchResult = String(await toolSearchHandler({
      query: 'select:module_context,symbol_context,impact_estimate',
    }, toolContext));
    const unlocked = [...getUnlockedDeferredTools(toolContext)];

    expect(searchResult).toContain('"name":"module_context"');
    expect(searchResult).toContain('"name":"symbol_context"');
    expect(searchResult).toContain('"name":"impact_estimate"');
    expect(unlocked).toEqual(expect.arrayContaining([
      'module_context',
      'symbol_context',
      'impact_estimate',
    ]));

    writeToolExposureEvalDump(SUITE, 'repo-intel-small-window-bridge', {
      stage: 'repo-intel-small-window-bridge',
      profile,
      pressure: budget.pressure,
      visibleToolNames: visibleNames,
      repoIntelDecisions: REPO_INTEL_DEFERRED.map((name) => (
        plan.decisions.find((entry) => entry.toolName === name)
      )),
      estimatedTokensSaved: plan.estimatedTokensSaved,
      searchResult,
      unlocked,
    });
  });
});
