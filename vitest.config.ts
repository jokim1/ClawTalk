import { defaultExclude, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The backend test suite uses postgres.js + Supabase (after phase-5 PR 2
    // cutover). Tests run serially in forked workers — slower, but stable for
    // shared-DB fixtures and native modules.
    include: ['src/**/*.test.ts', 'setup/**/*.test.ts', 'skills-engine/**/*.test.ts'],
    exclude: [
      ...defaultExclude,
      // Deferred to Node-path retirement follow-up PR — these tests still
      // use the sqlite-era `_initTestDatabase` helper that was removed in
      // the cutover. Re-port to the pg harness (see db/*-accessors.test.ts)
      // and remove from this list. Kept in sync with tsconfig.json's
      // matching exclude block.
      'src/clawtalk/identity/auth-service-oauth.test.ts',
      'src/clawtalk/identity/auth-service-public-mode.test.ts',
      'src/clawtalk/web/server.test.ts',
      'src/clawtalk/web/routes/auth-public-mode.test.ts',
      'src/clawtalk/web/routes/events.test.ts',
      'src/clawtalk/web/routes/system.test.ts',
      'src/clawtalk/web/routes/talk-attachments.test.ts',
      'src/clawtalk/web/routes/talk-context.test.ts',
      'src/clawtalk/web/routes/talk-jobs.test.ts',
      'src/clawtalk/web/routes/talk-outputs.test.ts',
    ],
    pool: 'forks',
    fileParallelism: false,
    maxWorkers: 1,
  },
});
