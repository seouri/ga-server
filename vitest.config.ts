import { defineConfig } from 'vitest/config';
// Integration tests share long-lived ga-test* projects and Medplum's login limit: always one file at a time.
export default defineConfig({
  test: {
    testTimeout: 30000,
    projects: [
      { test: { name: 'unit', include: ['tests/**/*.test.ts'], exclude: ['tests/integration/**', '**/node_modules/**'], testTimeout: 30000 } },
      { test: { name: 'integration', include: ['tests/integration/**/*.test.ts'], fileParallelism: false, testTimeout: 30000 } },
    ],
  },
});
