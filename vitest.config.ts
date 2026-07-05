import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/cli.tsx'],
      thresholds: {
        'src/core/**': { lines: 90, branches: 90 },
        'src/config.ts': { lines: 90, branches: 90 },
        'src/ui/**': { lines: 80, branches: 80 },
      },
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.{ts,tsx}'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.{ts,tsx}'],
          globalSetup: ['tests/integration/globalSetup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['tests/e2e/**/*.test.{ts,tsx}'],
          globalSetup: ['tests/integration/globalSetup.ts'],
          // Real timers against a real store polling every 3s (see Phase 9
          // notes) — the default 5s per-test timeout is too tight for
          // scenarios that legitimately wait out one or two poll intervals
          // or a connection-timeout bound. Individual tests still set a
          // tighter explicit timeout where useful (e.g. the live-refresh
          // scenario stays bounded to well under this ceiling).
          testTimeout: 20000,
        },
      },
    ],
  },
});
