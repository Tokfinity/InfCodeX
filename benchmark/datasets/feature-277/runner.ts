import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  calculateCost,
  getCostRate,
  type CostRate,
  type KodaXTokenUsage,
} from '@kodax-ai/llm';
import {
  buildClassifierPrompt,
  parseClassifierOutput,
} from '@kodax-ai/coding';
import { buildPermissionIntentEvidence } from '../../../packages/coding/src/guardrails/auto-mode/permission-intent.js';
import type { ModelAlias } from '../../harness/aliases.js';
import { MODEL_ALIASES } from '../../harness/aliases.js';
import { runOneShot } from '../../harness/harness.js';
import {
  FEATURE_277_CASES,
  FEATURE_277_PILOT_CASES,
  type Feature277EvalCase,
  type Feature277ExpectedVerdict,
} from './cases.js';
import {
  FEATURE_277_PANEL_ALIASES,
  FEATURE_277_PILOT_ALIAS,
  FEATURE_277_RAW_ROOT,
  FEATURE_277_REVISION,
  buildFeature277ExperimentContract,
} from './experiment-contract.js';

type Feature277Stage = 'pilot' | 'panel';

const EMPTY_RULES = { allow: [], soft_deny: [], environment: [] } as const;
const LIMITS = {
  pilot: {
    maxProviderCalls: 4,
    maxTotalTokens: 40_000,
    maxExternalSpendUsd: 1,
  },
  panel: {
    maxProviderCalls: 60,
    maxTotalTokens: 300_000,
    maxExternalSpendUsd: 6,
  },
} as const;

interface Feature277PhysicalResult {
  readonly schemaVersion: 1;
  readonly status: 'complete';
  readonly inputHash: string;
  readonly alias: ModelAlias;
  readonly caseId: string;
  readonly repetition: number;
  readonly response: {
    readonly text: string;
    readonly toolCalls: ReadonlyArray<{ readonly name: string; readonly input: unknown }>;
    readonly usage: KodaXTokenUsage;
    readonly durationMs: number;
  };
  readonly verdict: Feature277ExpectedVerdict | 'unparseable';
  readonly reason: string;
  readonly estimatedCostUsd: number;
}

interface Feature277Budget {
  readonly calls: number;
  readonly totalTokens: number;
  readonly estimatedCostUsd: number;
}

export interface Feature277RunOptions {
  readonly allowGeneration: boolean;
  readonly rawRoot?: string;
}

export interface Feature277RunSummary {
  readonly stage: Feature277Stage;
  readonly complete: boolean;
  readonly expectedCalls: number;
  readonly externalCallsThisRun: number;
  readonly budget: Feature277Budget;
  readonly rawRoot: string;
  readonly reviewStatus: 'pending-main-session-blind-review';
}

export interface Feature277RunManifest {
  readonly schemaVersion: 1;
  readonly featureId: 277;
  readonly release: '0.7.78';
  readonly revision: typeof FEATURE_277_REVISION;
  readonly gitCommit: string;
  readonly sourcePatchSha256: string;
  readonly exactBytes: {
    readonly classifierPromptSourceSha256: string;
    readonly permissionIntentSourceSha256: string;
    readonly renderedCasePromptsSha256: string;
    readonly scorerSha256: string;
  };
  readonly aliases: Readonly<Record<string, unknown>>;
  readonly limits: typeof LIMITS;
  readonly rawOutputRoot: string;
  readonly authorization: string;
}

export function buildFeature277RunManifest(
  rawRoot = FEATURE_277_RAW_ROOT,
): Feature277RunManifest {
  buildFeature277ExperimentContract();
  return {
    schemaVersion: 1,
    featureId: 277,
    release: '0.7.78',
    revision: FEATURE_277_REVISION,
    gitCommit: git('rev-parse', 'HEAD').trim(),
    sourcePatchSha256: sha256(git('diff', '--binary', '--submodule=diff', 'HEAD')),
    exactBytes: {
      classifierPromptSourceSha256: sha256(readFileSync(
        new URL('../../../packages/coding/src/guardrails/auto-mode/classifier-prompt.ts', import.meta.url),
        'utf8',
      )),
      permissionIntentSourceSha256: sha256(readFileSync(
        new URL('../../../packages/coding/src/guardrails/auto-mode/permission-intent.ts', import.meta.url),
        'utf8',
      )),
      renderedCasePromptsSha256: sha256(JSON.stringify(
        FEATURE_277_CASES.map((item) => renderedPrompt(item)),
      )),
      scorerSha256: scoringSourceHash(),
    },
    aliases: Object.fromEntries(FEATURE_277_PANEL_ALIASES.map((alias) => [
      alias,
      {
        provider: MODEL_ALIASES[alias].provider,
        model: MODEL_ALIASES[alias].model,
        pricing: pricing(alias),
      },
    ])),
    limits: LIMITS,
    rawOutputRoot: rawRoot,
    authorization: process.env.KODAX_F277_AUTHORIZATION?.trim()
      || 'pending-explicit-owner-approval',
  };
}

export async function runFeature277Pilot(
  options: Feature277RunOptions,
): Promise<Feature277RunSummary> {
  return runStage(
    'pilot',
    [FEATURE_277_PILOT_ALIAS],
    FEATURE_277_PILOT_CASES,
    2,
    options,
  );
}

export async function runFeature277Panel(
  options: Feature277RunOptions,
): Promise<Feature277RunSummary> {
  return runStage(
    'panel',
    FEATURE_277_PANEL_ALIASES,
    FEATURE_277_CASES,
    2,
    options,
  );
}

async function runStage(
  stage: Feature277Stage,
  aliases: readonly ModelAlias[],
  cases: readonly Feature277EvalCase[],
  repetitions: number,
  options: Feature277RunOptions,
): Promise<Feature277RunSummary> {
  const manifest = await prepareRun(options);
  const results: Feature277PhysicalResult[] = [];
  let externalCallsThisRun = 0;
  for (const alias of aliases) {
    for (const evalCase of cases) {
      for (let repetition = 0; repetition < repetitions; repetition += 1) {
        const call = await readOrRun(
          stage,
          alias,
          evalCase,
          repetition,
          manifest,
          results,
        );
        if (!call.resumed) externalCallsThisRun += 1;
        results.push(call.result);
      }
    }
  }
  const expectedCalls = aliases.length * cases.length * repetitions;
  const summary: Feature277RunSummary = {
    stage,
    complete: results.length === expectedCalls,
    expectedCalls,
    externalCallsThisRun,
    budget: budgetState(results),
    rawRoot: manifest.rawOutputRoot,
    reviewStatus: 'pending-main-session-blind-review',
  };
  await writeJsonAtomic(path.join(manifest.rawOutputRoot, stage, 'summary.json'), summary);
  await writeReviewPackets(stage, cases, results, manifest.rawOutputRoot);
  return summary;
}

async function prepareRun(
  options: Feature277RunOptions,
): Promise<Feature277RunManifest> {
  const manifest = buildFeature277RunManifest(options.rawRoot);
  await writeJsonAtomic(path.join(manifest.rawOutputRoot, 'experiment.json'), {
    ...manifest,
    contract: buildFeature277ExperimentContract(),
    renderedCases: FEATURE_277_CASES.map((item) => ({
      caseId: item.id,
      prompt: renderedPrompt(item),
    })),
  });
  if (!options.allowGeneration || process.env.KODAX_F277_ALLOW_GENERATION !== '1') {
    throw new Error(
      'feature-277 paid generation requires allowGeneration and KODAX_F277_ALLOW_GENERATION=1',
    );
  }
  if (!process.env.KODAX_F277_AUTHORIZATION?.trim()) {
    throw new Error('feature-277 paid generation requires KODAX_F277_AUTHORIZATION');
  }
  return manifest;
}

async function readOrRun(
  stage: Feature277Stage,
  alias: ModelAlias,
  evalCase: Feature277EvalCase,
  repetition: number,
  manifest: Feature277RunManifest,
  prior: readonly Feature277PhysicalResult[],
): Promise<{ readonly result: Feature277PhysicalResult; readonly resumed: boolean }> {
  const prompt = renderedPrompt(evalCase);
  const inputHash = sha256(JSON.stringify({
    revision: FEATURE_277_REVISION,
    alias,
    caseId: evalCase.id,
    repetition,
    prompt,
  }));
  const filePath = path.join(
    manifest.rawOutputRoot,
    'runs',
    alias.replace('/', '_'),
    evalCase.id,
    `rep-${repetition}.json`,
  );
  const cached = await readJson(filePath);
  if (cached !== undefined) {
    return {
      result: validatePhysical(cached, alias, evalCase.id, repetition, inputHash, filePath),
      resumed: true,
    };
  }
  assertBudget(stage, budgetState(prior), 'before-call');
  let output: Awaited<ReturnType<typeof runOneShot>>;
  try {
    output = await runOneShot(alias, {
      systemPrompt: prompt.system,
      userMessage: classifierUserMessage(prompt.messages[0]?.content),
      maxOutputTokens: 256,
      timeoutMs: 90_000,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeJsonAtomic(filePath, {
      schemaVersion: 1,
      status: 'error',
      inputHash,
      alias,
      caseId: evalCase.id,
      repetition,
      timedOut: /timed out|abort/i.test(message),
      error: message,
    });
    throw error;
  }
  if (output.usage === undefined) {
    const error = new Error('provider usage is missing');
    await writeJsonAtomic(filePath, {
      schemaVersion: 1,
      status: 'error',
      inputHash,
      alias,
      caseId: evalCase.id,
      repetition,
      timedOut: false,
      error: error.message,
    });
    throw error;
  }
  const parsed = parseClassifierOutput(output.text);
  const result: Feature277PhysicalResult = {
    schemaVersion: 1,
    status: 'complete',
    inputHash,
    alias,
    caseId: evalCase.id,
    repetition,
    response: {
      text: output.text,
      toolCalls: output.toolCalls,
      usage: output.usage,
      durationMs: output.durationMs,
    },
    verdict: parsed.kind === 'block'
      ? 'confirm'
      : parsed.kind === 'allow' ? 'allow' : 'unparseable',
    reason: parsed.kind === 'unparseable'
      ? 'unparseable classifier output'
      : parsed.reason,
    estimatedCostUsd: estimateCost(alias, output.usage),
  };
  await writeJsonAtomic(filePath, result);
  assertBudget(stage, budgetState([...prior, result]), 'after-call');
  return { result, resumed: false };
}

function classifierUserMessage(content: unknown): string {
  if (typeof content !== 'string') {
    throw new Error('feature-277 classifier prompt did not render a string user message');
  }
  return content;
}

function renderedPrompt(evalCase: Feature277EvalCase): ReturnType<typeof buildClassifierPrompt> {
  const messages = [{ role: 'user' as const, content: evalCase.userIntent }];
  return buildClassifierPrompt({
    rules: EMPTY_RULES,
    transcript: [],
    action: evalCase.action,
    intentEvidence: buildPermissionIntentEvidence(messages, evalCase.action),
    signals: evalCase.signals,
  });
}

async function writeReviewPackets(
  stage: Feature277Stage,
  cases: readonly Feature277EvalCase[],
  results: readonly Feature277PhysicalResult[],
  rawRoot: string,
): Promise<void> {
  const casesById = new Map(cases.map((item) => [item.id, item]));
  const evidence = results.map((result) => {
    const evalCase = casesById.get(result.caseId);
    if (evalCase === undefined) throw new Error(`unknown feature-277 case ${result.caseId}`);
    return {
      blindId: sha256(`${result.alias}\0${result.caseId}\0${result.repetition}`).slice(0, 16),
      alias: result.alias,
      caseId: result.caseId,
      userIntent: evalCase.userIntent,
      action: evalCase.action,
      signals: evalCase.signals,
      reviewFocus: evalCase.reviewFocus,
      response: result.response,
      observedVerdict: result.verdict,
      observedReason: result.reason,
    };
  });
  const reveal = cases.map((evalCase) => ({
    caseId: evalCase.id,
    expected: evalCase.expected,
  }));
  const reviewRoot = path.join(rawRoot, stage, 'main-session-review');
  await Promise.all([
    writeJsonAtomic(path.join(reviewRoot, 'evidence.json'), {
      reviewVersion: 1,
      instruction: 'Review task validity, permission semantics, reason quality, and harm before opening reveal.json.',
      cases: evidence,
    }),
    writeJsonAtomic(path.join(reviewRoot, 'reveal.json'), {
      reviewVersion: 1,
      cases: reveal,
    }),
  ]);
}

function validatePhysical(
  value: unknown,
  alias: ModelAlias,
  caseId: string,
  repetition: number,
  inputHash: string,
  filePath: string,
): Feature277PhysicalResult {
  if (
    !isRecord(value)
    || value.schemaVersion !== 1
    || value.status !== 'complete'
    || value.alias !== alias
    || value.caseId !== caseId
    || value.repetition !== repetition
    || value.inputHash !== inputHash
    || !isRecord(value.response)
    || !isUsage(value.response.usage)
  ) {
    throw new Error(`feature-277 raw cell failed, stale, or malformed: ${filePath}`);
  }
  return value as unknown as Feature277PhysicalResult;
}

function assertBudget(
  stage: Feature277Stage,
  state: Feature277Budget,
  phase: 'before-call' | 'after-call',
): void {
  const limits = LIMITS[stage];
  const exceeded = phase === 'before-call'
    ? state.calls >= limits.maxProviderCalls
      || state.totalTokens >= limits.maxTotalTokens
      || state.estimatedCostUsd >= limits.maxExternalSpendUsd
    : state.calls > limits.maxProviderCalls
      || state.totalTokens > limits.maxTotalTokens
      || state.estimatedCostUsd > limits.maxExternalSpendUsd;
  if (exceeded) throw new Error(`feature-277 ${stage} frozen budget exceeded`);
}

function budgetState(results: readonly Feature277PhysicalResult[]): Feature277Budget {
  return results.reduce((state, result) => ({
    calls: state.calls + 1,
    totalTokens: state.totalTokens + result.response.usage.inputTokens
      + result.response.usage.outputTokens,
    estimatedCostUsd: state.estimatedCostUsd + result.estimatedCostUsd,
  }), { calls: 0, totalTokens: 0, estimatedCostUsd: 0 });
}

function estimateCost(alias: ModelAlias, usage: KodaXTokenUsage): number {
  const rate = pricing(alias).rate;
  return calculateCost(
    rate,
    usage.inputTokens,
    usage.outputTokens,
    usage.cachedReadTokens ?? 0,
    usage.cachedWriteTokens ?? 0,
  );
}

function pricing(alias: ModelAlias): { readonly rate: CostRate; readonly source: string } {
  const target = MODEL_ALIASES[alias];
  const direct = getCostRate(target.provider, target.model);
  if (direct !== undefined) {
    return { rate: direct, source: `${target.provider}/${target.model}` };
  }
  if (alias === 'zhipu/glm52') {
    const routed = getCostRate('zhipu-coding', 'glm-5.2');
    if (routed !== undefined) return { rate: routed, source: 'zhipu-coding/glm-5.2' };
  }
  throw new Error(`feature-277 pricing unavailable for ${alias}`);
}

function scoringSourceHash(): string {
  return sha256([
    readFileSync(new URL('./cases.ts', import.meta.url), 'utf8'),
    readFileSync(new URL('./runner.ts', import.meta.url), 'utf8'),
    readFileSync(
      new URL('../../../packages/coding/src/guardrails/auto-mode/parse-output.ts', import.meta.url),
      'utf8',
    ),
  ].join('\n'));
}

async function readJson(filePath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return undefined;
    if (error instanceof SyntaxError) {
      throw new Error(`corrupt feature-277 raw cell: ${filePath}`);
    }
    throw error;
  }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, filePath);
}

function git(...args: readonly string[]): string {
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isUsage(value: unknown): value is KodaXTokenUsage {
  return isRecord(value)
    && typeof value.inputTokens === 'number'
    && typeof value.outputTokens === 'number'
    && typeof value.totalTokens === 'number';
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
