import path from 'path';
import { availableParallelism } from 'node:os';
import { defineConfig, type Plugin } from 'vitest/config';

const resolveFromRoot = (...segments: string[]): string =>
  path.resolve(__dirname, ...segments);

const isCoverageRun = process.argv.some((arg) => arg === '--coverage' || arg.startsWith('--coverage='));

function stripShebang(): Plugin {
  return {
    name: 'strip-shebang',
    transform(code, id) {
      if (id.endsWith('.js') && code.startsWith('#!')) {
        return { code: code.replace(/^#![^\n]*\n/, ''), map: null };
      }
    },
  };
}

export default defineConfig({
  plugins: [stripShebang()],
  resolve: {
    // Every workspace package gets a src-level alias so test runs are
    // build-independent (see packages/repl/vitest.config.ts for the
    // full rationale). Subpath aliases must come before package-root
    // aliases (Vite prefix-match order).
    alias: {
      '@kodax-ai/kodax/media': resolveFromRoot('src', 'sdk-media.ts'),
      '@kodax-ai/kodax/session': resolveFromRoot('src', 'sdk-session.ts'),
      '@kodax-ai/kodax/runtime': resolveFromRoot('src', 'sdk-runtime.ts'),
      '@kodax-ai/agent/media': resolveFromRoot('packages', 'agent', 'src', 'media', 'index.ts'),
      '@kodax-ai/coding/media': resolveFromRoot('packages', 'coding', 'src', 'media', 'index.ts'),
      '@kodax-ai/agent/capabilities/skills/shared/yaml': resolveFromRoot('packages', 'agent', 'src', 'capabilities', 'skills', 'shared', 'yaml.ts'),
      '@kodax-ai/agent/messaging/queue': resolveFromRoot('packages', 'agent', 'src', 'messaging', 'queue.ts'),
      // FEATURE_217: value-imported subpath — MUST precede the root alias
      // so the prefix-ordered matcher does not shadow it (unlike the
      // type-only subpaths below, which are erased at runtime).
      '@kodax-ai/agent/workflow': resolveFromRoot('packages', 'agent', 'src', 'workflow', 'index.ts'),
      '@kodax-ai/agent/experimental-memory': resolveFromRoot('packages', 'agent', 'src', 'experimental-memory', 'index.ts'),
      '@kodax-ai/agent': resolveFromRoot('packages', 'agent', 'src', 'index.ts'),
      '@kodax-ai/llm': resolveFromRoot('packages', 'llm', 'src', 'index.ts'),
      '@kodax-ai/coding': resolveFromRoot('packages', 'coding', 'src', 'index.ts'),
      '@kodax-ai/repl': resolveFromRoot('packages', 'repl', 'src', 'index.ts'),
      '@kodax-ai/agent/session-lineage': resolveFromRoot('packages', 'agent', 'src', 'session-lineage', 'index.ts'),
      '@kodax-ai/agent/capabilities/skills': resolveFromRoot('packages', 'agent', 'src', 'capabilities', 'skills', 'index.ts'),
      '@kodax-ai/agent/tracing': resolveFromRoot('packages', 'agent', 'src', 'tracing', 'index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    // Raised from vitest's 5s default: many fs-heavy integration tests already
    // set local 15_000/30_000 timeouts, i.e. 5s stopped fitting this suite's
    // scale (~600 files run in parallel). Under that contention an otherwise-
    // fast fs test can occasionally cross the ceiling and false-fail — which
    // file gets squeezed varies run-to-run. 15s still let the session-storage /
    // selection fs suites flake on a busy Windows box (they pass in isolation
    // in <3s but were squeezed past 15s under full-suite load), so the ceiling
    // is 30s. Passing tests don't get slower; a real deadlock still fails.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // The suite mixes worker RPC with filesystem-heavy tests and real child
    // processes. On high-core Windows hosts, uncapped workers can starve both
    // the workers and daemon shutdown long enough to create false failures.
    maxWorkers: Math.min(isCoverageRun ? 4 : 8, availableParallelism()),
    minWorkers: 1,
    // FEATURE_159 (v0.7.40) — global MessageQueue singleton reset before
    // each test. See `vitest.setup.queue.ts` for the rationale.
    setupFiles: [resolveFromRoot('vitest.setup.queue.ts')],
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/*/src/**/*.test.tsx',
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'tests/**/*.test.ts',
      'tests/**/*.test.tsx',
      // FEATURE_104 prompt-eval harness self-test (zero-LLM unit tests).
      // Benchmark module + datasets + gitignored run results live under benchmark/.
      'benchmark/**/*.test.ts',
    ],
  },
});
