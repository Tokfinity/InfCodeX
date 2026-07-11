import { buildWorkerInstructions } from '../agents/worker-role-prompt.js';
import type { KodaXTaskRoutingDecision } from '../types.js';
import { DEFERRED_TOOL_HINTS } from './deferred-tools.js';
import { getToolDefinition } from './registry.js';

const decision: KodaXTaskRoutingDecision = {
  primaryTask: 'edit',
  workIntent: 'append',
  complexity: 'moderate',
  riskLevel: 'medium',
  harnessProfile: 'PLANNED',
  recommendedMode: 'implementation',
  recommendedThinkingDepth: 'medium',
  confidence: 0.7,
  reason: 'planned route',
  requiresBrainstorm: false,
};

describe('FEATURE_259 prompt contracts', () => {
  it('keeps the resident workflow identity at least 60% smaller while full teaching stays discoverable', () => {
    const full = getToolDefinition('run_workflow')?.description ?? '';
    const resident = DEFERRED_TOOL_HINTS.run_workflow ?? '';
    expect(Buffer.byteLength(resident, 'utf8')).toBeLessThanOrEqual(
      Math.floor(Buffer.byteLength(full, 'utf8') * 0.4),
    );
    expect(resident).toContain('manifest + source');
    expect(resident).toContain('background task_id');
    expect(resident).toContain('idle-yield');
    expect(resident).toContain('tool_search');
    expect(full).toContain('wf.pipeline');
    expect(full).toContain('outputSchema');
    expect(full).toContain('wf.workflow');
  });

  it('keeps implementation metadata out of Worker-visible prose', () => {
    const prompt = buildWorkerInstructions(decision, undefined, false);
    expect(prompt).not.toMatch(/FEATURE_\d+/);
    expect(prompt).not.toMatch(/PLAN-FIRST CONTRACT \([^)]*v0\./);
    expect(prompt).toContain('Configured `fast`/`deep` tiers select their operator-mapped route');
  });
});
