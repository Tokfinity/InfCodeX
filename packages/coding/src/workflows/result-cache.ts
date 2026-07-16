/**
 * FEATURE_246 Part D (ADR-048) — fs-backed content-addressed result cache.
 *
 * The agent runtime keys each successful runAgent result by `<hash>#<occurrence>`
 * into an injected `WorkflowResultCache`; this is the coding-side fs impl rooted
 * at the run dir (`<runDir>/results/<safeKey>.json`). Every run writes its cache
 * so a later resume can replay it. On resume the cache also READS a prior run's
 * `results/` and copies any hit forward into the current run dir, so the resumed
 * run dir stays self-contained for a further resume.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { WorkflowResultCache, WorkflowTaskResult } from '@kodax-ai/agent';

const RESULTS_SUBDIR = 'results';

/** Make a cache key (`<hash>#<occurrence>`) safe as a filename. */
function safeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function readResult(dir: string, file: string): WorkflowTaskResult | undefined {
  const path = join(dir, file);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as WorkflowTaskResult;
  } catch {
    // A corrupt cache entry is treated as a miss — the effect re-runs live.
    return undefined;
  }
}

/**
 * Create the fs result cache for a run. `runDir` is the current run; `readFrom`
 * (when resuming) is a PRIOR run dir whose `results/` seeds the cache.
 */
export function createFsResultCache(
  runDir: string,
  opts: { readonly readFrom?: string } = {},
): WorkflowResultCache {
  const writeDir = join(runDir, RESULTS_SUBDIR);
  mkdirSync(writeDir, { recursive: true });
  const readDir = opts.readFrom ? join(opts.readFrom, RESULTS_SUBDIR) : undefined;

  return {
    get: (key) => {
      const file = `${safeKey(key)}.json`;
      const own = readResult(writeDir, file);
      if (own !== undefined) return own;
      if (readDir === undefined) return undefined;
      const prior = readResult(readDir, file);
      if (prior === undefined) return undefined;
      // Copy a prior-run hit forward so the resumed run dir is self-contained.
      try {
        writeFileSync(join(writeDir, file), JSON.stringify(prior), 'utf8');
      } catch {
        // Best-effort copy-forward; the in-memory result is still returned.
      }
      return prior;
    },
    set: (key, result) => {
      try {
        writeFileSync(join(writeDir, `${safeKey(key)}.json`), JSON.stringify(result), 'utf8');
      } catch {
        // A cache write failure must never fail the run — resume is best-effort.
      }
    },
  };
}
