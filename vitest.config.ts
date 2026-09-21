import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Every test in this suite is deterministic: fake clock, fake provider,
    // no network. A test that needs more than a second is a bug, not slowness.
    testTimeout: 5_000,
  },
});
