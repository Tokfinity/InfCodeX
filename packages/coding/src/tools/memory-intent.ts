import { createHash } from 'node:crypto';

import { sanitizePromptSafeMemoryClaim } from '@kodax-ai/agent';

import type { KodaXToolExecutionContext } from '../types.js';

export const MEMORY_INTENT_TOOL_NAME = 'memory_intent';

export const MEMORY_INTENT_TOOL_DESCRIPTION = [
  'Submit an explicit user request to remember or correct one durable preference, policy, fact, or constraint.',
  'Use semantic judgment over the current user message; do not call it for ordinary narration such as "I remember yesterday".',
  'userQuote must be an exact quote from the current user message that demonstrates durable intent.',
  'This tool captures one intent for end-of-episode governed submission and does not create a durable review job or write durable Memory.',
  'After success, say only that the intent was captured; never claim it was queued, persisted, or applied.',
].join(' ');

export const MEMORY_INTENT_TOOL_SCHEMA = {
  type: 'object' as const,
  properties: {
    operation: {
      type: 'string' as const,
      enum: ['remember', 'correct'],
      description: 'Whether the user asked to remember a claim or correct prior Memory.',
    },
    statement: {
      type: 'string' as const,
      description: 'A concise, faithful statement of the durable claim to review.',
    },
    userQuote: {
      type: 'string' as const,
      description: 'An exact quote from the current user message that establishes durable intent.',
    },
  },
  required: ['operation', 'statement', 'userQuote'],
};

export interface AcceptedMemoryIntent {
  readonly operation: 'remember' | 'correct';
  readonly evidenceRef: string;
  readonly candidateStatement: string;
  readonly userQuote: string;
}

interface CreateMemoryIntentBindingOptions {
  readonly getCurrentUserTurn: () => {
    readonly text: string;
    readonly turnId: string;
  };
  readonly sessionId: string;
  readonly onAccepted: (intent: AcceptedMemoryIntent) => void;
}

export function activateMemoryIntentTool(
  activeTools: readonly string[],
  enabled: boolean,
): string[] {
  const withoutIntent = activeTools.filter((name) => name !== MEMORY_INTENT_TOOL_NAME);
  return enabled ? [...withoutIntent, MEMORY_INTENT_TOOL_NAME] : withoutIntent;
}

export function createMemoryIntentBinding(
  options: CreateMemoryIntentBindingOptions,
): NonNullable<KodaXToolExecutionContext['memoryIntent']> {
  let accepted:
    | {
        readonly signature: string;
        readonly receipt: {
          readonly status: 'captured';
          readonly operation: 'remember' | 'correct';
          readonly evidenceRef: string;
        };
      }
    | undefined;
  return async (input) => {
    const currentUserTurn = options.getCurrentUserTurn();
    const quote = input.userQuote.trim();
    if (quote.length < 4 || !currentUserTurn.text.includes(quote)) {
      return {
        status: 'rejected',
        reason: 'userQuote must be an exact, meaningful quote from the current user turn',
      };
    }
    const candidateStatement = sanitizePromptSafeMemoryClaim(input.statement, 512);
    const userQuote = sanitizePromptSafeMemoryClaim(quote, 512);
    if (candidateStatement === undefined || userQuote === undefined) {
      return {
        status: 'rejected',
        reason: 'statement or userQuote is empty or contains restricted content',
      };
    }
    const signature = [
      currentUserTurn.turnId,
      input.operation,
      candidateStatement,
      userQuote,
    ].join('\0');
    if (accepted !== undefined) {
      return accepted.signature === signature
        ? accepted.receipt
        : {
            status: 'rejected',
            reason: 'a different memory intent was already captured for this episode',
          };
    }
    const evidenceRef = `user-intent:${createHash('sha256')
      .update([
        options.sessionId,
        currentUserTurn.turnId,
        input.operation,
        quote,
      ].join('\0'))
      .digest('hex')
      .slice(0, 24)}`;
    options.onAccepted({
      operation: input.operation,
      evidenceRef,
      candidateStatement,
      userQuote,
    });
    const receipt = {
      status: 'captured' as const,
      operation: input.operation,
      evidenceRef,
    };
    accepted = { signature, receipt };
    return receipt;
  };
}

export async function toolMemoryIntent(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  if (ctx.memoryIntent === undefined) {
    return '[Memory intent unavailable: no root MemorySession is bound]';
  }
  const operation = input.operation === 'remember' || input.operation === 'correct'
    ? input.operation
    : undefined;
  const statement = typeof input.statement === 'string' ? input.statement : '';
  const userQuote = typeof input.userQuote === 'string' ? input.userQuote : '';
  if (operation === undefined || statement.trim().length === 0 || userQuote.trim().length === 0) {
    return '[Memory intent rejected: operation, statement, and userQuote are required]';
  }
  const receipt = await ctx.memoryIntent({ operation, statement, userQuote });
  return receipt.status === 'captured'
    ? `[Memory intent captured for end-of-episode governed submission: ${receipt.operation}; no durable review job exists yet and Memory is not persisted or applied]`
    : `[Memory intent rejected: ${receipt.reason}]`;
}
