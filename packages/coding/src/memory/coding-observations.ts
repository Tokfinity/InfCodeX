import { createHash } from 'node:crypto';

import { sanitizePromptSafeMemoryClaim } from '@kodax-ai/agent';
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
  readonly decisionActionSignature?: string;
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
    const verificationCall = isVerificationToolCall(block);
    const verification = !failure && verificationCall;
    const verificationCommand = verificationCall
      ? readStringField(block.input, 'command')
      : undefined;
    const safeVerificationCommand = verificationCommand === undefined
      ? undefined
      : sanitizePromptSafeMemoryClaim(verificationCommand, 240);
    const reusableLesson = verification && safeVerificationCommand !== undefined
      ? `Run \`${safeVerificationCommand}\` and require a successful verifier result.`
      : undefined;
    if (!failure && !verification) continue;
    if (verification && isRestrictedMemoryContent(content)) continue;
    const callRefId = canonicalToolCallId(block.id);
    const evidenceRef = `tool-result:${callRefId}`;
    const safeResult = sanitizePromptSafeMemoryClaim(boundedSummary(content), 480);
    const neutralFailure =
      `${block.name} failed under the current inputs and environment. Inspect the referenced tool result.`;
    const summary = failure
      ? safeResult === undefined
        ? neutralFailure
        : `${block.name} failed under the current inputs and environment: ${safeResult}`
      : `Verification command succeeded: ${safeResult ?? 'Inspect the referenced tool result.'}`;
    sequence += 1;
    observations.push({
      id: `tool-outcome:${callRefId}`,
      sequence,
      kind: 'outcome',
      summary,
      evidence: [{
        ref: evidenceRef,
        requestedGrade: 'observed',
        source: 'tool',
        observedAt: input.observedAt,
      }],
      visibility: 'prompt_safe',
      ...(failure
        ? {
            actionSignature: input.decisionActionSignature ?? block.name,
            claimKey: `tool-failure:${block.name}:${failureFingerprint(safeResult)}`,
          }
        : {
            // Successful verifier evidence must stay bound to the concrete
            // command that produced it. A broad task signature would let an
            // unrelated later command inherit this verified method.
            actionSignature: verificationActionSignature(block.name, verificationCommand),
          }),
      occurredAt: input.observedAt,
      metadata: {
        toolName: block.name,
        failed: failure,
        verification: verificationCall,
        ...(reusableLesson === undefined ? {} : { reusableLesson }),
      },
    });
  }
  return observations;
}

function canonicalToolCallId(value: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) return value;
  return `sha256-${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
}

function failureFingerprint(safeResult: string | undefined): string {
  const normalized = (safeResult ?? 'restricted-result')
    .toLowerCase()
    .replace(/\b\d+\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

export const codingMemorySourcePolicy: MemorySourcePolicy = (evidence) => {
  if (evidence.source === 'user' || evidence.source === 'host') return evidence.requestedGrade;
  if (evidence.source === 'environment') return capGrade(evidence, 'verified');
  if (evidence.source === 'tool') {
    return evidence.requestedGrade === 'verified'
      && (evidence.verdict === 'passed' || evidence.verdict === 'failed')
      ? 'verified'
      : capGrade(evidence, 'observed');
  }
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

function verificationActionSignature(toolName: string, command: string | undefined): string {
  const normalized = command?.replace(/\s+/g, ' ').trim() ?? toolName;
  return `${toolName}:verify:${createHash('sha256').update(normalized).digest('hex').slice(0, 16)}`;
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
