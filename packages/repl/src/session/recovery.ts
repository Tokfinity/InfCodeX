import type {
  RecoverySeed,
  RecoverySeedInput,
} from '@kodax-ai/agent';
import {
  buildRecoverySeed,
  normalizeRecoveryPrompt,
} from '@kodax-ai/agent';
import { isSessionRecoveryCandidateError } from '@kodax-ai/coding';

export type {
  RecoverySeed,
  RecoverySeedInput,
};
export {
  buildRecoverySeed,
  normalizeRecoveryPrompt,
};

export const SESSION_RECOVERY_CONFIRM_MESSAGE =
  'The provider may be rejecting the current session history. Create a new session from a safe summary and continue there?';

export const SESSION_RECOVERY_HINT_MESSAGE =
  'The current LLM API may be rejecting this session history. Run /recover [prompt] to continue in a fresh session from safe memory.';

export interface SessionRecoveryOfferInput {
  error: Error;
  messageCount: number;
}

export function shouldOfferSessionRecovery(input: SessionRecoveryOfferInput): boolean {
  return isSessionRecoveryCandidateError(input.error, input.messageCount);
}
