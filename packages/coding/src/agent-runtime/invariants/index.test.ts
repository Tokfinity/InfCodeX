/**
 * FEATURE_101 — `registerCodingInvariants` bootstrap test.
 *
 * Verifies that calling the bootstrap registers the full v1 set
 * (4 core pure + 4 coding capability-coupled = 8 ids) on the shared
 * runtime registry.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  _resetInvariantRegistry,
  listRegisteredInvariants,
  Runner,
  createAgent,
} from '@kodax-ai/agent';
import type { AgentManifest } from '@kodax-ai/agent';

import { registerCodingInvariants } from './index.js';

describe('registerCodingInvariants', () => {
  afterEach(() => _resetInvariantRegistry());

  it('registers all 9 v1+v2 invariants in canonical order', () => {
    _resetInvariantRegistry();
    registerCodingInvariants();
    expect(listRegisteredInvariants()).toEqual([
      // Pure core (registered first by registerCoreInvariants).
      'finalOwner',
      'handoffLegality',
      'evidenceTrail',
      // Coding capability-coupled + coding-AMA-specific.
      // v0.7.35.1 FEATURE_142 (A-R2): harnessSelectionTiming moved from
      // @kodax-ai/agent's pure-core set into coding's invariant chain
      // (registered last alongside the capability-coupled four).
      'budgetCeiling',
      'toolPermission',
      'boundedRevise',
      'independentReview',
      'harnessSelectionTiming',
      // v0.7.36 FEATURE_114: planBeforeMutate — V2 plan-first
      // observation. Coexists with harnessSelectionTiming during the
      // V1↔V2 migration window.
      'planBeforeMutate',
    ]);
  });

  it('after registration, Runner.admit produces a 7-id binding for a minimal manifest', async () => {
    _resetInvariantRegistry();
    registerCodingInvariants();
    const manifest: AgentManifest = createAgent({ name: 'm', instructions: 'i' });
    const verdict = await Runner.admit(manifest);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      // The 7 admission v1 closed-set ids — harnessSelectionTiming is NOT
      // in the required set, so it appears in bindings only when
      // explicitly declared.
      expect(verdict.handle.invariantBindings).toEqual([
        'finalOwner',
        'handoffLegality',
        'budgetCeiling',
        'toolPermission',
        'evidenceTrail',
        'boundedRevise',
        'independentReview',
      ]);
    }
  });
});
