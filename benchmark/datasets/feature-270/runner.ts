import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  calculateCost,
  type KodaXMessage,
  type KodaXTokenUsage,
} from '@kodax-ai/llm';
import type { ModelAlias } from '../../harness/aliases.js';
import { MODEL_ALIASES } from '../../harness/aliases.js';
import { runOneShot } from '../../harness/harness.js';
import {
  FEATURE_270_LAYER_2_CASE_IDS,
  FEATURE_270_LAYER_3_CASE_IDS,
  buildFeature270Layer2Input,
  buildFeature270Layer3Round1,
  buildFeature270Layer3Round2,
  buildFeature270TreatmentPrompt,
  feature270BaselinePrompt,
  feature270ToolsForArm,
  scoreFeature270Adaptation,
  scoreFeature270Layer2,
  type Feature270Arm,
  type Feature270Layer2CaseId,
  type Feature270Layer3CaseId,
} from './cases.js';
import {
  FEATURE_270_ALIASES,
  FEATURE_270_LAYER_3_ALIAS,
  FEATURE_270_LIMITS,
  assertFeature270GenerationAuthorized,
  buildFeature270ExperimentManifest,
  feature270Pricing,
  writeFeature270ExperimentManifest,
  type Feature270ExperimentManifest,
} from './experiment-contract.js';

type BudgetStage = 'layer2' | 'layer3';
type RunStage = 'pilot' | BudgetStage;

export interface Feature270BudgetState {
  readonly calls: number;
  readonly totalTokens: number;
  readonly estimatedCostUsd: number;
}

interface Feature270CellSpec {
  readonly stage: BudgetStage;
  readonly alias: ModelAlias;
  readonly caseId: Feature270Layer2CaseId | Feature270Layer3CaseId;
  readonly arm: Feature270Arm;
  readonly repetition: number;
  readonly round: 1 | 2;
  readonly userMessage: string;
  readonly priorMessages: readonly KodaXMessage[];
  readonly firstToolCalls?: ReadonlyArray<{ readonly name: string; readonly input: unknown }>;
}

interface Feature270RawCell {
  readonly schemaVersion: 1;
  readonly status: 'complete';
  readonly inputHash: string;
  readonly blindId: string;
  readonly stage: BudgetStage;
  readonly alias: ModelAlias;
  readonly resolvedTarget: { readonly provider: string; readonly model: string };
  readonly caseId: string;
  readonly arm: Feature270Arm;
  readonly repetition: number;
  readonly round: 1 | 2;
  readonly request: {
    readonly systemPromptSha256: string;
    readonly toolsSha256: string;
    readonly userMessage: string;
    readonly priorMessages: readonly KodaXMessage[];
    readonly timeoutMs: number;
    readonly maxOutputTokens: number;
  };
  readonly response: {
    readonly text: string;
    readonly toolCalls: ReadonlyArray<{ readonly name: string; readonly input: unknown }>;
    readonly usage: KodaXTokenUsage;
    readonly durationMs: number;
  };
  readonly observations: unknown;
  readonly estimatedCostUsd: number;
  readonly timedOut: false;
  readonly error: null;
}

export interface Feature270RunSummary {
  readonly stage: RunStage;
  readonly complete: boolean;
  readonly expectedCalls: number;
  readonly externalCallsThisRun: number;
  readonly budget: Feature270BudgetState;
  readonly rawRoot: string;
  readonly reviewStatus: 'pending-main-session-blind-review';
  readonly cells: readonly Feature270RawCell[];
}

export function assertFeature270Budget(
  stage: BudgetStage,
  state: Feature270BudgetState,
  phase: 'before-call' | 'after-call',
): void {
  const limits = FEATURE_270_LIMITS[stage];
  const callExceeded = phase === 'before-call'
    ? state.calls >= limits.maxProviderCalls
    : state.calls > limits.maxProviderCalls;
  if (callExceeded) throw new Error(`feature-270 ${stage} call cap exceeded`);
  const tokenExceeded = phase === 'before-call'
    ? state.totalTokens >= limits.maxTotalTokens
    : state.totalTokens > limits.maxTotalTokens;
  if (tokenExceeded) {
    throw new Error(`feature-270 ${stage} token cap exceeded`);
  }
  const spendExceeded = phase === 'before-call'
    ? state.estimatedCostUsd >= limits.maxExternalSpendUsd
    : state.estimatedCostUsd > limits.maxExternalSpendUsd;
  if (spendExceeded) {
    throw new Error(`feature-270 ${stage} spend cap exceeded`);
  }
}

export async function runFeature270Pilot(options: {
  readonly allowGeneration: boolean;
}): Promise<Feature270RunSummary> {
  const manifest = await prepareRun(options.allowGeneration);
  const specs = layer2Specs().filter((spec) => spec.alias === 'zhipu/glm51'
    && spec.repetition === 0
    && (spec.caseId === 'parallel' || spec.caseId === 'no_workflow'));
  return runFixedSpecs('pilot', 'layer2', specs, manifest);
}

export async function runFeature270Layer2(options: {
  readonly allowGeneration: boolean;
}): Promise<Feature270RunSummary> {
  const manifest = await prepareRun(options.allowGeneration);
  return runFixedSpecs('layer2', 'layer2', layer2Specs(), manifest);
}

export async function runFeature270Layer3(options: {
  readonly allowGeneration: boolean;
}): Promise<Feature270RunSummary> {
  const manifest = await prepareRun(options.allowGeneration);
  const cells: Feature270RawCell[] = [];
  let externalCallsThisRun = 0;
  for (const caseId of FEATURE_270_LAYER_3_CASE_IDS) {
    for (const arm of ['baseline', 'treatment'] as const) {
      for (let repetition = 0; repetition < 2; repetition += 1) {
        const firstSpec = layer3FirstSpec(caseId, arm, repetition);
        const first = await readOrRunCell(firstSpec, manifest, cells);
        if (!first.resumed) externalCallsThisRun += 1;
        cells.push(first.cell);
        const secondSpec = layer3SecondSpec(firstSpec, first.cell);
        const second = await readOrRunCell(secondSpec, manifest, cells);
        if (!second.resumed) externalCallsThisRun += 1;
        cells.push(second.cell);
      }
    }
  }
  return finishRun('layer3', 24, externalCallsThisRun, cells, manifest);
}

async function prepareRun(allowGeneration: boolean): Promise<Feature270ExperimentManifest> {
  const manifest = buildFeature270ExperimentManifest();
  await writeFeature270ExperimentManifest(manifest);
  assertFeature270GenerationAuthorized(allowGeneration);
  return manifest;
}

function layer2Specs(): readonly Feature270CellSpec[] {
  return FEATURE_270_ALIASES.flatMap((alias) =>
    FEATURE_270_LAYER_2_CASE_IDS.flatMap((caseId) =>
      (['baseline', 'treatment'] as const).flatMap((arm) =>
        [0, 1, 2].map((repetition): Feature270CellSpec => {
          const input = buildFeature270Layer2Input(caseId, arm);
          return {
            stage: 'layer2',
            alias,
            caseId,
            arm,
            repetition,
            round: 1,
            userMessage: input.userMessage,
            priorMessages: input.priorMessages,
          };
        }))),
  );
}

function layer3FirstSpec(
  caseId: Feature270Layer3CaseId,
  arm: Feature270Arm,
  repetition: number,
): Feature270CellSpec {
  return {
    stage: 'layer3',
    alias: FEATURE_270_LAYER_3_ALIAS,
    caseId,
    arm,
    repetition,
    round: 1,
    userMessage: buildFeature270Layer3Round1(caseId),
    priorMessages: [],
  };
}

function layer3SecondSpec(
  firstSpec: Feature270CellSpec,
  first: Feature270RawCell,
): Feature270CellSpec {
  const caseId = firstSpec.caseId as Feature270Layer3CaseId;
  const input = buildFeature270Layer3Round2(
    caseId,
    firstSpec.arm,
    first.response.text,
    first.response.toolCalls,
  );
  return {
    ...firstSpec,
    round: 2,
    userMessage: input.userMessage,
    priorMessages: input.priorMessages,
    firstToolCalls: first.response.toolCalls,
  };
}

async function runFixedSpecs(
  runStage: RunStage,
  budgetStage: BudgetStage,
  specs: readonly Feature270CellSpec[],
  manifest: Feature270ExperimentManifest,
): Promise<Feature270RunSummary> {
  const cells: Feature270RawCell[] = [];
  let externalCallsThisRun = 0;
  for (const spec of specs) {
    const result = await readOrRunCell(spec, manifest, cells);
    if (!result.resumed) externalCallsThisRun += 1;
    cells.push(result.cell);
  }
  return finishRun(runStage, specs.length, externalCallsThisRun, cells, manifest, budgetStage);
}

async function finishRun(
  stage: RunStage,
  expectedCalls: number,
  externalCallsThisRun: number,
  cells: readonly Feature270RawCell[],
  manifest: Feature270ExperimentManifest,
  budgetStage: BudgetStage = 'layer3',
): Promise<Feature270RunSummary> {
  const budget = budgetState(cells);
  assertFeature270Budget(budgetStage, budget, 'after-call');
  const summary: Feature270RunSummary = {
    stage,
    complete: cells.length === expectedCalls,
    expectedCalls,
    externalCallsThisRun,
    budget,
    rawRoot: manifest.rawOutputRoot,
    reviewStatus: 'pending-main-session-blind-review',
    cells,
  };
  await writeJsonAtomic(path.join(manifest.rawOutputRoot, stage, 'summary.json'), summary);
  await writeBlindedEvidence(stage, cells, manifest.rawOutputRoot);
  return summary;
}

async function readOrRunCell(
  spec: Feature270CellSpec,
  manifest: Feature270ExperimentManifest,
  priorCells: readonly Feature270RawCell[],
): Promise<{ readonly cell: Feature270RawCell; readonly resumed: boolean }> {
  const inputHash = cellInputHash(spec);
  const filePath = cellPath(manifest.rawOutputRoot, spec);
  const cached = await readFeature270RawCell(filePath);
  if (cached !== undefined) {
    return { cell: validateRawCell(cached, spec, inputHash, filePath), resumed: true };
  }
  assertFeature270Budget(spec.stage, budgetState(priorCells), 'before-call');
  return { cell: await runCell(spec, inputHash, filePath), resumed: false };
}

async function runCell(
  spec: Feature270CellSpec,
  inputHash: string,
  filePath: string,
): Promise<Feature270RawCell> {
  const systemPrompt = spec.arm === 'baseline'
    ? feature270BaselinePrompt()
    : buildFeature270TreatmentPrompt();
  const tools = feature270ToolsForArm(spec.arm);
  const limits = FEATURE_270_LIMITS[spec.stage];
  const target = MODEL_ALIASES[spec.alias];
  const request = {
    systemPromptSha256: sha256(systemPrompt),
    toolsSha256: sha256(JSON.stringify(tools)),
    userMessage: spec.userMessage,
    priorMessages: spec.priorMessages,
    timeoutMs: limits.timeoutMs,
    maxOutputTokens: limits.maxOutputTokensPerCall,
  };
  const base = rawCellBase(spec, inputHash);
  try {
    const output = await runOneShot(spec.alias, {
      systemPrompt,
      userMessage: spec.userMessage,
      priorMessages: spec.priorMessages,
      tools,
      timeoutMs: limits.timeoutMs,
      maxOutputTokens: limits.maxOutputTokensPerCall,
    });
    if (output.usage === undefined) throw new Error('provider usage is missing');
    const cell = completedCell(spec, base, request, target, output, output.usage);
    assertFeature270Budget(spec.stage, budgetState([cell]), 'after-call');
    await writeJsonAtomic(filePath, cell);
    return cell;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeJsonAtomic(filePath, failedCell(base, request, target, message));
    throw error;
  }
}

function rawCellBase(spec: Feature270CellSpec, inputHash: string) {
  return {
    schemaVersion: 1 as const,
    inputHash,
    stage: spec.stage,
    alias: spec.alias,
    caseId: spec.caseId,
    arm: spec.arm,
    repetition: spec.repetition,
    round: spec.round,
  };
}

function completedCell(
  spec: Feature270CellSpec,
  base: ReturnType<typeof rawCellBase>,
  request: Feature270RawCell['request'],
  target: { readonly provider: string; readonly model: string },
  output: Awaited<ReturnType<typeof runOneShot>>,
  usage: KodaXTokenUsage,
): Feature270RawCell {
  return {
    ...base,
    status: 'complete',
    blindId: sha256(`${base.inputHash}:blind`).slice(0, 16),
    resolvedTarget: { provider: target.provider, model: target.model },
    request,
    response: {
      text: output.text,
      toolCalls: output.toolCalls,
      usage,
      durationMs: output.durationMs,
    },
    observations: observationsFor(spec, output.toolCalls, output.text),
    estimatedCostUsd: estimateCost(spec.alias, usage),
    timedOut: false,
    error: null,
  };
}

function failedCell(
  base: ReturnType<typeof rawCellBase>,
  request: Feature270RawCell['request'],
  target: { readonly provider: string; readonly model: string },
  message: string,
): object {
  return {
    ...base,
    status: 'error',
    blindId: sha256(`${base.inputHash}:blind`).slice(0, 16),
    resolvedTarget: { provider: target.provider, model: target.model },
    request,
    timedOut: /timed out|abort/i.test(message),
    error: message,
  };
}

function cellInputHash(spec: Feature270CellSpec): string {
  const systemPrompt = spec.arm === 'baseline'
    ? feature270BaselinePrompt()
    : buildFeature270TreatmentPrompt();
  return sha256(JSON.stringify({
    ...spec,
    systemPrompt,
    tools: feature270ToolsForArm(spec.arm),
  }));
}

function observationsFor(
  spec: Feature270CellSpec,
  toolCalls: ReadonlyArray<{ readonly name: string; readonly input: unknown }>,
  text: string,
): unknown {
  if (spec.stage === 'layer2') {
    return scoreFeature270Layer2(spec.caseId as Feature270Layer2CaseId, toolCalls, text);
  }
  if (spec.round === 1) return { phase: 'initial-decision' };
  return scoreFeature270Adaptation(spec.firstToolCalls ?? [], toolCalls);
}

function cellPath(root: string, spec: Feature270CellSpec): string {
  const alias = spec.alias.replace('/', '_');
  return path.join(
    root,
    spec.stage,
    'runs',
    alias,
    spec.caseId,
    `rep-${spec.repetition}-${spec.arm}-round-${spec.round}.json`,
  );
}

export async function readFeature270RawCell(filePath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  } catch (error) {
    if (isMissing(error)) return undefined;
    if (error instanceof SyntaxError) {
      throw new Error(`corrupt feature-270 raw cell JSON: ${filePath}: ${error.message}`);
    }
    throw error;
  }
}

function validateRawCell(
  value: unknown,
  spec: Feature270CellSpec,
  inputHash: string,
  filePath: string,
): Feature270RawCell {
  if (!isRecord(value)) throw new Error(`invalid feature-270 raw cell root: ${filePath}`);
  if (value.status === 'error') {
    throw new Error(`feature-270 raw cell records a failed provider call; create a new revision: ${filePath}`);
  }
  const valid = value.schemaVersion === 1 && value.status === 'complete'
    && value.inputHash === inputHash && value.stage === spec.stage
    && value.alias === spec.alias && value.caseId === spec.caseId
    && value.arm === spec.arm && value.repetition === spec.repetition
    && value.round === spec.round && isRecord(value.response)
    && isUsage(value.response.usage) && typeof value.estimatedCostUsd === 'number';
  if (!valid) throw new Error(`invalid or stale feature-270 raw cell: ${filePath}`);
  return value as unknown as Feature270RawCell;
}

function budgetState(cells: readonly Feature270RawCell[]): Feature270BudgetState {
  return cells.reduce((state, cell) => ({
    calls: state.calls + 1,
    totalTokens: state.totalTokens
      + cell.response.usage.inputTokens + cell.response.usage.outputTokens,
    estimatedCostUsd: state.estimatedCostUsd + cell.estimatedCostUsd,
  }), { calls: 0, totalTokens: 0, estimatedCostUsd: 0 });
}

function estimateCost(alias: ModelAlias, usage: KodaXTokenUsage): number {
  const { rate } = feature270Pricing(alias);
  return calculateCost(
    rate,
    usage.inputTokens,
    usage.outputTokens,
    usage.cachedReadTokens ?? 0,
    usage.cachedWriteTokens ?? 0,
  );
}

async function writeBlindedEvidence(
  stage: RunStage,
  cells: readonly Feature270RawCell[],
  rawRoot: string,
): Promise<void> {
  const groups = groupCells(cells);
  const pairs = [...groups.entries()].map(([pairId, group]) => {
    const baselineFirst = Number.parseInt(sha256(pairId).slice(-2), 16) % 2 === 0;
    const armA = compactJourney(group.filter((cell) =>
      cell.arm === (baselineFirst ? 'baseline' : 'treatment')));
    const armB = compactJourney(group.filter((cell) =>
      cell.arm === (baselineFirst ? 'treatment' : 'baseline')));
    return {
      evidence: { pairId, armA, armB },
      reveal: {
        pairId,
        armA: baselineFirst ? 'baseline' : 'treatment',
        armB: baselineFirst ? 'treatment' : 'baseline',
      },
    };
  });
  const reviewRoot = path.join(rawRoot, stage, 'main-session-review');
  await Promise.all([
    writeJsonAtomic(path.join(reviewRoot, 'evidence.json'), {
      reviewVersion: 1,
      instruction: 'Review validity, preferred arm, material value, and harm before opening reveal.json. Sample at least one mechanical pass and fail per case when available.',
      pairs: pairs.map((pair) => pair.evidence),
    }),
    writeJsonAtomic(path.join(reviewRoot, 'reveal.json'), {
      reviewVersion: 1,
      pairs: pairs.map((pair) => pair.reveal),
    }),
  ]);
}

function groupCells(cells: readonly Feature270RawCell[]): Map<string, Feature270RawCell[]> {
  const groups = new Map<string, Feature270RawCell[]>();
  for (const cell of cells) {
    const key = `${cell.alias}/${cell.caseId}/rep-${cell.repetition}`;
    const group = groups.get(key) ?? [];
    group.push(cell);
    groups.set(key, group);
  }
  return groups;
}

function compactJourney(cells: readonly Feature270RawCell[]): object {
  return {
    blindIds: cells.map((cell) => cell.blindId),
    rounds: [...cells].sort((left, right) => left.round - right.round).map((cell) => ({
      request: cell.request,
      response: cell.response,
      observations: cell.observations,
      timedOut: cell.timedOut,
      error: cell.error,
    })),
  };
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, filePath);
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
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
