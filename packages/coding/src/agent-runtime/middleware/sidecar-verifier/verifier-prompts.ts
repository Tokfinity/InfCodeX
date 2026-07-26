/**
 * FEATURE_184 (v0.7.45) — Sidecar Verifier prompt assets.
 *
 * Phase D.1 of ADR-030 (claudecode-shape Main Agent + Sidecar Verifier).
 * Used by `verifier.ts` to run a second-pass verification LLM call when
 * the Main Agent terminates a turn text-only (no tool_use). The
 * verifier reads the just-rendered final assistant text + recent
 * transcript + key artifacts and emits exactly one
 * `emit_sidecar_verdict` tool call.
 *
 * Design references:
 * - ADR-030 (docs/ADR.md)
 * - v0.7.45.md §FEATURE_184 Phase D
 * - claudecode `query.ts:1278,1282-1305` (preventContinuation /
 *   blockingErrors) — origin of the three-state verdict
 *
 * Pure data + pure-function — no side effects, no I/O.
 */

import type { KodaXMessage, KodaXToolDefinition } from '@kodax-ai/llm';
import type {
  PatternTrace,
  PatternTraceDispositionFact,
  PatternTraceStage,
} from '../../../orchestration/pattern-trace.js';
import type { SidecarVerifierContextInputs } from './verifier.js';

const MAX_PATTERN_TRACE_UTF8_BYTES = 8_000;

/**
 * Sidecar Verifier SYSTEM_PROMPT — pinned by the FEATURE_184 Phase D.4
 * eval (when run). Establishes (a) role separation (verifier is judging
 * the Main Agent's output, not authoring), (b) the three-state decision
 * criteria, (c) the output format (single forced tool call, no
 * narration).
 *
 * Style: third-person framing throughout. Verifier refers to the Main
 * Agent's actions in the third person — "the agent claimed", "the
 * agent edited" — to prevent first-person confusion that bit F178
 * during the eval pilot.
 */
export const VERIFIER_SYSTEM_PROMPT: string = [
  'You are a verification sidecar for an autonomous coding agent. A DIFFERENT agent (the "main agent") has just emitted what it considers its final answer for the user\'s current request. Your job is to do a second-pass judgment from the user\'s original ask, the main agent\'s recent transcript and final text, plus bounded control-plane evidence about delegated tasks, plan state, tool outcomes, and file edits.',
  '',
  '# IMPORTANT — role separation',
  '',
  'The transcript shown to you contains the MAIN AGENT\'s past messages and tool calls. You are NOT the author of those messages. You are a third-party observer judging whether that agent satisfied the user\'s request. Do not say "I edited the file" or "my reasoning" — the actions belong to the main agent. Your only action is to call `emit_sidecar_verdict` once.',
  '',
  '# Evidence semantics',
  '',
  '- Treat structured evidence as control-plane observations, not as stronger proof than it actually provides.',
  '- Task status proves lifecycle state, not correctness. A completed task summary is still an agent-produced claim; compare it with the request, transcript, and final answer.',
  '- A successful tool outcome only means the tool returned without error. It does not prove that tests passed or that the requested behavior is correct.',
  '- Plan state can expose an unfinished obligation, but plans can contain stale, optional, or superseded items. Do not reject solely because a plan item is still open; revise only when it corresponds to a requirement the user actually asked for and the final answer claims completion.',
  '- Omission counts mean the envelope was deliberately bounded. Do not infer failure merely because older evidence was omitted.',
  '',
  '# Three-state verdict',
  '',
  'Call `emit_sidecar_verdict` with one of three verdict values:',
  '',
  '## verdict = "accept"',
  '',
  'The main agent\'s output satisfies the user\'s current ask:',
  '- The text answer addresses what the user asked',
  '- IF the task required code changes: the file edits shown actually implement what the agent claimed',
  '- No obvious correctness issues in the diff (compile-breaking syntax, missing imports, wrong API usage)',
  '- The agent did not hallucinate completion of work it never performed',
  '',
  'If the current request is already satisfied and the final text merely offers optional follow-up or additional work, choose `accept` even when that offer is phrased as a question. Judge completion against the current request, not against work the agent only offered to do next.',
  '',
  'A reasonable workaround that satisfies the user\'s stated ask is `accept`, not `revise`. When the agent explained why the literal approach was not viable and the workaround achieves the goal, accept it — do not penalize a valid divergence.',
  '',
  '## verdict = "revise"',
  '',
  'The main agent\'s output is missing the literal thing the user named in the current turn. Use revise when ONE more iteration could plausibly close a gap that the user actually asked about:',
  '- A sub-requirement explicitly named in the user\'s ask was not satisfied',
  '- The agent claimed completion but the file-edit summary contradicts the claim (intent-vs-action gap)',
  '- The text answer is too vague where the user asked for specifics',
  '',
  'Scope discipline (important — over-revising is a failure mode):',
  '- If the user asked for feature X and the diff implements feature X (even imperfectly), that is `accept`, not `revise`. Hardening, cleanup, leak-prevention, and best-practice polish are NOT "missing pieces" — they are unrequested improvements. Example: user asks "add a 5-second timeout to fetch"; the agent uses setTimeout without clearTimeout. The timeout fires. The user\'s ask is satisfied. Do NOT revise to add clearTimeout — the user can ask for that in a future turn if they care.',
  '- If the user named one call site (`fetchUser`) and the agent edited only that call site, do NOT revise to ask for "also handle the other fetch calls in the file" — the user did not name those.',
  '- Do not revise to ask the agent to re-show or re-verify work the transcript already shows. Trust the transcript.',
  '',
  'When you choose revise, populate `reason` with a concrete, actionable correction the main agent should make. The main agent will see this as a user message — write it like a user follow-up, not like a third-party report.',
  '',
  '## verdict = "blocked"',
  '',
  'The main agent has stopped because human input or external action is needed before another iteration can help:',
  '- A clarifying question is `blocked` only when the user must answer it before the current request can be satisfied.',
  '- The agent stopped to ask the user a clarifying question (correct behavior when the request is genuinely ambiguous — surface the question to the user, do not auto-answer it on the user\'s behalf)',
  '- Task requires resources or permissions the agent does not have',
  '- The agent is fundamentally on the wrong track and revising won\'t recover',
  '',
  'When you choose blocked, populate `reason` with what the user needs to do to unblock (answer the clarifying question, grant permission, take over manually).',
  '',
  '# Output format',
  '',
  'Output ONLY the `emit_sidecar_verdict` tool call — no narration, no other tool calls, no free-form text.',
].join('\n');

/**
 * `emit_sidecar_verdict` tool definition — pinned by the FEATURE_184
 * Phase D.4 eval. Forces structured output: `verdict` (3-state union)
 * + `reason` (string).
 *
 * `suggestedFix` is optional and currently only carries a one-line
 * hint. The reanimate text the main agent SEES is `reason` — keep
 * `reason` written in the voice the main agent should hear.
 */
export const VERIFIER_REPORT_TOOL: KodaXToolDefinition = {
  name: 'emit_sidecar_verdict',
  description:
    "Report your verification verdict on the main agent's final output.",
  input_schema: {
    type: 'object',
    properties: {
      verdict: {
        type: 'string',
        enum: ['accept', 'revise', 'blocked'],
        description:
          'accept = the main agent satisfied the user\'s ask. revise = close but needs one more pass; reason becomes the follow-up the main agent sees. blocked = cannot complete; reason tells the user what they need to do.',
      },
      reason: {
        type: 'string',
        description:
          'A brief rationale citing specific evidence — typically a few concise sentences. For revise, this becomes the synthetic user-message follow-up the main agent will see — write it like the user is asking for the fix. For blocked, this is shown to the user verbatim.',
      },
      suggestedFix: {
        type: 'string',
        description:
          'Optional one-line hint about HOW to address the issue (file path, function name, missing import, etc.). May be empty.',
      },
      reasonCode: {
        type: 'string',
        enum: [
          'missing_requirement',
          'contradicted_evidence',
          'unsupported_claim',
          'unresolved_high_risk',
          'verification_degraded',
        ],
        description: 'Optional focused gap class for revise/blocked only.',
      },
      recommendedPattern: {
        type: 'string',
        enum: [
          'classify-and-act',
          'fan-out-and-synthesize',
          'adversarial-verification',
          'generate-and-filter',
          'tournament',
          'loop-until-done',
        ],
        description: 'Optional advisory next collaboration pattern for revise/blocked only.',
      },
      targetEvidenceRefs: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional concrete evidence gaps targeted by the recommendation.',
      },
    },
    required: ['verdict', 'reason'],
  },
};

/**
 * Render a Main Agent transcript window as third-person text. Embedding
 * the transcript in the user message (instead of as priorMessages) is
 * critical: assistant-role messages passed via priorMessages cause the
 * verifier to misattribute the Main Agent's past actions as its own
 * (same finding as F178 stall sidecar pilot).
 *
 * Window: caller decides; this function just renders whatever it gets.
 * The recommended window for verifier is 24 messages (vs F178 stall's
 * 16) because verification needs more conversational context than
 * anomaly detection.
 */
export function renderTranscriptForVerifier(
  messages: readonly KodaXMessage[],
): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      const text = typeof m.content === 'string'
        ? m.content
        : extractTextFromContent(m.content);
      if (text.trim()) lines.push(`[USER]: ${truncate(text, 800)}`);
    } else if (m.role === 'assistant') {
      const text = typeof m.content === 'string'
        ? m.content
        : extractTextFromContent(m.content);
      const tools = extractToolCallsFromContent(m.content);
      if (text) lines.push(`[MAIN AGENT TEXT]: ${truncate(text, 800)}`);
      for (const t of tools) {
        lines.push(`[MAIN AGENT TOOL]: ${t.name}(${truncate(t.argsSummary, 300)})`);
      }
    } else if (m.role === 'system') {
      // Skip — verifier has its own system prompt; main agent's would
      // pollute role separation.
      continue;
    }
  }
  return lines.join('\n');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…[truncated]`;
}

function renderPatternTraceStage(stage: PatternTraceStage): string[] {
  const lines: string[] = [];
  const participantRoles = stage.contextFacts.participants
    .map((participant) => participant.role)
    .join(',');
  const dispositions = stage.dispositionCounts
    ? ` confirmed=${stage.dispositionCounts.confirmed}`
      + ` refuted=${stage.dispositionCounts.refuted}`
      + ` unresolved=${stage.dispositionCounts.unresolved}`
    : '';
  const targetPreview = stage.targetEvidenceRefs
    .slice(0, 3)
    .map((ref) => truncate(ref, 160))
    .join(',');
  const participantPreview = stage.participantTurnRefs
    .slice(0, 3)
    .map((ref) => `${truncate(ref.actorPath, 100)}#turn=${truncate(ref.turnId, 100)}`)
    .join(',');
  const participantContextPreview = stage.contextFacts.participants
    .slice(0, 3)
    .map((participant) => (
      `${participant.role}`
      + `/fork=${String(participant.forkTurns)}`
      + `/provider=${participant.effectiveProviderGroup ?? 'unknown'}`
      + `/model=${participant.effectiveModelGroup ?? 'unknown'}`
      + `/evidence=${participant.evidenceRefCount}`
    ))
    .join(',');
  const participantCount = stage.participantTurnRefs.length
    + stage.contextFacts.omittedParticipantCount;
  lines.push(
    `- stage=${truncate(stage.stageId, 120)}`
    + ` pattern=${stage.pattern}`
    + ` status=${stage.status}`
    + ` relation=${stage.laneRelation ?? 'unspecified'}`
    + ` participants=${participantCount}`
    + ` roles=${participantRoles || 'unknown'}`
    + `${participantPreview ? ` participantRefs=${participantPreview}` : ''}`
    + `${participantContextPreview ? ` participantContext=${participantContextPreview}` : ''}`
    + ` sharedEvidenceRefs=${stage.contextFacts.sharedEvidenceRefCount}`
    + `${stage.contextFacts.commonParentActorPath
      ? ` commonParent=${truncate(stage.contextFacts.commonParentActorPath, 120)}`
      : ''}`
    + ` targets=${stage.targetEvidenceRefs.length}`
    + ` projectionOmitted=${String(stage.contextFacts.contextProjectionOmitted)}`
    + `${targetPreview ? ` targetRefs=${targetPreview}` : ''}`
    + dispositions,
  );
  const renderedFacts = [...(stage.dispositionFacts ?? [])]
    .map((fact, index) => ({ fact, index }))
    .sort((left, right) => (
      dispositionPriority(left.fact) - dispositionPriority(right.fact)
      || left.index - right.index
    ))
    .slice(0, 4)
    .map(({ fact }) => fact);
  for (const fact of renderedFacts) {
    const support = fact.evidenceRefs
      .map((ref) => truncate(ref, 160))
      .join(',');
    lines.push(
      `  Outcome: target=${truncate(fact.targetEvidenceRef, 180)}`
      + ` disposition=${fact.disposition}`
      + `${support ? ` support=${support}` : ''}`
      + `${fact.omittedEvidenceRefCount > 0
        ? ` omittedSupport=${fact.omittedEvidenceRefCount}`
        : ''}`,
    );
  }
  const omittedOutcomes = (stage.dispositionFacts?.length ?? 0) > 4
    ? (stage.dispositionFacts?.length ?? 0) - 4
    : 0;
  if (omittedOutcomes + (stage.omittedDispositionCount ?? 0) > 0) {
    lines.push(
      `  (${omittedOutcomes + (stage.omittedDispositionCount ?? 0)} outcome fact(s) omitted)`,
    );
  }
  if (stage.actorAssertedCoverage && stage.actorAssertedCoverage.length > 0) {
    lines.push(
      `  Actor-asserted coverage: ${stage.actorAssertedCoverage
        .slice(0, 4)
        .map((entry) => truncate(entry, 160))
        .join(', ')}`,
    );
  }
  if (stage.degradedReasons && stage.degradedReasons.length > 0) {
    lines.push(`  Degraded: ${stage.degradedReasons.join(', ')}`);
  }
  if (stage.stopReason) lines.push(`  Stop: ${truncate(stage.stopReason, 240)}`);
  return lines;
}

function renderBoundedPatternTrace(trace: PatternTrace): string[] {
  const candidates = trace.stages
    .map((stage, index) => ({ stage, index }))
    .sort((left, right) => (
      Number(hasRiskDisposition(right.stage)) - Number(hasRiskDisposition(left.stage))
      || left.index - right.index
    ))
    .slice(0, 18);
  const renderedBlocks: string[][] = [];
  for (const { stage } of candidates) {
    const block = renderPatternTraceStage(stage);
    const candidateLines = [...renderedBlocks.flat(), ...block];
    if (Buffer.byteLength(candidateLines.join('\n'), 'utf8')
      > MAX_PATTERN_TRACE_UTF8_BYTES - 128) {
      break;
    }
    renderedBlocks.push(block);
  }

  let omittedStageCount = trace.omittedStageCount
    + trace.stages.length
    - renderedBlocks.length;
  let lines = renderedBlocks.flat();
  if (omittedStageCount > 0) {
    let marker = `(${omittedStageCount} additional strategy stage(s) omitted)`;
    while (
      renderedBlocks.length > 0
      && Buffer.byteLength([...lines, marker].join('\n'), 'utf8')
        > MAX_PATTERN_TRACE_UTF8_BYTES
    ) {
      renderedBlocks.pop();
      omittedStageCount += 1;
      lines = renderedBlocks.flat();
      marker = `(${omittedStageCount} additional strategy stage(s) omitted)`;
    }
    lines.push(marker);
  }
  return lines;
}

function hasRiskDisposition(stage: PatternTraceStage): boolean {
  return (stage.dispositionCounts?.refuted ?? 0) > 0
    || (stage.dispositionCounts?.unresolved ?? 0) > 0;
}

function dispositionPriority(fact: PatternTraceDispositionFact): number {
  return fact.disposition === 'refuted' ? 0 : fact.disposition === 'unresolved' ? 1 : 2;
}

function extractTextFromContent(
  content: KodaXMessage['content'],
): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && 'type' in block) {
      if (block.type === 'text' && 'text' in block && typeof block.text === 'string') {
        out.push(block.text);
      }
    }
  }
  return out.join('\n');
}

function extractToolCallsFromContent(
  content: KodaXMessage['content'],
): { name: string; argsSummary: string }[] {
  if (typeof content === 'string') return [];
  if (!Array.isArray(content)) return [];
  const out: { name: string; argsSummary: string }[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && 'type' in block && block.type === 'tool_use') {
      const name = 'name' in block && typeof block.name === 'string' ? block.name : '?';
      const input = 'input' in block ? block.input : undefined;
      const argsSummary =
        input === undefined
          ? ''
          : typeof input === 'string'
            ? input
            : JSON.stringify(input);
      out.push({ name, argsSummary });
    }
  }
  return out;
}

/**
 * Build the verifier's user-message body from context inputs. Combines:
 *   - The user's original current-turn ask(es) — always preserved in full
 *   - A rendered transcript window (last N messages)
 *   - Bounded delegated-task, plan-state, and tool-outcome evidence
 *   - A file-edit summary (paths + diff hints — verifier sees WHAT
 *     changed, not just what the agent claimed)
 *   - The final assistant text the agent produced
 *
 * This is rendered as a single user message and passed to the verifier
 * provider via `provider.stream`. Why one message, not priorMessages:
 * see the F178 finding above.
 */
export function buildVerifierUserMessage(inputs: SidecarVerifierContextInputs): string {
  const sections: string[] = [];

  sections.push('=== USER REQUEST (CURRENT TURN) ===');
  if (inputs.currentTurnUserQueries.length === 0) {
    sections.push('(no current-turn user queries — verifier should treat this as evidence missing)');
  } else {
    for (const q of inputs.currentTurnUserQueries) {
      sections.push(q);
    }
  }
  sections.push('');

  sections.push('=== RECENT MAIN AGENT TRANSCRIPT ===');
  const rendered = renderTranscriptForVerifier(inputs.recentTranscript);
  sections.push(rendered || '(empty)');
  sections.push('');

  sections.push('=== DELEGATED TASK EVIDENCE ===');
  const taskEvidence = inputs.taskEvidence ?? [];
  if (taskEvidence.length === 0) {
    sections.push('(no structured child or workflow completion evidence)');
  } else {
    for (const task of taskEvidence) {
      sections.push(
        `- [${task.status}] ${truncate(task.title ?? task.taskId, 240)} `
        + `(source=${task.source}, task_id=${truncate(task.taskId, 240)})`,
      );
      if (task.summary) sections.push(`  Summary: ${truncate(task.summary, 800)}`);
      if (task.artifactRefs.length > 0) {
        sections.push(`  Artifacts: ${task.artifactRefs.map((ref) => truncate(ref, 240)).join(', ')}`);
      }
      if (task.omittedArtifactRefCount > 0) {
        sections.push(`  (${task.omittedArtifactRefCount} additional artifact reference(s) omitted)`);
      }
    }
  }
  if ((inputs.omittedTaskEvidenceCount ?? 0) > 0) {
    sections.push(`(${inputs.omittedTaskEvidenceCount} additional task result(s) omitted)`);
  }
  sections.push('');

  sections.push('=== PLAN STATE ===');
  const planEvidence = inputs.planEvidence ?? [];
  if (planEvidence.length === 0) {
    sections.push('(no committed plan items)');
  } else {
    for (const item of planEvidence) {
      const identity = [`id=${truncate(item.id, 120)}`];
      if (item.owner) identity.push(`owner=${truncate(item.owner, 160)}`);
      sections.push(`- [${item.status}] ${truncate(item.subject, 400)} (${identity.join(', ')})`);
      if (item.note) sections.push(`  Note: ${truncate(item.note, 400)}`);
    }
  }
  if ((inputs.omittedPlanEvidenceCount ?? 0) > 0) {
    sections.push(`(${inputs.omittedPlanEvidenceCount} additional plan item(s) omitted)`);
  }
  sections.push('');

  sections.push('=== TOOL OUTCOMES ===');
  const toolOutcomes = inputs.toolOutcomeEvidence ?? [];
  if (toolOutcomes.length === 0) {
    sections.push('(no structured tool outcomes in the current verification window)');
  } else {
    for (const outcome of toolOutcomes) {
      sections.push(`- ${truncate(outcome.toolName, 160)}: ${outcome.outcome}`);
    }
  }
  if ((inputs.omittedToolOutcomeEvidenceCount ?? 0) > 0) {
    sections.push(`(${inputs.omittedToolOutcomeEvidenceCount} additional tool outcome(s) omitted)`);
  }
  sections.push('');

  if (inputs.qualitySignals || inputs.patternTrace) {
    sections.push('=== QUALITY STRATEGY FACTS (context, not proof) ===');
    if (inputs.qualitySignals) {
      const signals = inputs.qualitySignals;
      sections.push(
        `Signals: risk=${signals.riskLevel ?? 'unknown'}`
        + ` needsIndependentQA=${String(signals.needsIndependentQA ?? false)}`
        + ` assuranceIntent=${signals.assuranceIntent ?? 'default'}`
        + ` reviewScale=${signals.reviewScale ?? 'unknown'}`
        + ` requiresBrainstorm=${String(signals.requiresBrainstorm ?? false)}`,
      );
    }
    if (inputs.patternTrace) {
      sections.push(...renderBoundedPatternTrace(inputs.patternTrace));
    } else {
      sections.push('(no attributable delegated strategy trace)');
    }
    sections.push(
      'Interpretation: coverage, replication, and opposition are distinct. Stage count or completion does not prove correctness. Do not resurrect refuted findings; resolve or disclose relevant unresolved/degraded facts. Missing optional patterns or solo execution are not failures by themselves. Judge the final answer from this bounded packet; do not repeat the domain audit or orchestrate Agents.',
    );
    sections.push('');
  }

  sections.push('=== FILE EDITS PERFORMED THIS TURN ===');
  if (inputs.fileEditSummary.length === 0) {
    sections.push('(no file edits — text-only response, OR the agent did not actually edit anything despite claiming it did)');
  } else {
    for (const edit of inputs.fileEditSummary) {
      sections.push(`- ${edit.path}: ${truncate(edit.diffHint, 400)}`);
    }
  }
  if ((inputs.omittedFileEditCount ?? 0) > 0) {
    sections.push(`(${inputs.omittedFileEditCount} additional file(s) omitted)`);
  }
  sections.push('');

  sections.push('=== MAIN AGENT FINAL TEXT (the answer the agent is delivering) ===');
  sections.push(inputs.lastAssistantText || '(empty text response)');
  sections.push('');

  // FEATURE_247 (R3): when the active profile (e.g. Partner) declares a
  // verification standard, hold the answer to it in addition to the base
  // checks. Present only when supplied ⇒ default coding verifier prompt is
  // byte-identical.
  if (inputs.additionalCriteria && inputs.additionalCriteria.trim()) {
    sections.push('=== ADDITIONAL VERIFICATION CRITERIA (active profile standard) ===');
    sections.push(inputs.additionalCriteria.trim());
    sections.push('');
  }

  sections.push(
    'Now call `emit_sidecar_verdict` exactly once with verdict ∈ {accept, revise, blocked} and a `reason`. Remember: when verdict=revise, the `reason` becomes a synthetic user follow-up the main agent will see — write it as the user would.',
  );

  return sections.join('\n');
}
