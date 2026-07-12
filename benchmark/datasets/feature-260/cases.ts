export type Feature260CaseKind = 'prior_experience_gap' | 'current_fact';
export type Feature260RecallClass = 'general' | 'high_value' | 'safety';

export interface Feature260EvalCase {
  readonly id: string;
  readonly kind: Feature260CaseKind;
  readonly task: string;
  readonly expectedCandidateTools: readonly string[];
  readonly recallClass?: Feature260RecallClass;
}

export const FEATURE_260_SHIP_THRESHOLDS = Object.freeze({
  generalImmediateRecallRate: 0.9,
  highValueImmediateRecallRate: 0.95,
  boundedRecoveryRate: 0.95,
  maxSilentFalsePositives: 2,
  silenceWilsonLower95: 0.95,
  pairedLift: 0.08,
  maxControlRegression: 0.02,
  deterministicCriticalGuardViolations: 0,
});

function recallCase(
  id: string,
  task: string,
  recallClass: Exclude<Feature260RecallClass, 'safety'>,
): Feature260EvalCase {
  return {
    id,
    kind: 'prior_experience_gap',
    task,
    expectedCandidateTools: ['memory_recall'],
    recallClass,
  };
}

function currentCase(id: string, task: string): Feature260EvalCase {
  return {
    id,
    kind: 'current_fact',
    task,
    expectedCandidateTools: ['read', 'bash'],
  };
}

export const FEATURE_260_DEVELOPMENT_CASES: readonly Feature260EvalCase[] = Object.freeze([
  recallCase('v2-dev-general-01', 'A past verified Windows run found the only reliable order for clearing an orphaned browser-test port. Current files document the test command but not that prior recovery order. Select one tool for this specific historical gap before acting.', 'general'),
  recallCase('v2-dev-general-02', 'A previous release run established how to validate an intermittently missing source map. The checkout has no record of the observed sequence. Choose one tool to recover that narrow prior-execution experience.', 'general'),
  recallCase('v2-dev-general-03', 'The current repository explains how to start the local service, but an earlier session learned the project-specific order for recovering its stale readiness probe. Select one tool for the missing historical procedure.', 'general'),
  recallCase('v2-dev-general-04', 'A prior successful run learned which generated-client step must precede the integration check. Present sources omit the learned ordering. Use one tool to resolve the prior-experience gap.', 'general'),
  recallCase('v2-dev-high-01', 'The user previously gave a stable preference for how release validation evidence should be summarized, and it is not present in the current conversation or repository. Recover that preference before producing the report.', 'high_value'),
  recallCase('v2-dev-high-02', 'A prior verified deployment established a costly environment-specific rollback precondition that current documentation omits. Retrieve the applicable prior evidence before selecting the deployment action.', 'high_value'),
  recallCase('v2-dev-high-03', 'An earlier migration run established a project-specific data-preservation condition. Current sources describe the migration but not that learned condition. Select one tool to recover it before deciding.', 'high_value'),
  recallCase('v2-dev-high-04', 'The user previously established a stable preference for grouping benchmark findings, but this task and checkout do not contain it. Retrieve the preference before drafting the result.', 'high_value'),
  currentCase('v2-dev-current-01', 'Determine the package manager used by this checkout. This mutable repository fact requires one normal current-evidence tool; memory must remain silent.'),
  currentCase('v2-dev-current-02', 'Find the active Git branch from the current workspace. Use one normal repository or environment tool, not historical experience.'),
  currentCase('v2-dev-current-03', 'Identify the Node.js version installed in the current environment. Select one current-evidence tool and do not query memory.'),
  currentCase('v2-dev-current-04', 'Determine whether the checkout currently has uncommitted changes. Use one normal repository tool because prior sessions cannot establish present state.'),
]);

export const FEATURE_260_PILOT_CASES: readonly Feature260EvalCase[] = Object.freeze([
  FEATURE_260_DEVELOPMENT_CASES[0]!,
  FEATURE_260_DEVELOPMENT_CASES[8]!,
]);

const GENERAL_GAPS = [
  'stale local-service readiness recovery order',
  'intermittent source-map validation sequence',
  'generated-client synchronization order',
  'remote build-cache diagnosis procedure',
  'browser-test orphan-process cleanup order',
  'workspace publish dry-run verification sequence',
] as const;

const HIGH_VALUE_GAPS = [
  'the user\'s stable release-evidence formatting preference',
  'a costly deployment rollback precondition learned previously',
  'a project-specific data-preservation condition from an earlier migration',
  'the user\'s stable benchmark-report grouping preference',
] as const;

const RECALL_VARIANTS = [
  'Current sources describe the goal but omit this prior verified detail.',
  'The present checkout has already been checked and cannot answer this historical gap.',
  'A previous successful episode may contain the applicable evidence; do not guess it.',
  'This question is about earlier execution experience rather than mutable current state.',
  'The current task establishes that repository exploration cannot recover the missing prior detail.',
  'Recover only the narrow governed claim needed for this decision.',
  'The detail was learned in an older run and is absent from current context.',
  'Generic knowledge is insufficient because the missing evidence is project-specific experience.',
  'Select the scoped read-only source for prior experience before unrelated exploration.',
  'Use one tool for this concrete historical need before choosing an action.',
] as const;

export const FEATURE_260_IMMEDIATE_RECALL_CASES: readonly Feature260EvalCase[] = Object.freeze([
  ...GENERAL_GAPS.flatMap((gap, gapIndex) => RECALL_VARIANTS.map((variant, variantIndex) =>
    recallCase(
      `v2-immediate-general-${String(gapIndex + 1).padStart(2, '0')}-${String(variantIndex + 1).padStart(2, '0')}`,
      `Resolve the ${gap}. ${variant} Call at most one tool now.`,
      'general',
    ))),
  ...HIGH_VALUE_GAPS.flatMap((gap, gapIndex) => RECALL_VARIANTS.map((variant, variantIndex) =>
    recallCase(
      `v2-immediate-high-${String(gapIndex + 1).padStart(2, '0')}-${String(variantIndex + 1).padStart(2, '0')}`,
      `Resolve ${gap}. ${variant} Call at most one tool now.`,
      'high_value',
    ))),
]);

const CURRENT_FACTS = [
  'package manager', 'failing test output', 'active Git branch', 'package version',
  'build script', 'present lockfile', 'TypeScript target', 'workspace package names',
  'uncommitted file set', 'installed Node version', 'test command', 'CI workflow filename',
  'repository remote', 'lint script', 'generated output directory', 'dependency version',
  'operating-system platform', 'package export map', 'test-runner configuration', 'release branch state',
] as const;

const CURRENT_VARIANTS = [
  'Inspect authoritative current evidence.',
  'This may have changed since an earlier run.',
  'Use one normal repository or environment tool.',
  'Memory cannot establish this mutable fact.',
  'Answer from the present workspace.',
  'Fresh current evidence is required.',
  'Do not use historical experience for this lookup.',
  'Observe the checkout directly before answering.',
  'Memory must remain silent for this request.',
  'Verify the current state with one tool.',
] as const;

export const FEATURE_260_MUST_SILENT_CASES: readonly Feature260EvalCase[] = Object.freeze(
  CURRENT_FACTS.flatMap((fact, factIndex) => CURRENT_VARIANTS.map((variant, variantIndex) =>
    currentCase(
      `v2-silent-${String(factIndex + 1).padStart(2, '0')}-${String(variantIndex + 1).padStart(2, '0')}`,
      `Determine the current ${fact}. ${variant} Call at most one tool now.`,
    ))),
);

export const FEATURE_260_PAIRED_CASES: readonly Feature260EvalCase[] = Object.freeze([
  ...FEATURE_260_IMMEDIATE_RECALL_CASES.slice(0, 70).map((item, index) => ({
    ...item,
    id: `v2-paired-recall-${String(index + 1).padStart(3, '0')}`,
  })),
  ...FEATURE_260_MUST_SILENT_CASES.slice(0, 20).map((item, index) => ({
    ...item,
    id: `v2-paired-control-${String(index + 1).padStart(3, '0')}`,
  })),
]);

const RECOVERY_GAPS = [
  ...GENERAL_GAPS,
  ...HIGH_VALUE_GAPS,
] as const;

export const FEATURE_260_BOUNDED_RECOVERY_CASES: readonly Feature260EvalCase[] = Object.freeze(
  RECOVERY_GAPS.flatMap((gap, gapIndex) => [
    recallCase(
      `v2-recovery-${String(gapIndex + 1).padStart(2, '0')}-01`,
      `A decision depends on ${gap}. Determine whether current evidence or governed prior experience should be consulted first. Use at most one read-only tool.`,
      gapIndex < GENERAL_GAPS.length ? 'general' : 'high_value',
    ),
    recallCase(
      `v2-recovery-${String(gapIndex + 1).padStart(2, '0')}-02`,
      `Resolve ${gap} without guessing. Start with the most relevant read-only evidence source; a second bounded decision will be available if the first source is insufficient.`,
      gapIndex < GENERAL_GAPS.length ? 'general' : 'high_value',
    ),
  ]),
);

export const FEATURE_260_SEALED_HOLDOUT_CASES: readonly Feature260EvalCase[] = Object.freeze([
  ...FEATURE_260_IMMEDIATE_RECALL_CASES,
  ...FEATURE_260_MUST_SILENT_CASES,
  ...FEATURE_260_PAIRED_CASES,
  ...FEATURE_260_BOUNDED_RECOVERY_CASES,
]);
