/**
 * FEATURE_248 — AMAW mode-level orchestration directive activation probe
 * (Layer-3, per benchmark/EVAL_GUIDELINES.md).
 *
 * Question (not answerable by Layer 1): does a MODE-LEVEL standing directive
 * (`ORCHESTRATION DEFAULT`, spliced into the AMAW Worker system prompt — the same
 * mechanism the reference "ultracode" mode uses) make the AMAW Worker orchestrate
 * PARALLEL multi-agent work (run_workflow OR a dispatch fan-out) on a complex,
 * multi-dimensional design/review task — WITHOUT over-triggering on a simple task?
 *
 * Why this lever, not the prior one: the tool-level lever (run_workflow description
 * reframe + amaw-gated dispatch nudge) was eval-falsified — no measurable lift, and
 * models already fan out via dispatch. This eval isolates the SYSTEM-PROMPT lever:
 * the intervention is entirely in the Worker system bytes; the tool surface is the
 * production AMAW surface (run_workflow present + dispatch nudge appended, mirroring
 * agent-chain.ts) and is IDENTICAL across variants.
 *
 * Design (bidirectional, anti-pattern 8 §2 byte-aligned):
 * - v_proposed = Worker system WITH the ORCHESTRATION DEFAULT directive
 *   (amawOrchestrationAvailable:true). v_baseline = WITHOUT it (false) — today's
 *   AMA-parity prompt. Tools identical (production amaw surface) in both.
 * - STRUCTURAL metric: does the Worker orchestrate PARALLEL multi-agent work —
 *   run_workflow OR a dispatch fan-out (>= 2 dispatch_child_task)? Accumulated across
 *   up to N turns (turn 1 is often plan/scout bookkeeping). `wf` (run_workflow-
 *   specific) tracked separately as a diagnostic (self-judge showed models fan out
 *   via dispatch, which a run_workflow-only metric misses).
 * - Fixtures are SEEDED histories past the mandatory plan-first + scouting phase, so
 *   the MEASURED turn is the actual "how do I produce this" decision — orchestrate
 *   vs single-threaded (feedback_workflow_authoring_eval_needs_layer3). A cold 2-turn
 *   probe never reaches it. NOTE the residual 2-3 turn Layer-3 limitation: a model
 *   that keeps re-planning can push the fan-out past the window; report, do not
 *   silently truncate.
 *
 * Pre-registered gate (panel >= 3):
 * - Complex (complexDesign, complexReview): proposed parallel-rate >= 0.5 AND
 *   proposed - baseline >= 0.15 (real lift; softer than the reverted eval's 0.25
 *   because this lever REINFORCES an already-decent dispatch baseline rather than
 *   creating activation from a near-zero floor).
 * - Simple (over-activation guard): proposed <= 0.20 AND proposed <= baseline + 0.10.
 * - run_workflow-specific rate is diagnostic (logged, not gated).
 * - If neither lever moves parallel-rate beyond the dispatch baseline, the premise is
 *   floored/saturated: report + DEFER with evidence, do NOT lower the gate post-hoc
 *   (feedback_pre_registered_gate_saturation).
 *
 * Run (pilot):  KODAX_EVAL_ALIASES=mimo/v25 KODAX_EVAL_RUNS=3 npm run test:eval -- tests/workflow-activation.eval.ts
 * Run (panel):  KODAX_EVAL_ALIASES=zhipu/glm52,mmx/m3,mimo/v25 npm run test:eval -- tests/workflow-activation.eval.ts
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

const VARIANTS = ['baseline', 'proposed'] as const;
type Variant = (typeof VARIANTS)[number];

// Both variants present the PRODUCTION AMAW tool surface: run_workflow is visible
// and DISPATCH_RUN_WORKFLOW_NUDGE is appended to dispatch_child_task (mirroring
// agent-chain.ts when ctx.workflowHost is present). The tool bytes DO NOT change
// across variants — this eval isolates the system-prompt lever alone.
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

// The A/B intervention: proposed = amawOrchestrationAvailable true (directive
// spliced), baseline = false (no directive — byte-identical to today's AMA prompt).
function workerSystem(variant: Variant): string {
  const decision = buildFallbackRoutingDecision('workflow activation probe');
  const ctx: ManagedRolePromptContext = {
    originalTask: 'workflow activation probe',
    workspace: {
      executionCwd: process.cwd(),
      gitRoot: process.cwd(),
      platform: process.platform,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    },
    amawOrchestrationAvailable: variant === 'proposed',
  };
  return createRolePrompt('worker', 'workflow activation probe', decision, undefined, undefined, 'kodax/role/worker', undefined, ctx, undefined, false);
}
const SYSTEM: Record<Variant, string> = {
  baseline: workerSystem('baseline'),
  proposed: workerSystem('proposed'),
};

// COMPLEX replays the real dogfood task (session 20260702_131031) with the facts
// that session scouted, then a seeded assistant "planned + scouted, now producing
// the design" turn so the MEASURED turn is the actual "how do I produce this
// multi-dimensional design" decision — orchestrate vs single-threaded write.
const COMPLEX_TASK =
  '我现在有一个需求：设计一套 A2A（Agent-to-Agent）框架，基于 Google 的 A2A 协议但有较大改动、可能需要自己的实现。我们架构有点特殊——A2A 中间有一层网关 A2Gate2A，负责请求与回复的转发。我们要怎么改造 A2A 的协议与架构，并且让以 KodaX SDK 为智能底座的系统也支持这套 A2Gate2A。\n\n' +
  '以下是我已经调研到的关键事实（无需再调研，直接据此定型）：\n' +
  '- Google A2A 协议：基于 HTTP + JSON-RPC 2.0 + SSE；核心是 Agent Card（能力发现）、Task 生命周期管理、流式中转、OAuth 认证；与 MCP 互补；原生支持 Custom Protocol Bindings、Extensions、AgentInterface（一个 Agent Card 可有多接口）、Multi-Tenancy。\n' +
  '- KodaX 现有基础设施：src/acp_server.ts（ACP server，JSON-RPC over ndjson，封装 runKodaX，带会话/流式通知/权限）；MCP transport 栈（stdio/SSE/Streamable HTTP，带 OAuth）；CapabilityProvider 模式；WorkflowAgentBackend（spawnAgent/wait/send/stop 契约，coding 层用 CodingWorkflowBackend 实现）。\n\n' +
  '请把 A2Gate2A 的设计定型，覆盖协议改造、网关层设计、KodaX SDK 集成、安全与鉴权、实现路线图这几个相对独立的维度，最后产出一份定型设计。';

// REVIEW = run_workflow's textbook shape (multi-angle + adversarial-verify +
// high-reliability), seeded past planning/scoping so the measured turn is the
// "how do I run this review" decision.
const REVIEW_TASK =
  '请对 packages/coding 这个包在 v0.7.58 的改动做一次彻底、高可信的 review：从正确性、并发安全、错误处理、测试充分性这几个相对独立的维度分别深审，而且每一条发现都要独立地对抗式复核一遍以剔除误报。可靠性要求很高，不能漏关键问题，也不能拿没核实的猜测充数。';

const TASKS: Record<'complexDesign' | 'complexReview' | 'simple', KodaXMessage[]> = {
  complexDesign: [
    { role: 'user', content: COMPLEX_TASK },
    {
      role: 'assistant',
      content:
        '我已经把这套设计拆成协议改造、网关层设计、KodaX SDK 集成、安全与鉴权、实现路线图这五个相对独立、各自都需要有深度并且互相印证的维度。上面的关键事实、以及 KodaX 代码库现状（acp_server / MCP transport / CapabilityProvider / WorkflowAgentBackend 等）都已经调研并扫描清楚了，不需要再调研或扫描代码库。接下来把这套设计定型。',
    },
    { role: 'user', content: '好，开始吧。' },
  ],
  complexReview: [
    { role: 'user', content: REVIEW_TASK },
    {
      role: 'assistant',
      content:
        '我已经把 review 拆成正确性、并发安全、错误处理、测试充分性这四个相对独立的维度，改动范围（packages/coding v0.7.58 的 diff）也已经用 changed_scope 扫清楚了，不需要再扫。每个维度审出的发现还要各自独立对抗式复核。接下来开始执行这次 review。',
    },
    { role: 'user', content: '好，开始吧。' },
  ],
  simple: [
    { role: 'user', content: '把 src/date-utils.ts 里 formatDate 函数上方的一行英文注释改成中文，其它不动。' },
  ],
};
type TaskKind = keyof typeof TASKS;

const RUNS = Number.parseInt(process.env.KODAX_EVAL_RUNS ?? '5', 10);
// 3-turn window (vs the reverted eval's 2) to reduce the "model re-plans, fan-out
// lands turn 3, cut off" truncation artifact the prior round hit. Accumulates and
// breaks early once the signal is decided, so extra turns cost nothing when the
// model fans out early.
const MAX_TURNS = Number.parseInt(process.env.KODAX_EVAL_TURNS ?? '3', 10);
const DUMP_DIR = join(tmpdir(), 'kodax-eval-dumps', 'workflow-activation');

function resolvePanel(): ModelAlias[] {
  const raw = process.env.KODAX_EVAL_ALIASES;
  if (raw && raw.trim().length > 0) return availableAliases(...(raw.split(',').map((s) => s.trim()) as ModelAlias[]));
  return availableAliases('zhipu/glm52', 'mmx/m3', 'mimo/v25');
}

/**
 * Does the Worker activate PARALLEL MULTI-AGENT work for this task — via
 * run_workflow OR a dispatch fan-out (>= 2 dispatch_child_task)? Accumulates tool
 * calls across up to MAX_TURNS turns. `wf` tracks the run_workflow-specific choice
 * separately (diagnostic).
 */
async function activationSignal(
  alias: ModelAlias,
  system: string,
  seed: KodaXMessage[],
): Promise<{ wf: boolean; dispatchCount: number; parallel: boolean; allTools: string[]; textSnippet: string }> {
  const provider = getProvider(resolveAlias(alias).provider);
  let msgs: KodaXMessage[] = [...seed];
  const allTools: string[] = [];
  let lastText = '';
  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    const result = await provider.stream(msgs, TOOLS, system);
    allTools.push(...result.toolBlocks.map((b) => b.name));
    lastText = result.textBlocks.map((b) => b.text).join('\n');
    const wf = allTools.includes('run_workflow');
    const dispatchCount = allTools.filter((t) => t === 'dispatch_child_task').length;
    // Stop once the parallel-multi-agent signal is decided, or the turn ended
    // text-only (nothing more to continue).
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
  return { wf, dispatchCount, parallel: wf || dispatchCount >= 2, allTools, textSnippet: lastText.slice(0, 300) };
}

describe('FEATURE_248 mode-level orchestration directive (complex activates / simple does not over-activate)', () => {
  const panel = resolvePanel();

  it.runIf(panel.length > 0)(
    'complex tasks activate parallel multi-agent work; simple tasks do not over-trigger',
    async () => {
      mkdirSync(DUMP_DIR, { recursive: true });
      // sanity: the directive is present in proposed and absent in baseline, and
      // the tool surface is genuinely the amaw surface (run_workflow visible).
      expect(SYSTEM.baseline).not.toContain('ORCHESTRATION DEFAULT');
      expect(SYSTEM.proposed).toContain('ORCHESTRATION DEFAULT');
      expect(getToolDefinition('run_workflow')).toBeDefined();
      expect(TOOLS.some((t) => t.name === 'run_workflow')).toBe(true);

      const parallelRate = new Map<string, Map<ModelAlias, number>>();
      const wfRate = new Map<string, Map<ModelAlias, number>>();
      for (const variant of VARIANTS) {
        const system = SYSTEM[variant];
        for (const taskKind of Object.keys(TASKS) as TaskKind[]) {
          const key = `${variant}:${taskKind}`;
          const perParallel = new Map<ModelAlias, number>();
          const perWf = new Map<ModelAlias, number>();
          const aliasDumps: Array<{ alias: string; parallelRate: number; wfRate: number; runs: unknown[] }> = [];
          for (const alias of panel) {
            const runs: Array<{ runIndex: number; wf: boolean; dispatchCount: number; parallel: boolean; allTools: string[]; textSnippet: string }> = [];
            for (let i = 0; i < RUNS; i += 1) {
              try {
                runs.push({ runIndex: i, ...(await activationSignal(alias, system, TASKS[taskKind])) });
              } catch (error) {
                runs.push({ runIndex: i, wf: false, dispatchCount: 0, parallel: false, allTools: [], textSnippet: `ERROR: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}` });
              }
            }
            perParallel.set(alias, runs.filter((x) => x.parallel).length / Math.max(1, runs.length));
            perWf.set(alias, runs.filter((x) => x.wf).length / Math.max(1, runs.length));
            aliasDumps.push({ alias, parallelRate: perParallel.get(alias)!, wfRate: perWf.get(alias)!, runs });
          }
          parallelRate.set(key, perParallel);
          wfRate.set(key, perWf);
          writeFileSync(join(DUMP_DIR, `${variant}-${taskKind}.json`), JSON.stringify({ key, aliases: aliasDumps }, null, 2), 'utf8');
        }
      }

      const mean = (map: Map<string, Map<ModelAlias, number>>, key: string): number => {
        const m = map.get(key)!;
        return panel.map((a) => m.get(a) ?? 0).reduce((s, x) => s + x, 0) / Math.max(1, panel.length);
      };
      const pct = (v: number): string => `${Math.round(v * 100)}`;
      const line = (task: TaskKind): string =>
        `${task}: parallel base ${pct(mean(parallelRate, `baseline:${task}`))}% -> prop ${pct(mean(parallelRate, `proposed:${task}`))}%` +
        ` | run_workflow-specific base ${pct(mean(wfRate, `baseline:${task}`))}% -> prop ${pct(mean(wfRate, `proposed:${task}`))}%`;
      // eslint-disable-next-line no-console
      console.log(
        `\n[FEATURE_248 activation] panel=${panel.join(',')} runs=${RUNS} turns=${MAX_TURNS}\n` +
        `${line('complexDesign')}\n${line('complexReview')}\n${line('simple')}\nDumps: ${DUMP_DIR}\n`,
      );

      if (panel.length >= 3) {
        // Desired behavior: complex work activates PARALLEL multi-agent (run_workflow OR dispatch fan-out),
        // and the mode-level directive lifts it over baseline.
        expect(mean(parallelRate, 'proposed:complexDesign'), 'complexDesign parallel activation >= 0.5').toBeGreaterThanOrEqual(0.5);
        expect(mean(parallelRate, 'proposed:complexReview'), 'complexReview parallel activation >= 0.5').toBeGreaterThanOrEqual(0.5);
        expect(
          mean(parallelRate, 'proposed:complexDesign') - mean(parallelRate, 'baseline:complexDesign'),
          'complexDesign lift >= 0.15',
        ).toBeGreaterThanOrEqual(0.15);
        expect(
          mean(parallelRate, 'proposed:complexReview') - mean(parallelRate, 'baseline:complexReview'),
          'complexReview lift >= 0.15',
        ).toBeGreaterThanOrEqual(0.15);
        // Over-activation guard: a simple task stays single-threaded.
        expect(mean(parallelRate, 'proposed:simple'), 'simple over-activation cap <= 0.20').toBeLessThanOrEqual(0.2);
        expect(
          mean(parallelRate, 'proposed:simple') - mean(parallelRate, 'baseline:simple'),
          'simple over-activation delta <= 0.10',
        ).toBeLessThanOrEqual(0.1);
      }
    },
    1_800_000,
  );
});
