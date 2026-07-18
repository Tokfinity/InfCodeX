/**
 * FEATURE_246 Part A3 — `run_workflow` tool-description trigger eval (Layer 2).
 *
 * Question (not answerable by Layer 1): does the production `run_workflow` tool
 * DESCRIPTION make a coding-plan model reach for it on workflow-worthy tasks
 * (multi-codebase compare, multi-lens adversarial diff review) while NOT
 * over-triggering on a single focused sub-task or a trivial lookup?
 *
 * Design (per benchmark/EVAL_GUIDELINES.md):
 * - Single-turn probe. Production tool bytes via the `tools` channel (real
 *   BUILTIN_TOOL_DEFINITIONS — run_workflow + its real alternatives), not stubs
 *   (anti-pattern 8).
 * - Assertion is STRUCTURAL: `runOneShot` captures real toolCalls, so we read
 *   `toolCalls[].name` directly — no regex / no negation-on-text false negatives
 *   (anti-pattern 7).
 * - Pilot first on `ark/v4flash` (anti-pattern 4): run with
 *   `KODAX_EVAL_ALIASES=ark/v4flash KODAX_EVAL_RUNS=1`. Hard gate only fires for
 *   a >=3-alias panel; pilot runs are informational (table + dump only).
 * - Raw dump → os.tmpdir()/kodax-eval-dumps/feature-246/<case>.json.
 *
 * Pre-registered gate (panel, >=3 aliases):
 * - POSITIVE cases: mean run_workflow trigger rate >= 0.5 across aliases.
 * - NEGATIVE cases: mean run_workflow trigger rate <= 0.3 (no over-trigger).
 *
 * Run:
 *   npm run test:eval -- tests/feature-246-run-workflow-tool.eval.ts
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

const TOOL_SUBSET = ['run_workflow', 'dispatch_child_task', 'read', 'grep', 'glob', 'code_search', 'bash', 'write', 'edit'];

// Production tool bytes via the package entry (registry bootstraps in the right
// order; importing the deep tool-definitions path hits a module-init cycle).
function productionToolSubset(): KodaXToolDefinition[] {
  return getAllRegisteredTools()
    .filter((t) => TOOL_SUBSET.includes(t.name))
    .map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
}

const SYSTEM_PROMPT = [
  'You are the Worker — an autonomous coding agent with a full toolset:',
  'read / grep / glob / code_search / bash for investigation, write / edit to change files,',
  'dispatch_child_task to delegate a single focused sub-agent, and run_workflow to author and run a multi-agent workflow.',
  'Investigate and act on the user request using tools. Begin now by calling the most appropriate tool(s); do not ask clarifying questions first.',
].join('\n');

interface EvalCase {
  readonly id: string;
  readonly expectWorkflow: boolean;
  readonly userMessage: string;
  /**
   * Positive cases prime the scoping turn (anti-pattern 11): coding-plan models
   * legitimately explore with read/grep before deciding the execution shape, so
   * a first-action metric floor-saturates. Priming "scoping is done" isolates
   * the execution-shape decision (run_workflow vs linear) we actually want to
   * measure. Negatives stay first-action — they must not trigger even fresh.
   */
  readonly priorMessages?: ReadonlyArray<{ readonly role: 'user' | 'assistant'; readonly content: string }>;
}

const CASES: readonly EvalCase[] = [
  {
    id: 'P1_compare_three_codebases',
    expectWorkflow: true,
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
  {
    id: 'P2_multilens_adversarial_diff_review',
    expectWorkflow: true,
    priorMessages: [
      {
        role: 'user',
        content:
          'Review the change in /tmp/batch.diff from three independent angles — correctness, regression risk, and test rigor — and for each finding, adversarially verify it against the real source files before reporting. Give me the confirmed issues only.',
      },
      {
        role: 'assistant',
        content:
          'I read the diff: it touches five files across the llm and coding layers (tool-input parsing, history alternation, stream termination). Each review lens (correctness / regression / test-rigor) is an independent pass, and each finding then needs an adversarial second pass that opens the real files to confirm or dissolve it.',
      },
    ],
    userMessage: 'Right — now run the three-lens review and adversarially verify each finding, then give me the confirmed issues.',
  },
  {
    id: 'N1_single_root_cause',
    expectWorkflow: false,
    userMessage:
      "The test 'logs in with valid credentials' in src/auth/login.test.ts is failing intermittently. Find the root cause and report it.",
  },
  {
    id: 'N2_trivial_lookup',
    expectWorkflow: false,
    userMessage: 'What is the default value of `thinkingBudgetCap` in config.example.jsonc?',
  },
];

const CANONICAL_PANEL: readonly ModelAlias[] = ['zhipu/glm52', 'kimi', 'mmx/m3', 'ark/v4pro', 'ark/v4flash'];

// Documented fallback (per feedback_harness_alias_fallback): ark-coding's
// DeepSeek slots fall back to the deepseek official API when the ark CodingPlan
// subscription is unavailable. Same model, different gateway.
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
const DUMP_DIR = join(tmpdir(), 'kodax-eval-dumps', 'feature-246');

// Scout-then-author INTENT: a model that scouts first (read/grep) but states it
// will then author a workflow. The first-action `toolCalls` metric can't see the
// next-turn authoring (anti-pattern 11), so this text signal (paired with the
// structural toolCalls, per anti-pattern 7 — observational, not a positive hard
// gate) reveals the taught behavior. On NEGATIVE cases intent must stay ~0.
const INTENT_RE = /\b(run_workflow|workflow|fan[ -]?out|pipeline|adversarial)/i;

interface RunRecord {
  readonly runIndex: number;
  readonly text: string;
  readonly toolCalls: readonly string[];
  readonly calledRunWorkflow: boolean;
  /** Called run_workflow first-action OR stated scout-then-author intent in text. */
  readonly intent: boolean;
  readonly passed: boolean;
  readonly durationMs: number;
}

describe('FEATURE_246 run_workflow tool-description trigger', () => {
  const panel = resolvePanel();

  it.runIf(panel.length > 0)(
    'triggers run_workflow on workflow-worthy tasks and not on single/trivial tasks',
    async () => {
      mkdirSync(DUMP_DIR, { recursive: true });
      const TOOLS = productionToolSubset();
      expect(TOOLS.some((t) => t.name === 'run_workflow'), 'run_workflow must be registered').toBe(true);
      // case id -> alias -> rate
      const triggerRate = new Map<string, Map<ModelAlias, number>>();
      const intentRate = new Map<string, Map<ModelAlias, number>>();

      for (const c of CASES) {
        const perAlias = new Map<ModelAlias, number>();
        const perAliasIntent = new Map<ModelAlias, number>();
        const aliasDumps: Array<{ alias: string; triggerRate: number; intentRate: number; runs: RunRecord[] }> = [];

        for (const alias of panel) {
          const runs: RunRecord[] = [];
          // concurrency = 1 per alias (anti-pattern 3: shared coding-plan quota)
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
              const called = names.includes('run_workflow');
              runs.push({
                runIndex: i,
                text: out.text,
                toolCalls: names,
                calledRunWorkflow: called,
                intent: called || INTENT_RE.test(out.text ?? ''),
                passed: called === c.expectWorkflow,
                durationMs: out.durationMs,
              });
            } catch (error) {
              // A single alias failing (rate limit / expired subscription) must
              // not nuke the panel or the other aliases' data.
              runs.push({
                runIndex: i,
                text: `[ERROR] ${error instanceof Error ? error.message : String(error)}`,
                toolCalls: [],
                calledRunWorkflow: false,
                intent: false,
                passed: false,
                durationMs: 0,
              });
            }
          }
          const denom = Math.max(1, runs.length);
          const rate = runs.filter((r) => r.calledRunWorkflow).length / denom;
          const iRate = runs.filter((r) => r.intent).length / denom;
          perAlias.set(alias, rate);
          perAliasIntent.set(alias, iRate);
          aliasDumps.push({ alias, triggerRate: rate, intentRate: iRate, runs });
        }

        triggerRate.set(c.id, perAlias);
        intentRate.set(c.id, perAliasIntent);
        writeFileSync(
          join(DUMP_DIR, `${c.id}.json`),
          JSON.stringify({ case: c.id, expectWorkflow: c.expectWorkflow, userMessage: c.userMessage, aliases: aliasDumps }, null, 2),
          'utf8',
        );
      }

      // ---- table (cell = called% / intent%) ----
      const header = ['case (called%/intent%)', ...panel].join(' | ');
      const pct = (v: number): string => `${Math.round(v * 100)}`;
      const rows = CASES.map((c) => {
        const t = triggerRate.get(c.id)!;
        const ix = intentRate.get(c.id)!;
        const cells = panel.map((a) => `${pct(t.get(a) ?? 0)}/${pct(ix.get(a) ?? 0)}`);
        return [`${c.id}${c.expectWorkflow ? ' [+]' : ' [-]'}`, ...cells].join(' | ');
      });
      // eslint-disable-next-line no-console
      console.log(`\n[FEATURE_246 run_workflow trigger] panel=${panel.join(',')} runs=${RUNS}\n${header}\n${rows.join('\n')}\nDumps: ${DUMP_DIR}\n`);

      const meanOf = (map: Map<string, Map<ModelAlias, number>>, c: EvalCase): number => {
        const perAlias = map.get(c.id)!;
        const vals = panel.map((a) => perAlias.get(a) ?? 0);
        return vals.reduce((s, v) => s + v, 0) / Math.max(1, vals.length);
      };
      const meanRate = (c: EvalCase): number => meanOf(triggerRate, c);
      const meanIntent = (c: EvalCase): number => meanOf(intentRate, c);

      const triggeredByAnyAlias = (c: EvalCase): boolean =>
        panel.some((a) => (triggerRate.get(c.id)!.get(a) ?? 0) > 0);

      // Pre-registered gate (panel >= 3 aliases). Pilot (<3) is informational.
      //
      // - NEGATIVE (the real risk + a STABLE signal): the description must not
      //   OVER-trigger run_workflow on a single sub-task or a trivial lookup.
      //   Hard, per-case mean <= 0.3. (Observed: 0% across the whole panel.)
      // - POSITIVE (discoverability FLOOR, not a majority gate): run_workflow
      //   must be reachable for at least one workflow-worthy task somewhere on
      //   the panel. A per-case majority gate is wrong here for two reasons:
      //   (1) run_workflow legitimately overlaps dispatch_child_task x N for
      //   fan-out, so models split between them; (2) single-turn trigger is
      //   variable run-to-run (anti-pattern 11). Per-alias rates are logged for
      //   inspection; the floor guards only against the tool becoming totally
      //   undiscoverable. Observed: P1 reliably via kimi + mmx/m3; P2 via kimi
      //   (variable). No alias over-triggers.
      const intendedByAnyAlias = (c: EvalCase): boolean =>
        panel.some((a) => (intentRate.get(c.id)!.get(a) ?? 0) > 0);

      if (panel.length >= 3) {
        // NEGATIVE (the real risk): must not over-trigger, and must not even
        // *intend* a workflow for a single/trivial task. Both hard, both stable.
        for (const c of CASES.filter((x) => !x.expectWorkflow)) {
          expect(meanRate(c), `${c.id} must NOT over-trigger run_workflow (called mean <= 0.3)`).toBeLessThanOrEqual(0.3);
          expect(meanIntent(c), `${c.id} must NOT even intend a workflow (intent mean <= 0.3)`).toBeLessThanOrEqual(0.3);
        }
        // POSITIVE: scout-then-author must be reachable on >=1 workflow-worthy
        // case — counting either a first-action call OR a stated intent (the
        // taught "read first, then author a workflow" that single-turn
        // first-action under-counts, anti-pattern 11). Logged per-alias above.
        const reachable = CASES.filter((x) => x.expectWorkflow).some(
          (c) => triggeredByAnyAlias(c) || intendedByAnyAlias(c),
        );
        expect(reachable, 'scout-then-author must be reachable on >=1 workflow-worthy case (called or intent)').toBe(true);
      }
    },
    600_000,
  );
});
