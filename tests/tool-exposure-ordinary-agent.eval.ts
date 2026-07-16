/**
 * Eval: FEATURE_254 ordinary-agent discovery exposure.
 *
 * Layer 1 deterministic release gate. Ordinary agent work often needs web,
 * goal, and MCP discovery tools rather than repo-intelligence. This verifies
 * small-window pruning keeps the core interaction/search bridge resident and
 * keeps the hidden deferred families discoverable through production
 * tool_search output.
 *
 * Run:
 *   npm run test:eval -- tests/tool-exposure-ordinary-agent.eval.ts
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

const SUITE = 'tool-exposure-ordinary-agent';
const ORDINARY_DISCOVERY_TOOLS = [
  'web_search',
  'web_fetch',
  'get_goal',
  'mcp_search',
  'mcp_read_resource',
  'mcp_get_prompt',
] as const;
const PROTECTED_ORDINARY_CORE = [
  'ask_user_question',
  'read',
  'grep',
  'glob',
  'tool_search',
  'tool_describe',
  'tool_call',
] as const;

function makeToolContext(): KodaXToolExecutionContext {
  return {
    backups: new Map<string, string>(),
    gitRoot: process.cwd(),
    executionCwd: process.cwd(),
  };
}

describe('Eval: tool exposure ordinary-agent discovery', () => {
  it('keeps ordinary core tools resident and preserves hidden deferred discovery families', async () => {
    const allToolNames = listToolDefinitions().map((tool) => tool.name);
    const activeDefinitions = getActiveToolDefinitions(
      allToolNames,
      'off',
      false,
      true,
    );
    const budget = createRuntimeContextBudgetSnapshot({
      contextWindow: 16_000,
      systemPrompt: 'Ordinary agent discovery eval prompt.',
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
    const activeNames = toolNames(activeDefinitions);

    expect(profile).toBe('small_window');
    expect(plan.reportOnly).toBe(false);
    expect(plan.bridgeAvailable).toBe(true);

    for (const name of PROTECTED_ORDINARY_CORE) {
      const decision = plan.decisions.find((entry) => entry.toolName === name);
      expect(activeNames, `${name} should be active for ordinary agent work`).toContain(name);
      expect(visibleNames, `${name} should stay provider-visible`).toContain(name);
      expect(decision?.mode, `${name} should remain resident`).toBe('resident');
    }

    for (const name of ORDINARY_DISCOVERY_TOOLS) {
      const decision = plan.decisions.find((entry) => entry.toolName === name);
      expect(activeNames, `${name} should be active before exposure planning`).toContain(name);
      expect(decision, `${name} should have an exposure decision`).toBeDefined();
      expect(decision?.reason, `${name} should have a deterministic reason`).toBeTruthy();
    }

    const toolContext = makeToolContext();
    const searchResult = String(await toolSearchHandler({
      query: 'select:web_search,web_fetch,get_goal,mcp_search,mcp_read_resource,mcp_get_prompt',
    }, toolContext));
    const unlocked = [...getUnlockedDeferredTools(toolContext)];

    for (const name of ORDINARY_DISCOVERY_TOOLS) {
      expect(searchResult, `${name} should remain discoverable through tool_search`).toContain(`"name":"${name}"`);
      expect(unlocked).toContain(name);
    }

    writeToolExposureEvalDump(SUITE, 'ordinary-discovery-small-window', {
      stage: 'ordinary-discovery-small-window',
      profile,
      pressure: budget.pressure,
      visibleToolNames: visibleNames,
      ordinaryDiscoveryDecisions: ORDINARY_DISCOVERY_TOOLS.map((name) => (
        plan.decisions.find((entry) => entry.toolName === name)
      )),
      protectedCoreDecisions: PROTECTED_ORDINARY_CORE.map((name) => (
        plan.decisions.find((entry) => entry.toolName === name)
      )),
      estimatedTokensSaved: plan.estimatedTokensSaved,
      searchResult,
      unlocked,
    });
  });
});
