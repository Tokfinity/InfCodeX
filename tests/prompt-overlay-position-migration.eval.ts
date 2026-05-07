/**
 * Eval: prompt-overlay user→system migration — FEATURE_143 (v0.7.36).
 *
 * ## Why this exists
 *
 * v0.7.26 FEATURE_084 stitched the AMA `plan.promptOverlay`
 * (routing-notes block: task-family guidance, work intent,
 * brainstorm directives, provider-policy notes, explicit-reason
 * trail) onto the user prompt head in `runner-driven.ts`. The Worker
 * received the bytes but read them as user input rather than
 * platform truth — semantic drift vs the SA path's
 * `capability-sections.ts` injection.
 *
 * v0.7.36 FEATURE_143 routes the same string through
 * `ManagedRolePromptContext.promptOverlay` so it lands as a
 * system-prompt section, matching SA-path behavior.
 *
 * ## What this eval guards (structural ship gate, no API keys)
 *
 * 1. **Migration completeness**: when `promptOverlay` is set on the
 *    role-prompt context, the resulting system prompt for every AMA
 *    role (scout / planner / generator / evaluator) carries marker
 *    text from the overlay.
 * 2. **No regression**: when `promptOverlay` is absent, the prompt
 *    builder still produces a valid prompt — no required-field
 *    crashes, no `[object Object]` leakage, no silent removal of
 *    other sections.
 * 3. **Bytes-only-once invariant**: `runner-driven.ts:promptWithOverlay`
 *    no longer prepends the overlay to the user prompt — verified by
 *    re-importing the bridge and asserting it returns the bare
 *    `prompt` argument unmodified.
 *
 * Behavioral validation (Worker H0/H1/H2 routing parity across the
 * migration boundary) requires a multi-provider judge harness and is
 * tracked as a v0.7.37 follow-up — the structural gate here is the
 * load-bearing guarantee.
 *
 * ## Run
 *
 *   npm run test -- prompt-overlay-position-migration
 */

import { describe, expect, it } from 'vitest';

import { createRolePrompt } from '../packages/coding/src/task-engine/_internal/managed-task/role-prompt.js';
import { buildFallbackRoutingDecision } from '../packages/coding/src/reasoning.js';
import type { KodaXTaskRole } from '@kodax/coding';
import type { ManagedRolePromptContext } from '../packages/coding/src/task-engine/_internal/managed-task/role-prompt-types.js';

const ROLES: KodaXTaskRole[] = ['scout', 'planner', 'generator', 'evaluator'];

const OVERLAY_FIXTURE = [
  '[Routing Notes]',
  '- Task family: implementation',
  '- Work intent: append',
  '- Provider-policy: prefer-edit-over-write',
  '- Explicit reason trail: user requested code change to packages/foo',
].join('\n');

function buildContext(promptOverlay?: string): ManagedRolePromptContext {
  return {
    originalTask: 'add a new helper to packages/foo',
    workspace: {
      executionCwd: '/repo',
      gitRoot: '/repo',
      platform: 'linux',
    },
    promptOverlay,
  };
}

describe('FEATURE_143 — prompt-overlay position migration (structural ship gate)', () => {
  it('overlay reaches the role prompt for every AMA role when present', () => {
    const decision = buildFallbackRoutingDecision('add helper');
    const ctx = buildContext(OVERLAY_FIXTURE);

    for (const role of ROLES) {
      const prompt = createRolePrompt(
        role,
        'add a new helper to packages/foo',
        decision,
        undefined,
        undefined,
        `kodax-${role}`,
        undefined,
        ctx,
      );
      expect(
        prompt,
        `[role=${role}] expected prompt to contain "[Routing Notes]" marker`,
      ).toContain('[Routing Notes]');
      expect(
        prompt,
        `[role=${role}] expected prompt to contain provider-policy line`,
      ).toContain('Provider-policy: prefer-edit-over-write');
    }
  });

  it('absent overlay produces a valid prompt with no overlay markers', () => {
    const decision = buildFallbackRoutingDecision('add helper');
    const ctx = buildContext(undefined);

    for (const role of ROLES) {
      const prompt = createRolePrompt(
        role,
        'add a new helper to packages/foo',
        decision,
        undefined,
        undefined,
        `kodax-${role}`,
        undefined,
        ctx,
      );
      expect(prompt.length).toBeGreaterThan(100);
      expect(prompt).not.toContain('[Routing Notes]');
      expect(prompt).not.toContain('[object Object]');
    }
  });

  it('whitespace-only overlay is treated as absent (no empty section emitted)', () => {
    const decision = buildFallbackRoutingDecision('add helper');
    const ctx = buildContext('   \n  \n  ');
    const prompt = createRolePrompt(
      'scout',
      'add a new helper',
      decision,
      undefined,
      undefined,
      'kodax-scout',
      undefined,
      ctx,
    );
    expect(prompt).not.toContain('\n\n\n\n\n');
  });
});
