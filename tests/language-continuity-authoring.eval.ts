/**
 * ③ Language-continuity AUTHORING probe (Layer-3, per benchmark/EVAL_GUIDELINES.md).
 *
 * This tests the HIGH-VALUE surface the downstream child probe
 * (language-continuity.eval.ts) could not: the real bug was a CHINESE query where
 * the Worker authored a run_workflow whose JS child-prompt STRINGS were English
 * (code-authoring drifts to English), so the children answered English. Question:
 * do the added rules (worker DISPATCH OBJECTIVE LANGUAGE bullet + EXECUTION_GUIDANCE
 * language bullet + run_workflow description reminder) make the Worker author the
 * run_workflow child prompts in Chinese?
 *
 * Design:
 * - v_proposed = current code (worker prompt + tools carry all 3 additions).
 *   v_baseline strips the 2 worker-prompt lines from the assembled system AND the
 *   run_workflow-description sentence from the tools channel — byte-aligned
 *   otherwise (anti-pattern 8 §2). Production worker system prompt via
 *   createRolePrompt('worker', …) and production tool bytes via getAllRegisteredTools.
 * - STRUCTURAL assertion on the AUTHORED artifact: count CJK chars in the authored
 *   run_workflow `source` (the JS). The English keywords contribute ~0 CJK, so a
 *   high CJK count means the child-prompt string literals (which carry the findings)
 *   are Chinese. Threshold >= 30 (an all-English script has ~0; a script whose 3
 *   child prompts restate the Chinese findings has 100+). Positive assertion, the
 *   low-trap direction (anti-pattern 7); self-judge the dump.
 * - The task supplies the scouted findings INLINE + says "don't scout, author now"
 *   so the Worker authors directly (avoids the scout-then-author single-turn miss,
 *   per feedback_workflow_authoring_eval_needs_layer3); 2-turn fallback if turn 1 is
 *   bookkeeping (mirrors feature-246-pattern-composition.eval).
 *
 * Pre-registered gate + classification (panel >= 3):
 * - proposed mean chineseAuthoringRate >= 0.60 (authored run_workflow with Chinese
 *   child prompts).
 * - baseline also >= 0.60 => saturation (the Worker already mirrors for authoring;
 *   the rules are a GUARD, SHIP as hygiene). baseline < proposed by >= 0.25 => real
 *   lift (the rules fix the English JS-string drift the user hit).
 *
 * Run (pilot):  KODAX_EVAL_ALIASES=mimo/v25 KODAX_EVAL_RUNS=3 npm run test:eval -- tests/language-continuity-authoring.eval.ts
 * Run (panel):  KODAX_EVAL_ALIASES=zhipu/glm51,mmx/m27,mimo/v25 npm run test:eval -- tests/language-continuity-authoring.eval.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';
import { getProvider } from '@kodax-ai/llm';
import type { KodaXMessage, KodaXToolDefinition } from '@kodax-ai/llm';
import { getAllRegisteredTools } from '@kodax-ai/coding';

import { createRolePrompt } from '../packages/coding/src/task-engine/_internal/managed-task/role-prompt.js';
import { buildFallbackRoutingDecision } from '../packages/coding/src/reasoning.js';
import type { ManagedRolePromptContext } from '../packages/coding/src/task-engine/_internal/managed-task/role-prompt-types.js';
import { availableAliases, resolveAlias } from '../benchmark/harness/aliases.js';
import type { ModelAlias } from '../benchmark/harness/aliases.js';

// The three strings the change added — baseline removes them (byte-aligned).
const EXEC_LINE =
  "- Respond in the primary natural language of the user's request for your user-visible explanations, progress notes, and final answer — if the user wrote in Chinese, reply in Chinese. Code, identifiers, file paths, tool output, and quoted evidence stay in their source language.";
const DISPATCH_LINE =
  "- DISPATCH OBJECTIVE LANGUAGE: write the `objective` (and any `run_workflow` child prompts) in the same natural language as the user's request, so the child's report comes back in that language. Code, file paths, and quoted scope stay in their source form.";
const RUNWF_SENTENCE =
  "Write those child prompts in the same natural language as the user's request, so each child's report and the synthesized result come back in that language. ";

function workerSystem(): string {
  const decision = buildFallbackRoutingDecision('language authoring probe');
  const ctx: ManagedRolePromptContext = {
    originalTask: 'language authoring probe',
    workspace: {
      executionCwd: process.cwd(),
      gitRoot: process.cwd(),
      platform: process.platform,
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
    },
  };
  return createRolePrompt(
    'worker',
    'language authoring probe',
    decision,
    undefined,
    undefined,
    'kodax/role/worker',
    undefined,
    ctx,
    undefined,
    false,
  );
}

const PROPOSED_SYSTEM = workerSystem();
const BASELINE_SYSTEM = PROPOSED_SYSTEM.replace(`${EXEC_LINE}\n`, '').replace(`${DISPATCH_LINE}\n`, '');

const VARIANTS = ['baseline', 'proposed'] as const;
type Variant = (typeof VARIANTS)[number];

function toolsForVariant(variant: Variant): KodaXToolDefinition[] {
  const all = getAllRegisteredTools().map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
  if (variant === 'proposed') return all;
  return all.map((t) => (t.name === 'run_workflow' ? { ...t, description: t.description.replace(RUNWF_SENTENCE, '') } : t));
}

const CHINESE_TASK = [
  '以下三个方面我已经调研清楚（发现见下）。现在请你直接用 run_workflow 并行做多角度 review：一个子 agent 负责一个方面，' +
    '把该方面的具体发现原样写进对应子 agent 的 prompt，最后综合成一份报告。不要再调研，直接授权并运行 workflow。',
  '',
  '方面一 · 错误处理：fetchUser 没有检查 res.ok，4xx/5xx 响应会被 res.json() 当作正常数据解析（api.ts:12）。',
  '方面二 · 类型安全：fetchUser 的参数 id 缺类型注解，返回值退化为 any（api.ts:10）。',
  '方面三 · 重试与超时：请求既无超时也无重试，网络抖动会直接抛错（api.ts:14）。',
].join('\n');

const CJK = /[一-鿿]/g;
function cjk(text: string): number {
  return text.match(CJK)?.length ?? 0;
}

const RUNS = Number.parseInt(process.env.KODAX_EVAL_RUNS ?? '5', 10);
const DUMP_DIR = join(tmpdir(), 'kodax-eval-dumps', 'language-continuity-authoring');

function resolvePanel(): ModelAlias[] {
  const raw = process.env.KODAX_EVAL_ALIASES;
  if (raw && raw.trim().length > 0) {
    return availableAliases(...(raw.split(',').map((s) => s.trim()) as ModelAlias[]));
  }
  return availableAliases('zhipu/glm51', 'mmx/m27', 'mimo/v25');
}

/** One authoring turn (2-turn fallback if turn 1 was bookkeeping, mirroring F246). */
async function authorWorkflow(
  alias: ModelAlias,
  system: string,
  tools: KodaXToolDefinition[],
): Promise<{ emitted: boolean; sourceCjk: number; source: string; tools: string[]; textSnippet: string }> {
  const provider = getProvider(resolveAlias(alias).provider);
  let msgs: KodaXMessage[] = [{ role: 'user', content: CHINESE_TASK }];
  let result = await provider.stream(msgs, tools, system);
  let wf = result.toolBlocks.find((b) => b.name === 'run_workflow');
  if (!wf && result.toolBlocks.length > 0) {
    msgs = [
      ...msgs,
      { role: 'assistant', content: [
        ...result.textBlocks.map((b) => ({ type: 'text' as const, text: b.text })),
        ...result.toolBlocks.map((b) => ({ type: 'tool_use' as const, id: b.id, name: b.name, input: b.input })),
      ] },
      { role: 'user', content: result.toolBlocks.map((b) => ({ type: 'tool_result' as const, tool_use_id: b.id, content: 'ok' })) },
    ] as KodaXMessage[];
    result = await provider.stream(msgs, tools, system);
    wf = result.toolBlocks.find((b) => b.name === 'run_workflow');
  }
  const source = wf ? String((wf.input as { source?: unknown })?.source ?? '') : '';
  // When run_workflow is NOT authored, capture what the Worker did instead so a
  // non-emit can be classified (chose dispatch/other tool, or answered in text)
  // rather than conflated with "authored English".
  const toolNames = result.toolBlocks.map((b) => b.name);
  const textSnippet = result.textBlocks.map((b) => b.text).join('\n').slice(0, 400);
  return { emitted: !!wf, sourceCjk: cjk(source), source, tools: toolNames, textSnippet };
}

describe('③ language-continuity run_workflow authoring probe', () => {
  const panel = resolvePanel();

  it.runIf(panel.length > 0)(
    'a Chinese task yields a run_workflow authored with Chinese child prompts',
    async () => {
      mkdirSync(DUMP_DIR, { recursive: true });
      // sanity: the strips actually removed the lines.
      expect(PROPOSED_SYSTEM).toContain(DISPATCH_LINE);
      expect(BASELINE_SYSTEM).not.toContain(DISPATCH_LINE);
      expect(BASELINE_SYSTEM).not.toContain(EXEC_LINE);
      expect(toolsForVariant('proposed').find((t) => t.name === 'run_workflow')!.description).toContain(RUNWF_SENTENCE);
      expect(toolsForVariant('baseline').find((t) => t.name === 'run_workflow')!.description).not.toContain(RUNWF_SENTENCE);

      const rate = new Map<Variant, Map<ModelAlias, number>>();
      for (const variant of VARIANTS) {
        const system = variant === 'proposed' ? PROPOSED_SYSTEM : BASELINE_SYSTEM;
        const tools = toolsForVariant(variant);
        const perAlias = new Map<ModelAlias, number>();
        const aliasDumps: Array<{ alias: string; chineseAuthoringRate: number; runs: unknown[] }> = [];
        for (const alias of panel) {
          const runs: Array<{ runIndex: number; emitted: boolean; sourceCjk: number; chinese: boolean; source: string; tools?: string[]; textSnippet?: string }> = [];
          for (let i = 0; i < RUNS; i += 1) {
            try {
              const r = await authorWorkflow(alias, system, tools);
              runs.push({ runIndex: i, ...r, chinese: r.emitted && r.sourceCjk >= 30 });
            } catch (error) {
              runs.push({ runIndex: i, emitted: false, sourceCjk: 0, chinese: false, source: `ERROR: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}` });
            }
          }
          const r = runs.filter((x) => x.chinese).length / Math.max(1, runs.length);
          perAlias.set(alias, r);
          aliasDumps.push({ alias, chineseAuthoringRate: r, runs });
        }
        rate.set(variant, perAlias);
        writeFileSync(join(DUMP_DIR, `${variant}.json`), JSON.stringify({ variant, aliases: aliasDumps }, null, 2), 'utf8');
      }

      const pct = (v: number): string => `${Math.round(v * 100)}`;
      const rows = panel.map((a) => `${a}: baseline ${pct(rate.get('baseline')!.get(a) ?? 0)}% -> proposed ${pct(rate.get('proposed')!.get(a) ?? 0)}%`);
      // eslint-disable-next-line no-console
      console.log(`\n[③ authoring] panel=${panel.join(',')} runs=${RUNS}\n${rows.join('\n')}\nDumps: ${DUMP_DIR}\n`);

      const mean = (v: Variant): number => {
        const m = rate.get(v)!;
        return panel.map((a) => m.get(a) ?? 0).reduce((s, x) => s + x, 0) / Math.max(1, panel.length);
      };
      if (panel.length >= 3) {
        expect(mean('proposed'), 'proposed mean chineseAuthoringRate >= 0.60').toBeGreaterThanOrEqual(0.6);
      }
    },
    1_800_000,
  );
});
