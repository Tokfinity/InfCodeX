/**
 * Coding Agent declarations test — FEATURE_193 v0.7.43.
 *
 * The V1 chain (Scout/Planner/Generator) Coding Agent declarations were
 * retired in FEATURE_193. The whole identity/tool-wiring/topology test
 * surface was deleted along with the agents themselves.
 *
 * `CODING_AGENT_MARKER` survives as the canonical admission-contract
 * marker string; downstream tests assert against it via the
 * `Constructed` admission path (FEATURE_087+).
 */

import { describe, expect, it } from 'vitest';
import { CODING_AGENT_MARKER } from './coding-agents.js';

describe('CODING_AGENT_MARKER', () => {
  it('exports the canonical admission-contract marker string', () => {
    expect(typeof CODING_AGENT_MARKER).toBe('string');
    expect(CODING_AGENT_MARKER.length).toBeGreaterThan(0);
  });
});
