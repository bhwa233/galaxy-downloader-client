import { defineConfig } from 'vitest/config'
// Live upstream probes are kept out of `pnpm test` so the offline gate stays deterministic.
export default defineConfig({ test: { include: ['test/live/*.test.ts'], testTimeout: 300_000, hookTimeout: 60_000, fileParallelism: false } })
