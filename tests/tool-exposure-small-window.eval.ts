/**
 * Eval: FEATURE_254 / FEATURE_255 small-window tool exposure.
 *
 * Layer 1 deterministic release gate. This does not measure model taste; it
 * proves the runtime chooses a small-window optimization profile before an API
 * call and reduces non-core deferred schemas without removing bridge access.
 *
 * Run:
 *   npm run test:eval -- tests/tool-exposure-small-window.eval.ts
 */

import { afterEach, describe, expect, it } from 'vitest';

import { runKodaX } from '../packages/coding/src/agent.js';
import type { RuntimeContextBudgetSnapshot } from '../packages/coding/src/agent-runtime/context-budget.js';
import type { RuntimeToolExposurePlan } from '../packages/coding/src/agent-runtime/tool-exposure-planner.js';
import {
  installCaptureProvider,
  toolNames,
  type CaptureProviderHandle,
  writeToolExposureEvalDump,
} from './tool-exposure-eval-helpers.js';

const SUITE = 'tool-exposure-small-window';
const SMALL_PROVIDER = 'tool-exposure-small-window-provider';
const LARGE_PROVIDER = 'tool-exposure-large-window-provider';

const handles: CaptureProviderHandle[] = [];

function captureProvider(
  providerName: string,
  apiKeyEnv: string,
  contextWindow: number,
): CaptureProviderHandle {
  const handle = installCaptureProvider({
    providerName,
    apiKeyEnv,
    contextWindow,
  });
  handles.push(handle);
  return handle;
}

afterEach(() => {
  while (handles.length > 0) {
    handles.pop()?.cleanup();
  }
});

describe('Eval: tool exposure small-window behavior', () => {
  it('activates schema pruning for 16k providers while leaving roomy providers behavior-compatible', async () => {
    const small = captureProvider(
      SMALL_PROVIDER,
      'TOOL_EXPOSURE_SMALL_WINDOW_API_KEY',
      16_000,
    );
    const large = captureProvider(
      LARGE_PROVIDER,
      'TOOL_EXPOSURE_LARGE_WINDOW_API_KEY',
      128_000,
    );

    const smallBudgets: RuntimeContextBudgetSnapshot[] = [];
    const smallPlans: RuntimeToolExposurePlan[] = [];
    const largeBudgets: RuntimeContextBudgetSnapshot[] = [];
    const largePlans: RuntimeToolExposurePlan[] = [];

    await runKodaX(
      {
        provider: SMALL_PROVIDER,
        reasoningMode: 'off',
        maxIter: 1,
        context: {
          contextDiagnostics: true,
          repoIntelligenceMode: 'off',
        },
        events: {
          onContextBudgetSnapshot: (event) => smallBudgets.push(event),
          onToolExposurePlanned: (event) => smallPlans.push(event),
        },
      },
      'Small-window eval: keep core coding tools usable while reducing schemas.',
    );

    await runKodaX(
      {
        provider: LARGE_PROVIDER,
        reasoningMode: 'off',
        maxIter: 1,
        context: {
          contextDiagnostics: true,
          repoIntelligenceMode: 'off',
        },
        events: {
          onContextBudgetSnapshot: (event) => largeBudgets.push(event),
          onToolExposurePlanned: (event) => largePlans.push(event),
        },
      },
      'Large-window eval: stay compatible when schema pressure is low.',
    );

    const smallVisible = toolNames(small.calls[0]?.tools ?? []);
    const largeVisible = toolNames(large.calls[0]?.tools ?? []);
    const smallPlan = smallPlans[0];
    const largePlan = largePlans[0];

    expect(smallBudgets[0]?.contextWindow).toBe(16_000);
    expect(smallBudgets[0]?.smallWindow).toBe(true);
    expect(smallPlan?.profile).toBe('small_window');
    expect(smallPlan?.reportOnly).toBe(false);
    expect(smallVisible).toContain('read');
    expect(smallVisible).toContain('grep');
    expect(smallVisible).toContain('tool_search');
    expect(smallVisible).toContain('tool_describe');
    expect(smallVisible).toContain('tool_call');
    expect(smallVisible).not.toContain('web_fetch');
    expect(smallPlan?.decisions.find((decision) => decision.toolName === 'web_fetch')?.mode).toBe('bridge');
    expect(smallPlan?.estimatedTokensSaved).toBeGreaterThan(0);

    expect(largeBudgets[0]?.contextWindow).toBe(128_000);
    expect(largeBudgets[0]?.smallWindow).toBe(false);
    expect(largePlan?.profile).toBe('report_only');
    expect(largePlan?.reportOnly).toBe(true);
    expect(largeVisible).toContain('web_fetch');
    expect(largeVisible).toContain('tool_search');

    writeToolExposureEvalDump(SUITE, 'small-vs-large-window', {
      stage: 'small-vs-large-window',
      small: {
        budget: smallBudgets[0],
        visibleToolNames: smallVisible,
        bridgedToolNames: smallPlan?.decisions
          .filter((decision) => decision.mode === 'bridge')
          .map((decision) => decision.toolName),
        estimatedTokensSaved: smallPlan?.estimatedTokensSaved,
      },
      large: {
        budget: largeBudgets[0],
        visibleToolNames: largeVisible,
        reportOnly: largePlan?.reportOnly,
      },
    });
  });
});
