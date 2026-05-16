/**
 * Global vitest setup — MessageQueue singleton isolation.
 *
 * FEATURE_159 (v0.7.40) made the process-global MessageQueue the canonical
 * source for queued user prompts (see `packages/agent/src/messaging/queue.ts`).
 * Any test that touches `getMessageQueue()` directly, or that constructs a
 * `StreamingManager` via `createStreamingManager()`, can leak queue state
 * into the next test running in the same vitest worker.
 *
 * Most existing tests already call `_resetMessageQueueForTests()` in their
 * own `beforeEach`. This file is a safety net for tests that forget — it
 * resets the singleton before every test, process-wide. Explicit per-suite
 * resets remain valid and are still preferred (they document intent at the
 * call site), but the global hook removes "I forgot the reset" as a class
 * of bugs.
 *
 * Registered via `setupFiles` in `vitest.config.ts`.
 */
import { beforeEach } from 'vitest';
// IMPORTANT: import from the `@kodax-ai/agent/messaging/queue` subpath,
// NOT the `@kodax-ai/agent` root barrel.
//
// The root barrel pulls in modules that import `node:os` at top level
// (e.g. `runtime/agent-home.ts`). Pre-loading the barrel during
// setupFiles would freeze the `node:os.homedir` binding inside the
// worker module cache before any test file's `vi.mock("node:os")`
// declaration gets hoisted — breaking tests like
// `packages/repl/src/ui/utils/paste-cache.test.ts`.
//
// The `messaging/queue` subpath is the leaf module: it only imports
// `./types.js` (pure types), so it has zero module-load side effects
// and a safe dependency surface for global test setup.
import { _resetMessageQueueForTests } from '@kodax-ai/agent/messaging/queue';

beforeEach(() => {
  _resetMessageQueueForTests();
});
