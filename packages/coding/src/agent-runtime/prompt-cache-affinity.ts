import { createHash } from 'node:crypto';

const PROMPT_CACHE_AFFINITY_DOMAIN = 'kodax:provider-prompt-cache-affinity:v1';

export interface PromptCacheAffinityScope {
  readonly logicalSessionId?: string;
  readonly agentId?: string;
}

/**
 * Build an opaque, stable Provider routing key from a logical Runtime context.
 *
 * The tagged tuple prevents a user-shaped root Session ID from colliding with
 * a derived child identity. A child uses its canonical Agent path, never its
 * short-lived physical transcript Session.
 */
export function derivePromptCacheAffinityKey(
  scope: PromptCacheAffinityScope,
): string | undefined {
  if (!scope.logicalSessionId) return undefined;
  const taggedIdentity = scope.agentId === undefined
    ? ['root', scope.logicalSessionId]
    : ['child', scope.logicalSessionId, scope.agentId];
  return createHash('sha256')
    .update(PROMPT_CACHE_AFFINITY_DOMAIN)
    .update('\0')
    .update(JSON.stringify(taggedIdentity))
    .digest('hex');
}
