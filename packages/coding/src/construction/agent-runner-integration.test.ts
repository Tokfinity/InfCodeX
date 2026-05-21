/**
 * FEATURE_089 Phase 3.4 — end-to-end test: stage → admit → activate
 * → resolve → Runner.run.
 *
 * Boots an LLM-emitted agent manifest through the full lifecycle and
 * confirms the resolved Agent is runnable via `Runner.run` with a
 * scripted LLM callback. This is the canonical integration scenario
 * called out in the FEATURE_089 §Testing block:
 *
 *   > 集成：coding agent 生成一个简单 agent (如 "echo-agent") → sandbox
 *   > test → activate → 后续 Runner.run 可用
 *
 * (The sandbox-test step lands in Phase 3.5; this test exercises the
 * non-sandbox baseline so the resolver wiring is locked in first.)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';

import { Runner, _resetInvariantRegistry } from '@kodax-ai/agent';
import type { AgentMessage, RunnerLlmResult } from '@kodax-ai/agent';

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
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-agent-e2e-'));
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

describe('FEATURE_089 — stage → admit → activate → Runner.run roundtrip', () => {
  it('admits + activates an echo-agent and Runner.run drives it through one turn', async () => {
    const artifact: AgentArtifact = {
      kind: 'agent',
      name: 'echo-agent',
      version: '1.0.0',
      status: 'staged',
      createdAt: Date.now(),
      content: {
        instructions:
          'You are a friendly echo agent. Repeat every user message back to them, prefixed with "echo: ".',
        reasoning: { default: 'quick' },
      },
    };

    // 1. Stage
    const handle = await stage(artifact);
    expect(handle.artifact.status).toBe('staged');

    // 2. Test (runs admission internally)
    const testResult = await testArtifact(handle);
    expect(testResult.ok).toBe(true);

    // 3. Activate (runs policy gate, populates resolver)
    await activate(handle);

    // 4. Resolve
    const resolved = resolveConstructedAgent('echo-agent');
    expect(resolved).toBeDefined();
    expect(resolved?.name).toBe('echo-agent');

    // 5. Run with a scripted llm callback that mirrors the user message.
    const llm = async (
      messages: readonly AgentMessage[],
    ): Promise<RunnerLlmResult> => {
      const last = messages[messages.length - 1];
      const userText =
        typeof last?.content === 'string'
          ? last.content
          : Array.isArray(last?.content)
            ? (last.content
                .map((b) => (b as { text?: string }).text)
                .filter(Boolean)
                .join('') as string)
            : '';
      return { text: `echo: ${userText}`, toolCalls: [] };
    };

    const result = await Runner.run(resolved!, 'hello world', {
      llm,
      tracer: null,
    });
    expect(result.output).toBe('echo: hello world');
  });

  // FEATURE_184 Phase C.1 (v0.7.45): Deleted "reject from admission prevents
  // activation (Generator without Evaluator)" test — that test relied on
  // `independentReview` rejecting a generator-bearing manifest that had no
  // evaluator handoff. independentReview has been removed from the admission
  // closed set (superseded by Sidecar Verifier StopHook), so
  // generator-bearing manifests are now valid and admission succeeds.

  it('reject from admission prevents activation when budget exceeds system cap', async () => {
    // Use budgetCeiling (still in the closed set) as the rejection driver:
    // a manifest whose maxBudget exceeds the system cap gets clamped on
    // admit, then testArtifact succeeds (clamping is not rejection). Use
    // a clearly malformed manifest to trigger schema-level rejection instead.
    const artifact: AgentArtifact = {
      kind: 'agent',
      name: 'malformed-no-instructions',
      version: '1.0.0',
      status: 'staged',
      createdAt: Date.now(),
      content: {
        // Missing instructions triggers schema validation failure.
        instructions: '',
      },
    };
    const handle = await stage(artifact);
    const testResult = await testArtifact(handle);
    // Schema validation rejects empty instructions.
    expect(testResult.ok).toBe(false);

    // activate must fail because testedAt was never set.
    await expect(activate(handle)).rejects.toThrow(/has not passed test/);

    // Resolver does NOT contain the agent.
    expect(resolveConstructedAgent('malformed-no-instructions')).toBeUndefined();
  });
});
