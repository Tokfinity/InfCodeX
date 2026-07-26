export type Feature274PolicyCaseKind =
  | 'solo'
  | 'classify'
  | 'fanout'
  | 'generate_filter'
  | 'tournament'
  | 'adversarial'
  | 'bounded_loop'
  | 'explicit_workflow';

export interface Feature274PolicyCase {
  readonly id: string;
  readonly kind: Feature274PolicyCaseKind;
  readonly prompt: string;
  readonly expectedPattern?: string;
  readonly expectedRelation?: 'coverage' | 'replication' | 'opposition';
  readonly expectedActorStarts: readonly [minimum: number, maximum: number];
  readonly expectsWorkflow: boolean;
  readonly requiredObservation: string;
}

export interface Feature274JourneyCase {
  readonly id: string;
  readonly traceCondition: string;
  readonly finalAnswerCondition: string;
  readonly expectedVerdict: 'accept' | 'revise';
  readonly expectedReasonCode?: string;
  readonly forbiddenBehavior: string;
}

export const FEATURE_274_POLICY_CASES: readonly Feature274PolicyCase[] = Object.freeze([
  {
    id: 'simple-direct-solo',
    kind: 'solo',
    prompt: 'Rename one local variable in the named function and run its focused unit test.',
    expectedActorStarts: [0, 0],
    expectsWorkflow: false,
    requiredObservation: 'No Agent or Workflow is started merely to satisfy strategy telemetry.',
  },
  {
    id: 'mixed-request-classify',
    kind: 'classify',
    prompt: 'Separate the documentation question from the code defect, identify which one blocks release, then address the blocking scope.',
    expectedPattern: 'classify-and-act',
    expectedActorStarts: [1, 2],
    expectsWorkflow: false,
    requiredObservation: 'A bounded classifier reports route, uncertainty, and the execution consequence.',
  },
  {
    id: 'independent-interface-coverage',
    kind: 'fanout',
    prompt: 'Review the CLI, SDK, and daemon compatibility surfaces for this protocol change, then synthesize gaps and agreements.',
    expectedPattern: 'fan-out-and-synthesize',
    expectedRelation: 'coverage',
    expectedActorStarts: [2, 3],
    expectsWorkflow: false,
    requiredObservation: 'Distinct scopes are assigned and synthesis retains provenance and gaps.',
  },
  {
    id: 'design-search-filter',
    kind: 'generate_filter',
    prompt: 'Produce distinct minimal designs for the state handoff, reject any that add a second store, and select the surviving option.',
    expectedPattern: 'generate-and-filter',
    expectedActorStarts: [2, 3],
    expectsWorkflow: false,
    requiredObservation: 'Candidates and evidence-backed rejection reasons remain visible.',
  },
  {
    id: 'complete-alternative-tournament',
    kind: 'tournament',
    prompt: 'Compare the two complete migration plans under one rubric covering rollback safety, compatibility, and implementation cost.',
    expectedPattern: 'tournament',
    expectedActorStarts: [2, 3],
    expectsWorkflow: false,
    requiredObservation: 'Every alternative is judged under the same rubric without majority-as-proof.',
  },
  {
    id: 'concrete-candidate-challenge',
    kind: 'adversarial',
    prompt: 'Challenge the completed auth-boundary patch against its exact Actor Turn and the failing regression evidence before synthesis.',
    expectedPattern: 'adversarial-verification',
    expectedRelation: 'opposition',
    expectedActorStarts: [1, 2],
    expectsWorkflow: false,
    requiredObservation: 'The challenger names a terminal exact-Turn or immutable evidence target.',
  },
  {
    id: 'evidence-delta-loop',
    kind: 'bounded_loop',
    prompt: 'Investigate the intermittent failure in bounded rounds; continue only when a round adds evidence that can change the next decision.',
    expectedPattern: 'loop-until-done',
    expectedActorStarts: [1, 3],
    expectsWorkflow: false,
    requiredObservation: 'Each follow-up names an evidence delta and stops on resolution, no delta, input, or budget.',
  },
  {
    id: 'explicit-workflow-request',
    kind: 'explicit_workflow',
    prompt: 'Create and run a reusable Workflow that audits three packages and persists resumable structured results.',
    expectedActorStarts: [0, 0],
    expectsWorkflow: true,
    requiredObservation: 'Workflow is selected because the user explicitly requested the reusable protocol.',
  },
]);

export const FEATURE_274_JOURNEY_CASES: readonly Feature274JourneyCase[] = Object.freeze([
  {
    id: 'refuted-false-positive',
    traceCondition: 'A challenger disposition marks the seeded finding refuted.',
    finalAnswerCondition: 'The draft still presents the finding as confirmed.',
    expectedVerdict: 'revise',
    expectedReasonCode: 'contradicted_evidence',
    forbiddenBehavior: 'The refuted finding survives without newer superseding evidence.',
  },
  {
    id: 'conflicting-coverage-transition',
    traceCondition: 'Coverage lanes disagree on a release-blocking claim.',
    finalAnswerCondition: 'The draft chooses one lane without resolving or disclosing the conflict.',
    expectedVerdict: 'revise',
    expectedReasonCode: 'unresolved_high_risk',
    forbiddenBehavior: 'Verifier count is treated as a vote proving correctness.',
  },
  {
    id: 'empty-filter-stop',
    traceCondition: 'Every generated candidate is refuted or unresolved under hard constraints.',
    finalAnswerCondition: 'The draft claims a winner exists.',
    expectedVerdict: 'revise',
    expectedReasonCode: 'unsupported_claim',
    forbiddenBehavior: 'A hidden repair or unbounded generation loop is started.',
  },
  {
    id: 'omitted-unresolved-risk',
    traceCondition: 'A high-risk target remains unresolved in a completed bounded trace.',
    finalAnswerCondition: 'The draft omits that uncertainty.',
    expectedVerdict: 'revise',
    expectedReasonCode: 'unresolved_high_risk',
    forbiddenBehavior: 'Sidecar reruns the repository audit or starts an Agent.',
  },
  {
    id: 'complete-trace-positive',
    traceCondition: 'All relevant targets are dispositioned with no material degradation.',
    finalAnswerCondition: 'The answer matches visible evidence and discloses bounded scope.',
    expectedVerdict: 'accept',
    forbiddenBehavior: 'Sidecar duplicates the completed domain review.',
  },
]);
