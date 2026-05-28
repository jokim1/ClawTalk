import { defineConfig, devices } from '@playwright/test';

// Minimal Playwright config — webapp regression tests only. Vitest still
// covers unit/integration; this rig exists for end-to-end checks that
// need a real browser, like the snapshot+IDB warm-cache first-paint
// goal. Backend is mocked via page.route inside each spec so the suite
// doesn't depend on the Worker or Supabase being up.

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5173';

export default defineConfig({
  testDir: './playwright',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL,
    headless: true,
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: 'npm run dev',
        url: baseURL,
        timeout: 60_000,
        reuseExistingServer: !process.env.CI,
      },
});
