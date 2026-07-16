/**
 * FEATURE_101 v0.7.31.1 — builtin handoff resolution.
 *
 * Closes the silent degradation where a constructed agent handing off to
 * a builtin role got a stub target with empty instructions. The patch
 * resolves `builtin:<role>` refs to the real Agent declarations.
 *
 * FEATURE_184 (v0.7.42): evaluator removed from BUILTIN_AGENTS map.
 * FEATURE_193 (v0.7.43): V1 chain (scout/planner/generator) agents retired —
 * Worker is the only builtin agent now.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

import { _resetInvariantRegistry } from '@kodax-ai/agent';
import { workerAgent } from '../agents/task-engine-agents.js';

import { registerCodingInvariants } from '../agent-runtime/invariants/index.js';
import {
  configureRuntime,
  stage,
  testArtifact,
  activate,
  resolveConstructedAgent,
  _resetRuntimeForTesting,
} from './index.js';
import type { AgentArtifact } from './types.js';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-builtin-handoff-'));
  configureRuntime({
    cwd: tmpRoot,
    policy: async () => 'approve',
  });
  _resetInvariantRegistry();
  registerCodingInvariants();
});

afterEach(async () => {
  _resetRuntimeForTesting();
  _resetInvariantRegistry();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('agent-resolver — builtin handoff resolution', () => {
  it('lifts builtin:worker handoff to the real workerAgent declaration', async () => {
    const artifact: AgentArtifact = {
      kind: 'agent',
      name: 'wrapper-with-worker',
      version: '1.0.0',
      status: 'staged',
      createdAt: Date.now(),
      content: {
        instructions: 'wrapper that hands off to the real worker',
        handoffs: [{ target: { ref: 'builtin:worker' }, kind: 'continuation' }],
      },
    };
    const handle = await stage(artifact);
    const tested = await testArtifact(handle);
    expect(tested.ok).toBe(true);
    await activate(handle);

    const resolved = resolveConstructedAgent('wrapper-with-worker');
    expect(resolved).toBeDefined();
    const handoff = resolved!.handoffs?.[0];
    expect(handoff).toBeDefined();
    expect(handoff!.target.name).toBe(workerAgent.name);
    expect(handoff!.target.instructions).toBe(workerAgent.instructions);
  });

  it('resolves canonical kodax/role/worker form too', async () => {
    const artifact: AgentArtifact = {
      kind: 'agent',
      name: 'wrapper-canonical',
      version: '1.0.0',
      status: 'staged',
      createdAt: Date.now(),
      content: {
        instructions: 'wrapper with canonical ref form',
        handoffs: [
          { target: { ref: 'builtin:kodax/role/worker' }, kind: 'continuation' },
        ],
      },
    };
    const handle = await stage(artifact);
    expect((await testArtifact(handle)).ok).toBe(true);
    await activate(handle);
    const resolved = resolveConstructedAgent('wrapper-canonical');
    expect(resolved!.handoffs?.[0]?.target.name).toBe(workerAgent.name);
    expect(resolved!.handoffs?.[0]?.target.instructions).toBe(workerAgent.instructions);
  });

  it('falls back to a stub when builtin name is unknown', async () => {
    // Unknown builtin (not in the BUILTIN_AGENTS map). Admission still
    // passes because the stub has no outgoing edges; runtime sees the
    // stub instructions are empty.
    const artifact: AgentArtifact = {
      kind: 'agent',
      name: 'wrapper-unknown',
      version: '1.0.0',
      status: 'staged',
      createdAt: Date.now(),
      content: {
        instructions: 'wrapper to an unknown builtin',
        handoffs: [{ target: { ref: 'builtin:never-defined' }, kind: 'continuation' }],
      },
    };
    const handle = await stage(artifact);
    expect((await testArtifact(handle)).ok).toBe(true);
    await activate(handle);
    const resolved = resolveConstructedAgent('wrapper-unknown');
    expect(resolved!.handoffs?.[0]?.target.name).toBe('never-defined');
    expect(resolved!.handoffs?.[0]?.target.instructions).toBe('');
  });
});
