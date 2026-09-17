import { defineConfig } from 'vitest/config';

const systemShard = process.env.DOOMPI_SYSTEM_SHARD;
const groupedSuites = {
  '1': ['DPI installed experiment runtime', 'DOOM-PI-LAUNCH installed runtime modes'],
  '2': ['RPC-LIFECYCLE installed runtime', 'conventional Pi discovery'],
} as const;

type SystemShard = keyof typeof groupedSuites | '3';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function suitesForShard(shard: SystemShard): readonly string[] {
  if (shard === '3') return Object.values(groupedSuites).flat();
  return groupedSuites[shard];
}

function systemTestNamePattern(): RegExp | undefined {
  if (systemShard === undefined) return undefined;
  if (systemShard !== '1' && systemShard !== '2' && systemShard !== '3') {
    throw new Error('DOOMPI_SYSTEM_SHARD must be 1, 2, or 3');
  }

  const suites = suitesForShard(systemShard);
  const suiteBoundary = `(?:${suites.map(escapeRegExp).join('|')})(?: > |$)`;
  return systemShard === '3' ? new RegExp(`^(?!${suiteBoundary})`) : new RegExp(`^${suiteBoundary}`);
}

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/system/**/*.system.test.ts'],
    exclude: ['node_modules/**/*', 'dist/**/*', 'coverage/**/*'],
    testNamePattern: systemTestNamePattern(),
    // One file at a time. These suites pack, install, and launch real
    // processes, so running two of them at once turns a turn that takes
    // seconds into one that outlasts its budget on a busy machine.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 180_000,
    coverage: { enabled: false },
  },
});
