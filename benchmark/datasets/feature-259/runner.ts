import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  calculateCost,
  getCostRate,
  type KodaXTokenUsage,
} from '@kodax-ai/llm';
import type { ModelAlias } from '../../harness/aliases.js';
import { MODEL_ALIASES } from '../../harness/aliases.js';
import {
  runBenchmark,
  runOneShot,
  runWithProviderConcurrency,
  type BenchmarkResult,
  type BenchmarkRunCell,
  type OneShotOutput,
} from '../../harness/harness.js';
import { CHILD_AGENT_SYSTEM_PROMPT } from '../../../packages/coding/src/child-executor.js';
import {
  applyFindingVerification,
  FINDING_VERIFICATION_OUTPUT_SCHEMA,
  mergeScopedReviewResults,
  normalizeScopedReviewResult,
  SCOPED_REVIEW_OUTPUT_SCHEMA,
  type FindingVerificationResult,
  type RawScopedReviewResult,
  type ReviewSeverity,
  type VerifiedScopedReviewResult,
} from '../../../packages/coding/src/workflows/scoped-review.js';
import {
  buildScopedReviewFinalPrompt,
  buildScopedReviewPrimaryPrompt,
  buildScopedReviewVerificationPrompt,
  type ScopedReviewWorkflowResult,
} from '../../../packages/coding/src/workflows/builtin/scoped-review.js';
import type { ReviewPacketMetadata } from '../../../packages/coding/src/workflows/review-packet.js';
import {
  buildStructuredOutputInstruction,
  buildStructuredOutputRepairPrompt,
  evaluateStructuredOutput,
} from '../../../packages/coding/src/workflows/structured-output.js';
import {
  buildFeature259Layer2Cases,
  FEATURE_259_LAYER_3_CASES,
  type Feature259Layer2Case,
  type Feature259Layer3Fixture,
} from './cases.js';

const DUMP_ROOT = path.join(os.tmpdir(), 'kodax-eval-dumps', 'feature-259');
const MIRROR_ROOT = path.join(os.tmpdir(), 'kodax-feature-259-eval-mirror');
const HARD_CAP_USD = 75;
const PILOT_ALIAS: ModelAlias = 'ark/v4flash';
const DECISION_ALIASES: readonly ModelAlias[] = [
  'zhipu/glm52', 'ark/k27', 'mmx/m3', 'ark/v4pro', 'ark/v4flash',
];
const LAYER_3_DECISION_ALIASES: readonly ModelAlias[] = ['zhipu/glm52', 'ark/v4flash'];
const SEVERITY_RANK: Readonly<Record<ReviewSeverity, number>> = {
  low: 0, medium: 1, high: 2, critical: 3,
};

interface UsageTotal {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cachedReadTokens: number;
}

interface Layer2Summary {
  readonly stage: 'pilot' | 'layer2';
  readonly aliases: readonly ModelAlias[];
  readonly runs: number;
  readonly complete: boolean;
  readonly usageCovered: boolean;
  readonly timeoutCompliant: boolean;
  readonly reviewStatus: 'pending-main-session-review' | 'main-session-review-complete';
  readonly evidencePacks: readonly MainSessionEvidenceDescriptor[];
  readonly mainSessionReview?: MainSessionReview;
  readonly results: readonly BenchmarkResult[];
  readonly usage: UsageTotal;
  readonly estimatedCostUsd: number;
}

export type EvalRecommendation =
  | 'recommend-ship'
  | 'recommend-iterate'
  | 'recommend-revert'
  | 'eval-invalid';

interface MainSessionReview {
  readonly reviewVersion: number;
  readonly reviewer: 'main-session';
  readonly recommendation: EvalRecommendation;
  readonly candidateBetter: boolean;
  readonly materialValue: boolean;
  readonly caseResults: readonly {
    readonly caseId: string;
    readonly inputHash: string;
    readonly resolvedPreference: VariantId | 'tie';
  }[];
  readonly reason: string;
}

type VariantId = 'baseline' | 'proposed';

interface MainSessionEvidenceDescriptor {
  readonly caseId: string;
  readonly inputHash: string;
  readonly evidencePath: string;
  readonly revealPath: string;
}

interface ReviewArmResult {
  readonly summary: string;
  readonly packetResults: readonly ScopedReviewWorkflowResult['packetResults'][number][];
  readonly usage: UsageTotal;
  readonly calls: readonly OneShotOutput[];
  readonly primaryStarts: number;
  readonly duplicatePacketReads: number;
}

interface ProviderCallBudget {
  readonly alias: ModelAlias;
  readonly max: number;
  used: number;
}

interface Layer3Cell {
  readonly alias: ModelAlias;
  readonly fixtureId: string;
  readonly repetition: number;
  readonly arm: 'baseline' | 'proposed';
  readonly passed: boolean;
  readonly reason: string;
  readonly result: ReviewArmResult;
}

interface Layer3Summary {
  readonly stage: 'layer3' | 'confirm';
  readonly complete: boolean;
  readonly usageCovered: boolean;
  readonly reviewStatus: 'pending-main-session-review';
  readonly qualityNonInferior: boolean;
  readonly medianStandardTokenReduction: number;
  readonly standardPrimaryReduction: number;
  readonly standardDuplicateReadReduction: number;
  readonly cells: readonly Layer3Cell[];
  readonly usage: UsageTotal;
  readonly estimatedCostUsd: number;
}

function emptyUsage(): UsageTotal {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedReadTokens: 0 };
}

function addUsage(left: UsageTotal, right: KodaXTokenUsage): UsageTotal {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    cachedReadTokens: left.cachedReadTokens + (right.cachedReadTokens ?? 0),
  };
}

function requireUsage(output: OneShotOutput): KodaXTokenUsage {
  if (!output.usage) throw new Error(`usage missing for ${output.alias}`);
  return output.usage;
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

async function writeRawDump(relativePath: string, value: unknown): Promise<void> {
  await Promise.all([
    writeJsonAtomic(path.join(DUMP_ROOT, relativePath), value),
    writeJsonAtomic(path.join(MIRROR_ROOT, relativePath), value),
  ]);
}

async function readMirrorJson<T>(relativePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path.join(MIRROR_ROOT, relativePath), 'utf8')) as T;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    throw error;
  }
}

function estimatedCost(alias: ModelAlias, usage: UsageTotal): number {
  const target = MODEL_ALIASES[alias];
  const rate = getCostRate(target.provider, target.model)
    ?? { inputPer1M: 0.1, outputPer1M: 0.1 };
  return calculateCost(rate, usage.inputTokens, usage.outputTokens, usage.cachedReadTokens);
}

function assertUnderCap(costUsd: number): void {
  if (costUsd > HARD_CAP_USD) {
    throw new Error(`feature-259 hard spend cap exceeded: $${costUsd.toFixed(4)} > $${HARD_CAP_USD}`);
  }
}

function structuredPrompt(prompt: string, schema: unknown, evidence: string): string {
  return [
    'This is a single-turn controlled evaluation. The packet below is complete.',
    'Do not call tools or announce future analysis. Return the required JSON in this response.',
    '',
    prompt,
    '',
    '## Controlled evaluation packet bytes',
    evidence,
    '',
    buildStructuredOutputInstruction(schema),
  ].join('\n');
}

function parsed<T>(output: OneShotOutput, schema: unknown): T {
  const evaluation = evaluateStructuredOutput(output.text, schema);
  if (!evaluation.ok) throw new Error(`structured output failed: ${evaluation.errors.join('; ')}`);
  return evaluation.value as T;
}

function compactText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const half = Math.floor(maxChars / 2);
  return `${value.slice(0, half)}\n...[${value.length - maxChars} chars omitted]...\n${value.slice(-half)}`;
}

function compactRun(run: BenchmarkResult['cells'][number]['runsRaw'][number]): unknown {
  return {
    text: compactText(run.text, 6_000),
    toolCalls: run.toolCalls.map((call) => ({
      name: call.name,
      input: compactText(JSON.stringify(call.input), 4_000),
    })),
    error: run.error ?? null,
    durationMs: run.durationMs,
  };
}

function compactComparison(result: BenchmarkResult, armA: VariantId, armB: VariantId): unknown {
  return result.models.map((alias) => {
    const cellA = result.cells.find((cell) => cell.alias === alias && cell.variantId === armA);
    const cellB = result.cells.find((cell) => cell.alias === alias && cell.variantId === armB);
    const paired = cellA?.runsRaw.flatMap((runA) => {
      const runB = cellB?.runsRaw.find((candidate) => candidate.runIndex === runA.runIndex);
      return runB ? [{ runA, runB, size: runA.text.length + runB.text.length }] : [];
    }) ?? [];
    const usable = paired.filter(({ runA, runB }) => !runA.error && !runB.error);
    const candidates = usable.length > 0 ? usable : paired;
    const representative = [...candidates].sort((left, right) => left.size - right.size)[
      Math.floor(candidates.length / 2)
    ];
    const stats = (cell: typeof cellA) => ({
      passRate: cell?.passRate ?? 0,
      completed: cell?.completed ?? 0,
      runs: cell?.runs ?? 0,
      errors: cell?.runsRaw.filter((run) => run.error).map((run) => run.error) ?? [],
    });
    return {
      alias,
      armA: { stats: stats(cellA), sample: representative ? compactRun(representative.runA) : null },
      armB: { stats: stats(cellB), sample: representative ? compactRun(representative.runB) : null },
      sampleSelection: 'median combined text length among paired non-error runs; fallback to all paired runs',
    };
  });
}

async function writeMainSessionEvidence(
  evalCase: Feature259Layer2Case,
  result: BenchmarkResult,
  analysisId: string,
): Promise<MainSessionEvidenceDescriptor> {
  const armA: VariantId = Number.parseInt(hash(evalCase.id).slice(-2), 16) % 2 === 0
    ? 'baseline' : 'proposed';
  const armB: VariantId = armA === 'baseline' ? 'proposed' : 'baseline';
  const evidence = {
    reviewVersion: 1,
    caseId: evalCase.id,
    contract: evalCase.contract,
    task: evalCase.variants[0]?.userMessage ?? '',
    pairedEvidence: compactComparison(result, armA, armB),
  };
  const evidenceText = JSON.stringify(evidence);
  const inputHash = hash(evidenceText);
  const evidenceRelativePath = path.join(
    'layer2', 'main-session-review', analysisId, 'cases', `${evalCase.id}.json`,
  );
  const revealRelativePath = path.join(
    'layer2', 'main-session-review', analysisId, 'reveal', `${evalCase.id}.json`,
  );
  await writeRawDump(evidenceRelativePath, { inputHash, ...evidence });
  await writeRawDump(revealRelativePath, { inputHash, caseId: evalCase.id, armA, armB });
  return {
    caseId: evalCase.id,
    inputHash,
    evidencePath: path.join(MIRROR_ROOT, evidenceRelativePath),
    revealPath: path.join(MIRROR_ROOT, revealRelativePath),
  };
}

export interface Layer2AnalysisOptions {
  readonly analysisId?: string;
  readonly caseIds?: readonly string[];
  readonly allowGeneration?: boolean;
}

export async function runFeature259Layer2(
  stage: 'pilot' | 'layer2',
  options: Layer2AnalysisOptions = {},
): Promise<Layer2Summary> {
  const aliases = stage === 'pilot' ? [PILOT_ALIAS] : [...DECISION_ALIASES];
  const runs = stage === 'pilot' ? 1 : 5;
  const results: BenchmarkResult[] = [];
  let usage = emptyUsage();
  let cost = 0;

  const allCases = buildFeature259Layer2Cases();
  for (const evalCase of allCases) {
    const resumeRun = async (
      variantId: string,
      alias: ModelAlias,
      runIndex: number,
    ) => {
      const relativePath = path.join(stage, 'runs', evalCase.id, variantId, alias, `${runIndex}.json`);
      const saved = await readMirrorJson<{
        readonly caseId: string;
        readonly contract: string;
        readonly variant: unknown;
        readonly rawRun: BenchmarkResult['cells'][number]['runsRaw'][number];
      }>(relativePath);
      const variant = evalCase.variants.find((item) => item.id === variantId);
      const valid = saved !== undefined && saved.caseId === evalCase.id
        && saved.contract === evalCase.contract
        && JSON.stringify(saved.variant) === JSON.stringify(variant);
      if (!valid) {
        const reason = `frozen raw mismatch for ${evalCase.id}/${variantId}/${alias}/${runIndex}`;
        await writeRawDump(path.join(stage, 'resume-mismatches', evalCase.id, variantId, alias, `${runIndex}.json`), {
          found: saved !== undefined,
          savedCaseId: saved?.caseId,
          currentCaseId: evalCase.id,
          contractMatches: saved?.contract === evalCase.contract,
          savedVariantHash: saved ? hash(JSON.stringify(saved.variant)) : null,
          currentVariantHash: hash(JSON.stringify(variant)),
          generationAllowed: options.allowGeneration === true,
        });
        if (options.allowGeneration === true) return undefined;
        const aggregate = {
          passed: false,
          results: [{ name: 'frozen-evidence', category: 'format' as const, passed: false, reason }],
          byCategory: { format: { passed: 0, total: 1 } },
          formatPassed: false,
        };
        const unavailable: BenchmarkRunCell = {
          variantId,
          alias,
          runIndex,
          text: '',
          toolCalls: [],
          durationMs: 0,
          error: reason,
          judges: aggregate.results,
          judgeAggregate: aggregate,
          passed: false,
        };
        return unavailable;
      }
      return saved.rawRun;
    };
    const result = await runBenchmark({
      variants: evalCase.variants,
      models: aliases,
      judges: evalCase.judges,
      runs,
      timeoutMs: 120_000,
      maxOutputTokens: 8_192,
      resumeRun,
      onRun: async (rawRun) => {
        const variant = evalCase.variants.find((item) => item.id === rawRun.variantId);
        await writeRawDump(path.join(
          stage,
          'runs',
          evalCase.id,
          rawRun.variantId,
          rawRun.alias,
          `${rawRun.runIndex}.json`,
        ), { caseId: evalCase.id, contract: evalCase.contract, variant, rawRun });
      },
    });
    results.push(result);
    for (const cell of result.cells) {
      for (const run of cell.runsRaw) {
        if (!run.usage) continue;
        usage = addUsage(usage, run.usage);
        cost += estimatedCost(cell.alias, {
          ...emptyUsage(),
          inputTokens: run.usage.inputTokens,
          outputTokens: run.usage.outputTokens,
          totalTokens: run.usage.totalTokens,
          cachedReadTokens: run.usage.cachedReadTokens ?? 0,
        });
      }
    }
    assertUnderCap(cost);
    await writeRawDump(`${stage}.partial.json`, {
      stage, aliases, runs, results, usage, estimatedCostUsd: cost,
    });
  }

  const selected = allCases.flatMap((evalCase, index) =>
    options.caseIds === undefined || options.caseIds.includes(evalCase.id)
      ? [{ evalCase, result: results[index]! }]
      : []
  );
  if (selected.length === 0) throw new Error('feature-259 analysis selected no cases');
  const analysisId = options.analysisId ?? (stage === 'pilot' ? 'generation-pilot' : 'full');
  const evidencePacks = await Promise.all(selected.map(({ evalCase, result }) =>
    writeMainSessionEvidence(evalCase, result, analysisId)
  ));
  const savedReview = await readMirrorJson<MainSessionReview>(path.join(
    'layer2', 'main-session-review', analysisId, 'main-session-review.json',
  ));
  const mainSessionReview = savedReview?.reviewVersion === 1
    && savedReview.reviewer === 'main-session'
    && evidencePacks.every((pack) => savedReview.caseResults.some(
      (result) => result.caseId === pack.caseId && result.inputHash === pack.inputHash,
    )) ? savedReview : undefined;

  const complete = results.every((result) => result.cells.every((cell) => cell.runsRaw.length === runs));
  const usageCovered = results.every((result) => result.cells.every(
    (cell) => cell.runsRaw.every((run) => run.usage !== undefined),
  ));
  const timeoutCompliant = results.every((result) => result.cells.every(
    (cell) => cell.runsRaw.every((run) => run.durationMs <= 120_000),
  ));
  const summary: Layer2Summary = {
    stage, aliases, runs, complete, usageCovered, timeoutCompliant,
    reviewStatus: mainSessionReview
      ? 'main-session-review-complete'
      : 'pending-main-session-review',
    evidencePacks,
    ...(mainSessionReview ? { mainSessionReview } : {}),
    results, usage, estimatedCostUsd: cost,
  };
  await writeRawDump(`${stage}.${analysisId}.json`, summary);
  return summary;
}

function packetFor(fixture: Feature259Layer3Fixture, areaIndex: number): ReviewPacketMetadata {
  const area = fixture.areas[areaIndex]!;
  const contentHash = hash(`${fixture.id}\0${area.partitionKey}\0${area.evidence}`);
  return {
    packetPath: `/eval/${fixture.id}/${areaIndex}/manifest.md`,
    contentHash,
    rangeId: fixture.id,
    partitionKey: area.partitionKey,
    label: fixture.id,
    scopePaths: area.scopePaths,
    riskFlags: fixture.risk ? ['routing-high'] : [],
    budget: { maxBytes: 32_000, maxLines: 500, maxLineChars: 2_000 },
    evidenceChunks: [{ path: `/eval/${fixture.id}/${areaIndex}/evidence.md`, contentHash }],
    requirementsPresent: fixture.requirements.length > 0,
    testEvidencePresent: fixture.id === 'misleading-test',
  };
}

function packetEvidence(fixture: Feature259Layer3Fixture, areaIndex: number): string {
  return [
    `Binding requirements: ${JSON.stringify(fixture.requirements)}`,
    fixture.areas[areaIndex]!.evidence,
  ].join('\n');
}

async function callStructured<T>(
  alias: ModelAlias,
  prompt: string,
  schema: unknown,
  evidence: string,
  dumpId: string,
  budget: ProviderCallBudget,
): Promise<{ readonly value: T; readonly calls: readonly OneShotOutput[] }> {
  const userMessage = structuredPrompt(prompt, schema, evidence);
  const inputHash = hash(JSON.stringify({ alias, systemPrompt: CHILD_AGENT_SYSTEM_PROMPT, userMessage }));
  const relativePath = path.join('layer3-calls', `${dumpId}.json`);
  const cached = await readMirrorJson<{
    readonly inputHash: string;
    readonly calls?: readonly OneShotOutput[];
    readonly raw?: OneShotOutput;
  }>(relativePath);
  const cachedCalls = cached?.calls ?? (cached?.raw ? [cached.raw] : []);
  const cachedFinal = cachedCalls.at(-1);
  if (cached?.inputHash === inputHash && cachedFinal?.usage !== undefined) {
    consumeProviderCalls(budget, cachedCalls.length);
    return { value: parsed<T>(cachedFinal, schema), calls: cachedCalls };
  }
  consumeProviderCalls(budget, 1);
  const first = await runOneShot(alias, {
    systemPrompt: CHILD_AGENT_SYSTEM_PROMPT,
    userMessage,
    timeoutMs: 120_000,
    maxOutputTokens: 4_096,
  });
  requireUsage(first);
  const firstEvaluation = evaluateStructuredOutput(first.text, schema);
  const calls: OneShotOutput[] = [first];
  if (!firstEvaluation.ok) {
    consumeProviderCalls(budget, 1);
    const repair = await runOneShot(alias, {
      systemPrompt: CHILD_AGENT_SYSTEM_PROMPT,
      userMessage: buildStructuredOutputRepairPrompt(firstEvaluation.errors, schema),
      priorMessages: [
        { role: 'user', content: userMessage },
        { role: 'assistant', content: first.text },
      ],
      timeoutMs: 120_000,
      maxOutputTokens: 4_096,
    });
    requireUsage(repair);
    calls.push(repair);
  }
  await writeRawDump(relativePath, {
    inputHash, alias, systemPrompt: CHILD_AGENT_SYSTEM_PROMPT, userMessage, calls,
  });
  return { value: parsed<T>(calls.at(-1)!, schema), calls };
}

function consumeProviderCalls(budget: ProviderCallBudget, count: number): void {
  if (budget.used + count > budget.max) {
    throw new Error(
      `feature-259 call cap would be exceeded for ${budget.alias}: ${budget.used + count} > ${budget.max}`,
    );
  }
  budget.used += count;
}

function toVerified(raw: ReturnType<typeof mergeScopedReviewResults>): VerifiedScopedReviewResult {
  return {
    specVerdict: raw.specVerdict,
    qualityVerdict: raw.qualityVerdict,
    unverifiedRequirements: raw.unverifiedRequirements,
    actionable: raw.findings.map((finding) => ({
      ...finding,
      disposition: 'confirmed' as const,
      verificationEvidence: 'Baseline arm has no independent verifier.',
    })),
    audit: { findings: [] },
    unqualifiedApprovalAllowed:
      raw.findings.length === 0 && raw.unverifiedRequirements.length === 0
      && raw.specVerdict === 'compliant' && raw.qualityVerdict === 'approved',
  };
}

function allEvidence(fixture: Feature259Layer3Fixture): string {
  return fixture.areas.map((_, index) => packetEvidence(fixture, index)).join('\n\n');
}

async function runBaselineArm(
  alias: ModelAlias,
  fixture: Feature259Layer3Fixture,
  dumpPrefix: string,
  budget: ProviderCallBudget,
): Promise<ReviewArmResult> {
  const lenses = ['specification compliance', 'implementation quality', 'adversarial edge cases', 'scope and test integrity'];
  const calls: OneShotOutput[] = [];
  const reviews: RawScopedReviewResult[] = [];
  for (const [lensIndex, lens] of lenses.entries()) {
    const response = await callStructured<RawScopedReviewResult>(alias, [
      `Broadly review the complete frozen change for ${lens}.`,
      'Own both specification and implementation-quality verdicts. Cite exact locations.',
      'If a binding requirement cannot be proven from the evidence, use specVerdict not-verifiable and name it in unverifiedRequirements.',
    ].join('\n'), SCOPED_REVIEW_OUTPUT_SCHEMA, allEvidence(fixture), `${dumpPrefix}__primary-${lensIndex}`, budget);
    calls.push(...response.calls);
    reviews.push(response.value);
  }
  const normalized = reviews.map((review, index) => normalizeScopedReviewResult(
    hash(`${fixture.id}\0baseline\0${index}`), true, review,
  ));
  const verified = toVerified(mergeScopedReviewResults(normalized));
  const packetResults = [{ contentHash: hash(`${fixture.id}\0baseline`), result: verified }];
  const final = await callStructured<{ readonly summary: string }>(
    alias,
    buildScopedReviewFinalPrompt(packetResults),
    { type: 'object', additionalProperties: false, required: ['summary'], properties: { summary: { type: 'string' } } },
    'Synthesize only the structured results already present in the prompt.',
    `${dumpPrefix}__final`,
    budget,
  );
  calls.push(...final.calls);
  const usage = calls.reduce((total, call) => addUsage(total, requireUsage(call)), emptyUsage());
  return {
    summary: final.value.summary,
    packetResults,
    usage,
    calls,
    primaryStarts: lenses.length,
    duplicatePacketReads: Math.max(0, lenses.length - 1) * fixture.areas.length,
  };
}

async function runProposedArm(
  alias: ModelAlias,
  fixture: Feature259Layer3Fixture,
  dumpPrefix: string,
  budget: ProviderCallBudget,
): Promise<ReviewArmResult> {
  const calls: OneShotOutput[] = [];
  const packetResults: ScopedReviewWorkflowResult['packetResults'][number][] = [];
  let primaryStarts = 0;
  let duplicatePacketReads = 0;
  for (let areaIndex = 0; areaIndex < fixture.areas.length; areaIndex++) {
    const packet = packetFor(fixture, areaIndex);
    const primaries: RawScopedReviewResult[] = [];
    const count = fixture.risk ? 2 : 1;
    for (let primaryIndex = 0; primaryIndex < count; primaryIndex++) {
      const response = await callStructured<RawScopedReviewResult>(
        alias,
        buildScopedReviewPrimaryPrompt(packet, primaryIndex === 1, { packets: [packet] }),
        SCOPED_REVIEW_OUTPUT_SCHEMA,
        packetEvidence(fixture, areaIndex),
        `${dumpPrefix}__area-${areaIndex}-primary-${primaryIndex}`,
        budget,
      );
      calls.push(...response.calls);
      primaries.push(response.value);
      primaryStarts += 1;
      if (primaryIndex > 0) duplicatePacketReads += 1;
    }
    const merged = mergeScopedReviewResults(primaries.map((primary) =>
      normalizeScopedReviewResult(packet.contentHash, packet.requirementsPresent, primary)
    ));
    let verified: VerifiedScopedReviewResult;
    if (merged.findings.length === 0) {
      verified = {
        specVerdict: merged.specVerdict,
        qualityVerdict: merged.qualityVerdict,
        unverifiedRequirements: merged.unverifiedRequirements,
        actionable: [],
        audit: { findings: [] },
        unqualifiedApprovalAllowed:
          merged.unverifiedRequirements.length === 0 && merged.specVerdict === 'compliant'
          && merged.qualityVerdict === 'approved',
      };
    } else {
      const response = await callStructured<FindingVerificationResult>(
        alias,
        buildScopedReviewVerificationPrompt(packet, merged),
        FINDING_VERIFICATION_OUTPUT_SCHEMA,
        packetEvidence(fixture, areaIndex),
        `${dumpPrefix}__area-${areaIndex}-verification`,
        budget,
      );
      calls.push(...response.calls);
      verified = applyFindingVerification(merged, response.value);
      duplicatePacketReads += 1;
    }
    packetResults.push({ contentHash: packet.contentHash, result: verified });
  }
  const final = await callStructured<{ readonly summary: string }>(
    alias,
    buildScopedReviewFinalPrompt(packetResults),
    { type: 'object', additionalProperties: false, required: ['summary'], properties: { summary: { type: 'string' } } },
    'Synthesize only the structured results already present in the prompt.',
    `${dumpPrefix}__final`,
    budget,
  );
  calls.push(...final.calls);
  return {
    summary: final.value.summary,
    packetResults,
    usage: calls.reduce((total, call) => addUsage(total, requireUsage(call)), emptyUsage()),
    calls,
    primaryStarts,
    duplicatePacketReads,
  };
}

function scoreReview(fixture: Feature259Layer3Fixture, result: ReviewArmResult): { passed: boolean; reason: string } {
  const verified = result.packetResults.map((packet) => packet.result);
  const searchable = `${result.summary}\n${JSON.stringify(verified)}`.toLowerCase();
  if (fixture.expectedDisposition === 'approved') {
    const passed = verified.every((item) => item.unqualifiedApprovalAllowed && item.actionable.length === 0);
    return { passed, reason: passed ? 'clean control approved' : 'clean control produced an issue or uncertainty' };
  }
  if (fixture.expectedDisposition === 'not-verifiable') {
    const passed = verified.some((item) => item.specVerdict === 'not-verifiable'
      && item.unverifiedRequirements.some((requirement) => requirement.toLowerCase().includes(fixture.expectedNeedle.toLowerCase())));
    return { passed, reason: passed ? 'requirement preserved as not-verifiable' : 'unprovable requirement was not preserved' };
  }
  const expectedRank = SEVERITY_RANK[fixture.expectedSeverity!];
  const passed = verified.some((item) => item.actionable.some((finding) =>
    finding.disposition === 'confirmed'
    && SEVERITY_RANK[finding.severity] >= expectedRank
    && `${finding.location} ${finding.claim} ${finding.evidence.join(' ')}`.toLowerCase()
      .includes(fixture.expectedNeedle.toLowerCase())
  )) && searchable.includes(fixture.expectedNeedle.toLowerCase());
  return { passed, reason: passed ? 'expected confirmed finding preserved' : 'expected confirmed finding/severity/location missing' };
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function reduction(baseline: number, proposed: number): number {
  return baseline === 0 ? 0 : (baseline - proposed) / baseline;
}

export async function runFeature259Layer3(
  stage: 'layer3' | 'confirm',
  options: { readonly allowGeneration?: boolean } = {},
): Promise<Layer3Summary> {
  if (options.allowGeneration !== true) {
    throw new Error('feature-259 Layer-3 generation requires explicit allowGeneration=true');
  }
  const confirmationIds = new Set(['trust-boundary', 'shared-state', 'plan-mandated-defect']);
  const comparisonIds = new Set([
    'edge-condition', 'shared-state', 'requirement-not-provable', 'clean-control',
  ]);
  const aliases = stage === 'layer3' ? [...LAYER_3_DECISION_ALIASES] : [...DECISION_ALIASES];
  const fixtures = stage === 'layer3'
    ? FEATURE_259_LAYER_3_CASES.filter((fixture) => comparisonIds.has(fixture.id))
    : FEATURE_259_LAYER_3_CASES.filter((fixture) => confirmationIds.has(fixture.id));
  const repetitions = 1;
  const arms: readonly ('baseline' | 'proposed')[] = stage === 'layer3' ? ['baseline', 'proposed'] : ['proposed'];
  const perAliasCallCap = stage === 'layer3' ? 40 : 20;
  const aliasResults = await runWithProviderConcurrency(aliases.map((alias) => ({
    alias,
    run: async () => {
      const aliasCells: Layer3Cell[] = [];
      let aliasCost = 0;
      const callBudget: ProviderCallBudget = { alias, max: perAliasCallCap, used: 0 };
      for (const fixture of fixtures) {
        for (let repetition = 0; repetition < repetitions; repetition++) {
          for (const arm of arms) {
            const dumpPrefix = `${stage}__${alias.replace('/', '-')}__${fixture.id}__${repetition}__${arm}`;
            const result = arm === 'baseline'
              ? await runBaselineArm(alias, fixture, dumpPrefix, callBudget)
              : await runProposedArm(alias, fixture, dumpPrefix, callBudget);
            const score = scoreReview(fixture, result);
            const cell = { alias, fixtureId: fixture.id, repetition, arm, ...score, result };
            aliasCells.push(cell);
            await writeRawDump(path.join(stage, 'cells', `${dumpPrefix}.json`), cell);
            aliasCost += estimatedCost(alias, result.usage);
            assertUnderCap(aliasCost);
            await writeRawDump(path.join(
              stage, 'partial', `${alias.replace('/', '__')}.json`,
            ), { stage, alias, cells: aliasCells, providerCalls: callBudget.used, estimatedCostUsd: aliasCost });
          }
        }
      }
      return { cells: aliasCells, cost: aliasCost, providerCalls: callBudget.used };
    },
  })));
  const cells = aliasResults.flatMap((result) => result.cells);
  const cost = aliasResults.reduce((sum, result) => sum + result.cost, 0);
  assertUnderCap(cost);

  const proposed = cells.filter((cell) => cell.arm === 'proposed');
  const baseline = cells.filter((cell) => cell.arm === 'baseline');
  const qualityNonInferior = stage === 'confirm'
    ? proposed.every((cell) => cell.passed)
    : proposed.every((cell) => {
        const paired = baseline.find((candidate) => candidate.alias === cell.alias
          && candidate.fixtureId === cell.fixtureId && candidate.repetition === cell.repetition);
        return cell.passed || paired?.passed === false;
      });
  const standardPairs = stage === 'layer3' ? baseline.flatMap((base) => {
    const fixture = FEATURE_259_LAYER_3_CASES.find((item) => item.id === base.fixtureId);
    if (!fixture?.standardReview) return [];
    const next = proposed.find((candidate) => candidate.alias === base.alias
      && candidate.fixtureId === base.fixtureId && candidate.repetition === base.repetition);
    return next ? [{ baseline: base, proposed: next }] : [];
  }) : [];
  const tokenReductions = standardPairs.map((pair) => reduction(
    pair.baseline.result.usage.totalTokens, pair.proposed.result.usage.totalTokens,
  ));
  const baselineStarts = standardPairs.reduce((sum, pair) => sum + pair.baseline.result.primaryStarts, 0);
  const proposedStarts = standardPairs.reduce((sum, pair) => sum + pair.proposed.result.primaryStarts, 0);
  const baselineReads = standardPairs.reduce((sum, pair) => sum + pair.baseline.result.duplicatePacketReads, 0);
  const proposedReads = standardPairs.reduce((sum, pair) => sum + pair.proposed.result.duplicatePacketReads, 0);
  const usage = cells.reduce((total, cell) => ({
    inputTokens: total.inputTokens + cell.result.usage.inputTokens,
    outputTokens: total.outputTokens + cell.result.usage.outputTokens,
    totalTokens: total.totalTokens + cell.result.usage.totalTokens,
    cachedReadTokens: total.cachedReadTokens + cell.result.usage.cachedReadTokens,
  }), emptyUsage());
  const medianStandardTokenReduction = median(tokenReductions);
  const standardPrimaryReduction = reduction(baselineStarts, proposedStarts);
  const standardDuplicateReadReduction = reduction(baselineReads, proposedReads);
  const usageCovered = cells.every((cell) => cell.result.calls.every((call) => call.usage !== undefined));
  const summary: Layer3Summary = {
    stage, complete: true, usageCovered, reviewStatus: 'pending-main-session-review', qualityNonInferior,
    medianStandardTokenReduction, standardPrimaryReduction, standardDuplicateReadReduction,
    cells, usage, estimatedCostUsd: cost,
  };
  await writeRawDump(`${stage}.json`, summary);
  return summary;
}

export async function readFeature259Dump(name: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(DUMP_ROOT, name), 'utf8')) as unknown;
}
