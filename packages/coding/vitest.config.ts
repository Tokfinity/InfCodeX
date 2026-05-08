import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@kodax-ai/llm': path.resolve(__dirname, '..', 'ai', 'src', 'index.ts'),
      '@kodax-ai/agent': path.resolve(__dirname, '..', 'agent', 'src', 'index.ts'),
      '@kodax-ai/skills': path.resolve(__dirname, '..', 'skills', 'src', 'index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
