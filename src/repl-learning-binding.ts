import { emitKodaXDiagnostic } from '@kodax-ai/agent';
import type { LearningBinding } from '@kodax-ai/repl';

import type { KodaXRuntime } from './sdk-runtime.js';

export function createReplLearningBinding(runtime: KodaXRuntime): LearningBinding {
  return {
    getSnapshot: () => runtime.learning.getSnapshot(),
    list: (query) => runtime.learning.list(query),
    get: (nameOrSlug) => runtime.learning.get(nameOrSlug),
    subscribe(listener, options) {
      const iterator = runtime.learning.subscribe(options)[Symbol.asyncIterator]();
      let active = true;
      void consumeLearningEvents(iterator, () => active, listener);
      return {
        close() {
          active = false;
          void iterator.return?.();
        },
      };
    },
    acknowledge: (nameOrSlug) => runtime.learning.acknowledge(nameOrSlug),
    snooze: (nameOrSlug, until) => runtime.learning.snooze(nameOrSlug, until),
    reject: (nameOrSlug) => runtime.learning.reject(nameOrSlug),
    disable: (nameOrSlug) => runtime.learning.disable(nameOrSlug),
    rollback: (nameOrSlug) => runtime.learning.rollback(nameOrSlug),
    promote: (nameOrSlug, scope) => runtime.learning.promote(nameOrSlug, scope),
    review: (nameOrSlug) => runtime.learning.review(nameOrSlug),
    trust: (nameOrSlug) => runtime.learning.trust(nameOrSlug),
  };
}

async function consumeLearningEvents(
  iterator: AsyncIterator<Awaited<ReturnType<KodaXRuntime['learning']['events']>>[number]>,
  isActive: () => boolean,
  listener: Parameters<LearningBinding['subscribe']>[0],
): Promise<void> {
  try {
    while (isActive()) {
      const next = await iterator.next();
      if (next.done || !isActive()) return;
      listener(next.value);
    }
  } catch (error: unknown) {
    if (!isActive()) return;
    emitKodaXDiagnostic({
      source: 'runtime:learning-binding',
      level: 'warn',
      message: 'Learning Center event subscription stopped.',
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}
