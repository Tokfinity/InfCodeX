import { createHash, randomInt } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';

import {
  ALL_MODEL_ALIASES,
  availableAliases,
  resolveAlias,
  type ModelAlias,
} from '../benchmark/harness/aliases.js';
import { runOneShot } from '../benchmark/harness/harness.js';
import {
  buildSidecarAlignmentInput,
  CASES,
  classifySidecarVerdict,
  type SidecarAlignmentCase,
  type SidecarAlignmentVariant,
} from '../benchmark/datasets/feature-270-sidecar-alignment/cases.js';

type EvalMode = 'pilot' | 'full';
type BlindArm = 'A' | 'B';

const MODE: EvalMode = process.env.KODAX_F270_SIDECAR_EVAL === 'full' ? 'full' : 'pilot';
const MAX_PROVIDER_CALLS = 32;
const MAX_CALLS_PER_CELL = 1;
const MAX_OUTPUT_TOKENS = 1_024;
const MAX_TOTAL_TOKENS = 120_000;
const CALL_TIMEOUT_MS = 90_000;
const MAX_ESTIMATED_COST_USD = 4;
const DUMP_ROOT = join(tmpdir(), 'kodax-eval-dumps', 'feature-270-sidecar-alignment');

const DEFAULT_PANEL: readonly ModelAlias[] = MODE === 'pilot'
  ? ['ark/v4flash']
  : ['zhipu/glm52', 'ark/v4flash'];

function requestedPanel(): readonly ModelAlias[] {
  const raw = process.env.KODAX_F270_SIDECAR_ALIASES;
  if (!raw) return DEFAULT_PANEL;
  const values = raw.split(',').map((value) => value.trim()).filter(Boolean);
  if (values.length > 2) throw new Error('KODAX_F270_SIDECAR_ALIASES is limited to 2 aliases.');
  for (const value of values) {
    if (!ALL_MODEL_ALIASES.includes(value as ModelAlias)) {
      throw new Error(`Unknown eval alias: ${value}`);
    }
  }
  return values as ModelAlias[];
}

const PILOT_CASE_IDS = new Set([
  'required_plan_item_still_pending',
  'optional_open_plan_does_not_over_revise',
]);
const REQUESTED_CASES: readonly SidecarAlignmentCase[] = MODE === 'pilot'
  ? CASES.filter((testCase) => PILOT_CASE_IDS.has(testCase.id))
  : CASES;

interface BlindMapping {
  readonly A: SidecarAlignmentVariant;
  readonly B: SidecarAlignmentVariant;
}

interface EvalRow {
  readonly caseId: string;
  readonly description: string;
  readonly expectedVerdict: 'accept' | 'revise' | 'blocked';
  readonly alias: ModelAlias;
  readonly arm: BlindArm;
  readonly input: {
    readonly systemPrompt: string;
    readonly userMessage: string;
  };
  readonly target: { readonly provider: string; readonly model: string };
  readonly durationMs: number;
  readonly text: string;
  readonly toolCalls: ReadonlyArray<{ readonly name: string; readonly input: unknown }>;
  readonly error?: string;
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
  };
  readonly mechanical: ReturnType<typeof classifySidecarVerdict>;
}

function armMapping(): BlindMapping {
  return randomInt(2) === 0
    ? { A: 'baseline', B: 'candidate' }
    : { A: 'candidate', B: 'baseline' };
}

function stableRows(rows: readonly EvalRow[]): readonly EvalRow[] {
  return [...rows].sort((left, right) => (
    left.caseId.localeCompare(right.caseId)
    || left.alias.localeCompare(right.alias)
    || left.arm.localeCompare(right.arm)
  ));
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(DUMP_ROOT, { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
}

describe(`Eval: FEATURE_270 Sidecar control-plane alignment (${MODE})`, () => {
  const aliases = availableAliases(...requestedPanel());
  if (aliases.length === 0) {
    it('skips: no requested provider API key is available', () => undefined);
    return;
  }

  it('runs the bounded blind A/B evidence probe', { timeout: 1_800_000 }, async () => {
    const expectedCalls = aliases.length * REQUESTED_CASES.length * 2;
    if (expectedCalls > MAX_PROVIDER_CALLS) {
      throw new Error(`Eval call graph requires ${expectedCalls} calls; cap is ${MAX_PROVIDER_CALLS}.`);
    }

    const runId = `${MODE}-${Date.now()}`;
    const rawPath = join(DUMP_ROOT, `${runId}-raw.json`);
    const blindPath = join(DUMP_ROOT, `${runId}-blind.json`);
    const revealPath = join(DUMP_ROOT, `${runId}-reveal.json`);
    const mappings = Object.fromEntries(REQUESTED_CASES.map((testCase) => [
      testCase.id,
      armMapping(),
    ])) as Record<string, BlindMapping>;
    const rows: EvalRow[] = [];
    let providerCalls = 0;
    let observedTokens = 0;

    const flushRaw = (): void => {
      writeJson(rawPath, {
        feature: 'FEATURE_270-sidecar-alignment',
        mode: MODE,
        timestamp: new Date().toISOString(),
        experimentContract: {
          layer1CannotAnswer: [
            'whether added evidence changes semantic verdict quality',
            'whether open plan items induce over-revision',
          ],
          maxProviderCalls: MAX_PROVIDER_CALLS,
          maxCallsPerCell: MAX_CALLS_PER_CELL,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          maxTotalTokens: MAX_TOTAL_TOKENS,
          maxEstimatedCostUsd: MAX_ESTIMATED_COST_USD,
          providerConcurrency: 'one in-flight call per model lane; harness enforced',
          recommendationRubric: 'material lift without credible over-revision => recommend-ship; mixed recoverable regression => recommend-iterate; net prompt harm => recommend-revert; invalid task/scorer => eval-invalid',
        },
        aliases,
        expectedCalls,
        completedCalls: providerCalls,
        observedTokens,
        rows: stableRows(rows),
        mainSessionReview: [],
      });
    };

    process.stdout.write(`[F270 sidecar] raw: ${rawPath}\n`);
    process.stdout.write(`[F270 sidecar] blind: ${blindPath}\n`);
    process.stdout.write(`[F270 sidecar] reveal: ${revealPath}\n`);
    flushRaw();

    await Promise.all(aliases.map(async (alias) => {
      for (const testCase of REQUESTED_CASES) {
        const mapping = mappings[testCase.id];
        if (!mapping) throw new Error(`Missing blind mapping for ${testCase.id}.`);
        for (const arm of ['A', 'B'] as const) {
          if (providerCalls >= MAX_PROVIDER_CALLS) throw new Error('Provider call budget exhausted.');
          if (observedTokens >= MAX_TOTAL_TOKENS) throw new Error('Observed token budget exhausted.');
          providerCalls += 1;
          const variant = mapping[arm];
          const input = buildSidecarAlignmentInput(testCase, variant);
          const startedAt = Date.now();
          let result: Awaited<ReturnType<typeof runOneShot>>;
          try {
            result = await runOneShot(alias, {
              ...input,
              timeoutMs: CALL_TIMEOUT_MS,
              maxOutputTokens: MAX_OUTPUT_TOKENS,
            });
          } catch (error: unknown) {
            const target = resolveAlias(alias);
            rows.push({
              caseId: testCase.id,
              description: testCase.description,
              expectedVerdict: testCase.expectedVerdict,
              alias,
              arm,
              input: {
                systemPrompt: input.systemPrompt,
                userMessage: input.userMessage,
              },
              target: { provider: target.provider, model: target.model },
              durationMs: Date.now() - startedAt,
              text: '',
              toolCalls: [],
              error: error instanceof Error ? error.message : String(error),
              mechanical: classifySidecarVerdict(testCase.expectedVerdict, []),
            });
            flushRaw();
            continue;
          }
          observedTokens += result.usage?.totalTokens ?? 0;
          rows.push({
            caseId: testCase.id,
            description: testCase.description,
            expectedVerdict: testCase.expectedVerdict,
            alias,
            arm,
            input: {
              systemPrompt: input.systemPrompt,
              userMessage: input.userMessage,
            },
            target: {
              provider: result.target.provider,
              model: result.target.model,
            },
            durationMs: result.durationMs,
            text: result.text,
            toolCalls: result.toolCalls,
            ...(result.usage ? { usage: {
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
              totalTokens: result.usage.totalTokens,
            } } : {}),
            mechanical: classifySidecarVerdict(testCase.expectedVerdict, result.toolCalls),
          });
          flushRaw();
        }
      }
    }));

    const blindPacket = {
      feature: 'FEATURE_270-sidecar-alignment',
      mode: MODE,
      aliases,
      cases: REQUESTED_CASES.map((testCase) => ({
        id: testCase.id,
        description: testCase.description,
        expectedVerdict: testCase.expectedVerdict,
        arms: stableRows(rows)
          .filter((row) => row.caseId === testCase.id)
          .map((row) => ({
            alias: row.alias,
            arm: row.arm,
            text: row.text,
            toolCalls: row.toolCalls,
            ...(row.error ? { error: row.error } : {}),
            mechanical: row.mechanical,
          })),
      })),
    };
    const blindJson = JSON.stringify(blindPacket, null, 2);
    writeJson(blindPath, blindPacket);
    writeJson(revealPath, {
      blindPacketSha256: createHash('sha256').update(blindJson).digest('hex'),
      mappings,
    });
    flushRaw();
  });
});
