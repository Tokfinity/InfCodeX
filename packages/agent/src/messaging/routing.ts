/** Canonical MessageQueue routing key for an Actor within a runtime session. */
export function actorQueueId(sessionId: string, actorPath: string): string;
export function actorQueueId(
  sessionId: string | undefined,
  actorPath: string,
): string | undefined;
export function actorQueueId(
  sessionId: string | undefined,
  actorPath: string,
): string | undefined {
  if (sessionId) return `actor:${sessionId}:${actorPath}`;
  return actorPath === '/root' ? undefined : actorPath;
}

const activeRootQueueRoutes = new Map<string, number>();

/**
 * Advertise a live Actor root queue to compatibility helpers. Repeated
 * registration is reference-counted because nested execution layers can own
 * the same route.
 */
export function registerActiveRootQueueRoute(agentId: string): () => void {
  activeRootQueueRoutes.set(agentId, (activeRootQueueRoutes.get(agentId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = activeRootQueueRoutes.get(agentId);
    if (count === undefined || count <= 1) {
      activeRootQueueRoutes.delete(agentId);
    } else {
      activeRootQueueRoutes.set(agentId, count - 1);
    }
  };
}

/** Resolve the sole live Actor root, failing closed when routing is ambiguous. */
export function resolveActiveRootQueueRoute(): string | undefined {
  if (activeRootQueueRoutes.size === 0) return undefined;
  if (activeRootQueueRoutes.size === 1) {
    return activeRootQueueRoutes.keys().next().value;
  }
  throw new Error(
    'Cannot infer queued follow-up target: multiple Actor root sessions are active. '
      + 'Pass sessionId or agentId explicitly.',
  );
}

/** Test-only process-global reset. */
export function _resetActiveRootQueueRoutesForTests(): void {
  activeRootQueueRoutes.clear();
}
