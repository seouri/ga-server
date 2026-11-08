import { defineConfig } from 'vitest/config';
// Integration tests share long-lived ga-test* projects and Medplum's login limit: always one file at a time.
// GA_STORE=sqlite: store-setup.ts gives each file its own temp SQLite store instead.
export default defineConfig({
  test: {
    testTimeout: 30000,
    projects: [
      { test: { name: 'unit', include: ['tests/**/*.test.ts', 'src/store/test/**/*.test.ts', 'vendor/**/test/*.test.ts'], exclude: ['tests/integration/**', '**/node_modules/**'], testTimeout: 30000 } },
      { test: { name: 'integration', include: ['tests/integration/**/*.test.ts'], setupFiles: ['tests/integration/store-setup.ts'], fileParallelism: false, testTimeout: 30000 } },
    ],
  },
});
