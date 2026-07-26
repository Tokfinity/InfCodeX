import { createHash } from 'node:crypto';

import type {
  MemoryRecallCandidate,
  PersistedOutcomeDigest,
} from '@kodax-ai/agent/experimental-memory';
import type { KodaXSessionArtifactLedgerEntry } from '../types.js';
import type { TodoStore } from '../task-engine/todo-store.js';

const MAX_CONTEXT_CHARS = 6_000;

export interface CodingMemoryContextInput {
  readonly objective: string;
  readonly decisionIntent: string;
  readonly actionSignature?: string;
  readonly goal?: { readonly objective: string; readonly status: string };
  readonly todoStore?: TodoStore;
  readonly artifacts?: readonly KodaXSessionArtifactLedgerEntry[];
  readonly childSummaries?: readonly string[];
  readonly verifierOutcome?: string;
  readonly recentOutcomeDigests?: readonly PersistedOutcomeDigest[];
  readonly observationSequence: number;
}

export interface CodingMemoryContext {
  readonly revision: string;
  readonly text: string;
  readonly decisionIntent: string;
  readonly actionSignature?: string;
  readonly throughSequence: number;
  readonly currentCandidates: readonly MemoryRecallCandidate[];
}

export function buildCodingMemoryContext(input: CodingMemoryContextInput): CodingMemoryContext {
  const lines: string[] = [
    `Objective: ${compact(input.objective)}`,
    `Decision intent: ${compact(input.decisionIntent)}`,
  ];
  if (input.actionSignature !== undefined) lines.push(`Action: ${compact(input.actionSignature)}`);
  if (input.goal !== undefined) {
    lines.push(`Goal (${compact(input.goal.status)}): ${compact(input.goal.objective)}`);
  }
  const openTodos = (input.todoStore?.getAll() ?? [])
    .filter((todo) => todo.status !== 'completed' && todo.status !== 'skipped');
  for (const todo of openTodos) {
    lines.push(`Todo ${todo.id} (${todo.status}): ${compact(todo.subject)}`);
  }
  for (const artifact of (input.artifacts ?? []).slice(-12)) {
    lines.push(`Artifact ${artifact.kind}: ${compact(artifact.summary ?? artifact.displayTarget ?? artifact.target)}`);
  }
  for (const summary of (input.childSummaries ?? []).slice(-6)) {
    lines.push(`Child: ${compact(summary)}`);
  }
  if (input.verifierOutcome !== undefined) lines.push(`Verifier: ${compact(input.verifierOutcome)}`);
  for (const digest of (input.recentOutcomeDigests ?? []).slice(-6)) {
    lines.push(`Outcome ${digest.outcome}: ${compact(digest.summary)}`);
  }
  const text = boundedLines(lines);
  const currentCandidates: MemoryRecallCandidate[] = [{
    refId: 'current:objective',
    claim: compact(input.objective),
    claimKind: 'objective',
    source: 'current',
    evidenceRefs: ['user:current-objective'],
  }];
  const orderedTodos = [
    ...openTodos.filter((todo) => todo.status === 'in_progress'),
    ...openTodos.filter((todo) => todo.status !== 'in_progress'),
  ];
  for (const todo of orderedTodos) {
    currentCandidates.push({
      refId: `current:todo:${todo.id}`,
      claim: `Open todo (${todo.status}): ${compact(todo.subject)}`,
      claimKind: 'todo',
      source: 'current',
      evidenceRefs: [`todo:${todo.id}`],
    });
  }
  return {
    revision: createHash('sha256').update(text).digest('hex'),
    text,
    decisionIntent: input.decisionIntent,
    ...(input.actionSignature !== undefined ? { actionSignature: input.actionSignature } : {}),
    throughSequence: input.observationSequence,
    currentCandidates,
  };
}

function boundedLines(lines: readonly string[]): string {
  let output = '';
  for (const line of lines) {
    const next = output.length === 0 ? line : `${output}\n${line}`;
    if (next.length > MAX_CONTEXT_CHARS) break;
    output = next;
  }
  return output;
}

function compact(value: string): string {
  return redactRestricted(value).replace(/\s+/g, ' ').trim().slice(0, 480);
}

function redactRestricted(value: string): string {
  return value
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|$)/gi, '[restricted]')
    .replace(/authorization:\s*bearer\s+\S+/gi, 'authorization: [restricted]')
    .replace(/\b(?:api[_-]?key|password|secret|token)\s*[:=]\s*\S+/gi, '[restricted]');
}
