/**
 * FEATURE_217 (v0.7.49) Phase C — Built-in read-only workflow.
 *
 * `parallel-investigation`: fan out several READ-ONLY investigators over
 * a question (optionally split by target areas), then synthesize their
 * findings into one ranked, evidence-keeping report. A failing
 * investigator degrades the synthesis (its gap is noted) rather than
 * crashing the whole run. Writes nothing — purely investigative.
 */

import type { WorkflowApi, WorkflowModule, WorkflowTaskResult } from '@kodax-ai/agent';

export interface ParallelInvestigationArgs {
  /** What to investigate. */
  readonly question: string;
  /** Optional target areas/paths — one investigator per target. When
   *  absent, a small default set of generic angles is used. */
  readonly targets?: readonly string[];
  /** Synthesis rubric; sensible default when omitted. */
  readonly rubric?: string;
  /** Lifetime agent cap (investigators + 1 synthesizer). */
  readonly maxAgents?: number;
  /** In-flight investigator cap. */
  readonly maxConcurrency?: number;
}

export interface InvestigationFinding {
  readonly angle: string;
  readonly status: 'completed' | 'failed';
  readonly text: string;
}

export interface ParallelInvestigationResult {
  readonly synthesis: string;
  readonly findings: readonly InvestigationFinding[];
  /** True when ≥1 investigator failed and the synthesis ran degraded. */
  readonly degraded: boolean;
}

const DEFAULT_MAX_AGENTS = 8;
const DEFAULT_ANGLES: readonly string[] = [
  'structure, entry points, and control flow',
  'edge cases, error handling, and failure modes',
  'tests, validation, and existing coverage',
];

const DEFAULT_RUBRIC =
  'Deduplicate overlapping findings, keep concrete evidence (file:line), ' +
  'rank by relevance to the question, and explicitly note gaps left by any ' +
  'failed investigation.';

interface InvestigationAngle {
  readonly name: string;
  readonly prompt: string;
}

/**
 * FEATURE_246 — the investigator declares an `outputSchema` so its finding
 * arrives on `result.structured`, the ONE field synchronously awaited (with a
 * bounded repair turn) by the time `runAgent` resolves. `result.finalText` is
 * NOT reliable here: a child that ends its turn on a tool_use/handoff has an
 * empty or preparatory finalText, and its smart digest is delivered
 * asynchronously (agent_summary_updated) AFTER runAgent returns — so folding
 * `finalText` straight into synthesis produced empty findings even though the
 * per-agent digest was visible in the panel a moment later.
 */
const FINDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['finding'],
  properties: {
    finding: {
      type: 'string',
      description:
        'Your concrete findings for this focus, with file:line evidence. ' +
        'If nothing relevant was found, a brief note saying so.',
    },
  },
} as const;

/** Read the `{ finding }` string off a child's structured result, if present. */
function readStructuredFinding(structured: unknown): string | undefined {
  if (structured !== null && typeof structured === 'object' && 'finding' in structured) {
    const finding = (structured as { finding?: unknown }).finding;
    if (typeof finding === 'string' && finding.trim().length > 0) return finding;
  }
  return undefined;
}

/**
 * Pick the most reliable finding text: the schema-validated `structured.finding`
 * first, then a non-empty `finalText`. Never return an empty string silently —
 * that is the exact failure the synthesis surfaced as "发现:无".
 */
function pickFindingText(result: WorkflowTaskResult): string {
  const structured = readStructuredFinding(result.structured);
  if (structured) return structured;
  const finalText = result.finalText?.trim();
  if (finalText && finalText.length > 0) return result.finalText;
  return '[no finding text was returned — the investigator may have ended on a tool call without a closing summary]';
}

function buildInvestigatorPrompt(question: string, focus: string): string {
  return [
    `Investigate the following question (READ-ONLY — do not modify any files):`,
    question,
    '',
    `Focus your investigation on: ${focus}`,
    '',
    'Report concrete findings backed by evidence (cite file:line). If you ' +
      'find nothing relevant for this focus, say so briefly.',
  ].join('\n');
}

/** Resolve the investigation angles, reserving one agent for synthesis. */
function resolveAngles(args: ParallelInvestigationArgs): InvestigationAngle[] {
  const cap = Math.max(1, (args.maxAgents ?? DEFAULT_MAX_AGENTS) - 1);
  const foci = args.targets && args.targets.length > 0 ? args.targets : DEFAULT_ANGLES;
  return foci.slice(0, cap).map((focus, i) => ({
    name: `investigate-${i + 1}`,
    prompt: buildInvestigatorPrompt(args.question, focus),
  }));
}

async function investigate(
  wf: WorkflowApi,
  angle: InvestigationAngle,
): Promise<InvestigationFinding> {
  try {
    const result = await wf.runAgent({
      name: angle.name,
      prompt: angle.prompt,
      readOnly: true,
      modelHint: 'balanced',
      outputSchema: FINDING_SCHEMA,
    });
    // FEATURE_246 Part E: runAgent now resolves to null on a failed/stopped child
    // (instead of throwing), so treat null as a failed angle.
    if (result === null) {
      return { angle: angle.name, status: 'failed', text: '[investigation failed] agent did not complete' };
    }
    return {
      angle: angle.name,
      status: result.status === 'completed' ? 'completed' : 'failed',
      // Prefer the schema-validated structured finding over the timing-fragile
      // finalText (see FINDING_SCHEMA / pickFindingText).
      text: pickFindingText(result),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { angle: angle.name, status: 'failed', text: `[investigation failed] ${message}` };
  }
}

async function runParallelInvestigation(
  wf: WorkflowApi,
  args: ParallelInvestigationArgs,
): Promise<ParallelInvestigationResult> {
  const angles = resolveAngles(args);
  // `investigate` always resolves to a finding (its own try/catch), so parallel
  // never yields null here — but parallel's type is `(T | null)[]` (Part E
  // lenient failure), so filter to satisfy the type and stay null-safe.
  const findings = (await wf.phase('investigate', () =>
    wf.parallel(
      angles.map((angle) => () => investigate(wf, angle)),
      args.maxConcurrency !== undefined ? { concurrency: args.maxConcurrency } : undefined,
    ),
  )).filter((f): f is InvestigationFinding => f !== null);

  const degraded = findings.some((f) => f.status !== 'completed');
  const synthesis = await wf.phase('synthesize', () =>
    wf.synthesize({
      inputs: findings.map((f) => `### ${f.angle} (${f.status})\n${f.text}`),
      rubric: args.rubric ?? DEFAULT_RUBRIC,
    }),
  );

  return { synthesis: synthesis.text, findings, degraded };
}

export const parallelInvestigation: WorkflowModule<
  ParallelInvestigationArgs,
  ParallelInvestigationResult
> = {
  meta: {
    name: 'parallel-investigation',
    description:
      'Fan out read-only investigators over a question (split by target ' +
      'areas), then synthesize ranked, evidence-keeping findings.',
    maxAgents: DEFAULT_MAX_AGENTS,
    maxConcurrency: 4,
    readOnly: true,
    phases: ['investigate', 'synthesize'],
  },
  run: runParallelInvestigation,
};
