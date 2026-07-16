/**
 * FEATURE_209 (v0.7.45): activate the tracing substrate in production.
 *
 * The tracing package (FEATURE_083, v0.7.24) and `FileTracingProcessor` have
 * existed for a while, but no production code ever registered a processor —
 * `Runner.run()` starts a trace via `defaultTracer` and emits spans into an
 * empty processor registry, so the events were discarded.
 *
 * `bootstrapTracing` registers a `FileTracingProcessor` once at CLI startup so
 * every run persists to `<config home>/.traces/<traceId>.jsonl`. The processor
 * lazily creates the trace directory on first flush, so no eager `mkdir` is
 * needed here.
 *
 * Opt-out: set `KODAX_TRACING=0`.
 */
import path from 'node:path';

import {
  FileTracingProcessor,
  addTracingProcessor,
  getAgentConfigHome,
} from '@kodax-ai/agent';

/** Environment variable that disables tracing activation when set to `'0'`. */
export const TRACING_ENV = 'KODAX_TRACING';

export interface BootstrapTracingOptions {
  /**
   * Override the trace output directory. Defaults to `<config home>/.traces`
   * (i.e. `~/.kodax/.traces` unless `KODAX_HOME` is set).
   */
  readonly traceDir?: string;
}

// Idempotency guard: `bootstrapTracing` is on the public `@kodax-ai/coding`
// surface, so a second call (re-entrant `main()`, downstream embedder) must
// not register a second processor writing duplicate JSONL lines.
let activeDispose: (() => void) | undefined;

/**
 * Register the `FileTracingProcessor` so production spans are persisted to
 * disk. Idempotent — a second call returns the existing dispose without
 * registering another processor. Returns a dispose function that unregisters
 * the processor (used by graceful shutdown and tests), or `undefined` — a
 * no-op — when tracing is disabled via `KODAX_TRACING=0`.
 */
export function bootstrapTracing(
  opts: BootstrapTracingOptions = {},
): (() => void) | undefined {
  if (process.env[TRACING_ENV] === '0') {
    return undefined;
  }
  if (activeDispose) {
    return activeDispose;
  }

  const traceDir = opts.traceDir ?? path.join(getAgentConfigHome(), '.traces');
  const processor = new FileTracingProcessor({ traceDir });
  const unregister = addTracingProcessor(processor);
  activeDispose = () => {
    unregister();
    activeDispose = undefined;
  };
  return activeDispose;
}

/** @internal Reset the activation guard. Tests only. */
export function _resetTracingBootstrap(): void {
  activeDispose?.();
  activeDispose = undefined;
}
