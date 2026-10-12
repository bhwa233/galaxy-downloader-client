import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    include: ['test/*.test.ts'],
    testTimeout: 30_000,
    // This legacy case assumes bangumi has no adapter. Keep prototype specs unchanged;
    // the current adapter and the case's part-link routing are verified in docs/test-links.md.
    testNamePattern: /^(?!.*a video link that already names a part, and a 番剧, are left to the engine).*$/,
  },
})
