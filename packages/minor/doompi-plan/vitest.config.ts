import { defineConfig } from 'vitest/config';

const threshold = process.env.THRESHOLD ? Number.parseInt(process.env.THRESHOLD, 10) : 80;

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    bail: 10,
    exclude: ['node_modules/**/*', 'dist/**/*', 'coverage/**/*'],
    coverage: {
      provider: 'v8',
      reporter: ['text'],
      exclude: [
        'node_modules/',
        'dist/',
        'tests/',
        '**/*.d.ts',
        '**/*.config.*',
        '**/coverage/**',
        // Components are rendered to static markup in tests/web, which proves
        // they mount and read the props the host sends but can never reach a
        // click handler or an effect. Counting those lines toward a threshold
        // only buys assertions that pad it. Their behaviour is the cockpit's
        // Playwright suite's, the same split doompi-web-components makes for
        // its portal-rendered primitives. The plain modules beside them,
        // stores and render helpers, stay counted.
        'web/**/*.tsx',
      ],
      reportOnFailure: false,
      enabled: true,
      skipFull: true,
      cleanOnRerun: true,
      thresholds: { branches: threshold, functions: threshold, lines: threshold, statements: threshold },
    },
  },
});
