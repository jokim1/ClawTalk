import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    // Playwright specs live in webapp/playwright/ and use Playwright's
    // own test runner; Vitest would import them and crash on the
    // Playwright-specific test API.
    exclude: [...configDefaults.exclude, 'playwright/**'],
    // CI runners have far fewer cores than dev machines. Running these
    // userEvent-driven jsdom suites with file-level parallelism there
    // starves the event loop and makes timer-based typing/transitions flaky
    // (passes locally, fails in CI). Run files serially in CI, and keep a
    // small retry as a backstop for any residual timing flake. Locally we
    // stay parallel + retry-free so real flakiness remains visible.
    fileParallelism: !process.env.CI,
    retry: process.env.CI ? 2 : 0,
  },
});
