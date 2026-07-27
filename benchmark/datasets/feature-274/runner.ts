import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  calculateCost,
  getCostRate,
  type CostRate,
  type KodaXMessage,
  type KodaXTokenUsage,
  type KodaXToolDefinition,
} from '@kodax-ai/llm';
import type { ModelAlias } from '../../harness/aliases.js';
import { MODEL_ALIASES } from '../../harness/aliases.js';
import { runOneShot } from '../../harness/harness.js';
import { buildWorkerStableInstructions } from '../../../packages/coding/src/agents/worker-role-prompt.js';
import {
  buildVerifierUserMessage,
  VERIFIER_REPORT_TOOL,
  VERIFIER_SYSTEM_PROMPT,
} from '../../../packages/coding/src/agent-runtime/middleware/sidecar-verifier/verifier-prompts.js';
import type { PatternTrace } from '../../../packages/coding/src/orchestration/pattern-trace.js';
import { renderAmaPatternPlaybook } from '../../../packages/coding/src/orchestration/pattern-catalog.js';
import { getToolDefinition } from '../../../packages/coding/src/tools/registry.js';
import {
  FEATURE_274_JOURNEY_CASES,
  FEATURE_274_POLICY_CASES,
  type Feature274JourneyCase,
  type Feature274PolicyCase,
} from './cases.js';
import {
  FEATURE_274_EXPANSION_ALIASES,
  FEATURE_274_PILOT_ALIAS,
  FEATURE_274_RAW_ROOT,
  FEATURE_274_REVISION,
  buildFeature274ExperimentContract,
} from './experiment-contract.js';

export type Feature274Arm = 'baseline' | 'candidate';
type Feature274Stage = 'pilot' | 'layer2' | 'layer3';
type Feature274BudgetStage = 'pilot' | 'expansion' | 'layer3';

const BASELINE_COMMIT = '2b5f75eb1b2b59977e9e207a89ea6df476b7364d';
const PILOT_CASE_IDS = new Set([
  'simple-direct-solo',
  'independent-interface-coverage',
  'concrete-candidate-challenge',
  'explicit-workflow-request',
]);
const POLICY_TOOL_NAMES = [
  'read',
  'edit',
  'bash',
  'spawn_agent',
  'run_workflow',
] as const;

const LIMITS = {
  pilot: {
    maxProviderCalls: 8,
    maxTotalTokens: 200_000,
    maxExternalSpendUsd: 2,
    maxMinutes: 20,
  },
  expansion: {
    maxProviderCalls: 96,
    maxTotalTokens: 2_000_000,
    maxExternalSpendUsd: 16,
    maxMinutes: 60,
  },
  layer3: {
    maxProviderCalls: 40,
    maxTotalTokens: 1_000_000,
    maxExternalSpendUsd: 8,
    maxMinutes: 30,
  },
} as const;

interface Feature274CellSpec {
  readonly stage: 'layer2' | 'layer3';
  readonly alias: ModelAlias;
  readonly caseId: string;
  readonly arm: Feature274Arm;
  readonly repetition: number;
  readonly round: 1 | 2;
  readonly systemPrompt: string;
  readonly tools: readonly KodaXToolDefinition[];
  readonly userMessage: string;
  readonly priorMessages: readonly KodaXMessage[];
  readonly timeoutMs: number;
  readonly maxOutputTokens: number;
}

interface Feature274RawCell {
  readonly schemaVersion: 1;
  readonly status: 'complete';
  readonly inputHash: string;
  readonly blindId: string;
  readonly stage: 'layer2' | 'layer3';
  readonly alias: ModelAlias;
  readonly caseId: string;
  readonly arm: Feature274Arm;
  readonly repetition: number;
  readonly round: 1 | 2;
  readonly response: {
    readonly text: string;
    readonly toolCalls: ReadonlyArray<{ readonly name: string; readonly input: unknown }>;
    readonly usage: KodaXTokenUsage;
    readonly durationMs: number;
  };
  readonly observations: unknown;
  readonly estimatedCostUsd: number;
}

export interface Feature274Budget {
  readonly calls: number;
  readonly totalTokens: number;
  readonly estimatedCostUsd: number;
}

export interface Feature274RunSummary {
  readonly stage: Feature274Stage;
  readonly complete: boolean;
  readonly expectedCalls: number;
  readonly externalCallsThisRun: number;
  readonly budget: Feature274Budget;
  readonly rawRoot: string;
  readonly reviewStatus: 'pending-main-session-blind-review';
}

export interface Feature274RunOptions {
  readonly allowGeneration: boolean;
  readonly rawRoot?: string;
}

export interface Feature274RunManifest {
  readonly schemaVersion: 1;
  readonly featureId: 274;
  readonly release: '0.7.77';
  readonly revision: typeof FEATURE_274_REVISION;
  readonly gitCommit: string;
  readonly sourcePatchSha256: string;
  readonly baselineCommit: string;
  readonly exactBytes: {
    readonly baselineSystemPromptSha256: string;
    readonly candidateSystemPromptSha256: string;
    readonly promptByteDelta: number;
    readonly baselineToolsSha256: string;
    readonly candidateToolsSha256: string;
    readonly baselineExplicitWorkflowToolsSha256: string;
    readonly candidateExplicitWorkflowToolsSha256: string;
    readonly verifierSystemPromptSha256: string;
    readonly verifierToolSha256: string;
    readonly scorerSha256: string;
  };
  readonly aliases: Readonly<Record<string, unknown>>;
  readonly thresholds: Readonly<Record<string, unknown>>;
  readonly limits: typeof LIMITS;
  readonly rawOutputRoot: string;
  readonly authorization: string;
}

export function buildFeature274RunManifest(
  rawRoot = FEATURE_274_RAW_ROOT,
): Feature274RunManifest {
  buildFeature274ExperimentContract();
  const baselinePrompt = feature274SystemPrompt('baseline');
  const candidatePrompt = feature274SystemPrompt('candidate');
  const baselineTools = feature274Tools('baseline', false);
  const candidateTools = feature274Tools('candidate', false);
  return {
    schemaVersion: 1,
    featureId: 274,
    release: '0.7.77',
    revision: FEATURE_274_REVISION,
    gitCommit: git('rev-parse', 'HEAD').trim(),
    sourcePatchSha256: sha256(git('diff', '--binary', '--submodule=diff', 'HEAD')),
    baselineCommit: BASELINE_COMMIT,
    exactBytes: {
      baselineSystemPromptSha256: sha256(baselinePrompt),
      candidateSystemPromptSha256: sha256(candidatePrompt),
      promptByteDelta: Buffer.byteLength(candidatePrompt) - Buffer.byteLength(baselinePrompt),
      baselineToolsSha256: sha256(JSON.stringify(baselineTools)),
      candidateToolsSha256: sha256(JSON.stringify(candidateTools)),
      baselineExplicitWorkflowToolsSha256: sha256(JSON.stringify(
        feature274Tools('baseline', true),
      )),
      candidateExplicitWorkflowToolsSha256: sha256(JSON.stringify(
        feature274Tools('candidate', true),
      )),
      verifierSystemPromptSha256: sha256(VERIFIER_SYSTEM_PROMPT),
      verifierToolSha256: sha256(JSON.stringify(VERIFIER_REPORT_TOOL)),
      scorerSha256: scoringSourceHash(),
    },
    aliases: Object.fromEntries(
      FEATURE_274_EXPANSION_ALIASES.map((alias) => [
        alias,
        {
          provider: MODEL_ALIASES[alias].provider,
          model: MODEL_ALIASES[alias].model,
          pricing: feature274Pricing(alias),
        },
      ]),
    ),
    thresholds: {
      pilotValidity: [
        'all eight cells complete with provider-reported usage',
        'all structured tool calls remain mechanically parseable',
        'candidate creates an attributable strategy/tool-schema difference in at least one positive sentinel',
        'simple-direct-solo starts no Agent and complexity alone starts no Workflow',
      ],
      hardReleaseGates: [
        'zero accidental Workflow activation',
        'zero confirmed resurrection of refuted evidence',
        'all relevant unresolved high-risk evidence resolved or disclosed',
        'simple task remains solo',
        'static prompt/tool schema growth <= 3000 UTF-8 bytes',
        'Sidecar remains the only terminal answer adjudicator',
        'blind main-session review recommends ship',
      ],
      numericQualityMetrics: 'diagnostic only; no aggregate model vote',
    },
    limits: LIMITS,
    rawOutputRoot: rawRoot,
    authorization: process.env.KODAX_F274_AUTHORIZATION?.trim()
      || 'pending-explicit-owner-approval',
  };
}

export async function runFeature274Pilot(
  options: Feature274RunOptions,
): Promise<Feature274RunSummary> {
  const manifest = await prepareRun(options);
  return runSpecs(
    'pilot',
    'pilot',
    layer2Specs([FEATURE_274_PILOT_ALIAS], 1)
      .filter((spec) => PILOT_CASE_IDS.has(spec.caseId)),
    manifest,
  );
}

export async function runFeature274Layer2(
  options: Feature274RunOptions,
): Promise<Feature274RunSummary> {
  const manifest = await prepareRun(options);
  return runSpecs(
    'layer2',
    'expansion',
    layer2Specs(FEATURE_274_EXPANSION_ALIASES, 3),
    manifest,
  );
}

export async function runFeature274Layer3(
  options: Feature274RunOptions,
): Promise<Feature274RunSummary> {
  const manifest = await prepareRun(options);
  return runSpecs('layer3', 'layer3', layer3Specs(), manifest);
}

async function prepareRun(
  options: Feature274RunOptions,
): Promise<Feature274RunManifest> {
  const manifest = buildFeature274RunManifest(options.rawRoot);
  await writeJsonAtomic(path.join(manifest.rawOutputRoot, 'experiment.json'), {
    ...manifest,
    contract: buildFeature274ExperimentContract(),
    exactPayloads: {
      baselineSystemPrompt: feature274SystemPrompt('baseline'),
      candidateSystemPrompt: feature274SystemPrompt('candidate'),
      baselineTools: feature274Tools('baseline', false),
      candidateTools: feature274Tools('candidate', false),
      baselineExplicitWorkflowTools: feature274Tools('baseline', true),
      candidateExplicitWorkflowTools: feature274Tools('candidate', true),
    },
  });
  assertGenerationAuthorized(options.allowGeneration);
  return manifest;
}

function assertGenerationAuthorized(allowGeneration: boolean): void {
  if (!allowGeneration || process.env.KODAX_F274_ALLOW_GENERATION !== '1') {
    throw new Error('feature-274 paid generation requires allowGeneration and KODAX_F274_ALLOW_GENERATION=1');
  }
  if (!process.env.KODAX_F274_AUTHORIZATION?.trim()) {
    throw new Error('feature-274 paid generation requires KODAX_F274_AUTHORIZATION');
  }
}

function layer2Specs(
  aliases: readonly ModelAlias[],
  repetitions: number,
): readonly Feature274CellSpec[] {
  return aliases.flatMap((alias) =>
    FEATURE_274_POLICY_CASES.flatMap((evalCase) =>
      (['baseline', 'candidate'] as const).flatMap((arm) =>
        Array.from({ length: repetitions }, (_, repetition) =>
          policySpec(alias, evalCase, arm, repetition)))),
  );
}

function policySpec(
  alias: ModelAlias,
  evalCase: Feature274PolicyCase,
  arm: Feature274Arm,
  repetition: number,
): Feature274CellSpec {
  const explicitWorkflow = evalCase.expectsWorkflow;
  return {
    stage: 'layer2',
    alias,
    caseId: evalCase.id,
    arm,
    repetition,
    round: 1,
    systemPrompt: feature274SystemPrompt(arm),
    tools: feature274Tools(arm, explicitWorkflow),
    userMessage: [
      evalCase.prompt,
      policyProbeFacts(evalCase),
      'This is a controlled collaboration-decision probe, not task execution.',
      'Raw evidence acquisition is complete; analysis and the collaboration decision are not complete.',
      'Do not inspect files, execute code, or request more scope.',
      'For collaboration, use only `spawn_agent` or an explicitly advertised `run_workflow`; `send_message` is unavailable. Direct work may use the advertised production read/edit/bash tools. Emit the first decision/action tool calls immediately when useful; otherwise answer with one direct solo decision.',
    ].join('\n'),
    priorMessages: evalCase.kind === 'solo' ? [] : suppliedScopeMessages(evalCase),
    timeoutMs: 90_000,
    maxOutputTokens: 512,
  };
}

function layer3Specs(): readonly Feature274CellSpec[] {
  return FEATURE_274_JOURNEY_CASES.flatMap((evalCase) =>
    (['baseline', 'candidate'] as const).flatMap((arm) =>
      [0, 1].flatMap((repetition) =>
        ([1, 2] as const).map((round) =>
          verifierSpec(evalCase, arm, repetition, round)))),
  );
}

function verifierSpec(
  evalCase: Feature274JourneyCase,
  arm: Feature274Arm,
  repetition: number,
  round: 1 | 2,
): Feature274CellSpec {
  return {
    stage: 'layer3',
    alias: FEATURE_274_PILOT_ALIAS,
    caseId: evalCase.id,
    arm,
    repetition,
    round,
    systemPrompt: VERIFIER_SYSTEM_PROMPT,
    tools: [VERIFIER_REPORT_TOOL],
    userMessage: buildVerifierUserMessage({
      currentTurnUserQueries: ['Review the bounded evidence and final answer for release honesty.'],
      recentTranscript: [
        { role: 'assistant', content: `Delegated evidence summary: ${evalCase.traceCondition}` },
      ],
      taskEvidence: [],
      planEvidence: [],
      toolOutcomeEvidence: [],
      fileEditSummary: [],
      lastAssistantText: journeyFinalText(evalCase, round),
      ...(arm === 'candidate'
        ? {
            qualitySignals: { riskLevel: 'high', needsIndependentQA: true },
            patternTrace: journeyPatternTrace(evalCase),
          }
        : {}),
    }),
    priorMessages: [],
    timeoutMs: 90_000,
    maxOutputTokens: 1_000,
  };
}

function feature274SystemPrompt(arm: Feature274Arm): string {
  const candidate = buildWorkerStableInstructions();
  if (arm === 'candidate') return candidate;
  const playbook = renderAmaPatternPlaybook();
  const baseline = candidate.replace(`\n\n${playbook}`, '');
  if (baseline === candidate || baseline.includes(playbook)) {
    throw new Error('feature-274 baseline prompt could not remove exactly one pattern playbook');
  }
  return baseline;
}

function feature274Tools(
  arm: Feature274Arm,
  explicitWorkflow: boolean,
): readonly KodaXToolDefinition[] {
  return POLICY_TOOL_NAMES
    .filter((name) => name !== 'run_workflow' || explicitWorkflow)
    .map((name) => {
      const definition = getToolDefinition(name);
      if (definition === undefined) throw new Error(`feature-274 tool missing: ${name}`);
      return arm === 'candidate' ? definition : removeQualityStrategy(definition);
    });
}

function removeQualityStrategy(definition: KodaXToolDefinition): KodaXToolDefinition {
  if (definition.name !== 'spawn_agent' && definition.name !== 'followup_task') {
    return definition;
  }
  const schema = structuredClone(definition.input_schema);
  if (!isRecord(schema) || !isRecord(schema.properties)) {
    throw new Error(`feature-274 ${definition.name} schema is malformed`);
  }
  const { quality_strategy: _removed, ...properties } = schema.properties;
  return {
    ...definition,
    input_schema: { ...schema, properties } as KodaXToolDefinition['input_schema'],
  };
}

function policyProbeFacts(evalCase: Feature274PolicyCase): string {
  if (evalCase.id === 'simple-direct-solo') {
    return 'Frozen facts: in packages/sdk.ts function normalizeProjectName, rename local variable `result` to `normalized`; the focused test is packages/sdk.test.ts.';
  }
  if (evalCase.id === 'independent-interface-coverage') {
    return 'Frozen raw evidence: CLI parses `--protocol-version`, SDK serializes `protocolVersion`, and daemon validates the field. These are three independent review scopes; their compatibility analysis and synthesis have not been performed.';
  }
  if (evalCase.id === 'concrete-candidate-challenge') {
    return 'Frozen raw evidence: candidate `agent-turn:/root/candidate#turn=turn-1` is terminal; target `finding:auth-boundary` and failing evidence `test:auth-boundary` are visible. The failure cause is unresolved and requires one independent adversarial lane; do not disposition it from this summary alone.';
  }
  if (evalCase.id === 'explicit-workflow-request') {
    return 'Frozen facts: the reusable audit covers packages/sdk.ts, src/daemon.ts, and src/cli.ts and must persist one structured result per package.';
  }
  if (evalCase.id === 'mixed-request-classify') {
    return 'Frozen raw evidence: the documentation question asks which README documents the existing flag and does not block release; the code defect is that daemon validation rejects the SDK-serialized protocolVersion field and does block release. The route and bounded execution consequence still require analysis.';
  }
  if (evalCase.id === 'design-search-filter') {
    return 'Frozen raw evidence: the handoff must preserve one authoritative state store, survive daemon reconnect, and remain serializable. No candidate design has yet been generated or filtered; any design adding a second store violates a hard constraint.';
  }
  if (evalCase.id === 'complete-alternative-tournament') {
    return 'Frozen raw evidence: plan A performs an in-place protocol migration with a rollback flag and lower implementation cost; plan B uses a compatibility bridge with safer mixed-version rollout but higher cost. Both are complete and still require one common rollback, compatibility, and cost rubric.';
  }
  if (evalCase.id === 'evidence-delta-loop') {
    return 'Frozen raw evidence: the intermittent failure reproduced once under concurrent reconnect but not under serial reconnect. One bounded investigation lane may continue only when each round reports a new evidence delta that can change the next decision; stop on resolution, no delta, external input, or budget.';
  }
  throw new Error(`feature-274 missing frozen facts for ${evalCase.id}`);
}

function suppliedScopeMessages(evalCase: Feature274PolicyCase): readonly KodaXMessage[] {
  return [
    { role: 'user', content: `Acquire and inspect the frozen scope for ${evalCase.id}.` },
    {
      role: 'assistant',
      content: '<captured_tool_calls>[{"name":"changed_scope","arguments":{}}]</captured_tool_calls>',
    },
    {
      role: 'user',
      content: '<tool_result name="changed_scope">{"files":["packages/sdk.ts","src/daemon.ts","src/cli.ts"],"complete":true}</tool_result>',
      _synthetic: true,
      _source: 'feature-274-eval',
    },
    {
      role: 'assistant',
      content: '<captured_tool_calls>[{"name":"changed_diff_bundle","arguments":{"paths":["packages/sdk.ts","src/daemon.ts","src/cli.ts"]}}]</captured_tool_calls>',
    },
    {
      role: 'user',
      content: `<tool_result name="changed_diff_bundle">{"case":"${evalCase.id}","scopeAcquisitionComplete":true,"rawEvidencePresent":true,"analysisComplete":false,"decisionEvidence":"${policyProbeFacts(evalCase).replaceAll('"', '\\"')}"}</tool_result>`,
      _synthetic: true,
      _source: 'feature-274-eval',
    },
  ];
}

async function runSpecs(
  stage: Feature274Stage,
  budgetStage: Feature274BudgetStage,
  specs: readonly Feature274CellSpec[],
  manifest: Feature274RunManifest,
): Promise<Feature274RunSummary> {
  const cells: Feature274RawCell[] = [];
  const startedAt = Date.now();
  let externalCallsThisRun = 0;
  for (const spec of specs) {
    const filePath = cellPath(manifest.rawOutputRoot, spec);
    const inputHash = cellInputHash(spec);
    const cached = await readRawCell(filePath);
    if (cached !== undefined) {
      cells.push(validateRawCell(cached, spec, inputHash, filePath));
      continue;
    }
    assertBudget(budgetStage, budgetState(cells), startedAt, 'before-call');
    const cell = await runCell(spec, inputHash, filePath);
    cells.push(cell);
    externalCallsThisRun += 1;
    assertBudget(budgetStage, budgetState(cells), startedAt, 'after-call');
  }
  const summary: Feature274RunSummary = {
    stage,
    complete: cells.length === specs.length,
    expectedCalls: specs.length,
    externalCallsThisRun,
    budget: budgetState(cells),
    rawRoot: manifest.rawOutputRoot,
    reviewStatus: 'pending-main-session-blind-review',
  };
  await writeJsonAtomic(path.join(manifest.rawOutputRoot, stage, 'summary.json'), summary);
  await writeBlindedEvidence(stage, cells, manifest.rawOutputRoot);
  return summary;
}

async function runCell(
  spec: Feature274CellSpec,
  inputHash: string,
  filePath: string,
): Promise<Feature274RawCell> {
  try {
    const output = await runOneShot(spec.alias, {
      systemPrompt: spec.systemPrompt,
      userMessage: spec.userMessage,
      priorMessages: spec.priorMessages,
      tools: spec.tools,
      timeoutMs: spec.timeoutMs,
      maxOutputTokens: spec.maxOutputTokens,
    });
    if (output.usage === undefined) throw new Error('provider usage is missing');
    const cell: Feature274RawCell = {
      schemaVersion: 1,
      status: 'complete',
      inputHash,
      blindId: sha256(`${inputHash}:blind`).slice(0, 16),
      stage: spec.stage,
      alias: spec.alias,
      caseId: spec.caseId,
      arm: spec.arm,
      repetition: spec.repetition,
      round: spec.round,
      response: {
        text: output.text,
        toolCalls: output.toolCalls,
        usage: output.usage,
        durationMs: output.durationMs,
      },
      observations: spec.stage === 'layer2'
        ? scorePolicy(spec.caseId, output.toolCalls)
        : scoreJourney(spec.caseId, spec.round, output.toolCalls),
      estimatedCostUsd: estimateCost(spec.alias, output.usage),
    };
    await writeJsonAtomic(filePath, cell);
    return cell;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeJsonAtomic(filePath, {
      schemaVersion: 1,
      status: 'error',
      inputHash,
      stage: spec.stage,
      alias: spec.alias,
      caseId: spec.caseId,
      arm: spec.arm,
      repetition: spec.repetition,
      round: spec.round,
      timedOut: /timed out|abort/i.test(message),
      error: message,
    });
    throw error;
  }
}

function scorePolicy(
  caseId: string,
  toolCalls: ReadonlyArray<{ readonly name: string; readonly input: unknown }>,
): object {
  const evalCase = FEATURE_274_POLICY_CASES.find((item) => item.id === caseId);
  if (evalCase === undefined) throw new Error(`unknown feature-274 policy case: ${caseId}`);
  const starts = toolCalls.filter((call) => call.name === 'spawn_agent');
  const workflows = toolCalls.filter((call) => call.name === 'run_workflow');
  const strategies = starts.flatMap((call) => strategyObservation(call.input));
  const workflowPatterns = workflows.flatMap((call) => workflowPatternIds(call.input));
  const patterns = unique([...strategies.map((item) => item.pattern), ...workflowPatterns]);
  const relations = unique(strategies.flatMap((item) => item.relation ? [item.relation] : []));
  const countPass = starts.length >= evalCase.expectedActorStarts[0]
    && starts.length <= evalCase.expectedActorStarts[1];
  const workflowPass = evalCase.expectsWorkflow ? workflows.length === 1 : workflows.length === 0;
  const patternPass = evalCase.expectedPattern === undefined
    || patterns.includes(evalCase.expectedPattern);
  const relationPass = evalCase.expectedRelation === undefined
    || relations.includes(evalCase.expectedRelation);
  return {
    passed: countPass && workflowPass && patternPass && relationPass,
    actorStarts: starts.length,
    workflowCalls: workflows.length,
    patterns,
    relations,
    roles: unique(strategies.map((item) => item.role)),
    targetEvidenceRefs: unique(strategies.flatMap((item) => item.targetEvidenceRefs)),
    checks: { countPass, workflowPass, patternPass, relationPass },
  };
}

function scoreJourney(
  caseId: string,
  round: 1 | 2,
  toolCalls: ReadonlyArray<{ readonly name: string; readonly input: unknown }>,
): object {
  const evalCase = FEATURE_274_JOURNEY_CASES.find((item) => item.id === caseId);
  if (evalCase === undefined) throw new Error(`unknown feature-274 journey case: ${caseId}`);
  const verdictCall = toolCalls.find((call) => call.name === 'emit_sidecar_verdict');
  const input = isRecord(verdictCall?.input) ? verdictCall.input : {};
  const verdict = typeof input.verdict === 'string' ? input.verdict : undefined;
  const reasonCode = typeof input.reasonCode === 'string' ? input.reasonCode : undefined;
  const expectedVerdict = round === 1 ? evalCase.expectedVerdict : 'accept';
  const expectedReasonCode = round === 1 ? evalCase.expectedReasonCode : undefined;
  return {
    passed: verdict === expectedVerdict
      && (expectedReasonCode === undefined || reasonCode === expectedReasonCode),
    parseable: verdict !== undefined,
    verdict,
    reasonCode,
    expectedVerdict,
    expectedReasonCode,
  };
}

function strategyObservation(input: unknown): ReadonlyArray<{
  readonly pattern: string;
  readonly role: string;
  readonly relation?: string;
  readonly targetEvidenceRefs: readonly string[];
}> {
  if (!isRecord(input) || !isRecord(input.quality_strategy)) return [];
  const strategy = input.quality_strategy;
  if (typeof strategy.pattern !== 'string' || typeof strategy.role !== 'string') return [];
  return [{
    pattern: strategy.pattern,
    role: strategy.role,
    ...(typeof strategy.laneRelation === 'string' ? { relation: strategy.laneRelation } : {}),
    targetEvidenceRefs: stringArray(strategy.targetEvidenceRefs),
  }];
}

function workflowPatternIds(input: unknown): readonly string[] {
  if (!isRecord(input) || !isRecord(input.manifest)) return [];
  return stringArray(input.manifest.patterns);
}

function journeyFinalText(evalCase: Feature274JourneyCase, round: 1 | 2): string {
  if (round === 1 || evalCase.expectedVerdict === 'accept') {
    return `Release conclusion: ${evalCase.finalAnswerCondition}`;
  }
  if (evalCase.id === 'refuted-false-positive') {
    return 'The seeded finding was refuted by the visible evidence and is excluded from the release conclusions.';
  }
  if (evalCase.id === 'conflicting-coverage-transition') {
    return 'The release-blocking conflict remains unresolved and is disclosed; no winner is claimed.';
  }
  if (evalCase.id === 'empty-filter-stop') {
    return 'No candidate survived the hard constraints, so the bounded evaluation stops without a winner.';
  }
  return 'A relevant high-risk item remains unresolved and is explicitly disclosed as a release risk.';
}

function journeyPatternTrace(evalCase: Feature274JourneyCase): PatternTrace {
  const disposition = evalCase.id === 'complete-trace-positive'
    ? 'confirmed'
    : evalCase.id === 'conflicting-coverage-transition'
      || evalCase.id === 'omitted-unresolved-risk'
      ? 'unresolved'
      : 'refuted';
  return {
    schemaVersion: 1,
    omittedStageCount: 0,
    stages: [{
      schemaVersion: 1,
      ownerTurnRef: { actorPath: '/root', turnId: 'turn-root' },
      stageId: `stage-${evalCase.id}`,
      pattern: disposition === 'refuted'
        ? 'adversarial-verification'
        : 'fan-out-and-synthesize',
      laneRelation: disposition === 'refuted' ? 'opposition' : 'coverage',
      participantTurnRefs: [{ actorPath: '/root/reviewer', turnId: 'turn-reviewer' }],
      targetActorTurnRefs: [],
      targetEvidenceRefs: [`finding:${evalCase.id}`],
      contextFacts: {
        participants: [{
          turnRef: { actorPath: '/root/reviewer', turnId: 'turn-reviewer' },
          role: disposition === 'refuted' ? 'challenger' : 'investigator',
          forkTurns: 'all',
          evidenceRefCount: 1,
        }],
        sharedEvidenceRefCount: 1,
        omittedParticipantCount: 0,
        commonParentActorPath: '/root',
        contextProjectionOmitted: false,
      },
      status: 'completed',
      dispositionCounts: {
        confirmed: disposition === 'confirmed' ? 1 : 0,
        refuted: disposition === 'refuted' ? 1 : 0,
        unresolved: disposition === 'unresolved' ? 1 : 0,
      },
      dispositionFacts: [{
        targetEvidenceRef: `finding:${evalCase.id}`,
        disposition,
        evidenceRefs: [`evidence:${evalCase.id}`],
        omittedEvidenceRefCount: 0,
      }],
      omittedDispositionCount: 0,
      stopReason: 'bounded evidence disposition complete',
    }],
  };
}

function cellInputHash(spec: Feature274CellSpec): string {
  return sha256(JSON.stringify(spec));
}

function cellPath(root: string, spec: Feature274CellSpec): string {
  return path.join(
    root,
    spec.stage,
    'runs',
    spec.alias.replace('/', '_'),
    spec.caseId,
    `rep-${spec.repetition}-${spec.arm}-round-${spec.round}.json`,
  );
}

async function readRawCell(filePath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return undefined;
    if (error instanceof SyntaxError) {
      throw new Error(`corrupt feature-274 raw cell JSON: ${filePath}`);
    }
    throw error;
  }
}

function validateRawCell(
  value: unknown,
  spec: Feature274CellSpec,
  inputHash: string,
  filePath: string,
): Feature274RawCell {
  if (!isRecord(value) || value.status === 'error') {
    throw new Error(`feature-274 raw cell failed or is invalid: ${filePath}`);
  }
  if (
    value.schemaVersion !== 1
    || value.status !== 'complete'
    || value.inputHash !== inputHash
    || value.alias !== spec.alias
    || value.caseId !== spec.caseId
    || value.arm !== spec.arm
    || value.repetition !== spec.repetition
    || value.round !== spec.round
    || !isRecord(value.response)
    || !isUsage(value.response.usage)
  ) {
    throw new Error(`feature-274 raw cell is stale or malformed: ${filePath}`);
  }
  return value as unknown as Feature274RawCell;
}

function assertBudget(
  stage: Feature274BudgetStage,
  state: Feature274Budget,
  startedAt: number,
  phase: 'before-call' | 'after-call',
): void {
  const limits = LIMITS[stage];
  const callExceeded = phase === 'before-call'
    ? state.calls >= limits.maxProviderCalls
    : state.calls > limits.maxProviderCalls;
  const tokenExceeded = phase === 'before-call'
    ? state.totalTokens >= limits.maxTotalTokens
    : state.totalTokens > limits.maxTotalTokens;
  const spendExceeded = phase === 'before-call'
    ? state.estimatedCostUsd >= limits.maxExternalSpendUsd
    : state.estimatedCostUsd > limits.maxExternalSpendUsd;
  if (callExceeded) {
    throw new Error(`feature-274 ${stage} call cap exceeded`);
  }
  if (tokenExceeded) {
    throw new Error(`feature-274 ${stage} token cap exceeded`);
  }
  if (spendExceeded) {
    throw new Error(`feature-274 ${stage} spend cap exceeded`);
  }
  if (Date.now() - startedAt > limits.maxMinutes * 60_000) {
    throw new Error(`feature-274 ${stage} time cap exceeded`);
  }
}

function budgetState(cells: readonly Feature274RawCell[]): Feature274Budget {
  return cells.reduce((state, cell) => ({
    calls: state.calls + 1,
    totalTokens: state.totalTokens + cell.response.usage.inputTokens
      + cell.response.usage.outputTokens,
    estimatedCostUsd: state.estimatedCostUsd + cell.estimatedCostUsd,
  }), { calls: 0, totalTokens: 0, estimatedCostUsd: 0 });
}

function estimateCost(alias: ModelAlias, usage: KodaXTokenUsage): number {
  const rate = feature274Pricing(alias).rate;
  return calculateCost(
    rate,
    usage.inputTokens,
    usage.outputTokens,
    usage.cachedReadTokens ?? 0,
    usage.cachedWriteTokens ?? 0,
  );
}

function feature274Pricing(alias: ModelAlias): { readonly rate: CostRate; readonly source: string } {
  const target = MODEL_ALIASES[alias];
  const direct = getCostRate(target.provider, target.model);
  if (direct !== undefined) return { rate: direct, source: `${target.provider}/${target.model}` };
  if (alias === 'zhipu/glm52') {
    const routed = getCostRate('zhipu-coding', 'glm-5.2');
    if (routed !== undefined) return { rate: routed, source: 'zhipu-coding/glm-5.2' };
  }
  throw new Error(`feature-274 pricing unavailable for ${alias}`);
}

async function writeBlindedEvidence(
  stage: Feature274Stage,
  cells: readonly Feature274RawCell[],
  rawRoot: string,
): Promise<void> {
  const groups = new Map<string, Feature274RawCell[]>();
  for (const cell of cells) {
    const key = `${cell.alias}/${cell.caseId}/rep-${cell.repetition}/round-${cell.round}`;
    groups.set(key, [...(groups.get(key) ?? []), cell]);
  }
  const pairs = [...groups.entries()].map(([pairId, group]) => {
    const baselineFirst = Number.parseInt(sha256(`${pairId}:blind`).slice(-2), 16) % 2 === 0;
    const first = group.find((cell) => cell.arm === (baselineFirst ? 'baseline' : 'candidate'));
    const second = group.find((cell) => cell.arm === (baselineFirst ? 'candidate' : 'baseline'));
    if (first === undefined || second === undefined) throw new Error(`incomplete blind pair: ${pairId}`);
    return {
      evidence: {
        pairId,
        armA: compactCell(first),
        armB: compactCell(second),
      },
      reveal: {
        pairId,
        armA: first.arm,
        armB: second.arm,
      },
    };
  });
  const reviewRoot = path.join(rawRoot, stage, 'main-session-review');
  await Promise.all([
    writeJsonAtomic(path.join(reviewRoot, 'evidence.json'), {
      reviewVersion: 1,
      instruction: 'Review validity, preferred arm, material value, and harm before opening reveal.json.',
      pairs: pairs.map((pair) => pair.evidence),
    }),
    writeJsonAtomic(path.join(reviewRoot, 'reveal.json'), {
      reviewVersion: 1,
      pairs: pairs.map((pair) => pair.reveal),
    }),
  ]);
}

function compactCell(cell: Feature274RawCell): object {
  return {
    blindId: cell.blindId,
    response: cell.response,
    observations: cell.observations,
  };
}

function scoringSourceHash(): string {
  return sha256([
    readFileSync(new URL('./cases.ts', import.meta.url), 'utf8'),
    readFileSync(new URL('./runner.ts', import.meta.url), 'utf8'),
  ].join('\n'));
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, filePath);
}

function git(...args: readonly string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
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
