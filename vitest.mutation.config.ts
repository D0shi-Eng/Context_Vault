import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      // The stdio entrypoint and lifecycle tests spawn the production
      // server as a child process against the unmutated build output, so
      // they can neither kill source mutants nor fail because of them;
      // running them per mutant would only burn time.
      'tests/integration/mcp-stdio-entrypoint.test.ts',
      'tests/e2e/**/*.test.ts',
    ],
  },
});
