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
import type {
  KodaXEvents,
  KodaXJsonValue,
  KodaXManagedTask,
  KodaXOptions,
  KodaXResult,
  KodaXTaskCapabilityHint,
  KodaXTaskEvidenceArtifact,
  KodaXTaskEvidenceEntry,
  KodaXTaskRole,
  KodaXTaskRoutingDecision,
  KodaXTaskStatus,
  KodaXTaskSurface,
  KodaXTaskToolPolicy,
  KodaXTaskVerificationContract,
} from './types.js';

interface ManagedTaskWorkerSpec extends KodaXAgentWorkerSpec {
  role: KodaXTaskRole;
  toolPolicy?: KodaXTaskToolPolicy;
}

interface ManagedTaskShape {
  task: KodaXManagedTask;
  terminalWorkerId: string;
  workers: ManagedTaskWorkerSpec[];
  workspaceDir: string;
  routingPromptOverlay?: string;
}

function truncateText(value: string, maxLength = 400): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

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

function inferFallbackDecision(prompt: string): KodaXTaskRoutingDecision {
  const base = buildFallbackRoutingDecision(prompt);
  const normalized = ` ${prompt.toLowerCase()} `;
  const asksForBrainstorm =
    /\b(brainstorm|options?|trade[\s-]?offs?|explore|compare approaches?)\b/.test(normalized);
  const appendIntent = /\b(append|continue|extend|follow[- ]up|iterate)\b/.test(normalized);
  const overwriteIntent = /\b(overwrite|rewrite|replace|migrate|refactor)\b/.test(normalized);

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
      reason: `${base.reason} Fallback task-engine routing selected H3 for cross-cutting scope.`,
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
      reason: `${base.reason} Fallback task-engine routing selected H2 for planning-heavy scope.`,
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
      reason: `${base.reason} Fallback task-engine routing selected H1 for non-trivial execution.`,
    };
  }

  return {
    ...base,
    complexity: 'simple',
    harnessProfile: 'H0_DIRECT',
    riskLevel: 'low',
    workIntent: overwriteIntent ? 'overwrite' : appendIntent ? 'append' : base.workIntent,
    requiresBrainstorm: asksForBrainstorm,
    reason: `${base.reason} Fallback task-engine routing kept the task in H0 direct mode.`,
  };
}

async function createManagedReasoningPlan(options: KodaXOptions, prompt: string): Promise<ReasoningPlan> {
  try {
    const provider = resolveProvider(options.provider);
    return await createReasoningPlan(options, prompt, provider);
  } catch (error) {
    const decision = inferFallbackDecision(prompt);
    const mode = resolveReasoningMode(options);
    const depth = mode === 'auto'
      ? decision.recommendedThinkingDepth
      : mode === 'off'
        ? 'off'
        : reasoningModeToDepth(mode);

    return {
      mode,
      depth,
      decision: {
        ...decision,
        recommendedThinkingDepth: depth,
        routingNotes: [
          ...(decision.routingNotes ?? []),
          `Managed task engine used heuristic fallback routing because provider-backed routing was unavailable: ${error instanceof Error ? error.message : String(error)}`,
        ],
      },
      promptOverlay: buildPromptOverlay({
        ...decision,
        recommendedThinkingDepth: depth,
        routingNotes: [
          ...(decision.routingNotes ?? []),
          'Managed task engine is running with heuristic fallback routing.',
        ],
      }),
    };
  }
}

function buildManagedWorkerAgent(role: KodaXTaskRole): string {
  switch (role) {
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

function buildManagedWorkerToolPolicy(role: KodaXTaskRole): KodaXTaskToolPolicy | undefined {
  switch (role) {
    case 'lead':
    case 'planner':
      return {
        summary: 'Planning agents must stay read-only and may inspect repository state or design context, but must not mutate files or execute implementation steps.',
        blockedTools: [...WRITE_ONLY_TOOLS],
        allowedShellPatterns: INSPECTION_SHELL_PATTERNS,
      };
    case 'validator':
    case 'evaluator':
      return {
        summary: 'Verification agents may inspect the repo and run verification commands, including browser or Playwright checks, but must not edit project files or mutate control-plane artifacts.',
        blockedTools: [...WRITE_ONLY_TOOLS],
        allowedShellPatterns: VERIFICATION_SHELL_PATTERNS,
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
): string {
  return [
    `[Managed Task] task=${task.contract.taskId}; role=${worker.role}; worker=${worker.id}; terminal=${worker.id === terminalWorkerId ? 'yes' : 'no'}; agent=${worker.agent ?? buildManagedWorkerAgent(worker.role)}.`,
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
      if (matchesShellPattern(command, toolPolicy.allowedShellPatterns)) {
        return true;
      }

      if (matchesShellPattern(command, SHELL_WRITE_PATTERNS)) {
        return `[Managed Task ${worker.title}] Shell command blocked because this role is verification-only or planning-only. ${toolPolicy.summary}`;
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
  ].join('\n');

  const metadataSection = formatTaskMetadata(metadata);
  const verificationSection = formatVerificationContract(verification);
  const toolPolicySection = formatToolPolicy(toolPolicy);
  const agentSection = `Assigned native agent identity: ${agent}`;

  switch (role) {
    case 'lead':
      return [
        'You are the Lead role for a managed KodaX task.',
        decisionSummary,
        `Original task:\n${prompt}`,
        agentSection,
        metadataSection,
        verificationSection,
        toolPolicySection,
        'Break the work into clear ownership boundaries and success criteria.',
        'Call out the evidence the evaluator should require before accepting the task.',
        sharedClosingRule,
      ].join('\n\n');
    case 'planner':
      return [
        'You are the Planner role for a managed KodaX task.',
        decisionSummary,
        `Original task:\n${prompt}`,
        agentSection,
        metadataSection,
        verificationSection,
        toolPolicySection,
        'Produce a concise execution plan, the critical risks, and the evidence checklist.',
        'Do not perform the work yet and do not self-certify completion.',
        sharedClosingRule,
      ].join('\n\n');
    case 'generator':
      return [
        'You are the Generator role for a managed KodaX task.',
        decisionSummary,
        `Original task:\n${prompt}`,
        agentSection,
        metadataSection,
        verificationSection,
        toolPolicySection,
        'Execute the task or produce the requested deliverable.',
        'Leave final judgment to the evaluator and include a crisp evidence handoff.',
        sharedClosingRule,
      ].join('\n\n');
    case 'worker':
      return [
        'You are a specialist Worker role for a managed KodaX task.',
        decisionSummary,
        `Original task:\n${prompt}`,
        agentSection,
        metadataSection,
        verificationSection,
        toolPolicySection,
        'Own the implementation work for your assigned slice and report evidence, changed areas, and residual risks.',
        'Do not overstep into evaluator judgment.',
        sharedClosingRule,
      ].join('\n\n');
    case 'validator':
      return [
        'You are the Validator role for a managed KodaX task.',
        decisionSummary,
        `Original task:\n${prompt}`,
        agentSection,
        metadataSection,
        verificationSection,
        toolPolicySection,
        'Independently look for gaps, missing evidence, risky assumptions, and verification needs.',
        'Execute the verification contract directly when it calls for tests, browser checks, or other validation tools.',
        'Treat implementation outputs as suspect until supported by concrete evidence.',
        sharedClosingRule,
      ].join('\n\n');
    case 'evaluator':
      return [
        'You are the Evaluator role for a managed KodaX task.',
        decisionSummary,
        `Original task:\n${prompt}`,
        agentSection,
        metadataSection,
        verificationSection,
        toolPolicySection,
        'Judge whether the dependency handoff satisfies the original task and whether the evidence is strong enough.',
        'You own the final verification pass and must personally execute any required checks or browser validation before accepting the task.',
        'Return the final user-facing answer. If the task is not ready, explain the blocker or missing evidence clearly.',
        'If the original task requires an exact closing block, include it in your final answer when you conclude.',
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
): { terminalWorkerId: string; workers: ManagedTaskWorkerSpec[] } {
  const createWorker = (
    id: string,
    title: string,
    role: KodaXTaskRole,
    dependsOn?: string[],
    execution?: ManagedTaskWorkerSpec['execution'],
  ): ManagedTaskWorkerSpec => {
    const agent = buildManagedWorkerAgent(role);
    const toolPolicy = buildManagedWorkerToolPolicy(role);
    const worker: ManagedTaskWorkerSpec = {
      id,
      title,
      role,
      dependsOn,
      execution,
      agent,
      toolPolicy,
      metadata: {
        role,
        agent,
      },
      prompt: createRolePrompt(role, prompt, decision, verification, toolPolicy, agent, metadata),
    };
    worker.beforeToolExecute = createToolPolicyHook(worker);
    return worker;
  };

  if (decision.harnessProfile === 'H1_EXECUTE_EVAL') {
    return {
      terminalWorkerId: 'evaluator',
      workers: [
        createWorker('generator', 'Generator', 'generator'),
        createWorker('evaluator', 'Evaluator', 'evaluator', ['generator']),
      ],
    };
  }

  if (decision.harnessProfile === 'H2_PLAN_EXECUTE_EVAL') {
    return {
      terminalWorkerId: 'evaluator',
      workers: [
        createWorker('planner', 'Planner', 'planner'),
        createWorker('generator', 'Generator', 'generator', ['planner']),
        createWorker('evaluator', 'Evaluator', 'evaluator', ['planner', 'generator']),
      ],
    };
  }

  return {
    terminalWorkerId: 'evaluator',
    workers: [
      createWorker('lead', 'Lead', 'lead'),
      createWorker('planner', 'Planner', 'planner', ['lead']),
      createWorker('worker-implementation', 'Implementation Worker', 'worker', ['planner'], 'parallel'),
      createWorker('worker-validation', 'Validation Worker', 'validator', ['planner'], 'parallel'),
      createWorker('evaluator', 'Evaluator', 'evaluator', ['lead', 'planner', 'worker-implementation', 'worker-validation']),
    ],
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
        metadata: options.context?.taskMetadata,
        verification: options.context?.taskVerification,
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
    };

    return {
      task,
      terminalWorkerId: 'direct',
      workers: [],
      workspaceDir,
      routingPromptOverlay: plan.promptOverlay,
    };
  }

  const workerSet = buildManagedTaskWorkers(
    prompt,
    plan.decision,
    options.context?.taskMetadata,
    options.context?.taskVerification,
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
      metadata: options.context?.taskMetadata,
      verification: options.context?.taskVerification,
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
  };

  return {
    task,
    terminalWorkerId: workerSet.terminalWorkerId,
    workers: workerSet.workers,
    workspaceDir,
    routingPromptOverlay: plan.promptOverlay,
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
): KodaXOptions['session'] {
  if (!session) {
    return {
      id: buildManagedWorkerSessionId(task, worker),
      scope: 'managed-task-worker',
      resume: false,
      autoResume: false,
    };
  }

  const { storage: _storage, ...sessionWithoutStorage } = session;
  return {
    ...sessionWithoutStorage,
    id: buildManagedWorkerSessionId(task, worker),
    scope: 'managed-task-worker',
    resume: false,
    autoResume: false,
    initialMessages: session.initialMessages?.length
      ? [...session.initialMessages]
      : undefined,
  };
}

function buildWorkerRunOptions(
  defaultOptions: KodaXOptions,
  task: KodaXManagedTask,
  worker: ManagedTaskWorkerSpec,
  terminalWorkerId: string,
  routingPromptOverlay: string | undefined,
): KodaXOptions {
  const roleEvents = createWorkerEvents(defaultOptions.events, worker, worker.id === terminalWorkerId);
  return {
    ...defaultOptions,
    session: createWorkerSession(defaultOptions.session, task, worker),
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
      promptOverlay: [
        routingPromptOverlay,
        defaultOptions.context?.promptOverlay,
        formatManagedPromptOverlay(task, worker, terminalWorkerId),
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

function applyDirectResultToTask(task: KodaXManagedTask, result: KodaXResult): KodaXManagedTask {
  const status: KodaXTaskStatus = result.success ? 'completed' : (result.signal === 'BLOCKED' ? 'blocked' : 'failed');
  const summary = truncateText(extractMessageText(result) || result.signalReason || 'Task finished without a textual summary.');
  return {
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
      entries: [
        {
          assignmentId: 'direct',
          role: 'direct',
          status,
          summary,
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
    },
  };
}

function applyOrchestrationResultToTask(
  task: KodaXManagedTask,
  terminalWorkerId: string,
  orchestrationResult: OrchestrationRunResult<ManagedTaskWorkerSpec, string>,
  workerResults: Map<string, KodaXResult>,
): KodaXManagedTask {
  const entryById = new Map<string, KodaXTaskEvidenceEntry>();

  for (const completed of orchestrationResult.tasks) {
    const result = workerResults.get(completed.id);
    entryById.set(completed.id, {
      assignmentId: completed.id,
      role: task.roleAssignments.find((item) => item.id === completed.id)?.role ?? 'worker',
      status: completed.status === 'completed'
        ? 'completed'
        : completed.status === 'blocked'
          ? 'blocked'
          : 'failed',
      summary: completed.result.summary ?? completed.result.error,
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
    {
      kind: 'json',
      path: path.join(task.evidence.workspaceDir, 'run.json'),
      description: 'Managed task orchestration manifest',
    },
    {
      kind: 'json',
      path: path.join(task.evidence.workspaceDir, 'summary.json'),
      description: 'Managed task orchestration summary',
    },
    {
      kind: 'text',
      path: path.join(task.evidence.workspaceDir, 'trace.ndjson'),
      description: 'Managed task orchestration trace',
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
      const evidence = entryById.get(assignment.id);
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
      artifacts,
      entries: task.roleAssignments
        .map((assignment) => entryById.get(assignment.id))
        .filter((entry): entry is KodaXTaskEvidenceEntry => Boolean(entry)),
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
    },
  };
}

function mergeManagedTaskIntoResult(result: KodaXResult, task: KodaXManagedTask): KodaXResult {
  return {
    ...result,
    managedTask: task,
  };
}

async function writeManagedTaskArtifacts(
  workspaceDir: string,
  task: KodaXManagedTask,
  result: Pick<KodaXResult, 'success' | 'lastText' | 'sessionId' | 'signal' | 'signalReason'>,
): Promise<void> {
  await mkdir(workspaceDir, { recursive: true });
  await writeFile(
    path.join(workspaceDir, 'managed-task.json'),
    `${JSON.stringify(task, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    path.join(workspaceDir, 'result.json'),
    `${JSON.stringify(result, null, 2)}\n`,
    'utf8',
  );
}

function buildFallbackManagedResult(
  task: KodaXManagedTask,
  workerResults: Map<string, KodaXResult>,
  terminalWorkerId: string,
): KodaXResult {
  const terminalResult = workerResults.get(terminalWorkerId);
  if (terminalResult) {
    return mergeManagedTaskIntoResult(terminalResult, task);
  }

  const fallbackResult = [...workerResults.values()].pop();
  if (fallbackResult) {
    return mergeManagedTaskIntoResult(
      {
        ...fallbackResult,
        success: task.verdict.status === 'completed',
        lastText: task.verdict.summary,
        signal: task.verdict.signal ?? (task.verdict.status === 'blocked' ? 'BLOCKED' : fallbackResult.signal),
        signalReason: task.verdict.signalReason ?? fallbackResult.signalReason,
      },
      task,
    );
  }

  return {
    success: task.verdict.status === 'completed',
    lastText: task.verdict.summary,
    signal: task.verdict.signal ?? (task.verdict.status === 'blocked' ? 'BLOCKED' : undefined),
    signalReason: task.verdict.signalReason,
    messages: [
      {
        role: 'assistant',
        content: task.verdict.summary,
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
      reason: task.contract.reason,
      routingNotes: task.evidence.routingNotes,
    },
    managedTask: task,
  };
}

function createManagedOrchestrationEvents(
  baseEvents: KodaXEvents | undefined,
): OrchestrationRunEvents<ManagedTaskWorkerSpec, string> | undefined {
  if (!baseEvents?.onTextDelta) {
    return undefined;
  }

  return {
    onTaskStart: async (task) => {
      baseEvents.onTextDelta?.(`\n[${task.title}] starting\n`);
    },
    onTaskMessage: async (task, message) => {
      baseEvents.onTextDelta?.(`\n[${task.title}] ${message}\n`);
    },
    onTaskComplete: async (task, completed) => {
      baseEvents.onTextDelta?.(`\n[${task.title}] ${completed.status}: ${completed.result.summary ?? 'No summary available.'}\n`);
    },
  };
}

export async function runManagedTask(
  options: KodaXOptions,
  prompt: string,
): Promise<KodaXResult> {
  const plan = await createManagedReasoningPlan(options, prompt);
  const shape = createTaskShape(options, prompt, plan);
  await mkdir(shape.workspaceDir, { recursive: true });

  if (shape.task.contract.harnessProfile === 'H0_DIRECT') {
    const directOptions: KodaXOptions = {
      ...options,
      context: {
        ...options.context,
        taskSurface: shape.task.contract.surface,
        managedTaskWorkspaceDir: shape.workspaceDir,
        taskMetadata: shape.task.contract.metadata,
        taskVerification: shape.task.contract.verification,
        promptOverlay: [
          shape.routingPromptOverlay,
          options.context?.promptOverlay,
          '[Managed Task] direct execution path.',
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

  const workerResults = new Map<string, KodaXResult>();
  const managedWorkerRunner = createKodaXTaskRunner<ManagedTaskWorkerSpec>({
    baseOptions: options,
    runAgent: runDirectKodaX,
    createOptions: (worker, _context, defaultOptions) => buildWorkerRunOptions(
      defaultOptions,
      shape.task,
      worker,
      shape.terminalWorkerId,
      shape.routingPromptOverlay,
    ),
    onResult: async (worker, _context, result) => {
      workerResults.set(worker.id, result);
    },
  });
  const orchestrationResult = await runOrchestration<ManagedTaskWorkerSpec, string>({
    runId: shape.task.contract.taskId,
    workspaceDir: shape.workspaceDir,
    maxParallel: shape.task.contract.harnessProfile === 'H3_MULTI_WORKER' ? 2 : 1,
    tasks: shape.workers,
    signal: options.abortSignal,
    runner: async (worker, context) => {
      await context.emit(`Launching ${worker.title}`);
      return managedWorkerRunner(worker, context);
    },
    events: createManagedOrchestrationEvents(options.events),
  });

  const managedTask = applyOrchestrationResultToTask(
    shape.task,
    shape.terminalWorkerId,
    orchestrationResult,
    workerResults,
  );
  const result = buildFallbackManagedResult(managedTask, workerResults, shape.terminalWorkerId);

  await writeManagedTaskArtifacts(shape.workspaceDir, managedTask, {
    success: result.success,
    lastText: result.lastText,
    sessionId: result.sessionId,
    signal: result.signal,
    signalReason: result.signalReason,
  });

  return mergeManagedTaskIntoResult(
    {
      ...result,
      routingDecision: result.routingDecision ?? plan.decision,
    },
    managedTask,
  );
}
