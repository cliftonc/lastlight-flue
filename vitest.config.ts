import { defineConfig } from 'vitest/config';

// Vitest is the acceptance-test runner for every phase (see BUILD-LOOP.md).
// Flue ships `@flue/runtime/test-utils` (store-contract suite) and
// `examples/vitest-evals` for eval-style tests — wired in per phase as needed.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'examples/**/*.test.ts'],
    // Keep `pnpm test` green during early bootstrap before any phase tests exist.
    passWithNoTests: true,
  },
});
