import type {
  MemoryEvidenceGrade,
  MemoryEvidenceRef,
  MemoryObservation,
  MemorySourcePolicy,
} from '@kodax-ai/agent/experimental-memory';
import type { KodaXToolResultBlock, KodaXToolUseBlock } from '../types.js';

export interface ToolMemoryObservationInput {
  readonly toolBlocks: readonly KodaXToolUseBlock[];
  readonly toolResults: readonly KodaXToolResultBlock[];
  readonly startSequence: number;
  readonly observedAt: string;
}

export function buildToolMemoryObservations(
  input: ToolMemoryObservationInput,
): readonly MemoryObservation[] {
  const resultByCall = new Map(input.toolResults.map((result) => [result.tool_use_id, result]));
  const observations: MemoryObservation[] = [];
  let sequence = input.startSequence;
  for (const block of input.toolBlocks) {
    if (block.name === 'memory_recall') continue;
    const result = resultByCall.get(block.id);
    if (result === undefined) continue;
    const content = toolResultText(result);
    const failure = result.is_error === true || /^\s*\[Tool Error\]/i.test(content);
    const verification = !failure && isVerificationToolCall(block);
    if (!failure && !verification) continue;
    if (isRestrictedMemoryContent(content)) continue;
    sequence += 1;
    observations.push({
      id: `tool-outcome:${block.id}`,
      sequence,
      kind: 'outcome',
      summary: failure
        ? `${block.name} failed under the current inputs and environment: ${boundedSummary(content)}`
        : `Verification command succeeded: ${boundedSummary(content)}`,
      evidence: [{
        ref: `tool-result:${block.id}`,
        requestedGrade: 'observed',
        source: 'tool',
        observedAt: input.observedAt,
      }],
      visibility: 'prompt_safe',
      actionSignature: verification ? `${block.name}:verify` : block.name,
      occurredAt: input.observedAt,
      metadata: { toolName: block.name, failed: failure },
    });
  }
  return observations;
}

export const codingMemorySourcePolicy: MemorySourcePolicy = (evidence) => {
  if (evidence.source === 'user' || evidence.source === 'host') return evidence.requestedGrade;
  if (evidence.source === 'environment') return capGrade(evidence, 'verified');
  if (evidence.source === 'tool') return capGrade(evidence, 'observed');
  return 'inferred';
};

function capGrade(evidence: MemoryEvidenceRef, ceiling: MemoryEvidenceGrade): MemoryEvidenceGrade {
  const order = ['inferred', 'observed', 'corroborated', 'verified', 'authoritative'] as const;
  return order[Math.min(order.indexOf(evidence.requestedGrade), order.indexOf(ceiling))] ?? 'inferred';
}

function isVerificationToolCall(block: KodaXToolUseBlock): boolean {
  if (block.name !== 'bash') return false;
  const command = readStringField(block.input, 'command');
  return command !== undefined
    && /(?:^|\s)(?:test|build|lint|check|typecheck|tsc|vitest|pytest|cargo\s+test|go\s+test)(?:\s|$|:)/i.test(command);
}

function readStringField(value: unknown, field: string): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const candidate = (value as Readonly<Record<string, unknown>>)[field];
  return typeof candidate === 'string' ? candidate : undefined;
}

function toolResultText(result: KodaXToolResultBlock): string {
  if (typeof result.content === 'string') return result.content;
  if (!Array.isArray(result.content)) return '';
  return result.content
    .map((item) => {
      if (typeof item !== 'object' || item === null || !('text' in item)) return '';
      return typeof item.text === 'string' ? item.text : '';
    })
    .filter((value) => value.length > 0)
    .join('\n');
}

function boundedSummary(value: string): string {
  const compact = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return (compact || 'no textual result').slice(0, 480);
}

function isRestrictedMemoryContent(value: string): boolean {
  return /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|authorization:\s*bearer\s+\S+|(?:api[_-]?key|password|secret|token)\s*[:=]\s*\S+)/i.test(value);
}
