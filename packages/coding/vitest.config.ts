import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // More-specific subpath aliases must precede the package-root alias
      // because Vite matches alias entries by prefix.
      '@kodax-ai/agent/media': path.resolve(__dirname, '..', 'agent', 'src', 'media', 'index.ts'),
      '@kodax-ai/agent/capabilities/skills/shared/yaml': path.resolve(__dirname, '..', 'agent', 'src', 'capabilities', 'skills', 'shared', 'yaml.ts'),
      '@kodax-ai/llm': path.resolve(__dirname, '..', 'llm', 'src', 'index.ts'),
      '@kodax-ai/agent/messaging/queue': path.resolve(__dirname, '..', 'agent', 'src', 'messaging', 'queue.ts'),
      '@kodax-ai/agent': path.resolve(__dirname, '..', 'agent', 'src', 'index.ts'),
      '@kodax-ai/agent/capabilities/skills': path.resolve(__dirname, '..', 'agent', 'src', 'capabilities', 'skills', 'index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
