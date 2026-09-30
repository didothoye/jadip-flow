import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: { NODE_ENV: 'test' },
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 60000,
    hookTimeout: 60000,
    setupFiles: ['test/setup.ts'],
  },
});
