import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    clearMocks: true,
    coverage: {
      exclude: ['src/main.ts', 'src/infrastructure/run-stdio-server.ts'],
      include: ['src/**/*.ts'],
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      thresholds: {
        branches: 90,
        functions: 95,
        lines: 95,
        statements: 95,
      },
    },
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    mockReset: true,
    passWithNoTests: false,
    restoreMocks: true,
    sequence: {
      concurrent: false,
    },
    testTimeout: 5_000,
  },
});
