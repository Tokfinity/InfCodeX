import { describe, expect, it } from 'vitest';
import type { KodaXTaskRoutingDecision } from '../types.js';
import {
  buildWorkerInstructions,
  EXPLICIT_WORKFLOW_POLICY,
  ULTRA_AGENT_POLICY,
  WORKER_AGENT_NAME,
} from './worker-role-prompt.js';

const baseDecision: KodaXTaskRoutingDecision = {
  primaryTask: 'edit',
  workIntent: 'append',
  complexity: 'moderate',
  riskLevel: 'medium',
  harnessProfile: 'PLANNED',
  recommendedMode: 'implementation',
  recommendedThinkingDepth: 'medium',
  confidence: 0.7,
  reason: 'PLANNED route',
  requiresBrainstorm: false,
};

describe('buildWorkerInstructions', () => {
  it('keeps the primary worker identity and execution contracts', () => {
    const output = buildWorkerInstructions(baseDecision, undefined, false);

    expect(WORKER_AGENT_NAME).toBe('kodax-worker');
    expect(output).toContain("You are the Worker — KodaX's single primary agent");
    expect(output).toContain('PLAN-FIRST CONTRACT:');
    expect(output).toContain('SCOPE COMMITMENT:');
    expect(output).toContain('MUTATION DISCIPLINE:');
    expect(output).toContain('REPO INTELLIGENCE TOOLS');
    expect(output).toContain('TERMINATION:');
  });

  it('teaches the canonical recursive Agent collaboration surface', () => {
    const output = buildWorkerInstructions(baseDecision, undefined, false);

    expect(output).toContain('AGENT COLLABORATION:');
    expect(output).toContain('AGENT STEERING:');
    for (const toolName of [
      'spawn_agent',
      'wait_agent',
      'send_message',
      'followup_task',
      'list_agents',
      'agent_output',
      'interrupt_agent',
    ]) {
      expect(output).toContain(`\`${toolName}\``);
    }
    expect(output).toContain('Children may recursively spawn descendants');
    expect(output).toContain('same root concurrency and work budget');
    expect(output).toContain('<agent-completed path="..." turn_id="..." state="completed">');
    expect(output).toContain('its body is the authoritative terminal result');
    expect(output).toContain('Do not call `agent_output` speculatively');
    expect(output).toContain('only after a preceding `<agent-completed>` supplies the target');
    expect(output).toContain('After `AgentLimitReached`');
    expect(output).toContain('do not retry `spawn_agent` while the reported capacity is still full');
    expect(output).toContain('canonical `agent_id` from `list_dispatchable_agents`');
    expect(output).not.toContain('On a fresh request with independent lanes');
  });

  it('does not teach retired task lifecycle tools or complexity-driven Workflow activation', () => {
    const output = buildWorkerInstructions(baseDecision, undefined, false);

    expect(output).not.toContain('dispatch_child_task');
    expect(output).not.toContain('task_output');
    expect(output).not.toContain('task_stop');
    expect(output).not.toContain('<task-completed>');
    expect(output).not.toContain('DISPATCH RULES');
    expect(output).not.toContain('ORCHESTRATION DEFAULT');
    expect(output).not.toContain('FAN-OUT PLAN GRANULARITY');
  });

  it('keeps explicit and proactive policy sentences stable', () => {
    expect(ULTRA_AGENT_POLICY).toBe(
      'Use sub-agents when parallel work would materially improve speed or quality.',
    );
    expect(EXPLICIT_WORKFLOW_POLICY).toBe(
      'Use `run_workflow` only when the user explicitly requests a Workflow or names a Workflow. Do not infer Workflow intent from task complexity alone.',
    );
  });

  it('keeps the prompt stable across revise reanimation', () => {
    expect(buildWorkerInstructions(baseDecision, undefined, true)).toBe(
      buildWorkerInstructions(baseDecision, undefined, false),
    );
  });

  it('preserves routing context and natural-language child guidance', () => {
    const output = buildWorkerInstructions(baseDecision, undefined, false);

    expect(output).toContain('- Primary task: edit');
    expect(output).toContain('- Risk: medium');
    expect(output).toContain('- Complexity: moderate');
    expect(output).toContain('same natural language as the user\'s request');
    expect(output).toContain('`model_hint` intentionally');
  });
});
