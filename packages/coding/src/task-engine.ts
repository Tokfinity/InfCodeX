import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runKodaX as runDirectKodaX } from './agent.js';
import {
  createKodaXTaskRunner,
  runOrchestration,
  type KodaXAgentWorkerSpec,
  type OrchestrationRunEvents,
  type OrchestrationRunResult,
} from './orchestration.js';
import { resolveProvider } from './providers/index.js';
import {
  buildFallbackRoutingDecision,
  buildPromptOverlay,
  buildProviderPolicyHintsForDecision,
  createReasoningPlan,
  reasoningModeToDepth,
  resolveReasoningMode,
  type ReasoningPlan,
} from './reasoning.js';
import {
  analyzeChangedScope,
  getRepoOverview,
  renderChangedScope,
  renderRepoOverview,
} from './repo-intelligence/index.js';
import { debugLogRepoIntelligence } from './repo-intelligence/internal.js';
import {
  getImpactEstimate,
  getModuleContext,
  getRepoRoutingSignals,
  renderImpactEstimate,
  renderModuleContext,
} from './repo-intelligence/query.js';
import type {
  KodaXAgentMode,
  KodaXBudgetDisclosureZone,
  KodaXBudgetExtensionRequest,
  KodaXEvents,
  KodaXJsonValue,
  KodaXManagedTaskHarnessTransition,
  KodaXManagedTask,
  KodaXManagedBudgetSnapshot,
  KodaXMemoryStrategy,
  KodaXOptions,
  KodaXRepoRoutingSignals,
  KodaXResult,
  KodaXSessionData,
  KodaXSessionStorage,
  KodaXRuntimeVerificationContract,
  KodaXTaskCapabilityHint,
  KodaXTaskEvidenceArtifact,
  KodaXTaskEvidenceEntry,
  KodaXTaskRole,
  KodaXTaskRoutingDecision,
  KodaXTaskStatus,
  KodaXTaskSurface,
  KodaXTaskToolPolicy,
  KodaXTaskVerificationCriterion,
  KodaXTaskVerificationContract,
  KodaXVerificationScorecard,
} from './types.js';

interface ManagedTaskWorkerSpec extends KodaXAgentWorkerSpec {
  role: KodaXTaskRole;
  toolPolicy?: KodaXTaskToolPolicy;
  memoryStrategy?: KodaXMemoryStrategy;
  budgetSnapshot?: KodaXManagedBudgetSnapshot;
  terminalAuthority?: boolean;
}

interface ManagedTaskShape {
  task: KodaXManagedTask;
  terminalWorkerId: string;
  workers: ManagedTaskWorkerSpec[];
  workspaceDir: string;
  routingPromptOverlay?: string;
  qualityAssuranceMode: ManagedTaskQualityAssuranceMode;
  providerPolicy?: ReasoningPlan['providerPolicy'];
}

interface ManagedTaskRepoIntelligenceSnapshot {
  artifacts: KodaXTaskEvidenceArtifact[];
}

interface ManagedTaskVerdictDirective {
  source: 'contract-review' | 'evaluator' | 'worker';
  status: 'accept' | 'revise' | 'blocked';
  reason?: string;
  followups: string[];
  userFacingText: string;
  artifactPath?: string;
  nextHarness?: KodaXTaskRoutingDecision['harnessProfile'];
}

interface ManagedTaskAdmissionDirective {
  summary?: string;
  scope: string[];
  requiredEvidence: string[];
  reviewFilesOrAreas?: string[];
  evidenceAcquisitionMode?: ManagedEvidenceAcquisitionMode;
  confirmedHarness?: KodaXTaskRoutingDecision['harnessProfile'];
}

interface ManagedTaskContractDirective {
  summary?: string;
  successCriteria: string[];
  requiredEvidence: string[];
  constraints: string[];
}

interface ManagedTaskHandoffDirective {
  status: 'ready' | 'incomplete' | 'blocked';
  summary?: string;
  evidence: string[];
  followup: string[];
  userFacingText: string;
}

interface ManagedTaskRoundExecution {
  workerSet: { terminalWorkerId: string; workers: ManagedTaskWorkerSpec[] };
  workerResults: Map<string, KodaXResult>;
  contractDirectives: Map<string, ManagedTaskContractDirective>;
  orchestrationResult: OrchestrationRunResult<ManagedTaskWorkerSpec, string>;
  workspaceDir: string;
  directive?: ManagedTaskVerdictDirective;
  budgetRequest?: KodaXBudgetExtensionRequest;
  budgetExtensionGranted?: number;
  budgetExtensionReason?: string;
}

type ManagedTaskQualityAssuranceMode = 'required' | 'optional';

interface ManagedTaskBudgetController {
  totalBudget: number;
  reserveBudget: number;
  reserveRemaining: number;
  upgradeReserveBudget: number;
  upgradeReserveRemaining: number;
  plannedRounds: number;
  spentBudget: number;
  currentHarness: KodaXTaskRoutingDecision['harnessProfile'];
  upgradeCeiling?: KodaXTaskRoutingDecision['harnessProfile'];
}

function truncateText(value: string, maxLength = 400): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

type ManagedEvidenceAcquisitionMode = NonNullable<KodaXManagedTask['runtime']>['evidenceAcquisitionMode'];
type ManagedReviewTarget = NonNullable<KodaXTaskRoutingDecision['reviewTarget']>;

interface ManagedToolTelemetry {
  toolOutputTruncated: boolean;
  toolOutputTruncationNotes: string[];
  evidenceAcquisitionMode?: ManagedEvidenceAcquisitionMode;
  consecutiveEvidenceOnlyIterations?: number;
}

interface ManagedPlanningResult {
  plan: ReasoningPlan;
  repoRoutingSignals?: KodaXRepoRoutingSignals;
  rawDecision: KodaXTaskRoutingDecision;
  reviewTarget: ManagedReviewTarget;
  routingOverrideReason?: string;
}

const MANAGED_TASK_CONTRACT_BLOCK = 'kodax-task-contract';
const MANAGED_TASK_CONTRACT_REVIEW_BLOCK = 'kodax-task-contract-review';
const MANAGED_TASK_VERDICT_BLOCK = 'kodax-task-verdict';
const MANAGED_TASK_ADMISSION_BLOCK = 'kodax-task-admission';
const MANAGED_TASK_HANDOFF_BLOCK = 'kodax-task-handoff';
const MANAGED_TASK_BUDGET_REQUEST_BLOCK = 'kodax-budget-request';
const MANAGED_TASK_MAX_REFINEMENT_ROUND_CAP = 12;
const MANAGED_TASK_MIN_REFINEMENT_ROUNDS = 2;
const MANAGED_TASK_ROUTER_MAX_RETRIES = 3;
const EVIDENCE_ONLY_ITERATION_THRESHOLD = 3;
const MANAGED_TASK_BUDGET_BASE: Record<KodaXTaskRoutingDecision['harnessProfile'], number> = {
  H0_DIRECT: 50,
  H1_EXECUTE_EVAL: 100,
  H2_PLAN_EXECUTE_EVAL: 200,
  H3_MULTI_WORKER: 350,
};

function getManagedTaskSurface(options: KodaXOptions): KodaXTaskSurface {
  return options.context?.taskSurface
    ?? (options.context?.providerPolicyHints?.harness === 'project' ? 'project' : 'cli');
}

function getManagedTaskWorkspaceRoot(options: KodaXOptions, surface: KodaXTaskSurface): string {
  if (options.context?.managedTaskWorkspaceDir?.trim()) {
    return path.resolve(options.context.managedTaskWorkspaceDir);
  }

  const cwd = options.context?.executionCwd ?? options.context?.gitRoot ?? process.cwd();
  if (surface === 'project') {
    return path.resolve(cwd, '.agent', 'project', 'managed-tasks');
  }
  return path.resolve(cwd, '.agent', 'managed-tasks');
}

function resolveManagedAgentMode(options: KodaXOptions): KodaXAgentMode {
  return options.agentMode ?? 'ama';
}

function applyAgentModeToPlan(
  plan: ReasoningPlan,
  agentMode: KodaXAgentMode,
): ReasoningPlan {
  if (agentMode !== 'sa') {
    return {
      ...plan,
      promptOverlay: [
        plan.promptOverlay,
        '[Agent Mode: AMA] Adaptive multi-agent harness selection is enabled.',
      ].filter(Boolean).join('\n\n'),
    };
  }

  if (plan.decision.harnessProfile === 'H0_DIRECT') {
    return {
      ...plan,
      promptOverlay: [
        plan.promptOverlay,
        '[Agent Mode: SA] Single-agent execution is pinned for this run.',
      ].filter(Boolean).join('\n\n'),
    };
  }

  return {
    ...plan,
    decision: {
      ...plan.decision,
      harnessProfile: 'H0_DIRECT',
      reason: `${plan.decision.reason} Agent mode SA forced single-agent execution to reduce token usage.`,
      routingNotes: [
        ...(plan.decision.routingNotes ?? []),
        'Agent mode SA disabled adaptive multi-agent role split for this run.',
      ],
    },
    promptOverlay: buildPromptOverlay(
      {
        ...plan.decision,
        harnessProfile: 'H0_DIRECT',
        reason: `${plan.decision.reason} Agent mode SA forced single-agent execution to reduce token usage.`,
        routingNotes: [
          ...(plan.decision.routingNotes ?? []),
          'Agent mode SA disabled adaptive multi-agent role split for this run.',
        ],
      },
      [
        ...(plan.providerPolicy?.routingNotes ?? []),
        '[Agent Mode: SA] Single-agent execution is pinned for this run.',
      ],
      plan.providerPolicy,
    ),
  };
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function inferVerificationRubricFamily(
  verification: KodaXTaskVerificationContract | undefined,
  primaryTask: KodaXTaskRoutingDecision['primaryTask'],
): NonNullable<KodaXTaskVerificationContract['rubricFamily']> | undefined {
  if (verification?.rubricFamily) {
    return verification.rubricFamily;
  }
  if (verification?.capabilityHints?.some((hint) => /agent-browser|playwright/i.test(hint.name))) {
    return 'frontend';
  }
  if (primaryTask === 'review') {
    return 'code-review';
  }
  if (primaryTask === 'bugfix') {
    return 'functionality';
  }
  return 'code-quality';
}

function resolveVerificationCriteria(
  verification: KodaXTaskVerificationContract | undefined,
  primaryTask: KodaXTaskRoutingDecision['primaryTask'],
): KodaXTaskVerificationCriterion[] {
  if (verification?.criteria?.length) {
    return verification.criteria.map((criterion) => ({
      ...criterion,
      threshold: clampNumber(criterion.threshold, 0, 100),
      weight: clampNumber(criterion.weight, 0, 1),
    }));
  }

  const rubricFamily = inferVerificationRubricFamily(verification, primaryTask);
  const requiredEvidence = verification?.requiredEvidence ?? [];
  const requiredChecks = verification?.requiredChecks ?? [];
  if (rubricFamily === 'frontend') {
    return [
      {
        id: 'ui-flow',
        label: 'UI flow verification',
        description: 'Critical browser path completes without visible breakage.',
        threshold: 75,
        weight: 0.4,
        requiredEvidence,
      },
      {
        id: 'console-clean',
        label: 'Console and runtime health',
        description: 'Browser or app runtime should not show blocking errors.',
        threshold: 75,
        weight: 0.25,
        requiredEvidence,
      },
      {
        id: 'check-evidence',
        label: 'Deterministic checks',
        description: 'Required checks or tests must be explicitly reported.',
        threshold: 70,
        weight: 0.35,
        requiredEvidence: [...requiredEvidence, ...requiredChecks],
      },
    ];
  }

  if (rubricFamily === 'code-review') {
    return [
      {
        id: 'finding-accuracy',
        label: 'Finding accuracy',
        description: 'Reported issues should be grounded in concrete evidence.',
        threshold: 80,
        weight: 0.45,
        requiredEvidence,
      },
      {
        id: 'verification',
        label: 'Independent verification',
        description: 'Claims should be independently verified before acceptance.',
        threshold: 75,
        weight: 0.35,
        requiredEvidence: [...requiredEvidence, ...requiredChecks],
      },
      {
        id: 'completeness',
        label: 'Review completeness',
        description: 'High-risk changes should not truncate before the critical findings are delivered.',
        threshold: 70,
        weight: 0.2,
        requiredEvidence,
      },
    ];
  }

  return [
    {
      id: 'functionality',
      label: 'Functional correctness',
      description: 'The requested behavior is implemented and evidenced.',
      threshold: 75,
      weight: 0.5,
      requiredEvidence,
    },
    {
      id: 'checks',
      label: 'Check coverage',
      description: 'Relevant checks and validation evidence are reported.',
      threshold: 70,
      weight: 0.3,
      requiredEvidence: [...requiredEvidence, ...requiredChecks],
    },
    {
      id: 'quality',
      label: 'Quality and safety',
      description: 'The result does not leave obvious correctness or safety gaps behind.',
      threshold: 70,
      weight: 0.2,
      requiredEvidence,
    },
  ];
}

function deriveRuntimeVerificationContract(
  verification: KodaXTaskVerificationContract | undefined,
  options: KodaXOptions,
): KodaXRuntimeVerificationContract | undefined {
  if (verification?.runtime) {
    return verification.runtime;
  }

  if (!verification) {
    return undefined;
  }

  const runtime: KodaXRuntimeVerificationContract = {
    cwd: options.context?.executionCwd ?? options.context?.gitRoot ?? process.cwd(),
    uiFlows: verification.capabilityHints?.some((hint) => /agent-browser|playwright/i.test(hint.name))
      ? ['Open the live app, execute the critical user path, and reject completion on visual or console failure.']
      : undefined,
    apiChecks: verification.requiredChecks?.filter((check) => /api|http|curl|endpoint/i.test(check)),
    dbChecks: verification.requiredChecks?.filter((check) => /\bdb\b|database|sql/i.test(check)),
    fixtures: verification.requiredEvidence?.filter((item) => /fixture|seed|sample/i.test(item)),
  };

  return Object.values(runtime).some((value) => {
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    return Boolean(value);
  }) ? runtime : undefined;
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractRuntimeCommandCandidate(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const suffixMatch = trimmed.match(/^[^:]+:\s*(.+)$/);
  const candidate = suffixMatch?.[1]?.trim() || trimmed;
  return /^(?:npm|pnpm|yarn|bun|npx|node|python|pytest|go\s+test|cargo\s+test|dotnet\s+test|mvn\s+test|gradle\s+test|curl|Invoke-WebRequest|Invoke-RestMethod|agent-browser|sqlite3|psql|mysql)\b/i.test(candidate)
    ? candidate
    : undefined;
}

function buildRuntimeVerificationShellPatterns(
  verification: KodaXTaskVerificationContract | undefined,
): string[] {
  const runtime = verification?.runtime;
  if (!runtime) {
    return [];
  }

  const exactCommands = [
    runtime.startupCommand,
    ...(runtime.apiChecks ?? []),
    ...(runtime.dbChecks ?? []),
  ]
    .map(extractRuntimeCommandCandidate)
    .filter((value): value is string => Boolean(value));
  const patterns = exactCommands.map((command) => `^${escapeRegexLiteral(command)}(?:\\s+.*)?$`);

  if (runtime.baseUrl || (runtime.apiChecks?.length ?? 0) > 0) {
    patterns.push('^(?:curl|Invoke-WebRequest|Invoke-RestMethod)\\b');
  }

  return Array.from(new Set(patterns));
}

function buildRuntimeExecutionGuide(
  verification: KodaXTaskVerificationContract | undefined,
): string | undefined {
  const runtime = verification?.runtime;
  if (!runtime) {
    return undefined;
  }

  const lines = [
    '# Runtime Execution Guide',
    '',
    'Use this guide to drive live verification against the runtime under test.',
    '',
    runtime.cwd ? `- Working directory: ${runtime.cwd}` : undefined,
    runtime.startupCommand ? `- Startup command: ${runtime.startupCommand}` : undefined,
    runtime.readySignal ? `- Ready signal: ${runtime.readySignal}` : undefined,
    runtime.baseUrl ? `- Base URL: ${runtime.baseUrl}` : undefined,
    runtime.env && Object.keys(runtime.env).length > 0
      ? `- Environment keys: ${Object.keys(runtime.env).join(', ')}`
      : undefined,
    '',
    'Execution protocol:',
    runtime.startupCommand
      ? '1. Start or confirm the runtime using the declared startup command before accepting the task.'
      : '1. Confirm the target runtime is available before accepting the task.',
    runtime.readySignal || runtime.baseUrl
      ? '2. Wait until the runtime is ready, using the ready signal or base URL when available.'
      : '2. Confirm runtime readiness using the strongest observable signal you have.',
    runtime.uiFlows?.length
      ? ['3. Execute the declared UI flows:', ...runtime.uiFlows.map((flow, index) => `   ${index + 1}. ${flow}`)].join('\n')
      : '3. Execute the critical user-facing flow when browser verification is required.',
    runtime.apiChecks?.length
      ? ['4. Run the declared API checks:', ...runtime.apiChecks.map((check, index) => `   ${index + 1}. ${check}`)].join('\n')
      : undefined,
    runtime.dbChecks?.length
      ? ['5. Run the declared DB checks:', ...runtime.dbChecks.map((check, index) => `   ${index + 1}. ${check}`)].join('\n')
      : undefined,
    runtime.fixtures?.length
      ? ['6. Account for the declared fixtures:', ...runtime.fixtures.map((fixture, index) => `   ${index + 1}. ${fixture}`)].join('\n')
      : undefined,
    '',
    'Evidence requirements:',
    '- Capture concrete evidence for every hard-threshold criterion before accepting the task.',
    '- Reject completion if the runtime cannot be started, cannot reach readiness, or any declared flow/check fails.',
  ].filter((line): line is string => Boolean(line));

  return `${lines.join('\n')}\n`;
}

const HARNESS_ORDER: KodaXTaskRoutingDecision['harnessProfile'][] = [
  'H0_DIRECT',
  'H1_EXECUTE_EVAL',
  'H2_PLAN_EXECUTE_EVAL',
  'H3_MULTI_WORKER',
];

const HARNESS_UPGRADE_COST: Record<KodaXTaskRoutingDecision['harnessProfile'], number> = {
  H0_DIRECT: 0,
  H1_EXECUTE_EVAL: 16,
  H2_PLAN_EXECUTE_EVAL: 24,
  H3_MULTI_WORKER: 40,
};

function getHarnessRank(harness: KodaXTaskRoutingDecision['harnessProfile']): number {
  return HARNESS_ORDER.indexOf(harness);
}

function isHarnessUpgrade(
  from: KodaXTaskRoutingDecision['harnessProfile'],
  to: KodaXTaskRoutingDecision['harnessProfile'] | undefined,
): to is KodaXTaskRoutingDecision['harnessProfile'] {
  if (!to) {
    return false;
  }
  return getHarnessRank(to) > getHarnessRank(from);
}

function getHarnessUpgradeCost(
  from: KodaXTaskRoutingDecision['harnessProfile'],
  to: KodaXTaskRoutingDecision['harnessProfile'],
): number {
  if (!isHarnessUpgrade(from, to)) {
    return 0;
  }
  return Math.max(8, HARNESS_UPGRADE_COST[to] - HARNESS_UPGRADE_COST[from]);
}

function createManagedBudgetController(
  options: KodaXOptions,
  plan: ReasoningPlan,
  agentMode: KodaXAgentMode,
): ManagedTaskBudgetController {
  if (agentMode !== 'ama' || plan.decision.harnessProfile === 'H0_DIRECT') {
    return {
      totalBudget: MANAGED_TASK_BUDGET_BASE.H0_DIRECT,
      reserveBudget: 0,
      reserveRemaining: 0,
      upgradeReserveBudget: 0,
      upgradeReserveRemaining: 0,
      plannedRounds: 1,
      spentBudget: 0,
      currentHarness: 'H0_DIRECT',
      upgradeCeiling: undefined,
    };
  }

  let totalBudget = MANAGED_TASK_BUDGET_BASE[plan.decision.harnessProfile];
  const primaryTask = String(plan.decision.primaryTask);
  const tokenCount = options.context?.contextTokenSnapshot?.currentTokens ?? 0;
  const longRunning = Boolean(
    options.context?.taskSurface === 'project'
    || options.context?.providerPolicyHints?.longRunning
    || options.context?.longRunning
  );

  if (longRunning) {
    totalBudget = Math.round(totalBudget * 1.25);
  }
  if (
    primaryTask === 'review'
    || primaryTask === 'verify'
    || primaryTask === 'debug'
    || primaryTask === 'investigate'
  ) {
    totalBudget = Math.round(totalBudget * 1.15);
  }
  if (plan.decision.requiresBrainstorm || plan.decision.complexity === 'systemic') {
    totalBudget = Math.round(totalBudget * 1.2);
  }
  if (tokenCount >= 120_000) {
    totalBudget = Math.round(totalBudget * 0.65);
  } else if (tokenCount >= 60_000) {
    totalBudget = Math.round(totalBudget * 0.8);
  }

  totalBudget = clampNumber(totalBudget, 50, 500);
  const reserveBudget = clampNumber(Math.round(totalBudget * 0.2), 0, Math.max(0, totalBudget - 25));
  const hasUpgradePath = isHarnessUpgrade(plan.decision.harnessProfile, plan.decision.upgradeCeiling);
  const upgradeReserveBudget = hasUpgradePath
    ? clampNumber(Math.round(reserveBudget * 0.6), 8, reserveBudget)
    : 0;
  const executableBudget = Math.max(1, totalBudget - reserveBudget);
  const roundDivisor = plan.decision.harnessProfile === 'H3_MULTI_WORKER'
    ? 35
    : plan.decision.harnessProfile === 'H2_PLAN_EXECUTE_EVAL'
      ? 26
      : 30;
  const plannedRounds = clampNumber(
    Math.ceil(executableBudget / roundDivisor),
    MANAGED_TASK_MIN_REFINEMENT_ROUNDS,
    MANAGED_TASK_MAX_REFINEMENT_ROUND_CAP,
  );

  return {
    totalBudget,
    reserveBudget,
    reserveRemaining: reserveBudget,
    upgradeReserveBudget,
    upgradeReserveRemaining: upgradeReserveBudget,
    plannedRounds,
    spentBudget: 0,
    currentHarness: plan.decision.harnessProfile,
    upgradeCeiling: plan.decision.upgradeCeiling,
  };
}

function resolveBudgetZone(
  round: number,
  plannedRounds: number,
  role: KodaXTaskRole,
): KodaXBudgetDisclosureZone {
  const ratio = plannedRounds <= 0 ? 1 : round / plannedRounds;
  const earlyConvergeRole = role === 'admission' || role === 'planner' || role === 'validator' || role === 'evaluator';
  const yellowThreshold = earlyConvergeRole ? 0.5 : 0.6;
  const orangeThreshold = earlyConvergeRole ? 0.78 : 0.85;
  const redThreshold = earlyConvergeRole ? 0.9 : 0.95;

  if (ratio >= redThreshold || round >= plannedRounds) {
    return 'red';
  }
  if (ratio >= orangeThreshold || plannedRounds - round <= 1) {
    return 'orange';
  }
  if (ratio >= yellowThreshold) {
    return 'yellow';
  }
  return 'green';
}

function resolveWorkerIterLimits(
  harness: KodaXTaskRoutingDecision['harnessProfile'],
  role: KodaXTaskRole,
): { soft: number; hard: number } {
  const budgets: Record<KodaXTaskRoutingDecision['harnessProfile'], Partial<Record<KodaXTaskRole, { soft: number; hard: number }>>> = {
    H0_DIRECT: {
      direct: { soft: 18, hard: 24 },
    },
    H1_EXECUTE_EVAL: {
      admission: { soft: 6, hard: 8 },
      generator: { soft: 24, hard: 30 },
      evaluator: { soft: 12, hard: 16 },
    },
    H2_PLAN_EXECUTE_EVAL: {
      admission: { soft: 6, hard: 8 },
      planner: { soft: 8, hard: 12 },
      validator: { soft: 6, hard: 10 },
      generator: { soft: 28, hard: 36 },
      evaluator: { soft: 14, hard: 18 },
    },
    H3_MULTI_WORKER: {
      admission: { soft: 6, hard: 8 },
      lead: { soft: 6, hard: 8 },
      planner: { soft: 10, hard: 14 },
      validator: { soft: 8, hard: 12 },
      worker: { soft: 24, hard: 32 },
      evaluator: { soft: 14, hard: 18 },
    },
  };
  const explicit = budgets[harness][role];
  if (explicit) {
    return explicit;
  }

  if (role === 'validator') {
    return harness === 'H3_MULTI_WORKER' ? { soft: 8, hard: 12 } : { soft: 6, hard: 10 };
  }

  return harness === 'H3_MULTI_WORKER'
    ? { soft: 24, hard: 32 }
    : harness === 'H2_PLAN_EXECUTE_EVAL'
      ? { soft: 28, hard: 36 }
      : harness === 'H1_EXECUTE_EVAL'
        ? { soft: 24, hard: 30 }
        : { soft: 18, hard: 24 };
}

function createBudgetSnapshot(
  controller: ManagedTaskBudgetController,
  harness: KodaXTaskRoutingDecision['harnessProfile'],
  round: number,
  role: KodaXTaskRole | undefined,
  workerId?: string,
): KodaXManagedBudgetSnapshot {
  const zone = resolveBudgetZone(round, controller.plannedRounds, role ?? 'worker');
  const iterLimits = resolveWorkerIterLimits(
    harness,
    role ?? 'worker',
  );
  return {
    totalBudget: controller.totalBudget,
    reserveBudget: controller.reserveBudget,
    reserveRemaining: controller.reserveRemaining,
    upgradeReserveBudget: controller.upgradeReserveBudget,
    upgradeReserveRemaining: controller.upgradeReserveRemaining,
    plannedRounds: controller.plannedRounds,
    currentRound: round,
    spentBudget: controller.spentBudget,
    remainingBudget: Math.max(0, controller.totalBudget - controller.spentBudget),
    workerId,
    role,
    currentHarness: controller.currentHarness || harness,
    upgradeCeiling: controller.upgradeCeiling,
    zone,
    showExactRoundCounter: zone === 'orange' || zone === 'red',
    allowExtensionRequest: zone === 'orange' || zone === 'red',
    mustConverge: zone === 'red',
    softMaxIter: iterLimits.soft,
    hardMaxIter: iterLimits.hard,
  };
}

function formatBudgetAdvisory(snapshot: KodaXManagedBudgetSnapshot | undefined): string | undefined {
  if (!snapshot) {
    return undefined;
  }

  if (snapshot.zone === 'green') {
    return [
      'Budget advisory:',
      '- You are in the normal execution window. Stay focused and avoid unbounded exploration.',
    ].join('\n');
  }

  if (snapshot.zone === 'yellow') {
    return [
      'Budget advisory:',
      '- Begin converging. Reduce branch exploration and organize a completion path.',
    ].join('\n');
  }

  const lines = [
    'Budget advisory:',
    `- Current round: ${snapshot.currentRound}/${snapshot.plannedRounds}`,
    `- Worker iteration budget: target=${snapshot.softMaxIter ?? 'n/a'}, safety-cap=${snapshot.hardMaxIter ?? 'n/a'}`,
    snapshot.zone === 'red'
      ? '- Final completion window: return a complete result, a blocked verdict, or a budget extension request.'
      : '- You are approaching the execution boundary. Do not open new exploration branches.',
  ];

  if (snapshot.allowExtensionRequest) {
    lines.push(
      `- If you are close to completion, append a \`\`\`${MANAGED_TASK_BUDGET_REQUEST_BLOCK}\` block requesting 1-3 additional iterations.`,
      '- Block shape: requested_iters: 1|2|3, reason: <why>, completion_expectation: <what finishes>, confidence_to_finish: <0..1>, fallback_if_denied: <best incomplete result plan>.',
    );
  }

  return lines.join('\n');
}

function resolveManagedMemoryStrategy(
  options: KodaXOptions,
  plan: ReasoningPlan | undefined,
  role: KodaXTaskRole,
  round: number,
  previousDirective?: ManagedTaskVerdictDirective,
): KodaXMemoryStrategy {
  if (previousDirective?.status === 'revise' && previousDirective.nextHarness) {
    return 'reset-handoff';
  }
  if (role === 'planner' || role === 'validator' || role === 'evaluator') {
    return 'reset-handoff';
  }

  const tokenCount = options.context?.contextTokenSnapshot?.currentTokens ?? 0;
  const providerSnapshot = plan?.providerPolicy?.snapshot;
  if (
    providerSnapshot?.sessionSupport === 'stateless'
    || providerSnapshot?.contextFidelity === 'lossy'
    || providerSnapshot?.transport === 'cli-bridge'
  ) {
    return 'reset-handoff';
  }

  if (
    tokenCount >= 120_000
    || (round >= 3 && previousDirective?.status === 'revise')
  ) {
    return 'compact';
  }

  return 'continuous';
}

class ManagedWorkerSessionStorage implements KodaXSessionStorage {
  private sessions = new Map<string, {
    data: KodaXSessionData;
    createdAt: string;
  }>();
  private memoryNotes = new Map<string, string>();

  async save(id: string, data: KodaXSessionData): Promise<void> {
    const existing = this.sessions.get(id);
    this.sessions.set(id, {
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      data: structuredClone(data),
    });
  }

  async load(id: string): Promise<KodaXSessionData | null> {
    return structuredClone(this.sessions.get(id)?.data ?? null);
  }

  async list(_gitRoot?: string): Promise<Array<{ id: string; title: string; msgCount: number }>> {
    return Array.from(this.sessions.entries())
      .map(([id, entry]) => ({
        id,
        title: entry.data.title,
        msgCount: entry.data.messages.length,
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  saveMemoryNote(id: string, note: string): void {
    this.memoryNotes.set(id, note);
  }

  loadMemoryNote(id: string): string | undefined {
    return this.memoryNotes.get(id);
  }

  snapshotMemoryNotes(): Record<string, string> {
    return Object.fromEntries(this.memoryNotes.entries());
  }
}

function buildManagedWorkerMemoryNote(
  task: KodaXManagedTask,
  worker: ManagedTaskWorkerSpec,
  result: KodaXResult | undefined,
  round: number,
): string {
  const latestSummary = truncateText(extractMessageText(result) || result?.lastText || 'No prior worker output captured.', 800);
  const latestFeedbackArtifact = task.evidence.artifacts
    .filter((artifact) => artifact.path.endsWith(`${path.sep}feedback.json`) || artifact.path.endsWith('/feedback.json'))
    .at(-1)?.path;
  const runtimeGuidePath = path.join(task.evidence.workspaceDir, 'runtime-execution.md');
  const lines = [
    'Compacted managed-task memory:',
    `- Objective: ${task.contract.objective}`,
    `- Role: ${worker.role}`,
    `- Harness: ${task.contract.harnessProfile}`,
    `- Round reached: ${round}`,
    task.contract.contractSummary ? `- Contract summary: ${task.contract.contractSummary}` : undefined,
    task.contract.successCriteria.length > 0
      ? `- Success criteria: ${task.contract.successCriteria.join(' | ')}`
      : undefined,
    task.contract.requiredEvidence.length > 0
      ? `- Required evidence: ${task.contract.requiredEvidence.join(' | ')}`
      : undefined,
    task.runtime?.reviewFilesOrAreas?.length
      ? `- Review targets: ${task.runtime.reviewFilesOrAreas.join(' | ')}`
      : undefined,
    task.runtime?.evidenceAcquisitionMode
      ? `- Evidence acquisition mode: ${task.runtime.evidenceAcquisitionMode}`
      : undefined,
    task.runtime?.toolOutputTruncated
      ? `- Tool output truncation observed: ${(task.runtime.toolOutputTruncationNotes ?? []).join(' | ') || 'yes'}`
      : undefined,
    (task.runtime?.consecutiveEvidenceOnlyIterations ?? 0) >= EVIDENCE_ONLY_ITERATION_THRESHOLD
      ? '- Recovery: recent iterations stayed in serial diff paging. Switch to changed_diff_bundle before drilling deeper with changed_diff.'
      : undefined,
    `- Latest worker summary: ${latestSummary}`,
    latestFeedbackArtifact ? `- Latest feedback artifact: ${latestFeedbackArtifact}` : undefined,
    task.contract.verification?.runtime ? `- Runtime guide: ${runtimeGuidePath}` : undefined,
    `- Contract path: ${path.join(task.evidence.workspaceDir, 'contract.json')}`,
    `- Round history path: ${path.join(task.evidence.workspaceDir, 'round-history.json')}`,
    'Use the current contract and artifacts as the source of truth; do not rely on stale assumptions from older rounds.',
  ].filter((line): line is string => Boolean(line));

  return lines.join('\n');
}

function buildCompactInitialMessages(
  task: KodaXManagedTask,
  worker: ManagedTaskWorkerSpec,
  storage: ManagedWorkerSessionStorage | undefined,
  round: number,
): KodaXSessionData['messages'] | undefined {
  const sessionId = buildManagedWorkerSessionId(task, worker);
  const memoryNote = storage?.loadMemoryNote(sessionId)
    ?? buildManagedWorkerMemoryNote(task, worker, undefined, round);
  if (!memoryNote.trim()) {
    return undefined;
  }
  return [
    {
      role: 'system',
      content: memoryNote,
    },
  ];
}

function resolveManagedTaskMaxRounds(
  options: KodaXOptions,
  plan: ReasoningPlan,
  agentMode: KodaXAgentMode,
): number {
  return createManagedBudgetController(options, plan, agentMode).plannedRounds;
}

function resolveManagedTaskQualityAssuranceMode(
  options: KodaXOptions,
  plan: ReasoningPlan,
): ManagedTaskQualityAssuranceMode {
  const primaryTask = String(plan.decision.primaryTask);
  const verification = options.context?.taskVerification;
  const explicitVerification = Boolean(
    verification?.instructions?.length
    || verification?.requiredChecks?.length
    || verification?.requiredEvidence?.length
    || verification?.capabilityHints?.length
  );

  if (
    plan.decision.harnessProfile === 'H3_MULTI_WORKER'
    || plan.decision.needsIndependentQA
    || plan.decision.riskLevel === 'high'
    || plan.decision.requiresBrainstorm
    || options.context?.taskSurface === 'project'
    || options.context?.providerPolicyHints?.longRunning
    || options.context?.longRunning
    || explicitVerification
    || primaryTask === 'verify'
    || primaryTask === 'plan'
    || plan.decision.recommendedMode === 'pr-review'
    || plan.decision.recommendedMode === 'strict-audit'
  ) {
    return 'required';
  }

  return 'optional';
}

function isReviewEvidenceTask(decision: KodaXTaskRoutingDecision): boolean {
  return decision.primaryTask === 'review' || decision.recommendedMode === 'strict-audit';
}

function formatManagedEvidenceRuntime(
  runtime: KodaXManagedTask['runtime'],
): string | undefined {
  if (!runtime) {
    return undefined;
  }

  const parts: string[] = [];
  if (runtime.evidenceAcquisitionMode) {
    parts.push(`mode=${runtime.evidenceAcquisitionMode}`);
  }
  if (runtime.toolOutputTruncated) {
    parts.push('toolOutputTruncated=yes');
  }
  if (runtime.reviewFilesOrAreas?.length) {
    parts.push(`reviewTargets=${runtime.reviewFilesOrAreas.slice(0, 6).join(' | ')}`);
  }
  if (runtime.toolOutputTruncationNotes?.length) {
    parts.push(`truncationHints=${runtime.toolOutputTruncationNotes.slice(0, 3).join(' | ')}`);
  }
  if ((runtime.consecutiveEvidenceOnlyIterations ?? 0) >= EVIDENCE_ONLY_ITERATION_THRESHOLD) {
    parts.push('recovery=switch-to-diff-bundle');
  }

  if (parts.length === 0) {
    return undefined;
  }

  return `[Managed Task Evidence] ${parts.join('; ')}.`;
}

function getEvidenceAcquisitionModeRank(mode: ManagedEvidenceAcquisitionMode | undefined): number {
  switch (mode) {
    case 'diff-bundle':
      return 4;
    case 'diff-slice':
      return 3;
    case 'file-read':
      return 2;
    case 'overview':
      return 1;
    default:
      return 0;
  }
}

function mergeEvidenceAcquisitionMode(
  current: ManagedEvidenceAcquisitionMode | undefined,
  next: ManagedEvidenceAcquisitionMode | undefined,
): ManagedEvidenceAcquisitionMode | undefined {
  return getEvidenceAcquisitionModeRank(next) >= getEvidenceAcquisitionModeRank(current)
    ? next
    : current;
}

const TOOL_TRUNCATION_MARKERS = [
  'Tool output truncated',
  'Bash output truncated',
  'stdout capture capped',
  'stderr capture capped',
  'Diff preview truncated',
] as const;

function collectManagedToolTelemetry(result: KodaXResult): ManagedToolTelemetry {
  const toolNamesById = new Map<string, string>();
  const truncationNotes: string[] = [];
  let evidenceAcquisitionMode: ManagedEvidenceAcquisitionMode | undefined;
  let toolOutputTruncated = false;

  for (const message of result.messages) {
    if (!Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content) {
      if (part.type === 'tool_use') {
        toolNamesById.set(part.id, part.name);
        continue;
      }
      if (part.type !== 'tool_result' || typeof part.content !== 'string') {
        continue;
      }
      const toolName = toolNamesById.get(part.tool_use_id);
      if (toolName === 'changed_diff_bundle') {
        evidenceAcquisitionMode = mergeEvidenceAcquisitionMode(evidenceAcquisitionMode, 'diff-bundle');
      } else if (toolName === 'changed_diff') {
        evidenceAcquisitionMode = mergeEvidenceAcquisitionMode(evidenceAcquisitionMode, 'diff-slice');
      } else if (toolName === 'read') {
        evidenceAcquisitionMode = mergeEvidenceAcquisitionMode(evidenceAcquisitionMode, 'file-read');
      } else if (toolName === 'changed_scope' || toolName === 'repo_overview') {
        evidenceAcquisitionMode = mergeEvidenceAcquisitionMode(evidenceAcquisitionMode, 'overview');
      }

      const matchingLines = part.content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => TOOL_TRUNCATION_MARKERS.some((marker) => line.includes(marker)));
      if (matchingLines.length > 0) {
        toolOutputTruncated = true;
        for (const line of matchingLines) {
          if (!truncationNotes.includes(line)) {
            truncationNotes.push(line);
          }
        }
      }
    }
  }

  return {
    toolOutputTruncated,
    toolOutputTruncationNotes: truncationNotes.slice(0, 6),
    evidenceAcquisitionMode,
  };
}

const REVIEW_PROGRESS_PREFIXES = [
  'now let me',
  'let me',
  'i will now',
  '现在让我',
  '让我',
  '接下来我',
  '现在我来',
] as const;

function looksLikeEvidenceOnlyProgress(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  return REVIEW_PROGRESS_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function isSubstantiveReviewSynthesis(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  if (normalized.length >= 160) {
    return true;
  }

  return (
    normalized.includes('must fix')
    || normalized.includes('optional improvements')
    || normalized.includes('finding')
    || normalized.includes('必须修复')
    || normalized.includes('建议')
    || normalized.includes('问题')
  );
}

function computeEvidenceOnlyIterationCount(
  runtime: KodaXManagedTask['runtime'],
  telemetry: ManagedToolTelemetry,
  result: KodaXResult,
): number | undefined {
  const visibleText = sanitizeManagedUserFacingText(extractMessageText(result) || result.lastText).trim();
  const mode = telemetry.evidenceAcquisitionMode;
  if (!mode) {
    return isSubstantiveReviewSynthesis(visibleText) ? 0 : runtime?.consecutiveEvidenceOnlyIterations;
  }

  if (mode === 'diff-bundle') {
    return 0;
  }

  if (mode !== 'diff-slice' && mode !== 'file-read') {
    return runtime?.consecutiveEvidenceOnlyIterations;
  }

  const evidenceOnly = !isSubstantiveReviewSynthesis(visibleText) && looksLikeEvidenceOnlyProgress(visibleText);
  if (!evidenceOnly) {
    return 0;
  }

  return (runtime?.consecutiveEvidenceOnlyIterations ?? 0) + 1;
}

function applyManagedToolTelemetry(
  task: KodaXManagedTask,
  result: KodaXResult,
): KodaXManagedTask {
  const telemetry = collectManagedToolTelemetry(result);
  if (
    !telemetry.toolOutputTruncated
    && !telemetry.evidenceAcquisitionMode
    && telemetry.toolOutputTruncationNotes.length === 0
  ) {
    return task;
  }

  const runtime = task.runtime ?? {};
  const truncationNotes = Array.from(new Set([
    ...(runtime.toolOutputTruncationNotes ?? []),
    ...telemetry.toolOutputTruncationNotes,
  ]));
  const consecutiveEvidenceOnlyIterations = computeEvidenceOnlyIterationCount(runtime, telemetry, result);

  return {
    ...task,
    runtime: {
      ...runtime,
      toolOutputTruncated: runtime.toolOutputTruncated || telemetry.toolOutputTruncated,
      toolOutputTruncationNotes: truncationNotes.length > 0 ? truncationNotes : runtime.toolOutputTruncationNotes,
      evidenceAcquisitionMode: mergeEvidenceAcquisitionMode(
        runtime.evidenceAcquisitionMode,
        telemetry.evidenceAcquisitionMode,
      ),
      consecutiveEvidenceOnlyIterations,
    },
  };
}

const WRITE_ONLY_TOOLS = new Set([
  'write',
  'edit',
  'multi_edit',
  'apply_patch',
  'delete',
  'remove',
  'rename',
  'move',
  'create',
  'create_file',
  'create_resource',
  'scene_create',
  'scene_node_add',
  'scene_node_delete',
  'scene_node_set',
  'scene_save',
  'script_create',
  'script_modify',
  'project_setting_set',
  'signal_connect',
]);

const SHELL_PATTERN_CACHE = new Map<string, RegExp>();

const INSPECTION_SHELL_PATTERNS = [
  '^(?:git\\s+(?:status|diff|show|log|branch|rev-parse|ls-files))\\b',
  '^(?:Get-ChildItem|Get-Content|Select-String|type|dir|ls|cat)\\b',
  '^(?:findstr|where|pwd|cd)\\b',
  '^(?:node|npm|pnpm|yarn|bun)\\s+(?:run\\s+)?(?:lint|typecheck|check|list|why)\\b',
];

const VERIFICATION_SHELL_PATTERNS = [
  ...INSPECTION_SHELL_PATTERNS,
  '^(?:agent-browser)\\b',
  '^(?:npx\\s+)?playwright\\b',
  '^(?:npx\\s+)?vitest\\b',
  '^(?:npx\\s+)?jest\\b',
  '^(?:npx\\s+)?cypress\\b',
  '^(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?(?:test|test:[^\\s]+|e2e|e2e:[^\\s]+|verify|verify:[^\\s]+|build|build:[^\\s]+|lint|lint:[^\\s]+|typecheck|typecheck:[^\\s]+)\\b',
  '^(?:pytest|go\\s+test|cargo\\s+test|dotnet\\s+test|mvn\\s+test|gradle\\s+test)\\b',
];

const SHELL_WRITE_PATTERNS = [
  '\\b(?:Set-Content|Add-Content|Out-File|Tee-Object|Copy-Item|Move-Item|Rename-Item|Remove-Item|New-Item|Clear-Content)\\b',
  '\\b(?:rm|mv|cp|del|erase|touch|mkdir|rmdir|rename|ren)\\b',
  '\\b(?:sed\\s+-i|perl\\s+-pi|python\\s+-c|node\\s+-e)\\b',
  '(?:^|\\s)(?:>|>>)(?!(?:\\s*&1|\\s*2>&1))',
];

const REVIEW_LARGE_FILE_THRESHOLD = 10;
const REVIEW_LARGE_LINE_THRESHOLD = 1200;
const REVIEW_LARGE_MODULE_THRESHOLD = 3;
const REVIEW_MASSIVE_FILE_THRESHOLD = 30;
const REVIEW_MASSIVE_LINE_THRESHOLD = 4000;
const REVIEW_MASSIVE_MODULE_THRESHOLD = 5;

function parsePromptInteger(prompt: string, pattern: RegExp): number | undefined {
  const match = prompt.match(pattern);
  if (!match) {
    return undefined;
  }

  const parsed = Number(match[1]?.replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function inferPromptReviewScale(
  prompt: string,
): KodaXTaskRoutingDecision['reviewScale'] | undefined {
  const normalized = prompt.toLowerCase();
  const promptFileCount = parsePromptInteger(normalized, /(\d[\d,]*)\s*(?:\+)?\s*files?\b/);
  const promptLineCount = parsePromptInteger(
    normalized,
    /(\d[\d,]*)\s*(?:\+)?\s*(?:changed\s*)?(?:lines?|loc)\b/,
  );

  if (
    (promptFileCount ?? 0) >= REVIEW_MASSIVE_FILE_THRESHOLD
    || (promptLineCount ?? 0) >= REVIEW_MASSIVE_LINE_THRESHOLD
  ) {
    return 'massive';
  }

  if (
    (promptFileCount ?? 0) >= REVIEW_LARGE_FILE_THRESHOLD
    || (promptLineCount ?? 0) >= REVIEW_LARGE_LINE_THRESHOLD
  ) {
    return 'large';
  }

  return undefined;
}

function deriveFallbackReviewScale(
  prompt: string,
  repoSignals?: KodaXRepoRoutingSignals,
): KodaXTaskRoutingDecision['reviewScale'] | undefined {
  if (repoSignals?.reviewScale) {
    return repoSignals.reviewScale;
  }

  const touchedModules = repoSignals?.touchedModuleCount ?? 0;
  const changedFiles = repoSignals?.changedFileCount ?? 0;
  const changedLines = repoSignals?.changedLineCount ?? 0;

  if (
    changedFiles >= REVIEW_MASSIVE_FILE_THRESHOLD
    || changedLines >= REVIEW_MASSIVE_LINE_THRESHOLD
    || touchedModules >= REVIEW_MASSIVE_MODULE_THRESHOLD
  ) {
    return 'massive';
  }

  if (
    changedFiles >= REVIEW_LARGE_FILE_THRESHOLD
    || changedLines >= REVIEW_LARGE_LINE_THRESHOLD
    || touchedModules >= REVIEW_LARGE_MODULE_THRESHOLD
  ) {
    return 'large';
  }

  return inferPromptReviewScale(prompt);
}

function inferReviewTarget(prompt: string): ManagedReviewTarget {
  const normalized = ` ${prompt.toLowerCase()} `;
  if (
    /\b(compare|range|between|since|from\s+\S+\s+to\s+\S+|commit-range|commit range|diff range)\b/.test(normalized)
    || /提交范围|提交区间|版本范围|对比.*提交|比较.*提交/.test(prompt)
  ) {
    return 'compare-range';
  }

  if (
    /\b(current|worktree|workspace|working tree|staged|unstaged|uncommitted|local changes?|current code changes?|current workspace changes?)\b/.test(normalized)
    || /当前(?:工作区|代码)?改动|当前代码改动|当前工作区改动|所有当前代码改动/.test(prompt)
  ) {
    return 'current-worktree';
  }

  return 'general';
}

function isDiffDrivenReviewPrompt(prompt: string): boolean {
  const normalized = ` ${prompt.toLowerCase()} `;
  return (
    /\b(review|code review|audit|look at the changes|changed files|current code changes?|current workspace changes?)\b/.test(normalized)
    || /review一下|评审|审查|看下改动|代码改动/.test(prompt)
  );
}

function cloneRoutingDecisionWithReviewTarget(
  decision: KodaXTaskRoutingDecision,
  reviewTarget: ManagedReviewTarget,
): KodaXTaskRoutingDecision {
  return {
    ...decision,
    reviewTarget,
  };
}

function formatHarnessProfileShort(
  harnessProfile?: KodaXTaskRoutingDecision['harnessProfile'],
): string | undefined {
  switch (harnessProfile) {
    case 'H0_DIRECT':
      return 'H0';
    case 'H1_EXECUTE_EVAL':
      return 'H1';
    case 'H2_PLAN_EXECUTE_EVAL':
      return 'H2';
    case 'H3_MULTI_WORKER':
      return 'H3';
    default:
      return harnessProfile;
  }
}

function formatManagedReviewTargetLabel(
  reviewTarget?: ManagedReviewTarget,
  reviewScale?: KodaXTaskRoutingDecision['reviewScale'],
): string | undefined {
  if (reviewTarget === 'current-worktree') {
    return `${reviewScale ? `${reviewScale} ` : ''}current-diff review`;
  }
  if (reviewTarget === 'compare-range') {
    return `${reviewScale ? `${reviewScale} ` : ''}compare-range review`;
  }
  if (reviewScale) {
    return `${reviewScale} review`;
  }
  return undefined;
}

function createLiveRoutingNote(
  rawDecision: KodaXTaskRoutingDecision,
  finalDecision: KodaXTaskRoutingDecision,
  repoSignals?: KodaXRepoRoutingSignals,
  reason?: string,
): string {
  const finalHarness = formatHarnessProfileShort(finalDecision.harnessProfile) ?? finalDecision.harnessProfile;
  const rawHarness = formatHarnessProfileShort(rawDecision.harnessProfile) ?? rawDecision.harnessProfile;
  const detailParts: string[] = [];
  const reviewLabel = formatManagedReviewTargetLabel(finalDecision.reviewTarget, finalDecision.reviewScale);

  if (reviewLabel) {
    detailParts.push(reviewLabel);
  }

  if ((repoSignals?.changedFileCount ?? 0) > 0 || (repoSignals?.changedLineCount ?? 0) > 0) {
    const scopeParts: string[] = [];
    if ((repoSignals?.changedFileCount ?? 0) > 0) {
      scopeParts.push(`${repoSignals?.changedFileCount ?? 0} files`);
    }
    if ((repoSignals?.changedLineCount ?? 0) > 0) {
      scopeParts.push(`${repoSignals?.changedLineCount ?? 0} lines`);
    }
    detailParts.push(scopeParts.join(' / '));
  }

  if (
    rawDecision.harnessProfile !== finalDecision.harnessProfile
    || rawDecision.upgradeCeiling !== finalDecision.upgradeCeiling
  ) {
    detailParts.push(`raw ${rawHarness} -> ${finalHarness}`);
  }

  if (reason && !reviewLabel) {
    detailParts.push(reason);
  } else if (
    reason
    && (
      rawDecision.harnessProfile !== finalDecision.harnessProfile
      || rawDecision.upgradeCeiling !== finalDecision.upgradeCeiling
    )
  ) {
    detailParts.push('override applied');
  }

  return detailParts.length > 0
    ? `AMA ${finalHarness} · ${detailParts.join(' · ')}`
    : `AMA ${finalHarness}`;
}

function createRoutingBreadcrumb(
  rawDecision: KodaXTaskRoutingDecision,
  finalDecision: KodaXTaskRoutingDecision,
  reason?: string,
): string {
  const rawSource = rawDecision.routingSource ?? 'unknown';
  const base = `AMA routing: raw=${rawDecision.harnessProfile}(${rawSource}) -> final=${finalDecision.harnessProfile}`;
  if (reason) {
    return `${base} reason=${reason}`;
  }
  if (finalDecision.reviewTarget === 'current-worktree' && finalDecision.reviewScale) {
    return `${base} reason=${finalDecision.reviewScale} current-diff review`;
  }
  if (finalDecision.reviewTarget === 'current-worktree') {
    return `${base} reason=current-diff review (scale unavailable)`;
  }
  if (finalDecision.reviewTarget === 'compare-range' && finalDecision.reviewScale) {
    return `${base} reason=${finalDecision.reviewScale} compare-range review`;
  }
  if (finalDecision.reviewTarget === 'compare-range') {
    return `${base} reason=compare-range review (scale unavailable)`;
  }
  return base;
}

function buildRoutingOverrideReason(
  reviewTarget: ManagedReviewTarget,
  reviewScale: KodaXTaskRoutingDecision['reviewScale'],
  nextHarness: KodaXTaskRoutingDecision['harnessProfile'],
): string | undefined {
  if (reviewTarget === 'general' || !reviewScale) {
    return undefined;
  }
  if (reviewScale === 'large') {
    return `${reviewTarget === 'current-worktree' ? 'large current-diff review' : 'large compare-range review'} forced a minimum ${nextHarness} harness.`;
  }
  if (reviewScale === 'massive') {
    return `${reviewTarget === 'current-worktree' ? 'massive current-diff review' : 'massive compare-range review'} forced a minimum ${nextHarness} harness.`;
  }
  return undefined;
}

function applyCurrentDiffReviewRoutingFloor(
  plan: ReasoningPlan,
  prompt: string,
  repoSignals?: KodaXRepoRoutingSignals,
): {
  plan: ReasoningPlan;
  rawDecision: KodaXTaskRoutingDecision;
  reviewTarget: ManagedReviewTarget;
  routingOverrideReason?: string;
} {
  const reviewTarget = inferReviewTarget(prompt);
  const rawDecision = cloneRoutingDecisionWithReviewTarget(plan.decision, reviewTarget);
  const reviewScale = rawDecision.reviewScale ?? deriveFallbackReviewScale(prompt, repoSignals);
  const diffDrivenReview = reviewTarget !== 'general' && (
    rawDecision.primaryTask === 'review'
    || isDiffDrivenReviewPrompt(prompt)
  );

  if (!diffDrivenReview || !reviewScale) {
    const finalDecision = reviewScale
      ? { ...rawDecision, reviewScale }
      : rawDecision;
    if (finalDecision === plan.decision) {
      return {
        plan,
        rawDecision,
        reviewTarget,
      };
    }
    return {
      plan: {
        ...plan,
        decision: finalDecision,
        promptOverlay: buildPromptOverlay(finalDecision, plan.providerPolicy?.routingNotes, plan.providerPolicy),
      },
      rawDecision,
      reviewTarget,
    };
  }

  const likelySystemic = Boolean(
    repoSignals?.crossModule
    || (repoSignals?.touchedModuleCount ?? 0) >= REVIEW_MASSIVE_MODULE_THRESHOLD
    || rawDecision.complexity === 'systemic',
  );

  let nextHarness = rawDecision.harnessProfile;
  let nextUpgradeCeiling = rawDecision.upgradeCeiling;

  if (reviewScale === 'massive') {
    nextHarness = likelySystemic ? 'H3_MULTI_WORKER' : 'H2_PLAN_EXECUTE_EVAL';
    nextUpgradeCeiling = likelySystemic ? undefined : 'H3_MULTI_WORKER';
  } else if (reviewScale === 'large') {
    nextHarness = 'H2_PLAN_EXECUTE_EVAL';
    nextUpgradeCeiling = rawDecision.upgradeCeiling;
  }

  if (getHarnessRank(rawDecision.harnessProfile) >= getHarnessRank(nextHarness)) {
    const finalDecision = {
      ...rawDecision,
      reviewScale,
    };
    return {
      plan: {
        ...plan,
        decision: finalDecision,
        promptOverlay: buildPromptOverlay(finalDecision, plan.providerPolicy?.routingNotes, plan.providerPolicy),
      },
      rawDecision,
      reviewTarget,
    };
  }

  const routingOverrideReason = buildRoutingOverrideReason(reviewTarget, reviewScale, nextHarness);
  const finalDecision: KodaXTaskRoutingDecision = {
    ...rawDecision,
    primaryTask: 'review',
    reviewScale,
    harnessProfile: nextHarness,
    upgradeCeiling: nextUpgradeCeiling,
    routingNotes: [
      ...(rawDecision.routingNotes ?? []),
      routingOverrideReason ?? `Routing floor raised the harness to ${nextHarness}.`,
    ],
    reason: routingOverrideReason
      ? `${rawDecision.reason} ${routingOverrideReason}`
      : rawDecision.reason,
  };

  return {
    plan: {
      ...plan,
      decision: finalDecision,
      promptOverlay: buildPromptOverlay(finalDecision, plan.providerPolicy?.routingNotes, plan.providerPolicy),
    },
    rawDecision,
    reviewTarget,
    routingOverrideReason,
  };
}

function inferFallbackDecision(
  prompt: string,
  repoSignals?: KodaXRepoRoutingSignals,
): KodaXTaskRoutingDecision {
  const base = buildFallbackRoutingDecision(prompt, undefined, {
    repoSignals,
  });
  const normalized = ` ${prompt.toLowerCase()} `;
  const reviewScale = deriveFallbackReviewScale(prompt, repoSignals);
  const asksForBrainstorm =
    /\b(brainstorm|options?|trade[\s-]?offs?|explore|compare approaches?)\b/.test(normalized);
  const appendIntent = /\b(append|continue|extend|follow[- ]up|iterate)\b/.test(normalized);
  const overwriteIntent = /\b(overwrite|rewrite|replace|migrate|refactor)\b/.test(normalized);
  const likelySystemic = Boolean(
    repoSignals?.crossModule
    || (repoSignals?.touchedModuleCount ?? 0) >= REVIEW_MASSIVE_MODULE_THRESHOLD
    || /\b(multi-agent|parallel|across the monorepo|systemic|cross-cutting)\b/.test(normalized),
  );

  if (base.primaryTask === 'review' && reviewScale === 'massive') {
    return {
      ...base,
      complexity: likelySystemic ? 'systemic' : 'complex',
      harnessProfile: likelySystemic ? 'H3_MULTI_WORKER' : 'H2_PLAN_EXECUTE_EVAL',
      upgradeCeiling: likelySystemic ? undefined : 'H3_MULTI_WORKER',
      riskLevel: likelySystemic ? 'high' : 'medium',
      reviewScale,
      requiresBrainstorm: asksForBrainstorm,
      workIntent: overwriteIntent ? 'overwrite' : appendIntent ? 'append' : base.workIntent,
      reason: `${base.reason} Fallback task-engine routing treated the review as massive and started with ${likelySystemic ? 'H3' : 'H2'}${likelySystemic ? '' : ' plus an H3 upgrade ceiling'}.`,
      soloBoundaryConfidence: likelySystemic ? 0.12 : 0.26,
      needsIndependentQA: true,
      routingNotes: [
        ...(base.routingNotes ?? []),
        likelySystemic
          ? 'Task-engine fallback routing started in H3 because repo signals showed a massive, systemic review surface.'
          : 'Task-engine fallback routing started in H2 with an H3 upgrade ceiling because repo signals showed a massive review surface.',
      ],
    };
  }

  if (base.primaryTask === 'review' && reviewScale === 'large') {
    return {
      ...base,
      complexity: 'complex',
      harnessProfile: 'H2_PLAN_EXECUTE_EVAL',
      riskLevel: base.riskLevel === 'low' ? 'medium' : base.riskLevel,
      reviewScale,
      requiresBrainstorm: asksForBrainstorm,
      workIntent: overwriteIntent ? 'overwrite' : appendIntent ? 'append' : base.workIntent,
      reason: `${base.reason} Fallback task-engine routing treated the review as large and started in H2.`,
      soloBoundaryConfidence: 0.38,
      needsIndependentQA: true,
      routingNotes: [
        ...(base.routingNotes ?? []),
        'Task-engine fallback routing escalated the review to H2 because repo signals showed a large review surface.',
      ],
    };
  }

  if (
    /\b(multi-agent|parallel|across the monorepo|systemic|cross-cutting)\b/.test(normalized)
  ) {
    return {
      ...base,
      complexity: 'systemic',
      harnessProfile: 'H3_MULTI_WORKER',
      riskLevel: 'high',
      requiresBrainstorm: asksForBrainstorm,
      workIntent: overwriteIntent ? 'overwrite' : appendIntent ? 'append' : base.workIntent,
      reviewScale,
      reason: `${base.reason} Fallback task-engine routing selected H3 for cross-cutting scope.`,
      soloBoundaryConfidence: 0.18,
      needsIndependentQA: true,
      routingNotes: [
        ...(base.routingNotes ?? []),
        'Task-engine fallback routing escalated to H3 because the prompt looked cross-cutting or multi-worker.',
      ],
    };
  }

  if (
    asksForBrainstorm
    || /\b(plan|design|architecture|proposal|refactor|migration)\b/.test(normalized)
  ) {
    return {
      ...base,
      complexity: 'complex',
      harnessProfile: 'H2_PLAN_EXECUTE_EVAL',
      requiresBrainstorm: asksForBrainstorm,
      workIntent: overwriteIntent ? 'overwrite' : appendIntent ? 'append' : base.workIntent,
      reviewScale,
      reason: `${base.reason} Fallback task-engine routing selected H2 for planning-heavy scope.`,
      soloBoundaryConfidence: 0.38,
      needsIndependentQA: true,
      routingNotes: [
        ...(base.routingNotes ?? []),
        'Task-engine fallback routing escalated to H2 because the prompt looked planning-heavy or exploratory.',
      ],
    };
  }

  if (
    /\b(review|verify|test|fix|bug|debug|investigate|audit)\b/.test(normalized)
    || prompt.trim().length > 280
  ) {
    return {
      ...base,
      complexity: 'moderate',
      harnessProfile: 'H1_EXECUTE_EVAL',
      workIntent: overwriteIntent ? 'overwrite' : appendIntent ? 'append' : base.workIntent,
      requiresBrainstorm: asksForBrainstorm,
      reviewScale,
      reason: `${base.reason} Fallback task-engine routing selected H1 for non-trivial execution.`,
      soloBoundaryConfidence: /\b(review|bug|fix)\b/.test(normalized) ? 0.72 : 0.58,
      needsIndependentQA: /\b(verify|test|audit|must[- ]fix|independent)\b/.test(normalized),
    };
  }

  return {
    ...base,
    complexity: 'simple',
    harnessProfile: 'H0_DIRECT',
    riskLevel: 'low',
    workIntent: overwriteIntent ? 'overwrite' : appendIntent ? 'append' : base.workIntent,
    requiresBrainstorm: asksForBrainstorm,
    reviewScale,
    reason: `${base.reason} Fallback task-engine routing kept the task in H0 direct mode.`,
    soloBoundaryConfidence: 0.9,
    needsIndependentQA: false,
  };
}

async function createManagedReasoningPlan(
  options: KodaXOptions,
  prompt: string,
): Promise<ManagedPlanningResult> {
  const repoRoutingSignals = options.context?.repoRoutingSignals
    ?? (
      (options.context?.executionCwd || options.context?.gitRoot)
        ? await getRepoRoutingSignals({
          executionCwd: options.context?.executionCwd,
          gitRoot: options.context?.gitRoot ?? undefined,
        }).catch(() => null)
        : null
    );
  try {
    const provider = resolveProvider(options.provider);
    const plan = await createReasoningPlan(options, prompt, provider, {
      repoSignals: repoRoutingSignals ?? undefined,
    });
    const floored = applyCurrentDiffReviewRoutingFloor(
      plan,
      prompt,
      repoRoutingSignals ?? undefined,
    );
    return {
      plan: floored.plan,
      repoRoutingSignals: repoRoutingSignals ?? undefined,
      rawDecision: floored.rawDecision,
      reviewTarget: floored.reviewTarget,
      routingOverrideReason: floored.routingOverrideReason,
    };
  } catch (error) {
    const decision = inferFallbackDecision(prompt, repoRoutingSignals ?? undefined);
    const mode = resolveReasoningMode(options);
    const depth = mode === 'auto'
      ? decision.recommendedThinkingDepth
      : mode === 'off'
        ? 'off'
        : reasoningModeToDepth(mode);

    const rawPlan: ReasoningPlan = {
      mode,
      depth,
      decision: {
        ...decision,
        recommendedThinkingDepth: depth,
        routingSource: 'retried-fallback',
        routingAttempts: Math.max(decision.routingAttempts ?? 1, MANAGED_TASK_ROUTER_MAX_RETRIES),
        routingNotes: [
          ...(decision.routingNotes ?? []),
          `Managed task engine used heuristic fallback routing because provider-backed routing was unavailable: ${error instanceof Error ? error.message : String(error)}`,
        ],
      },
      promptOverlay: buildPromptOverlay({
        ...decision,
        recommendedThinkingDepth: depth,
        routingSource: 'retried-fallback',
        routingAttempts: Math.max(decision.routingAttempts ?? 1, MANAGED_TASK_ROUTER_MAX_RETRIES),
        routingNotes: [
          ...(decision.routingNotes ?? []),
          'Managed task engine is running with heuristic fallback routing.',
        ],
      }),
    };
    const floored = applyCurrentDiffReviewRoutingFloor(
      rawPlan,
      prompt,
      repoRoutingSignals ?? undefined,
    );

    return {
      plan: floored.plan,
      repoRoutingSignals: repoRoutingSignals ?? undefined,
      rawDecision: floored.rawDecision,
      reviewTarget: floored.reviewTarget,
      routingOverrideReason: floored.routingOverrideReason,
    };
  }
}

function buildManagedWorkerAgent(role: KodaXTaskRole, workerId?: string): string {
  if (workerId === 'contract-review') {
    return 'ContractReviewAgent';
  }

  switch (role) {
    case 'admission':
      return 'AdmissionAgent';
    case 'lead':
      return 'LeadAgent';
    case 'planner':
      return 'PlanningAgent';
    case 'generator':
      return 'ExecutionAgent';
    case 'validator':
      return 'VerificationAgent';
    case 'evaluator':
      return 'EvaluationAgent';
    case 'worker':
      return 'SpecialistWorker';
    case 'direct':
    default:
      return 'DirectAgent';
  }
}

function buildManagedWorkerToolPolicy(
  role: KodaXTaskRole,
  verification: KodaXTaskVerificationContract | undefined,
): KodaXTaskToolPolicy | undefined {
  switch (role) {
    case 'admission':
    case 'lead':
    case 'planner':
      return {
        summary: 'Admission and planning agents must stay read-only and may inspect repository state or design context, but must not mutate files or execute implementation steps.',
        blockedTools: [...WRITE_ONLY_TOOLS],
        allowedShellPatterns: INSPECTION_SHELL_PATTERNS,
      };
    case 'validator':
    case 'evaluator':
      return {
        summary: 'Verification agents may inspect the repo and run verification commands, including browser, startup, API, and runtime checks declared by the verification contract, but must not edit project files or mutate control-plane artifacts.',
        blockedTools: [...WRITE_ONLY_TOOLS],
        allowedShellPatterns: [
          ...VERIFICATION_SHELL_PATTERNS,
          ...buildRuntimeVerificationShellPatterns(verification),
        ],
      };
    default:
      return undefined;
  }
}

function formatCapabilityHint(hint: KodaXTaskCapabilityHint): string {
  return `${hint.kind}:${hint.name}${hint.details ? ` - ${hint.details}` : ''}`;
}

function formatVerificationContract(
  verification: KodaXTaskVerificationContract | undefined,
): string | undefined {
  if (!verification) {
    return undefined;
  }

  const lines = [
    'Verification contract:',
    verification.summary ? `Summary: ${verification.summary}` : undefined,
    verification.rubricFamily ? `Rubric family: ${verification.rubricFamily}` : undefined,
    verification.instructions?.length
      ? ['Instructions:', ...verification.instructions.map((item) => `- ${item}`)].join('\n')
      : undefined,
    verification.requiredEvidence?.length
      ? ['Required evidence:', ...verification.requiredEvidence.map((item) => `- ${item}`)].join('\n')
      : undefined,
    verification.requiredChecks?.length
      ? ['Required checks:', ...verification.requiredChecks.map((item) => `- ${item}`)].join('\n')
      : undefined,
    verification.capabilityHints?.length
      ? ['Capability hints:', ...verification.capabilityHints.map((item) => `- ${formatCapabilityHint(item)}`)].join('\n')
      : undefined,
    verification.criteria?.length
      ? [
        'Verification criteria:',
        ...verification.criteria.map((criterion) => `- ${criterion.id}: ${criterion.label} (threshold=${criterion.threshold}, weight=${criterion.weight})`),
      ].join('\n')
      : undefined,
    verification.runtime
      ? [
        'Runtime under test:',
        verification.runtime.cwd ? `- cwd: ${verification.runtime.cwd}` : undefined,
        verification.runtime.startupCommand ? `- startupCommand: ${verification.runtime.startupCommand}` : undefined,
        verification.runtime.readySignal ? `- readySignal: ${verification.runtime.readySignal}` : undefined,
        verification.runtime.baseUrl ? `- baseUrl: ${verification.runtime.baseUrl}` : undefined,
        verification.runtime.uiFlows?.length ? `- uiFlows: ${verification.runtime.uiFlows.join(' | ')}` : undefined,
        verification.runtime.apiChecks?.length ? `- apiChecks: ${verification.runtime.apiChecks.join(' | ')}` : undefined,
        verification.runtime.dbChecks?.length ? `- dbChecks: ${verification.runtime.dbChecks.join(' | ')}` : undefined,
        verification.runtime.fixtures?.length ? `- fixtures: ${verification.runtime.fixtures.join(' | ')}` : undefined,
      ].filter((line): line is string => Boolean(line)).join('\n')
      : undefined,
    buildRuntimeExecutionGuide(verification)
      ? `Runtime execution guide:\n${buildRuntimeExecutionGuide(verification)?.trimEnd()}`
      : undefined,
  ].filter((line): line is string => Boolean(line));

  return lines.length > 1 ? lines.join('\n') : undefined;
}

function formatTaskContract(task: KodaXManagedTask['contract']): string | undefined {
  const lines = [
    'Task contract:',
    task.contractSummary ? `Summary: ${task.contractSummary}` : undefined,
    task.successCriteria.length > 0
      ? ['Success criteria:', ...task.successCriteria.map((item) => `- ${item}`)].join('\n')
      : undefined,
    task.requiredEvidence.length > 0
      ? ['Required evidence:', ...task.requiredEvidence.map((item) => `- ${item}`)].join('\n')
      : undefined,
    task.constraints.length > 0
      ? ['Constraints:', ...task.constraints.map((item) => `- ${item}`)].join('\n')
      : undefined,
  ].filter((line): line is string => Boolean(line));

  return lines.length > 1 ? lines.join('\n') : undefined;
}

function formatTaskMetadata(metadata: Record<string, KodaXJsonValue> | undefined): string | undefined {
  if (!metadata || Object.keys(metadata).length === 0) {
    return undefined;
  }

  return [
    'Task metadata:',
    JSON.stringify(metadata, null, 2),
  ].join('\n');
}

function formatToolPolicy(policy: KodaXTaskToolPolicy | undefined): string | undefined {
  if (!policy) {
    return undefined;
  }

  const lines = [
    'Tool policy:',
    `Summary: ${policy.summary}`,
    policy.allowedTools?.length
      ? `Allowed tools: ${policy.allowedTools.join(', ')}`
      : undefined,
    policy.blockedTools?.length
      ? `Blocked tools: ${policy.blockedTools.join(', ')}`
      : undefined,
    policy.allowedShellPatterns?.length
      ? ['Allowed shell patterns:', ...policy.allowedShellPatterns.map((pattern) => `- ${pattern}`)].join('\n')
      : undefined,
  ].filter((line): line is string => Boolean(line));

  return lines.length > 1 ? lines.join('\n') : undefined;
}

function formatManagedPromptOverlay(
  task: KodaXManagedTask,
  worker: ManagedTaskWorkerSpec,
  terminalWorkerId: string,
  qualityAssuranceMode: ManagedTaskQualityAssuranceMode,
): string {
  return [
    `[Managed Task] task=${task.contract.taskId}; role=${worker.role}; worker=${worker.id}; terminal=${worker.id === terminalWorkerId ? 'yes' : 'no'}; agent=${worker.agent ?? buildManagedWorkerAgent(worker.role)}; qa=${qualityAssuranceMode}; currentHarness=${task.contract.harnessProfile}; upgradeCeiling=${task.runtime?.upgradeCeiling ?? 'none'}.`,
    worker.memoryStrategy
      ? `[Managed Task Memory] strategy=${worker.memoryStrategy}.`
      : undefined,
    `Managed task artifacts: contract=${path.join(task.evidence.workspaceDir, 'contract.json')}; rounds=${path.join(task.evidence.workspaceDir, 'round-history.json')}; runtimeGuide=${path.join(task.evidence.workspaceDir, 'runtime-execution.md')}.`,
    formatManagedEvidenceRuntime(task.runtime),
    formatBudgetAdvisory(worker.budgetSnapshot),
    formatTaskContract(task.contract),
    formatTaskMetadata(task.contract.metadata),
    formatVerificationContract(task.contract.verification),
    formatToolPolicy(worker.toolPolicy),
  ]
    .filter((section): section is string => Boolean(section && section.trim()))
    .join('\n\n');
}

function matchesShellPattern(command: string, patterns: readonly string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) {
    return false;
  }

  return patterns.some((pattern) => {
    let compiled = SHELL_PATTERN_CACHE.get(pattern);
    if (!compiled) {
      compiled = new RegExp(pattern, 'i');
      SHELL_PATTERN_CACHE.set(pattern, compiled);
    }
    return compiled.test(command);
  });
}

function createToolPolicyHook(
  worker: ManagedTaskWorkerSpec,
): KodaXEvents['beforeToolExecute'] | undefined {
  const toolPolicy = worker.toolPolicy;
  if (!toolPolicy) {
    return undefined;
  }

  return async (tool, input) => {
    const normalizedTool = tool.toLowerCase();
    if (toolPolicy.blockedTools?.some((blocked) => blocked.toLowerCase() === normalizedTool)) {
      return `[Managed Task ${worker.title}] Tool "${tool}" is blocked for this role. ${toolPolicy.summary}`;
    }

    if (normalizedTool === 'bash' && typeof input.command === 'string') {
      const command = input.command.trim();
      if (matchesShellPattern(command, SHELL_WRITE_PATTERNS)) {
        return `[Managed Task ${worker.title}] Shell command blocked because this role is verification-only or planning-only. ${toolPolicy.summary}`;
      }
      if (matchesShellPattern(command, toolPolicy.allowedShellPatterns)) {
        return true;
      }

      if (toolPolicy.allowedShellPatterns?.length) {
        return `[Managed Task ${worker.title}] Shell command is outside the allowed verification/planning boundary. ${toolPolicy.summary}`;
      }
    }

    if (
      toolPolicy.allowedTools?.length
      && !toolPolicy.allowedTools.some((allowed) => allowed.toLowerCase() === normalizedTool)
      && normalizedTool !== 'bash'
    ) {
      return `[Managed Task ${worker.title}] Tool "${tool}" is outside the allowed capability boundary. ${toolPolicy.summary}`;
    }

    return true;
  };
}

function createRolePrompt(
  role: KodaXTaskRole,
  prompt: string,
  decision: KodaXTaskRoutingDecision,
  verification: KodaXTaskVerificationContract | undefined,
  toolPolicy: KodaXTaskToolPolicy | undefined,
  agent: string,
  metadata: Record<string, KodaXJsonValue> | undefined,
  workerId?: string,
  isTerminalAuthority = false,
): string {
  const decisionSummary = [
    `Primary task: ${decision.primaryTask}`,
    `Work intent: ${decision.workIntent}`,
    `Complexity: ${decision.complexity}`,
    `Risk: ${decision.riskLevel}`,
    `Harness: ${decision.harnessProfile}`,
    `Brainstorm required: ${decision.requiresBrainstorm ? 'yes' : 'no'}`,
  ].join('\n');

  const sharedClosingRule = [
    'Preserve any exact machine-readable closing contract requested by the original task.',
    'Do not claim completion authority unless your role explicitly owns final judgment.',
    'When proposing shell commands or command examples, match the current host OS and shell. Do not assume Unix-only tools such as head on Windows.',
  ].join('\n');

  const contractSection = formatTaskContract({
    taskId: 'preview',
    surface: 'cli',
    objective: prompt,
    createdAt: '',
    updatedAt: '',
    status: 'running',
    primaryTask: decision.primaryTask,
    workIntent: decision.workIntent,
    complexity: decision.complexity,
    riskLevel: decision.riskLevel,
    harnessProfile: decision.harnessProfile,
    recommendedMode: decision.recommendedMode,
    requiresBrainstorm: decision.requiresBrainstorm,
    reason: decision.reason,
    contractSummary: undefined,
    successCriteria: [],
    requiredEvidence: verification?.requiredEvidence ?? [],
    constraints: [],
    metadata,
    verification,
  });
  const metadataSection = formatTaskMetadata(metadata);
  const verificationSection = formatVerificationContract(verification);
  const toolPolicySection = formatToolPolicy(toolPolicy);
  const agentSection = `Assigned native agent identity: ${agent}`;
  const isContractReview = workerId === 'contract-review';
  const isReviewHighRiskWorker = workerId === 'review-worker-high-risk';
  const isReviewSurfaceWorker = workerId === 'review-worker-surface';
  const reviewLikeTask = isReviewEvidenceTask(decision);
  const reviewPresentationRule = decision.primaryTask === 'review'
    ? 'When the task is review or audit, speak directly to the user about the final review findings. Do not frame the answer as grading or critiquing the Generator.'
    : undefined;
  const reviewEvidenceGuidance = reviewLikeTask
    ? [
      'For large or history-based reviews, collect evidence in this order: changed_scope -> repo_overview (only when needed) -> changed_diff_bundle for a batch of high-priority files -> changed_diff slices for suspicious files/areas -> read for current-file context.',
      'Do not start with broad bash git diff/git show output unless you are using it as a narrow fallback after changed_scope/changed_diff_bundle.',
      'When a tool reports truncated output, narrow the follow-up by path or offset, or switch from changed_diff to changed_diff_bundle instead of repeating the same broad request.',
    ].join('\n')
    : undefined;
  const handoffBlockInstructions = [
    `Append a final fenced block named \`\`\`${MANAGED_TASK_HANDOFF_BLOCK}\` with this exact shape:`,
    'status: ready|incomplete|blocked',
    'summary: <one-line handoff summary>',
    'evidence:',
    '- <evidence item>',
    'followup:',
    '- <required next step or "none">',
    '- <optional second next step>',
    'Keep the role output above the block.',
  ].join('\n');

  switch (role) {
    case 'admission':
      return [
        'You are the Admission role for a managed KodaX task.',
        decisionSummary,
        `Original task:\n${prompt}`,
        agentSection,
        contractSection,
        metadataSection,
        verificationSection,
        toolPolicySection,
        'Define the initial scope before execution begins. Clarify the evidence surface, likely change radius, and whether the proposed harness is sufficient.',
        'Prefer cheap facts: changed scope, module spread, diff size, verification requirements, and any explicit task constraints already present.',
        reviewEvidenceGuidance,
        [
          `Append a final fenced block named \`\`\`${MANAGED_TASK_ADMISSION_BLOCK}\` with this exact shape:`,
          'summary: <one-line admission summary>',
          'confirmed_harness: <optional H1_EXECUTE_EVAL|H2_PLAN_EXECUTE_EVAL|H3_MULTI_WORKER>',
          'evidence_acquisition_mode: <optional overview|diff-bundle|diff-slice|file-read>',
          'scope:',
          '- <scope item>',
          'required_evidence:',
          '- <evidence item>',
          'review_files_or_areas:',
          '- <path or area to inspect first>',
          'Keep the admission analysis above the block.',
        ].join('\n'),
        sharedClosingRule,
      ].join('\n\n');
    case 'lead':
      return [
        'You are the Lead role for a managed KodaX task.',
        decisionSummary,
        `Original task:\n${prompt}`,
        agentSection,
        contractSection,
        metadataSection,
        verificationSection,
        toolPolicySection,
        reviewEvidenceGuidance,
        'Break the work into clear ownership boundaries and success criteria.',
        'Call out the evidence the evaluator should require before accepting the task.',
        [
          `Append a final fenced block named \`\`\`${MANAGED_TASK_CONTRACT_BLOCK}\` with this exact shape:`,
          'summary: <one-line contract summary>',
          'success_criteria:',
          '- <criterion>',
          'required_evidence:',
          '- <evidence item>',
          'constraints:',
          '- <constraint or leave empty>',
        ].join('\n'),
        sharedClosingRule,
      ].join('\n\n');
    case 'planner':
      return [
        'You are the Planner role for a managed KodaX task.',
        decisionSummary,
        `Original task:\n${prompt}`,
        agentSection,
        contractSection,
        metadataSection,
        verificationSection,
        toolPolicySection,
        reviewEvidenceGuidance,
        'Produce a concise execution plan, the critical risks, and the evidence checklist.',
        'Do not perform the work yet and do not self-certify completion.',
        [
          `Append a final fenced block named \`\`\`${MANAGED_TASK_CONTRACT_BLOCK}\` with this exact shape:`,
          'summary: <one-line contract summary>',
          'success_criteria:',
          '- <criterion>',
          'required_evidence:',
          '- <evidence item>',
          'constraints:',
          '- <constraint or leave empty>',
        ].join('\n'),
        sharedClosingRule,
      ].join('\n\n');
    case 'generator':
      return [
        'You are the Generator role for a managed KodaX task.',
        decisionSummary,
        `Original task:\n${prompt}`,
        agentSection,
        contractSection,
        metadataSection,
        verificationSection,
        toolPolicySection,
        reviewPresentationRule,
        reviewEvidenceGuidance,
        'Read the managed task artifacts and dependency handoff artifacts before acting. Treat them as the primary coordination surface.',
        'Execute the task or produce the requested deliverable.',
        isTerminalAuthority
          ? 'You are the terminal delivery role for this run. Return the final user-facing answer and summarize concrete evidence inline.'
          : 'Leave final judgment to the evaluator and include a crisp evidence handoff.',
        isTerminalAuthority ? undefined : handoffBlockInstructions,
        sharedClosingRule,
      ].filter(Boolean).join('\n\n');
    case 'worker':
      return [
        isReviewHighRiskWorker
          ? 'You are the High-Risk Review Worker for a managed KodaX task.'
          : isReviewSurfaceWorker
            ? 'You are the Surface Review Worker for a managed KodaX task.'
            : 'You are a specialist Worker role for a managed KodaX task.',
        decisionSummary,
        `Original task:\n${prompt}`,
        agentSection,
        contractSection,
        metadataSection,
        verificationSection,
        toolPolicySection,
        reviewEvidenceGuidance,
        'Read the managed task artifacts and dependency handoff artifacts before acting. Treat them as the primary coordination surface.',
        isReviewHighRiskWorker
          ? 'Own the highest-risk review slice: correctness, security, runtime failures, and merge blockers. Produce evidence-backed findings only.'
          : isReviewSurfaceWorker
            ? 'Own the review surface slice: API regressions, maintainability, test gaps, and broader regression risk. Produce evidence-backed findings only.'
            : 'Own the implementation work for your assigned slice and report evidence, changed areas, and residual risks.',
        'Do not overstep into evaluator judgment.',
        handoffBlockInstructions,
        sharedClosingRule,
      ].join('\n\n');
    case 'validator':
      if (isContractReview) {
        return [
          'You are the Contract Reviewer role for a managed KodaX task.',
          decisionSummary,
          `Original task:\n${prompt}`,
          agentSection,
          contractSection,
          metadataSection,
          verificationSection,
          toolPolicySection,
          reviewEvidenceGuidance,
          'Review the proposed task contract before implementation begins.',
          'Read the dependency handoff artifacts first, especially the structured handoff bundle and any contract files produced by planner or lead.',
          'Approve only if the planned scope, success criteria, required evidence, and constraints are concrete enough to verify.',
          'Use status=revise when the contract needs replanning or tighter success criteria before implementation should start.',
          'Use status=blocked when the task cannot responsibly proceed because key information is missing or contradictory.',
          [
            `Append a final fenced block named \`\`\`${MANAGED_TASK_CONTRACT_REVIEW_BLOCK}\` with this exact shape:`,
            'status: approve|revise|blocked',
            'reason: <one-line reason>',
            'next_harness: <optional H2_PLAN_EXECUTE_EVAL|H3_MULTI_WORKER when revise requires a stronger harness>',
            'followup:',
            '- <required next step>',
            '- <optional second next step>',
            'Keep the contract review above the block.',
          ].join('\n'),
          sharedClosingRule,
        ].join('\n\n');
      }

      return [
        'You are the Validator role for a managed KodaX task.',
        decisionSummary,
        `Original task:\n${prompt}`,
        agentSection,
        contractSection,
        metadataSection,
        verificationSection,
        toolPolicySection,
        reviewEvidenceGuidance,
        'Read the managed task artifacts and dependency handoff artifacts before acting. Treat them as the primary coordination surface.',
        'Independently look for gaps, missing evidence, risky assumptions, and verification needs.',
        'Execute the verification contract directly when it calls for tests, browser checks, or other validation tools.',
        'Treat implementation outputs as suspect until supported by concrete evidence.',
        handoffBlockInstructions,
        sharedClosingRule,
      ].join('\n\n');
    case 'evaluator':
      return [
        'You are the Evaluator role for a managed KodaX task.',
        decisionSummary,
        `Original task:\n${prompt}`,
        agentSection,
        contractSection,
        metadataSection,
        verificationSection,
        toolPolicySection,
        reviewPresentationRule,
        reviewEvidenceGuidance,
        'Read the managed task artifacts and dependency handoff artifacts before acting. Treat them as the primary coordination surface.',
        'Judge whether the dependency handoff satisfies the original task and whether the evidence is strong enough.',
        'You own the final verification pass and must personally execute any required checks or browser validation before accepting the task.',
        'Evaluate the task against the verification criteria and thresholds. If any hard threshold is not met, do not accept the task.',
        'Return the final user-facing answer. If the task is not ready, explain the blocker or missing evidence clearly.',
        'If the original task requires an exact closing block, include it in your final answer when you conclude.',
        [
          `Append a final fenced block named \`\`\`${MANAGED_TASK_VERDICT_BLOCK}\` with this exact shape:`,
          `status: accept|revise|blocked`,
          'reason: <one-line reason>',
          'next_harness: <optional H2_PLAN_EXECUTE_EVAL|H3_MULTI_WORKER when revise requires a stronger harness>',
          'followup:',
          '- <required next step>',
          '- <optional second next step>',
          'Keep the user-facing answer above the block. Use status=revise when more execution should happen before acceptance.',
        ].join('\n'),
      ].join('\n\n');
    case 'direct':
    default:
      return prompt;
  }
}

function buildManagedTaskWorkers(
  prompt: string,
  decision: KodaXTaskRoutingDecision,
  metadata: Record<string, KodaXJsonValue> | undefined,
  verification: KodaXTaskVerificationContract | undefined,
  qualityAssuranceMode: ManagedTaskQualityAssuranceMode,
  phase: 'initial' | 'refinement' = 'initial',
): { terminalWorkerId: string; workers: ManagedTaskWorkerSpec[] } {
  const evaluatorRequired = qualityAssuranceMode === 'required' || decision.harnessProfile === 'H3_MULTI_WORKER';
  const isReviewH3 = decision.primaryTask === 'review' && decision.harnessProfile === 'H3_MULTI_WORKER';
  const createWorker = (
    id: string,
    title: string,
    role: KodaXTaskRole,
    isTerminalAuthority: boolean,
    dependsOn?: string[],
    execution?: ManagedTaskWorkerSpec['execution'],
  ): ManagedTaskWorkerSpec => {
    const agent = buildManagedWorkerAgent(role, id);
    const toolPolicy = buildManagedWorkerToolPolicy(role, verification);
    const worker: ManagedTaskWorkerSpec = {
      id,
      title,
      role,
      terminalAuthority: isTerminalAuthority,
      dependsOn,
      execution,
      agent,
      toolPolicy,
      metadata: {
        role,
        agent,
      },
      prompt: createRolePrompt(role, prompt, decision, verification, toolPolicy, agent, metadata, id, isTerminalAuthority),
    };
    worker.beforeToolExecute = createToolPolicyHook(worker);
    return worker;
  };

  if (phase === 'refinement') {
    if (decision.harnessProfile === 'H3_MULTI_WORKER') {
      return {
        terminalWorkerId: 'evaluator',
        workers: [
          createWorker('lead', 'Lead', 'lead', false),
          createWorker('planner', 'Planner', 'planner', false, ['lead']),
          createWorker('contract-review', 'Contract Reviewer', 'validator', false, ['lead', 'planner']),
          ...(isReviewH3
            ? [
              createWorker('review-worker-high-risk', 'High-Risk Review Worker', 'worker', false, ['contract-review'], 'parallel'),
              createWorker('review-worker-surface', 'Surface Review Worker', 'worker', false, ['contract-review'], 'parallel'),
            ]
            : [
              createWorker('worker-implementation', 'Implementation Worker', 'worker', false, ['contract-review'], 'parallel'),
              createWorker('worker-validation', 'Validation Worker', 'validator', false, ['contract-review'], 'parallel'),
            ]),
          createWorker(
            'evaluator',
            'Evaluator',
            'evaluator',
            true,
            isReviewH3
              ? ['lead', 'planner', 'contract-review', 'review-worker-high-risk', 'review-worker-surface']
              : ['lead', 'planner', 'contract-review', 'worker-implementation', 'worker-validation'],
          ),
        ],
      };
    }

    if (!evaluatorRequired) {
      return {
        terminalWorkerId: 'generator',
        workers: [
          ...(decision.harnessProfile === 'H2_PLAN_EXECUTE_EVAL'
            ? [createWorker('planner', 'Planner', 'planner', false)]
            : []),
          ...(decision.harnessProfile === 'H2_PLAN_EXECUTE_EVAL'
            ? [createWorker('contract-review', 'Contract Reviewer', 'validator', false, ['planner'])]
            : []),
          createWorker(
            'generator',
            'Generator',
            'generator',
            true,
            decision.harnessProfile === 'H2_PLAN_EXECUTE_EVAL' ? ['contract-review'] : undefined,
          ),
        ],
      };
    }

    return {
      terminalWorkerId: 'evaluator',
      workers: [
        ...(decision.harnessProfile === 'H2_PLAN_EXECUTE_EVAL'
          ? [createWorker('planner', 'Planner', 'planner', false)]
          : []),
        ...(decision.harnessProfile === 'H2_PLAN_EXECUTE_EVAL'
          ? [createWorker('contract-review', 'Contract Reviewer', 'validator', false, ['planner'])]
          : []),
        createWorker(
          'generator',
          'Generator',
          'generator',
          false,
          decision.harnessProfile === 'H2_PLAN_EXECUTE_EVAL' ? ['contract-review'] : undefined,
        ),
        createWorker(
          'evaluator',
          'Evaluator',
          'evaluator',
          true,
          decision.harnessProfile === 'H2_PLAN_EXECUTE_EVAL'
            ? ['planner', 'contract-review', 'generator']
            : ['generator'],
        ),
      ],
    };
  }

  if (decision.harnessProfile === 'H1_EXECUTE_EVAL') {
    if (!evaluatorRequired) {
      const admission = createWorker('admission', 'Admission', 'admission', false);
      const generator = createWorker('generator', 'Generator', 'generator', true, ['admission']);
      return {
        terminalWorkerId: 'generator',
        workers: [
          ...(phase === 'initial' ? [admission] : []),
          phase === 'initial'
            ? generator
            : createWorker('generator', 'Generator', 'generator', true),
        ],
      };
    }

    const admission = createWorker('admission', 'Admission', 'admission', false);
    return {
      terminalWorkerId: 'evaluator',
      workers: [
        ...(phase === 'initial' ? [admission] : []),
        createWorker('generator', 'Generator', 'generator', false, phase === 'initial' ? ['admission'] : undefined),
        createWorker('evaluator', 'Evaluator', 'evaluator', true, ['generator']),
      ],
    };
  }

  if (decision.harnessProfile === 'H2_PLAN_EXECUTE_EVAL') {
    if (!evaluatorRequired) {
      const admissionDependsOn = phase === 'initial' ? ['admission'] : undefined;
      return {
        terminalWorkerId: 'generator',
        workers: [
          ...(phase === 'initial' ? [createWorker('admission', 'Admission', 'admission', false)] : []),
          createWorker('planner', 'Planner', 'planner', false, admissionDependsOn),
          createWorker('contract-review', 'Contract Reviewer', 'validator', false, ['planner']),
          createWorker('generator', 'Generator', 'generator', true, ['contract-review']),
        ],
      };
    }

    const admissionDependsOn = phase === 'initial' ? ['admission'] : undefined;
    return {
      terminalWorkerId: 'evaluator',
      workers: [
        ...(phase === 'initial' ? [createWorker('admission', 'Admission', 'admission', false)] : []),
        createWorker('planner', 'Planner', 'planner', false, admissionDependsOn),
        createWorker('contract-review', 'Contract Reviewer', 'validator', false, ['planner']),
        createWorker('generator', 'Generator', 'generator', false, ['contract-review']),
        createWorker('evaluator', 'Evaluator', 'evaluator', true, ['planner', 'contract-review', 'generator']),
      ],
    };
  }

  const admissionDependsOn = phase === 'initial' ? ['admission'] : undefined;
  return {
    terminalWorkerId: 'evaluator',
    workers: [
      ...(phase === 'initial' ? [createWorker('admission', 'Admission', 'admission', false)] : []),
      createWorker('lead', 'Lead', 'lead', false, admissionDependsOn),
      createWorker('planner', 'Planner', 'planner', false, ['lead']),
      createWorker('contract-review', 'Contract Reviewer', 'validator', false, ['lead', 'planner']),
      ...(isReviewH3
        ? [
          createWorker('review-worker-high-risk', 'High-Risk Review Worker', 'worker', false, ['contract-review'], 'parallel'),
          createWorker('review-worker-surface', 'Surface Review Worker', 'worker', false, ['contract-review'], 'parallel'),
        ]
        : [
          createWorker('worker-implementation', 'Implementation Worker', 'worker', false, ['contract-review'], 'parallel'),
          createWorker('worker-validation', 'Validation Worker', 'validator', false, ['contract-review'], 'parallel'),
        ]),
      createWorker(
        'evaluator',
        'Evaluator',
        'evaluator',
        true,
        isReviewH3
          ? ['lead', 'planner', 'contract-review', 'review-worker-high-risk', 'review-worker-surface']
          : ['lead', 'planner', 'contract-review', 'worker-implementation', 'worker-validation'],
      ),
    ],
  };
}

function stripAdmissionFromWorkerSet(
  workerSet: { terminalWorkerId: string; workers: ManagedTaskWorkerSpec[] },
): { terminalWorkerId: string; workers: ManagedTaskWorkerSpec[] } {
  return {
    terminalWorkerId: workerSet.terminalWorkerId,
    workers: workerSet.workers
      .filter((worker) => worker.role !== 'admission')
      .map((worker) => ({
        ...worker,
        dependsOn: worker.dependsOn?.filter((dependency) => dependency !== 'admission'),
      })),
  };
}

function applyAdmissionDirective(
  task: KodaXManagedTask,
  directive: ManagedTaskAdmissionDirective | undefined,
): KodaXManagedTask {
  if (!directive) {
    return task;
  }

  const mergedEvidence = directive.requiredEvidence.length > 0
    ? Array.from(new Set([...task.contract.requiredEvidence, ...directive.requiredEvidence]))
    : task.contract.requiredEvidence;
  const reviewFilesOrAreas = directive.reviewFilesOrAreas?.filter(Boolean) ?? [];

  return {
    ...task,
    contract: {
      ...task.contract,
      contractSummary: directive.summary ?? task.contract.contractSummary,
      requiredEvidence: mergedEvidence,
      updatedAt: new Date().toISOString(),
    },
    runtime: {
      ...task.runtime,
      admissionSummary: directive.summary,
      reviewFilesOrAreas: reviewFilesOrAreas.length > 0
        ? Array.from(new Set([...(task.runtime?.reviewFilesOrAreas ?? []), ...reviewFilesOrAreas]))
        : task.runtime?.reviewFilesOrAreas,
      evidenceAcquisitionMode: directive.evidenceAcquisitionMode
        ? mergeEvidenceAcquisitionMode(task.runtime?.evidenceAcquisitionMode, directive.evidenceAcquisitionMode)
        : task.runtime?.evidenceAcquisitionMode ?? 'overview',
    },
  };
}

function createTaskShape(
  options: KodaXOptions,
  prompt: string,
  plan: ReasoningPlan,
): ManagedTaskShape {
  const taskId = `task-${randomUUID()}`;
  const surface = getManagedTaskSurface(options);
  const workspaceDir = path.join(getManagedTaskWorkspaceRoot(options, surface), taskId);
  const createdAt = new Date().toISOString();
  const qualityAssuranceMode = resolveManagedTaskQualityAssuranceMode(options, plan);
  const normalizedVerification = options.context?.taskVerification
    ? {
        ...options.context.taskVerification,
        rubricFamily: inferVerificationRubricFamily(options.context.taskVerification, plan.decision.primaryTask),
        criteria: resolveVerificationCriteria(options.context.taskVerification, plan.decision.primaryTask),
        runtime: deriveRuntimeVerificationContract(options.context.taskVerification, options),
      }
    : undefined;

  if (plan.decision.harnessProfile === 'H0_DIRECT') {
    const task: KodaXManagedTask = {
      contract: {
        taskId,
        surface,
        objective: prompt,
        createdAt,
        updatedAt: createdAt,
        status: 'running',
        primaryTask: plan.decision.primaryTask,
        workIntent: plan.decision.workIntent,
        complexity: plan.decision.complexity,
        riskLevel: plan.decision.riskLevel,
        harnessProfile: plan.decision.harnessProfile,
        recommendedMode: plan.decision.recommendedMode,
        requiresBrainstorm: plan.decision.requiresBrainstorm,
        reason: plan.decision.reason,
        contractSummary: undefined,
        successCriteria: [],
        requiredEvidence: options.context?.taskVerification?.requiredEvidence ?? [],
        constraints: [],
        metadata: options.context?.taskMetadata,
        verification: normalizedVerification,
      },
      roleAssignments: [
        {
          id: 'direct',
          role: 'direct',
          title: 'Direct Agent',
          dependsOn: [],
          status: 'running',
        },
      ],
      workItems: [
        {
          id: 'direct',
          assignmentId: 'direct',
          description: 'Handle the task directly in a single-agent fallback run.',
          execution: 'serial',
        },
      ],
      evidence: {
        workspaceDir,
        artifacts: [],
        entries: [],
        routingNotes: plan.decision.routingNotes ?? [],
      },
      verdict: {
        status: 'running',
        decidedByAssignmentId: 'direct',
        summary: 'Task is running in direct fallback mode.',
      },
      runtime: {
        routingAttempts: plan.decision.routingAttempts,
        routingSource: plan.decision.routingSource,
        currentHarness: plan.decision.harnessProfile,
        upgradeCeiling: plan.decision.upgradeCeiling,
        harnessTransitions: [],
      },
    };

    return {
      task,
      terminalWorkerId: 'direct',
      workers: [],
      workspaceDir,
      routingPromptOverlay: plan.promptOverlay,
      qualityAssuranceMode: 'required',
      providerPolicy: plan.providerPolicy,
    };
  }

  const workerSet = buildManagedTaskWorkers(
    prompt,
    plan.decision,
    options.context?.taskMetadata,
    normalizedVerification,
    qualityAssuranceMode,
  );
  const task: KodaXManagedTask = {
    contract: {
      taskId,
      surface,
      objective: prompt,
      createdAt,
      updatedAt: createdAt,
      status: 'running',
      primaryTask: plan.decision.primaryTask,
      workIntent: plan.decision.workIntent,
      complexity: plan.decision.complexity,
      riskLevel: plan.decision.riskLevel,
      harnessProfile: plan.decision.harnessProfile,
      recommendedMode: plan.decision.recommendedMode,
      requiresBrainstorm: plan.decision.requiresBrainstorm,
      reason: plan.decision.reason,
      contractSummary: undefined,
      successCriteria: [],
      requiredEvidence: options.context?.taskVerification?.requiredEvidence ?? [],
      constraints: [],
      metadata: options.context?.taskMetadata,
      verification: normalizedVerification,
    },
    roleAssignments: workerSet.workers.map((worker) => ({
      id: worker.id,
      role: worker.role,
      title: worker.title,
      dependsOn: worker.dependsOn ?? [],
      status: 'planned',
      agent: worker.agent,
      toolPolicy: worker.toolPolicy,
    })),
    workItems: workerSet.workers.map((worker) => ({
      id: worker.id,
      assignmentId: worker.id,
      description: worker.title,
      execution: worker.execution ?? 'serial',
    })),
    evidence: {
      workspaceDir,
      artifacts: [],
      entries: [],
      routingNotes: plan.decision.routingNotes ?? [],
    },
    verdict: {
      status: 'running',
      decidedByAssignmentId: workerSet.terminalWorkerId,
      summary: 'Task is running under the managed task engine.',
    },
    runtime: {
      routingAttempts: plan.decision.routingAttempts,
      routingSource: plan.decision.routingSource,
      currentHarness: plan.decision.harnessProfile,
      upgradeCeiling: plan.decision.upgradeCeiling,
      harnessTransitions: [],
    },
  };

  return {
    task,
    terminalWorkerId: workerSet.terminalWorkerId,
    workers: workerSet.workers,
    workspaceDir,
    routingPromptOverlay: plan.promptOverlay,
    qualityAssuranceMode,
    providerPolicy: plan.providerPolicy,
  };
}

function extractMessageText(result: Partial<KodaXResult> | undefined): string {
  if (!result) {
    return '';
  }

  if (typeof result.lastText === 'string' && result.lastText.trim()) {
    return result.lastText;
  }

  const lastMessage = result.messages?.[result.messages.length - 1];
  if (!lastMessage) {
    return '';
  }

  if (typeof lastMessage.content === 'string') {
    return lastMessage.content;
  }

  return lastMessage.content
    .map((part) => ('text' in part ? part.text : '') || '')
    .join('');
}

function replaceLastAssistantMessage(messages: KodaXResult['messages'], text: string): KodaXResult['messages'] {
  if (messages.length === 0) {
    return [{ role: 'assistant', content: text }];
  }

  const nextMessages = [...messages];
  for (let index = nextMessages.length - 1; index >= 0; index -= 1) {
    const message = nextMessages[index];
    if (message?.role !== 'assistant') {
      continue;
    }

    nextMessages[index] = {
      ...message,
      content: text,
    };
    return nextMessages;
  }

  nextMessages.push({ role: 'assistant', content: text });
  return nextMessages;
}

const MANAGED_CONTROL_PLANE_MARKERS = [
  '[Managed Task Protocol Retry]',
  'Assigned native agent identity:',
  'Tool policy:',
  'Blocked tools:',
  'Allowed shell patterns:',
  'Dependency handoff artifacts:',
  'Dependency summary preview:',
  'Preferred agent:',
  'Read structured bundle first:',
  'Read human summary next:',
];

function sanitizeManagedUserFacingText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return '';
  }
  let cutIndex = -1;
  for (const marker of MANAGED_CONTROL_PLANE_MARKERS) {
    const index = trimmed.indexOf(marker);
    if (index >= 0 && (cutIndex === -1 || index < cutIndex)) {
      cutIndex = index;
    }
  }
  if (cutIndex === 0) {
    return '';
  }
  return (cutIndex > 0 ? trimmed.slice(0, cutIndex) : trimmed).trim();
}

function parseManagedTaskAdmissionDirective(text: string): ManagedTaskAdmissionDirective | undefined {
  const match = text.match(new RegExp(String.raw`(?:\r?\n)?\`\`\`${MANAGED_TASK_ADMISSION_BLOCK}\s*([\s\S]*?)\`\`\`\s*$`, 'i'));
  if (!match) {
    return undefined;
  }

  const body = match[1]?.trim() ?? '';
  let summary: string | undefined;
  let confirmedHarness: ManagedTaskAdmissionDirective['confirmedHarness'];
  let evidenceAcquisitionMode: ManagedTaskAdmissionDirective['evidenceAcquisitionMode'];
  const scope: string[] = [];
  const requiredEvidence: string[] = [];
  const reviewFilesOrAreas: string[] = [];
  let currentList: 'scope' | 'evidence' | 'review-files' | undefined;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const normalized = line.toLowerCase();
    if (normalized.startsWith('summary:')) {
      summary = line.slice('summary:'.length).trim();
      currentList = undefined;
      continue;
    }
    if (normalized.startsWith('confirmed_harness:')) {
      const candidate = line.slice('confirmed_harness:'.length).trim();
      if (candidate === 'H1_EXECUTE_EVAL' || candidate === 'H2_PLAN_EXECUTE_EVAL' || candidate === 'H3_MULTI_WORKER') {
        confirmedHarness = candidate;
      }
      currentList = undefined;
      continue;
    }
    if (normalized.startsWith('evidence_acquisition_mode:')) {
      const candidate = line.slice('evidence_acquisition_mode:'.length).trim();
      if (candidate === 'overview' || candidate === 'diff-bundle' || candidate === 'diff-slice' || candidate === 'file-read') {
        evidenceAcquisitionMode = candidate;
      }
      currentList = undefined;
      continue;
    }
    if (normalized.startsWith('scope:')) {
      currentList = 'scope';
      continue;
    }
    if (normalized.startsWith('required_evidence:')) {
      currentList = 'evidence';
      continue;
    }
    if (normalized.startsWith('review_files_or_areas:')) {
      currentList = 'review-files';
      continue;
    }

    const item = line.replace(/^-+\s*/, '').trim();
    if (!item || !currentList) {
      continue;
    }
    if (currentList === 'scope') {
      scope.push(item);
    } else if (currentList === 'evidence') {
      requiredEvidence.push(item);
    } else {
      reviewFilesOrAreas.push(item);
    }
  }

  if (
    !summary
    && scope.length === 0
    && requiredEvidence.length === 0
    && reviewFilesOrAreas.length === 0
    && !confirmedHarness
    && !evidenceAcquisitionMode
  ) {
    return undefined;
  }

  return {
    summary,
    scope: scope.filter(Boolean),
    requiredEvidence: requiredEvidence.filter(Boolean),
    reviewFilesOrAreas: reviewFilesOrAreas.filter(Boolean),
    evidenceAcquisitionMode,
    confirmedHarness,
  };
}

function parseManagedTaskHandoffDirective(text: string): ManagedTaskHandoffDirective | undefined {
  const match = text.match(new RegExp(String.raw`(?:\r?\n)?\`\`\`${MANAGED_TASK_HANDOFF_BLOCK}\s*([\s\S]*?)\`\`\`\s*$`, 'i'));
  if (!match) {
    return undefined;
  }

  const body = match[1]?.trim() ?? '';
  const visibleText = sanitizeManagedUserFacingText(text.slice(0, match.index ?? text.length).trim());
  let status: ManagedTaskHandoffDirective['status'] | undefined;
  let summary: string | undefined;
  const evidence: string[] = [];
  const followup: string[] = [];
  let currentList: 'evidence' | 'followup' | undefined;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const normalized = line.toLowerCase();
    if (normalized.startsWith('status:')) {
      const candidate = line.slice('status:'.length).trim().toLowerCase();
      if (candidate === 'ready' || candidate === 'incomplete' || candidate === 'blocked') {
        status = candidate;
      }
      currentList = undefined;
      continue;
    }
    if (normalized.startsWith('summary:')) {
      summary = line.slice('summary:'.length).trim();
      currentList = undefined;
      continue;
    }
    if (normalized.startsWith('evidence:')) {
      currentList = 'evidence';
      continue;
    }
    if (normalized.startsWith('followup:')) {
      currentList = 'followup';
      continue;
    }

    const item = line.replace(/^-+\s*/, '').trim();
    if (!item || !currentList) {
      continue;
    }
    if (currentList === 'evidence') {
      evidence.push(item);
    } else {
      followup.push(item);
    }
  }

  if (!status) {
    return undefined;
  }

  return {
    status,
    summary,
    evidence: evidence.filter(Boolean),
    followup: followup.filter(Boolean),
    userFacingText: visibleText,
  };
}

function parseManagedTaskVerdictDirective(text: string): ManagedTaskVerdictDirective | undefined {
  const match = text.match(new RegExp(String.raw`(?:\r?\n)?\`\`\`${MANAGED_TASK_VERDICT_BLOCK}\s*([\s\S]*?)\`\`\`\s*$`, 'i'));
  if (!match) {
    return undefined;
  }

  const body = match[1]?.trim() ?? '';
  const visibleText = sanitizeManagedUserFacingText(text.slice(0, match.index ?? text.length).trim());
  let status: ManagedTaskVerdictDirective['status'] | undefined;
  let reason: string | undefined;
  let nextHarness: ManagedTaskVerdictDirective['nextHarness'];
  const followups: string[] = [];
  let inFollowups = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (line.toLowerCase().startsWith('status:')) {
      const candidate = line.slice('status:'.length).trim().toLowerCase();
      if (candidate === 'accept' || candidate === 'revise' || candidate === 'blocked') {
        status = candidate;
      }
      inFollowups = false;
      continue;
    }
      if (line.toLowerCase().startsWith('reason:')) {
        reason = line.slice('reason:'.length).trim();
        inFollowups = false;
        continue;
      }
      if (line.toLowerCase().startsWith('next_harness:')) {
        const candidate = line.slice('next_harness:'.length).trim();
        if (candidate === 'H1_EXECUTE_EVAL' || candidate === 'H2_PLAN_EXECUTE_EVAL' || candidate === 'H3_MULTI_WORKER') {
          nextHarness = candidate;
        }
        inFollowups = false;
        continue;
      }
      if (line.toLowerCase().startsWith('followup:')) {
        inFollowups = true;
        continue;
      }
    if (inFollowups) {
      followups.push(line.replace(/^-+\s*/, '').trim());
    }
  }

  if (!status) {
    return undefined;
  }

  return {
    source: 'evaluator',
      status,
      reason,
      nextHarness,
      followups: followups.filter(Boolean),
      userFacingText: visibleText,
    };
  }

function parseManagedTaskContractReviewDirective(
  text: string,
): ManagedTaskVerdictDirective | undefined {
  const match = text.match(new RegExp(String.raw`(?:\r?\n)?\`\`\`${MANAGED_TASK_CONTRACT_REVIEW_BLOCK}\s*([\s\S]*?)\`\`\`\s*$`, 'i'));
  if (!match) {
    return undefined;
  }

  const body = match[1]?.trim() ?? '';
  const visibleText = sanitizeManagedUserFacingText(text.replace(match[0], '').trim());
  let status: ManagedTaskVerdictDirective['status'] = 'blocked';
  let reason: string | undefined;
  let nextHarness: ManagedTaskVerdictDirective['nextHarness'];
  const followups: string[] = [];
  let inFollowups = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const normalized = line.toLowerCase();
    if (normalized.startsWith('status:')) {
      const value = line.slice('status:'.length).trim().toLowerCase();
      if (value === 'approve' || value === 'accept') {
        status = 'accept';
      } else if (value === 'revise') {
        status = 'revise';
      } else {
        status = 'blocked';
      }
      inFollowups = false;
      continue;
    }
      if (normalized.startsWith('reason:')) {
        reason = line.slice('reason:'.length).trim();
        inFollowups = false;
        continue;
      }
      if (normalized.startsWith('next_harness:')) {
        const candidate = line.slice('next_harness:'.length).trim();
        if (candidate === 'H1_EXECUTE_EVAL' || candidate === 'H2_PLAN_EXECUTE_EVAL' || candidate === 'H3_MULTI_WORKER') {
          nextHarness = candidate;
        }
        inFollowups = false;
        continue;
      }
      if (normalized.startsWith('followup:')) {
        inFollowups = true;
        continue;
      }
    if (inFollowups) {
      const item = line.replace(/^-+\s*/, '').trim();
      if (item) {
        followups.push(item);
      }
    }
  }

  return {
      source: 'contract-review',
      status,
      reason,
      nextHarness,
      followups: followups.filter(Boolean),
      userFacingText: visibleText,
    };
  }

function parseManagedTaskContractDirective(text: string): ManagedTaskContractDirective | undefined {
  const match = text.match(new RegExp(String.raw`(?:\r?\n)?\`\`\`${MANAGED_TASK_CONTRACT_BLOCK}\s*([\s\S]*?)\`\`\`\s*$`, 'i'));
  if (!match) {
    return undefined;
  }

  const body = match[1]?.trim() ?? '';
  let summary: string | undefined;
  const successCriteria: string[] = [];
  const requiredEvidence: string[] = [];
  const constraints: string[] = [];
  let currentList: 'success' | 'evidence' | 'constraints' | undefined;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const normalized = line.toLowerCase();
    if (normalized.startsWith('summary:')) {
      summary = line.slice('summary:'.length).trim();
      currentList = undefined;
      continue;
    }
    if (normalized.startsWith('success_criteria:')) {
      currentList = 'success';
      continue;
    }
    if (normalized.startsWith('required_evidence:')) {
      currentList = 'evidence';
      continue;
    }
    if (normalized.startsWith('constraints:')) {
      currentList = 'constraints';
      continue;
    }

    const item = line.replace(/^-+\s*/, '').trim();
    if (!item || !currentList) {
      continue;
    }

    if (currentList === 'success') {
      successCriteria.push(item);
    } else if (currentList === 'evidence') {
      requiredEvidence.push(item);
    } else {
      constraints.push(item);
    }
  }

  if (!summary && successCriteria.length === 0 && requiredEvidence.length === 0 && constraints.length === 0) {
    return undefined;
  }

  return {
    summary,
    successCriteria: successCriteria.filter(Boolean),
    requiredEvidence: requiredEvidence.filter(Boolean),
    constraints: constraints.filter(Boolean),
  };
}

function parseBudgetExtensionRequest(text: string): KodaXBudgetExtensionRequest | undefined {
  const match = text.match(new RegExp(String.raw`(?:\r?\n)?\`\`\`${MANAGED_TASK_BUDGET_REQUEST_BLOCK}\s*([\s\S]*?)\`\`\`\s*$`, 'i'));
  if (!match) {
    return undefined;
  }

  let requestedIters: KodaXBudgetExtensionRequest['requestedIters'] | undefined;
  let reason = '';
  let completionExpectation = '';
  let confidenceToFinish = 0;
  let fallbackIfDenied = '';

  for (const rawLine of (match[1]?.trim() ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const normalized = line.toLowerCase();
    if (normalized.startsWith('requestediters:') || normalized.startsWith('requested_iters:')) {
      const value = Number(line.split(':').slice(1).join(':').trim());
      if (value === 1 || value === 2 || value === 3) {
        requestedIters = value;
      }
      continue;
    }
    if (normalized.startsWith('reason:')) {
      reason = line.slice('reason:'.length).trim();
      continue;
    }
    if (normalized.startsWith('completionexpectation:') || normalized.startsWith('completion_expectation:')) {
      completionExpectation = line.split(':').slice(1).join(':').trim();
      continue;
    }
    if (normalized.startsWith('confidencetofinish:') || normalized.startsWith('confidence_to_finish:')) {
      confidenceToFinish = clampNumber(Number(line.split(':').slice(1).join(':').trim()), 0, 1);
      continue;
    }
    if (normalized.startsWith('fallbackifdenied:') || normalized.startsWith('fallback_if_denied:')) {
      fallbackIfDenied = line.split(':').slice(1).join(':').trim();
    }
  }

  if (!requestedIters || !reason || !completionExpectation || !fallbackIfDenied) {
    return undefined;
  }

  return {
    requestedIters,
    reason,
    completionExpectation,
    confidenceToFinish,
    fallbackIfDenied,
  };
}

function createVerificationScorecard(
  task: KodaXManagedTask,
  directive: ManagedTaskVerdictDirective | undefined,
): KodaXVerificationScorecard | undefined {
  const verification = task.contract.verification;
  if (!verification) {
    return undefined;
  }

  const criteria = resolveVerificationCriteria(verification, task.contract.primaryTask).map((criterion) => {
    const evidence = [
      ...(criterion.requiredEvidence ?? []),
      ...task.evidence.entries
        .filter((entry) => entry.status === 'completed' && entry.summary)
        .map((entry) => entry.summary!)
        .slice(-2),
    ];
    const verdictScore = directive?.status === 'accept'
      ? 100
      : directive?.status === 'revise'
        ? 45
        : task.verdict.status === 'completed'
          ? 90
          : task.verdict.status === 'blocked'
            ? 35
            : 55;
    const score = clampNumber(verdictScore, 0, 100);
    return {
      id: criterion.id,
      label: criterion.label,
      threshold: criterion.threshold,
      score,
      passed: score >= criterion.threshold,
      weight: criterion.weight,
      requiredEvidence: criterion.requiredEvidence,
      evidence,
      reason: directive?.reason,
    };
  });

  const totalWeight = criteria.reduce((sum, criterion) => sum + criterion.weight, 0) || 1;
  const overallScore = clampNumber(
    Math.round(
      criteria.reduce((sum, criterion) => sum + criterion.score * criterion.weight, 0) / totalWeight,
    ),
    0,
    100,
  );
  const verdict = criteria.every((criterion) => criterion.passed)
    ? 'accept'
    : directive?.status === 'blocked' || task.verdict.status === 'blocked'
      ? 'blocked'
      : 'revise';

  return {
    rubricFamily: inferVerificationRubricFamily(verification, task.contract.primaryTask),
    overallScore,
    verdict,
    criteria,
    trend: directive?.status === 'accept' ? 'improving' : directive?.status === 'revise' ? 'flat' : 'regressing',
    summary: directive?.reason ?? task.verdict.summary,
  };
}

function sanitizeManagedWorkerResult(
  result: KodaXResult,
  options?: { enforceVerdictBlock?: boolean },
): { result: KodaXResult; directive?: ManagedTaskVerdictDirective } {
  const text = extractMessageText(result) || result.lastText;
  const directive = parseManagedTaskVerdictDirective(text);
  if (!directive) {
    if (options?.enforceVerdictBlock) {
      const reason = `Evaluator response omitted required ${MANAGED_TASK_VERDICT_BLOCK} block.`;
      return {
        directive: {
          source: 'evaluator',
          status: 'blocked',
          reason,
          followups: [
            `Re-run the evaluator and require a final ${MANAGED_TASK_VERDICT_BLOCK} fenced block with accept, revise, or blocked.`,
          ],
          userFacingText: text,
        },
        result,
      };
    }
    return { result };
  }

  const sanitizedText = directive.userFacingText || text;
  return {
    directive,
    result: {
      ...result,
      lastText: sanitizedText,
      messages: replaceLastAssistantMessage(result.messages, sanitizedText),
    },
  };
}

function sanitizeContractResult(
  result: KodaXResult,
): { result: KodaXResult; directive?: ManagedTaskContractDirective } {
  const text = extractMessageText(result) || result.lastText;
  const directive = parseManagedTaskContractDirective(text);
  if (!directive) {
    return { result };
  }

  const sanitizedText = directive.summary || sanitizeManagedUserFacingText(text) || text;
  return {
    directive,
    result: {
      ...result,
      lastText: sanitizedText,
      messages: replaceLastAssistantMessage(result.messages, sanitizedText),
    },
  };
}

function sanitizeAdmissionResult(
  result: KodaXResult,
): { result: KodaXResult; directive?: ManagedTaskAdmissionDirective } {
  const text = extractMessageText(result) || result.lastText;
  const directive = parseManagedTaskAdmissionDirective(text);
  if (!directive) {
    const reason = `Admission response omitted required ${MANAGED_TASK_ADMISSION_BLOCK} block.`;
    return {
      directive: undefined,
      result: {
        ...result,
        success: false,
        signal: 'BLOCKED',
        signalReason: reason,
      },
    };
  }

  return {
    directive,
    result: {
      ...result,
      lastText: directive.summary || text,
      messages: replaceLastAssistantMessage(result.messages, directive.summary || text),
    },
  };
}

function sanitizeHandoffResult(
  result: KodaXResult,
  roleTitle: string,
): { result: KodaXResult; directive?: ManagedTaskHandoffDirective } {
  const text = extractMessageText(result) || result.lastText;
  const directive = parseManagedTaskHandoffDirective(text);
  if (!directive) {
    const reason = `${roleTitle} response omitted required ${MANAGED_TASK_HANDOFF_BLOCK} block.`;
    return {
      directive: undefined,
      result: {
        ...result,
        success: false,
        signal: 'BLOCKED',
        signalReason: reason,
      },
    };
  }

  const sanitizedText = directive.userFacingText || directive.summary || text;
  const signal = directive.status === 'blocked' ? 'BLOCKED' : result.signal;
  const signalReason = directive.status === 'blocked'
    ? directive.summary || result.signalReason || `${roleTitle} reported a blocked handoff.`
    : directive.status === 'incomplete'
      ? directive.summary || result.signalReason || `${roleTitle} reported an incomplete handoff.`
      : result.signalReason;
  return {
    directive,
    result: {
      ...result,
      success: directive.status === 'ready',
      lastText: sanitizedText,
      messages: replaceLastAssistantMessage(result.messages, sanitizedText),
      signal,
      signalReason,
    },
  };
}

function sanitizeContractReviewResult(
  result: KodaXResult,
): { result: KodaXResult; directive?: ManagedTaskVerdictDirective } {
  const text = extractMessageText(result) || result.lastText;
  const directive = parseManagedTaskContractReviewDirective(text);
  if (!directive) {
    const reason = `Contract review response omitted required ${MANAGED_TASK_CONTRACT_REVIEW_BLOCK} block.`;
    return {
      directive: {
        source: 'contract-review',
        status: 'blocked',
        reason,
        followups: [
          `Re-run contract review and require a final ${MANAGED_TASK_CONTRACT_REVIEW_BLOCK} fenced block with approve, revise, or blocked.`,
        ],
        userFacingText: text,
      },
      result: {
        ...result,
        success: false,
        signal: 'BLOCKED',
        signalReason: reason,
      },
    };
  }

  const sanitizedText = directive.userFacingText || text;
  const baseResult: KodaXResult = {
    ...result,
    lastText: sanitizedText,
    messages: replaceLastAssistantMessage(result.messages, sanitizedText),
  };
  if (directive.status === 'accept') {
    return {
      directive,
      result: {
        ...baseResult,
        success: true,
        signal: result.signal === 'BLOCKED' ? undefined : result.signal,
        signalReason: result.signal === 'BLOCKED' ? undefined : result.signalReason,
      },
    };
  }

  return {
    directive,
    result: {
      ...baseResult,
      success: false,
      signal: directive.status === 'blocked' ? 'BLOCKED' : result.signal,
      signalReason: directive.reason ?? result.signalReason,
    },
  };
}

function buildManagedRoundPrompt(
  prompt: string,
  round: number,
  feedback?: ManagedTaskVerdictDirective,
): string {
  if (!feedback) {
    return prompt;
  }

  const sections = [
    prompt,
    `${feedback.source === 'contract-review' ? 'Contract review' : 'Evaluator'} feedback after round ${round - 1}:`,
    feedback.artifactPath
      ? `Previous round feedback artifact: ${feedback.artifactPath}`
      : undefined,
    feedback.reason ? `Reason: ${feedback.reason}` : undefined,
    feedback.nextHarness ? `Requested next harness: ${feedback.nextHarness}` : undefined,
    feedback.followups.length > 0
      ? ['Required follow-up:', ...feedback.followups.map((item) => `- ${item}`)].join('\n')
      : undefined,
    feedback.userFacingText
      ? `Prior findings preview:\n${truncateText(feedback.userFacingText, 1200)}`
      : undefined,
  ].filter((section): section is string => Boolean(section && section.trim()));

  return sections.join('\n\n');
}

async function persistManagedTaskDirectiveArtifact(
  workspaceDir: string,
  directive: ManagedTaskVerdictDirective,
): Promise<ManagedTaskVerdictDirective> {
  const artifactPath = path.join(workspaceDir, 'feedback.json');
  const markdownPath = path.join(workspaceDir, 'feedback.md');
  await writeFile(
    artifactPath,
    `${JSON.stringify({
      source: directive.source,
      status: directive.status,
      reason: directive.reason ?? null,
      nextHarness: directive.nextHarness ?? null,
      followups: directive.followups,
      userFacingText: directive.userFacingText,
    }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    markdownPath,
    [
      `# ${directive.source === 'contract-review' ? 'Contract Review' : directive.source === 'worker' ? 'Worker Handoff' : 'Evaluator'} Feedback`,
      '',
      `- Status: ${directive.status}`,
      directive.reason ? `- Reason: ${directive.reason}` : undefined,
      directive.nextHarness ? `- Requested harness: ${directive.nextHarness}` : undefined,
      directive.followups.length > 0
        ? ['- Follow-up:', ...directive.followups.map((item) => `  - ${item}`)].join('\n')
        : undefined,
      directive.userFacingText
        ? ['', '## Visible Feedback', '', directive.userFacingText].join('\n')
        : undefined,
    ].filter((line): line is string => Boolean(line)).join('\n') + '\n',
    'utf8',
  );
  return {
    ...directive,
    artifactPath,
  };
}

function createWorkerEvents(
  baseEvents: KodaXEvents | undefined,
  worker: ManagedTaskWorkerSpec,
  forwardStream: boolean,
): KodaXEvents | undefined {
  if (!baseEvents) {
    return undefined;
  }

  if (forwardStream) {
    return undefined;
  }

  let textPrefixed = false;
  let thinkingPrefixed = false;
  const prefix = `[${worker.title}] `;
  const thinkingPrefix = `[${worker.title} thinking] `;

  return {
    askUser: baseEvents.askUser,
    onTextDelta: (text) => {
      if (!text) {
        return;
      }
      const rendered = textPrefixed ? text : `${prefix}${text}`;
      textPrefixed = true;
      baseEvents.onTextDelta?.(rendered);
    },
    onThinkingDelta: (text) => {
      if (!text) {
        return;
      }
      const rendered = thinkingPrefixed ? text : `${thinkingPrefix}${text}`;
      thinkingPrefixed = true;
      baseEvents.onThinkingDelta?.(rendered);
    },
    onThinkingEnd: (thinking) => {
      baseEvents.onThinkingEnd?.(`${prefix}${thinking}`);
      thinkingPrefixed = false;
    },
    onToolUseStart: (tool) => {
      baseEvents.onToolUseStart?.({
        ...tool,
        name: `${worker.title}:${tool.name}`,
      });
    },
    onToolResult: (result) => {
      baseEvents.onToolResult?.({
        ...result,
        name: `${worker.title}:${result.name}`,
      });
    },
    onToolInputDelta: (toolName, partialJson) => {
      baseEvents.onToolInputDelta?.(`${worker.title}:${toolName}`, partialJson);
    },
    onRetry: baseEvents.onRetry,
    onProviderRateLimit: baseEvents.onProviderRateLimit,
    onError: baseEvents.onError,
    onStreamEnd: () => {
      if (textPrefixed) {
        baseEvents.onTextDelta?.('\n');
      }
      if (thinkingPrefixed) {
        baseEvents.onThinkingDelta?.('\n');
      }
      textPrefixed = false;
      thinkingPrefixed = false;
    },
  };
}

function buildManagedWorkerSessionId(
  task: KodaXManagedTask,
  worker: ManagedTaskWorkerSpec,
): string {
  return `managed-task-worker-${task.contract.taskId}-${worker.id}`;
}

function createWorkerSession(
  session: KodaXOptions['session'],
  task: KodaXManagedTask,
  worker: ManagedTaskWorkerSpec,
  storage: KodaXSessionStorage | undefined,
  memoryStrategy: KodaXMemoryStrategy,
  compactInitialMessages?: KodaXSessionData['messages'],
): KodaXOptions['session'] {
  const shouldResume = memoryStrategy === 'continuous';
  const initialMessages = memoryStrategy === 'compact'
    ? compactInitialMessages
    : session?.initialMessages?.length
      ? [...session.initialMessages]
      : undefined;
  if (!session) {
    return {
      id: buildManagedWorkerSessionId(task, worker),
      scope: 'managed-task-worker',
      resume: shouldResume,
      autoResume: shouldResume,
      storage,
      initialMessages,
    };
  }
  return {
    ...session,
    id: buildManagedWorkerSessionId(task, worker),
    scope: 'managed-task-worker',
    resume: shouldResume,
    autoResume: shouldResume,
    storage,
    initialMessages,
  };
}

function mergeEvidenceArtifacts(
  ...artifactSets: Array<readonly KodaXTaskEvidenceArtifact[] | undefined>
): KodaXTaskEvidenceArtifact[] {
  const merged = new Map<string, KodaXTaskEvidenceArtifact>();
  for (const artifactSet of artifactSets) {
    for (const artifact of artifactSet ?? []) {
      merged.set(path.resolve(artifact.path), artifact);
    }
  }
  return Array.from(merged.values());
}

async function captureManagedTaskRepoIntelligence(
  options: KodaXOptions,
  workspaceDir: string,
): Promise<ManagedTaskRepoIntelligenceSnapshot> {
  const executionCwd = options.context?.executionCwd?.trim();
  const gitRoot = options.context?.gitRoot?.trim();
  if (!executionCwd && !gitRoot) {
    return { artifacts: [] };
  }

  const repoContext = {
    executionCwd: executionCwd ?? gitRoot ?? process.cwd(),
    gitRoot: gitRoot ?? undefined,
  };
  const repoSnapshotDir = path.join(workspaceDir, 'repo-intelligence');
  await mkdir(repoSnapshotDir, { recursive: true });

  const artifacts: KodaXTaskEvidenceArtifact[] = [];
  const summarySections: string[] = [];

  const activeModuleTargetPath = executionCwd ? '.' : undefined;

  try {
    const overview = await getRepoOverview(repoContext, { refresh: false });
    const overviewPath = path.join(repoSnapshotDir, 'repo-overview.json');
    await writeFile(overviewPath, `${JSON.stringify(overview, null, 2)}\n`, 'utf8');
    artifacts.push({
      kind: 'json',
      path: overviewPath,
      description: 'Task-scoped repository overview snapshot',
    });
    summarySections.push('## Repository Overview', renderRepoOverview(overview));
  } catch (error) {
    debugLogRepoIntelligence('Skipping task-scoped repo overview snapshot.', error);
  }

  try {
    const changedScope = await analyzeChangedScope(repoContext, {
      scope: 'all',
      refreshOverview: false,
    });
    const changedScopePath = path.join(repoSnapshotDir, 'changed-scope.json');
    await writeFile(changedScopePath, `${JSON.stringify(changedScope, null, 2)}\n`, 'utf8');
    artifacts.push({
      kind: 'json',
      path: changedScopePath,
      description: 'Task-scoped changed-scope snapshot',
    });
    summarySections.push('## Changed Scope', renderChangedScope(changedScope));
  } catch (error) {
    debugLogRepoIntelligence('Skipping task-scoped changed-scope snapshot.', error);
  }

  if (activeModuleTargetPath) {
    try {
      const moduleContext = await getModuleContext(repoContext, {
        targetPath: activeModuleTargetPath,
        refresh: false,
      });
      const moduleContextPath = path.join(repoSnapshotDir, 'active-module.json');
      await writeFile(moduleContextPath, `${JSON.stringify(moduleContext, null, 2)}\n`, 'utf8');
      artifacts.push({
        kind: 'json',
        path: moduleContextPath,
        description: 'Task-scoped active module capsule',
      });
      summarySections.push('## Active Module', renderModuleContext(moduleContext));
    } catch (error) {
      debugLogRepoIntelligence('Skipping task-scoped active-module snapshot.', error);
    }

    try {
      const impactEstimate = await getImpactEstimate(repoContext, {
        targetPath: activeModuleTargetPath,
        refresh: false,
      });
      const impactEstimatePath = path.join(repoSnapshotDir, 'impact-estimate.json');
      await writeFile(impactEstimatePath, `${JSON.stringify(impactEstimate, null, 2)}\n`, 'utf8');
      artifacts.push({
        kind: 'json',
        path: impactEstimatePath,
        description: 'Task-scoped impact estimate capsule',
      });
      summarySections.push('## Impact Estimate', renderImpactEstimate(impactEstimate));
    } catch (error) {
      debugLogRepoIntelligence('Skipping task-scoped impact snapshot.', error);
    }
  }

  if (summarySections.length > 0) {
    const summaryPath = path.join(repoSnapshotDir, 'summary.md');
    await writeFile(summaryPath, `${summarySections.join('\n\n')}\n`, 'utf8');
    artifacts.unshift({
      kind: 'markdown',
      path: summaryPath,
      description: 'Task-scoped repository intelligence summary',
    });
  }

  return { artifacts };
}

async function attachManagedTaskRepoIntelligence(
  options: KodaXOptions,
  task: KodaXManagedTask,
): Promise<KodaXManagedTask> {
  const snapshot = await captureManagedTaskRepoIntelligence(options, task.evidence.workspaceDir);
  if (snapshot.artifacts.length === 0) {
    return task;
  }

  return {
    ...task,
    evidence: {
      ...task.evidence,
      artifacts: mergeEvidenceArtifacts(task.evidence.artifacts, snapshot.artifacts),
    },
  };
}

function buildManagedTaskArtifactRecords(workspaceDir: string): KodaXTaskEvidenceArtifact[] {
  return [
    {
      kind: 'json',
      path: path.join(workspaceDir, 'contract.json'),
      description: 'Managed task contract snapshot',
    },
    {
      kind: 'json',
      path: path.join(workspaceDir, 'managed-task.json'),
      description: 'Managed task contract and evidence snapshot',
    },
    {
      kind: 'json',
      path: path.join(workspaceDir, 'result.json'),
      description: 'Managed task final result snapshot',
    },
    {
      kind: 'json',
      path: path.join(workspaceDir, 'round-history.json'),
      description: 'Managed task round history ledger',
    },
    {
      kind: 'json',
      path: path.join(workspaceDir, 'budget.json'),
      description: 'Managed task budget snapshot',
    },
    {
      kind: 'json',
      path: path.join(workspaceDir, 'memory-strategy.json'),
      description: 'Managed task memory strategy snapshot',
    },
    {
      kind: 'json',
      path: path.join(workspaceDir, 'runtime-contract.json'),
      description: 'Managed task runtime-under-test contract',
    },
    {
      kind: 'markdown',
      path: path.join(workspaceDir, 'runtime-execution.md'),
      description: 'Managed task runtime execution guide',
    },
    {
      kind: 'json',
      path: path.join(workspaceDir, 'scorecard.json'),
      description: 'Managed task verification scorecard',
    },
    {
      kind: 'json',
      path: path.join(workspaceDir, 'continuation.json'),
      description: 'Managed task continuation checkpoint',
    },
  ];
}

function buildManagedTaskRoundHistory(task: KodaXManagedTask): Array<{
  round: number;
  entries: Array<{
    assignmentId: string;
    title?: string;
    role: KodaXTaskRole;
    status: KodaXTaskStatus;
    summary?: string;
    sessionId?: string;
    signal?: KodaXTaskEvidenceEntry['signal'];
    signalReason?: string;
  }>;
}> {
  const rounds = new Map<number, Array<{
    assignmentId: string;
    title?: string;
    role: KodaXTaskRole;
    status: KodaXTaskStatus;
    summary?: string;
    sessionId?: string;
    signal?: KodaXTaskEvidenceEntry['signal'];
    signalReason?: string;
  }>>();

  for (const entry of task.evidence.entries) {
    const round = entry.round ?? 1;
    const roundEntries = rounds.get(round) ?? [];
    roundEntries.push({
      assignmentId: entry.assignmentId,
      title: entry.title,
      role: entry.role,
      status: entry.status,
      summary: entry.summary,
      sessionId: entry.sessionId,
      signal: entry.signal,
      signalReason: entry.signalReason,
    });
    rounds.set(round, roundEntries);
  }

  return Array.from(rounds.entries())
    .sort((left, right) => left[0] - right[0])
    .map(([round, entries]) => ({
      round,
      entries,
    }));
}

function buildWorkerRunOptions(
  defaultOptions: KodaXOptions,
  task: KodaXManagedTask,
  worker: ManagedTaskWorkerSpec,
  terminalWorkerId: string,
  routingPromptOverlay: string | undefined,
  qualityAssuranceMode: ManagedTaskQualityAssuranceMode,
  sessionStorage: KodaXSessionStorage | undefined,
  memoryStrategy: KodaXMemoryStrategy,
  budgetSnapshot: KodaXManagedBudgetSnapshot | undefined,
): KodaXOptions {
  worker.memoryStrategy = memoryStrategy;
  worker.budgetSnapshot = budgetSnapshot;
  const compactInitialMessages = memoryStrategy === 'compact' && sessionStorage instanceof ManagedWorkerSessionStorage
    ? buildCompactInitialMessages(task, worker, sessionStorage, budgetSnapshot?.currentRound ?? 1)
    : undefined;
  const roleEvents = createWorkerEvents(defaultOptions.events, worker, worker.id === terminalWorkerId);
  return {
    ...defaultOptions,
    maxIter: budgetSnapshot?.softMaxIter ?? defaultOptions.maxIter,
    session: createWorkerSession(defaultOptions.session, task, worker, sessionStorage, memoryStrategy, compactInitialMessages),
    context: {
      ...defaultOptions.context,
      taskSurface: task.contract.surface,
      managedTaskWorkspaceDir: task.evidence.workspaceDir,
      taskMetadata: task.contract.metadata,
      taskVerification: task.contract.verification,
      providerPolicyHints: {
        ...defaultOptions.context?.providerPolicyHints,
        ...buildProviderPolicyHintsForDecision({
          primaryTask: task.contract.primaryTask,
          confidence: 1,
          riskLevel: task.contract.riskLevel,
          recommendedMode: task.contract.recommendedMode,
          recommendedThinkingDepth: 'medium',
          complexity: task.contract.complexity,
          workIntent: task.contract.workIntent,
          requiresBrainstorm: task.contract.requiresBrainstorm,
          harnessProfile: task.contract.harnessProfile,
          reason: task.contract.reason,
          routingNotes: task.evidence.routingNotes,
        }),
      },
      disableAutoTaskReroute: true,
      promptOverlay: [
        routingPromptOverlay,
        defaultOptions.context?.promptOverlay,
        formatManagedPromptOverlay(task, worker, terminalWorkerId, qualityAssuranceMode),
      ]
        .filter(Boolean)
        .join('\n\n'),
    },
    events: roleEvents
      ? {
          ...defaultOptions.events,
          ...roleEvents,
        }
      : defaultOptions.events,
  };
}

async function runManagedAdmissionStage(
  options: KodaXOptions,
  task: KodaXManagedTask,
  prompt: string,
  initialWorkerSet: { terminalWorkerId: string; workers: ManagedTaskWorkerSpec[] },
  routingPromptOverlay: string | undefined,
  qualityAssuranceMode: ManagedTaskQualityAssuranceMode,
  controller: ManagedTaskBudgetController,
  plan: ReasoningPlan,
  sessionStorage: KodaXSessionStorage | undefined,
): Promise<{
  task: KodaXManagedTask;
  initialWorkerSet: { terminalWorkerId: string; workers: ManagedTaskWorkerSpec[] };
}> {
  const admissionWorker = initialWorkerSet.workers.find((worker) => worker.role === 'admission');
  if (!admissionWorker) {
    return {
      task,
      initialWorkerSet: initialWorkerSet,
    };
  }

  const admissionWorkspaceDir = path.join(task.evidence.workspaceDir, 'rounds', 'round-00', 'tasks', '00-admission');
  await mkdir(admissionWorkspaceDir, { recursive: true });

  const preparedOptions = buildWorkerRunOptions(
    options,
    task,
    admissionWorker,
    admissionWorker.id,
    routingPromptOverlay,
    qualityAssuranceMode,
    sessionStorage,
    resolveManagedMemoryStrategy(options, plan, admissionWorker.role, 1),
    createBudgetSnapshot(controller, task.contract.harnessProfile, 1, admissionWorker.role, admissionWorker.id),
  );
  const execution = await runManagedWorkerTask(
    admissionWorker,
    preparedOptions,
    admissionWorker.prompt,
    () => runDirectKodaX(preparedOptions, admissionWorker.prompt),
    controller,
  );
  const sanitized = sanitizeAdmissionResult(execution.result);
  const completionStatus = sanitized.directive ? 'ready' : 'missing';
  const status: KodaXTaskStatus = sanitized.result.success
    ? 'completed'
    : sanitized.result.signal === 'BLOCKED'
      ? 'blocked'
      : 'failed';
  let nextTask = applyAdmissionDirective(task, sanitized.directive);
  nextTask = applyManagedToolTelemetry(nextTask, sanitized.result);
  nextTask = {
    ...nextTask,
    roleAssignments: nextTask.roleAssignments.map((assignment) => assignment.id === admissionWorker.id
      ? {
          ...assignment,
          status,
          summary: sanitized.directive?.summary ?? truncateText(extractMessageText(sanitized.result) || sanitized.result.signalReason || 'Admission finished without a summary.'),
          sessionId: sanitized.result.sessionId,
        }
      : assignment),
    evidence: {
      ...nextTask.evidence,
      entries: [
        ...nextTask.evidence.entries,
        {
          assignmentId: admissionWorker.id,
          title: admissionWorker.title,
          role: admissionWorker.role,
          round: 0,
          status,
          summary: sanitized.directive?.summary ?? truncateText(extractMessageText(sanitized.result) || sanitized.result.signalReason || 'Admission finished without a summary.'),
          output: extractMessageText(sanitized.result),
          sessionId: sanitized.result.sessionId,
          signal: sanitized.result.signal,
          signalReason: sanitized.result.signalReason,
        },
      ],
    },
    runtime: {
      ...nextTask.runtime,
      completionContractStatus: {
        ...(nextTask.runtime?.completionContractStatus ?? {}),
        [admissionWorker.id]: completionStatus,
      },
      budget: createBudgetSnapshot(controller, task.contract.harnessProfile, 0, admissionWorker.role, admissionWorker.id),
    },
  };

  let nextWorkerSet = stripAdmissionFromWorkerSet(initialWorkerSet);
  const currentHarness = nextTask.contract.harnessProfile;
  const requestedHarness = sanitized.directive?.confirmedHarness;
  if (requestedHarness && isHarnessUpgrade(currentHarness, requestedHarness)) {
    const denialReason =
      !canProviderSatisfyHarness(requestedHarness, plan.providerPolicy)
        ? `Admission suggested ${requestedHarness}, but provider policy cannot safely satisfy it in this run.`
        : controller.upgradeCeiling && getHarnessRank(requestedHarness) > getHarnessRank(controller.upgradeCeiling)
          ? `Admission suggested ${requestedHarness}, but it exceeds the configured upgrade ceiling ${controller.upgradeCeiling}.`
          : undefined;

    if (denialReason) {
      nextTask = withHarnessTransition(nextTask, {
        from: currentHarness,
        to: requestedHarness,
        round: 0,
        source: 'admission',
        reason: sanitized.directive?.summary,
        approved: false,
        denialReason,
      });
      nextTask = {
        ...nextTask,
        runtime: {
          ...nextTask.runtime,
          degradedContinue: true,
          providerRuntimeBehavior: {
            downgraded: true,
            reasons: [...(nextTask.runtime?.providerRuntimeBehavior?.reasons ?? []), denialReason],
          },
        },
      };
    } else {
      controller.currentHarness = requestedHarness;
      if (controller.upgradeCeiling && getHarnessRank(requestedHarness) >= getHarnessRank(controller.upgradeCeiling)) {
        controller.upgradeCeiling = undefined;
      }
      nextTask = withHarnessTransition(nextTask, {
        from: currentHarness,
        to: requestedHarness,
        round: 0,
        source: 'admission',
        reason: sanitized.directive?.summary,
        approved: true,
      });
      nextTask = {
        ...nextTask,
        contract: {
          ...nextTask.contract,
          harnessProfile: requestedHarness,
          updatedAt: new Date().toISOString(),
        },
        runtime: {
          ...nextTask.runtime,
          currentHarness: requestedHarness,
          upgradeCeiling: controller.upgradeCeiling,
        },
      };
      nextWorkerSet = stripAdmissionFromWorkerSet(
        buildManagedTaskWorkers(
          prompt,
          {
            ...plan.decision,
            harnessProfile: requestedHarness,
            upgradeCeiling: controller.upgradeCeiling,
          },
          options.context?.taskMetadata,
          nextTask.contract.verification,
          qualityAssuranceMode,
          'initial',
        ),
      );
    }
  }

  await writeManagedTaskSnapshotArtifacts(task.evidence.workspaceDir, nextTask);
  return {
    task: nextTask,
    initialWorkerSet: nextWorkerSet,
  };
}

function applyDirectResultToTask(task: KodaXManagedTask, result: KodaXResult): KodaXManagedTask {
  const status: KodaXTaskStatus = result.success ? 'completed' : (result.signal === 'BLOCKED' ? 'blocked' : 'failed');
  const summary = truncateText(extractMessageText(result) || result.signalReason || 'Task finished without a textual summary.');
  const nextTask: KodaXManagedTask = {
    ...task,
    contract: {
      ...task.contract,
      status,
      updatedAt: new Date().toISOString(),
    },
    roleAssignments: task.roleAssignments.map((assignment) => ({
      ...assignment,
      status,
      summary,
      sessionId: result.sessionId,
    })),
    evidence: {
      ...task.evidence,
      artifacts: mergeEvidenceArtifacts(
        task.evidence.artifacts,
        buildManagedTaskArtifactRecords(task.evidence.workspaceDir),
      ),
      entries: [
        {
          assignmentId: 'direct',
          title: 'Direct Agent',
          role: 'direct',
          round: 1,
          status,
          summary,
          output: extractMessageText(result),
          sessionId: result.sessionId,
          signal: result.signal,
          signalReason: result.signalReason,
        },
      ],
    },
    verdict: {
      status,
      decidedByAssignmentId: 'direct',
      summary,
      signal: result.signal,
      signalReason: result.signalReason,
      disposition: status === 'completed' ? 'complete' : 'blocked',
      continuationSuggested: status !== 'completed',
    },
  };
  return {
    ...nextTask,
    runtime: {
      ...nextTask.runtime,
      scorecard: createVerificationScorecard(nextTask, undefined),
    },
  };
}

function applyOrchestrationResultToTask(
  task: KodaXManagedTask,
  terminalWorkerId: string,
  orchestrationResult: OrchestrationRunResult<ManagedTaskWorkerSpec, string>,
  workerResults: Map<string, KodaXResult>,
  round: number,
  roundWorkspaceDir: string,
): KodaXManagedTask {
  const newEntries: KodaXTaskEvidenceEntry[] = [];

  for (const completed of orchestrationResult.tasks) {
    const result = workerResults.get(completed.id);
    newEntries.push({
      assignmentId: completed.id,
      title: completed.title,
      role: task.roleAssignments.find((item) => item.id === completed.id)?.role ?? 'worker',
      round,
      status: completed.status === 'completed'
        ? 'completed'
        : completed.status === 'blocked'
          ? 'blocked'
          : 'failed',
      summary: completed.result.summary ?? completed.result.error,
      output: typeof completed.result.output === 'string'
        ? completed.result.output
        : extractMessageText(result),
      sessionId: typeof completed.result.metadata?.sessionId === 'string'
        ? completed.result.metadata.sessionId
        : result?.sessionId,
      signal: typeof completed.result.metadata?.signal === 'string'
        ? completed.result.metadata.signal as KodaXResult['signal']
        : result?.signal,
      signalReason: typeof completed.result.metadata?.signalReason === 'string'
        ? completed.result.metadata.signalReason
        : result?.signalReason,
    });
  }

  const allEntries = [...task.evidence.entries, ...newEntries];
  const latestEntryById = new Map<string, KodaXTaskEvidenceEntry>();
  for (const entry of allEntries) {
    const previous = latestEntryById.get(entry.assignmentId);
    if (!previous || (entry.round ?? 0) >= (previous.round ?? 0)) {
      latestEntryById.set(entry.assignmentId, entry);
    }
  }

  const terminalResult = workerResults.get(terminalWorkerId);
  const terminalCompleted = orchestrationResult.taskResults[terminalWorkerId];
  const fallbackCompleted = [...orchestrationResult.tasks].reverse().find((item) => item.status !== 'blocked');
  const fallbackResult = fallbackCompleted ? workerResults.get(fallbackCompleted.id) : undefined;
  const terminalSignal = typeof terminalCompleted?.result.metadata?.signal === 'string'
    ? terminalCompleted.result.metadata.signal
    : terminalResult?.signal;
  const fallbackSignal = typeof fallbackCompleted?.result.metadata?.signal === 'string'
    ? fallbackCompleted.result.metadata.signal
    : fallbackResult?.signal;
  const hasBlockedSignal = orchestrationResult.tasks.some(
    (item) => item.result.metadata?.signal === 'BLOCKED'
  );
  let status: KodaXTaskStatus;
  if (terminalCompleted?.status === 'completed') {
    status = terminalSignal === 'BLOCKED' ? 'blocked' : 'completed';
  } else if (terminalCompleted?.status === 'blocked') {
    status = 'blocked';
  } else if (terminalSignal === 'BLOCKED' || fallbackSignal === 'BLOCKED' || hasBlockedSignal) {
    status = 'blocked';
  } else if (orchestrationResult.summary.failed > 0) {
    status = 'failed';
  } else if (orchestrationResult.summary.blocked > 0) {
    status = 'blocked';
  } else {
    status = 'completed';
  }

  const summary = truncateText(
    extractMessageText(terminalResult)
    || terminalCompleted?.result.summary
    || extractMessageText(fallbackResult)
    || fallbackCompleted?.result.summary
    || 'Managed task finished without a textual summary.',
  );

  const artifacts: KodaXTaskEvidenceArtifact[] = [
    ...buildManagedTaskArtifactRecords(task.evidence.workspaceDir),
    {
      kind: 'json',
      path: path.join(roundWorkspaceDir, 'run.json'),
      description: `Managed task orchestration manifest for round ${round}`,
    },
    {
      kind: 'json',
      path: path.join(roundWorkspaceDir, 'summary.json'),
      description: `Managed task orchestration summary for round ${round}`,
    },
    {
      kind: 'text',
      path: path.join(roundWorkspaceDir, 'trace.ndjson'),
      description: `Managed task orchestration trace for round ${round}`,
    },
  ];

  return {
    ...task,
    contract: {
      ...task.contract,
      status,
      updatedAt: new Date().toISOString(),
    },
    roleAssignments: task.roleAssignments.map((assignment) => {
      const evidence = latestEntryById.get(assignment.id);
      return evidence
        ? {
            ...assignment,
            status: evidence.status,
            summary: evidence.summary,
            sessionId: evidence.sessionId,
          }
        : assignment;
    }),
    evidence: {
      ...task.evidence,
      runId: orchestrationResult.runId,
      artifacts: mergeEvidenceArtifacts(task.evidence.artifacts, artifacts),
      entries: allEntries,
    },
    verdict: {
      status,
      decidedByAssignmentId: terminalWorkerId,
      summary,
      signal: (terminalSignal as KodaXResult['signal'] | undefined)
        ?? (fallbackSignal as KodaXResult['signal'] | undefined),
      signalReason: typeof terminalCompleted?.result.metadata?.signalReason === 'string'
        ? terminalCompleted.result.metadata.signalReason
        : terminalResult?.signalReason ?? (
          typeof fallbackCompleted?.result.metadata?.signalReason === 'string'
            ? fallbackCompleted.result.metadata.signalReason
            : fallbackResult?.signalReason
        ),
      disposition: status === 'completed' ? 'complete' : 'blocked',
      continuationSuggested: status !== 'completed',
    },
  };
}

function mergeManagedTaskIntoResult(result: KodaXResult, task: KodaXManagedTask): KodaXResult {
  return {
    ...result,
    managedTask: task,
  };
}

async function writeManagedTaskSnapshotArtifacts(
  workspaceDir: string,
  task: KodaXManagedTask,
): Promise<void> {
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(
    path.join(workspaceDir, 'contract.json'),
    `${JSON.stringify(task.contract, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    path.join(workspaceDir, 'managed-task.json'),
    `${JSON.stringify(task, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    path.join(workspaceDir, 'round-history.json'),
    `${JSON.stringify(buildManagedTaskRoundHistory(task), null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    path.join(workspaceDir, 'budget.json'),
    `${JSON.stringify(task.runtime?.budget ?? null, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    path.join(workspaceDir, 'memory-strategy.json'),
    `${JSON.stringify({
      strategies: task.runtime?.memoryStrategies ?? {},
      notes: task.runtime?.memoryNotes ?? {},
    }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    path.join(workspaceDir, 'runtime-contract.json'),
    `${JSON.stringify(task.contract.verification?.runtime ?? null, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    path.join(workspaceDir, 'runtime-execution.md'),
    buildRuntimeExecutionGuide(task.contract.verification) ?? 'No explicit runtime-under-test contract.\n',
    'utf8',
  );
  await writeFile(
    path.join(workspaceDir, 'scorecard.json'),
    `${JSON.stringify(task.runtime?.scorecard ?? null, null, 2)}\n`,
    'utf8',
  );
}

async function writeManagedTaskArtifacts(
  workspaceDir: string,
  task: KodaXManagedTask,
  result: Pick<KodaXResult, 'success' | 'lastText' | 'sessionId' | 'signal' | 'signalReason'>,
  directive?: ManagedTaskVerdictDirective,
): Promise<void> {
  await writeManagedTaskSnapshotArtifacts(workspaceDir, task);
  const continuationSuggested = Boolean(
    directive?.status === 'revise'
    || task.verdict.disposition === 'needs_continuation'
    || (task.verdict.status === 'blocked' && task.verdict.signal === 'BLOCKED')
  );
  const nextRound = (buildManagedTaskRoundHistory(task).at(-1)?.round ?? 0) + 1;
  const latestFeedbackArtifact = directive?.artifactPath
    ?? task.evidence.artifacts
      .filter((artifact) => artifact.path.endsWith(`${path.sep}feedback.json`) || artifact.path.endsWith('/feedback.json'))
      .at(-1)?.path;
  await writeFile(
    path.join(workspaceDir, 'continuation.json'),
    `${JSON.stringify({
      continuationSuggested,
      taskId: task.contract.taskId,
      status: task.contract.status,
      nextRound,
      signal: task.verdict.signal ?? null,
      signalReason: task.verdict.signalReason ?? null,
      disposition: task.verdict.disposition ?? null,
      latestFeedbackArtifact: latestFeedbackArtifact ?? null,
      roundHistoryPath: path.join(workspaceDir, 'round-history.json'),
      contractPath: path.join(workspaceDir, 'contract.json'),
      managedTaskPath: path.join(workspaceDir, 'managed-task.json'),
      scorecardPath: path.join(workspaceDir, 'scorecard.json'),
      runtimeContractPath: path.join(workspaceDir, 'runtime-contract.json'),
      runtimeExecutionGuidePath: path.join(workspaceDir, 'runtime-execution.md'),
      budgetPath: path.join(workspaceDir, 'budget.json'),
      harnessTransitions: task.runtime?.harnessTransitions ?? [],
      suggestedPrompt: continuationSuggested && directive
        ? buildManagedRoundPrompt(task.contract.objective, nextRound, directive)
        : null,
    }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    path.join(workspaceDir, 'result.json'),
    `${JSON.stringify(result, null, 2)}\n`,
    'utf8',
  );
}

function applyDegradedContinueNote(task: KodaXManagedTask, text: string): string {
  if (!task.runtime?.degradedContinue) {
    return text;
  }
  const note = 'Note: a stronger AMA harness was requested during this run, but execution continued under the current harness as a best-effort pass. Coverage and confidence may be reduced.';
  if (!text.trim()) {
    return note;
  }
  return text.includes(note) ? text : `${text.trim()}\n\n${note}`;
}

function buildFallbackManagedResult(
  task: KodaXManagedTask,
  workerResults: Map<string, KodaXResult>,
  terminalWorkerId: string,
): KodaXResult {
  const terminalResult = workerResults.get(terminalWorkerId);
  if (terminalResult) {
    const finalText = applyDegradedContinueNote(
      task,
      extractMessageText(terminalResult) || terminalResult.lastText || task.verdict.summary,
    );
    return mergeManagedTaskIntoResult(
      {
        ...terminalResult,
        success: task.verdict.status === 'completed',
        lastText: finalText,
        signal: task.verdict.signal ?? (task.verdict.status === 'blocked' ? 'BLOCKED' : terminalResult.signal),
        signalReason: task.verdict.signalReason ?? terminalResult.signalReason,
        messages: replaceLastAssistantMessage(terminalResult.messages, finalText),
      },
      task,
    );
  }

  const fallbackResult = [...workerResults.values()].pop();
  if (fallbackResult) {
    const finalText = applyDegradedContinueNote(
      task,
      extractMessageText(fallbackResult) || fallbackResult.lastText || task.verdict.summary,
    );
    return mergeManagedTaskIntoResult(
      {
        ...fallbackResult,
        success: task.verdict.status === 'completed',
        lastText: finalText,
        signal: task.verdict.signal ?? (task.verdict.status === 'blocked' ? 'BLOCKED' : fallbackResult.signal),
        signalReason: task.verdict.signalReason ?? fallbackResult.signalReason,
        messages: replaceLastAssistantMessage(fallbackResult.messages, finalText),
      },
      task,
    );
  }

  return {
    success: task.verdict.status === 'completed',
    lastText: applyDegradedContinueNote(task, task.verdict.summary),
    signal: task.verdict.signal ?? (task.verdict.status === 'blocked' ? 'BLOCKED' : undefined),
    signalReason: task.verdict.signalReason,
    messages: [
      {
        role: 'assistant',
        content: applyDegradedContinueNote(task, task.verdict.summary),
      },
    ],
    sessionId: task.contract.taskId,
    routingDecision: {
      primaryTask: task.contract.primaryTask,
      confidence: 1,
      riskLevel: task.contract.riskLevel,
      recommendedMode: task.contract.recommendedMode,
      recommendedThinkingDepth: 'medium',
      complexity: task.contract.complexity,
      workIntent: task.contract.workIntent,
      requiresBrainstorm: task.contract.requiresBrainstorm,
      harnessProfile: task.contract.harnessProfile,
      upgradeCeiling: task.runtime?.upgradeCeiling,
      reviewScale: task.runtime?.scorecard?.rubricFamily === 'code-review' ? 'small' : undefined,
      soloBoundaryConfidence: undefined,
      needsIndependentQA: undefined,
      routingSource: task.runtime?.routingSource,
      routingAttempts: task.runtime?.routingAttempts,
      reason: task.contract.reason,
      routingNotes: task.evidence.routingNotes,
    },
    managedTask: task,
  };
}

function canProviderSatisfyHarness(
  harness: KodaXTaskRoutingDecision['harnessProfile'],
  providerPolicy: ReasoningPlan['providerPolicy'] | undefined,
): boolean {
  if (!providerPolicy) {
    return true;
  }

  const snapshot = providerPolicy.snapshot;
  if (harness === 'H3_MULTI_WORKER') {
    return !(
      snapshot.contextFidelity === 'lossy'
      || snapshot.sessionSupport === 'stateless'
      || snapshot.toolCallingFidelity === 'none'
      || snapshot.evidenceSupport === 'none'
      || snapshot.toolCallingFidelity === 'limited'
      || snapshot.evidenceSupport === 'limited'
      || snapshot.transport === 'cli-bridge'
    );
  }

  if (harness === 'H2_PLAN_EXECUTE_EVAL') {
    return !(
      snapshot.contextFidelity === 'lossy'
      || snapshot.sessionSupport === 'stateless'
      || snapshot.toolCallingFidelity === 'none'
      || snapshot.evidenceSupport === 'none'
    );
  }

  return true;
}

function consumeHarnessUpgradeBudget(
  controller: ManagedTaskBudgetController,
  fromHarness: KodaXTaskRoutingDecision['harnessProfile'],
  toHarness: KodaXTaskRoutingDecision['harnessProfile'],
): { granted: boolean; cost: number; reason?: string } {
  const cost = getHarnessUpgradeCost(fromHarness, toHarness);
  if (cost <= 0) {
    return { granted: false, cost: 0, reason: 'Requested harness is not stronger than the current harness.' };
  }
  if (controller.upgradeReserveRemaining < cost) {
    return {
      granted: false,
      cost,
      reason: `Upgrade to ${toHarness} needs ${cost} reserve units, but only ${controller.upgradeReserveRemaining} remain.`,
    };
  }

  controller.upgradeReserveRemaining -= cost;
  controller.reserveRemaining = Math.max(controller.reserveRemaining - cost, controller.upgradeReserveRemaining);
  controller.currentHarness = toHarness;
  return { granted: true, cost };
}

function withHarnessTransition(
  task: KodaXManagedTask,
  transition: KodaXManagedTaskHarnessTransition,
): KodaXManagedTask {
  return {
    ...task,
    runtime: {
      ...task.runtime,
      currentHarness: transition.approved ? transition.to : task.runtime?.currentHarness ?? task.contract.harnessProfile,
      harnessTransitions: [...(task.runtime?.harnessTransitions ?? []), transition],
    },
  };
}

function buildProtocolRetryPrompt(
  prompt: string,
  worker: ManagedTaskWorkerSpec,
  reason: string,
): string {
  return [
    prompt,
    [
      '[Managed Task Protocol Retry]',
      `Previous ${worker.title} output could not be safely consumed: ${reason}`,
      'Re-run the same role, keep the user-facing content, and append the required structured closing block exactly once at the end.',
    ].join('\n'),
  ].join('\n\n');
}

function shouldGrantBudgetExtension(
  controller: ManagedTaskBudgetController,
  worker: ManagedTaskWorkerSpec,
  request: KodaXBudgetExtensionRequest | undefined,
): { granted: number; reason?: string } {
  if (!request) {
    return { granted: 0 };
  }
  if (!worker.budgetSnapshot?.allowExtensionRequest) {
    return { granted: 0, reason: 'Budget extension requests are only allowed near the execution boundary.' };
  }
  const usableReserve = controller.upgradeReserveRemaining > 0
    ? Math.max(0, controller.reserveRemaining - controller.upgradeReserveRemaining)
    : controller.reserveRemaining;
  if (usableReserve <= 0) {
    return { granted: 0, reason: 'No reserve budget remains for extension.' };
  }
  if (request.confidenceToFinish < 0.55) {
    return { granted: 0, reason: 'Extension request confidence was too low to auto-approve.' };
  }
  const granted = Math.min(request.requestedIters, 3, usableReserve);
  if (granted <= 0) {
    return { granted: 0, reason: 'Requested extension exceeds remaining reserve.' };
  }
  return { granted };
}

function resolveHarnessUpgrade(
  task: KodaXManagedTask,
  directive: ManagedTaskVerdictDirective | undefined,
  agentMode: KodaXAgentMode,
  controller: ManagedTaskBudgetController,
  providerPolicy: ReasoningPlan['providerPolicy'] | undefined,
  round: number,
): {
  updatedDirective?: ManagedTaskVerdictDirective;
  transition?: KodaXManagedTaskHarnessTransition;
  haltRun: boolean;
  degradedContinue?: boolean;
} {
  if (!directive?.nextHarness) {
    return { updatedDirective: directive, haltRun: false };
  }

  const requestedHarness = directive.nextHarness;
  const currentHarness = task.contract.harnessProfile;
  const transitionSource = directive.source === 'worker' ? 'evaluator' : directive.source;
  const baseTransition: KodaXManagedTaskHarnessTransition = {
    from: currentHarness,
    to: requestedHarness,
    round,
    source: transitionSource,
    reason: directive.reason,
    approved: false,
  };

  const ignoreInvalidUpgrade = (denialReason: string): {
    updatedDirective: ManagedTaskVerdictDirective;
    transition: KodaXManagedTaskHarnessTransition;
    haltRun: false;
  } => ({
    updatedDirective: {
      ...directive,
      nextHarness: undefined,
      followups: [...directive.followups, denialReason],
    },
    transition: {
      ...baseTransition,
      denialReason,
    },
    haltRun: false,
  });

  const continueOnDeniedUpgrade = (denialReason: string): {
    updatedDirective: ManagedTaskVerdictDirective;
    transition: KodaXManagedTaskHarnessTransition;
    haltRun: false;
    degradedContinue: true;
  } => ({
    updatedDirective: {
      ...directive,
      nextHarness: undefined,
      followups: [...directive.followups, denialReason],
    },
    transition: {
      ...baseTransition,
      denialReason,
    },
    haltRun: false,
    degradedContinue: true,
  });

  if (directive.status !== 'revise') {
    return ignoreInvalidUpgrade('next_harness is only valid when status=revise.');
  }
  if (agentMode !== 'ama') {
    return continueOnDeniedUpgrade('Harness upgrade was requested, but this run is pinned to SA mode; continuing with the current harness.');
  }
  if (currentHarness === 'H0_DIRECT') {
    return ignoreInvalidUpgrade('Harness upgrades are not supported for H0 direct execution.');
  }
  if (!isHarnessUpgrade(currentHarness, requestedHarness)) {
    return ignoreInvalidUpgrade(`Requested harness ${requestedHarness} is not stronger than the current harness ${currentHarness}.`);
  }
  if (
    controller.upgradeCeiling
    && getHarnessRank(requestedHarness) > getHarnessRank(controller.upgradeCeiling)
  ) {
    return continueOnDeniedUpgrade(
      `Requested harness ${requestedHarness} exceeds the allowed upgrade ceiling ${controller.upgradeCeiling}.`,
    );
  }
  if (!canProviderSatisfyHarness(requestedHarness, providerPolicy)) {
    return continueOnDeniedUpgrade(`Provider policy cannot safely satisfy ${requestedHarness}; continuing with the current harness.`);
  }

  const budgetDecision = consumeHarnessUpgradeBudget(controller, currentHarness, requestedHarness);
  if (!budgetDecision.granted) {
    return continueOnDeniedUpgrade(
      budgetDecision.reason ?? `Budget reserve could not satisfy upgrade to ${requestedHarness}; continuing with the current harness.`,
    );
  }

  if (controller.upgradeCeiling && getHarnessRank(requestedHarness) >= getHarnessRank(controller.upgradeCeiling)) {
    controller.upgradeCeiling = undefined;
  }

  return {
    updatedDirective: directive,
    transition: {
      ...baseTransition,
      approved: true,
    },
    haltRun: false,
  };
}

async function runManagedWorkerTask(
  worker: ManagedTaskWorkerSpec,
  preparedOptions: KodaXOptions,
  prompt: string,
  executeDefault: () => Promise<KodaXResult>,
  controller: ManagedTaskBudgetController,
): Promise<{ result: KodaXResult; budgetRequest?: KodaXBudgetExtensionRequest; budgetExtensionGranted?: number; budgetExtensionReason?: string }> {
  let attempts = 0;
  let currentPrompt = prompt;
  let lastResult: KodaXResult | undefined;
  let extensionUsed = false;

  while (attempts < MANAGED_TASK_ROUTER_MAX_RETRIES) {
    attempts += 1;
    const result = attempts === 1
      ? await executeDefault()
      : await runDirectKodaX(preparedOptions, currentPrompt);
    lastResult = result;

    const text = extractMessageText(result) || result.lastText;
    const requiredBlockReason =
      worker.role === 'evaluator'
        ? (!parseManagedTaskVerdictDirective(text) ? `missing ${MANAGED_TASK_VERDICT_BLOCK}` : undefined)
        : worker.id === 'contract-review'
          ? (!parseManagedTaskContractReviewDirective(text) ? `missing ${MANAGED_TASK_CONTRACT_REVIEW_BLOCK}` : undefined)
          : worker.role === 'planner' || worker.role === 'lead'
            ? (!parseManagedTaskContractDirective(text) ? `missing ${MANAGED_TASK_CONTRACT_BLOCK}` : undefined)
            : worker.role === 'admission'
              ? (!parseManagedTaskAdmissionDirective(text) ? `missing ${MANAGED_TASK_ADMISSION_BLOCK}` : undefined)
              : (worker.role === 'generator' || worker.role === 'worker' || worker.role === 'validator') && !worker.terminalAuthority
                ? (!parseManagedTaskHandoffDirective(text) ? `missing ${MANAGED_TASK_HANDOFF_BLOCK}` : undefined)
                : undefined;

    if (requiredBlockReason && attempts < MANAGED_TASK_ROUTER_MAX_RETRIES) {
      currentPrompt = buildProtocolRetryPrompt(
        prompt,
        worker,
        requiredBlockReason,
      );
      continue;
    }

    const budgetRequest = parseBudgetExtensionRequest(text);
    if (budgetRequest && !extensionUsed) {
      const extension = shouldGrantBudgetExtension(controller, worker, budgetRequest);
      if (extension.granted > 0 && attempts < MANAGED_TASK_ROUTER_MAX_RETRIES) {
        extensionUsed = true;
        controller.reserveRemaining -= extension.granted;
        currentPrompt = [
          prompt,
          '[Managed Task Budget Extension Approved]',
          `You were granted ${extension.granted} additional iterations. Finish the task now and avoid opening new exploration branches.`,
        ].join('\n\n');
        preparedOptions.maxIter = (preparedOptions.maxIter ?? worker.budgetSnapshot?.softMaxIter ?? 8) + extension.granted;
        worker.budgetSnapshot = {
          ...(worker.budgetSnapshot ?? createBudgetSnapshot(controller, controller.currentHarness, 1, worker.role, worker.id)),
          extensionGrantedIters: extension.granted,
          reserveRemaining: controller.reserveRemaining,
          upgradeReserveRemaining: controller.upgradeReserveRemaining,
        };
        continue;
      }
      return {
        result,
        budgetRequest,
        budgetExtensionGranted: extension.granted,
        budgetExtensionReason: extension.reason,
      };
    }

    return { result };
  }

  return {
    result: lastResult ?? await executeDefault(),
  };
}

function createManagedOrchestrationEvents(
  baseEvents: KodaXEvents | undefined,
  agentMode: KodaXAgentMode,
  harnessProfile: KodaXTaskRoutingDecision['harnessProfile'],
  currentRound: number,
  maxRounds: number,
  upgradeCeiling?: KodaXTaskRoutingDecision['harnessProfile'],
): OrchestrationRunEvents<ManagedTaskWorkerSpec, string> | undefined {
  if (!baseEvents?.onTextDelta && !baseEvents?.onManagedTaskStatus) {
    return undefined;
  }

  return {
    onTaskStart: async (task) => {
      baseEvents.onTextDelta?.(`\n[${task.title}] starting\n`);
      baseEvents.onManagedTaskStatus?.({
        agentMode,
        harnessProfile,
        activeWorkerId: task.id,
        activeWorkerTitle: task.title,
        currentRound,
        maxRounds,
        phase: 'worker',
        upgradeCeiling,
      });
    },
    onTaskMessage: async (task, message) => {
      baseEvents.onTextDelta?.(`\n[${task.title}] ${message}\n`);
    },
    onTaskComplete: async (task, completed) => {
      baseEvents.onTextDelta?.(`\n[${task.title}] ${completed.status}: ${completed.result.summary ?? 'No summary available.'}\n`);
      baseEvents.onManagedTaskStatus?.({
        agentMode,
        harnessProfile,
        activeWorkerId: task.id,
        activeWorkerTitle: task.title,
        currentRound,
        maxRounds,
        phase: 'worker',
        note: `${task.title} ${completed.status}`,
        upgradeCeiling,
      });
    },
  };
}

async function executeManagedTaskRound(
  options: KodaXOptions,
  task: KodaXManagedTask,
  workerSet: { terminalWorkerId: string; workers: ManagedTaskWorkerSpec[] },
  workspaceDir: string,
  runId: string,
  routingPromptOverlay: string | undefined,
  qualityAssuranceMode: ManagedTaskQualityAssuranceMode,
  controller: ManagedTaskBudgetController,
  agentMode: KodaXAgentMode,
  round: number,
  maxRounds: number,
  plan: ReasoningPlan,
  sessionStorage: KodaXSessionStorage | undefined,
  previousDirective?: ManagedTaskVerdictDirective,
): Promise<ManagedTaskRoundExecution> {
  let directive: ManagedTaskVerdictDirective | undefined;
  let budgetRequest: KodaXBudgetExtensionRequest | undefined;
  let budgetExtensionGranted: number | undefined;
  let budgetExtensionReason: string | undefined;
  const workerResults = new Map<string, KodaXResult>();
  const contractDirectives = new Map<string, ManagedTaskContractDirective>();
  let taskSnapshot = task;
  const managedWorkerRunner = createKodaXTaskRunner<ManagedTaskWorkerSpec>({
    baseOptions: options,
    runAgent: runDirectKodaX,
    createOptions: (worker, _context, defaultOptions) => buildWorkerRunOptions(
      defaultOptions,
      task,
      worker,
      workerSet.terminalWorkerId,
      routingPromptOverlay,
      qualityAssuranceMode,
      sessionStorage,
      resolveManagedMemoryStrategy(options, plan, worker.role, round, previousDirective),
      createBudgetSnapshot(controller, task.contract.harnessProfile, round, worker.role, worker.id),
    ),
    runTask: async (worker, _context, preparedOptions, prompt, executeDefault) => {
      const execution = await runManagedWorkerTask(
        worker,
        preparedOptions,
        prompt,
        executeDefault,
        controller,
      );
      if (execution.budgetRequest) {
        budgetRequest = execution.budgetRequest;
        budgetExtensionGranted = execution.budgetExtensionGranted;
        budgetExtensionReason = execution.budgetExtensionReason;
      }
      return execution.result;
    },
    onResult: async (worker, _context, result) => {
      const sanitized = worker.role === 'evaluator'
        ? sanitizeManagedWorkerResult(result, { enforceVerdictBlock: true })
        : worker.id === 'contract-review'
          ? sanitizeContractReviewResult(result)
          : worker.role === 'lead' || worker.role === 'planner'
            ? sanitizeContractResult(result)
          : worker.role === 'admission'
            ? sanitizeAdmissionResult(result)
            : (worker.role === 'generator' || worker.role === 'worker' || worker.role === 'validator') && !worker.terminalAuthority
              ? sanitizeHandoffResult(result, worker.title)
              : { result };
      workerResults.set(worker.id, sanitized.result);
      let completionStatus: 'ready' | 'incomplete' | 'blocked' | 'missing' = 'missing';
      if (worker.role === 'admission') {
        completionStatus = (sanitized.directive as ManagedTaskAdmissionDirective | undefined) ? 'ready' : 'missing';
      } else if (worker.id === 'contract-review') {
        const reviewDirective = sanitized.directive as ManagedTaskVerdictDirective | undefined;
        completionStatus = reviewDirective?.status === 'accept'
          ? 'ready'
          : reviewDirective?.status === 'revise'
            ? 'incomplete'
            : reviewDirective?.status ?? 'missing';
      } else if (worker.role === 'evaluator') {
        const verdictDirective = sanitized.directive as ManagedTaskVerdictDirective | undefined;
        completionStatus = verdictDirective?.status === 'accept'
          ? 'ready'
          : verdictDirective?.status === 'revise'
            ? 'incomplete'
            : verdictDirective?.status ?? 'missing';
      } else {
        const handoffDirective = sanitized.directive as ManagedTaskHandoffDirective | undefined;
        completionStatus = handoffDirective?.status ?? (
          sanitized.result.success
            ? 'ready'
            : sanitized.result.signal === 'BLOCKED'
              ? 'blocked'
              : 'missing'
        );
      }
      const taskWithTelemetry = applyManagedToolTelemetry(taskSnapshot, sanitized.result);
      taskSnapshot = {
        ...taskWithTelemetry,
        runtime: {
          ...taskWithTelemetry.runtime,
          completionContractStatus: {
            ...(taskWithTelemetry.runtime?.completionContractStatus ?? {}),
            [worker.id]: completionStatus,
          },
        },
      };
      if (sessionStorage instanceof ManagedWorkerSessionStorage) {
        sessionStorage.saveMemoryNote(
          buildManagedWorkerSessionId(task, worker),
          buildManagedWorkerMemoryNote(task, worker, sanitized.result, round),
        );
      }
      if (worker.role === 'lead' || worker.role === 'planner') {
        const contractDirective = (sanitized.directive as ManagedTaskContractDirective | undefined)
          ?? parseManagedTaskContractDirective(
            extractMessageText(sanitized.result) || sanitized.result.lastText,
          );
        if (contractDirective) {
          contractDirectives.set(worker.id, contractDirective);
          taskSnapshot = applyManagedTaskContractDirectives(
            taskSnapshot,
            contractDirectives,
          );
          await writeManagedTaskSnapshotArtifacts(taskSnapshot.evidence.workspaceDir, taskSnapshot);
        }
      }
      if (worker.id === workerSet.terminalWorkerId && worker.role === 'evaluator') {
        directive = sanitized.directive as ManagedTaskVerdictDirective | undefined;
      }
      if (worker.id === 'contract-review') {
        const reviewDirective = sanitized.directive as ManagedTaskVerdictDirective | undefined;
        if (reviewDirective?.status && reviewDirective.status !== 'accept') {
          directive = reviewDirective;
        }
      }
      return sanitized.result;
    },
  });

  const orchestrationResult = await runOrchestration<ManagedTaskWorkerSpec, string>({
    runId,
    workspaceDir,
    maxParallel: task.contract.harnessProfile === 'H3_MULTI_WORKER' ? 2 : 1,
    tasks: workerSet.workers,
    signal: options.abortSignal,
    runner: async (worker, context) => {
      await context.emit(`Launching ${worker.title}`);
      return managedWorkerRunner(worker, context);
    },
    events: createManagedOrchestrationEvents(
      options.events,
      agentMode,
      task.contract.harnessProfile,
      round,
      maxRounds,
      task.runtime?.upgradeCeiling,
    ),
  });

  if (!directive) {
    for (const worker of workerSet.workers) {
      const result = workerResults.get(worker.id);
      if (!result) {
        continue;
      }
      if (worker.role === 'generator' || worker.role === 'worker' || (worker.role === 'validator' && worker.id !== 'contract-review')) {
        const handoff = parseManagedTaskHandoffDirective(extractMessageText(result) || result.lastText);
        if (handoff && handoff.status !== 'ready') {
          directive = {
            source: 'worker',
            status: handoff.status === 'blocked' ? 'blocked' : 'revise',
            reason: handoff.summary || result.signalReason || `${worker.title} reported ${handoff.status}.`,
            followups: handoff.followup.filter((item) => item.toLowerCase() !== 'none'),
            userFacingText: handoff.userFacingText || handoff.summary || '',
          };
          break;
        }
        if (!handoff && result.success === false) {
          directive = {
            source: 'worker',
            status: result.signal === 'BLOCKED' ? 'blocked' : 'revise',
            reason: result.signalReason || `${worker.title} did not produce a consumable handoff.`,
            followups: [],
            userFacingText: sanitizeManagedUserFacingText(extractMessageText(result) || result.lastText),
          };
          break;
        }
      }
    }
  }

  return {
    workerSet,
    workerResults,
    contractDirectives,
    orchestrationResult,
    workspaceDir,
    directive,
    budgetRequest,
    budgetExtensionGranted,
    budgetExtensionReason,
  };
}

function applyManagedTaskDirective(
  task: KodaXManagedTask,
  directive: ManagedTaskVerdictDirective | undefined,
): KodaXManagedTask {
  if (!directive) {
    return task;
  }

  if (directive.status === 'accept') {
    return {
      ...task,
      verdict: {
        ...task.verdict,
        summary: directive.userFacingText || task.verdict.summary,
        disposition: 'complete',
        continuationSuggested: false,
      },
    };
  }

  const signalReason = directive.reason || 'Evaluator requested another revision before acceptance.';
  const disposition = directive.status === 'revise' ? 'needs_continuation' : 'blocked';
  return {
    ...task,
    contract: {
      ...task.contract,
      status: 'blocked',
      updatedAt: new Date().toISOString(),
    },
    verdict: {
      ...task.verdict,
      status: 'blocked',
      summary: directive.userFacingText || task.verdict.summary,
      signal: 'BLOCKED',
      signalReason,
      disposition,
      continuationSuggested: directive.status === 'revise',
    },
  };
}

function applyManagedTaskContractDirectives(
  task: KodaXManagedTask,
  directives: Map<string, ManagedTaskContractDirective>,
): KodaXManagedTask {
  if (directives.size === 0) {
    return task;
  }

  const selectedAssignmentId = directives.has('planner')
    ? 'planner'
    : directives.has('lead')
      ? 'lead'
      : undefined;
  const selected = selectedAssignmentId ? directives.get(selectedAssignmentId) : Array.from(directives.values()).at(-1);
  if (!selected) {
    return task;
  }

  const requiredEvidence = selected.requiredEvidence.length > 0
    ? selected.requiredEvidence
    : task.contract.requiredEvidence;

  return {
    ...task,
    contract: {
      ...task.contract,
      contractSummary: selected.summary ?? task.contract.contractSummary,
      successCriteria: selected.successCriteria.length > 0
        ? selected.successCriteria
        : task.contract.successCriteria,
      requiredEvidence,
      constraints: selected.constraints.length > 0
        ? selected.constraints
        : task.contract.constraints,
      contractCreatedByAssignmentId: selectedAssignmentId ?? task.contract.contractCreatedByAssignmentId,
      contractUpdatedAt: new Date().toISOString(),
    },
  };
}

function synchronizeManagedTaskGraph(
  task: KodaXManagedTask,
  workerSet: { terminalWorkerId: string; workers: ManagedTaskWorkerSpec[] },
  harnessProfile: KodaXTaskRoutingDecision['harnessProfile'],
  upgradeCeiling?: KodaXTaskRoutingDecision['harnessProfile'],
): KodaXManagedTask {
  const previousAssignments = new Map(task.roleAssignments.map((assignment) => [assignment.id, assignment]));
  const admissionAssignment = previousAssignments.get('admission');
  const admissionWorkItem = task.workItems.find((item) => item.assignmentId === 'admission');
  return {
    ...task,
    contract: {
      ...task.contract,
      harnessProfile,
      updatedAt: new Date().toISOString(),
    },
    roleAssignments: [
      ...(admissionAssignment ? [admissionAssignment] : []),
      ...workerSet.workers.map((worker) => {
        const existing = previousAssignments.get(worker.id);
        return {
          id: worker.id,
          role: worker.role,
          title: worker.title,
          dependsOn: worker.dependsOn ?? [],
          status: existing?.status ?? 'planned',
          summary: existing?.summary,
          sessionId: existing?.sessionId,
          agent: worker.agent,
          toolPolicy: worker.toolPolicy,
        };
      }),
    ],
    workItems: [
      ...(admissionWorkItem ? [admissionWorkItem] : []),
      ...workerSet.workers.map((worker) => ({
        id: worker.id,
        assignmentId: worker.id,
        description: worker.title,
        execution: worker.execution ?? 'serial',
      })),
    ],
    verdict: {
      ...task.verdict,
      decidedByAssignmentId: workerSet.terminalWorkerId,
    },
    runtime: {
      ...task.runtime,
      currentHarness: harnessProfile,
      upgradeCeiling,
    },
  };
}

export async function runManagedTask(
  options: KodaXOptions,
  prompt: string,
): Promise<KodaXResult> {
  const agentMode = resolveManagedAgentMode(options);
  const managedPlanning = await createManagedReasoningPlan(options, prompt);
  const managedOptions: KodaXOptions = managedPlanning.repoRoutingSignals
    ? {
      ...options,
      context: {
        ...options.context,
        repoRoutingSignals: managedPlanning.repoRoutingSignals,
      },
    }
    : options;
  const plan = applyAgentModeToPlan(managedPlanning.plan, agentMode);
  const rawRoutingDecision = managedPlanning.rawDecision;
  const finalRoutingDecision = cloneRoutingDecisionWithReviewTarget(
    plan.decision,
    managedPlanning.reviewTarget,
  );
  const routingOverrideReason = managedPlanning.routingOverrideReason
    ?? (
      agentMode === 'sa'
      && (
        rawRoutingDecision.harnessProfile !== finalRoutingDecision.harnessProfile
        || rawRoutingDecision.upgradeCeiling !== finalRoutingDecision.upgradeCeiling
      )
        ? 'agent mode SA forced single-agent execution'
        : undefined
    );
  const routingBreadcrumb = createRoutingBreadcrumb(
    rawRoutingDecision,
    finalRoutingDecision,
    routingOverrideReason,
  );
  const liveRoutingNote = createLiveRoutingNote(
    rawRoutingDecision,
    finalRoutingDecision,
    managedPlanning.repoRoutingSignals,
    routingOverrideReason,
  );
  const shape = createTaskShape(managedOptions, prompt, plan);
  const budgetController = createManagedBudgetController(managedOptions, plan, agentMode);
  const sessionStorage = new ManagedWorkerSessionStorage();
  await mkdir(shape.workspaceDir, { recursive: true });
  shape.task = await attachManagedTaskRepoIntelligence(managedOptions, shape.task);
  shape.task = {
    ...shape.task,
    runtime: {
      ...shape.task.runtime,
      budget: createBudgetSnapshot(budgetController, shape.task.contract.harnessProfile, 0, undefined),
      routingAttempts: plan.decision.routingAttempts,
      routingSource: plan.decision.routingSource,
      scorecard: createVerificationScorecard(shape.task, undefined),
      currentHarness: shape.task.contract.harnessProfile,
      upgradeCeiling: plan.decision.upgradeCeiling,
      qualityAssuranceMode: shape.qualityAssuranceMode,
      rawRoutingDecision,
      finalRoutingDecision,
      routingOverrideReason,
    },
  };

  managedOptions.events?.onManagedTaskStatus?.({
    agentMode,
    harnessProfile: shape.task.contract.harnessProfile,
    currentRound: 0,
    maxRounds: resolveManagedTaskMaxRounds(managedOptions, plan, agentMode),
    phase: 'routing',
    note: liveRoutingNote,
    upgradeCeiling: shape.task.runtime?.upgradeCeiling,
  });

  if (shape.task.contract.harnessProfile === 'H0_DIRECT') {
    const directOptions: KodaXOptions = {
      ...managedOptions,
      context: {
        ...managedOptions.context,
        taskSurface: shape.task.contract.surface,
        managedTaskWorkspaceDir: shape.workspaceDir,
        taskMetadata: shape.task.contract.metadata,
        taskVerification: shape.task.contract.verification,
        promptOverlay: [
          shape.routingPromptOverlay,
          managedOptions.context?.promptOverlay,
          '[Managed Task] direct execution path.',
          `[Managed Task Routing] ${routingBreadcrumb}`,
          formatTaskMetadata(shape.task.contract.metadata),
          formatVerificationContract(shape.task.contract.verification),
        ].filter(Boolean).join('\n\n'),
      },
    };
    const result = await runDirectKodaX(directOptions, prompt);
    const managedTask = applyDirectResultToTask(shape.task, result);
    await writeManagedTaskArtifacts(shape.workspaceDir, managedTask, {
      success: result.success,
      lastText: extractMessageText(result),
      sessionId: result.sessionId,
      signal: result.signal,
      signalReason: result.signalReason,
    });
    return mergeManagedTaskIntoResult(
      {
        ...result,
        lastText: extractMessageText(result) || result.lastText,
        routingDecision: result.routingDecision ?? plan.decision,
      },
      managedTask,
    );
  }

  let managedTask = shape.task;
  let roundDirective: ManagedTaskVerdictDirective | undefined;
  let roundExecution: ManagedTaskRoundExecution | undefined;
  let pendingInitialWorkerSet: { terminalWorkerId: string; workers: ManagedTaskWorkerSpec[] } | undefined;
  let initialWorkerSet = { terminalWorkerId: shape.terminalWorkerId, workers: shape.workers };
  const maxRounds = resolveManagedTaskMaxRounds(managedOptions, plan, agentMode);
  if (managedTask.contract.harnessProfile !== 'H0_DIRECT') {
    managedOptions.events?.onManagedTaskStatus?.({
      agentMode,
      harnessProfile: managedTask.contract.harnessProfile,
      activeWorkerId: 'admission',
      activeWorkerTitle: 'Admission',
      currentRound: 0,
      maxRounds,
      phase: 'preflight',
      note: 'Admission preflight starting',
      upgradeCeiling: managedTask.runtime?.upgradeCeiling,
    });
    const admissionExecution = await runManagedAdmissionStage(
      managedOptions,
      managedTask,
      prompt,
      initialWorkerSet,
      shape.routingPromptOverlay,
      shape.qualityAssuranceMode,
      budgetController,
      plan,
      sessionStorage,
    );
    managedTask = synchronizeManagedTaskGraph(
      admissionExecution.task,
      admissionExecution.initialWorkerSet,
      admissionExecution.task.contract.harnessProfile,
      admissionExecution.task.runtime?.upgradeCeiling ?? budgetController.upgradeCeiling,
    );
    managedOptions.events?.onTextDelta?.(
      `\n[Admission] completed: ${managedTask.runtime?.admissionSummary ?? 'Scope preflight finished.'}\n`,
    );
    managedTask = {
      ...managedTask,
      runtime: {
        ...managedTask.runtime,
        budget: createBudgetSnapshot(budgetController, managedTask.contract.harnessProfile, 0, 'admission', 'admission'),
      },
    };
    initialWorkerSet = admissionExecution.initialWorkerSet;
    await writeManagedTaskSnapshotArtifacts(shape.workspaceDir, managedTask);
  }

  for (let round = 1; round <= maxRounds; round += 1) {
    const evidenceRecoveryNote = (
      (managedTask.runtime?.consecutiveEvidenceOnlyIterations ?? 0) >= EVIDENCE_ONLY_ITERATION_THRESHOLD
      && managedTask.runtime?.evidenceAcquisitionMode !== 'diff-bundle'
    )
      ? [
        '[Evidence Recovery]',
        'Recent iterations repeated serial diff paging without enough synthesis.',
        'Switch the next evidence pass to changed_diff_bundle before using changed_diff or read for deeper inspection.',
      ].join('\n')
      : undefined;
    const roundPrompt = [
      buildManagedRoundPrompt(prompt, round, roundDirective),
      evidenceRecoveryNote,
    ].filter(Boolean).join('\n\n');
    const roundDecision: KodaXTaskRoutingDecision = {
      ...plan.decision,
      harnessProfile: managedTask.contract.harnessProfile,
      upgradeCeiling: managedTask.runtime?.upgradeCeiling ?? budgetController.upgradeCeiling,
    };
    const workerSet = pendingInitialWorkerSet
      ?? (round === 1
        ? initialWorkerSet
        : buildManagedTaskWorkers(
          roundPrompt,
          roundDecision,
          managedOptions.context?.taskMetadata,
          managedOptions.context?.taskVerification,
          shape.qualityAssuranceMode,
          'refinement',
        ));
    pendingInitialWorkerSet = undefined;
    const roundWorkspaceDir = path.join(shape.workspaceDir, 'rounds', `round-${String(round).padStart(2, '0')}`);
    if (round > 1) {
      managedOptions.events?.onTextDelta?.(`\n[Managed Task] starting refinement round ${round}\n`);
    }
    managedOptions.events?.onManagedTaskStatus?.({
      agentMode,
      harnessProfile: managedTask.contract.harnessProfile,
      currentRound: round,
      maxRounds,
      phase: 'round',
      note: round > 1 ? `Starting refinement round ${round}` : 'Starting managed task execution',
      upgradeCeiling: managedTask.runtime?.upgradeCeiling ?? budgetController.upgradeCeiling,
    });
    budgetController.currentHarness = managedTask.contract.harnessProfile;
    budgetController.spentBudget = clampNumber(
      Math.round(((round - 1) / Math.max(1, maxRounds)) * (budgetController.totalBudget - budgetController.reserveRemaining)),
      0,
      budgetController.totalBudget,
    );
    managedTask = {
      ...managedTask,
      runtime: {
        ...managedTask.runtime,
        budget: createBudgetSnapshot(budgetController, managedTask.contract.harnessProfile, round, undefined),
      },
    };
    await writeManagedTaskSnapshotArtifacts(shape.workspaceDir, managedTask);
    roundExecution = await executeManagedTaskRound(
      managedOptions,
      managedTask,
      workerSet,
      roundWorkspaceDir,
      `${shape.task.contract.taskId}-round-${round}`,
      shape.routingPromptOverlay,
      shape.qualityAssuranceMode,
      budgetController,
      agentMode,
      round,
      maxRounds,
      plan,
      sessionStorage,
      roundDirective,
    );
    managedTask = applyOrchestrationResultToTask(
      managedTask,
      workerSet.terminalWorkerId,
      roundExecution.orchestrationResult,
      roundExecution.workerResults,
      round,
      roundWorkspaceDir,
    );
    managedTask = applyManagedTaskContractDirectives(
      managedTask,
      roundExecution.contractDirectives,
    );
    managedTask = {
      ...managedTask,
      runtime: {
        ...managedTask.runtime,
        budget: createBudgetSnapshot(budgetController, managedTask.contract.harnessProfile, round, undefined),
        memoryStrategies: {
          ...(managedTask.runtime?.memoryStrategies ?? {}),
          ...Object.fromEntries(
            workerSet.workers
              .filter((worker) => worker.memoryStrategy)
              .map((worker) => [worker.id, worker.memoryStrategy as KodaXMemoryStrategy]),
          ),
        },
        memoryNotes: sessionStorage.snapshotMemoryNotes(),
      },
    };
    await writeManagedTaskSnapshotArtifacts(shape.workspaceDir, managedTask);

    roundDirective = roundExecution.directive;
    if (roundDirective) {
      roundDirective = await persistManagedTaskDirectiveArtifact(roundWorkspaceDir, roundDirective);
      managedTask = {
        ...managedTask,
        evidence: {
          ...managedTask.evidence,
          artifacts: mergeEvidenceArtifacts(
            managedTask.evidence.artifacts,
            [
              {
                kind: 'json',
                path: roundDirective.artifactPath!,
                description: `Managed task feedback artifact for round ${round}`,
              },
              {
                kind: 'markdown',
                path: path.join(roundWorkspaceDir, 'feedback.md'),
                description: `Managed task feedback summary for round ${round}`,
              },
            ],
          ),
        },
      };

      const upgradeResolution = resolveHarnessUpgrade(
        managedTask,
        roundDirective,
        agentMode,
        budgetController,
        shape.providerPolicy,
        round,
      );
      roundDirective = upgradeResolution.updatedDirective;
      if (upgradeResolution.transition) {
        managedTask = withHarnessTransition(managedTask, upgradeResolution.transition);
      }
      if (upgradeResolution.degradedContinue) {
        managedTask = {
          ...managedTask,
          runtime: {
            ...managedTask.runtime,
            degradedContinue: true,
            providerRuntimeBehavior: {
              downgraded: true,
              reasons: [
                ...(managedTask.runtime?.providerRuntimeBehavior?.reasons ?? []),
                upgradeResolution.transition?.denialReason ?? roundDirective?.reason ?? 'Continuing with current harness after denied upgrade.',
              ],
            },
          },
        };
      }

      if (upgradeResolution.transition?.approved && roundDirective?.nextHarness) {
        const targetHarness = roundDirective.nextHarness;
        const upgradedDecision: KodaXTaskRoutingDecision = {
          ...plan.decision,
          harnessProfile: targetHarness,
          upgradeCeiling: budgetController.upgradeCeiling,
        };
        pendingInitialWorkerSet = buildManagedTaskWorkers(
          roundPrompt,
          upgradedDecision,
          managedOptions.context?.taskMetadata,
          managedOptions.context?.taskVerification,
          shape.qualityAssuranceMode,
          'initial',
        );
        managedTask = synchronizeManagedTaskGraph(
          managedTask,
          pendingInitialWorkerSet,
          targetHarness,
          budgetController.upgradeCeiling,
        );
        managedTask = {
          ...managedTask,
          runtime: {
            ...managedTask.runtime,
            budget: createBudgetSnapshot(budgetController, targetHarness, round, undefined),
          },
        };
        managedOptions.events?.onTextDelta?.(
          `\n[Managed Task] approved harness upgrade ${upgradeResolution.transition.from} -> ${upgradeResolution.transition.to} for the next round.\n`,
        );
        managedOptions.events?.onManagedTaskStatus?.({
          agentMode,
          harnessProfile: targetHarness,
          currentRound: round,
          maxRounds,
          phase: 'upgrade',
          note: `Approved harness upgrade ${upgradeResolution.transition.from} -> ${upgradeResolution.transition.to}`,
          upgradeCeiling: budgetController.upgradeCeiling,
        });
      } else if (upgradeResolution.transition && !upgradeResolution.transition.approved && upgradeResolution.haltRun) {
        const denialReason = upgradeResolution.transition.denialReason
          ?? `Requested harness ${upgradeResolution.transition.to} could not be satisfied.`;
        managedOptions.events?.onTextDelta?.(
          `\n[Managed Task] requested harness upgrade denied: ${denialReason}\n`,
        );
        managedOptions.events?.onManagedTaskStatus?.({
          agentMode,
          harnessProfile: managedTask.contract.harnessProfile,
          currentRound: round,
          maxRounds,
          phase: 'upgrade',
          note: `Denied harness upgrade ${upgradeResolution.transition.from} -> ${upgradeResolution.transition.to}: ${denialReason}`,
          upgradeCeiling: managedTask.runtime?.upgradeCeiling ?? budgetController.upgradeCeiling,
        });
        managedTask = {
          ...managedTask,
          contract: {
            ...managedTask.contract,
            status: 'blocked',
            updatedAt: new Date().toISOString(),
          },
          verdict: {
            ...managedTask.verdict,
            status: 'blocked',
            signal: 'BLOCKED',
            signalReason: denialReason,
            disposition: 'needs_continuation',
            continuationSuggested: true,
            summary: roundDirective?.userFacingText || managedTask.verdict.summary,
          },
          runtime: {
            ...managedTask.runtime,
            budget: createBudgetSnapshot(budgetController, managedTask.contract.harnessProfile, round, undefined),
          },
        };
        roundDirective = {
          ...(roundDirective ?? {
            source: 'evaluator',
            status: 'blocked',
            followups: [],
            userFacingText: managedTask.verdict.summary,
          }),
          status: 'blocked',
          reason: denialReason,
        };
        break;
      } else if (upgradeResolution.transition && !upgradeResolution.transition.approved) {
        const denialReason = upgradeResolution.transition.denialReason
          ?? `Requested harness ${upgradeResolution.transition.to} could not be satisfied.`;
        managedOptions.events?.onTextDelta?.(
          `\n[Managed Task] requested harness upgrade denied; continuing current harness: ${denialReason}\n`,
        );
      }
    }
    if (roundExecution.budgetRequest && roundExecution.budgetExtensionGranted === 0) {
      managedTask = {
        ...managedTask,
        verdict: {
          ...managedTask.verdict,
          disposition: 'needs_continuation',
          continuationSuggested: true,
          signal: 'BLOCKED',
          signalReason: roundExecution.budgetExtensionReason ?? roundExecution.budgetRequest.fallbackIfDenied,
          summary: roundExecution.budgetRequest.fallbackIfDenied || managedTask.verdict.summary,
        },
        runtime: {
          ...managedTask.runtime,
          budget: {
            ...createBudgetSnapshot(budgetController, managedTask.contract.harnessProfile, round, undefined),
            extensionDenied: true,
            extensionReason: roundExecution.budgetExtensionReason ?? roundExecution.budgetRequest.reason,
          },
        },
      };
      roundDirective = {
        source: 'evaluator',
        status: 'revise',
        reason: roundExecution.budgetExtensionReason ?? roundExecution.budgetRequest.reason,
        followups: [roundExecution.budgetRequest.fallbackIfDenied],
        userFacingText: managedTask.verdict.summary,
      };
      break;
    }
    if (roundDirective?.status === 'revise' && round < maxRounds) {
      const requesterLabel = roundDirective.source === 'contract-review'
        ? 'contract review'
        : roundDirective.source === 'worker'
          ? 'worker handoff'
          : 'evaluator';
      managedOptions.events?.onTextDelta?.(
        `\n[Managed Task] ${requesterLabel} requested another pass: ${roundDirective.reason ?? 'additional evidence required.'}${roundDirective.nextHarness ? ` Requested harness=${roundDirective.nextHarness}.` : ''}\n`,
      );
      continue;
    }
    break;
  }

  managedTask = applyManagedTaskDirective(managedTask, roundDirective);
  managedTask = {
    ...managedTask,
    runtime: {
      ...managedTask.runtime,
      budget: createBudgetSnapshot(budgetController, managedTask.contract.harnessProfile, maxRounds, undefined),
      scorecard: createVerificationScorecard(managedTask, roundDirective),
      memoryNotes: sessionStorage.snapshotMemoryNotes(),
      currentHarness: managedTask.contract.harnessProfile,
      upgradeCeiling: managedTask.runtime?.upgradeCeiling ?? budgetController.upgradeCeiling,
    },
  };
  const result = buildFallbackManagedResult(
    managedTask,
    roundExecution?.workerResults ?? new Map<string, KodaXResult>(),
    roundExecution?.workerSet.terminalWorkerId ?? shape.terminalWorkerId,
  );

  await writeManagedTaskArtifacts(shape.workspaceDir, managedTask, {
    success: result.success,
    lastText: result.lastText,
    sessionId: result.sessionId,
    signal: result.signal,
    signalReason: result.signalReason,
  }, roundDirective);

  managedOptions.events?.onManagedTaskStatus?.({
    agentMode,
    harnessProfile: managedTask.contract.harnessProfile,
    currentRound: Math.min(maxRounds, buildManagedTaskRoundHistory(managedTask).at(-1)?.round ?? maxRounds),
    maxRounds,
    phase: 'completed',
    note: managedTask.verdict.summary,
    upgradeCeiling: managedTask.runtime?.upgradeCeiling ?? budgetController.upgradeCeiling,
  });

  return mergeManagedTaskIntoResult(
    {
      ...result,
      routingDecision: result.routingDecision ?? plan.decision,
    },
    managedTask,
  );
}
