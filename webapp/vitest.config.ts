import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    // Playwright specs live in webapp/playwright/ and use Playwright's
    // own test runner; Vitest would import them and crash on the
    // Playwright-specific test API.
    exclude: [...configDefaults.exclude, 'playwright/**'],
  },
});
