/**
 * Preload script — must execute before any ESM module evaluation.
 * Loaded via: node --require ./scripts/production-env.cjs ...
 *
 * React ships two runtimes: development (with PerformanceMeasure tracking,
 * prop diff strings, component profiling) and production (zero overhead).
 * Development mode creates ~100 MB/turn of profiling objects that are never
 * released, causing inevitable OOM after 10-20 conversation rounds.
 *
 * Default to production. Set KODAX_DEV=1 to opt-in to development mode.
 */
'use strict';

if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = process.env.KODAX_DEV === '1' ? 'development' : 'production';
}

// Bootstrap hardening must run before the first application ESM import.
// ELECTRON_RUN_AS_NODE is a one-shot exec-boundary switch and is never kept.
delete process.env.ELECTRON_RUN_AS_NODE;
if (process.env.KODAX_DISABLE_HARDENING !== '1') {
  delete process.env.LD_PRELOAD;
  delete process.env.DYLD_INSERT_LIBRARIES;
  delete process.env.DYLD_LIBRARY_PATH;
}
