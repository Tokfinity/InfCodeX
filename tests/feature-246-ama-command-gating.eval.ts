/**
 * FEATURE_246 follow-up — AMA command-gating graceful-degradation eval (Layer 2).
 *
 * Context: the activation-semantics change gives plain AMA NO standing
 * `run_workflow` (it is command-gated; only an elevated `/workflow` command turn
 * or AMAW carry it) and, because the dispatch→run_workflow nudge is now
 * host-conditional, the AMA Worker's dispatch description carries no nudge. That
 * AMA surface (no run_workflow, dispatch without nudge) is byte-identical to the
 * pre-FEATURE_246 AMA Worker — a shipped, proven config; run_workflow was *added*
 * by 246. AMAW's surface stays byte-identical to the post-A3 state already
 * covered by feature-246-run-workflow-tool.eval.ts, so it is not re-tested here.
 *
 * Question (not answerable by Layer 1; Layer 1 only proves the tool is absent):
 * given the AMA surface, does the Worker DEGRADE GRACEFULLY on a synthesizable
 * fan-out task — i.e. reach for `dispatch_child_task` (the fan-out tool it does
 * have) — rather than flail looking for a `run_workflow` it was never offered?
 *
 * Design (per benchmark/EVAL_GUIDELINES.md):
 * - Single-turn probe. Production tool bytes via the package entry (real
 *   descriptions; dispatch's bytes are exactly what the AMA Worker sees — no
 *   nudge — since the nudge now lives outside the static def). run_workflow is
 *   excluded from the subset to model the AMA surface (anti-pattern 8: real bytes).
 * - Structural assertion: `runOneShot` captures real toolCalls; the gate reads
 *   `toolCalls[].name` (dispatch_child_task used). A soft text signal (does the
 *   Worker reference a workflow tool it doesn't have) is observational only
 *   (anti-pattern 7: no negation-on-text hard gate).
 * - Scoping is primed (anti-pattern 11) so the first action is the
 *   execution-shape decision, not exploratory read/grep.
 * - Pilot first on one alias (anti-pattern 4): KODAX_EVAL_ALIASES=ark/v4flash
 *   KODAX_EVAL_RUNS=1. Hard gate only fires for a >=3-alias panel.
 *
 * Pre-registered gate (panel, >=3 aliases):
 * - Graceful degradation: mean dispatch_child_task rate >= 0.5 (uses the fan-out
 *   tool it has on a fan-out task).
 * - No phantom tool: the Worker never emits a run_workflow tool call (structural,
 *   trivially true since it is absent) AND mean "asks for a missing workflow
 *   tool" text rate <= 0.3 (observational, logged).
 *
 * Run:
 *   npm run test:eval -- tests/feature-246-ama-command-gating.eval.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';
import type { KodaXToolDefinition } from '@kodax-ai/llm';

import { availableAliases } from '../benchmark/harness/aliases.js';
import type { ModelAlias } from '../benchmark/harness/aliases.js';
import { runOneShot } from '../benchmark/harness/harness.js';
import { getAllRegisteredTools } from '@kodax-ai/coding';

// AMA surface: the same investigation/mutation/dispatch tools as the canonical
// probe MINUS run_workflow (plain AMA does not carry it).
const AMA_TOOL_SUBSET = ['dispatch_child_task', 'read', 'grep', 'glob', 'code_search', 'bash', 'write', 'edit'];

function amaToolSubset(): KodaXToolDefinition[] {
  return getAllRegisteredTools()
    .filter((t) => AMA_TOOL_SUBSET.includes(t.name))
    .map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
}

// AMA Worker framing — note it does NOT mention run_workflow (the AMA Worker has
// no such tool; mentioning it would defeat the point of the probe).
const SYSTEM_PROMPT = [
  'You are the Worker — an autonomous coding agent with a full toolset:',
  'read / grep / glob / code_search / bash for investigation, write / edit to change files,',
  'and dispatch_child_task to delegate a focused sub-agent — call it multiple times in parallel for concurrent sub-tasks.',
  'Investigate and act on the user request using tools. Begin now by calling the most appropriate tool(s); do not ask clarifying questions first.',
].join('\n');

interface EvalCase {
  readonly id: string;
  readonly userMessage: string;
  readonly priorMessages?: ReadonlyArray<{ readonly role: 'user' | 'assistant'; readonly content: string }>;
}

// Reuse the canonical synthesizable-fan-out scenarios (same shape as the
// run_workflow trigger eval) — but on the AMA surface the right move is
// dispatch_child_task x N, not run_workflow.
const CASES: readonly EvalCase[] = [
  {
    id: 'P1_compare_three_codebases',
    priorMessages: [
      {
        role: 'user',
        content:
          "Compare how three CLI coding agents — at /repos/a, /repos/b and /repos/c — each handle LLM streaming error recovery (empty assistant output, truncated/partial tool-call JSON, and mid-stream cutoffs). Map each codebase's mechanisms with file:line evidence, then synthesize where they differ and which approach is soundest.",
      },
      {
        role: 'assistant',
        content:
          "I scoped the three repos. /repos/a, /repos/b and /repos/c are each full CLI coding-agent codebases with their own multi-file LLM-integration layers (separate streaming, tool-parsing and compaction modules). Mapping each one's error-recovery mechanisms is an independent deep read, and then I need to synthesize the cross-codebase differences.",
      },
    ],
    userMessage: 'Good — now carry out the full three-way comparison and give me the synthesis.',
  },
];

const CANONICAL_PANEL: readonly ModelAlias[] = ['zhipu/glm52', 'kimi', 'mmx/m3', 'ark/v4pro', 'ark/v4flash'];

const ALIAS_FALLBACK: Partial<Record<ModelAlias, ModelAlias>> = {
  'ark/v4pro': 'ds/v4pro',
  'ark/v4flash': 'ds/v4flash',
};

function resolvePanel(): ModelAlias[] {
  const override = process.env.KODAX_EVAL_ALIASES;
  if (override && override.trim().length > 0) {
    const wanted = override.split(',').map((s) => s.trim()) as ModelAlias[];
    return availableAliases(...wanted);
  }
  return availableAliases(...CANONICAL_PANEL);
}

const RUNS = Number(process.env.KODAX_EVAL_RUNS ?? '3');
const DUMP_DIR = join(tmpdir(), 'kodax-eval-dumps', 'feature-246-ama-gating');

// Observational only (not a hard gate, per anti-pattern 7): does the Worker
// reference a workflow tool it was not given — a sign it is flailing rather than
// degrading to dispatch?
const PHANTOM_TOOL_RE = /\brun_workflow\b/i;

interface RunRecord {
  readonly runIndex: number;
  readonly text: string;
  readonly toolCalls: readonly string[];
  readonly dispatched: boolean;
  readonly emittedRunWorkflow: boolean;
  readonly mentionsPhantomTool: boolean;
  readonly durationMs: number;
}

describe('FEATURE_246 AMA command-gating graceful degradation', () => {
  const panel = resolvePanel();

  it.runIf(panel.length > 0)(
    'AMA Worker (no run_workflow) degrades to dispatch_child_task on a fan-out task instead of flailing',
    async () => {
      mkdirSync(DUMP_DIR, { recursive: true });
      const TOOLS = amaToolSubset();
      expect(TOOLS.some((t) => t.name === 'run_workflow'), 'AMA surface must EXCLUDE run_workflow').toBe(false);
      expect(TOOLS.some((t) => t.name === 'dispatch_child_task'), 'AMA surface must include dispatch_child_task').toBe(true);
      // The AMA dispatch description must NOT carry the run_workflow nudge.
      const dispatchDesc = TOOLS.find((t) => t.name === 'dispatch_child_task')?.description ?? '';
      expect(dispatchDesc.includes('run_workflow'), 'AMA dispatch description must not point at run_workflow').toBe(false);

      const dispatchRate = new Map<string, Map<ModelAlias, number>>();
      const phantomRate = new Map<string, Map<ModelAlias, number>>();

      for (const c of CASES) {
        const perAliasDispatch = new Map<ModelAlias, number>();
        const perAliasPhantom = new Map<ModelAlias, number>();
        const aliasDumps: Array<{ alias: string; dispatchRate: number; phantomRate: number; runs: RunRecord[] }> = [];

        for (const alias of panel) {
          const runs: RunRecord[] = [];
          for (let i = 0; i < RUNS; i += 1) {
            try {
              const oneShot = {
                systemPrompt: SYSTEM_PROMPT,
                userMessage: c.userMessage,
                tools: TOOLS,
                ...(c.priorMessages ? { priorMessages: c.priorMessages } : {}),
              };
              let out: Awaited<ReturnType<typeof runOneShot>>;
              try {
                out = await runOneShot(alias, oneShot);
              } catch (primaryError) {
                const fallback = ALIAS_FALLBACK[alias];
                if (!fallback) throw primaryError;
                out = await runOneShot(fallback, oneShot);
              }
              const names = out.toolCalls.map((t) => t.name);
              runs.push({
                runIndex: i,
                text: out.text,
                toolCalls: names,
                dispatched: names.includes('dispatch_child_task'),
                emittedRunWorkflow: names.includes('run_workflow'),
                mentionsPhantomTool: PHANTOM_TOOL_RE.test(out.text ?? ''),
                durationMs: out.durationMs,
              });
            } catch (error) {
              runs.push({
                runIndex: i,
                text: `[ERROR] ${error instanceof Error ? error.message : String(error)}`,
                toolCalls: [],
                dispatched: false,
                emittedRunWorkflow: false,
                mentionsPhantomTool: false,
                durationMs: 0,
              });
            }
          }
          const denom = Math.max(1, runs.length);
          perAliasDispatch.set(alias, runs.filter((r) => r.dispatched).length / denom);
          perAliasPhantom.set(alias, runs.filter((r) => r.mentionsPhantomTool).length / denom);
          aliasDumps.push({
            alias,
            dispatchRate: perAliasDispatch.get(alias)!,
            phantomRate: perAliasPhantom.get(alias)!,
            runs,
          });
        }

        dispatchRate.set(c.id, perAliasDispatch);
        phantomRate.set(c.id, perAliasPhantom);
        writeFileSync(
          join(DUMP_DIR, `${c.id}.json`),
          JSON.stringify({ case: c.id, userMessage: c.userMessage, aliases: aliasDumps }, null, 2),
          'utf8',
        );
      }

      // ---- table (cell = dispatch% / phantom%) ----
      const header = ['case (dispatch%/phantom%)', ...panel].join(' | ');
      const pct = (v: number): string => `${Math.round(v * 100)}`;
      const rows = CASES.map((c) => {
        const d = dispatchRate.get(c.id)!;
        const p = phantomRate.get(c.id)!;
        const cells = panel.map((a) => `${pct(d.get(a) ?? 0)}/${pct(p.get(a) ?? 0)}`);
        return [c.id, ...cells].join(' | ');
      });
      // eslint-disable-next-line no-console
      console.log(`\n[FEATURE_246 AMA gating] panel=${panel.join(',')} runs=${RUNS}\n${header}\n${rows.join('\n')}\nDumps: ${DUMP_DIR}\n`);

      const mean = (map: Map<string, Map<ModelAlias, number>>, c: EvalCase): number => {
        const perAlias = map.get(c.id)!;
        const vals = panel.map((a) => perAlias.get(a) ?? 0);
        return vals.reduce((s, v) => s + v, 0) / Math.max(1, vals.length);
      };

      if (panel.length >= 3) {
        for (const c of CASES) {
          // Graceful degradation: on a fan-out task the AMA Worker uses the
          // fan-out tool it has.
          expect(mean(dispatchRate, c), `${c.id}: AMA Worker should dispatch on a fan-out task (mean >= 0.5)`).toBeGreaterThanOrEqual(0.5);
          // Phantom-tool reference (observational, soft gate): it should not be
          // pining for a run_workflow it was never offered.
          expect(mean(phantomRate, c), `${c.id}: AMA Worker should not reference an absent run_workflow (mean <= 0.3)`).toBeLessThanOrEqual(0.3);
        }
      }
    },
    600_000,
  );
});
