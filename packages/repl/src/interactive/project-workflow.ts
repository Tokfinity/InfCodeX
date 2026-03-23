import type { CommandCallbacks } from './commands.js';
import type { ProjectStorage } from './project-storage.js';
import type {
  ProjectAlignment,
  ProjectFeature,
  ProjectWorkflowScope,
  ProjectWorkflowStage,
  ProjectWorkflowState,
} from './project-state.js';

export const OTHER_INPUT_LABEL = 'Other (type my own answer)';
const MAX_ALIGNMENT_DERIVED_FEATURES = 6;

export interface DiscoveryQuestion {
  prompt: string;
  options: string[];
  apply: (alignment: ProjectAlignment, answer: string) => ProjectAlignment;
}

export type AlignmentField =
  | 'confirmedRequirements'
  | 'constraints'
  | 'nonGoals'
  | 'acceptedTradeoffs'
  | 'successCriteria'
  | 'openQuestions';

export function appendAlignmentEntry(
  alignment: ProjectAlignment,
  field: AlignmentField,
  value: string,
): ProjectAlignment {
  return {
    ...alignment,
    [field]: [...alignment[field], value],
  };
}

export const DISCOVERY_QUESTIONS: DiscoveryQuestion[] = [
  {
    prompt: 'Which outcome matters most for the first usable version?',
    options: [
      'Ship the smallest usable version quickly',
      'Reduce implementation risk before scaling',
      'Preserve compatibility with the current workflow',
    ],
    apply: (alignment, answer) => appendAlignmentEntry(alignment, 'confirmedRequirements', answer),
  },
  {
    prompt: 'Which implementation boundary or constraint must we respect?',
    options: [
      'Keep the existing interfaces stable',
      'Avoid large architectural changes',
      'Prioritize correctness over speed of delivery',
    ],
    apply: (alignment, answer) => appendAlignmentEntry(alignment, 'constraints', answer),
  },
  {
    prompt: 'What should stay out of scope for this iteration?',
    options: [
      'Defer advanced configuration and edge-case polish',
      'Defer scalability work beyond the first release',
      'Defer UI/UX refinements unless required for correctness',
    ],
    apply: (alignment, answer) => appendAlignmentEntry(alignment, 'nonGoals', answer),
  },
  {
    prompt: 'How will we know this first version is successful?',
    options: [
      'The core workflow works end to end',
      'Focused tests cover the new behavior',
      'Operators can understand the new flow without extra handholding',
    ],
    apply: (alignment, answer) => appendAlignmentEntry(alignment, 'successCriteria', answer),
  },
];

function dedupeList(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values.map(item => item.trim()).filter(Boolean)) {
    const key = value.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return result;
}

export function normalizeAlignment(
  alignment: ProjectAlignment,
  timestamp = new Date().toISOString(),
): ProjectAlignment {
  return {
    ...alignment,
    confirmedRequirements: dedupeList(alignment.confirmedRequirements),
    constraints: dedupeList(alignment.constraints),
    nonGoals: dedupeList(alignment.nonGoals),
    acceptedTradeoffs: dedupeList(alignment.acceptedTradeoffs),
    successCriteria: dedupeList(alignment.successCriteria),
    openQuestions: dedupeList(alignment.openQuestions),
    updatedAt: timestamp,
  };
}

export async function chooseOrInput(
  callbacks: CommandCallbacks,
  title: string,
  options: string[],
  inputPrompt: string,
): Promise<string | undefined> {
  const choice = await callbacks.ui.select(title, [...options, OTHER_INPUT_LABEL]);
  if (!choice) {
    return undefined;
  }
  if (choice === OTHER_INPUT_LABEL) {
    const typed = await callbacks.ui.input(inputPrompt);
    return typed?.trim() || undefined;
  }
  return choice;
}

const ALIGNMENT_FIELD_OPTIONS: Array<{ label: string; field: AlignmentField }> = [
  { label: 'Confirmed requirement', field: 'confirmedRequirements' },
  { label: 'Constraint', field: 'constraints' },
  { label: 'Non-goal', field: 'nonGoals' },
  { label: 'Tradeoff', field: 'acceptedTradeoffs' },
  { label: 'Success criterion', field: 'successCriteria' },
  { label: 'Open question', field: 'openQuestions' },
];

export function isRemovalInstruction(guidance: string): boolean {
  return /\b(remove|delete|drop)\b/i.test(guidance) || /(删除|移除|去掉)/.test(guidance);
}

function isAddInstruction(guidance: string): boolean {
  return /\b(add|append|include|record|note|capture|mark|set)\b/i.test(guidance) || /(添加|增加|补充|记录|加入|设为)/.test(guidance);
}

export function detectAlignmentField(guidance: string): AlignmentField | null {
  if (/\bconstraint(s)?\b/i.test(guidance) || /约束/.test(guidance)) {
    return 'constraints';
  }
  if (/\bnon[-\s]?goal(s)?\b/i.test(guidance) || /非目标/.test(guidance)) {
    return 'nonGoals';
  }
  if (/\btrade[\s-]?off(s)?\b/i.test(guidance) || /取舍/.test(guidance)) {
    return 'acceptedTradeoffs';
  }
  if (/\bsuccess(\s+criteria|\s+criterion)?\b/i.test(guidance) || /成功标准|成功准则/.test(guidance)) {
    return 'successCriteria';
  }
  if (/\b(open\s+question|question)\b/i.test(guidance) || /问题|待确认/.test(guidance)) {
    return 'openQuestions';
  }
  if (/\brequirement(s)?\b/i.test(guidance) || /需求/.test(guidance)) {
    return 'confirmedRequirements';
  }
  return null;
}

export function looksLikeExplicitAlignmentFieldEdit(guidance: string): boolean {
  if (/^(constraint|constraints|约束|non[-\s]?goal|non[-\s]?goals|非目标|trade[\s-]?off|trade[\s-]?offs|取舍|success(\s+criteria|\s+criterion)?|成功标准|success|question|open question|问题|requirement|requirements|需求)\s*[:：-]/i.test(guidance.trim())) {
    return true;
  }
  return detectAlignmentField(guidance) !== null && (isAddInstruction(guidance) || isRemovalInstruction(guidance));
}

export function stripAlignmentEditPrefix(
  guidance: string,
  field: AlignmentField,
  mode: 'add' | 'remove',
): string {
  const prefixesByField: Record<AlignmentField, string[]> = {
    confirmedRequirements: ['requirement', 'requirements', '需求'],
    constraints: ['constraint', 'constraints', '约束'],
    nonGoals: ['non-goal', 'non-goals', 'non goal', 'non goals', '非目标'],
    acceptedTradeoffs: ['tradeoff', 'tradeoffs', 'trade off', 'trade offs', '取舍'],
    successCriteria: ['success criteria', 'success criterion', 'success', '成功标准', '成功准则'],
    openQuestions: ['open question', 'open questions', 'question', 'questions', '问题', '待确认问题'],
  };

  const escaped = prefixesByField[field]
    .map(item => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const actionPattern = mode === 'add'
    ? '(?:add|append|include|record|note|capture|mark|set|添加|增加|补充|记录|加入|设为)'
    : '(?:remove|delete|drop|删除|移除|去掉)';
  const prefixPattern = new RegExp(
    `^(?:${actionPattern})\\s+(?:an?\\s+|the\\s+)?(?:${escaped})(?:\\s+(?:about|for))?\\s*[:：-]?\\s*`,
    'i',
  );

  const withoutPrefix = guidance.trim().replace(prefixPattern, '');
  return withoutPrefix
    .replace(/^(about|for)\s+/i, '')
    .replace(/^(关于|针对)/, '')
    .trim();
}

export function removeAlignmentEntry(
  alignment: ProjectAlignment,
  field: AlignmentField,
  guidance: string,
): { alignment: ProjectAlignment; removed: boolean } {
  const rawTarget = stripAlignmentEditPrefix(guidance, field, 'remove');
  const target = rawTarget
    .replace(/^(the\s+)?/, '')
    .replace(/^(about\s+|for\s+)/i, '')
    .trim();

  if (!target) {
    return { alignment, removed: false };
  }

  const nextItems = alignment[field].filter(item => {
    const normalizedItem = item.toLowerCase();
    const normalizedTarget = target.toLowerCase();
    return !(
      normalizedItem === normalizedTarget
      || normalizedItem.includes(normalizedTarget)
      || normalizedTarget.includes(normalizedItem)
    );
  });

  return {
    alignment: {
      ...alignment,
      [field]: nextItems,
    },
    removed: nextItems.length !== alignment[field].length,
  };
}

export async function chooseAlignmentField(
  callbacks: CommandCallbacks,
  guidance: string,
): Promise<AlignmentField | null> {
  const choice = await callbacks.ui.select(
    `Which alignment area should this update? "${guidance}"`,
    ALIGNMENT_FIELD_OPTIONS.map(option => option.label),
  );
  const selected = ALIGNMENT_FIELD_OPTIONS.find(option => option.label === choice);
  return selected?.field ?? null;
}

export function ensureWorkflowStateDefaults(
  state: ProjectWorkflowState,
  timestamp = new Date().toISOString(),
): ProjectWorkflowState {
  return {
    ...state,
    scope: state.scope ?? 'project',
    unresolvedQuestionCount: state.unresolvedQuestionCount ?? 0,
    discoveryStepIndex: state.discoveryStepIndex ?? 0,
    lastUpdated: state.lastUpdated ?? timestamp,
  };
}

export async function getWorkflowState(storage: ProjectStorage): Promise<ProjectWorkflowState> {
  return ensureWorkflowStateDefaults(await storage.loadOrInferWorkflowState());
}

export function getRecommendedNextStep(
  state: ProjectWorkflowState,
  hasFeatures: boolean,
  hasSessionPlan: boolean,
): string {
  if (state.stage === 'bootstrap' || state.stage === 'discovering') {
    return '/project brainstorm';
  }
  if (state.stage === 'aligned') {
    return '/project plan';
  }
  if (state.stage === 'planned') {
    return '/project next';
  }
  if (state.stage === 'executing') {
    return '/project auto';
  }
  if (state.stage === 'blocked') {
    return '/project verify';
  }
  if (!hasFeatures) {
    return '/project plan';
  }
  return hasSessionPlan ? '/project next' : '/project plan';
}

export function isExecutionStage(stage: ProjectWorkflowStage): boolean {
  return stage === 'planned' || stage === 'executing' || stage === 'blocked' || stage === 'completed';
}

export function formatStage(stage: ProjectWorkflowStage): string {
  return stage.replace(/_/g, ' ');
}

export function summarizeActiveScope(scope: ProjectWorkflowScope, activeRequestId?: string): string {
  return scope === 'change_request'
    ? `change request${activeRequestId ? ` (${activeRequestId})` : ''}`
    : 'project';
}

export function buildFallbackFeatureListFromAlignment(
  alignment: ProjectAlignment,
  existingFeatures: ProjectFeature[],
  scope: ProjectWorkflowScope,
): ProjectFeature[] {
  const baseRequirements = alignment.confirmedRequirements.length > 0
    ? alignment.confirmedRequirements
    : [alignment.sourcePrompt];
  const steps = dedupeList([
    ...alignment.constraints.map(item => `Respect constraint: ${item}`),
    ...alignment.successCriteria.map(item => `Validate success criteria: ${item}`),
  ]);

  const generated = baseRequirements.slice(0, MAX_ALIGNMENT_DERIVED_FEATURES).map((requirement, index) => ({
    description: scope === 'change_request'
      ? `Change request: ${requirement}`
      : requirement,
    steps: steps.length > 0 ? steps : [
      'Implement the aligned behavior',
      'Update focused verification and progress evidence',
    ],
    passes: false,
    notes: index === 0 ? `Derived from alignment: ${alignment.sourcePrompt}` : undefined,
  }));

  if (scope === 'change_request' && existingFeatures.length > 0) {
    return [...existingFeatures, ...generated];
  }

  return generated;
}
