import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    include: ['packages/*/src/**/*.test.ts', 'packages/*/__tests__/**/*.test.ts'],
    testTimeout: 30000, // 30s per test (PlanetScale can be slow)
    hookTimeout: 60000, // 60s for setup/teardown hooks
    // Workaround for spurious "Worker exited unexpectedly" errors during cleanup
    // These occur after tests complete and don't affect test results
    dangerouslyIgnoreUnhandledErrors: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
