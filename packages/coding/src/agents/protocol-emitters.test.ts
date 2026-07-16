/**
 * Protocol emitter tool tests — FEATURE_084 Shard 2 (v0.7.26).
 *
 * Verifies that each emit tool:
 *   1. Has the expected tool name + required input fields
 *   2. Normalizes valid payloads via `coerceManagedProtocolToolPayload`
 *   3. Returns the normalized payload under `metadata.payload`
 *   4. Surfaces `isError: true` when the payload cannot be normalized
 *   5. Produces payloads IDENTICAL to what the legacy fenced-block parser
 *      would emit for the same JSON (parity contract)
 */

import { describe, expect, it } from 'vitest';
import type { ProtocolEmitterMetadata } from './protocol-emitters.js';
import {
  // FEATURE_193 (v0.7.43): EMIT_SCOUT_VERDICT_TOOL_NAME / emitScoutVerdict +
  // EMIT_CONTRACT_TOOL_NAME / emitContract deleted — V1 chain roles retired.
  EMIT_VERDICT_TOOL_NAME,
  PROTOCOL_EMITTER_TOOLS,
  emitVerdict,
} from './protocol-emitters.js';
import { coerceManagedProtocolToolPayload } from '../managed-protocol.js';

function runExecute(tool: typeof emitVerdict, input: Record<string, unknown>) {
  return tool.execute(input, { agent: { name: 'test', instructions: '' } });
}

describe('protocol emitters — tool shapes', () => {
  // FEATURE_193 (v0.7.43): shrank from 3 to 1 — emitScoutVerdict + emitContract
  // deleted with V1 chain retirement. Only emitVerdict (Sidecar Verifier) remains.
  it('exposes the one expected tool name (emitVerdict)', () => {
    expect(emitVerdict.name).toBe(EMIT_VERDICT_TOOL_NAME);
    expect(PROTOCOL_EMITTER_TOOLS).toHaveLength(1);
  });

  it('declares an execute function on each tool', () => {
    for (const tool of PROTOCOL_EMITTER_TOOLS) {
      expect(typeof tool.execute).toBe('function');
    }
  });

  it('requires status on evaluator', () => {
    expect(emitVerdict.input_schema.required).toContain('status');
  });

  it('enumerates the status on evaluator', () => {
    const verdictStatusEnum = (emitVerdict.input_schema.properties as Record<string, { enum?: string[] }>)
      .status?.enum;
    expect(verdictStatusEnum).toEqual(['accept', 'revise', 'blocked']);
  });
});

// FEATURE_193 v0.7.43: protocol emitters scout describe deleted (V1 chain retired)
// FEATURE_193 v0.7.43: protocol emitters planner (contract) describe deleted (V1 chain retired)

// FEATURE_190 (v0.7.43) Phase 3: `emitHandoff` deleted. Worker/Generator
// terminate text-only. The `coerceManagedProtocolToolPayload('generator',
// ...)` normalizer is still exercised by the parity test below (legacy
// fenced-block fallback parser path), but no tool wraps it any more.

describe('protocol emitters — evaluator (verdict)', () => {
  it('normalizes an accept verdict with user_answer', async () => {
    const result = await runExecute(emitVerdict, {
      status: 'accept',
      reason: 'All tests pass',
      user_answer: 'Login endpoint added at POST /auth/login.',
      followup: [],
    });
    expect(result.isError).toBeUndefined();
    const meta = result.metadata as unknown as ProtocolEmitterMetadata;
    expect(meta.role).toBe('evaluator');
    expect(meta.payload.verdict?.status).toBe('accept');
    expect(meta.payload.verdict?.userAnswer).toMatch(/Login endpoint added/);
  });

  it('normalizes a revise verdict with next_harness escalation', async () => {
    const result = await runExecute(emitVerdict, {
      status: 'revise',
      reason: 'Scope larger than anticipated',
      next_harness: 'H2_PLAN_EXECUTE_EVAL',
    });
    expect(result.isError).toBeUndefined();
    const meta = result.metadata as unknown as ProtocolEmitterMetadata;
    expect(meta.payload.verdict?.status).toBe('revise');
    expect(meta.payload.verdict?.nextHarness).toBe('H2_PLAN_EXECUTE_EVAL');
  });

  it('surfaces is_error when status is missing', async () => {
    const result = await runExecute(emitVerdict, { reason: 'no status' });
    expect(result.isError).toBe(true);
  });
});

describe('protocol emitters — handoff target resolution (Shard 4)', () => {
  // FEATURE_193 v0.7.43: scout H0/H1/H2 and planner contract its deleted (V1 chain retired)

  // FEATURE_190 (v0.7.43) Phase 3: the previous "generator handoff →
  // terminal" assertion exercised the deleted `emitHandoff` tool — the
  // resolveHandoffTarget('generator', ...) function (still exported)
  // remains terminal for the parser-fallback path and is covered by the
  // parity test below.

  it('evaluator accept → no handoffTarget, isTerminal=true', async () => {
    const result = await runExecute(emitVerdict, { status: 'accept', user_answer: 'done' });
    const meta = result.metadata as unknown as ProtocolEmitterMetadata;
    expect(meta.handoffTarget).toBeUndefined();
    expect(meta.isTerminal).toBe(true);
  });

  it('evaluator blocked → no handoffTarget, isTerminal=true', async () => {
    const result = await runExecute(emitVerdict, { status: 'blocked', reason: 'needs auth' });
    const meta = result.metadata as unknown as ProtocolEmitterMetadata;
    expect(meta.handoffTarget).toBeUndefined();
    expect(meta.isTerminal).toBe(true);
  });

  // FEATURE_184 Phase C.1 (v0.7.45): evaluator revise (H1) with no
  // nextHarness no longer routes back to generator — Evaluator removed
  // from chain; sidecar verifier uses a different routing path.
  it('evaluator revise (default, no nextHarness) → isTerminal=true (FEATURE_184 C.1)', async () => {
    const result = await runExecute(emitVerdict, { status: 'revise' });
    const meta = result.metadata as unknown as ProtocolEmitterMetadata;
    expect(meta.handoffTarget).toBeUndefined();
    expect(meta.isTerminal).toBe(true);
  });

  // FEATURE_193 (v0.7.43): next_harness=H2 → planner routing deleted with
  // V1 chain retirement. revise+H2 is now terminal (same as all revise).
  it('evaluator revise with next_harness=H2 → isTerminal=true (planner retired)', async () => {
    const result = await runExecute(emitVerdict, { status: 'revise', next_harness: 'H2' });
    const meta = result.metadata as unknown as ProtocolEmitterMetadata;
    expect(meta.handoffTarget).toBeUndefined();
    expect(meta.isTerminal).toBe(true);
  });
});

describe('protocol emitters — parity with legacy parser', () => {
  // FEATURE_193 v0.7.43: scout parity it deleted (V1 chain retired)

  it('evaluator payload is byte-equivalent to legacy for revise + next_harness', async () => {
    const input = { status: 'revise', next_harness: 'H2', reason: 'scope grew' };
    const result = await runExecute(emitVerdict, input);
    const meta = result.metadata as unknown as ProtocolEmitterMetadata;
    const legacy = coerceManagedProtocolToolPayload('evaluator', input);
    expect(meta.payload).toEqual(legacy);
  });

  // FEATURE_190 (v0.7.43) Phase 3: `emitHandoff` deleted. The
  // `coerceManagedProtocolToolPayload('generator', ...)` normalizer is
  // still reachable via the fenced-block fallback parser; the parser
  // tests in parse-helpers.test.ts pin its behavior on that path.
});

// FEATURE_193 v0.7.43: coerceManagedProtocolToolPayload FEATURE_097 skill_map regression describe deleted (V1 scout role retired)
