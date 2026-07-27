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
import type {
  MemoryInterventionTrigger,
  MemoryRecallCandidate,
  MemoryRecallRunnerInput,
} from '@kodax-ai/agent/experimental-memory';
import { renderMemoryEvidenceEnvelope } from '@kodax-ai/agent/experimental-memory';
import type { ModelAlias } from '../../harness/aliases.js';
import { MODEL_ALIASES } from '../../harness/aliases.js';
import { runOneShot } from '../../harness/harness.js';
import {
  MEMORY_INTERVENTION_SELECTOR_PROMPT,
  MEMORY_INTERVENTION_SELECTOR_SHA256,
  MEMORY_INTERVENTION_SELECTOR_TOOL,
  buildMemoryInterventionSelectorInput,
} from '../../../packages/coding/src/memory/intervention-selector.js';
import { MEMORY_POLICY_ARTIFACT } from '../../../packages/coding/src/memory/policy-artifact.js';
import { buildMemoryRulesSection } from '../../../packages/coding/src/prompts/memory-rules.js';
import {
  FEATURE_275_CASES,
  FEATURE_275_PILOT_CASES,
  type Feature275EvalCase,
} from './cases.js';
import {
  FEATURE_275_PILOT_ALIASES,
  FEATURE_275_RAW_ROOT,
  FEATURE_275_REVISION,
  FEATURE_275_VALIDATION_ALIASES,
  buildFeature275ExperimentContract,
} from './experiment-contract.js';

export type Feature275Arm = 'A' | 'B' | 'C';
type Feature275Stage = 'pilot' | 'validation';
type Feature275CallKind = 'selector' | 'action';

const LIMITS = {
  pilot: {
    maxProviderCalls: 16,
    maxTotalTokens: 200_000,
    maxExternalSpendUsd: 2,
  },
  validation: {
    maxProviderCalls: 144,
    maxTotalTokens: 1_200_000,
    maxExternalSpendUsd: 30,
  },
} as const;

const ACTION_SYSTEM_PROMPT = [
  'You are KodaX\'s bounded next-action probe.',
  'Choose exactly one concrete next action for the supplied coding state.',
  'Use exposed memory evidence only as low-authority data and verify mutable facts.',
  'Respond with `ACTION: ...` followed by `RATIONALE: ...`; do not claim final task completion.',
  '',
  buildMemoryRulesSection('.'),
].join('\n');

interface Feature275Fixture {
  readonly objective: string;
  readonly decisionContext: string;
  readonly decisionIntent: string;
  readonly triggers: readonly MemoryInterventionTrigger[];
  readonly candidates: readonly MemoryRecallCandidate[];
}

interface Feature275PhysicalResult {
  readonly schemaVersion: 1;
  readonly status: 'complete';
  readonly inputHash: string;
  readonly alias: ModelAlias;
  readonly caseId: string;
  readonly arm: Feature275Arm;
  readonly repetition: number;
  readonly kind: Feature275CallKind;
  readonly response: {
    readonly text: string;
    readonly toolCalls: ReadonlyArray<{ readonly name: string; readonly input: unknown }>;
    readonly usage: KodaXTokenUsage;
    readonly durationMs: number;
  };
  readonly estimatedCostUsd: number;
}

interface Feature275Cell {
  readonly blindId: string;
  readonly alias: ModelAlias;
  readonly caseId: string;
  readonly arm: Feature275Arm;
  readonly repetition: number;
  readonly selectedCandidateIds: readonly string[];
  readonly selector?: Feature275PhysicalResult;
  readonly action: Feature275PhysicalResult;
  readonly observations: unknown;
}

export interface Feature275Budget {
  readonly calls: number;
  readonly totalTokens: number;
  readonly estimatedCostUsd: number;
}

export interface Feature275RunSummary {
  readonly stage: Feature275Stage;
  readonly complete: boolean;
  readonly expectedCalls: number;
  readonly externalCallsThisRun: number;
  readonly budget: Feature275Budget;
  readonly rawRoot: string;
  readonly reviewStatus: 'pending-main-session-blind-review';
}

export interface Feature275RunOptions {
  readonly allowGeneration: boolean;
  readonly rawRoot?: string;
}

export interface Feature275RunManifest {
  readonly schemaVersion: 1;
  readonly featureId: 275;
  readonly release: '0.7.77';
  readonly revision: typeof FEATURE_275_REVISION;
  readonly gitCommit: string;
  readonly sourcePatchSha256: string;
  readonly exactBytes: {
    readonly actionSystemPromptSha256: string;
    readonly selectorPromptSha256: string;
    readonly selectorToolSha256: string;
    readonly selectorPolicySha256: string;
    readonly memoryPolicyArtifactSha256: string;
    readonly scorerSha256: string;
  };
  readonly aliases: Readonly<Record<string, unknown>>;
  readonly thresholds: Readonly<Record<string, unknown>>;
  readonly limits: typeof LIMITS;
  readonly rawOutputRoot: string;
  readonly authorization: string;
}

export function buildFeature275RunManifest(
  rawRoot = FEATURE_275_RAW_ROOT,
): Feature275RunManifest {
  buildFeature275ExperimentContract();
  return {
    schemaVersion: 1,
    featureId: 275,
    release: '0.7.77',
    revision: FEATURE_275_REVISION,
    gitCommit: git('rev-parse', 'HEAD').trim(),
    sourcePatchSha256: sha256(git('diff', '--binary', '--submodule=diff', 'HEAD')),
    exactBytes: {
      actionSystemPromptSha256: sha256(ACTION_SYSTEM_PROMPT),
      selectorPromptSha256: sha256(MEMORY_INTERVENTION_SELECTOR_PROMPT),
      selectorToolSha256: sha256(JSON.stringify(MEMORY_INTERVENTION_SELECTOR_TOOL)),
      selectorPolicySha256: MEMORY_INTERVENTION_SELECTOR_SHA256,
      memoryPolicyArtifactSha256: sha256(JSON.stringify(MEMORY_POLICY_ARTIFACT)),
      scorerSha256: scoringSourceHash(),
    },
    aliases: Object.fromEntries(
      uniqueAliases([...FEATURE_275_PILOT_ALIASES, ...FEATURE_275_VALIDATION_ALIASES])
        .map((alias) => [
          alias,
          {
            provider: MODEL_ALIASES[alias].provider,
            model: MODEL_ALIASES[alias].model,
            pricing: feature275Pricing(alias),
          },
        ]),
    ),
    thresholds: {
      deterministicHardGates: [
        'candidate coverage',
        'private and sensitive exclusion',
        'unknown-ID rejection',
        'stale-result discard',
        'source quotas',
        'stable ordering and fingerprints',
      ],
      pilotValidity: [
        'all 16 physical calls complete with provider-reported usage',
        'selector calls are exact-tool parseable',
        'positive case preserves the compatibility constraint',
        'negative control remains silent and reads current authoritative evidence',
        'no invalid or unoffered candidate ID reaches the action suffix',
      ],
      shipmentBoundary: 'deterministic governance may ship; semantic selector remains experimental host opt-in',
      claimBoundary: 'no task-effect/default-on claim without the frozen 144-call validation',
    },
    limits: LIMITS,
    rawOutputRoot: rawRoot,
    authorization: process.env.KODAX_F275_AUTHORIZATION?.trim()
      || 'pending-explicit-owner-approval',
  };
}

export async function runFeature275Pilot(
  options: Feature275RunOptions,
): Promise<Feature275RunSummary> {
  return runFeature275Stage(
    'pilot',
    FEATURE_275_PILOT_ALIASES,
    FEATURE_275_PILOT_CASES,
    1,
    options,
  );
}

export async function runFeature275Validation(
  options: Feature275RunOptions,
): Promise<Feature275RunSummary> {
  return runFeature275Stage(
    'validation',
    FEATURE_275_VALIDATION_ALIASES,
    FEATURE_275_CASES,
    3,
    options,
  );
}

async function runFeature275Stage(
  stage: Feature275Stage,
  aliases: readonly ModelAlias[],
  cases: readonly Feature275EvalCase[],
  repetitions: number,
  options: Feature275RunOptions,
): Promise<Feature275RunSummary> {
  const manifest = await prepareRun(options);
  const physicalResults: Feature275PhysicalResult[] = [];
  const cells: Feature275Cell[] = [];
  let externalCallsThisRun = 0;
  for (const alias of aliases) {
    for (const evalCase of cases) {
      for (let repetition = 0; repetition < repetitions; repetition += 1) {
        for (const arm of ['A', 'B', 'C'] as const) {
          const fixture = fixtureFor(evalCase);
          let selector: Feature275PhysicalResult | undefined;
          let selectedCandidateIds = arm === 'A'
            ? []
            : [...evalCase.expectedSelectedCandidateIds];
          if (arm === 'C') {
            const selectorResult = await readOrRunSelector(
              stage,
              alias,
              evalCase,
              repetition,
              fixture,
              manifest,
              physicalResults,
            );
            selector = selectorResult.result;
            if (!selectorResult.resumed) externalCallsThisRun += 1;
            physicalResults.push(selector);
            selectedCandidateIds = uniqueStrings([
              ...selectedCandidateIds,
              ...parseSelectorSelection(selector, fixture.candidates),
            ]).slice(0, 3);
          }
          const actionResult = await readOrRunAction(
            stage,
            alias,
            evalCase,
            arm,
            repetition,
            fixture,
            selectedCandidateIds,
            manifest,
            physicalResults,
          );
          if (!actionResult.resumed) externalCallsThisRun += 1;
          physicalResults.push(actionResult.result);
          cells.push({
            blindId: sha256([
              alias,
              evalCase.id,
              arm,
              String(repetition),
            ].join('\0')).slice(0, 16),
            alias,
            caseId: evalCase.id,
            arm,
            repetition,
            selectedCandidateIds,
            ...(selector !== undefined ? { selector } : {}),
            action: actionResult.result,
            observations: scoreCell(
              evalCase,
              arm,
              selectedCandidateIds,
              selector,
              actionResult.result.response.text,
            ),
          });
        }
      }
    }
  }
  const expectedCalls = aliases.length * cases.length * repetitions * 4;
  const summary: Feature275RunSummary = {
    stage,
    complete: physicalResults.length === expectedCalls,
    expectedCalls,
    externalCallsThisRun,
    budget: budgetState(physicalResults),
    rawRoot: manifest.rawOutputRoot,
    reviewStatus: 'pending-main-session-blind-review',
  };
  await writeJsonAtomic(path.join(manifest.rawOutputRoot, stage, 'summary.json'), summary);
  await writeBlindedEvidence(stage, cells, manifest.rawOutputRoot);
  return summary;
}

async function prepareRun(options: Feature275RunOptions): Promise<Feature275RunManifest> {
  const manifest = buildFeature275RunManifest(options.rawRoot);
  await writeJsonAtomic(path.join(manifest.rawOutputRoot, 'experiment.json'), {
    ...manifest,
    contract: buildFeature275ExperimentContract(),
    exactPayloads: {
      actionSystemPrompt: ACTION_SYSTEM_PROMPT,
      selectorSystemPrompt: MEMORY_INTERVENTION_SELECTOR_PROMPT,
      selectorTool: MEMORY_INTERVENTION_SELECTOR_TOOL,
      memoryPolicyArtifact: MEMORY_POLICY_ARTIFACT,
    },
  });
  if (!options.allowGeneration || process.env.KODAX_F275_ALLOW_GENERATION !== '1') {
    throw new Error('feature-275 paid generation requires allowGeneration and KODAX_F275_ALLOW_GENERATION=1');
  }
  if (!process.env.KODAX_F275_AUTHORIZATION?.trim()) {
    throw new Error('feature-275 paid generation requires KODAX_F275_AUTHORIZATION');
  }
  return manifest;
}

async function readOrRunSelector(
  stage: Feature275Stage,
  alias: ModelAlias,
  evalCase: Feature275EvalCase,
  repetition: number,
  fixture: Feature275Fixture,
  manifest: Feature275RunManifest,
  prior: readonly Feature275PhysicalResult[],
): Promise<{ readonly result: Feature275PhysicalResult; readonly resumed: boolean }> {
  const aliased = fixture.candidates.map((candidate, index) => ({
    ...candidate,
    refId: `candidate:${index + 1}`,
    evidenceRefs: [],
  }));
  const input: MemoryRecallRunnerInput = {
    objective: fixture.objective,
    decisionContext: fixture.decisionContext,
    decisionIntent: fixture.decisionIntent,
    triggers: fixture.triggers,
    candidates: fixture.candidates,
    signal: new AbortController().signal,
  };
  return readOrRunPhysical({
    stage,
    alias,
    evalCase,
    arm: 'C',
    repetition,
    kind: 'selector',
    systemPrompt: MEMORY_INTERVENTION_SELECTOR_PROMPT,
    userMessage: buildMemoryInterventionSelectorInput(input, aliased),
    tools: [MEMORY_INTERVENTION_SELECTOR_TOOL],
    timeoutMs: 5_000,
    maxOutputTokens: 256,
    manifest,
    prior,
  });
}

async function readOrRunAction(
  stage: Feature275Stage,
  alias: ModelAlias,
  evalCase: Feature275EvalCase,
  arm: Feature275Arm,
  repetition: number,
  fixture: Feature275Fixture,
  selectedCandidateIds: readonly string[],
  manifest: Feature275RunManifest,
  prior: readonly Feature275PhysicalResult[],
): Promise<{ readonly result: Feature275PhysicalResult; readonly resumed: boolean }> {
  const selected = selectedCandidateIds
    .map((id) => fixture.candidates.find((candidate) => candidate.refId === id))
    .filter((candidate): candidate is MemoryRecallCandidate => candidate !== undefined);
  const suffix = selected.length === 0
    ? undefined
    : renderMemoryEvidenceEnvelope(
        selected.map((candidate) => candidate.claim).join('\n'),
        selected.map((candidate) => candidate.refId),
      );
  return readOrRunPhysical({
    stage,
    alias,
    evalCase,
    arm,
    repetition,
    kind: 'action',
    systemPrompt: ACTION_SYSTEM_PROMPT,
    userMessage: [
      `Objective: ${fixture.objective}`,
      `Current state: ${fixture.decisionContext}`,
      `Task: ${evalCase.actionTask}`,
    ].join('\n'),
    tools: [],
    ...(suffix !== undefined ? { ephemeralSuffix: suffix } : {}),
    timeoutMs: 90_000,
    maxOutputTokens: 512,
    manifest,
    prior,
  });
}

interface PhysicalCallSpec {
  readonly stage: Feature275Stage;
  readonly alias: ModelAlias;
  readonly evalCase: Feature275EvalCase;
  readonly arm: Feature275Arm;
  readonly repetition: number;
  readonly kind: Feature275CallKind;
  readonly systemPrompt: string;
  readonly userMessage: string;
  readonly tools: readonly typeof MEMORY_INTERVENTION_SELECTOR_TOOL[];
  readonly ephemeralSuffix?: string;
  readonly timeoutMs: number;
  readonly maxOutputTokens: number;
  readonly manifest: Feature275RunManifest;
  readonly prior: readonly Feature275PhysicalResult[];
}

async function readOrRunPhysical(
  spec: PhysicalCallSpec,
): Promise<{ readonly result: Feature275PhysicalResult; readonly resumed: boolean }> {
  const inputHash = sha256(JSON.stringify({
    alias: spec.alias,
    caseId: spec.evalCase.id,
    arm: spec.arm,
    repetition: spec.repetition,
    kind: spec.kind,
    systemPrompt: spec.systemPrompt,
    userMessage: spec.userMessage,
    tools: spec.tools,
    ephemeralSuffix: spec.ephemeralSuffix,
  }));
  const filePath = path.join(
    spec.manifest.rawOutputRoot,
    spec.stage,
    'runs',
    spec.alias.replace('/', '_'),
    spec.evalCase.id,
    `rep-${spec.repetition}-${spec.arm}-${spec.kind}.json`,
  );
  const cached = await readPhysical(filePath);
  if (cached !== undefined) {
    return {
      result: validatePhysical(cached, spec, inputHash, filePath),
      resumed: true,
    };
  }
  assertBudget(spec.stage, budgetState(spec.prior), 'before-call');
  try {
    const output = await runOneShot(spec.alias, {
      systemPrompt: spec.systemPrompt,
      userMessage: spec.userMessage,
      tools: spec.tools,
      ...(spec.ephemeralSuffix !== undefined
        ? { ephemeralSuffix: { content: spec.ephemeralSuffix } }
        : {}),
      timeoutMs: spec.timeoutMs,
      maxOutputTokens: spec.maxOutputTokens,
    });
    if (output.usage === undefined) throw new Error('provider usage is missing');
    const result: Feature275PhysicalResult = {
      schemaVersion: 1,
      status: 'complete',
      inputHash,
      alias: spec.alias,
      caseId: spec.evalCase.id,
      arm: spec.arm,
      repetition: spec.repetition,
      kind: spec.kind,
      response: {
        text: output.text,
        toolCalls: output.toolCalls,
        usage: output.usage,
        durationMs: output.durationMs,
      },
      estimatedCostUsd: estimateCost(spec.alias, output.usage),
    };
    assertBudget(spec.stage, budgetState([...spec.prior, result]), 'after-call');
    await writeJsonAtomic(filePath, result);
    return { result, resumed: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeJsonAtomic(filePath, {
      schemaVersion: 1,
      status: 'error',
      inputHash,
      alias: spec.alias,
      caseId: spec.evalCase.id,
      arm: spec.arm,
      repetition: spec.repetition,
      kind: spec.kind,
      timedOut: /timed out|abort/i.test(message),
      error: message,
    });
    throw error;
  }
}

function fixtureFor(evalCase: Feature275EvalCase): Feature275Fixture {
  if (evalCase.kind === 'post_compaction') {
    return {
      objective: 'Complete the Runtime bridge without breaking SDK compatibility.',
      decisionContext: 'Compaction committed. The Runtime bridge integration step is still open.',
      decisionIntent: 'continue-runtime-integration',
      triggers: ['context_compacted'],
      candidates: [
        {
          refId: 'current:objective',
          claim: 'Required constraint: preserve the existing SDK and daemon protocol compatibility while completing the Runtime bridge.',
          claimKind: 'objective',
          source: 'current',
        },
        {
          refId: 'current:todo:integration',
          claim: 'Open integration step: update the Runtime bridge and run its focused compatibility tests.',
          claimKind: 'todo',
          source: 'current',
        },
      ],
    };
  }
  if (evalCase.kind === 'irrelevant_control') {
    return {
      objective: 'Read the current package version from the workspace.',
      decisionContext: 'The workspace package.json is authoritative.',
      decisionIntent: 'read-current-package-version',
      triggers: ['tool_failure'],
      candidates: [
        {
          refId: 'memdir:old-release-format',
          claim: 'An old release used a legacy version-file format that may no longer exist.',
          claimKind: 'procedure',
          source: 'durable',
        },
        {
          refId: 'current:objective',
          claim: 'Current objective: read the package version.',
          claimKind: 'objective',
          source: 'current',
        },
      ],
    };
  }
  if (evalCase.kind === 'failed_tool') {
    return {
      objective: 'Recover from the failed focused test.',
      decisionContext: 'The same test command failed because generated fixtures were not prepared.',
      decisionIntent: 'failed-test-precondition',
      triggers: ['tool_failure'],
      candidates: [
        {
          refId: 'observation:tool-outcome:failed-test',
          claim: 'The test requires generated fixtures; prepare them before rerunning the unchanged command.',
          claimKind: 'outcome',
          source: 'session',
        },
        {
          refId: 'current:objective',
          claim: 'Current objective: make the focused regression pass.',
          claimKind: 'objective',
          source: 'current',
        },
      ],
    };
  }
  return {
    objective: 'Recover from repeated equivalent diagnostic failures.',
    decisionContext: 'Two equivalent attempts failed for the same stable reason.',
    decisionIntent: 'repeated-failure-recovery',
    triggers: ['verification_failure'],
    candidates: [
      {
        refId: 'observation:tool-outcome:repeated-failure',
        claim: 'Two unchanged attempts failed with the same stable error.',
        claimKind: 'outcome',
        source: 'session',
      },
      {
        refId: 'memdir:verified-recovery-order',
        claim: 'Verified recovery order: inspect the generated configuration, repair its source input, then rerun once.',
        claimKind: 'procedure',
        source: 'durable',
      },
    ],
  };
}

function parseSelectorSelection(
  selector: Feature275PhysicalResult,
  candidates: readonly MemoryRecallCandidate[],
): readonly string[] {
  const call = selector.response.toolCalls.find(
    (candidate) => candidate.name === MEMORY_INTERVENTION_SELECTOR_TOOL.name,
  );
  if (!isRecord(call?.input) || !Array.isArray(call.input.selectedRefIds)) return [];
  const originalByAlias = new Map(
    candidates.map((candidate, index) => [`candidate:${index + 1}`, candidate.refId]),
  );
  return uniqueStrings(call.input.selectedRefIds
    .filter((id): id is string => typeof id === 'string')
    .map((id) => originalByAlias.get(id))
    .filter((id): id is string => id !== undefined))
    .slice(0, 3);
}

function scoreCell(
  evalCase: Feature275EvalCase,
  arm: Feature275Arm,
  selectedCandidateIds: readonly string[],
  selector: Feature275PhysicalResult | undefined,
  actionText: string,
): object {
  const selectorCall = selector?.response.toolCalls.find(
    (call) => call.name === MEMORY_INTERVENTION_SELECTOR_TOOL.name,
  );
  const selectorParseable = selector === undefined || isRecord(selectorCall?.input)
    && Array.isArray(selectorCall.input.selectedRefIds)
    && selectorCall.input.selectedRefIds.every((id) => typeof id === 'string');
  const expectedIds = arm === 'A' ? [] : evalCase.expectedSelectedCandidateIds;
  const expected = new Set(expectedIds);
  const selected = new Set(selectedCandidateIds);
  const selectionPass = expected.size === selected.size
    && [...expected].every((id) => selected.has(id));
  const actionPass = actionObservationPass(evalCase, actionText);
  return {
    passed: selectorParseable && selectionPass && actionPass,
    selectorParseable,
    selectedCandidateIds,
    expectedSelectedCandidateIds: expectedIds,
    selectionPass,
    actionPass,
  };
}

function actionObservationPass(evalCase: Feature275EvalCase, text: string): boolean {
  const normalized = text.toLowerCase();
  if (evalCase.kind === 'post_compaction') {
    return /compatib|protocol|sdk/.test(normalized)
      && /bridge|integration|test/.test(normalized);
  }
  if (evalCase.kind === 'irrelevant_control') {
    return /package\.json|package version|current version/.test(normalized)
      && !/old release|legacy version-file|memory/.test(normalized);
  }
  if (evalCase.kind === 'failed_tool') {
    return /fixture|precondition|prepare|generat/.test(normalized)
      && !/rerun (?:the )?unchanged.*first/.test(normalized);
  }
  return /different|inspect|configuration|source input|change/.test(normalized);
}

async function writeBlindedEvidence(
  stage: Feature275Stage,
  cells: readonly Feature275Cell[],
  rawRoot: string,
): Promise<void> {
  const groups = new Map<string, Feature275Cell[]>();
  for (const cell of cells) {
    const key = `${cell.alias}/${cell.caseId}/rep-${cell.repetition}`;
    groups.set(key, [...(groups.get(key) ?? []), cell]);
  }
  const packets = [...groups.entries()].map(([packetId, group]) => {
    const ordered = [...group].sort((left, right) => (
      sha256(`${packetId}:${left.arm}`).localeCompare(sha256(`${packetId}:${right.arm}`))
    ));
    if (ordered.length !== 3) throw new Error(`incomplete feature-275 blind packet: ${packetId}`);
    return {
      evidence: {
        packetId,
        variants: ordered.map((cell, index) => ({
          label: `variant-${index + 1}`,
          selectedCandidateIds: cell.selectedCandidateIds,
          selector: cell.selector?.response,
          action: cell.action.response,
          observations: cell.observations,
        })),
      },
      reveal: {
        packetId,
        variants: ordered.map((cell, index) => ({
          label: `variant-${index + 1}`,
          arm: cell.arm,
        })),
      },
    };
  });
  const reviewRoot = path.join(rawRoot, stage, 'main-session-review');
  await Promise.all([
    writeJsonAtomic(path.join(reviewRoot, 'evidence.json'), {
      reviewVersion: 1,
      instruction: 'Review measurement validity, immediate action quality, false intervention, and harm before opening reveal.json.',
      packets: packets.map((packet) => packet.evidence),
    }),
    writeJsonAtomic(path.join(reviewRoot, 'reveal.json'), {
      reviewVersion: 1,
      packets: packets.map((packet) => packet.reveal),
    }),
  ]);
}

async function readPhysical(filePath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return undefined;
    if (error instanceof SyntaxError) throw new Error(`corrupt feature-275 raw cell: ${filePath}`);
    throw error;
  }
}

function validatePhysical(
  value: unknown,
  spec: PhysicalCallSpec,
  inputHash: string,
  filePath: string,
): Feature275PhysicalResult {
  if (
    !isRecord(value)
    || value.status !== 'complete'
    || value.schemaVersion !== 1
    || value.inputHash !== inputHash
    || value.alias !== spec.alias
    || value.caseId !== spec.evalCase.id
    || value.arm !== spec.arm
    || value.repetition !== spec.repetition
    || value.kind !== spec.kind
    || !isRecord(value.response)
    || !isUsage(value.response.usage)
  ) {
    throw new Error(`feature-275 raw cell failed, stale, or malformed: ${filePath}`);
  }
  return value as unknown as Feature275PhysicalResult;
}

function assertBudget(
  stage: Feature275Stage,
  state: Feature275Budget,
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
  if (callExceeded) throw new Error(`feature-275 ${stage} call cap exceeded`);
  if (tokenExceeded) throw new Error(`feature-275 ${stage} token cap exceeded`);
  if (spendExceeded) throw new Error(`feature-275 ${stage} spend cap exceeded`);
}

function budgetState(results: readonly Feature275PhysicalResult[]): Feature275Budget {
  return results.reduce((state, result) => ({
    calls: state.calls + 1,
    totalTokens: state.totalTokens + result.response.usage.inputTokens
      + result.response.usage.outputTokens,
    estimatedCostUsd: state.estimatedCostUsd + result.estimatedCostUsd,
  }), { calls: 0, totalTokens: 0, estimatedCostUsd: 0 });
}

function estimateCost(alias: ModelAlias, usage: KodaXTokenUsage): number {
  const rate = feature275Pricing(alias).rate;
  return calculateCost(
    rate,
    usage.inputTokens,
    usage.outputTokens,
    usage.cachedReadTokens ?? 0,
    usage.cachedWriteTokens ?? 0,
  );
}

function feature275Pricing(alias: ModelAlias): { readonly rate: CostRate; readonly source: string } {
  const target = MODEL_ALIASES[alias];
  const direct = getCostRate(target.provider, target.model);
  if (direct !== undefined) return { rate: direct, source: `${target.provider}/${target.model}` };
  if (alias === 'zhipu/glm52') {
    const routed = getCostRate('zhipu-coding', 'glm-5.2');
    if (routed !== undefined) return { rate: routed, source: 'zhipu-coding/glm-5.2' };
  }
  throw new Error(`feature-275 pricing unavailable for ${alias}`);
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

function uniqueAliases(values: readonly ModelAlias[]): readonly ModelAlias[] {
  return [...new Set(values)];
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
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
