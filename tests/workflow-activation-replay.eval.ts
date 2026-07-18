/**
 * FEATURE_248 — AMAW orchestration directive, REAL-SESSION REPLAY probe
 * (Layer-3, per benchmark/EVAL_GUIDELINES.md + feedback_workflow_authoring_eval_needs_layer3).
 *
 * Why this exists (vs workflow-activation.eval.ts): the synthetic-seed probe cannot
 * reliably measure this behavior — the orchestration decision lands after plan-first
 * + scouting, and a truncated N-turn probe with `ok` tool stubs lets the model
 * re-plan/re-scout so the fan-out lands past the window (confirmed twice: the reverted
 * A+B' round and the mode-level pilot, both ~floored + confounded). This probe removes
 * that confound by replaying the ACTUAL dogfood session (20260702_131031) truncated to
 * the exact synthesis-decision boundary, with the REAL scouted tool_results in context
 * (a 52KB acp_server read, a 37KB read, the child's partial output, the full A2A spec
 * fetch). The model arrives at the decision with genuine accumulated evidence and no
 * reason to re-scout — the ONLY thing left is the synthesis-approach decision:
 * orchestrate the multi-dimensional design (run_workflow OR a dispatch fan-out) vs
 * write the whole thing solo. In the real run the model chose SOLO write (msg 13) —
 * exactly the gap FEATURE_248 targets.
 *
 * Fixture: benchmark/datasets/feature-248-a2a-design-replay.json — seed = messages
 * [0..12] of the real session (thinking stripped, tool_use/tool_result ids intact),
 * ending on a user tool_result turn so the next live assistant turn IS the decision.
 *
 * Design (bidirectional, byte-aligned — anti-pattern 8 §2):
 * - v_proposed = Worker system WITH `ORCHESTRATION DEFAULT` (amawOrchestrationAvailable
 *   true). v_baseline = WITHOUT it (false) — the real run's prompt shape. Tools identical
 *   (production amaw surface: run_workflow visible + DISPATCH_RUN_WORKFLOW_NUDGE appended).
 * - Metric: does the next turn (2-turn fallback) orchestrate PARALLEL multi-agent work —
 *   run_workflow OR >= 2 dispatch_child_task? `wf` (run_workflow-specific) is diagnostic.
 *
 * Pre-registered gate (panel >= 3):
 * - proposed parallel-rate >= 0.5 AND proposed - baseline >= 0.15 (real lift attributable
 *   to the directive, measured at the true decision boundary).
 * - If floored/no-lift across the panel here TOO, the premise is a model floor, not a
 *   measurement artifact — DEFER with evidence, do NOT lower the gate
 *   (feedback_pre_registered_gate_saturation / feedback_model_structural_floor_not_prompt_tunable).
 *
 * Run (pilot):  KODAX_EVAL_ALIASES=zhipu/glm52 KODAX_EVAL_RUNS=3 npm run test:eval -- tests/workflow-activation-replay.eval.ts
 * Run (panel):  KODAX_EVAL_ALIASES=zhipu/glm52,mmx/m3,ark/v4flash,kimi npm run test:eval -- tests/workflow-activation-replay.eval.ts
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';
import { getProvider } from '@kodax-ai/llm';
import type { KodaXMessage, KodaXToolDefinition } from '@kodax-ai/llm';
import { getAllRegisteredTools } from '@kodax-ai/coding';

import { getToolDefinition } from '../packages/coding/src/tools/index.js';
import { DISPATCH_RUN_WORKFLOW_NUDGE } from '../packages/coding/src/tools/tool-definitions.js';
import { createRolePrompt } from '../packages/coding/src/task-engine/_internal/managed-task/role-prompt.js';
import { buildFallbackRoutingDecision } from '../packages/coding/src/reasoning.js';
import type { ManagedRolePromptContext } from '../packages/coding/src/task-engine/_internal/managed-task/role-prompt-types.js';
import { availableAliases, resolveAlias } from '../benchmark/harness/aliases.js';
import type { ModelAlias } from '../benchmark/harness/aliases.js';

interface Fixture {
  _meta: { source: string; truncatedAtMsg: number; decision: string; messages: number };
  seed: KodaXMessage[];
}
const FIXTURE: Fixture = JSON.parse(
  readFileSync(join(process.cwd(), 'benchmark/datasets/feature-248-a2a-design-replay.json'), 'utf8'),
) as Fixture;
const SEED: KodaXMessage[] = FIXTURE.seed;
// The real user task (seed[0]) — used as the prompt's originalTask for fidelity.
const REAL_TASK = typeof SEED[0]?.content === 'string' ? SEED[0].content : 'A2Gate2A 框架设计';

const VARIANTS = ['baseline', 'proposed'] as const;
type Variant = (typeof VARIANTS)[number];

// Production AMAW tool surface, identical across variants: run_workflow visible +
// DISPATCH_RUN_WORKFLOW_NUDGE appended to dispatch_child_task (agent-chain.ts). The
// only thing that changes between variants is the system-prompt directive.
function amawTools(): KodaXToolDefinition[] {
  return getAllRegisteredTools().map((t) => {
    const base = { name: t.name, description: t.description, input_schema: t.input_schema };
    if (t.name === 'dispatch_child_task') {
      return { ...base, description: `${t.description} ${DISPATCH_RUN_WORKFLOW_NUDGE}` };
    }
    return base;
  });
}
const TOOLS = amawTools();

function workerSystem(variant: Variant): string {
  const decision = buildFallbackRoutingDecision(REAL_TASK);
  const ctx: ManagedRolePromptContext = {
    originalTask: REAL_TASK,
    workspace: {
      executionCwd: process.cwd(),
      gitRoot: process.cwd(),
      platform: process.platform,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    },
    amawOrchestrationAvailable: variant === 'proposed',
  };
  return createRolePrompt('worker', REAL_TASK, decision, undefined, undefined, 'kodax/role/worker', undefined, ctx, undefined, false);
}
const SYSTEM: Record<Variant, string> = {
  baseline: workerSystem('baseline'),
  proposed: workerSystem('proposed'),
};

const RUNS = Number.parseInt(process.env.KODAX_EVAL_RUNS ?? '5', 10);
// Small window: scouting is DONE in the seed, so the synthesis-approach decision
// should land in turn 1-2. Continuation tool_results are synthetic (`ok`) — only the
// FIRST 1-2 assistant turns after the real seed are measured.
const MAX_TURNS = Number.parseInt(process.env.KODAX_EVAL_TURNS ?? '2', 10);
const DUMP_DIR = join(tmpdir(), 'kodax-eval-dumps', 'workflow-activation-replay');

function resolvePanel(): ModelAlias[] {
  const raw = process.env.KODAX_EVAL_ALIASES;
  if (raw && raw.trim().length > 0) return availableAliases(...(raw.split(',').map((s) => s.trim()) as ModelAlias[]));
  // ark + kimi now available; mimo excluded (key returns 401).
  return availableAliases('zhipu/glm52', 'mmx/m3', 'ark/v4flash', 'kimi');
}

async function replayDecision(
  alias: ModelAlias,
  system: string,
): Promise<{ wf: boolean; dispatchCount: number; parallel: boolean; allTools: string[]; textSnippet: string }> {
  const provider = getProvider(resolveAlias(alias).provider);
  let msgs: KodaXMessage[] = [...SEED];
  const allTools: string[] = [];
  let lastText = '';
  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    const result = await provider.stream(msgs, TOOLS, system);
    allTools.push(...result.toolBlocks.map((b) => b.name));
    lastText = result.textBlocks.map((b) => b.text).join('\n');
    const wf = allTools.includes('run_workflow');
    const dispatchCount = allTools.filter((t) => t === 'dispatch_child_task').length;
    if (wf || dispatchCount >= 2 || result.toolBlocks.length === 0) break;
    msgs = [
      ...msgs,
      { role: 'assistant', content: [
        ...result.textBlocks.map((b) => ({ type: 'text' as const, text: b.text })),
        ...result.toolBlocks.map((b) => ({ type: 'tool_use' as const, id: b.id, name: b.name, input: b.input })),
      ] },
      { role: 'user', content: result.toolBlocks.map((b) => ({ type: 'tool_result' as const, tool_use_id: b.id, content: 'ok' })) },
    ] as KodaXMessage[];
  }
  const wf = allTools.includes('run_workflow');
  const dispatchCount = allTools.filter((t) => t === 'dispatch_child_task').length;
  return { wf, dispatchCount, parallel: wf || dispatchCount >= 2, allTools, textSnippet: lastText.slice(0, 400) };
}

describe('FEATURE_248 real-session replay — synthesis-approach orchestration decision', () => {
  const panel = resolvePanel();

  it.runIf(panel.length > 0)(
    'at the real A2A-design synthesis boundary, the directive lifts parallel orchestration',
    async () => {
      mkdirSync(DUMP_DIR, { recursive: true });
      expect(SYSTEM.baseline).not.toContain('ORCHESTRATION DEFAULT');
      expect(SYSTEM.proposed).toContain('ORCHESTRATION DEFAULT');
      expect(getToolDefinition('run_workflow')).toBeDefined();
      expect(SEED.length).toBeGreaterThan(10);
      expect(SEED[SEED.length - 1]?.role).toBe('user'); // next live turn = the decision

      const parallelRate = new Map<string, Map<ModelAlias, number>>();
      const wfRate = new Map<string, Map<ModelAlias, number>>();
      for (const variant of VARIANTS) {
        const system = SYSTEM[variant];
        const perParallel = new Map<ModelAlias, number>();
        const perWf = new Map<ModelAlias, number>();
        const aliasDumps: Array<{ alias: string; parallelRate: number; wfRate: number; runs: unknown[] }> = [];
        for (const alias of panel) {
          const runs: Array<{ runIndex: number; wf: boolean; dispatchCount: number; parallel: boolean; allTools: string[]; textSnippet: string }> = [];
          for (let i = 0; i < RUNS; i += 1) {
            try {
              runs.push({ runIndex: i, ...(await replayDecision(alias, system)) });
            } catch (error) {
              runs.push({ runIndex: i, wf: false, dispatchCount: 0, parallel: false, allTools: [], textSnippet: `ERROR: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}` });
            }
          }
          perParallel.set(alias, runs.filter((x) => x.parallel).length / Math.max(1, runs.length));
          perWf.set(alias, runs.filter((x) => x.wf).length / Math.max(1, runs.length));
          aliasDumps.push({ alias, parallelRate: perParallel.get(alias)!, wfRate: perWf.get(alias)!, runs });
        }
        parallelRate.set(variant, perParallel);
        wfRate.set(variant, perWf);
        writeFileSync(join(DUMP_DIR, `${variant}.json`), JSON.stringify({ variant, aliases: aliasDumps }, null, 2), 'utf8');
      }

      const mean = (map: Map<string, Map<ModelAlias, number>>, key: string): number => {
        const m = map.get(key)!;
        return panel.map((a) => m.get(a) ?? 0).reduce((s, x) => s + x, 0) / Math.max(1, panel.length);
      };
      const pct = (v: number): string => `${Math.round(v * 100)}`;
      // eslint-disable-next-line no-console
      console.log(
        `\n[FEATURE_248 replay] panel=${panel.join(',')} runs=${RUNS} turns=${MAX_TURNS}\n` +
        `parallel: base ${pct(mean(parallelRate, 'baseline'))}% -> prop ${pct(mean(parallelRate, 'proposed'))}%` +
        ` | run_workflow-specific: base ${pct(mean(wfRate, 'baseline'))}% -> prop ${pct(mean(wfRate, 'proposed'))}%\n` +
        panel.map((a) => `  ${a}: base ${pct(parallelRate.get('baseline')!.get(a) ?? 0)}% -> prop ${pct(parallelRate.get('proposed')!.get(a) ?? 0)}%`).join('\n') +
        `\nDumps: ${DUMP_DIR}\n`,
      );

      if (panel.length >= 3) {
        expect(mean(parallelRate, 'proposed'), 'proposed parallel activation >= 0.5').toBeGreaterThanOrEqual(0.5);
        expect(
          mean(parallelRate, 'proposed') - mean(parallelRate, 'baseline'),
          'lift >= 0.15',
        ).toBeGreaterThanOrEqual(0.15);
      }
    },
    1_800_000,
  );
});
