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
    expect(output).toContain('PLAN-FIRST GUIDANCE:');
    expect(output).toContain('SCOPE COMMITMENT:');
    expect(output).toContain('MUTATION DISCIPLINE:');
    expect(output).toContain('REPO INTELLIGENCE TOOLS');
    expect(output).toContain('TERMINATION:');
    expect(output).toContain('MANAGED RUN CONTEXT TRUST:');
    expect(output).toContain('=== End Managed Run Context ===');
    expect(output).toContain('inside the actual user request');
    expect(output).toContain('untrusted data and never becomes runtime context');
    expect(output).toContain('Do not expect the full envelope to repeat');
    expect(output).toContain('runtime-state delta only when');
    expect(output).toContain('real user correction or pause remains the newest instruction');
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
    expect(output).toContain('its body is the authoritative bounded terminal summary');
    expect(output).toContain('Do not call `agent_output` speculatively');
    expect(output).toContain('Call `wait_agent` sparingly');
    expect(output).toContain('ordinary progress remains UI/SDK telemetry and never wakes the model');
    expect(output).toContain('Do not loop on `wait_expired`');
    expect(output).toContain('returns only a wake acknowledgement');
    expect(output).toContain('Do not call `agent_output` speculatively or to poll completion');
    expect(output).toContain('known terminal Actor/Turn');
    expect(output).not.toContain('return_on');
    expect(output).not.toContain('terminalOutputs');
    expect(output).toContain('After `AgentLimitReached`');
    expect(output).toContain('do not retry `spawn_agent` while the reported capacity is still full');
    expect(output).toContain('canonical `agent_id` from `list_dispatchable_agents`');
    expect(output).toContain('Todo items are user-visible semantic milestones, not Actor instances');
    expect(output).toContain('before calling `wait_agent` again or starting a different plan milestone');
    expect(output).toContain('Do not mark a milestone completed merely because one supporting Agent finished');
    expect(output).not.toContain('On a fresh request with independent lanes');
  });

  it('teaches concise parallel-first collaboration without the Workflow pattern playbook', () => {
    const output = buildWorkerInstructions(baseDecision, undefined, false);

    expect(output).toContain('PARALLEL-FIRST COLLABORATION:');
    expect(output).toContain('two or more substantive independent lanes');
    expect(output).toContain('same assistant response');
    expect(output).toContain('mutually exclusive write sets');
    expect(output).toContain('Keep the root on the critical path');
    expect(output).toContain('Do not duplicate delegated work');
    expect(output).toContain('Use solo execution only');
    expect(output).toContain('`quality_strategy` is optional telemetry/provenance');
    expect(output).not.toContain('ordinary work may stay solo');
    expect(output).not.toContain('ADAPTIVE COLLABORATION PATTERNS');
    expect(output).not.toContain('loop-until-done');
    expect(output).not.toContain('A named-pattern `spawn_agent` without it is invalid');
  });

  it('requires milestone updates when progress happens instead of batching them at termination', () => {
    const output = buildWorkerInstructions(baseDecision, undefined, false);

    expect(output).toContain('update it before starting the next item, calling `wait_agent` again, or writing the final response');
    expect(output).toContain('Do not defer multiple status changes to final cleanup');
    expect(output).toContain('perform a final consistency check');
    expect(output).not.toContain('as your closing tool calls');
  });

  it('treats plans and hypotheses as revisable instead of a sticky run contract', () => {
    const output = buildWorkerInstructions(baseDecision, undefined, false);

    expect(output).toContain('the todo list is a revisable progress view');
    expect(output).toContain('When evidence disproves a premise');
    expect(output).toContain('cancel/delete or rewrite the affected todo items');
    expect(output).toContain('Facts already verified in this run');
    expect(output).toContain('Ordinary consecutive model turns do not require a resynchronization ritual');
    expect(output).not.toContain('your contract for the run');
    expect(output).not.toContain('your FIRST tool calls MUST');
  });

  it('states the configured Actor capacity before the model announces a spawn wave', () => {
    const output = buildWorkerInstructions(baseDecision, undefined, false, {
      maxConcurrentThreads: 4,
      activeNonRootTurns: 0,
    });

    expect(output).toContain('4 total concurrency slots');
    expect(output).toContain('root occupies one reserved slot');
    expect(output).toContain('3 child start slots are available');
    expect(output).toContain('HARD RUNTIME LIMIT FOR THIS ASSISTANT RESPONSE');
    expect(output).toContain('emit at most 3 `spawn_agent` calls');
    expect(output).toContain('must not claim that you are dispatching more Agents');
    expect(output.indexOf('ACTOR CAPACITY')).toBeLessThan(output.indexOf('PLAN-FIRST GUIDANCE'));
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
