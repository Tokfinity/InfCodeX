import { describe, expect, it } from 'vitest';

import type { StopReason as AnthropicStopReason } from '@anthropic-ai/sdk/resources/messages/messages';
import type { ChatCompletion } from 'openai/resources/chat/completions/completions';

import { classifyStopReason } from './stop-reason.js';

type OpenAIChatFinishReason = NonNullable<ChatCompletion.Choice['finish_reason']>;

function assertCoveredUnion<TUnion extends string, const TValues extends readonly TUnion[]>(
  values: TValues & (
    Exclude<TUnion, TValues[number]> extends never
      ? unknown
      : readonly ['Missing stop reason mapping', Exclude<TUnion, TValues[number]>]
  ),
): TValues {
  return values;
}

const ANTHROPIC_STOP_REASONS = assertCoveredUnion<AnthropicStopReason>([
  'end_turn',
  'max_tokens',
  'stop_sequence',
  'tool_use',
  'pause_turn',
  'refusal',
] as const);

const OPENAI_FINISH_REASONS = assertCoveredUnion<OpenAIChatFinishReason>([
  'stop',
  'length',
  'tool_calls',
  'content_filter',
  'function_call',
] as const);

describe('stop reason SDK coverage', () => {
  it('classifies every Anthropic SDK StopReason to a known class', () => {
    for (const reason of ANTHROPIC_STOP_REASONS) {
      expect(classifyStopReason(reason)).not.toBe('unknown');
    }
  });

  it('classifies every OpenAI chat finish_reason to a known class', () => {
    for (const reason of OPENAI_FINISH_REASONS) {
      expect(classifyStopReason(reason)).not.toBe('unknown');
    }
  });
});
