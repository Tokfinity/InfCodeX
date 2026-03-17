export type PlanTaskComplexity = 'small' | 'medium' | 'large';

export interface ProjectPlanTask {
  id: string;
  title: string;
  estimateMinutes: number;
  complexity: PlanTaskComplexity;
  dependsOn: string[];
}

export interface ProjectPlanPhase {
  id: string;
  title: string;
  goal: string;
  milestone: string;
  estimateMinutes: number;
  tasks: ProjectPlanTask[];
}

export interface ProjectPlan {
  id: string;
  title: string;
  createdAt: string;
  summary: string;
  totalEstimateMinutes: number;
  phases: ProjectPlanPhase[];
  risks: string[];
  nextCheckpoint: string;
}

export interface ProjectPlanInput {
  title: string;
  steps?: string[];
  contextNote?: string;
}

function normalizeText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} cannot be empty`);
  }
  return normalized;
}

function inferComplexity(text: string): PlanTaskComplexity {
  const lowered = text.toLowerCase();
  if (/(migrate|architecture|distributed|multi-tenant|security|permission|workflow|planner|queue|stream)/.test(lowered)) {
    return 'large';
  }
  if (/(integration|validation|review|api|state|storage|session|config)/.test(lowered)) {
    return 'medium';
  }
  return 'small';
}

function estimateMinutes(complexity: PlanTaskComplexity, multiplier = 1): number {
  const base =
    complexity === 'large'
      ? 120
      : complexity === 'medium'
        ? 60
        : 30;
  return base * multiplier;
}

function createTask(
  id: string,
  title: string,
  complexity: PlanTaskComplexity,
  dependsOn: string[] = [],
  multiplier = 1,
): ProjectPlanTask {
  return {
    id,
    title,
    estimateMinutes: estimateMinutes(complexity, multiplier),
    complexity,
    dependsOn,
  };
}

function sumEstimate(tasks: ProjectPlanTask[]): number {
  return tasks.reduce((total, task) => total + task.estimateMinutes, 0);
}

function formatEstimate(minutes: number): string {
  if (minutes % 60 === 0) {
    return `${minutes / 60}h`;
  }
  if (minutes > 60) {
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    return `${hours}h ${remainder}m`;
  }
  return `${minutes}m`;
}

function buildImplementationTasks(input: ProjectPlanInput): ProjectPlanTask[] {
  const rawSteps = input.steps?.map(step => normalizeText(step, 'step')) ?? [];
  const tasks = rawSteps.length > 0
    ? rawSteps.map((step, index) =>
        createTask(
          `impl-${index + 1}`,
          step,
          inferComplexity(step),
          index === 0 ? [] : [`impl-${index}`],
        ))
    : [
        createTask('impl-1', `Implement the core workflow for ${input.title}`, inferComplexity(input.title)),
        createTask('impl-2', 'Integrate state, storage, and user-facing command wiring', 'medium', ['impl-1']),
        createTask('impl-3', 'Polish edge cases, error handling, and operator UX', 'medium', ['impl-2']),
      ];

  return tasks;
}

function buildRiskList(input: ProjectPlanInput): string[] {
  const risks = [
    'The acceptance criteria may still hide one or two non-obvious edge cases.',
    'The implementation path should be validated against existing project workflows before rollout.',
  ];

  const joined = `${input.title} ${(input.steps ?? []).join(' ')}`.toLowerCase();
  if (/(history|storage|session|persist)/.test(joined)) {
    risks.push('Persistence changes should be checked for cross-session compatibility.');
  }
  if (/(ui|render|terminal|output)/.test(joined)) {
    risks.push('Terminal presentation should be verified under narrow viewport conditions.');
  }

  return risks;
}

export function buildProjectPlan(
  input: ProjectPlanInput,
  timestamp = new Date().toISOString(),
): ProjectPlan {
  const title = normalizeText(input.title, 'title');
  const contextNote = input.contextNote?.trim();
  const implementationTasks = buildImplementationTasks({
    ...input,
    title,
  });

  const designTasks = [
    createTask('design-1', `Clarify scope and success criteria for ${title}`, 'small'),
    createTask('design-2', 'Confirm constraints, dependencies, and rollout boundaries', 'medium', ['design-1']),
  ];
  const validationTasks = [
    createTask('validate-1', 'Add or update automated tests for the new behavior', 'medium', [implementationTasks[implementationTasks.length - 1]!.id]),
    createTask('validate-2', 'Review regressions and run focused verification', 'medium', ['validate-1']),
  ];
  const releaseTasks = [
    createTask('release-1', 'Update operator-facing docs and examples', 'small', ['validate-2']),
    createTask('release-2', 'Prepare rollout notes and next checkpoints', 'small', ['release-1']),
  ];

  const phases: ProjectPlanPhase[] = [
    {
      id: 'phase-1',
      title: 'Design',
      goal: 'Turn the request into a stable implementation boundary.',
      milestone: 'Scope, constraints, and acceptance criteria are aligned.',
      estimateMinutes: sumEstimate(designTasks),
      tasks: designTasks,
    },
    {
      id: 'phase-2',
      title: 'Implementation',
      goal: 'Deliver the core behavior and integrate it into the project workflow.',
      milestone: 'The new capability works end-to-end in the main path.',
      estimateMinutes: sumEstimate(implementationTasks),
      tasks: implementationTasks,
    },
    {
      id: 'phase-3',
      title: 'Validation',
      goal: 'Lock in correctness and reduce regression risk.',
      milestone: 'Tests, review, and focused checks are green.',
      estimateMinutes: sumEstimate(validationTasks),
      tasks: validationTasks,
    },
    {
      id: 'phase-4',
      title: 'Release',
      goal: 'Make the change operable and ready to share.',
      milestone: 'Docs and rollout guidance are ready.',
      estimateMinutes: sumEstimate(releaseTasks),
      tasks: releaseTasks,
    },
  ];

  const totalEstimateMinutes = phases.reduce((total, phase) => total + phase.estimateMinutes, 0);

  return {
    id: `plan_${timestamp.replace(/[:.]/g, '-')}`,
    title,
    createdAt: timestamp,
    summary: contextNote
      ? `A four-phase plan for ${title} covering design, implementation, validation, and release. ${contextNote}`
      : `A four-phase plan for ${title} covering design, implementation, validation, and release.`,
    totalEstimateMinutes,
    phases,
    risks: buildRiskList(input),
    nextCheckpoint: `Finish "${phases[0]!.tasks[0]!.title}" before committing to deeper implementation work.`,
  };
}

export function formatProjectPlan(plan: ProjectPlan): string {
  const lines = [
    `# Project Plan: ${plan.title}`,
    '',
    plan.summary,
    '',
    `Estimated Total: ${formatEstimate(plan.totalEstimateMinutes)}`,
    '',
  ];

  for (const phase of plan.phases) {
    lines.push(`## ${phase.title} (${formatEstimate(phase.estimateMinutes)})`);
    lines.push(`Goal: ${phase.goal}`);
    lines.push(`Milestone: ${phase.milestone}`);
    lines.push('');

    for (const task of phase.tasks) {
      const dependencyText =
        task.dependsOn.length > 0
          ? ` | depends on: ${task.dependsOn.join(', ')}`
          : '';
      lines.push(
        `- [ ] ${task.id}: ${task.title} (${formatEstimate(task.estimateMinutes)}, ${task.complexity})${dependencyText}`,
      );
    }

    lines.push('');
  }

  lines.push('## Risks');
  for (const risk of plan.risks) {
    lines.push(`- ${risk}`);
  }
  lines.push('');
  lines.push('## Next Checkpoint');
  lines.push(plan.nextCheckpoint);

  return lines.join('\n');
}
