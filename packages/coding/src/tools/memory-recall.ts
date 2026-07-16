import { createHash } from 'node:crypto';

import type { MemorySession } from '@kodax-ai/agent/experimental-memory';

import type { KodaXToolExecutionContext } from '../types.js';
import { renderMemoryEvidenceEnvelope } from '../memory/rendering.js';

export const MEMORY_RECALL_TOOL_NAME = 'memory_recall';

export const MEMORY_RECALL_TOOL_DESCRIPTION = [
  'Recall governed prior experience for one specific decision-relevant gap.',
  'Use only when current context does not answer a concrete historical need.',
  'When prior execution experience is the known missing source, use this before unrelated repository exploration.',
  'Do not use for current repository or environment facts; verify those with normal tools.',
  'The query is read-only, exactly scoped to the current MemorySession, and may return no claim.',
].join(' ');

export const MEMORY_RECALL_TOOL_SCHEMA = {
  type: 'object' as const,
  properties: {
    need: {
      type: 'string' as const,
      description: 'One concrete prior-experience gap relevant to the current decision.',
    },
  },
  required: ['need'],
};

export const MEMORY_RECALL_TOOL_BYTES_SHA256 = `sha256:${createHash('sha256')
  .update(JSON.stringify({
    name: MEMORY_RECALL_TOOL_NAME,
    description: MEMORY_RECALL_TOOL_DESCRIPTION,
    input_schema: MEMORY_RECALL_TOOL_SCHEMA,
  }))
  .digest('hex')}`;

const EMPTY_MEMORY_RECALL_RESULT = '[Memory recall: no applicable governed claim]';

export interface MemoryRecallDecisionBinding {
  readonly decisionRevision: string;
  readonly actionSignature?: string;
  readonly throughSequence: number;
}

export function activateMemoryRecallTool(
  activeTools: readonly string[],
  enabled: boolean,
): string[] {
  const withoutMemory = activeTools.filter((name) => name !== MEMORY_RECALL_TOOL_NAME);
  return enabled ? [...withoutMemory, MEMORY_RECALL_TOOL_NAME] : withoutMemory;
}

export function createMemoryRecallBinding(
  session: MemorySession,
  readDecision: () => MemoryRecallDecisionBinding | undefined,
): NonNullable<KodaXToolExecutionContext['memoryRecall']> {
  return async (need) => {
    const decision = readDecision();
    if (decision === undefined) return undefined;
    return session.query({
      decisionRevision: decision.decisionRevision,
      need,
      ...(decision.actionSignature !== undefined
        ? { actionSignature: decision.actionSignature }
        : {}),
      throughSequence: decision.throughSequence,
    });
  };
}

export async function toolMemoryRecall(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  const need = typeof input.need === 'string' ? input.need : '';
  if (ctx.memoryRecall === undefined || need.trim().length === 0) return EMPTY_MEMORY_RECALL_RESULT;
  const reminder = await ctx.memoryRecall(need);
  if (reminder === undefined || reminder.content.trim().length === 0) return EMPTY_MEMORY_RECALL_RESULT;
  return renderMemoryEvidenceEnvelope(reminder.content, reminder.evidenceRefs)
    ?? EMPTY_MEMORY_RECALL_RESULT;
}
