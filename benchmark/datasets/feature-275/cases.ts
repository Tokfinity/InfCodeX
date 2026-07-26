export type Feature275CaseKind =
  | 'failed_tool'
  | 'post_compaction'
  | 'repeated_failure'
  | 'irrelevant_control';

export interface Feature275EvalCase {
  readonly id: string;
  readonly kind: Feature275CaseKind;
  readonly actionTask: string;
  readonly governedCandidateIds: readonly string[];
  readonly expectedSelectedCandidateIds: readonly string[];
  readonly expectedInjection: boolean;
  readonly expectedActionObservation: string;
}

export const FEATURE_275_CASES: readonly Feature275EvalCase[] = Object.freeze([
  {
    id: 'failed-tool-next-action',
    kind: 'failed_tool',
    actionTask: 'Choose the next bounded action after the same test command failed with the recorded project-specific precondition.',
    governedCandidateIds: [
      'observation:tool-outcome:failed-test',
      'current:objective',
    ],
    expectedSelectedCandidateIds: ['observation:tool-outcome:failed-test'],
    expectedInjection: true,
    expectedActionObservation: 'The next Action request uses the exposed precondition once and does not repeat the unchanged failing command.',
  },
  {
    id: 'post-compaction-requirement',
    kind: 'post_compaction',
    actionTask: 'Continue the implementation after durable compaction without losing the user-required compatibility constraint.',
    governedCandidateIds: ['current:objective', 'current:todo:integration'],
    expectedSelectedCandidateIds: ['current:objective'],
    expectedInjection: true,
    expectedActionObservation: 'The next Action preserves the compatibility constraint and advances the open integration step.',
  },
  {
    id: 'repeated-failure-recovery',
    kind: 'repeated_failure',
    actionTask: 'Select a different diagnostic action after two equivalent attempts failed for the same stable reason.',
    governedCandidateIds: [
      'observation:tool-outcome:repeated-failure',
      'memdir:verified-recovery-order',
    ],
    expectedSelectedCandidateIds: ['memdir:verified-recovery-order'],
    expectedInjection: true,
    expectedActionObservation: 'The Action changes approach using the selected verified recovery evidence.',
  },
  {
    id: 'irrelevant-memory-control',
    kind: 'irrelevant_control',
    actionTask: 'Read the current package version from the workspace.',
    governedCandidateIds: ['memdir:old-release-format', 'current:objective'],
    expectedSelectedCandidateIds: [],
    expectedInjection: false,
    expectedActionObservation: 'The selector remains silent and the Action reads current authoritative evidence.',
  },
]);

export const FEATURE_275_PILOT_CASES: readonly Feature275EvalCase[] = Object.freeze([
  FEATURE_275_CASES[1]!,
  FEATURE_275_CASES[3]!,
]);
