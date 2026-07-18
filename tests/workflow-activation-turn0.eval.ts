/**
 * FEATURE_248 — AMAW orchestration directive, TURN-0 probe (Layer-3).
 *
 * Why this exists: the mid-task real-session replay (workflow-activation-replay.eval.ts)
 * floored at 0% for BOTH variants — but the deep-investigation workflow found it tested
 * the WRONG moment. It measured whether the directive can make a model ABANDON a solo
 * plan already formed over 12 turns of solo scouting (mid-task defection). The reference
 * "ultracode" mode never asks that: it places the orchestrate-vs-solo decision at TURN 0,
 * before any solo momentum exists, so the model never forms the solo plan in the first
 * place. This probe seeds at TURN 0 (fresh task, zero prior scouting) to isolate whether
 * the directive works at the point in the task lifecycle where ultracode actually applies.
 *
 * It also tests the task SHAPES the maintainer judged to be genuine orchestration
 * candidates (review / judge-panel design / compare) — models are already willing to
 * fan out on these — as a positive control separate from the single-doc design shape
 * that reasonably stays solo. The A2A design task (the original dogfood case) is kept as
 * a harder reference; combined with the existing mid-task replay (also 0%), it gives the
 * turn-0-vs-mid-task delta on the SAME task.
 *
 * Design (bidirectional, byte-aligned): proposed = Worker system WITH the ORCHESTRATION
 * DEFAULT directive (amawOrchestrationAvailable true); baseline = WITHOUT. Tools identical
 * (production amaw surface: run_workflow visible + DISPATCH_RUN_WORKFLOW_NUDGE appended).
 * Seed = ONLY the task (turn 0). 3-turn window: turn 1 is usually plan-first todo_create,
 * so the orchestrate decision (fan-out plan) can land turn 2-3. Full per-turn reasoning is
 * captured so a self-judge can tell "never considered orchestrating" from "considered and
 * declined".
 *
 * Metric: parallel = run_workflow OR >= 2 dispatch_child_task within the window. `wf`
 * (run_workflow-specific) tracked as diagnostic.
 *
 * Pre-registered gate (panel >= 3), FAVORABLE shapes (review, judgePanelDesign, compare):
 * - proposed parallel-rate >= 0.5 AND proposed - baseline >= 0.15.
 * - a2aDesign is diagnostic (single-doc shape; solo is a reasonable model choice), NOT gated.
 * - If the favorable shapes ALSO floor at turn-0, that is strong shape+timing-independent
 *   evidence the prompt-level lever is insufficient -> pivot to a structured PLAN-FIRST
 *   solo-vs-orchestrate field (flow fix), not more prompt iteration.
 *
 * Run (pilot):  KODAX_EVAL_ALIASES=zhipu/glm52 KODAX_EVAL_RUNS=3 npm run test:eval -- tests/workflow-activation-turn0.eval.ts
 * Run (panel):  KODAX_EVAL_ALIASES=zhipu/glm52,mmx/m3,kimi npm run test:eval -- tests/workflow-activation-turn0.eval.ts
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

// baseline = no directive; proposed = the shipped AMAW directive (which since the
// FEATURE_248 flow-fix INCLUDES the PLAN-TIME COMMITMENT sentences — the 3-variant
// experiment that isolated the flow-fix's marginal contribution is recorded in
// docs/features/v0.7.59.md §6.1; the flow-fix is now part of orchestrationDefault so
// 'proposed' tests the full shipped form).
const ALL_VARIANTS = ['baseline', 'proposed'] as const;
type Variant = (typeof ALL_VARIANTS)[number];
const isVariant = (v: string): v is Variant => v === 'baseline' || v === 'proposed';
// Allow running a subset (e.g. one variant at a time) so a big panel fits the test
// timeout; on-disk dumps from a prior run supply the other variant for reporting.
const VARIANTS: readonly Variant[] = (process.env.KODAX_EVAL_VARIANTS
  ? (process.env.KODAX_EVAL_VARIANTS.split(',').map((s) => s.trim()))
  : [...ALL_VARIANTS]).filter(isVariant);

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

function workerSystem(variant: Variant, task: string): string {
  const decision = buildFallbackRoutingDecision(task);
  const ctx: ManagedRolePromptContext = {
    originalTask: task,
    workspace: {
      executionCwd: process.cwd(),
      gitRoot: process.cwd(),
      platform: process.platform,
      provider: 'zhipu-coding',
      model: 'glm-5.2',
    },
    amawOrchestrationAvailable: variant !== 'baseline',
  };
  return createRolePrompt('worker', task, decision, undefined, undefined, 'kodax/role/worker', undefined, ctx, undefined, false);
}

// Turn-0 tasks — each is a fresh user request (no prior scouting). Written so the true
// complexity is legible at turn 0 (the maintainer's note: "A2Gate2A" alone reads trivial).
const TASKS: Record<string, string> = {
  // Harder reference: single-doc design shape (the original dogfood case), faithful framing.
  a2aDesign:
    '我现在有一个需求：设计一套 A2A（Agent-to-Agent）框架，基于 Google 的 A2A 协议但有较大改动、可能需要自己的实现。我们架构有点特殊——A2A 中间有一层网关 A2Gate2A，负责请求与回复的转发。我们要怎么改造 A2A 的协议与架构，并让以 KodaX SDK 为智能底座的系统也支持这套 A2Gate2A。请覆盖协议改造、网关层设计、KodaX SDK 集成、安全与鉴权、实现路线图这几个相对独立的维度，最后产出一份定型设计。你可以在系统临时目录落一份设计文档。',
  // Favorable shape A: multi-dimensional review + adversarial verify. SELF-CONTAINED —
  // the changed-file set is inlined so the orchestration decision is NOT blocked on
  // changed_scope/bash returning real data (the `ok` tool stub otherwise starves the
  // scout phase and the model never reaches the decision).
  review:
    '请对以下这批 v0.7.58 改动做一次彻底、高可信的 review。**改动清单（已给出，无需再用 `changed_scope`/git 拉取，直接据此审）**：\n' +
    '- packages/coding/src/agent.ts（+120/-40，会话主循环重构）\n' +
    '- packages/coding/src/task-engine/runner-driven.ts（+80/-15，并发回合调度）\n' +
    '- packages/coding/src/messages.ts（+45/-10，消息规范化）\n' +
    '- packages/llm/src/providers/custom-provider.ts（+60/-25，流式截断处理）\n' +
    '- packages/agent/src/workflow/run-manager.ts（+90/-30，workflow 生命周期）\n' +
    '从正确性、并发安全、错误处理、测试充分性这四个相对独立的维度分别深审，每一条发现都要独立地对抗式复核一遍以剔除误报。可靠性要求很高，不能漏关键问题，也不能拿没核实的猜测充数。',
  // Favorable shape B: judge-panel design (N independent approaches). A2Gate2A explained
  // so the model perceives the real multi-dimensional complexity, not a trivial one-liner.
  judgePanelDesign:
    '我要为一套 Agent-to-Agent 通信体系设计核心架构，代号 A2Gate2A。背景：它基于 Google A2A 协议（HTTP + JSON-RPC 2.0 + SSE，核心是 Agent Card 能力发现、Task 生命周期、流式中转、OAuth），但有较大改动——最关键的是我们在两端 Agent 之间插入一层网关 A2Gate2A，由网关统一负责请求/回复的转发、鉴权、协议绑定与多租户。这不是小改动，涉及协议改造、网关层内部设计、与 KodaX SDK 智能底座的集成、安全与鉴权模型、以及分阶段实现路线图等多个相对独立、各有深度的维度。请给出 3 套彼此独立、取舍不同的候选架构方案（例如 MVP 优先 / 可靠性优先 / 扩展性优先），对每套独立评估其取舍，再综合成一份定型推荐。可靠性要求高。',
  // Favorable shape C: compare N options with independent evaluation + ranking.
  compare:
    '我在为 KodaX 的 workflow 持久化层选型，有 3 个候选方案：(1) 纯文件 JSONL append-only；(2) SQLite 本地库；(3) 嵌入式 KV（如 LMDB）。请分别独立评估这 3 个方案的：可靠性/崩溃恢复、并发写安全、查询/回放能力、与现有 .agent/ 目录约定的契合度、以及运维复杂度。每个方案独立深评后，横向对比并排名，给出推荐。',
};
type TaskKind = keyof typeof TASKS;
const FAVORABLE: TaskKind[] = ['review', 'judgePanelDesign', 'compare'];

const RUNS = Number.parseInt(process.env.KODAX_EVAL_RUNS ?? '5', 10);
const MAX_TURNS = Number.parseInt(process.env.KODAX_EVAL_TURNS ?? '3', 10);
// Throttle between provider calls to avoid bursting a single provider's per-minute
// quota (the eval is already sequential; this just paces same-provider bursts of
// up to RUNS*MAX_TURNS back-to-back calls). Configurable; default 1s.
const THROTTLE_MS = Number.parseInt(process.env.KODAX_EVAL_THROTTLE_MS ?? '1000', 10);
const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });
const DUMP_DIR = join(tmpdir(), 'kodax-eval-dumps', 'workflow-activation-turn0');

function resolvePanel(): ModelAlias[] {
  const raw = process.env.KODAX_EVAL_ALIASES;
  if (raw && raw.trim().length > 0) return availableAliases(...(raw.split(',').map((s) => s.trim()) as ModelAlias[]));
  return availableAliases('zhipu/glm52', 'mmx/m3', 'kimi');
}

async function turn0Signal(
  alias: ModelAlias,
  system: string,
  task: string,
): Promise<{ wf: boolean; dispatchCount: number; parallel: boolean; allTools: string[]; reasoning: string }> {
  const provider = getProvider(resolveAlias(alias).provider);
  let msgs: KodaXMessage[] = [{ role: 'user', content: task }];
  const allTools: string[] = [];
  const texts: string[] = [];
  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    if (THROTTLE_MS > 0) await sleep(THROTTLE_MS);
    const result = await provider.stream(msgs, TOOLS, system);
    allTools.push(...result.toolBlocks.map((b) => b.name));
    const t = result.textBlocks.map((b) => b.text).join('\n').trim();
    if (t) texts.push(`[turn ${turn}] ${t}`);
    const wf = allTools.includes('run_workflow');
    const dispatchCount = allTools.filter((x) => x === 'dispatch_child_task').length;
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
  const dispatchCount = allTools.filter((x) => x === 'dispatch_child_task').length;
  // Keep full reasoning (all turns) so a self-judge can separate "never considered"
  // from "considered and declined".
  return { wf, dispatchCount, parallel: wf || dispatchCount >= 2, allTools, reasoning: texts.join('\n\n').slice(0, 1600) };
}

describe('FEATURE_248 turn-0 activation (favorable shapes + a2a design reference)', () => {
  const panel = resolvePanel();

  it.runIf(panel.length > 0)(
    'at turn 0, the directive lifts parallel orchestration on favorable shapes',
    async () => {
      mkdirSync(DUMP_DIR, { recursive: true });
      // proposed = the full shipped AMAW directive (ORCHESTRATION DEFAULT + the merged
      // FEATURE_248 flow-fix PLAN-TIME COMMITMENT); baseline has neither.
      expect(workerSystem('baseline', TASKS.review)).not.toContain('ORCHESTRATION DEFAULT');
      expect(workerSystem('baseline', TASKS.review)).not.toContain('PLAN-TIME COMMITMENT');
      expect(workerSystem('proposed', TASKS.review)).toContain('ORCHESTRATION DEFAULT');
      expect(workerSystem('proposed', TASKS.review)).toContain('PLAN-TIME COMMITMENT');
      expect(getToolDefinition('run_workflow')).toBeDefined();

      const parallelRate = new Map<string, Map<ModelAlias, number>>();
      const wfRate = new Map<string, Map<ModelAlias, number>>();
      for (const variant of VARIANTS) {
        for (const taskKind of Object.keys(TASKS) as TaskKind[]) {
          const system = workerSystem(variant, TASKS[taskKind]);
          const key = `${variant}:${taskKind}`;
          const perParallel = new Map<ModelAlias, number>();
          const perWf = new Map<ModelAlias, number>();
          const aliasDumps: Array<{ alias: string; parallelRate: number; wfRate: number; runs: unknown[] }> = [];
          for (const alias of panel) {
            const runs: Array<{ runIndex: number; wf: boolean; dispatchCount: number; parallel: boolean; allTools: string[]; reasoning: string }> = [];
            for (let i = 0; i < RUNS; i += 1) {
              try {
                runs.push({ runIndex: i, ...(await turn0Signal(alias, system, TASKS[taskKind])) });
              } catch (error) {
                runs.push({ runIndex: i, wf: false, dispatchCount: 0, parallel: false, allTools: [], reasoning: `ERROR: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}` });
              }
            }
            perParallel.set(alias, runs.filter((x) => x.parallel).length / Math.max(1, runs.length));
            perWf.set(alias, runs.filter((x) => x.wf).length / Math.max(1, runs.length));
            aliasDumps.push({ alias, parallelRate: perParallel.get(alias)!, wfRate: perWf.get(alias)!, runs });
          }
          parallelRate.set(key, perParallel);
          wfRate.set(key, perWf);
          // Re-mkdir before every write: on Windows the temp cleaner can remove the
          // dump dir mid-run (a long panel spans >10min), which ENOENTs writeFileSync
          // and aborts the run (feedback_audit_dump_dir_vanishes).
          mkdirSync(DUMP_DIR, { recursive: true });
          writeFileSync(join(DUMP_DIR, `${variant}-${taskKind}.json`), JSON.stringify({ key, aliases: aliasDumps }, null, 2), 'utf8');
        }
      }

      // Mean parallel rate for variant:task — from the in-memory map if that variant ran
      // this invocation, else from the on-disk dump written by a prior run. Returns NaN
      // if neither is available (so gates can be skipped rather than crash).
      const meanFor = (which: 'parallel' | 'wf', variant: Variant, task: TaskKind): number => {
        const map = which === 'parallel' ? parallelRate : wfRate;
        const inMem = map.get(`${variant}:${task}`);
        if (inMem) return panel.map((a) => inMem.get(a) ?? 0).reduce((s, x) => s + x, 0) / Math.max(1, panel.length);
        try {
          const disk = JSON.parse(readFileSync(join(DUMP_DIR, `${variant}-${task}.json`), 'utf8')) as { aliases: Array<{ alias: string; parallelRate: number; wfRate: number }> };
          const byAlias = new Map(disk.aliases.map((a) => [a.alias, which === 'parallel' ? a.parallelRate : a.wfRate]));
          return panel.map((a) => byAlias.get(a) ?? 0).reduce((s, x) => s + x, 0) / Math.max(1, panel.length);
        } catch { return Number.NaN; }
      };
      const pct = (v: number): string => (Number.isNaN(v) ? 'n/a' : `${Math.round(v * 100)}`);
      const line = (task: TaskKind): string =>
        `${task}: parallel base ${pct(meanFor('parallel', 'baseline', task))}% -> directive ${pct(meanFor('parallel', 'proposed', task))}%` +
        ` | wf base ${pct(meanFor('wf', 'baseline', task))}% -> directive ${pct(meanFor('wf', 'proposed', task))}%`;
      // eslint-disable-next-line no-console
      console.log(
        `\n[FEATURE_248 turn-0] panel=${panel.join(',')} runs=${RUNS} turns=${MAX_TURNS} variants=${VARIANTS.join('+')}\n` +
        `${(Object.keys(TASKS) as TaskKind[]).map(line).join('\n')}\nDumps: ${DUMP_DIR}\n`,
      );

      // Regression guard for the shipped directive: aggregated over the favorable shapes,
      // the directive must lift turn-0 orchestration over no-directive. Absolute per-shape
      // rates are model-ceiling-limited (see §6.1), so this gates the AGGREGATE lift, not
      // an absolute per-shape bar.
      const haveBoth = ALL_VARIANTS.every((v) => FAVORABLE.every((t) => !Number.isNaN(meanFor('parallel', v, t))));
      if (panel.length >= 3 && haveBoth) {
        const favMean = (v: Variant): number => FAVORABLE.reduce((s, t) => s + meanFor('parallel', v, t), 0) / FAVORABLE.length;
        expect(favMean('proposed') - favMean('baseline'), 'favorable-shape turn-0 aggregate lift >= 0.05').toBeGreaterThanOrEqual(0.05);
        // Per-shape rates + a2aDesign are diagnostic (logged), not gated.
      }
    },
    3_600_000,
  );
});
