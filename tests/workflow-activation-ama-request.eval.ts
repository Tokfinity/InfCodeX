/**
 * FEATURE_249 — AMA natural-language workflow activation (Layer-3 acceptance eval).
 *
 * FEATURE_249 widened the run_workflow host gate so AMA (not just AMAW) can call
 * run_workflow. The acceptance question: does AMA activate a workflow on an EXPLICIT
 * natural-language request, WITHOUT the FEATURE_248 complexity directive (which stays
 * amaw-only), and WITHOUT over-activating on complexity-that-carries-no-request?
 *
 * This is NOT a directive A/B (the AMA prompt has no ORCHESTRATION DEFAULT in either
 * arm — that is the FEATURE_249 invariant). The A/B axis is the TASK PHRASING at matched
 * complexity:
 *   - explicitRequest: a complex task phrased WITH an orchestration ask ("用 workflow
 *     并行编排 ...").
 *   - noRequest: the SAME complex task phrased WITHOUT any orchestration language.
 *   - simple: a trivial task (guard — must stay near-zero regardless).
 * The AMA Worker system prompt (amawOrchestrationAvailable: false) and the AMA production
 * tool surface (run_workflow visible + DISPATCH_RUN_WORKFLOW_NUDGE appended, exactly what
 * the widened host gate produces) are held constant across all tasks.
 *
 * Metric: parallel = run_workflow OR >= 2 dispatch_child_task within the window; `wf`
 * (run_workflow-specific) tracked as diagnostic.
 *
 * Pre-registered gates (panel >= 3):
 *   - explicitRequest parallel >= 0.5 AND explicitRequest - noRequest >= 0.15
 *     (the NL request itself, not mere complexity, drives activation).
 *   - noRequest <= 0.35 (complexity-without-request may still fan out via reasonable
 *     dispatch judgment — legitimate AMA behavior — but must not match explicitRequest).
 *   - simple <= 0.20 regardless of phrasing.
 * Sanity: the AMA SYSTEM must NOT contain ORCHESTRATION DEFAULT / PLAN-TIME COMMITMENT
 * (proves the FEATURE_248 boundary holds); TOOLS must contain run_workflow (proves the
 * widened gate produced an AMA surface with the tool).
 *
 * Run (pilot):  KODAX_EVAL_ALIASES=zhipu/glm51 KODAX_EVAL_RUNS=3 npm run test:eval -- tests/workflow-activation-ama-request.eval.ts
 * Run (panel):  KODAX_EVAL_ALIASES=zhipu/glm51,mmx/m27,kimi,ark/v4flash npm run test:eval -- tests/workflow-activation-ama-request.eval.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
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

// AMA production tool surface: run_workflow visible + DISPATCH_RUN_WORKFLOW_NUDGE appended
// to dispatch (exactly what agent-chain.ts produces once ctx.workflowHost is present —
// which, post-FEATURE_249, it is for AMA).
function amaTools(): KodaXToolDefinition[] {
  return getAllRegisteredTools().map((t) => {
    const base = { name: t.name, description: t.description, input_schema: t.input_schema };
    if (t.name === 'dispatch_child_task') {
      return { ...base, description: `${t.description} ${DISPATCH_RUN_WORKFLOW_NUDGE}` };
    }
    return base;
  });
}
const TOOLS = amaTools();

// AMA Worker system prompt: amawOrchestrationAvailable is FALSE (the FEATURE_249
// invariant — AMA never gets the FEATURE_248 complexity directive).
function amaSystem(task: string): string {
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
    amawOrchestrationAvailable: false,
  };
  return createRolePrompt('worker', task, decision, undefined, undefined, 'kodax/role/worker', undefined, ctx, undefined, false);
}

// Synthesis-of-inline-material shape: the four dimensions' raw material is inlined and
// the task says "don't scout", so the orchestration decision can land in-window without
// the model first pulling a real diff (a review shape starves the scout phase on the `ok`
// tool stub even with a file list inlined — models insist on the real code).
const MATERIAL =
  '一套「KodaX 多租户改造」评估的四个相对独立维度的原始材料（已给，无需再调研或读代码）：\n' +
  '维度一 · 数据隔离：现状单库单 schema；候选=行级租户ID / schema-per-tenant / db-per-tenant，隔离强度与运维成本各有权衡。\n' +
  '维度二 · 认证授权：现有 OAuth 单租户；需扩为租户感知 token + 跨租户越权防护。\n' +
  '维度三 · 资源配额与限流：现无 per-tenant 限流；需按租户的配额、限流、计费埋点。\n' +
  '维度四 · 迁移与回滚：存量单租户数据如何平滑迁移、灰度、可回滚。';

const TASKS: Record<string, string> = {
  // Same complexity/material as noRequest, but WITH an explicit orchestration ask.
  explicitRequest:
    `我已经把${MATERIAL}\n\n**请直接用 \`run_workflow\` 并行编排**：每个维度派一个子 agent 独立深化分析并交叉核对，最后综合成一份定稿建议。不要再自己调研，直接授权并运行 workflow。`,
  // Identical material, NO orchestration language.
  noRequest:
    `我已经把${MATERIAL}\n\n请深化分析每个维度并综合成一份定稿建议（无需再调研）。`,
  // Guard: trivial task must not activate regardless of anything.
  simple:
    '把 src/date-utils.ts 里 formatDate 函数上方的一行英文注释改成中文，其它不动。',
};
type TaskKind = keyof typeof TASKS;

const RUNS = Number.parseInt(process.env.KODAX_EVAL_RUNS ?? '5', 10);
const MAX_TURNS = Number.parseInt(process.env.KODAX_EVAL_TURNS ?? '3', 10);
const THROTTLE_MS = Number.parseInt(process.env.KODAX_EVAL_THROTTLE_MS ?? '1000', 10);
const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });
const DUMP_DIR = join(tmpdir(), 'kodax-eval-dumps', 'workflow-activation-ama-request');

function resolvePanel(): ModelAlias[] {
  const raw = process.env.KODAX_EVAL_ALIASES;
  if (raw && raw.trim().length > 0) return availableAliases(...(raw.split(',').map((s) => s.trim()) as ModelAlias[]));
  return availableAliases('zhipu/glm51', 'mmx/m27', 'kimi', 'ark/v4flash');
}

async function activationSignal(
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
  return { wf, dispatchCount, parallel: wf || dispatchCount >= 2, allTools, reasoning: texts.join('\n\n').slice(0, 1400) };
}

describe('FEATURE_249 AMA natural-language workflow activation (request-driven, not complexity-driven)', () => {
  const panel = resolvePanel();

  it.runIf(panel.length > 0)(
    'AMA activates a workflow on explicit NL request, not on complexity-without-request',
    async () => {
      mkdirSync(DUMP_DIR, { recursive: true });
      // FEATURE_248 boundary: the AMA prompt has neither directive in any task.
      for (const t of Object.keys(TASKS) as TaskKind[]) {
        expect(amaSystem(TASKS[t]), t).not.toContain('ORCHESTRATION DEFAULT');
        expect(amaSystem(TASKS[t]), t).not.toContain('PLAN-TIME COMMITMENT');
      }
      // FEATURE_249: the widened gate produced an AMA surface WITH run_workflow.
      expect(getToolDefinition('run_workflow')).toBeDefined();
      expect(TOOLS.some((t) => t.name === 'run_workflow')).toBe(true);

      const parallelRate = new Map<string, number>();
      const wfRate = new Map<string, number>();
      for (const taskKind of Object.keys(TASKS) as TaskKind[]) {
        const system = amaSystem(TASKS[taskKind]);
        const perParallel = new Map<ModelAlias, number>();
        const perWf = new Map<ModelAlias, number>();
        const aliasDumps: Array<{ alias: string; parallelRate: number; wfRate: number; runs: unknown[] }> = [];
        for (const alias of panel) {
          const runs: Array<{ runIndex: number; wf: boolean; dispatchCount: number; parallel: boolean; allTools: string[]; reasoning: string }> = [];
          for (let i = 0; i < RUNS; i += 1) {
            try {
              runs.push({ runIndex: i, ...(await activationSignal(alias, system, TASKS[taskKind])) });
            } catch (error) {
              runs.push({ runIndex: i, wf: false, dispatchCount: 0, parallel: false, allTools: [], reasoning: `ERROR: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}` });
            }
          }
          perParallel.set(alias, runs.filter((x) => x.parallel).length / Math.max(1, runs.length));
          perWf.set(alias, runs.filter((x) => x.wf).length / Math.max(1, runs.length));
          aliasDumps.push({ alias, parallelRate: perParallel.get(alias)!, wfRate: perWf.get(alias)!, runs });
        }
        parallelRate.set(taskKind, panel.map((a) => perParallel.get(a) ?? 0).reduce((s, x) => s + x, 0) / Math.max(1, panel.length));
        wfRate.set(taskKind, panel.map((a) => perWf.get(a) ?? 0).reduce((s, x) => s + x, 0) / Math.max(1, panel.length));
        mkdirSync(DUMP_DIR, { recursive: true });
        writeFileSync(join(DUMP_DIR, `${taskKind}.json`), JSON.stringify({ taskKind, aliases: aliasDumps }, null, 2), 'utf8');
      }

      const pct = (v: number): string => `${Math.round((v ?? 0) * 100)}`;
      // eslint-disable-next-line no-console
      console.log(
        `\n[FEATURE_249 AMA request] panel=${panel.join(',')} runs=${RUNS} turns=${MAX_TURNS}\n` +
        `explicitRequest ${pct(parallelRate.get('explicitRequest')!)}% (wf ${pct(wfRate.get('explicitRequest')!)}%) | ` +
        `noRequest ${pct(parallelRate.get('noRequest')!)}% | simple ${pct(parallelRate.get('simple')!)}%\nDumps: ${DUMP_DIR}\n`,
      );

      if (panel.length >= 3) {
        const er = parallelRate.get('explicitRequest')!;
        const nr = parallelRate.get('noRequest')!;
        expect(er, 'explicitRequest parallel >= 0.5').toBeGreaterThanOrEqual(0.5);
        expect(er - nr, 'explicitRequest - noRequest >= 0.15 (request drives it, not complexity)').toBeGreaterThanOrEqual(0.15);
        expect(nr, 'noRequest <= 0.35 (no over-activation on complexity-without-request)').toBeLessThanOrEqual(0.35);
        expect(parallelRate.get('simple')!, 'simple <= 0.20 (trivial guard)').toBeLessThanOrEqual(0.20);
      }
    },
    3_600_000,
  );
});
