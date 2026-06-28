/**
 * Compatibility barrel for REPL-local imports.
 *
 * Canonical ownership:
 * - `@kodax-ai/llm`: pure capability-learning data operations.
 * - `@kodax-ai/agent`: default KodaX runtime cache store under KODAX_HOME.
 *
 * REPL keeps this path only so older internal imports and tests do not need to
 * know the store moved out of the UI layer.
 */

import { getCapabilityCacheFile } from '@kodax-ai/agent';

export const CAPABILITY_CACHE_FILE = getCapabilityCacheFile();

export {
  clearCapabilityCache,
  getCachedRejectedEfforts,
  getCapabilityCacheFile,
  loadCapabilityCache,
  recordRejectedEffort,
  resetCapabilityCacheMemoForTesting,
} from '@kodax-ai/agent';
export type {
  CapabilityCache,
  CapabilityCacheEntry,
  CapabilityCacheSource,
} from '@kodax-ai/agent';

export {
  addRejectedEffort,
  capabilityCacheKey,
  getRejectedEfforts,
  narrowReasoningProfile,
  removeCacheEntry,
  sanitizeCapabilityCache,
} from '@kodax-ai/llm';
