import type { WorkflowPatternId } from '@kodax-ai/agent';

export type CollaborationPatternId = WorkflowPatternId;

export interface CollaborationPatternDefinition {
  readonly id: CollaborationPatternId;
  readonly purpose: string;
  readonly usefulSignals: readonly string[];
  readonly expectedEvidence: readonly string[];
  readonly stopRules: readonly string[];
}

export const COLLABORATION_PATTERN_CATALOG: readonly CollaborationPatternDefinition[] = [
  {
    id: 'classify-and-act',
    purpose: 'Classify an ambiguous or mixed request, then act on the selected route.',
    usefulSignals: ['mixed scopes, uncertain routing, or a relevant specialist'],
    expectedEvidence: ['route, confidence, unknowns, and why execution changes'],
    stopRules: ['act when the route is clear; otherwise use one bounded evidence lane'],
  },
  {
    id: 'fan-out-and-synthesize',
    purpose: 'Split independent scopes or hypotheses, then synthesize their evidence.',
    usefulSignals: ['two or more bounded lanes can proceed independently'],
    expectedEvidence: ['coverage, gaps, agreements, disagreements, and provenance'],
    stopRules: ['stop when decision-relevant coverage is adequate'],
  },
  {
    id: 'adversarial-verification',
    purpose: 'Challenge a concrete high-risk candidate against targeted evidence.',
    usefulSignals: ['a claim, plan, patch, or winner exists and failure matters'],
    expectedEvidence: ['confirmed, refuted, and unresolved target dispositions'],
    stopRules: ['stop when relevant targets are dispositioned or uncertainty is disclosed'],
  },
  {
    id: 'generate-and-filter',
    purpose: 'Generate distinct candidates, then filter them under hard constraints.',
    usefulSignals: ['the task benefits from viable alternatives'],
    expectedEvidence: ['candidate set, rejection reasons, and surviving options'],
    stopRules: ['stop on a viable shortlist or report that none passed'],
  },
  {
    id: 'tournament',
    purpose: 'Compare complete alternatives under one evidence-backed rubric.',
    usefulSignals: ['two or more plausible complete options remain'],
    expectedEvidence: ['common-rubric trade-offs, decisive evidence, and uncertainty'],
    stopRules: ['select only when evidence distinguishes an option'],
  },
  {
    id: 'loop-until-done',
    purpose: 'Run bounded follow-ups while each round reduces a named uncertainty.',
    usefulSignals: ['new evidence can materially change the next round'],
    expectedEvidence: ['round delta, remaining uncertainty, and stop reason'],
    stopRules: ['stop on no material delta, resolution, external input, or hard budget'],
  },
] as const;

export const WORKFLOW_REVIEW_COMPOSITION_GUIDANCE =
  'For an explicitly requested review or audit Workflow, combine fan-out-and-synthesize with adversarial-verification: declare [\'fan-out-and-synthesize\', \'adversarial-verification\'], give each verifier a distinct failure-mode angle, and assess every finding against shared evidence and a common rubric. Keep confirmed findings, exclude refuted findings, and disclose unresolved findings; verifier count is not proof. This refutes a reviewer blind spot before synthesis.';

export function getCollaborationPatternDefinition(
  id: CollaborationPatternId,
): CollaborationPatternDefinition {
  const definition = COLLABORATION_PATTERN_CATALOG.find((candidate) => candidate.id === id);
  if (definition === undefined) throw new Error(`missing collaboration pattern: ${id}`);
  return definition;
}

export function renderAmaPatternPlaybook(): string {
  return [
    'ADAPTIVE COLLABORATION PATTERNS (guidance, not deterministic routing):',
    ...COLLABORATION_PATTERN_CATALOG.map((definition) =>
      `- \`${definition.id}\`: ${definition.purpose} Evidence: ${definition.expectedEvidence[0]}. Stop: ${definition.stopRules[0]}.`),
    '- Compose stages only when they add decision value; ordinary work may stay solo. Root remains accountable for synthesis.',
    '- When delegating a named pattern stage, set `quality_strategy` on every `spawn_agent` or stage-changing `followup_task`: use `{schemaVersion:1, stageId, pattern, role, laneRelation?, targetEvidenceRefs?}`. Keep one stable `stageId` across participants in the same stage.',
    '- Use `laneRelation:"coverage"` for distinct scopes, `"replication"` only for genuinely independent checks, and `"opposition"` for challengers. A challenger must name a terminal exact `agent-turn:` or immutable evidence target.',
    '- Omit `quality_strategy` for solo/direct work. Metadata records intent and provenance; it never proves correctness or requires starting an Agent for telemetry.',
  ].join('\n');
}

export function renderWorkflowPatternGuidance(): readonly string[] {
  return [
    ...COLLABORATION_PATTERN_CATALOG.map(
      (definition) => `- ${definition.id}: ${definition.purpose}`,
    ),
    `- ${WORKFLOW_REVIEW_COMPOSITION_GUIDANCE}`,
  ];
}
