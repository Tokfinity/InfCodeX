import path from 'path';
import { defineConfig, type Plugin } from 'vitest/config';

const resolveFromRoot = (...segments: string[]): string =>
  path.resolve(__dirname, ...segments);

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
      '@kodax-ai/agent/capabilities/skills/shared/yaml': resolveFromRoot('packages', 'agent', 'src', 'capabilities', 'skills', 'shared', 'yaml.ts'),
      '@kodax-ai/agent/messaging/queue': resolveFromRoot('packages', 'agent', 'src', 'messaging', 'queue.ts'),
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
