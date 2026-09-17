import { defineConfig } from 'vitest/config';

const systemShard = process.env.DOOMPI_SYSTEM_SHARD;
const groupedSuites = {
  '1': ['DPI installed experiment runtime'],
  '2': ['DOOM-PI-LAUNCH installed runtime modes'],
  '3': ['RPC-LIFECYCLE installed runtime'],
  '4': ['packed package identity and closure', 'conventional Pi discovery'],
  '5': ['consumer ownership boundaries', 'resources, RMUX, and installed text rendering'],
  '6': [
    'system target and CI gate',
    'frozen published package compatibility baseline',
    'a composed session against a scripted model',
    'packed startup input readiness',
    'measures direct entries and the synced Doom wrapper before accepting input',
  ],
} as const;

type SystemShard = keyof typeof groupedSuites;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function systemTestNamePattern(): RegExp | undefined {
  if (systemShard === undefined) return undefined;
  if (!(systemShard in groupedSuites)) {
    throw new Error('DOOMPI_SYSTEM_SHARD must be 1, 2, 3, 4, 5, or 6');
  }

  const suites = groupedSuites[systemShard as SystemShard];
  const suiteBoundary = `(?:${suites.map(escapeRegExp).join('|')})(?: > |$)`;
  return new RegExp(`^${suiteBoundary}`);
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
