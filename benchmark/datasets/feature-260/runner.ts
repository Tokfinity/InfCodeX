import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  calculateCost,
  getCostRate,
  type KodaXToolDefinition,
  type KodaXTokenUsage,
} from '@kodax-ai/llm';
import { buildMemoryRulesSection } from '../../../packages/coding/src/prompts/memory-rules.js';
import { listToolDefinitions } from '../../../packages/coding/src/tools/index.js';
import type { ModelAlias } from '../../harness/aliases.js';
import { MODEL_ALIASES } from '../../harness/aliases.js';
import { runOneShot } from '../../harness/harness.js';
import {
  FEATURE_260_BOUNDED_RECOVERY_CASES,
  FEATURE_260_DEVELOPMENT_CASES,
  FEATURE_260_IMMEDIATE_RECALL_CASES,
  FEATURE_260_MUST_SILENT_CASES,
  FEATURE_260_PAIRED_CASES,
  FEATURE_260_PILOT_CASES,
  FEATURE_260_SHIP_THRESHOLDS,
  type Feature260EvalCase,
} from './cases.js';
import {
  FEATURE_260_PILOT_ALIAS,
  FEATURE_260_RAW_ROOT,
  writeFeature260ExperimentManifest,
} from './experiment-contract.js';

type PilotArm = 'baseline' | 'candidate';
type DecisionFamily = 'immediate-recall' | 'must-silent' | 'paired' | 'bounded-recovery';

interface PilotCell {
  readonly caseId: string;
  readonly arm: PilotArm;
  readonly alias: ModelAlias;
  readonly passed: boolean;
  readonly firstTool?: string;
  readonly toolCalls: ReadonlyArray<{ readonly name: string; readonly input: unknown }>;
  readonly text: string;
  readonly durationMs: number;
  readonly usage: KodaXTokenUsage;
  readonly estimatedCostUsd: number;
}

interface DecisionCell extends PilotCell {
  readonly family: DecisionFamily;
  readonly round?: 1 | 2;
}

export interface Feature260PilotSummary {
  readonly stage: 'pilot';
  readonly complete: boolean;
  readonly mechanicalPass: boolean;
  readonly usageCovered: true;
  readonly calls: number;
  readonly estimatedCostUsd: number;
  readonly hardSpendCapUsd: 2;
  readonly reviewStatus: 'separate-main-session-review-artifact';
  readonly rawRoot: string;
  readonly cells: readonly PilotCell[];
}

export interface Feature260DecisionSummary {
  readonly stage: 'decision';
  readonly complete: boolean;
  readonly passed: boolean;
  readonly totalCells: number;
  readonly externalCallsThisRun: number;
  readonly estimatedCostUsd: number;
  readonly usage: KodaXTokenUsage;
  readonly metrics: {
    readonly generalImmediateRecallRate: number;
    readonly highValueImmediateRecallRate: number;
    readonly silenceRate: number;
    readonly silentFalsePositives: number;
    readonly silenceWilsonLower95: number;
    readonly pairedBaselineRate: number;
    readonly pairedCandidateRate: number;
    readonly pairedLift: number;
    readonly controlRegression: number;
    readonly boundedRecoveryRate: number;
  };
  readonly reviewStatus: 'separate-main-session-review-artifact';
  readonly rawRoot: string;
}

export async function runFeature260Pilot(options: {
  readonly allowGeneration: boolean;
  readonly alias?: ModelAlias;
}): Promise<Feature260PilotSummary> {
  if (!options.allowGeneration) {
    throw new Error('feature-260 generation is disabled; set KODAX_F260_ALLOW_GENERATION=1');
  }
  const alias = options.alias ?? FEATURE_260_PILOT_ALIAS;
  await writeFeature260ExperimentManifest();
  const cells: PilotCell[] = [];
  for (const evalCase of FEATURE_260_PILOT_CASES) {
    for (const arm of ['baseline', 'candidate'] as const) {
      const cell = await runPilotCell(evalCase, arm, alias);
      cells.push(cell);
      await writeJsonAtomic(
        path.join(FEATURE_260_RAW_ROOT, 'pilot', 'runs', evalCase.id, `${arm}.json`),
        cell,
      );
      assertPilotSpend(cells.reduce((sum, item) => sum + item.estimatedCostUsd, 0));
    }
  }
  const estimatedCostUsd = cells.reduce((sum, item) => sum + item.estimatedCostUsd, 0);
  const expectedCalls = FEATURE_260_PILOT_CASES.length * 2;
  const summary: Feature260PilotSummary = {
    stage: 'pilot',
    complete: cells.length === expectedCalls,
    mechanicalPass: pilotMechanicallyValid(cells),
    usageCovered: true,
    calls: cells.length,
    estimatedCostUsd,
    hardSpendCapUsd: 2,
    reviewStatus: 'separate-main-session-review-artifact',
    rawRoot: FEATURE_260_RAW_ROOT,
    cells,
  };
  await writeJsonAtomic(path.join(FEATURE_260_RAW_ROOT, 'pilot', 'summary.json'), summary);
  await writeFeature260BlindedEvidence(summary);
  return summary;
}

function pilotMechanicallyValid(cells: readonly PilotCell[]): boolean {
  const candidates = cells.filter((cell) => cell.arm === 'candidate');
  const currentBaselines = cells.filter((cell) => cell.arm === 'baseline'
    && FEATURE_260_PILOT_CASES.find((item) => item.id === cell.caseId)?.kind === 'current_fact');
  const priorCandidates = candidates.filter((cell) =>
    FEATURE_260_PILOT_CASES.find((item) => item.id === cell.caseId)?.kind === 'prior_experience_gap');
  const priorBaselines = cells.filter((cell) => cell.arm === 'baseline'
    && FEATURE_260_PILOT_CASES.find((item) => item.id === cell.caseId)?.kind === 'prior_experience_gap');
  return candidates.every((cell) => cell.passed)
    && currentBaselines.every((cell) => cell.passed)
    && passRate(priorCandidates) > passRate(priorBaselines);
}

export async function runFeature260DecisionPanel(options: {
  readonly allowGeneration: boolean;
  readonly alias?: ModelAlias;
}): Promise<Feature260DecisionSummary> {
  if (!options.allowGeneration) throw new Error('feature-260 decision generation is disabled');
  const releaseLock = await acquireDecisionRunLock();
  try {
    return await runFeature260DecisionPanelUnlocked(options);
  } finally {
    await releaseLock();
  }
}

async function runFeature260DecisionPanelUnlocked(options: {
  readonly allowGeneration: true;
  readonly alias?: ModelAlias;
}): Promise<Feature260DecisionSummary> {
  const alias = options.alias ?? FEATURE_260_PILOT_ALIAS;
  await writeFeature260ExperimentManifest();
  const cells: DecisionCell[] = [];
  let externalCallsThisRun = 0;

  for (const spec of oneShotDecisionSpecs()) {
    const resumed = await readDecisionCell(spec.family, spec.evalCase.id, spec.arm, alias);
    const cell = resumed ?? await runDecisionCell(spec.family, spec.evalCase, spec.arm, alias);
    if (resumed === undefined) {
      externalCallsThisRun += 1;
      await writeJsonAtomic(decisionCellPath(spec.family, spec.evalCase.id, spec.arm), cell);
    }
    cells.push(cell);
    assertDecisionBudget(cells);
  }

  for (const evalCase of FEATURE_260_BOUNDED_RECOVERY_CASES) {
    const first = await readOrRunRecoveryCell(evalCase, 1, undefined, alias);
    if (!first.resumed) externalCallsThisRun += 1;
    cells.push(first.cell);
    assertDecisionBudget(cells);
    const second = await readOrRunRecoveryCell(evalCase, 2, first.cell.firstTool, alias);
    if (!second.resumed) externalCallsThisRun += 1;
    cells.push(second.cell);
    assertDecisionBudget(cells);
  }

  const summary = summarizeDecisionCells(cells, externalCallsThisRun);
  await writeJsonAtomic(path.join(FEATURE_260_RAW_ROOT, 'decision', 'summary.json'), summary);
  return summary;
}

async function acquireDecisionRunLock(): Promise<() => Promise<void>> {
  const lockPath = path.join(FEATURE_260_RAW_ROOT, 'decision', '.run-lock');
  await mkdir(path.dirname(lockPath), { recursive: true });
  try {
    const handle = await open(lockPath, 'wx');
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    await handle.close();
  } catch (error) {
    if (isRecord(error) && error.code === 'EEXIST') {
      throw new Error(`feature-260 decision run lock exists: ${lockPath}`);
    }
    throw error;
  }
  return async () => {
    await rm(lockPath, { force: true });
  };
}

export async function writeFeature260BlindedEvidence(
  summary: Feature260PilotSummary,
): Promise<void> {
  const reviewRoot = path.join(FEATURE_260_RAW_ROOT, 'pilot', 'main-session-review');
  const cases = FEATURE_260_PILOT_CASES.map((evalCase) => {
    const baselineFirst = Number.parseInt(hash(evalCase.id).slice(-2), 16) % 2 === 0;
    const armA = baselineFirst ? 'baseline' : 'candidate';
    const armB = baselineFirst ? 'candidate' : 'baseline';
    return {
      evidence: {
        caseId: evalCase.id,
        kind: evalCase.kind,
        task: evalCase.task,
        armA: compactCell(requiredCell(summary, evalCase.id, armA)),
        armB: compactCell(requiredCell(summary, evalCase.id, armB)),
      },
      reveal: { caseId: evalCase.id, armA, armB },
    };
  });
  await Promise.all([
    writeJsonAtomic(path.join(reviewRoot, 'evidence.json'), {
      reviewVersion: 2,
      instruction: 'Review A/B behavior without opening reveal.json; record value, harm, and recommendation first.',
      cases: cases.map((item) => item.evidence),
    }),
    writeJsonAtomic(path.join(reviewRoot, 'reveal.json'), {
      reviewVersion: 2,
      cases: cases.map((item) => item.reveal),
    }),
  ]);
}

export async function writeFeature260DecisionBlindedEvidence(
  alias: ModelAlias = FEATURE_260_PILOT_ALIAS,
): Promise<void> {
  const reviewRoot = path.join(FEATURE_260_RAW_ROOT, 'decision', 'main-session-review');
  const cases = [];
  for (const evalCase of FEATURE_260_PAIRED_CASES) {
    const baseline = await readDecisionCell('paired', evalCase.id, 'baseline', alias);
    const candidate = await readDecisionCell('paired', evalCase.id, 'candidate', alias);
    if (baseline === undefined || candidate === undefined) {
      throw new Error(`paired decision evidence missing: ${evalCase.id}`);
    }
    const baselineFirst = Number.parseInt(hash(evalCase.id).slice(-2), 16) % 2 === 0;
    const armA = baselineFirst ? baseline : candidate;
    const armB = baselineFirst ? candidate : baseline;
    cases.push({
      evidence: {
        caseId: evalCase.id,
        kind: evalCase.kind,
        task: evalCase.task,
        armA: compactCell(armA),
        armB: compactCell(armB),
      },
      reveal: {
        caseId: evalCase.id,
        armA: baselineFirst ? 'baseline' : 'candidate',
        armB: baselineFirst ? 'candidate' : 'baseline',
      },
    });
  }
  await Promise.all([
    writeJsonAtomic(path.join(reviewRoot, 'evidence.json'), {
      reviewVersion: 2,
      instruction: 'Review task validity, preferred arm, material value, and harm before opening reveal.json.',
      cases: cases.map((item) => item.evidence),
    }),
    writeJsonAtomic(path.join(reviewRoot, 'reveal.json'), {
      reviewVersion: 2,
      cases: cases.map((item) => item.reveal),
    }),
  ]);
}

async function runPilotCell(
  evalCase: Feature260EvalCase,
  arm: PilotArm,
  alias: ModelAlias,
): Promise<PilotCell> {
  const output = await runOneShot(alias, {
    systemPrompt: systemPrompt(arm),
    userMessage: evalCase.task,
    tools: toolsForArm(arm),
    timeoutMs: 90_000,
    maxOutputTokens: 512,
  });
  if (output.usage === undefined) throw new Error(`usage missing for ${alias}/${evalCase.id}/${arm}`);
  const firstTool = output.toolCalls[0]?.name;
  return {
    caseId: evalCase.id,
    arm,
    alias,
    passed: scoreDecisionCell(evalCase, arm, firstTool, output.text),
    ...(firstTool !== undefined ? { firstTool } : {}),
    toolCalls: output.toolCalls,
    text: output.text,
    durationMs: output.durationMs,
    usage: output.usage,
    estimatedCostUsd: estimateCost(alias, output.usage),
  };
}

function oneShotDecisionSpecs(): ReadonlyArray<{
  readonly family: Exclude<DecisionFamily, 'bounded-recovery'>;
  readonly evalCase: Feature260EvalCase;
  readonly arm: PilotArm;
}> {
  return [
    ...FEATURE_260_IMMEDIATE_RECALL_CASES.map((evalCase) => ({
      family: 'immediate-recall' as const, evalCase, arm: 'candidate' as const,
    })),
    ...FEATURE_260_MUST_SILENT_CASES.map((evalCase) => ({
      family: 'must-silent' as const, evalCase, arm: 'candidate' as const,
    })),
    ...FEATURE_260_PAIRED_CASES.flatMap((evalCase) => ([
      { family: 'paired' as const, evalCase, arm: 'baseline' as const },
      { family: 'paired' as const, evalCase, arm: 'candidate' as const },
    ])),
  ];
}

async function runDecisionCell(
  family: DecisionFamily,
  evalCase: Feature260EvalCase,
  arm: PilotArm,
  alias: ModelAlias,
  task = evalCase.task,
  round?: 1 | 2,
): Promise<DecisionCell> {
  const output = await runOneShot(alias, {
    systemPrompt: systemPrompt(arm),
    userMessage: task,
    tools: toolsForArm(arm),
    timeoutMs: 90_000,
    maxOutputTokens: 256,
  });
  if (output.usage === undefined) throw new Error(`usage missing for ${family}/${evalCase.id}/${arm}`);
  const firstTool = output.toolCalls[0]?.name;
  return {
    family,
    caseId: evalCase.id,
    arm,
    alias,
    passed: family === 'bounded-recovery'
      ? firstTool === 'memory_recall' || firstTool === 'read' || firstTool === 'bash'
      : scoreDecisionCell(evalCase, arm, firstTool, output.text),
    ...(round !== undefined ? { round } : {}),
    ...(firstTool !== undefined ? { firstTool } : {}),
    toolCalls: output.toolCalls,
    text: output.text,
    durationMs: output.durationMs,
    usage: output.usage,
    estimatedCostUsd: estimateCost(alias, output.usage),
  };
}

async function readOrRunRecoveryCell(
  evalCase: Feature260EvalCase,
  round: 1 | 2,
  firstTool: string | undefined,
  alias: ModelAlias,
): Promise<{ readonly cell: DecisionCell; readonly resumed: boolean }> {
  const resumed = await readDecisionCell('bounded-recovery', evalCase.id, 'candidate', alias, round);
  if (resumed !== undefined) return { cell: resumed, resumed: true };
  const task = round === 1 ? evalCase.task : recoveryFollowUp(evalCase, firstTool);
  const cell = await runDecisionCell(
    'bounded-recovery', evalCase, 'candidate', alias, task, round,
  );
  await writeJsonAtomic(
    decisionCellPath('bounded-recovery', evalCase.id, 'candidate', round),
    cell,
  );
  return { cell, resumed: false };
}

function recoveryFollowUp(evalCase: Feature260EvalCase, firstTool: string | undefined): string {
  if (firstTool === 'memory_recall') {
    return [
      `The governed query for ${evalCase.id} returned a potentially applicable low-authority claim.`,
      'Before acting, verify one mutable current precondition with a normal repository or environment tool.',
      'Do not call memory_recall again. Call at most one tool.',
    ].join(' ');
  }
  return [
    `The first decision for ${evalCase.id} did not recover the required prior experience.`,
    'Current evidence is now confirmed insufficient for this historical gap.',
    'Use the scoped read-only prior-experience tool now. Call at most one tool.',
  ].join(' ');
}

function scoreDecisionCell(
  evalCase: Feature260EvalCase,
  arm: PilotArm,
  firstTool: string | undefined,
  text: string,
): boolean {
  if (evalCase.kind === 'current_fact') {
    return firstTool !== undefined && evalCase.expectedCandidateTools.includes(firstTool);
  }
  if (arm === 'candidate') return firstTool === 'memory_recall';
  return firstTool === undefined && /(?:insufficient|cannot|need more|unavailable)/i.test(text);
}

async function readDecisionCell(
  family: DecisionFamily,
  caseId: string,
  arm: PilotArm,
  alias: ModelAlias,
  round?: 1 | 2,
): Promise<DecisionCell | undefined> {
    const value = await readFeature260JsonCache(decisionCellPath(family, caseId, arm, round));
    if (value === undefined) return undefined;
    const invalidFields = invalidDecisionCellFields(
      value, family, caseId, arm, alias, round,
    );
    if (invalidFields.length > 0) {
      throw new Error(`invalid cached feature-260 cell ${caseId}/${arm}: ${invalidFields.join(', ')}`);
    }
    return value as unknown as DecisionCell;
}

export async function readFeature260JsonCache(filePath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  } catch (error) {
    if (isMissing(error)) return undefined;
    if (error instanceof SyntaxError) {
      throw new Error(`corrupt feature-260 cache JSON: ${filePath}: ${error.message}`);
    }
    throw error;
  }
}

function invalidDecisionCellFields(
  value: unknown,
  family: DecisionFamily,
  caseId: string,
  arm: PilotArm,
  alias: ModelAlias,
  round?: 1 | 2,
): string[] {
  if (!isRecord(value)) return ['root'];
  const invalid: string[] = [];
  if (value.family !== family) invalid.push('family');
  if (value.caseId !== caseId) invalid.push('caseId');
  if (value.arm !== arm) invalid.push('arm');
  if (value.alias !== alias) invalid.push('alias');
  if (value.round !== round) invalid.push('round');
  if (typeof value.passed !== 'boolean') invalid.push('passed');
  if (!isUsage(value.usage)) invalid.push('usage');
  if (typeof value.estimatedCostUsd !== 'number') invalid.push('estimatedCostUsd');
  return invalid;
}

function decisionCellPath(
  family: DecisionFamily,
  caseId: string,
  arm: PilotArm,
  round?: 1 | 2,
): string {
  const filename = round === undefined ? `${arm}.json` : `${arm}-round-${round}.json`;
  return path.join(FEATURE_260_RAW_ROOT, 'decision', 'runs', family, caseId, filename);
}

function summarizeDecisionCells(
  cells: readonly DecisionCell[],
  externalCallsThisRun: number,
): Feature260DecisionSummary {
  const immediate = cells.filter((cell) => cell.family === 'immediate-recall');
  const generalImmediate = immediate.filter((cell) => findRecallClass(cell.caseId) === 'general');
  const highValueImmediate = immediate.filter((cell) => findRecallClass(cell.caseId) === 'high_value');
  const silence = cells.filter((cell) => cell.family === 'must-silent');
  const pairedBaseline = cells.filter((cell) => cell.family === 'paired' && cell.arm === 'baseline');
  const pairedCandidate = cells.filter((cell) => cell.family === 'paired' && cell.arm === 'candidate');
  const baselineControls = pairedBaseline.filter((cell) => cell.caseId.startsWith('v2-paired-control-'));
  const candidateControls = pairedCandidate.filter((cell) => cell.caseId.startsWith('v2-paired-control-'));
  const recovery = cells.filter((cell) => cell.family === 'bounded-recovery');
  const silentFalsePositives = silence.filter((cell) => !cell.passed).length;
  const metrics = {
    generalImmediateRecallRate: passRate(generalImmediate),
    highValueImmediateRecallRate: passRate(highValueImmediate),
    silenceRate: passRate(silence),
    silentFalsePositives,
    silenceWilsonLower95: wilsonLower(silence.length - silentFalsePositives, silence.length),
    pairedBaselineRate: passRate(pairedBaseline),
    pairedCandidateRate: passRate(pairedCandidate),
    pairedLift: passRate(pairedCandidate) - passRate(pairedBaseline),
    controlRegression: passRate(baselineControls) - passRate(candidateControls),
    boundedRecoveryRate: boundedRecoveryRate(recovery),
  };
  const thresholds = FEATURE_260_SHIP_THRESHOLDS;
  const passed = metrics.generalImmediateRecallRate >= thresholds.generalImmediateRecallRate
    && metrics.highValueImmediateRecallRate >= thresholds.highValueImmediateRecallRate
    && metrics.silentFalsePositives <= thresholds.maxSilentFalsePositives
    && metrics.silenceWilsonLower95 > thresholds.silenceWilsonLower95
    && metrics.pairedLift >= thresholds.pairedLift
    && metrics.controlRegression <= thresholds.maxControlRegression
    && metrics.boundedRecoveryRate >= thresholds.boundedRecoveryRate;
  return {
    stage: 'decision',
    complete: cells.length === 520,
    passed,
    totalCells: cells.length,
    externalCallsThisRun,
    estimatedCostUsd: cells.reduce((sum, cell) => sum + cell.estimatedCostUsd, 0),
    usage: sumUsage(cells),
    metrics,
    reviewStatus: 'separate-main-session-review-artifact',
    rawRoot: FEATURE_260_RAW_ROOT,
  };
}

function findRecallClass(caseId: string): Feature260EvalCase['recallClass'] {
  return FEATURE_260_IMMEDIATE_RECALL_CASES.find((item) => item.id === caseId)?.recallClass;
}

function boundedRecoveryRate(cells: readonly DecisionCell[]): number {
  const successes = FEATURE_260_BOUNDED_RECOVERY_CASES.filter((evalCase) => {
    const first = cells.find((cell) => cell.caseId === evalCase.id && cell.round === 1);
    const second = cells.find((cell) => cell.caseId === evalCase.id && cell.round === 2);
    if (first?.firstTool === 'memory_recall') {
      return second?.firstTool === 'read' || second?.firstTool === 'bash';
    }
    return second?.firstTool === 'memory_recall';
  }).length;
  return successes / FEATURE_260_BOUNDED_RECOVERY_CASES.length;
}

function passRate(cells: readonly DecisionCell[]): number {
  return cells.length === 0 ? 0 : cells.filter((cell) => cell.passed).length / cells.length;
}

function wilsonLower(successes: number, total: number): number {
  if (total === 0) return 0;
  const z = 1.96;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
  return (centre - margin) / denominator;
}

function assertDecisionBudget(cells: readonly DecisionCell[]): void {
  const usage = sumUsage(cells);
  const cost = cells.reduce((sum, cell) => sum + cell.estimatedCostUsd, 0);
  if (usage.inputTokens > 1_600_000 || usage.outputTokens > 136_000) {
    throw new Error('feature-260 decision token budget exceeded');
  }
  if (cost > 0.02) throw new Error(`feature-260 decision spend cap exceeded: $${cost.toFixed(6)}`);
}

function sumUsage(cells: readonly DecisionCell[]): KodaXTokenUsage {
  return cells.reduce<KodaXTokenUsage>((sum, cell) => ({
    inputTokens: sum.inputTokens + cell.usage.inputTokens,
    outputTokens: sum.outputTokens + cell.usage.outputTokens,
    totalTokens: sum.totalTokens + cell.usage.totalTokens,
    cachedReadTokens: (sum.cachedReadTokens ?? 0) + (cell.usage.cachedReadTokens ?? 0),
  }), { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedReadTokens: 0 });
}

function isUsage(value: unknown): value is KodaXTokenUsage {
  return isRecord(value)
    && typeof value.inputTokens === 'number'
    && typeof value.outputTokens === 'number'
    && typeof value.totalTokens === 'number';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

function toolsForArm(arm: PilotArm): readonly KodaXToolDefinition[] {
  const definitions = listToolDefinitions();
  const names = arm === 'candidate' ? ['read', 'bash', 'memory_recall'] : ['read', 'bash'];
  return names.map((name) => requiredTool(definitions, name));
}

function requiredTool(
  definitions: readonly KodaXToolDefinition[],
  name: string,
): KodaXToolDefinition {
  const definition = definitions.find((item) => item.name === name);
  if (definition === undefined) throw new Error(`production tool is missing: ${name}`);
  return definition;
}

function systemPrompt(arm: PilotArm): string {
  const base = [
    'You are a coding Action Agent in a controlled tool-selection evaluation.',
    'Call at most one tool. Choose the evidence source that directly answers the stated decision gap.',
  ].join('\n');
  return arm === 'candidate' ? [base, '', buildMemoryRulesSection('.')].join('\n') : base;
}

function estimateCost(alias: ModelAlias, usage: KodaXTokenUsage): number {
  const target = MODEL_ALIASES[alias];
  const rate = getCostRate(target.provider, target.model);
  if (rate === undefined) throw new Error(`pricing unavailable for ${target.provider}/${target.model}`);
  return calculateCost(rate, usage.inputTokens, usage.outputTokens, usage.cachedReadTokens ?? 0);
}

function assertPilotSpend(costUsd: number): void {
  if (costUsd > 2) throw new Error(`feature-260 pilot spend cap exceeded: $${costUsd.toFixed(4)}`);
}

function requiredCell(
  summary: Feature260PilotSummary,
  caseId: string,
  arm: PilotArm,
): PilotCell {
  const cell = summary.cells.find((item) => item.caseId === caseId && item.arm === arm);
  if (cell === undefined) throw new Error(`pilot cell missing: ${caseId}/${arm}`);
  return cell;
}

function compactCell(cell: PilotCell): object {
  return {
    toolCalls: cell.toolCalls,
    text: cell.text,
    durationMs: cell.durationMs,
    usage: cell.usage,
  };
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, filePath);
}
