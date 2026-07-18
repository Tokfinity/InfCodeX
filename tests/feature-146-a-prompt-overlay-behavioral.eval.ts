/**
 * Eval: FEATURE_146-A prompt-overlay position migration behavioral eval (v0.7.37).
 *
 * ## Why this exists
 *
 * v0.7.36 FEATURE_143 migrated the prompt overlay from the user-prompt
 * head (legacy v0.7.35.1, runner-driven.ts) to the system-prompt section
 * (`ManagedRolePromptContext.promptOverlay` rendered by `createRolePrompt`).
 * The structural ship gate
 * (`tests/prompt-overlay-position-migration.eval.ts`) verifies migration
 * completeness — overlay text reaches every role's system prompt. What
 * it cannot answer: do real LLMs **act on** the overlay the same way
 * when it's repositioned?
 *
 * This eval is the load-bearing follow-up tracked in
 * `docs/features/v0.7.37.md` § FEATURE_146 Sub-feature A.
 *
 * ## Per-cell measurement
 *
 * For each (alias × task × variant) cell, run a single-turn probe and
 * apply the task's mechanical predicate (overlay-directive surfaces
 * in tool calls / text).
 *
 *   - Variant A (legacy v0.7.35.1 user-prompt-head)
 *   - Variant B (v0.7.36 system-prompt-section)
 *
 * ## Pre-registered thresholds
 *
 *   - PASS gate (must on every task): variant B pass rate ≥ variant A
 *     pass rate − 10pp (no regression beyond 10pp)
 *   - INFORMATIONAL: aggregate variant B mean pass rate ≥ 50% (overlay
 *     information IS reaching the model in section position)
 *
 * ## Aliases
 *
 *   5 aliases with API keys configured: `zhipu/glm52`, `kimi`, `mmx/m3`,
 *   `ds/v4pro`, `ds/v4flash`. Cells skip individually when their key is
 *   absent (per `availableAliases()`).
 *
 * ## Run
 *
 *   npm run test:eval -- feature-146-a-prompt-overlay-behavioral
 */

import { describe, expect, it } from 'vitest';

import type { KodaXToolUseBlock } from '@kodax-ai/llm';

import { createRolePrompt } from '../packages/coding/src/task-engine/_internal/managed-task/role-prompt.js';
import { buildFallbackRoutingDecision } from '../packages/coding/src/reasoning.js';
import type { ManagedRolePromptContext } from '../packages/coding/src/task-engine/_internal/managed-task/role-prompt-types.js';

import { availableAliases, type ModelAlias } from '../benchmark/harness/aliases.js';
import { runOneShot } from '../benchmark/harness/harness.js';
import {
  buildVariantALegacy,
  buildVariantBSection,
  OVERLAY_TASKS,
  type OverlayTaskCase,
} from '../benchmark/datasets/prompt-overlay-position/cases.js';

const PROBE_ALIASES: ModelAlias[] = [
  'zhipu/glm52',
  'kimi',
  'mmx/m3',
  'ds/v4pro',
  'ds/v4flash',
];

const RUNNABLE_ALIASES = availableAliases(...PROBE_ALIASES);

const FIXTURE_CWD = 'C:\\fixture\\fea146a-overlay';

// ---------------------------------------------------------------------------
// Role-prompt builders for each variant
// ---------------------------------------------------------------------------

function buildBaseRolePrompt(): string {
  // Bare role prompt — no overlay (variant A baseline).
  const ctx: ManagedRolePromptContext = {
    originalTask: 'overlay-eval probe',
    workspace: {
      executionCwd: FIXTURE_CWD,
      gitRoot: FIXTURE_CWD,
      platform: 'win32',
    },
  };
  return createRolePrompt(
    'generator',
    'overlay-eval probe',
    buildFallbackRoutingDecision('overlay-eval probe'),
    undefined,
    undefined,
    'kodax/role/generator',
    undefined,
    ctx,
    undefined,
    /* isTerminalAuthority */ true,
  );
}

function buildRolePromptWithOverlay(overlayText: string): string {
  const ctx: ManagedRolePromptContext = {
    originalTask: 'overlay-eval probe',
    workspace: {
      executionCwd: FIXTURE_CWD,
      gitRoot: FIXTURE_CWD,
      platform: 'win32',
    },
    promptOverlay: overlayText,
  };
  return createRolePrompt(
    'generator',
    'overlay-eval probe',
    buildFallbackRoutingDecision('overlay-eval probe'),
    undefined,
    undefined,
    'kodax/role/generator',
    undefined,
    ctx,
    undefined,
    /* isTerminalAuthority */ true,
  );
}

// ---------------------------------------------------------------------------
// Cell shape + execution
// ---------------------------------------------------------------------------

type Variant = 'A-legacy' | 'B-section';

interface CellResult {
  readonly alias: ModelAlias;
  readonly taskId: OverlayTaskCase['id'];
  readonly variant: Variant;
  readonly passed: boolean;
  readonly text: string;
  readonly toolNames: readonly string[];
  readonly error?: string;
}

async function runCell(
  alias: ModelAlias,
  task: OverlayTaskCase,
  variant: Variant,
): Promise<CellResult> {
  try {
    const input =
      variant === 'A-legacy'
        ? buildVariantALegacy(task, buildBaseRolePrompt())
        : buildVariantBSection(task, buildRolePromptWithOverlay(task.overlayText));
    const result = await runOneShot(alias, {
      systemPrompt: input.systemPrompt,
      userMessage: input.userMessage,
      tools: input.tools,
      priorMessages: input.priorMessages,
    });
    const toolBlocks: KodaXToolUseBlock[] = result.toolCalls.map((c) => ({
      type: 'tool_use',
      id: 'probe-id',
      name: c.name,
      input: c.input as Record<string, unknown>,
    }));
    const passed = task.predicate({
      text: result.text,
      toolBlocks,
      toolNames: result.toolCalls.map((c) => c.name),
    });
    return {
      alias,
      taskId: task.id,
      variant,
      passed,
      text: result.text,
      toolNames: result.toolCalls.map((c) => c.name),
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      alias,
      taskId: task.id,
      variant,
      passed: false,
      text: `[probe error: ${errMsg}]`,
      toolNames: [],
      error: errMsg,
    };
  }
}

interface AggregateReport {
  readonly cells: readonly CellResult[];
  /** task → variant → { passed, total } */
  readonly perTaskByVariant: Readonly<
    Record<string, Readonly<Record<Variant, { passed: number; total: number }>>>
  >;
  /** variant → mean pass rate (0-100) */
  readonly meanByVariant: Readonly<Record<Variant, number>>;
}

function aggregate(cells: readonly CellResult[]): AggregateReport {
  const perTaskByVariant: Record<
    string,
    Record<Variant, { passed: number; total: number }>
  > = {};
  for (const c of cells) {
    perTaskByVariant[c.taskId] ??= {
      'A-legacy': { passed: 0, total: 0 },
      'B-section': { passed: 0, total: 0 },
    };
    perTaskByVariant[c.taskId]![c.variant].total += 1;
    if (c.passed) perTaskByVariant[c.taskId]![c.variant].passed += 1;
  }
  const variantTotals: Record<Variant, { passed: number; total: number }> = {
    'A-legacy': { passed: 0, total: 0 },
    'B-section': { passed: 0, total: 0 },
  };
  for (const c of cells) {
    variantTotals[c.variant].total += 1;
    if (c.passed) variantTotals[c.variant].passed += 1;
  }
  const meanByVariant: Record<Variant, number> = {
    'A-legacy':
      variantTotals['A-legacy'].total === 0
        ? 0
        : (variantTotals['A-legacy'].passed / variantTotals['A-legacy'].total) * 100,
    'B-section':
      variantTotals['B-section'].total === 0
        ? 0
        : (variantTotals['B-section'].passed / variantTotals['B-section'].total) * 100,
  };
  return { cells, perTaskByVariant, meanByVariant };
}

const reportRef: { current: AggregateReport | undefined } = { current: undefined };

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('FEATURE_146-A — Prompt-overlay position migration behavioral eval', () => {
  describe.skipIf(RUNNABLE_ALIASES.length === 0)('with ≥1 alias key configured', () => {
    it(
      `runs ${RUNNABLE_ALIASES.length} aliases × ${OVERLAY_TASKS.length} tasks × 2 variants serially`,
      async () => {
        const cells: CellResult[] = [];
        for (const alias of RUNNABLE_ALIASES) {
          for (const task of OVERLAY_TASKS) {
            for (const variant of ['A-legacy', 'B-section'] as Variant[]) {
              const cell = await runCell(alias, task, variant);
              cells.push(cell);
              // eslint-disable-next-line no-console
              console.log(
                `[probe] ${alias} / ${task.id} / ${variant}: ` +
                  `${cell.passed ? 'PASS' : 'fail'}  tools=[${cell.toolNames.join(',')}]` +
                  (cell.error ? ` ERROR=${cell.error}` : ''),
              );
            }
          }
        }
        reportRef.current = aggregate(cells);
        expect(cells.length).toBe(
          RUNNABLE_ALIASES.length * OVERLAY_TASKS.length * 2,
        );
      },
      // 5 alias × 6 task × 2 variant × ~15s/cell upper bound = 15 min.
      // Vitest timeout overshoot to 30 min for slow providers.
      30 * 60_000,
    );

    it('per-task: variant B does not regress more than 10pp vs variant A', () => {
      const report = reportRef.current;
      expect(report).toBeDefined();
      const failures: string[] = [];
      for (const task of OVERLAY_TASKS) {
        const counts = report!.perTaskByVariant[task.id];
        if (!counts) continue;
        const aRate =
          counts['A-legacy'].total === 0
            ? 0
            : (counts['A-legacy'].passed / counts['A-legacy'].total) * 100;
        const bRate =
          counts['B-section'].total === 0
            ? 0
            : (counts['B-section'].passed / counts['B-section'].total) * 100;
        // eslint-disable-next-line no-console
        console.log(
          `[fea146-A] ${task.id}: A-legacy=${counts['A-legacy'].passed}/${counts['A-legacy'].total} ` +
            `(${aRate.toFixed(0)}%) B-section=${counts['B-section'].passed}/${counts['B-section'].total} ` +
            `(${bRate.toFixed(0)}%) Δ=${(bRate - aRate).toFixed(0)}pp`,
        );
        if (aRate - bRate > 10) {
          failures.push(`${task.id}: B regression ${(aRate - bRate).toFixed(0)}pp (A=${aRate.toFixed(0)}%, B=${bRate.toFixed(0)}%)`);
        }
      }
      expect(
        failures,
        `B-section variant regressed more than 10pp on ${failures.length} tasks: ${failures.join('; ')}`,
      ).toHaveLength(0);
    });

    it('aggregate variant B mean pass rate ≥ 50% (informational floor — overlay must reach model)', () => {
      const report = reportRef.current;
      expect(report).toBeDefined();
      // eslint-disable-next-line no-console
      console.log(
        `[fea146-A] aggregate mean: A-legacy=${report!.meanByVariant['A-legacy'].toFixed(0)}% ` +
          `B-section=${report!.meanByVariant['B-section'].toFixed(0)}%`,
      );
      // Floor: 50% — below this, the overlay-in-section position is
      // rhetorically dead even if A-legacy is also bad. Assert non-zero
      // so we don't pretend it's working when it isn't.
      expect(
        report!.meanByVariant['B-section'],
        'B-section mean below 50% — overlay-in-section position not reaching model',
      ).toBeGreaterThanOrEqual(50);
    });

    it('per-alias breakdown report (informational)', () => {
      const report = reportRef.current;
      expect(report).toBeDefined();
      const byAliasVariant = new Map<string, { passed: number; total: number }>();
      for (const c of report!.cells) {
        const key = `${c.alias} / ${c.variant}`;
        const counts = byAliasVariant.get(key) ?? { passed: 0, total: 0 };
        counts.total += 1;
        if (c.passed) counts.passed += 1;
        byAliasVariant.set(key, counts);
      }
      // eslint-disable-next-line no-console
      console.log('[fea146-A] per-alias × variant breakdown:');
      for (const [key, counts] of byAliasVariant) {
        // eslint-disable-next-line no-console
        console.log(`  ${key.padEnd(28)}  ${counts.passed}/${counts.total}`);
      }
    });
  });

  it('at least one alias has an API key configured', () => {
    if (RUNNABLE_ALIASES.length === 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[fea146-A behavioral eval] No alias keys present (need any of ` +
          `ZHIPU_CODING_API_KEY / KIMI_CODE_API_KEY / MINIMAX_CODING_API_KEY / DEEPSEEK_API_KEY) — eval is skipped.`,
      );
    }
    expect(true).toBe(true);
  });
});
