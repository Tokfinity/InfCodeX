import {
  getMessageQueue,
  type MessagePriority,
} from '@kodax-ai/agent';
import type { KodaXInputArtifact } from '../types.js';
import {
  validateInputArtifactsForModel,
  type ValidateInputArtifactsOptions,
} from './validation.js';

export interface EnqueueWithArtifactsInput extends ValidateInputArtifactsOptions {
  readonly content: string;
  readonly inputArtifacts?: readonly KodaXInputArtifact[];
  readonly priority?: MessagePriority;
  readonly agentId?: string;
}

export function enqueueWithArtifacts(input: EnqueueWithArtifactsInput): string {
  validateInputArtifactsForModel(input.inputArtifacts ?? [], input);
  return getMessageQueue().enqueue({
    priority: input.priority ?? 'user',
    mode: 'prompt',
    content: input.content,
    agentId: input.agentId,
    inputArtifacts: input.inputArtifacts,
  });
}
