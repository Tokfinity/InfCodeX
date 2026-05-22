/**
 * FEATURE_187 (v0.7.43) Phase A — byte-identity prompt lock.
 *
 * The FEATURE_178 stall sidecar's SHIP-SIDECAR-ALL eval verdict
 * (`benchmark/datasets/feature-178-stall-sidecar/` panel `1909d5d2`,
 * 149/150 PASS across 5 canonical aliases, 0% audit disagreement) is
 * pinned to the EXACT wording of three prompt assets:
 *
 *   1. `SIDECAR_SYSTEM_PROMPT` — the verifier role prompt
 *   2. `REPORT_TOOL`           — the `report_stall_judgment` schema
 *   3. `buildSidecarUserMessage` — the user-message rendering function
 *
 * Phase A of FEATURE_187 moves these assets from
 * `multi-instance/stall-sidecar-prompts.ts` to
 * `agent-runtime/middleware/stall-sidecar/prompts.ts` (pure plumbing).
 * **No content change is permitted in Phase A** — this file pins each
 * asset's output to a snapshot so any accidental drift fails the build
 * before the eval becomes invalid.
 *
 * If a future feature DOES need to change a prompt asset, the workflow is:
 *   1. Update the prompt in `prompts.ts`
 *   2. Update the snapshot here (`-u` flag) — deliberate act
 *   3. Re-run the F178 Layer 2 panel on the canonical 5-alias suite
 *   4. Document the new eval evidence in `docs/features/v0.7.x.md`
 *
 * This file makes step 2 a deliberate snapshot bump rather than a silent
 * regression, mirroring the policy `feedback_canonical_eval_alias_panel`
 * established for other LLM-facing prompt changes.
 */

import { describe, it, expect } from 'vitest';
import type { KodaXMessage } from '@kodax-ai/llm';

import {
  REPORT_TOOL,
  SIDECAR_SYSTEM_PROMPT,
  buildSidecarUserMessage,
} from './prompts.js';

describe('FEATURE_187 Phase A — byte-identity prompt lock for F178 eval 1909d5d2', () => {
  it('SIDECAR_SYSTEM_PROMPT matches snapshot (F178 SHIP-SIDECAR-ALL baseline)', () => {
    // Snapshot pins the EXACT string. Any change here invalidates the
    // F178 eval evidence and MUST be accompanied by a fresh Layer 2
    // panel run on the canonical 5-alias suite.
    expect(SIDECAR_SYSTEM_PROMPT).toMatchSnapshot();
  });

  it('REPORT_TOOL schema matches snapshot (tool schema byte-identical)', () => {
    expect(REPORT_TOOL).toMatchSnapshot();
  });

  it('buildSidecarUserMessage output matches snapshot for canonical sample', () => {
    // Canonical sample exercising both the signalEnvelope passthrough
    // and the transcript-rendering branches the eval cases hit.
    const messages: readonly KodaXMessage[] = [
      {
        role: 'user',
        content: 'Find every place we read package.json.',
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will use grep.' },
          {
            type: 'tool_use',
            id: 'tool_1',
            name: 'grep',
            input: { pattern: 'package.json', glob: '**/*' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool_1',
            content: 'src/cli/main.ts:12:import pkg from "../../package.json";',
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me grep again with a different scope.' },
          {
            type: 'tool_use',
            id: 'tool_2',
            name: 'grep',
            input: { pattern: 'package.json', glob: '**/*' },
          },
        ],
      },
    ];

    const sample = buildSidecarUserMessage({
      signalEnvelope:
        '=== L1 SIGNAL ===\nkind: repeat-identical-call\ntool: grep\ncount: 2',
      recentMessages: messages,
    });

    expect(sample).toMatchSnapshot();
  });
});
