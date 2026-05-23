/**
 * C1 parity tests — `attemptProtocolTextFallback` + `getEmitToolNameForRole`.
 *
 * Scenario coverage mirrors the v0.7.22 call sites that consumed a
 * `?? parseManagedTask*Directive(text)` fallback when the LLM forgot to
 * call the emit tool but wrote a well-formed `kodax-task-*` block:
 *   - Scout    → emit_scout_verdict  (block: kodax-task-scout)
 *   - Planner  → emit_contract       (block: kodax-task-contract)
 *   - Evaluator → emit_verdict       (block: kodax-task-verdict, Sidecar slot)
 *
 * FEATURE_184 (v0.7.45) Phase C.3: Generator is now terminal (Sidecar Verifier
 * via StopHook). Evaluator `revise` without next_harness is terminal (no
 * in-chain agent to route back to).
 *
 * FEATURE_190 (v0.7.43) Phase 3: `emit_handoff` deleted. Generator and
 * Worker have no emit tool — `getEmitToolNameForRole` returns
 * `undefined` for both; the legacy `kodax-task-handoff` fenced-block
 * fallback path also no-ops (no tool to synthesize a call to).
 */

import { describe, expect, it } from 'vitest';
import {
  attemptProtocolTextFallback,
  findLastFencedBlock,
} from './parse-helpers.js';
// FEATURE_193 v0.7.43: getEmitToolNameForRole import removed (V1 role mapping describe deleted)

// FEATURE_193 v0.7.43: getEmitToolNameForRole describe deleted (V1 scout/planner/generator emit tool name mapping retired)

// FEATURE_193 v0.7.43: attemptProtocolTextFallback scout describe deleted (V1 chain retired)

// FEATURE_193 v0.7.43: attemptProtocolTextFallback planner (contract) describe deleted (V1 chain retired)

// FEATURE_193 v0.7.43: attemptProtocolTextFallback generator (handoff) describe deleted (V1 chain retired)

describe('attemptProtocolTextFallback — evaluator (verdict)', () => {
  it('parses a kodax-task-verdict block with accept status as terminal', () => {
    const text = [
      'Summary for the user here.',
      '',
      '```kodax-task-verdict',
      JSON.stringify({
        status: 'accept',
        reason: 'all criteria met',
        user_answer: 'Task complete.',
      }),
      '```',
    ].join('\n');
    const meta = attemptProtocolTextFallback('evaluator', text);
    expect(meta).toBeDefined();
    expect(meta!.payload.verdict?.status).toBe('accept');
    expect(meta!.payload.verdict?.userAnswer).toBe('Task complete.');
    expect(meta!.isTerminal).toBe(true);
  });

  it('parses a revise verdict (default: terminal — no in-chain re-run after FEATURE_184 C.1)', () => {
    const text = [
      '```kodax-task-verdict',
      JSON.stringify({ status: 'revise', reason: 'test coverage gap' }),
      '```',
    ].join('\n');
    const meta = attemptProtocolTextFallback('evaluator', text);
    expect(meta).toBeDefined();
    expect(meta!.payload.verdict?.status).toBe('revise');
    // FEATURE_184 (v0.7.45): without next_harness the revise path is
    // now terminal — the Sidecar Verifier owns the verdict slot and there
    // is no in-chain evaluator to route back to.
    expect(meta!.handoffTarget).toBeUndefined();
    expect(meta!.isTerminal).toBe(true);
  });

  // FEATURE_193 v0.7.43: revise+next_harness=H2 routes-back-to-planner it deleted (V1 planner role retired)

  it('propagates assistant text preceding the block into userFacingText', () => {
    const text = [
      'Here is the final answer for the user.',
      '',
      '```kodax-task-verdict',
      JSON.stringify({ status: 'accept' }),
      '```',
    ].join('\n');
    const meta = attemptProtocolTextFallback('evaluator', text);
    expect(meta!.payload.verdict?.userFacingText).toContain('Here is the final answer');
  });
});

describe('attemptProtocolTextFallback — negative edges', () => {
  // FEATURE_193 v0.7.43: prefers-last-fenced-block scout it deleted (V1 chain retired)

  it('returns undefined for an unknown role', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(attemptProtocolTextFallback('direct' as any, 'x')).toBeUndefined();
  });
});

// FEATURE_193 v0.7.43: findLastFencedBlock tests migrated from kodax-task-scout/handoff to kodax-task-verdict (V1 chain retired)
describe('findLastFencedBlock — FEATURE_060 Track 1: tail-only scan for large texts', () => {
  it('matches a fenced block at the very end of a large text without scanning the leading portion', () => {
    // Build a 200KB filler that contains lookalike syntax — the scanner
    // must still find ONLY the trailing legitimate block.
    const filler = '`'.repeat(200_000);
    const tail = '\n```kodax-task-verdict\n{"status":"accept"}\n```\n';
    const text = filler + tail;

    const block = findLastFencedBlock(text, 'kodax-task-verdict');
    expect(block).toBeDefined();
    expect(block!.body).toBe('{"status":"accept"}');
    // index points into the original full-text coordinate space.
    expect(block!.index).toBeGreaterThanOrEqual(filler.length);
    expect(text.slice(0, block!.index)).toMatch(/`{1,}/);
  });

  it('returns undefined when no fenced block exists in the tail window of a huge text', () => {
    // 200KB of unrelated text, then a block well before the tail window —
    // the tail-only scan should not see it.
    const earlyBlock = '```kodax-task-verdict\n{"status":"accept"}\n```\n';
    const tailFiller = 'x'.repeat(200_000);
    const text = earlyBlock + tailFiller;

    const block = findLastFencedBlock(text, 'kodax-task-verdict');
    expect(block).toBeUndefined();
  });

  it('full-text scan path: small text below the threshold scans the entire payload', () => {
    // Threshold is 128KB; this test stays well under to exercise the
    // non-tail path explicitly.
    const text = [
      'lots of preamble',
      '',
      '```kodax-task-verdict',
      '{"status":"accept"}',
      '```',
      '',
      'trailing content',
    ].join('\n');

    const block = findLastFencedBlock(text, 'kodax-task-verdict');
    expect(block).toBeDefined();
    expect(block!.body).toBe('{"status":"accept"}');
  });

  it('with a fenced block straddling the tail boundary, the tail scan still finds it (block is in the tail window)', () => {
    // Build a 130KB prefix + a small tail with the block — the entire
    // block is inside the tail window so it gets matched.
    const prefix = 'a'.repeat(130_000);
    const tail = '```kodax-task-verdict\n{"status":"blocked"}\n```\n';
    const text = prefix + '\n' + tail;

    const block = findLastFencedBlock(text, 'kodax-task-verdict');
    expect(block).toBeDefined();
    expect(block!.body).toBe('{"status":"blocked"}');
    // index in full-text coordinates.
    expect(text.slice(block!.index, block!.index + 4)).toBe('```k');
  });
});
