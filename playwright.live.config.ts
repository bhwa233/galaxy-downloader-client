import { defineConfig } from '@playwright/test'

// Live upstream probes are kept out of `pnpm test` and `pnpm test:e2e` so the offline gates stay deterministic.
export default defineConfig({
  testDir: './test/live',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    trace: 'on-first-retry',
  },
})
