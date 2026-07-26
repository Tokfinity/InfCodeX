/**
 * FEATURE_184 (v0.7.45) — Production Sidecar Verifier context builder.
 *
 * Phase D.2 plumbing. Extracts the verifier's input context from the
 * StopHookContext (transcript + lastAssistantText) plus per-run side
 * channels (ManagedMutationTracker file edits and the committed Todo plan).
 * Structured task results and tool outcomes are selected from the transcript.
 *
 * Design references:
 * - ADR-030 (docs/ADR.md)
 * - v0.7.45.md §FEATURE_184 Phase D.2
 */

import type { KodaXMessage, KodaXTaskResultMetadata } from '@kodax-ai/llm';
import type {
  KodaXTaskVerificationContract,
  ManagedMutationTracker,
  TodoList,
} from '../../../types.js';
import type {
  SidecarPlanEvidence,
  SidecarQualitySignals,
  SidecarTaskEvidence,
  SidecarToolOutcomeEvidence,
  SidecarVerifierContextInputs,
} from './verifier.js';
import type { PatternTrace } from '../../../orchestration/pattern-trace.js';

const ROLLING_BUFFER_SIZE = 24;
const TASK_EVIDENCE_LIMIT = 20;
const PLAN_EVIDENCE_LIMIT = 20;
const TOOL_OUTCOME_LIMIT = 32;
const FILE_EDIT_LIMIT = 40;
const ARTIFACT_REF_LIMIT = 8;
const FILE_PATH_LIMIT = 400;
const TRUNCATION_MARKER = '...[truncated]';

interface CurrentIntentSelection {
  readonly queries: readonly string[];
  readonly indexes: ReadonlySet<number>;
  readonly startIndex: number;
}

function selectCurrentUserIntent(
  transcript: readonly KodaXMessage[],
): CurrentIntentSelection {
  let latestIndex = -1;
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const message = transcript[i];
    if (!message || message.role !== 'user' || message._synthetic) continue;
    if (!extractTextFromContentBlocks(message.content).trim()) continue;
    latestIndex = i;
    break;
  }
  if (latestIndex < 0) return { queries: [], indexes: new Set(), startIndex: 0 };

  const latest = transcript[latestIndex];
  const indexes = latest?.turnId
    ? transcript.flatMap((message, index) => (
        message.role === 'user'
        && !message._synthetic
        && message.turnId === latest.turnId
        && extractTextFromContentBlocks(message.content).trim()
          ? [index]
          : []
      ))
    : [latestIndex];
  return {
    queries: indexes.map((index) => extractTextFromContentBlocks(transcript[index]?.content ?? '')),
    indexes: new Set(indexes),
    startIndex: indexes[0] ?? latestIndex,
  };
}

/**
 * Extract the real user messages that own the CURRENT turn. The latest
 * non-synthetic user message is authoritative; when it has a turn id, sibling
 * real-user messages with that id are retained. Legacy transcripts without a
 * turn id use the latest real-user fallback.
 *
 * Edge case: an empty transcript or one with only system messages
 * yields zero queries (verifier sees "no current-turn queries" — the
 * prompt explicitly handles this case).
 */
export function extractCurrentTurnUserQueries(
  transcript: readonly KodaXMessage[],
): string[] {
  return [...selectCurrentUserIntent(transcript).queries];
}

function extractTextFromContentBlocks(
  content: KodaXMessage['content'],
): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && 'type' in block) {
      if (block.type === 'text' && 'text' in block && typeof block.text === 'string') {
        out.push(block.text);
      } else if (block.type === 'tool_result' && 'content' in block) {
        // Tool result blocks — skip; not user-authored.
        continue;
      }
    }
  }
  return out.join('\n');
}

/**
 * Take the last `ROLLING_BUFFER_SIZE` messages from the transcript for
 * the verifier's "recent conversational context". Drops `system` role
 * messages (verifier has its own system prompt; main agent's would
 * confuse role separation).
 */
export function extractRollingBuffer(
  transcript: readonly KodaXMessage[],
): KodaXMessage[] {
  const filtered = transcript.filter((m) => m.role !== 'system');
  if (filtered.length <= ROLLING_BUFFER_SIZE) return filtered;
  return filtered.slice(filtered.length - ROLLING_BUFFER_SIZE);
}

/**
 * Build a file-edit summary from the ManagedMutationTracker.
 *
 * `ManagedMutationTracker.files` is `Map<path, opCount>` (types.ts:966).
 * Verifier sees `path: N op(s)` rows — enough to compare "agent claimed
 * X edits" against "tracker observed Y mutations". A future iteration
 * can enrich the tracker with diff previews; for v0.7.45 op-count
 * presence is sufficient to detect the "claimed-completion-without-
 * actual-edits" case the verifier most needs to catch.
 */
export function buildFileEditSummary(
  mutationTracker: ManagedMutationTracker | undefined,
): { path: string; diffHint: string }[] {
  if (!mutationTracker) return [];
  const out: { path: string; diffHint: string }[] = [];
  for (const [path, opCount] of mutationTracker.files) {
    if (out.length >= FILE_EDIT_LIMIT) break;
    const label = opCount === 1 ? '1 mutation' : `${opCount} mutations`;
    const boundedPath = path.length <= FILE_PATH_LIMIT
      ? path
      : `${path.slice(0, FILE_PATH_LIMIT - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
    out.push({ path: boundedPath, diffHint: label });
  }
  return out;
}

function taskResults(message: KodaXMessage): readonly KodaXTaskResultMetadata[] {
  if (message._taskResults) {
    return message._taskResult
      ? [...message._taskResults, message._taskResult]
      : message._taskResults;
  }
  return message._taskResult ? [message._taskResult] : [];
}

function extractTaskEvidence(
  transcript: readonly KodaXMessage[],
  startIndex: number,
): { readonly items: readonly SidecarTaskEvidence[]; readonly omitted: number } {
  const byTask = new Map<string, SidecarTaskEvidence>();
  for (const message of transcript.slice(startIndex)) {
    for (const result of taskResults(message)) {
      const refs = result.artifactRefs ?? [];
      const evidence: SidecarTaskEvidence = {
        source: result.source,
        taskId: result.taskId,
        status: result.status,
        ...(result.title ? { title: result.title } : {}),
        ...(result.summary ? { summary: result.summary } : {}),
        artifactRefs: refs.slice(0, ARTIFACT_REF_LIMIT),
        omittedArtifactRefCount: Math.max(0, refs.length - ARTIFACT_REF_LIMIT),
      };
      const key = `${result.source}\0${result.taskId}`;
      byTask.delete(key);
      byTask.set(key, evidence);
    }
  }
  const all = [...byTask.values()];
  return {
    items: all.slice(Math.max(0, all.length - TASK_EVIDENCE_LIMIT)),
    omitted: Math.max(0, all.length - TASK_EVIDENCE_LIMIT),
  };
}

function extractPlanEvidence(
  plan: TodoList | undefined,
): { readonly items: readonly SidecarPlanEvidence[]; readonly omitted: number } {
  const all = (plan ?? []).map((item): SidecarPlanEvidence => ({
    id: item.id,
    subject: item.subject,
    status: item.status,
    ...(item.owner ? { owner: item.owner } : {}),
    ...(item.note ? { note: item.note } : {}),
  }));
  if (all.length <= PLAN_EVIDENCE_LIMIT) return { items: all, omitted: 0 };
  const needsAttention = all.filter((item) => (
    item.status === 'pending'
    || item.status === 'in_progress'
    || item.status === 'failed'
    || item.status === 'cancelled'
  ));
  const settled = all.filter((item) => (
    item.status === 'completed' || item.status === 'skipped'
  ));
  const selectedAttention = needsAttention.slice(0, PLAN_EVIDENCE_LIMIT);
  const remaining = PLAN_EVIDENCE_LIMIT - selectedAttention.length;
  const selectedSettled = settled.slice(Math.max(0, settled.length - remaining));
  const selected = [...selectedAttention, ...selectedSettled];
  return {
    items: selected,
    omitted: Math.max(0, all.length - selected.length),
  };
}

function extractToolOutcomeEvidence(
  transcript: readonly KodaXMessage[],
  startIndex: number,
): { readonly items: readonly SidecarToolOutcomeEvidence[]; readonly omitted: number } {
  const toolNames = new Map<string, string>();
  const outcomes: SidecarToolOutcomeEvidence[] = [];
  for (const message of transcript.slice(startIndex)) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === 'tool_use') toolNames.set(block.id, block.name);
      if (block.type !== 'tool_result') continue;
      const toolName = toolNames.get(block.tool_use_id);
      if (!toolName) continue;
      outcomes.push({ toolName, outcome: block.is_error ? 'error' : 'ok' });
    }
  }
  return {
    items: outcomes.slice(Math.max(0, outcomes.length - TOOL_OUTCOME_LIMIT)),
    omitted: Math.max(0, outcomes.length - TOOL_OUTCOME_LIMIT),
  };
}

function buildRecentTranscript(
  transcript: readonly KodaXMessage[],
  intent: CurrentIntentSelection,
  lastAssistantText: string,
): KodaXMessage[] {
  let terminalAssistantIndex = -1;
  const terminalText = lastAssistantText.trim();
  if (terminalText) {
    for (let i = transcript.length - 1; i >= 0; i -= 1) {
      const message = transcript[i];
      if (
        message?.role === 'assistant'
        && extractTextFromContentBlocks(message.content).trim() === terminalText
      ) {
        terminalAssistantIndex = i;
        break;
      }
    }
  }
  const deduplicated = transcript.filter((message, index) => (
    !intent.indexes.has(index)
    && index !== terminalAssistantIndex
    && !(
      index >= intent.startIndex
      && message._synthetic
      && taskResults(message).length > 0
    )
  ));
  return extractRollingBuffer(deduplicated);
}

export interface BuildVerifierContextOptions {
  readonly transcript: readonly KodaXMessage[];
  readonly lastAssistantText: string;
  readonly mutationTracker?: ManagedMutationTracker;
  readonly plan?: TodoList;
  /**
   * FEATURE_247 (R3) — effective verification standard (profile default merged
   * with per-task). Rendered into `additionalCriteria` when present so the
   * verifier holds the answer to the profile's standard (source faithfulness,
   * citations, uncertainty disclosure, no-project-file-modification, …).
   */
  readonly verification?: KodaXTaskVerificationContract;
  readonly qualitySignals?: SidecarQualitySignals;
  readonly patternTrace?: PatternTrace;
}

/**
 * FEATURE_247 (R3) — render a verification contract into a compact criteria
 * block for the verifier user message. Returns undefined when the contract
 * carries no actionable content (so nothing is injected).
 */
export function renderVerificationCriteria(
  contract: KodaXTaskVerificationContract | undefined,
): string | undefined {
  if (!contract) return undefined;
  const lines: string[] = [];
  if (contract.summary?.trim()) lines.push(contract.summary.trim());
  if (contract.rubricFamily) lines.push(`Rubric family: ${contract.rubricFamily}`);
  for (const instruction of contract.instructions ?? []) {
    if (instruction.trim()) lines.push(`- ${instruction.trim()}`);
  }
  for (const criterion of contract.criteria ?? []) {
    const label = criterion.label?.trim() || criterion.id;
    const desc = criterion.description?.trim();
    lines.push(desc ? `- ${label}: ${desc}` : `- ${label}`);
  }
  for (const evidence of contract.requiredEvidence ?? []) {
    if (evidence.trim()) lines.push(`- Required evidence: ${evidence.trim()}`);
  }
  return lines.length > 0 ? lines.join('\n') : undefined;
}

/**
 * Build the full `SidecarVerifierContextInputs` from a StopHookContext
 * + side-channel state. Pure composition of the extractors above.
 */
export function buildVerifierContext(
  options: BuildVerifierContextOptions,
): SidecarVerifierContextInputs {
  const additionalCriteria = renderVerificationCriteria(options.verification);
  const intent = selectCurrentUserIntent(options.transcript);
  const tasks = extractTaskEvidence(options.transcript, intent.startIndex);
  const plan = extractPlanEvidence(options.plan);
  const tools = extractToolOutcomeEvidence(options.transcript, intent.startIndex);
  const fileEditSummary = buildFileEditSummary(options.mutationTracker);
  return {
    currentTurnUserQueries: intent.queries,
    recentTranscript: buildRecentTranscript(
      options.transcript,
      intent,
      options.lastAssistantText,
    ),
    fileEditSummary,
    omittedFileEditCount: Math.max(
      0,
      (options.mutationTracker?.files.size ?? 0) - fileEditSummary.length,
    ),
    taskEvidence: tasks.items,
    omittedTaskEvidenceCount: tasks.omitted,
    planEvidence: plan.items,
    omittedPlanEvidenceCount: plan.omitted,
    toolOutcomeEvidence: tools.items,
    omittedToolOutcomeEvidenceCount: tools.omitted,
    lastAssistantText: options.lastAssistantText,
    ...(additionalCriteria ? { additionalCriteria } : {}),
    ...(options.qualitySignals ? { qualitySignals: options.qualitySignals } : {}),
    ...(options.patternTrace ? { patternTrace: options.patternTrace } : {}),
  };
}
