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
  type BenchmarkResult,
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
  evaluateStructuredOutput,
} from '../../../packages/coding/src/workflows/structured-output.js';
import {
  buildFeature259Layer2Cases,
  FEATURE_259_LAYER_3_CASES,
  type Feature259Layer3Fixture,
} from './cases.js';

const DUMP_ROOT = path.join(os.tmpdir(), 'kodax-eval-dumps', 'feature-259');
const HARD_CAP_USD = 75;
const PILOT_ALIAS: ModelAlias = 'ark/v4flash';
const DECISION_ALIASES: readonly ModelAlias[] = [
  'zhipu/glm51', 'kimi', 'mmx/m27', 'ark/v4pro', 'ark/v4flash',
];
const LAYER_3_DECISION_ALIASES: readonly ModelAlias[] = ['zhipu/glm51', 'ark/v4flash'];
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
  readonly decisionPassed: boolean;
  readonly judgeAudits: readonly JudgeAudit[];
  readonly results: readonly BenchmarkResult[];
  readonly usage: UsageTotal;
  readonly estimatedCostUsd: number;
}

interface ReviewArmResult {
  readonly summary: string;
  readonly packetResults: readonly ScopedReviewWorkflowResult['packetResults'][number][];
  readonly usage: UsageTotal;
  readonly calls: readonly OneShotOutput[];
  readonly primaryStarts: number;
  readonly duplicatePacketReads: number;
}

interface Layer3Cell {
  readonly alias: ModelAlias;
  readonly fixtureId: string;
  readonly repetition: number;
  readonly arm: 'baseline' | 'proposed';
  readonly passed: boolean;
  readonly reason: string;
  readonly result: ReviewArmResult;
  readonly judgeAudit?: JudgeAudit;
}

interface Layer3Summary {
  readonly stage: 'layer3' | 'confirm';
  readonly complete: boolean;
  readonly usageCovered: boolean;
  readonly decisionPassed: boolean;
  readonly qualityNonInferior: boolean;
  readonly medianStandardTokenReduction: number;
  readonly standardPrimaryReduction: number;
  readonly standardDuplicateReadReduction: number;
  readonly judgeDisagreementRate: number;
  readonly cells: readonly Layer3Cell[];
  readonly usage: UsageTotal;
  readonly estimatedCostUsd: number;
}

interface JudgeAudit {
  readonly alias: ModelAlias;
  readonly caseId: string;
  readonly mechanicalPassed: false;
  readonly judgeAgrees: boolean;
  readonly reason: string;
  readonly raw: OneShotOutput;
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

async function auditFailure(
  caseId: string,
  contract: string,
  rawOutput: string,
  mechanicalReason: string,
): Promise<JudgeAudit> {
  const schema = {
    type: 'object', additionalProperties: false, required: ['agrees', 'reason'],
    properties: { agrees: { type: 'boolean' }, reason: { type: 'string' } },
  } as const;
  const raw = await runOneShot(PILOT_ALIAS, {
    systemPrompt: 'You are an independent benchmark-scoring auditor. Judge only the frozen contract and candidate output. Do not infer unstated requirements.',
    userMessage: structuredPrompt([
      `Case: ${caseId}`,
      `Frozen contract: ${contract}`,
      `Mechanical scorer reason: ${mechanicalReason}`,
      'Candidate output follows:',
      rawOutput,
      'Does the mechanical failure accurately reflect the frozen contract?',
    ].join('\n'), schema, 'No additional evidence.'),
  });
  const verdict = parsed<{ readonly agrees: boolean; readonly reason: string }>(raw, schema);
  requireUsage(raw);
  return {
    alias: PILOT_ALIAS,
    caseId,
    mechanicalPassed: false,
    judgeAgrees: verdict.agrees,
    reason: verdict.reason,
    raw,
  };
}

function layer2Decision(results: readonly BenchmarkResult[]): boolean {
  const comparisons = results.flatMap((result) => result.models.map((alias) => {
    const baseline = result.cells.find((cell) => cell.alias === alias && cell.variantId === 'baseline');
    const proposed = result.cells.find((cell) => cell.alias === alias && cell.variantId === 'proposed');
    return baseline !== undefined && proposed !== undefined && proposed.quality >= baseline.quality;
  }));
  const casesPassingFourModels = results.every((result) => {
    const passes = result.models.filter((alias) => {
      const baseline = result.cells.find((cell) => cell.alias === alias && cell.variantId === 'baseline');
      const proposed = result.cells.find((cell) => cell.alias === alias && cell.variantId === 'proposed');
      return baseline !== undefined && proposed !== undefined
        && proposed.quality >= baseline.quality && proposed.passRate === 100;
    }).length;
    return passes >= Math.min(4, result.models.length);
  });
  return comparisons.every(Boolean) && casesPassingFourModels;
}

export async function runFeature259Layer2(stage: 'pilot' | 'layer2'): Promise<Layer2Summary> {
  const aliases = stage === 'pilot' ? [PILOT_ALIAS] : [...DECISION_ALIASES];
  const runs = stage === 'pilot' ? 1 : 5;
  const results: BenchmarkResult[] = [];
  const judgeAudits: JudgeAudit[] = [];
  let usage = emptyUsage();
  let cost = 0;

  for (const evalCase of buildFeature259Layer2Cases()) {
    const result = await runBenchmark({
      variants: evalCase.variants,
      models: aliases,
      judges: evalCase.judges,
      runs,
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
        const failedJudge = run.judges.find((judge) => !judge.passed);
        if (!run.error && failedJudge) {
          const audit = await auditFailure(
            `${evalCase.id}/${cell.variantId}/${cell.alias}/${run.runIndex}`,
            evalCase.judges.map((judge) => judge.name).join(', '),
            run.text || JSON.stringify(run.toolCalls),
            failedJudge.reason ?? failedJudge.name,
          );
          judgeAudits.push(audit);
          const auditUsage = requireUsage(audit.raw);
          usage = addUsage(usage, auditUsage);
          cost += estimatedCost(audit.alias, {
            inputTokens: auditUsage.inputTokens,
            outputTokens: auditUsage.outputTokens,
            totalTokens: auditUsage.totalTokens,
            cachedReadTokens: auditUsage.cachedReadTokens ?? 0,
          });
        }
      }
    }
    assertUnderCap(cost);
    await writeJsonAtomic(path.join(DUMP_ROOT, `${stage}.partial.json`), {
      stage, aliases, runs, results, judgeAudits, usage, estimatedCostUsd: cost,
    });
  }

  const complete = results.every((result) => result.cells.every((cell) => cell.completed === runs));
  const usageCovered = results.every((result) => result.cells.every(
    (cell) => cell.runsRaw.every((run) => run.usage !== undefined),
  ));
  const disagreements = judgeAudits.filter((audit) => !audit.judgeAgrees).length;
  const auditValid = judgeAudits.length === 0 || disagreements / judgeAudits.length <= 0.1;
  const summary: Layer2Summary = {
    stage, aliases, runs, complete, usageCovered,
    decisionPassed: complete && usageCovered && auditValid && layer2Decision(results),
    judgeAudits, results, usage, estimatedCostUsd: cost,
  };
  await writeJsonAtomic(path.join(DUMP_ROOT, `${stage}.json`), summary);
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
): Promise<{ readonly value: T; readonly raw: OneShotOutput }> {
  const raw = await runOneShot(alias, {
    systemPrompt: CHILD_AGENT_SYSTEM_PROMPT,
    userMessage: structuredPrompt(prompt, schema, evidence),
  });
  requireUsage(raw);
  return { value: parsed<T>(raw, schema), raw };
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

async function runBaselineArm(alias: ModelAlias, fixture: Feature259Layer3Fixture): Promise<ReviewArmResult> {
  const lenses = ['specification compliance', 'implementation quality', 'adversarial edge cases', 'scope and test integrity'];
  const calls: OneShotOutput[] = [];
  const reviews: RawScopedReviewResult[] = [];
  for (const lens of lenses) {
    const response = await callStructured<RawScopedReviewResult>(alias, [
      `Broadly review the complete frozen change for ${lens}.`,
      'Own both specification and implementation-quality verdicts. Cite exact locations.',
      'If a binding requirement cannot be proven from the evidence, use specVerdict not-verifiable and name it in unverifiedRequirements.',
    ].join('\n'), SCOPED_REVIEW_OUTPUT_SCHEMA, allEvidence(fixture));
    calls.push(response.raw);
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
  );
  calls.push(final.raw);
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

async function runProposedArm(alias: ModelAlias, fixture: Feature259Layer3Fixture): Promise<ReviewArmResult> {
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
      );
      calls.push(response.raw);
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
      );
      calls.push(response.raw);
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
  );
  calls.push(final.raw);
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

export async function runFeature259Layer3(stage: 'layer3' | 'confirm'): Promise<Layer3Summary> {
  const confirmationIds = new Set(['trust-boundary', 'shared-state', 'plan-mandated-defect']);
  const aliases = stage === 'layer3' ? [...LAYER_3_DECISION_ALIASES] : [...DECISION_ALIASES];
  const fixtures = stage === 'layer3'
    ? [...FEATURE_259_LAYER_3_CASES]
    : FEATURE_259_LAYER_3_CASES.filter((fixture) => confirmationIds.has(fixture.id));
  const repetitions = stage === 'layer3' ? 3 : 1;
  const arms: readonly ('baseline' | 'proposed')[] = stage === 'layer3' ? ['baseline', 'proposed'] : ['proposed'];
  const cells: Layer3Cell[] = [];
  let cost = 0;
  for (const alias of aliases) {
    for (const fixture of fixtures) {
      for (let repetition = 0; repetition < repetitions; repetition++) {
        for (const arm of arms) {
          const result = arm === 'baseline'
            ? await runBaselineArm(alias, fixture)
            : await runProposedArm(alias, fixture);
          const score = scoreReview(fixture, result);
          const judgeAudit = score.passed ? undefined : await auditFailure(
            `${stage}/${fixture.id}/${alias}/${repetition}/${arm}`,
            `${fixture.expectedDisposition}; expected ${fixture.expectedSeverity ?? 'no severity'}; needle ${fixture.expectedNeedle}`,
            `${result.summary}\n${JSON.stringify(result.packetResults)}`,
            score.reason,
          );
          cells.push({ alias, fixtureId: fixture.id, repetition, arm, ...score, result, ...(judgeAudit ? { judgeAudit } : {}) });
          cost += estimatedCost(alias, result.usage);
          if (judgeAudit) {
            const auditUsage = requireUsage(judgeAudit.raw);
            cost += estimatedCost(judgeAudit.alias, {
              inputTokens: auditUsage.inputTokens,
              outputTokens: auditUsage.outputTokens,
              totalTokens: auditUsage.totalTokens,
              cachedReadTokens: auditUsage.cachedReadTokens ?? 0,
            });
          }
          assertUnderCap(cost);
          await writeJsonAtomic(path.join(DUMP_ROOT, `${stage}.partial.json`), { stage, cells, estimatedCostUsd: cost });
        }
      }
    }
  }

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
  const audits = cells.flatMap((cell) => cell.judgeAudit ? [cell.judgeAudit] : []);
  const judgeDisagreementRate = audits.length === 0 ? 0
    : audits.filter((audit) => !audit.judgeAgrees).length / audits.length;
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
  const decisionPassed = stage === 'confirm'
    ? qualityNonInferior && usageCovered && judgeDisagreementRate <= 0.1
    : qualityNonInferior && usageCovered && judgeDisagreementRate <= 0.1
      && medianStandardTokenReduction >= 0.2
      && standardPrimaryReduction >= 0.3
      && standardDuplicateReadReduction >= 0.3;
  const summary: Layer3Summary = {
    stage, complete: true, usageCovered, decisionPassed, qualityNonInferior,
    medianStandardTokenReduction, standardPrimaryReduction, standardDuplicateReadReduction,
    judgeDisagreementRate, cells, usage, estimatedCostUsd: cost,
  };
  await writeJsonAtomic(path.join(DUMP_ROOT, `${stage}.json`), summary);
  return summary;
}

export async function readFeature259Dump(name: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(DUMP_ROOT, name), 'utf8')) as unknown;
}
